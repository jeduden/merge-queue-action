import { errorMessage, silentReporter, type Reporter } from "./reporter.js";
import { ConfigurationError } from "./errors.js";

/**
 * GitOperator defines the interface for git operations.
 *
 * Error contract — LOAD-BEARING for the retry orchestration: the
 * orchestrator routes on `err instanceof ConfigurationError` to decide
 * between marking PRs failed (permanent, operator must fix) and requeueing
 * them (transient, cap-bounded). Implementations MUST throw
 * `ConfigurationError` (errors.ts) for failures that no retry can resolve:
 *   - `createBranchFromRef`: missing worktree / shallow clone;
 *   - `pushBranch`: pushes rejected for missing token scope (e.g. workflow
 *     files without the `workflow` scope);
 *   - `fastForwardMain`: branch-protection / ruleset rejections and
 *     missing-permission errors updating `main`.
 * An implementation that throws plain `Error` for those downgrades a
 * permanent misconfiguration to a retried-until-the-cap transient.
 */
export interface GitOperator {
  createBranchFromRef(branch: string, baseRef: string): Promise<void>;
  mergeBranch(
    branch: string,
    sourceRef: string,
    commitMsg: string,
  ): Promise<boolean>;
  pushBranch(branch: string): Promise<void>;
  getHeadSHA(ref: string): Promise<string>;
  /** Fast-forwards main to the given ref and returns the resulting main SHA. */
  fastForwardMain(ref: string): Promise<string>;
  deleteBranch(branch: string): Promise<void>;
}

/** PR holds the minimal info needed for batch operations. */
export interface BatchPR {
  number: number;
  headRef: string;
  headSHA: string;
  title: string;
}

/** MergeResult describes the outcome of merging PRs into a batch branch. */
export interface MergeResult {
  branch: string;
  headSHA?: string;
  merged: BatchPR[];
  conflicted: BatchPR[];
}

type LogFunc = (msg: string) => void;

/** Batch manages batch branch creation and merging. */
export class Batch {
  private git: GitOperator;
  private dryRun: boolean;
  private log: LogFunc;
  private reporter: Reporter;

  constructor(
    git: GitOperator,
    dryRun: boolean,
    log?: LogFunc,
    reporter?: Reporter,
  ) {
    this.git = git;
    this.dryRun = dryRun;
    this.log = log ?? (() => {});
    this.reporter = reporter ?? silentReporter;
  }

  /**
   * Creates a batch branch from main and merges each PR into it.
   * PRs that conflict are recorded in the result but do not stop the process.
   */
  async createAndMerge(
    batchID: string,
    prs: BatchPR[],
  ): Promise<MergeResult> {
    const branch = `merge-queue/batch-${batchID}`;
    const result: MergeResult = { branch, merged: [], conflicted: [] };

    // Scope Reporter warnings raised inside this call (including
    // those raised by GitOps via the Reporter) to the PRs that are
    // part of this batch. Errors emitted before this point — e.g.
    // during label collection — would not carry PR routing.
    const prNumbers = prs.map((p) => p.number);
    return this.reporter.withScope(prNumbers, async () => {
      this.log(`Creating batch branch ${branch} from main`);
      if (!this.dryRun) {
        await this.git.createBranchFromRef(branch, "main");
      }

      for (const pr of prs) {
        this.log(`Merging PR #${pr.number} (${pr.headRef}) into ${branch}`);
        if (this.dryRun) {
          result.merged.push(pr);
          continue;
        }

        const msg = `Merge PR #${pr.number}: ${pr.title}`;
        let ok: boolean;
        try {
          ok = await this.git.mergeBranch(branch, pr.headSHA, msg);
        } catch (err) {
          try {
            await this.git.deleteBranch(branch);
          } catch (delErr) {
            await this.reporter.warn(
              `failed to delete batch branch \`${branch}\` after a merge error: ${errorMessage(delErr)}`,
            );
          }
          // A ConfigurationError must reach the orchestrator with its type
          // intact (it routes to markFailed, not requeue) — wrapping it in
          // a plain Error would silently downgrade a permanent
          // misconfiguration to a retried-forever transient.
          if (err instanceof ConfigurationError) throw err;
          // `errorMessage(err)` keeps the thrown message readable
          // for non-Error rejections; `{ cause }` preserves the
          // original value for structured debuggers (Node logs the
          // cause chain in its default Error printer).
          throw new Error(
            `merging PR #${pr.number}: ${errorMessage(err)}`,
            { cause: err },
          );
        }

        if (!ok) {
          result.conflicted.push(pr);
          continue;
        }
        result.merged.push(pr);
      }

      if (result.merged.length > 0 && !this.dryRun) {
        this.log(`Pushing batch branch ${branch}`);
        try {
          await this.git.pushBranch(branch);
        } catch (err) {
          // Best-effort cleanup so a failed push doesn't leak the
          // `merge-queue/batch-*` ref. Rethrow the ORIGINAL error so its
          // type is preserved: a ConfigurationError (e.g. the token lacks
          // `workflow` scope) must reach the orchestrator unchanged so it
          // marks the PR failed instead of requeueing it.
          try {
            await this.git.deleteBranch(branch);
          } catch (delErr) {
            await this.reporter.warn(
              `failed to delete batch branch \`${branch}\` after a push error: ${errorMessage(delErr)}`,
            );
          }
          throw err;
        }
        // Capture the head SHA for reliable workflow run lookup.
        // This is best-effort: the batch branch has already been
        // pushed successfully, so a SHA lookup failure should not
        // fail the whole batch creation.
        try {
          result.headSHA = await this.git.getHeadSHA(branch);
        } catch (err) {
          await this.reporter.warn(
            `failed to capture head SHA for batch branch \`${branch}\`: ${errorMessage(err)}`,
          );
        }
      }

      return result;
    });
  }

  /** Fast-forwards main to the batch branch and cleans up. Returns the new main SHA. */
  async completeMerge(branch: string): Promise<string> {
    this.log(`Fast-forwarding main to ${branch}`);
    if (this.dryRun) return "";
    const sha = await this.git.fastForwardMain(branch);
    this.log(`Deleting batch branch ${branch}`);
    try {
      await this.git.deleteBranch(branch);
    } catch (err) {
      // The merge to main already happened — a failed branch delete must
      // not throw, or the caller would misclassify a SUCCESSFUL merge as
      // a fast-forward failure and requeue freshly-merged PRs.
      await this.reporter.warn(
        `failed to delete batch branch \`${branch}\` after merging: ${errorMessage(err)}`,
      );
    }
    return sha;
  }
}
