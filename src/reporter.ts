import { commentOperatorWarning } from "./comments.js";
import type { CommentCtx } from "./comments.js";

/**
 * Extract a short, readable message from an arbitrary thrown value.
 *
 * Shapes in priority order:
 *   1. `Error` — use `err.message`.
 *   2. string — use the string itself.
 *   3. plain object with a string `message` (e.g. octokit's
 *      `RequestError` before it's been wrapped into a real Error) —
 *      use that `message`.
 *   4. anything else — `String(err)` (which can degrade to
 *      `[object Object]` for exotic throws, but at least won't
 *      crash).
 *
 * The entire body is wrapped in try/catch so that truly exotic
 * throws — objects with throwing `message` getters, throwing
 * `toString()`, proxies that trap on property access — can't in
 * turn throw out of an error-handling path. In that last-resort
 * case we return a fixed string so callers stay on the happy path.
 *
 * Exists so call sites don't inline `err instanceof Error ? ... :
 * String(err)` at every catch. That pattern doubles branch count
 * per site AND silently renders plain objects as `[object Object]`
 * in logs/PR comments; centralising it keeps warnings actionable.
 */
export function errorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    if (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as { message: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
    return String(err);
  } catch {
    return "unknown error";
  }
}

/** Minimal comment-poster interface — lets tests mock without pulling in the full GitHubAPI. */
export interface CommentPoster {
  comment(prNumber: number, body: string): Promise<void>;
}

/**
 * Reporter is the surface that lets internal layers (GitOps, Batch,
 * action orchestration) emit operator-facing messages that land both
 * in the Actions log AND — for `warn()` calls — as comments on the
 * PRs currently in scope.
 *
 * The scope is set by the orchestration layer (which knows which PRs
 * a given operation covers) via `withScope`. Lower layers like
 * GitOps don't need to pass PR numbers; they just call `warn` and
 * the active scope carries the routing information.
 */
export interface Reporter {
  /** Log-only informational message. */
  info(msg: string): void;
  /**
   * Log + post a comment on every PR in the current scope. If no
   * scope is active, degrades to log-only. Never throws — comment
   * failures are logged and swallowed so a flaky API call can't
   * abort the merge-queue run.
   *
   * Implementations are expected to log every `warn` call (so
   * operators see every warning at least in the run log). The
   * exception is `silentReporter` below, whose explicit purpose is
   * to swallow output for tests/internal call sites that don't care.
   */
  warn(msg: string): Promise<void>;
  /**
   * Run `fn` with `prs` as the active scope. Nested calls preserve
   * the previous scope and restore it on completion / exception.
   */
  withScope<T>(prs: number[], fn: () => Promise<T>): Promise<T>;
}

/**
 * `silentReporter` discards everything (no log, no comment). Use
 * sparingly — it deliberately violates the "warn must log"
 * convention because it exists for tests / internal helpers that
 * don't care about side effects. Production call sites should pass
 * a `PRReporter` (logs + comments) or `loggingReporter` (logs only)
 * so warnings always reach the run log.
 */
export const silentReporter: Reporter = {
  info: () => {},
  warn: async () => {},
  withScope: async (_prs, fn) => fn(),
};

/**
 * `loggingReporter(log)` returns a Reporter that forwards `info`
 * and `warn` to the provided log function but never posts comments.
 * Useful when a layer has a `log` callback handy but no
 * `CommentPoster` / `CommentCtx` — for example tests asserting on
 * "Warning: …" strings, or any internal default that should still
 * surface warnings in the run log.
 */
export function loggingReporter(log: (msg: string) => void): Reporter {
  return {
    info: (msg) => log(msg),
    warn: async (msg) => {
      log(`Warning: ${msg}`);
    },
    withScope: async (_prs, fn) => fn(),
  };
}

export interface PRReporterOpts {
  poster: CommentPoster;
  ctx: CommentCtx;
  log: (msg: string) => void;
  /** When true, warnings log but no PR comments are posted. */
  dryRun: boolean;
}

/**
 * PRReporter is the production Reporter. Warnings are logged and,
 * when PRs are in scope, posted once per PR with a
 * `<!-- merge-queue:warning -->` marker so readers (humans and
 * bots) can find or dedupe them.
 */
export class PRReporter implements Reporter {
  private poster: CommentPoster;
  private ctx: CommentCtx;
  private log: (msg: string) => void;
  private dryRun: boolean;
  private scope: number[] = [];

  constructor(opts: PRReporterOpts) {
    this.poster = opts.poster;
    this.ctx = opts.ctx;
    this.log = opts.log;
    this.dryRun = opts.dryRun;
  }

  info(msg: string): void {
    this.log(msg);
  }

  async warn(msg: string): Promise<void> {
    this.log(`Warning: ${msg}`);
    if (this.dryRun) return;
    if (this.scope.length === 0) return;

    // Snapshot the scope: if `warn` is awaited across a scope change
    // (unlikely in practice but cheap to be safe), we still comment
    // on the PRs the warning was raised for, not a later scope's.
    const targets = [...this.scope];
    const body = commentOperatorWarning(this.ctx, msg);
    for (const pr of targets) {
      try {
        await this.poster.comment(pr, body);
      } catch (err) {
        // Don't rethrow — reporter failures must never abort the
        // run. Extract a real message string so plain-object
        // rejections (e.g. octokit `RequestError`s before they're
        // wrapped) don't render as `[object Object]` in the log.
        this.log(
          `Warning: failed to post merge-queue warning comment on PR #${pr}: ${errorMessage(err)}`,
        );
      }
    }
  }

  async withScope<T>(prs: number[], fn: () => Promise<T>): Promise<T> {
    const prev = this.scope;
    this.scope = [...prs];
    try {
      return await fn();
    } finally {
      this.scope = prev;
    }
  }
}
