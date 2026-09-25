import { describe, expect, it } from "vitest";

import { asMaxComments } from "../src/config";

describe("asMaxComments env parsing", () => {
  it("parses a valid positive integer", () => {
    expect(asMaxComments("10")).toBe(10);
    expect(asMaxComments("1")).toBe(1);
  });

  it("undefined means the input was not set, deferring to the file/default", () => {
    expect(asMaxComments(undefined)).toBeUndefined();
  });

  it("rejects non-integer, zero, negative, and empty values", () => {
    for (const bad of ["0", "-2", "2.5", "abc", "  ", "3,000"]) {
      expect(() => asMaxComments(bad)).toThrow(/Invalid max-comments/);
    }
  });
});
