import { describe, expect, it } from "vitest";
import {
  PRReporter,
  errorMessage,
  noopReporter,
  type CommentPoster,
} from "./reporter.js";
import type { CommentCtx } from "./comments.js";

const ctx: CommentCtx = {
  serverUrl: "https://github.com",
  ownerRepo: "o/r",
  actionRunUrl: "https://github.com/o/r/actions/runs/1",
  queueLabel: "queue",
};

function makePoster(): CommentPoster & {
  calls: Array<{ pr: number; body: string }>;
  failOn?: number;
  failError?: unknown;
} {
  const p = {
    calls: [] as Array<{ pr: number; body: string }>,
    failOn: undefined as number | undefined,
    failError: undefined as unknown,
    async comment(pr: number, body: string) {
      p.calls.push({ pr, body });
      if (p.failOn === pr) {
        throw p.failError ?? new Error("poster failed");
      }
    },
  };
  return p;
}

describe("PRReporter", () => {
  it("info only logs", () => {
    const poster = makePoster();
    const logged: string[] = [];
    const r = new PRReporter({
      poster,
      ctx,
      log: (m) => logged.push(m),
      dryRun: false,
    });
    r.info("hello");
    expect(logged).toEqual(["hello"]);
    expect(poster.calls).toEqual([]);
  });

  it("warn with no scope logs but does not comment", async () => {
    const poster = makePoster();
    const logged: string[] = [];
    const r = new PRReporter({
      poster,
      ctx,
      log: (m) => logged.push(m),
      dryRun: false,
    });
    await r.warn("something happened");
    expect(logged).toEqual(["Warning: something happened"]);
    expect(poster.calls).toEqual([]);
  });

  it("warn inside withScope posts one comment per scoped PR", async () => {
    const poster = makePoster();
    const logged: string[] = [];
    const r = new PRReporter({
      poster,
      ctx,
      log: (m) => logged.push(m),
      dryRun: false,
    });
    await r.withScope([1, 2, 3], async () => {
      await r.warn("batch branch leaked");
    });
    expect(poster.calls.map((c) => c.pr)).toEqual([1, 2, 3]);
    expect(poster.calls[0].body).toContain("<!-- merge-queue:warning -->");
    expect(poster.calls[0].body).toContain("batch branch leaked");
    expect(poster.calls[0].body).toContain(ctx.actionRunUrl);
  });

  it("warn in dryRun logs but does not comment", async () => {
    const poster = makePoster();
    const logged: string[] = [];
    const r = new PRReporter({
      poster,
      ctx,
      log: (m) => logged.push(m),
      dryRun: true,
    });
    await r.withScope([42], async () => {
      await r.warn("would warn");
    });
    expect(logged).toEqual(["Warning: would warn"]);
    expect(poster.calls).toEqual([]);
  });

  it("does not throw if the poster throws; logs per-PR failure", async () => {
    const poster = makePoster();
    poster.failOn = 2;
    poster.failError = new Error("418 teapot");
    const logged: string[] = [];
    const r = new PRReporter({
      poster,
      ctx,
      log: (m) => logged.push(m),
      dryRun: false,
    });
    await r.withScope([1, 2, 3], async () => {
      await r.warn("oops");
    });
    // PR 1 and PR 3 still got their comments — poster failure on 2
    // didn't short-circuit the rest.
    expect(poster.calls.map((c) => c.pr)).toEqual([1, 2, 3]);
    // Failure surfaced in the log with the error's message, not
    // `[object Object]`.
    expect(
      logged.some((m) =>
        m.includes("failed to post merge-queue warning comment on PR #2"),
      ),
    ).toBe(true);
    expect(logged.some((m) => m.includes("418 teapot"))).toBe(true);
  });

  it("formats non-Error poster failures by extracting `.message`", async () => {
    const poster = makePoster();
    poster.failOn = 7;
    // Simulates the shape of an unwrapped octokit RequestError: a
    // plain object with `status` + `message`, not a real Error.
    poster.failError = { status: 503, message: "gone" };
    const logged: string[] = [];
    const r = new PRReporter({
      poster,
      ctx,
      log: (m) => logged.push(m),
      dryRun: false,
    });
    await r.withScope([7], async () => {
      await r.warn("thing");
    });
    const failureLine = logged.find((m) =>
      m.includes("failed to post merge-queue warning comment on PR #7"),
    );
    expect(failureLine).toBeDefined();
    // Must show the extracted `.message` ("gone"), NOT "[object Object]".
    expect(failureLine).toContain("gone");
    expect(failureLine).not.toContain("[object Object]");
  });

  it("withScope restores the previous scope on success", async () => {
    const poster = makePoster();
    const r = new PRReporter({
      poster,
      ctx,
      log: () => {},
      dryRun: false,
    });
    await r.withScope([1, 2], async () => {
      await r.withScope([99], async () => {
        await r.warn("inner");
      });
      await r.warn("outer");
    });
    const inner = poster.calls.filter((c) => c.body.includes("inner"));
    const outer = poster.calls.filter((c) => c.body.includes("outer"));
    expect(inner.map((c) => c.pr)).toEqual([99]);
    expect(outer.map((c) => c.pr)).toEqual([1, 2]);
  });

  it("withScope restores the previous scope on exception", async () => {
    const poster = makePoster();
    const r = new PRReporter({
      poster,
      ctx,
      log: () => {},
      dryRun: false,
    });
    await r.withScope([1, 2], async () => {
      await expect(
        r.withScope([99], async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // After the throw, scope 1,2 must still be in effect.
      await r.warn("after-throw");
    });
    expect(
      poster.calls.filter((c) => c.body.includes("after-throw")).map((c) => c.pr),
    ).toEqual([1, 2]);
  });

  it("warn's scope snapshot is stable if scope changes mid-await", async () => {
    const poster = makePoster();
    // Slow the poster so we can mutate scope between comments.
    let resolveNext: (() => void) | null = null;
    poster.comment = async (pr, body) => {
      poster.calls.push({ pr, body });
      await new Promise<void>((res) => {
        resolveNext = res;
      });
    };
    const r = new PRReporter({
      poster,
      ctx,
      log: () => {},
      dryRun: false,
    });

    const warnPromise = r.withScope([1, 2], () => r.warn("queued"));

    // Wait a tick, then drain the first comment.
    await Promise.resolve();
    await Promise.resolve();
    resolveNext?.();
    resolveNext = null;
    // While warn is mid-loop, swap the scope; this must NOT affect
    // which PRs the in-flight warn targets.
    const swap = r.withScope([999], async () => {});
    await swap;

    await Promise.resolve();
    await Promise.resolve();
    resolveNext?.();
    await warnPromise;

    expect(poster.calls.map((c) => c.pr)).toEqual([1, 2]);
  });
});

describe("noopReporter", () => {
  it("info/warn no-ops and withScope still runs fn", async () => {
    expect(() => noopReporter.info("x")).not.toThrow();
    await expect(noopReporter.warn("x")).resolves.toBeUndefined();
    const result = await noopReporter.withScope([1, 2], async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("errorMessage", () => {
  it("uses Error.message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("uses a string value verbatim", () => {
    expect(errorMessage("boom")).toBe("boom");
  });

  it("extracts .message from a plain object (octokit-shaped)", () => {
    expect(errorMessage({ status: 500, message: "server down" })).toBe(
      "server down",
    );
  });

  it("ignores a non-string .message and falls back to String()", () => {
    // Object with a non-string `message`: don't pick it up, fall
    // back to String() so we don't return `undefined` or a number.
    expect(errorMessage({ message: 42 })).toBe("[object Object]");
  });

  it("falls back to String() for numbers and booleans", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(false)).toBe("false");
  });

  it("falls back to String() for null/undefined safely", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("falls back to String() for a plain object with no message", () => {
    // Known limitation: truly opaque objects degrade to
    // `[object Object]`. Documented so the fallback behaviour is
    // stable.
    expect(errorMessage({ foo: "bar" })).toBe("[object Object]");
  });
});
