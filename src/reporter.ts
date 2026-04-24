import { commentOperatorWarning } from "./comments.js";
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
export const noopReporter: Reporter = {
  info: () => {},
  warn: async () => {},
  withScope: async (_prs, fn) => fn(),
};

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
        // run. Log with a real message string rather than letting
        // `${err}` render an object as `[object Object]`.
        const detail =
          err instanceof Error ? err.message : String(err);
        this.log(
          `Warning: failed to post merge-queue warning comment on PR #${pr}: ${detail}`,
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
