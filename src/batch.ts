/** GitOperator defines the interface for git operations. */
export interface GitOperator {
  createBranchFromRef(branch: string, baseRef: string): Promise<void>;
  mergeBranch(
    branch: string,
    sourceBranch: string,
    commitMsg: string,
  ): Promise<boolean>;
  pushBranch(branch: string): Promise<void>;
  fastForwardMain(ref: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
}

/** PR holds the minimal info needed for batch operations. */
export interface BatchPR {
  number: number;
  headRef: string;
  title: string;
}

/** MergeResult describes the outcome of merging PRs into a batch branch. */
export interface MergeResult {
  branch: string;
  merged: BatchPR[];
  conflicted: BatchPR[];
}

type LogFunc = (msg: string) => void;

/** Batch manages batch branch creation and merging. */
export class Batch {
  private git: GitOperator;
  private dryRun: boolean;
  private log: LogFunc;

  constructor(git: GitOperator, dryRun: boolean, log?: LogFunc) {
    this.git = git;
    this.dryRun = dryRun;
    this.log = log ?? (() => {});
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
        ok = await this.git.mergeBranch(branch, pr.headRef, msg);
      } catch (err) {
        try {
          await this.git.deleteBranch(branch);
        } catch (delErr) {
          this.log(
            `Warning: failed to delete batch branch ${branch}: ${delErr}`,
          );
        }
        throw new Error(`merging PR #${pr.number}: ${err}`);
      }

      if (!ok) {
        result.conflicted.push(pr);
        continue;
      }
      result.merged.push(pr);
    }

    if (result.merged.length > 0 && !this.dryRun) {
      this.log(`Pushing batch branch ${branch}`);
      await this.git.pushBranch(branch);
    }

    return result;
  }

  /** Fast-forwards main to the batch branch and cleans up. */
  async completeMerge(branch: string): Promise<void> {
    this.log(`Fast-forwarding main to ${branch}`);
    if (this.dryRun) return;
    await this.git.fastForwardMain(branch);
    this.log(`Deleting batch branch ${branch}`);
    await this.git.deleteBranch(branch);
  }
}
