import { appendFileSync } from "node:fs";

import type { HarnessTraceEvent } from "@loupe/harness";

/**
 * GitHub Actions review traces.
 *
 * The whip harness streams a normalized event log (reasoning deltas, text,
 * tool_start/tool_end, done/error) through `HarnessContext.trace`. The
 * orchestrator captures each reviewer's events into a `TraceCollector` — safely
 * (an array per reviewer, appended from within that reviewer's own promise so
 * parallel reviewers never race on a shared buffer) — then, once every outcome
 * has completed, renders them into a bounded, readable Markdown section and
 * appends it to `process.env.GITHUB_STEP_SUMMARY`.
 *
 * Nothing here issues model calls; it only renders already-captured events to a
 * file. So the summary is a free, offline transcript of what the run did.
 */

/** Bound on one reviewer's rendered Markdown section, in characters. */
export const SECTION_MAX_CHARS = 20000;
/** Bound on the whole summary file, in characters. */
export const SUMMARY_MAX_CHARS = 100000;
/** Truncate tool args / results / reply blobs to this many characters. */
export const BLOB_CHARS = 2000;
/** Collapsed reasoning shows at most this many characters of the head. */
export const REASONING_CHARS = 1200;

/** A bounded per-reviewer trace snapshot, safe for parallel capture. */
export type ReviewerTrace = {
  readonly reviewer: string;
  /** The harness that produced these events (e.g. "whip"). Used to explain why
   * a non-whip reviewer shows no enriched detail. */
  readonly harness?: string;
  readonly events: readonly HarnessTraceEvent[];
};

/**
 * Per-reviewer event collector. `emit` is handed to `runReview`'s `trace` sink;
 * events accumulate in this reviewer's own array, so concurrent reviewers never
 * share mutable state. `read()` returns the ordered snapshot.
 */
export function createTraceCollector(
  reviewer: string,
  harness?: string,
): {
  readonly events: HarnessTraceEvent[];
  readonly emit: (e: HarnessTraceEvent) => void;
  readonly read: () => ReviewerTrace;
} {
  const events: HarnessTraceEvent[] = [];
  return {
    events,
    emit: (e) => {
      events.push(e);
    },
    read: () => ({ reviewer, harness, events: [...events] }),
  };
}

/** Escape a string so backticks and other markdown-sensitive chars are inert. */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/(^|\n)#/g, "$1\\#")
    .slice(0, BLOB_CHARS);
}

