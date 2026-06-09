import { describe, expect, it } from "vitest";
import { hasWritePermission, parseMaxRequeues } from "./action.js";
import { MAX_REQUEUE_ATTEMPTS } from "./queue.js";

describe("parseMaxRequeues", () => {
  it("returns the default for an unset input", () => {
    expect(parseMaxRequeues("")).toBe(MAX_REQUEUE_ATTEMPTS);
    expect(parseMaxRequeues("  ")).toBe(MAX_REQUEUE_ATTEMPTS);
  });

  it("parses canonical positive integers (with surrounding whitespace)", () => {
    expect(parseMaxRequeues("5")).toBe(5);
    expect(parseMaxRequeues(" 7 ")).toBe(7);
    expect(parseMaxRequeues("0")).toBe(0); // Queue rejects 0 loudly
  });

  it("rejects numeric-prefix garbage instead of silently truncating", () => {
    // parseInt would accept these ("1O" → 1, "10.9" → 10) and silently
    // change the cap; NaN makes Queue warn and use the default.
    expect(parseMaxRequeues("1O")).toBeNaN();
    expect(parseMaxRequeues("10.9")).toBeNaN();
    expect(parseMaxRequeues("-3")).toBeNaN();
    expect(parseMaxRequeues("ten")).toBeNaN();
  });
});

describe("hasWritePermission", () => {
  const tests = [
    { perm: "admin", want: true },
    { perm: "maintain", want: true },
    { perm: "write", want: true },
    { perm: "triage", want: false },
    { perm: "read", want: false },
    { perm: "none", want: false },
    { perm: "", want: false },
  ];

  for (const tt of tests) {
    it(`${tt.perm || "(empty)"} -> ${tt.want}`, () => {
      expect(hasWritePermission(tt.perm)).toBe(tt.want);
    });
  }
});
