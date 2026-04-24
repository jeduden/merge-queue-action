import type { CommentCtx } from "./comments.js";
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
     */
    warn(msg: string): Promise<void>;
    /**
     * Run `fn` with `prs` as the active scope. Nested calls preserve
     * the previous scope and restore it on completion / exception.
     */
    withScope<T>(prs: number[], fn: () => Promise<T>): Promise<T>;
}
/** Default no-op reporter — handy for tests and for the `dryRun` path. */
export declare const noopReporter: Reporter;
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
