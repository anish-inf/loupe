import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HarnessTraceEvent } from "@loupe/harness";

import {
  createTraceCollector,
  renderReviewsTrace,
  renderTraceSection,
  writeReviewsTraceToSummary,
  type ReviewerTrace,
} from "../src/trace";

function sample(): HarnessTraceEvent[] {
  return [
    {
      type: "reasoning",
      delta: "user wants a safe file read; check for path traversal. ",
    },
    { type: "text", delta: '{"summary":' },
    { type: "tool_start", name: "read", args: '{"path":"src/a.ts"}' },
    { type: "tool_end", name: "read", result: "export const a = 1;" },
    { type: "text", delta: '"done","findings":[]}' },
    { type: "done", text: '{"summary":"safe","findings":[],"concerns":[]}' },
  ];
}

describe("renderTraceSection", () => {
  it("renders reasoning (collapsed), tools, final result and metadata", () => {
    const events = [
      {
        type: "reasoning",
        delta: "think a ",
        model: "kimi-k3",
        phase: "primary:kimi-k3",
      },
      { type: "reasoning", delta: "think b " },
      { type: "tool_start", name: "read", args: "sm://secret path" },
      { type: "tool_end", name: "read", result: "a`b" },
      { type: "done", text: '{"ok":true}' },
    ] as HarnessTraceEvent[];
    const md = renderTraceSection("engine", events);
    expect(md).toContain("### `engine`");
    expect(md).toContain("model: `kimi-k3`");
    expect(md).toContain("phase: `primary:kimi-k3`");
    expect(md).toContain("reasoning");
    expect(md).toContain("**tools** (1)");
    expect(md).toContain("**read**");
    // A backtick inside a tool result is escaped so it can't break surrounding
    // markdown (safe even within a code fence).
    expect(md).toContain("a\\`b");
    expect(md).toContain("**result:** ✅ done");
  });

  it("escapes markdown and HTML control characters", () => {
    const md = renderTraceSection("x", [
      { type: "tool_start", name: "grep", args: "pattern `x` <details>" },
      { type: "tool_end", name: "grep", result: "a`b </details>" },
      { type: "done", text: "ok" },
    ] as HarnessTraceEvent[]);
    expect(md).not.toContain("pattern `x`");
    expect(md).not.toContain("</details>\n**result");
    expect(md).toContain("\\`");
    expect(md).toContain("&lt;details&gt;");
  });

  it("surfaces an error outcome even without a done event", () => {
    const md = renderTraceSection("x", [
      { type: "error", error: "exit 1: boom" },
    ] as HarnessTraceEvent[]);
    expect(md).toContain("**result:** ⚠️ error");
    expect(md).toContain("boom");
  });

  it("marks an empty trace as no events captured", () => {
    const md = renderTraceSection("x", []);
    expect(md).toContain("no trace events captured");
  });

  it("adds a Whip-only note for a non-whip harness, even with a done event", () => {
    const md = renderTraceSection(
      "x",
      [{ type: "done", text: "[]" } as HarnessTraceEvent],
      { harness: "claude" },
    );
    expect(md).toContain("harness: `claude`");
    expect(md).toContain("**Whip-only**");
    expect(md).toContain("doesn't stream the whip-style event log");
    // The final outcome still renders alongside the note.
    expect(md).toContain("**result:** ✅ done");
  });

  it("shows the harness in metadata when present", () => {
    const md = renderTraceSection(
      "x",
      [{ type: "done", text: "[]" } as HarnessTraceEvent],
      { harness: "whip" },
    );
    expect(md).toContain("harness: `whip`");
  });
});

describe("renderReviewsTrace", () => {
  it("renders every reviewer and stays bounded by the char cap", () => {
    const traces: ReviewerTrace[] = [
      { reviewer: "code", events: sample() },
      { reviewer: "migrations", events: [{ type: "done", text: "[]" }] },
    ];
    const md = renderReviewsTrace(traces);
    expect(md).toContain("## 🔎 Review traces (2 reviewers)");
    expect(md).toContain("### `code`");
    expect(md).toContain("### `migrations`");

    // Bounded: a huge reasoning stream is truncated, not dumped whole.
    const huge: HarnessTraceEvent[] = [
      { type: "reasoning", delta: "y".repeat(40000) },
      { type: "done", text: "ok" },
    ];
    const bounded = renderReviewsTrace([{ reviewer: "huge", events: huge }]);
    expect(bounded.length).toBeLessThan(100000);
  });
});

describe("createTraceCollector", () => {
  it("accumulates events per collector and snapshots independently", () => {
    const c = createTraceCollector("code");
    c.emit({ type: "text", delta: "a" });
    c.emit({ type: "done", text: "b" });
    expect([...c.events]).toHaveLength(2);
    const snap = c.read();
    expect(snap.reviewer).toBe("code");
    expect(snap.events).toHaveLength(2);
    // The snapshot is defensive: pushing later doesn't change it.
    c.emit({ type: "text", delta: "c" });
    expect(snap.events).toHaveLength(2);
    expect(c.events).toHaveLength(3);
  });

  it("carries the harness label onto the snapshot", () => {
    const c = createTraceCollector("code", "claude");
    expect(c.read().harness).toBe("claude");
  });
});

describe("writeReviewsTraceToSummary", () => {
  it("appends to the path from GITHUB_STEP_SUMMARY when set", () => {
    const p = join(mkdtempSync(join(tmpdir(), "loupe-summary-")), "summary.md");
    writeFileSync(p, "preexisting\n");
    writeReviewsTraceToSummary([{ reviewer: "code", events: sample() }], {
      GITHUB_STEP_SUMMARY: p,
    } as NodeJS.ProcessEnv);
    const out = readFileSync(p, "utf8");
    expect(out).toContain("preexisting");
    expect(out).toContain("## 🔎 Review traces");
    expect(out).toContain("### `code`");
  });

  it("is a no-op without GITHUB_STEP_SUMMARY", () => {
    expect(() =>
      writeReviewsTraceToSummary([{ reviewer: "code", events: sample() }], {}),
    ).not.toThrow();
  });

  it("is a no-op with no reviewer traces", () => {
    expect(() =>
      writeReviewsTraceToSummary([], { GITHUB_STEP_SUMMARY: "/tmp/x.md" }),
    ).not.toThrow();
  });
});
