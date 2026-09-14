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
      model: "kimi-k3",
      phase: "primary:kimi-k3",
    },
    { type: "text", delta: '{"summary":', phase: "primary:kimi-k3" },
    {
      type: "tool_start",
      name: "read",
      args: '{"path":"src/a.ts"}',
      phase: "primary:kimi-k3",
    },
    {
      type: "tool_end",
      name: "read",
      result: "export const a = 1;",
      phase: "primary:kimi-k3",
    },
    {
      type: "text",
      delta: '"done","findings":[]}',
      phase: "primary:kimi-k3",
    },
    {
      type: "done",
      text: '{"summary":"safe","findings":[],"concerns":[]}',
      phase: "primary:kimi-k3",
    },
  ];
}

describe("renderTraceSection", () => {
  it("renders a compact trace with collapsible details", () => {
    const md = renderTraceSection("engine", sample(), { harness: "whip" });
    expect(md).toContain("### ✅ engine");
    expect(md).toContain("`whip` · `kimi-k3` · 1 inspection");
    expect(md).toContain("#### ✅ Review");
    expect(md).toContain("<strong>🧠 Thinking</strong>");
    expect(md).toContain("**Inspected**");
    expect(md).toContain("<summary>1. <code>read</code>");
    expect(md).toContain("<strong>📝 Output</strong>");
    // The terminal output replaces, rather than duplicates, streamed reply text.
    expect(md.match(/📝 Output/g)).toHaveLength(1);
  });

  it("separates primary and verification phases", () => {
    const md = renderTraceSection("engine", [
      ...sample(),
      {
        type: "reasoning",
        delta: "check evidence",
        model: "kimi-k3",
        phase: "verify:kimi-k3",
      },
      {
        type: "done",
        text: '{"verdicts":[]}',
        model: "kimi-k3",
        phase: "verify:kimi-k3",
      },
    ]);
    expect(md).toContain("#### ✅ Review");
    expect(md).toContain("#### ✅ Verify findings");
    expect(md).toContain("`unknown` · `kimi-k3` · 1 inspection");
  });

  it("escapes HTML in untrusted event content", () => {
    const md = renderTraceSection("x", [
      { type: "tool_start", name: "grep", args: "pattern <details>" },
      { type: "tool_end", name: "grep", result: "</details><script>" },
      { type: "done", text: "ok" },
    ] as HarnessTraceEvent[]);
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;details&gt;");
    expect(md).toContain("&lt;/details&gt;&lt;script&gt;");
  });

  it("surfaces errors as a warning callout", () => {
    const md = renderTraceSection("x", [
      { type: "error", error: "exit 1: boom" },
    ] as HarnessTraceEvent[]);
    expect(md).toContain("### ⚠️ x");
    expect(md).toContain("> [!WARNING]");
    expect(md).toContain("boom");
  });

  it("marks an empty trace", () => {
    expect(renderTraceSection("x", [])).toContain(
      "No trace events were captured",
    );
  });

  it("adds a Whip-only note for a non-whip harness", () => {
    const md = renderTraceSection(
      "x",
      [{ type: "done", text: "[]" } as HarnessTraceEvent],
      { harness: "claude" },
    );
    expect(md).toContain("`claude` · 0 inspections");
    expect(md).toContain("available only for Whip");
  });
});

describe("renderReviewsTrace", () => {
  it("renders every reviewer and stays bounded", () => {
    const traces: ReviewerTrace[] = [
      { reviewer: "code", harness: "whip", events: sample() },
      { reviewer: "migrations", events: [{ type: "done", text: "[]" }] },
    ];
    const md = renderReviewsTrace(traces);
    expect(md).toContain("## 🔎 Loupe trace");
    expect(md).toContain("2 reviewers · Review → verify → post");
    expect(md).toContain("### ✅ code");
    expect(md).toContain("### ✅ migrations");

    const huge: HarnessTraceEvent[] = [
      { type: "reasoning", delta: "y".repeat(40000) },
      { type: "done", text: "ok" },
    ];
    expect(
      renderReviewsTrace([{ reviewer: "huge", events: huge }]).length,
    ).toBeLessThan(100000);
  });
});

describe("createTraceCollector", () => {
  it("accumulates events and returns defensive snapshots", () => {
    const collector = createTraceCollector("code", "whip");
    collector.emit({ type: "text", delta: "a" });
    collector.emit({ type: "done", text: "b" });
    const snapshot = collector.read();
    collector.emit({ type: "text", delta: "c" });
    expect(snapshot.events).toHaveLength(2);
    expect(collector.events).toHaveLength(3);
    expect(snapshot.harness).toBe("whip");
  });
});

describe("writeReviewsTraceToSummary", () => {
  it("appends to GITHUB_STEP_SUMMARY", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "loupe-summary-")),
      "summary.md",
    );
    writeFileSync(path, "preexisting\n");
    writeReviewsTraceToSummary(
      [{ reviewer: "code", harness: "whip", events: sample() }],
      { GITHUB_STEP_SUMMARY: path } as NodeJS.ProcessEnv,
    );
    const output = readFileSync(path, "utf8");
    expect(output).toContain("preexisting");
    expect(output).toContain("## 🔎 Loupe trace");
    expect(output).toContain("### ✅ code");
  });

  it("is a no-op without a summary path or traces", () => {
    expect(() =>
      writeReviewsTraceToSummary([{ reviewer: "code", events: sample() }], {}),
    ).not.toThrow();
    expect(() =>
      writeReviewsTraceToSummary([], { GITHUB_STEP_SUMMARY: "/tmp/x.md" }),
    ).not.toThrow();
  });
});
