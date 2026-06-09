import { describe, expect, it } from "vitest";
import { isRetryableHttpError, withRetry } from "./github.js";

const withStatus = (status: number, extra: object = {}) =>
  Object.assign(new Error("x"), { status, ...extra });

describe("isRetryableHttpError", () => {
  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [404, false],
    [422, false],
    [401, false],
    [403, false], // plain 403 = missing permission = NOT retryable
  ])("status %s → retryable=%s", (status, want) => {
    expect(isRetryableHttpError(withStatus(status))).toBe(want);
  });

  it("retries a secondary-rate-limit 403 (header or message)", () => {
    expect(
      isRetryableHttpError(
        withStatus(403, { response: { headers: { "retry-after": "1" } } }),
      ),
    ).toBe(true);
    expect(
      isRetryableHttpError(
        withStatus(403, {
          response: { headers: { "x-ratelimit-remaining": "0" } },
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableHttpError(
        Object.assign(new Error("You hit a secondary rate limit"), {
          status: 403,
        }),
      ),
    ).toBe(true);
  });

  it("returns false for non-HTTP / status-less errors", () => {
    expect(isRetryableHttpError(new Error("network"))).toBe(false);
    expect(isRetryableHttpError(null)).toBe(false);
    expect(isRetryableHttpError("x")).toBe(false);
  });

  it("treats a 403 with a non-string message as non-retryable", () => {
    expect(isRetryableHttpError({ status: 403, message: 1 })).toBe(false);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("returns the first success without retrying", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { sleepFn: noSleep },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient errors and then succeeds", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw withStatus(503);
        return "ok";
      },
      { attempts: 5, baseMs: 1, sleepFn: noSleep },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows a permanent error immediately (no retry)", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw withStatus(404);
        },
        { attempts: 5, sleepFn: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("gives up after `attempts` transient failures", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw withStatus(500);
        },
        { attempts: 3, baseMs: 1, sleepFn: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("logs and backs off (exponentially) between retries", async () => {
    const slept: number[] = [];
    const logs: string[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw withStatus(500);
        return "ok";
      },
      {
        attempts: 4,
        baseMs: 10,
        log: (m) => logs.push(m),
        sleepFn: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(slept).toEqual([10, 20]); // exponential: 10*2^0, 10*2^1
    expect(logs.some((l) => l.includes("retrying"))).toBe(true);
  });
});
