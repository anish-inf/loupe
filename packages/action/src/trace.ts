import { appendFileSync } from "node:fs";

import type { HarnessTraceEvent } from "@loupe/harness";

/** Bounds keep the Actions summary readable and below GitHub's limits. */
export const SECTION_MAX_CHARS = 30000;
export const SUMMARY_MAX_CHARS = 100000;
export const BLOB_CHARS = 4000;
export const REASONING_CHARS = 6000;

export type ReviewerTrace = {
  readonly reviewer: string;
  readonly harness?: string;
  readonly events: readonly HarnessTraceEvent[];
};

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
    emit: (e) => events.push(e),
    read: () => ({ reviewer, harness, events: [...events] }),
  };
}

function inline(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

function blob(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value: string, max = BLOB_CHARS): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const newline = cut.lastIndexOf("\n");
  const space = cut.lastIndexOf(" ");
  const boundary = Math.max(newline, space);
  return `${boundary > max / 2 ? cut.slice(0, boundary) : cut}\n… truncated (${value.length.toLocaleString()} characters total)`;
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function code(value: string, language = "text", max = BLOB_CHARS): string {
  return `\`\`\`${language}\n${blob(truncate(pretty(value), max))}\n\`\`\``;
}

type PhaseTrace = {
  readonly name: string;
  readonly model?: string;
  readonly events: HarnessTraceEvent[];
};

function splitPhases(events: readonly HarnessTraceEvent[]): PhaseTrace[] {
  const phases: PhaseTrace[] = [];
  let current: PhaseTrace | undefined;
  for (const event of events) {
    const name = event.phase ?? current?.name ?? "review";
    if (!current || current.name !== name) {
      current = { name, model: event.model, events: [] };
      phases.push(current);
    }
    current.events.push(event);
  }
  return phases;
}

function phaseTitle(phase: PhaseTrace): string {
  const raw = phase.name.split(":")[0] ?? phase.name;
  const labels: Record<string, string> = {
    primary: "Primary review",
    fallback: "Headless fallback",
    ensemble: "Ensemble review",
    verify: "Verification",
    review: "Review",
  };
  return labels[raw] ?? raw;
}

function renderPhase(phase: PhaseTrace): string {
  let reasoning = "";
  let reply = "";
  const tools: { name: string; args?: string; result?: string }[] = [];
  let outcome: { status: "done" | "error"; text: string } | undefined;

  for (const event of phase.events) {
    switch (event.type) {
      case "reasoning":
        reasoning += event.delta;
        break;
      case "text":
        reply += event.delta;
        break;
      case "tool_start":
        tools.push({ name: event.name, args: event.args });
        break;
      case "tool_end": {
        const match = [...tools]
          .reverse()
          .find(
            (tool) => tool.result === undefined && tool.name === event.name,
          );
        if (match) match.result = event.result;
        else tools.push({ name: event.name, result: event.result });
        break;
      }
      case "done":
        outcome = { status: "done", text: event.text };
        break;
      case "error":
        outcome = { status: "error", text: event.error };
        break;
    }
  }

  const status = outcome?.status === "error" ? "⚠️" : outcome ? "✅" : "⏳";
  const stats = [
    reasoning
      ? `${reasoning.length.toLocaleString()} reasoning chars`
      : undefined,
    tools.length
      ? `${tools.length} tool call${tools.length === 1 ? "" : "s"}`
      : undefined,
    reply ? `${reply.length.toLocaleString()} reply chars` : undefined,
  ].filter(Boolean);
  const out = [
    `#### ${status} ${phaseTitle(phase)}`,
    [phase.model ? `Model \`${inline(phase.model)}\`` : undefined, ...stats]
      .filter(Boolean)
      .join(" · "),
  ];

  if (reasoning) {
    out.push(
      `<details>\n<summary><strong>🧠 Reasoning</strong> · ${reasoning.length.toLocaleString()} characters</summary>\n\n${code(reasoning, "text", REASONING_CHARS)}\n\n</details>`,
    );
  }

  if (tools.length) {
    out.push("**Investigation**");
    tools.forEach((tool, index) => {
      const summary = `${index + 1}. <code>${inline(tool.name)}</code>${tool.args ? ` · ${inline(truncate(tool.args, 180))}` : ""}`;
      const body = [
        tool.args ? `**Input**\n\n${code(tool.args, "json")}` : undefined,
        tool.result
          ? `**Result**\n\n${code(tool.result)}`
          : "_No result was captured._",
      ]
        .filter(Boolean)
        .join("\n\n");
      out.push(
        `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`,
      );
    });
  }

  // The final done payload normally repeats the streamed reply. Show one copy.
  const final = outcome?.status === "done" ? outcome.text : reply;
  if (final) {
    out.push(
      `<details>\n<summary><strong>📝 Model output</strong> · ${final.length.toLocaleString()} characters</summary>\n\n${code(final, "json")}\n\n</details>`,
    );
  }

  if (outcome?.status === "error") {
    out.push(`> [!WARNING]\n> This phase failed.\n\n${code(outcome.text)}`);
  } else if (!outcome) {
    out.push(
      "> [!NOTE]\n> This phase ended without a terminal event. See the job log for details.",
    );
  }

  return out.filter(Boolean).join("\n\n");
}

export function renderTraceSection(
  name: string,
  events: readonly HarnessTraceEvent[],
  opts: { harness?: string } = {},
): string {
  const phases = splitPhases(events);
  const model = events.find((event) => event.model)?.model;
  const tools = events.filter((event) => event.type === "tool_start").length;
  const reasoning = events
    .filter((event) => event.type === "reasoning")
    .reduce((sum, event) => sum + event.delta.length, 0);
  const failed = events.some((event) => event.type === "error");
  const completed = events.some((event) => event.type === "done");

  const overview = [
    "| Harness | Model | Phases | Tool calls | Reasoning |",
    "| --- | --- | ---: | ---: | ---: |",
    `| \`${inline(opts.harness ?? "unknown")}\` | ${model ? `\`${inline(model)}\`` : "—"} | ${phases.length} | ${tools} | ${reasoning.toLocaleString()} chars |`,
  ].join("\n");
  const out = [
    `### ${failed ? "⚠️" : completed ? "✅" : "➖"} ${inline(name)}`,
    overview,
  ];

  if (opts.harness && opts.harness !== "whip") {
    out.push(
      `> [!NOTE]\n> Detailed reasoning and tool traces are currently available only for Whip. This reviewer used \`${inline(opts.harness)}\`.`,
    );
  }

  if (!events.length) out.push("_No trace events were captured._");
  else phases.forEach((phase) => out.push("---", renderPhase(phase)));

  let body = out.join("\n\n");
  if (body.length > SECTION_MAX_CHARS) {
    body = `${body.slice(0, SECTION_MAX_CHARS)}\n\n> [!NOTE]\n> Trace truncated at ${SECTION_MAX_CHARS.toLocaleString()} characters. Additional detail remains in the job log.`;
  }
  return body;
}

function boundSummary(body: string): string {
  if (body.length <= SUMMARY_MAX_CHARS) return body;
  return `${body.slice(0, SUMMARY_MAX_CHARS)}\n\n> [!NOTE]\n> Summary truncated at ${SUMMARY_MAX_CHARS.toLocaleString()} characters. Additional detail remains in the job log.`;
}

export function renderReviewsTrace(traces: readonly ReviewerTrace[]): string {
  const parts = [
    `## 🔎 Loupe review trace`,
    `> ${traces.length} reviewer${traces.length === 1 ? "" : "s"} · Captured from Whip's live event stream · No additional model calls`,
  ];
  for (const trace of traces) {
    parts.push(
      "",
      renderTraceSection(trace.reviewer, trace.events, {
        harness: trace.harness,
      }),
    );
  }
  return boundSummary(parts.join("\n"));
}

export function writeReviewsTraceToSummary(
  traces: readonly ReviewerTrace[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path || traces.length === 0) return;
  appendFileSync(path, `\n${renderReviewsTrace(traces)}\n`);
}
