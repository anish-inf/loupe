import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { asDirs, loadReviewers, loadSettings } from "../src/reviewers";

function config(json: object): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-cfg-"));
  const p = join(dir, "loupe.json");
  writeFileSync(p, JSON.stringify(json));
  return p;
}

describe("dir setting", () => {
  it("keeps accepting the original single-string form unchanged", () => {
    const p = config({
      dir: "inference",
      reviewers: [{ name: "code", prompt: "x" }],
    });
    expect(loadSettings(p).dirs).toEqual(["inference"]);
    expect(loadReviewers(p)[0]!.dirs).toBeUndefined();
  });

  it("accepts a list at the top level and per reviewer", () => {
    const p = config({
      dir: ["inference", "elixir_engine"],
      reviewers: [
        { name: "code", prompt: "x" },
        { name: "engine", prompt: "y", dir: "elixir_engine" },
        { name: "both", prompt: "z", dir: ["inference", "elixir_engine"] },
      ],
    });
    expect(loadSettings(p).dirs).toEqual(["inference", "elixir_engine"]);
    const [code, engine, both] = loadReviewers(p);
    expect(code!.dirs).toBeUndefined();
    expect(engine!.dirs).toEqual(["elixir_engine"]);
    expect(both!.dirs).toEqual(["inference", "elixir_engine"]);
  });

  it("asDirs splits the comma form used by the Action input and CLI flag", () => {
    expect(asDirs("inference, elixir_engine")).toEqual([
      "inference",
      "elixir_engine",
    ]);
    expect(asDirs("inference")).toEqual(["inference"]);
    expect(asDirs("")).toBeUndefined();
    expect(asDirs(undefined)).toBeUndefined();
  });
});

describe("rubric setting", () => {
  it("loads a top-level rubric default and surfaces it on loadSettings", () => {
    const p = config({
      rubric: true,
      reviewers: [{ name: "code", prompt: "x" }],
    });
    expect(loadSettings(p).rubric).toBe(true);
  });

  it("applies the top-level default to reviewers that don't set it", () => {
    const p = config({
      rubric: true,
      reviewers: [
        { name: "inherits", prompt: "x" },
        { name: "opts-out", prompt: "y", rubric: false },
      ],
    });
    const [inherits, optsOut] = loadReviewers(p);
    expect(inherits!.rubric).toBe(true);
    expect(optsOut!.rubric).toBe(false);
  });

  it("a reviewer's own value wins over the top-level default", () => {
    const p = config({
      rubric: false,
      reviewers: [{ name: "opts-in", prompt: "x", rubric: true }],
    });
    expect(loadReviewers(p)[0]!.rubric).toBe(true);
  });

  it("defaults to undefined (off) when neither top-level nor reviewer sets it", () => {
    const p = config({
      reviewers: [{ name: "code", prompt: "x" }],
    });
    expect(loadSettings(p).rubric).toBeUndefined();
    expect(loadReviewers(p)[0]!.rubric).toBeUndefined();
  });
});
