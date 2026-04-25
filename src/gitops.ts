import { spawn } from "node:child_process";
import type * as github from "@actions/github";
import type { GitOperator } from "./batch.js";
import { errorMessage, silentReporter, type Reporter } from "./reporter.js";

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
        // Force non-interactive git. Without this, a missing credential
        // helper or a misconfigured remote can cause `git fetch`/`push`
        // to block waiting for a terminal prompt, which in a runner
        // manifests as the job hanging until the job timeout. We
        // deliberately do NOT set GIT_ASKPASS to a platform-specific
        // binary (e.g. `/bin/true`) so the action stays portable
        // across ubuntu/macos/windows runners — GIT_TERMINAL_PROMPT=0
        // alone is enough to fail fast, and the existing credential
        // helper configured by `actions/checkout` still handles auth.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
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
  private reporter: Reporter;

  constructor(
    octokit: Octokit,
    owner: string,
    repo: string,
    opts?: { exec?: Exec; log?: LogFunc; reporter?: Reporter },
  ) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.exec = opts?.exec ?? defaultExec();
    this.log = opts?.log ?? (() => {});
    this.reporter = opts?.reporter ?? silentReporter;
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

  /**
   * Verify the runner is actually inside a git working tree with an
   * `origin` remote before we issue any `git` command. Without this
   * check, callers who forgot `actions/checkout` (or ran the action in
   * a directory with no remote) would hit a generic `git ... failed`
   * error deep in the merge flow; this surfaces the real problem early
   * and points at the required workflow step.
   */
  private async assertWorktreeReady(): Promise<void> {
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      throw new Error(
        "merge-queue-action must run in a checked-out git working tree — add an `actions/checkout` step with `fetch-depth: 0` and a pushable token before this action.",
      );
    }
    const remote = await this.git(["remote", "get-url", "origin"]);
    if (remote.code !== 0) {
      throw new Error(
        "merge-queue-action could not find an `origin` remote in the working tree — make sure `actions/checkout` ran in the same job with the merge-queue token.",
      );
    }
    // `actions/checkout` defaults to `fetch-depth: 1`, which produces a
    // shallow clone. Local merges of PR head SHAs — especially across
    // older common ancestors — need full history; refuse early with a
    // targeted message instead of letting a later `git merge` fail
    // with a confusing "fatal: refusing to merge unrelated histories".
    const shallow = await this.git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.code === 0 && shallow.stdout.trim() === "true") {
      throw new Error(
        "merge-queue-action requires a full-history clone, but the working tree is a shallow repository. Set `fetch-depth: 0` on the `actions/checkout` step (or run `git fetch --unshallow` before invoking this action).",
      );
    }
  }

  async createBranchFromRef(branch: string, baseRef: string): Promise<void> {
    this.log(`Creating branch ${branch} from ${baseRef}`);

    await this.assertWorktreeReady();

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

    // Best-effort cleanup: the remote ref is already created, so if
    // fetch/checkout fails locally we'd otherwise leak a
    // `merge-queue/batch-*` branch on origin. Delete the ref before
    // rethrowing so subsequent retries aren't polluted by stale
    // branches.
    try {
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
    } catch (err) {
      this.log(
        `Local fetch/checkout failed after creating ${branch} on origin; deleting the leaked ref`,
      );
      try {
        await this.octokit.rest.git.deleteRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${branch}`,
        });
      } catch (delErr) {
        // `errorMessage` handles Error / string / `{ message }` /
        // other shapes so plain-object rejections don't render as
        // `[object Object]` in the log or the PR comment.
        // Reporter.warn also routes this to every PR in scope, so
        // an orphan `merge-queue/batch-*` on origin surfaces on
        // the affected PRs, not just the Actions log.
        await this.reporter.warn(
          `failed to delete leaked batch branch \`${branch}\` on origin after a local fetch/checkout error: ${errorMessage(delErr)}`,
        );
      }
      throw err;
    }
  }

  async mergeBranch(
    branch: string,
    sourceRef: string,
    commitMsg: string,
  ): Promise<boolean> {
    this.log(`Merging ${sourceRef} into ${branch}`);

    await this.gitOrThrow(["checkout", branch]);
    // Fetch by raw SHA: this works on GitHub because
    // `uploadpack.allowReachableSHA1InWant` is enabled, which makes PR
    // head SHAs — including fork-PR heads, reachable via
    // `refs/pull/<N>/head` — fetchable without knowing the ref name.
    // If you "optimise" this to fetch a branch, fork PRs will break.
    await this.gitOrThrow(["fetch", "--no-tags", "origin", sourceRef]);

    // `-c commit.gpgsign=false` / `-c tag.gpgsign=false`: `git merge
    // --no-ff` creates a merge commit and would otherwise inherit any
    // global signing config (common on self-hosted runners). If the
    // signing key isn't available to the action, signing blocks the
    // merge — disable it explicitly for this invocation only so repo
    // and user config elsewhere are untouched.
    const merge = await this.git([
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "merge",
      "--no-ff",
      "-m",
      commitMsg,
      sourceRef,
    ]);
    if (merge.code === 0) return true;

    // git merge returns 1 on a real merge conflict; any other non-zero
    // exit is a real error (missing user.email, unknown revision,
    // failed hook, etc.) and must surface as a throw rather than being
    // mis-labelled `queue:failed`.
    if (merge.code !== 1) {
      throw new Error(
        `git merge failed (exit ${merge.code}): ${merge.stderr.trim() || merge.stdout.trim()}`,
      );
    }

    this.log(
      `git merge reported a conflict (exit 1); aborting. stderr: ${merge.stderr.trim()}`,
    );
    const abort = await this.git(["merge", "--abort"]);
    if (abort.code !== 0) {
      // Leave the working tree tidy even if --abort is a no-op (merge
      // may have failed before touching the index).
      const reset = await this.git(["reset", "--hard", "HEAD"]);
      if (reset.code !== 0) {
        // Both cleanup paths failed — the working tree may be dirty,
        // which would silently corrupt the next PR's merge if we kept
        // going. Throw so the batch stops and the failure surfaces
        // with enough detail to diagnose.
        throw new Error(
          `failed to clean up conflicted merge: both \`git merge --abort\` and \`git reset --hard HEAD\` failed; worktree is in an unknown state. abort stderr: ${abort.stderr.trim()}; reset stderr: ${reset.stderr.trim()}`,
        );
      }
    }
    return false;
  }

  async pushBranch(branch: string): Promise<void> {
    this.log(`Pushing ${branch} to origin`);
    // No `--force-with-lease` / `--force`: batch branches are
    // single-writer and disposable, so any concurrent update means
    // something has gone wrong and the push *should* fail loudly
    // rather than clobber the other writer.
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
