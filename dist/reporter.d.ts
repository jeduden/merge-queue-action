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
export declare function errorMessage(err: unknown): string;
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
export declare const silentReporter: Reporter;
/**
 * `loggingReporter(log)` returns a Reporter that forwards `info`
 * and `warn` to the provided log function but never posts comments.
 * Useful when a layer has a `log` callback handy but no
 * `CommentPoster` / `CommentCtx` — for example tests asserting on
 * "Warning: …" strings, or any internal default that should still
 * surface warnings in the run log.
 */
export declare function loggingReporter(log: (msg: string) => void): Reporter;
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
export declare class PRReporter implements Reporter {
    private poster;
    private ctx;
    private log;
    private dryRun;
    private scope;
    constructor(opts: PRReporterOpts);
    info(msg: string): void;
    warn(msg: string): Promise<void>;
    withScope<T>(prs: number[], fn: () => Promise<T>): Promise<T>;
}
