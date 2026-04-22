import { spawn } from "node:child_process";
import type * as github from "@actions/github";
import type { GitOperator } from "./batch.js";

type Octokit = ReturnType<typeof github.getOctokit>;

type LogFunc = (msg: string) => void;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<ExecResult>;

export function defaultExec(cwd?: string): Exec {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: opts?.cwd ?? cwd,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}

/**
 * GitOps implements GitOperator using a hybrid of the GitHub Git Data
 * API (for branch creation, fast-forward and deletion) and local
 * `git merge` (for per-PR merges). Running the merge locally is what
 * lets `.gitattributes` and `merge.<name>.driver` config take effect,
 * so repos with custom merge drivers see them honoured during batching.
 *
 * The workflow calling this action must run `actions/checkout` with a
 * pushable token before the action step so the working tree is ready
 * for `git fetch` / `git merge` / `git push`.
 */
export class GitOps implements GitOperator {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private exec: Exec;
  private log: LogFunc;

  constructor(
    octokit: Octokit,
    owner: string,
    repo: string,
    opts?: { exec?: Exec; log?: LogFunc },
  ) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.exec = opts?.exec ?? defaultExec();
    this.log = opts?.log ?? (() => {});
  }

  private async git(args: string[]): Promise<ExecResult> {
    return this.exec(args);
  }

  private async gitOrThrow(args: string[]): Promise<string> {
    const res = await this.git(args);
    if (res.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    return res.stdout;
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

    await this.gitOrThrow([
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    await this.gitOrThrow([
      "checkout",
      "-B",
      branch,
      `refs/remotes/origin/${branch}`,
    ]);
  }

  async mergeBranch(
    branch: string,
    sourceRef: string,
    commitMsg: string,
  ): Promise<boolean> {
    this.log(`Merging ${sourceRef} into ${branch}`);

    await this.gitOrThrow(["checkout", branch]);
    await this.gitOrThrow(["fetch", "--no-tags", "origin", sourceRef]);

    const merge = await this.git([
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      commitMsg,
      sourceRef,
    ]);
    if (merge.code === 0) return true;

    this.log(
      `git merge returned ${merge.code}; aborting and reporting conflict. stderr: ${merge.stderr.trim()}`,
    );
    const abort = await this.git(["merge", "--abort"]);
    if (abort.code !== 0) {
      // Leave the working tree tidy even if --abort is a no-op (merge
      // may have failed before touching the index).
      await this.git(["reset", "--hard", "HEAD"]);
    }
    return false;
  }

  async pushBranch(branch: string): Promise<void> {
    this.log(`Pushing ${branch} to origin`);
    await this.gitOrThrow(["push", "origin", `${branch}:refs/heads/${branch}`]);
  }

  async fastForwardMain(ref: string): Promise<string> {
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

    return sha;
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
