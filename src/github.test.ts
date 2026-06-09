import { describe, expect, it } from "vitest";
import {
  GitHubClient,
  isRetryableHttpError,
  isThrottleError,
  withRetry,
} from "./github.js";
import { isRateLimitedError } from "./errors.js";

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

describe("isRateLimitedError", () => {
  it("rejects non-object values and plain errors", () => {
    expect(isRateLimitedError(null)).toBe(false);
    expect(isRateLimitedError("x")).toBe(false);
    expect(isRateLimitedError(new Error("Forbidden"))).toBe(false);
  });

  it("accepts the three rate-limit signals", () => {
    expect(
      isRateLimitedError({ response: { headers: { "retry-after": "1" } } }),
    ).toBe(true);
    expect(
      isRateLimitedError({
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }),
    ).toBe(true);
    expect(
      isRateLimitedError(new Error("You have exceeded a secondary rate limit")),
    ).toBe(true);
  });
});

describe("isThrottleError", () => {
  it("accepts only throttle responses — safe to resend a non-idempotent request", () => {
    expect(isThrottleError(withStatus(429))).toBe(true);
    expect(
      isThrottleError(
        withStatus(403, { response: { headers: { "retry-after": "1" } } }),
      ),
    ).toBe(true);
    // A 5xx is ambiguous (the dispatch may have been processed) — NOT safe,
    // even when its headers happen to show an exhausted rate-limit quota.
    expect(isThrottleError(withStatus(500))).toBe(false);
    expect(isThrottleError(withStatus(502))).toBe(false);
    expect(
      isThrottleError(
        withStatus(500, {
          response: { headers: { "x-ratelimit-remaining": "0" } },
        }),
      ),
    ).toBe(false);
    // Plain permission 403 / permanent errors are not throttles.
    expect(isThrottleError(withStatus(403))).toBe(false);
    expect(isThrottleError(withStatus(404))).toBe(false);
    expect(isThrottleError(null)).toBe(false);
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

  it("honors a custom retryIf predicate (dispatch: no retry on 5xx)", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw withStatus(502); // retryable by default, NOT a throttle
        },
        { attempts: 4, retryIf: isThrottleError, sleepFn: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
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

describe("GitHubClient retry wiring", () => {
  // Pins WHICH predicate each call site uses — the predicates are unit
  // tested above, but without these, swapping triggerWorkflow back to the
  // permissive predicate (re-enabling duplicate dispatches) or dropping
  // findWorkflowRun's retry would pass the whole suite.
  function clientWith(
    overrides: Partial<Record<string, (...args: never[]) => unknown>>,
  ) {
    const client = new GitHubClient("test-token", "o", "r");
    Object.assign(client.octokit.rest.actions, overrides);
    return client;
  }

  it("does NOT retry a 5xx on workflow dispatch (non-idempotent)", async () => {
    let calls = 0;
    const client = clientWith({
      createWorkflowDispatch: async () => {
        calls++;
        throw Object.assign(new Error("Bad gateway"), { status: 502 });
      },
    });
    await expect(
      client.triggerWorkflow(".github/workflows/ci.yml", "main"),
    ).rejects.toThrow("Bad gateway");
    expect(calls).toBe(1);
  });

  it("retries a rate-limited 403 on workflow dispatch", async () => {
    let calls = 0;
    const client = clientWith({
      createWorkflowDispatch: async () => {
        calls++;
        if (calls < 2) {
          throw Object.assign(new Error("secondary rate limit"), {
            status: 403,
            response: { headers: { "retry-after": "0" } },
          });
        }
        return { data: {} };
      },
    });
    // withRetry's first backoff inside triggerWorkflow is 1000ms (not
    // injectable from here); wait it out with a real timer.
    const promise = client.triggerWorkflow(".github/workflows/ci.yml", "main");
    await new Promise((r) => setTimeout(r, 1100));
    await promise;
    expect(calls).toBe(2);
  }, 10_000);

  it("retries a 5xx while locating the dispatched run (idempotent read)", async () => {
    let calls = 0;
    const client = clientWith({
      listWorkflowRuns: async () => {
        calls++;
        if (calls < 2) {
          throw Object.assign(new Error("Bad gateway"), { status: 502 });
        }
        return {
          data: {
            workflow_runs: [
              { id: 7, status: "queued", conclusion: null, html_url: "u" },
            ],
          },
        };
      },
    });
    const promise = client.findWorkflowRun(
      ".github/workflows/ci.yml",
      "merge-queue/batch-x",
      new Date(),
      "headsha",
    );
    await new Promise((r) => setTimeout(r, 1100));
    const handle = await promise;
    expect(handle.runId).toBe(7);
    expect(calls).toBe(2);
  }, 10_000);
});