/** Truncate a long blob to BLOB_CHARS with an ellipsis, on a word boundary. */
function truncate(s: string, max = BLOB_CHARS): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${sp > 0 ? cut.slice(0, sp) : cut} … (truncated, ${s.length} chars)`;
}

/**
 * Render a single reviewer's events as a bounded, readable Markdown section.
 * - Actual reasoning deltas are aggregated and shown collapsed (so the summary
 *   stays scannable).
 * - Emitted reply text is rendered inside a collapsed fenced block.
 * - Observable tool calls/results are a numbered list, each blob escaped and
 *   truncated for safe Markdown.
 * - The final `done`/`error` outcome is surfaced at the end (an error that
 *   never resolves to a `done` is still rendered as the reviewer's result).
 * - `phase`/`model` metadata are shown when present.
 */
export function renderTraceSection(
  name: string,
  events: readonly HarnessTraceEvent[],
  opts: { harness?: string } = {},
): string {
  let reasoningChrs = 0;
  let reasoningHead = "";
  const textParts: string[] = [];
  const tools: { name: string; args?: string; result?: string }[] = [];
  let outcome: { status: "done" | "error"; text: string } | undefined;
  let model: string | undefined;
  // First non-empty phase label seen, for grouping context.
  let phase: string | undefined;

  for (const ev of events) {
    model = model ?? ev.model;
    phase = phase ?? ev.phase;
    switch (ev.type) {
      case "reasoning":
        reasoningChrs += ev.delta.length;
        if (reasoningHead.length < REASONING_CHARS) {
          reasoningHead += ev.delta;
        }
        break;
      case "text":
        textParts.push(ev.delta);
        break;
      case "tool_start":
        tools.push({ name: ev.name, args: ev.args });
        break;
      case "tool_end": {
        // Match the last unresolved tool_start by name; default to appended.
        const match = [...tools].reverse().find((t) => t.result === undefined);
        if (match) match.result = ev.result;
        else tools.push({ name: ev.name, result: ev.result });
        break;
      }
      case "done":
        outcome = { status: "done", text: ev.text };
        break;
      case "error":
        outcome = { status: "error", text: ev.error };
        break;
    }
  }

  const out: string[] = [`### \`${escape(name)}\``];
  const meta = [
    opts.harness ? `harness: \`${escape(opts.harness)}\`` : undefined,
    model ? `model: \`${escape(model)}\`` : undefined,
    phase ? `phase: \`${escape(phase)}\`` : undefined,
  ].filter(Boolean);
  if (meta.length > 0) out.push(`${meta.join(" · ")}`);

  // A non-whip harness doesn't stream the whip-style NDJSON event log this
  // feature enriches from, so it can't contribute reasoning/tool detail. Say so
  // explicitly rather than implying the run silently produced nothing.
  if (opts.harness && opts.harness !== "whip") {
    out.push(
      `_No detailed trace available — the **\`${escape(opts.harness)}\`** harness doesn't stream the whip-style event log this feature reads. Reasoning and per-tool traces are **Whip-only**; the final outcome still renders._`,
    );
  }

  // Reasoning, collapsed.
  if (reasoningChrs > 0) {
    out.push(
      `<details><summary>🧠 reasoning · ${reasoningChrs.toLocaleString()} chars</summary>\n\n${reasoningHead.length ? `\`\`\`\n${escape(reasoningHead)}\n\`\`\`` : "_reasoning deltas emitted, none captured text_."}\n</details>`,
    );
  }

  // Emitted reply text, collapsed.
  if (textParts.length > 0) {
    const text = textParts.join("");
    out.push(
      `<details><summary>📝 reply · ${text.length.toLocaleString()} chars</summary>\n\n\`\`\`\n${escape(truncate(text))}\n\`\`\`\n</details>`,
    );
  }

  // Observable tool calls/results.
  if (tools.length > 0) {
    out.push(`**tools** (${tools.length})`);
    tools.forEach((t, i) => {
      const head = [
        `**${escape(t.name)}**`,
        t.args ? `\`${escape(truncate(t.args))}\`` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      out.push(
        `${i + 1}. ${head}`,
        t.result
          ? `   \`\`\`\n   ${escape(truncate(t.result)).replace(/\n/g, "\n   ")}\n   \`\`\``
          : "   _no result captured_",
      );
    });
  }

  // Outcome.
  if (outcome) {
    if (outcome.status === "error") {
      out.push(`**result:** ⚠️ error`);
      out.push(`\`\`\`\n${escape(truncate(outcome.text))}\n\`\`\``);
    } else {
      out.push(`**result:** ✅ done`);
      out.push(
        `<details><summary>final output · ${outcome.text.length.toLocaleString()} chars</summary>\n\n\`\`\`\n${escape(truncate(outcome.text))}\n\`\`\`\n</details>`,
      );
    }
  } else if (
    reasoningChrs === 0 &&
    textParts.length === 0 &&
    tools.length === 0
  ) {
    out.push("_no trace events captured._");
  } else {
    out.push(
      "**result:** ⚠️ no `done` or `error` event received (run ended without a terminal event).",
    );
  }

  // Bound the section.
  let body = out.join("\n");
  if (out.length > 3 && body.length > SECTION_MAX_CHARS) {
    body = `${header(out, name)}\n\n_trace truncated (${body.length} chars); full detail is in the job logs._`;
  }
  return body;
}

/** First two lines (header + meta) preserved when truncating a section. */
function header(lines: readonly string[], _name: string): string {
  return lines.slice(0, 2).join("\n");
}

/** Bounds a whole summary by dropping per-tool detail past the cap. */
function boundSummary(body: string): string {
  if (body.length <= SUMMARY_MAX_CHARS) return body;
  return `${body.slice(0, SUMMARY_MAX_CHARS)}\n\n_trace truncated to ${SUMMARY_MAX_CHARS.toLocaleString()} chars; full detail is in the job logs._`;
}

/** Render every reviewer's traces into one half-title'd markdown blob. */
export function renderReviewsTrace(traces: readonly ReviewerTrace[]): string {
  const parts = [
    `## 🔎 Review traces (${traces.length} reviewer${traces.length === 1 ? "" : "s"})`,
    "_Live harness events captured during this run — reasoning, tool calls/results, and the outcome per reviewer._",
  ];
  for (const t of traces) {
    parts.push(
      "",
      renderTraceSection(t.reviewer, t.events, { harness: t.harness }),
    );
  }
  return boundSummary(parts.join("\n"));
}

/**
 * Append the rendered trace to the GitHub Actions step summary. No model calls;
 * purely writes already-captured events to `GITHUB_STEP_SUMMARY` (Append Mode).
 * No-op unless that env var exists and is non-empty.
 */
export function writeReviewsTraceToSummary(
  traces: readonly ReviewerTrace[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path || path.length === 0) return;
  if (traces.length === 0) return;
  const body = renderReviewsTrace(traces);
  appendFileSync(path, `\n${body}\n`);
}
