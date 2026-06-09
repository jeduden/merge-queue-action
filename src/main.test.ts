import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_SIZE,
  parseBatchSize,
  parseMaxRequeues,
} from "./action.js";
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

describe("parseBatchSize", () => {
  it("returns the default for an unset input", () => {
    expect(parseBatchSize("")).toBe(DEFAULT_BATCH_SIZE);
    expect(parseBatchSize("  ")).toBe(DEFAULT_BATCH_SIZE);
  });

  it("parses canonical integers, including 0 (no batch limit)", () => {
    expect(parseBatchSize("3")).toBe(3);
    expect(parseBatchSize("0")).toBe(0);
  });

  it("warns and falls back on garbage instead of producing NaN", () => {
    // The lenient parseInt this replaced made "five" → NaN, which disabled
    // both the listing limit and the batch trim (whole backlog in one batch).
    const warned: string[] = [];
    expect(parseBatchSize("five", (m) => warned.push(m))).toBe(
      DEFAULT_BATCH_SIZE,
    );
    expect(parseBatchSize("5O", (m) => warned.push(m))).toBe(
      DEFAULT_BATCH_SIZE,
    );
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("Invalid batch_size");
  });
});
