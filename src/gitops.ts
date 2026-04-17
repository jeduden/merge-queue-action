import type * as github from "@actions/github";
import type { GitOperator } from "./batch.js";

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * GitOps implements GitOperator using the GitHub API.
 * All operations are server-side — no local git binary required.
 */
export class GitOps implements GitOperator {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private log: (msg: string) => void;

  constructor(
    octokit: Octokit,
    owner: string,
    repo: string,
    log?: (msg: string) => void,
  ) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.log = log ?? (() => {});
  }

  async createBranchFromRef(branch: string, baseRef: string): Promise<void> {
    this.log(`Creating branch ${branch} from ${baseRef}`);

    const { data: ref } = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${baseRef}`,
    });
    const sha = ref.object.sha;

    await this.octokit.rest.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  async mergeBranch(
    branch: string,
    sourceRef: string,
    commitMsg: string,
  ): Promise<boolean> {
    this.log(`Merging ${sourceRef} into ${branch}`);

    try {
      await this.octokit.rest.repos.merge({
        owner: this.owner,
        repo: this.repo,
        base: branch,
        head: sourceRef,
        commit_message: commitMsg,
      });
      return true;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 409) return false;
      throw err;
    }
  }

  async pushBranch(branch: string): Promise<void> {
    // Server-side merges are already pushed — nothing to do
    this.log(`Branch ${branch} already up to date on remote`);
  }

  async fastForwardMain(ref: string): Promise<void> {
    this.log(`Fast-forwarding main to ${ref}`);

    const { data: srcRef } = await this.octokit.rest.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${ref}`,
    });
    const sha = srcRef.object.sha;

    await this.octokit.rest.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/main`,
      sha,
      force: false,
    });
  }

  async deleteBranch(branch: string): Promise<void> {
    this.log(`Deleting branch ${branch}`);
    await this.octokit.rest.git.deleteRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branch}`,
    });
  }
}
