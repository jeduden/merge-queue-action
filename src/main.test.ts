import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_SIZE,
  parseBatchSize,
  parseCiWaitMinutes,
  parseMaxRequeues,
} from "./action.js";
import { tokenlessOriginUrl } from "./cleanup.js";
import { ciWaitAttempts, DEFAULT_CI_WAIT_MINUTES } from "./github.js";
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

describe("tokenlessOriginUrl", () => {
  it("builds the token-less URL from env values", () => {
    expect(
      tokenlessOriginUrl("https://github.com", "owner/repo"),
    ).toBe("https://github.com/owner/repo.git");
    // Trailing slashes on the server URL don't double up.
    expect(
      tokenlessOriginUrl("https://ghe.example.com/", "o/r"),
    ).toBe("https://ghe.example.com/o/r.git");
  });

  it("defaults the server and bails without a repository", () => {
    expect(tokenlessOriginUrl(undefined, "o/r")).toBe(
      "https://github.com/o/r.git",
    );
    expect(tokenlessOriginUrl("https://github.com", undefined)).toBeUndefined();
  });
});

describe("formatErrorForComment injection hardening", () => {
  it("renders untrusted fragments as inline code so mentions and links stay inert", async () => {
    const { formatErrorForComment } = await import("./comments.js");
    const out = formatErrorForComment(
      new Error("conflict in [evil](https://x) @everyone path"),
    );
    expect(out.startsWith("`")).toBe(true);
    expect(out.endsWith("`")).toBe(true);
    // Inner backticks were stripped, so the span cannot be closed early.
    expect(out.slice(1, -1)).not.toContain("`");
  });
});

describe("parseCiWaitMinutes / ciWaitAttempts", () => {
  it("parses canonical minutes and falls back loudly on garbage", () => {
    expect(parseCiWaitMinutes("", 60)).toBe(60);
    expect(parseCiWaitMinutes("90", 60)).toBe(90);
    const warned: string[] = [];
    expect(parseCiWaitMinutes("0", 60, (m) => warned.push(m))).toBe(60);
    expect(parseCiWaitMinutes("an hour", 60, (m) => warned.push(m))).toBe(60);
    expect(warned).toHaveLength(2);
  });

  it("converts minutes to 10s poll attempts with a sane floor", () => {
    expect(ciWaitAttempts(60)).toBe(360);
    expect(ciWaitAttempts(90)).toBe(540);
    expect(ciWaitAttempts(1)).toBe(6);
    // Non-finite / sub-minute values fall back to the default budget.
    expect(ciWaitAttempts(Number.NaN)).toBe(DEFAULT_CI_WAIT_MINUTES * 6);
    expect(ciWaitAttempts(0)).toBe(DEFAULT_CI_WAIT_MINUTES * 6);
  });
});
