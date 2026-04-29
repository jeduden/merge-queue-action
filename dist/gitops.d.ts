import type * as github from "@actions/github";
import type { GitOperator } from "./batch.js";
import { type Reporter } from "./reporter.js";
type Octokit = ReturnType<typeof github.getOctokit>;
type LogFunc = (msg: string) => void;
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type Exec = (args: string[], opts?: {
    cwd?: string;
}) => Promise<ExecResult>;
export declare function defaultExec(cwd?: string): Exec;
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
export declare class GitOps implements GitOperator {
    private octokit;
    private owner;
    private repo;
    private exec;
    private log;
    private reporter;
    constructor(octokit: Octokit, owner: string, repo: string, opts?: {
        exec?: Exec;
        log?: LogFunc;
        reporter?: Reporter;
    });
    private git;
    private gitOrThrow;
    /**
     * Configure local git so subsequent merges and pushes from this
     * action work without any user-side wiring:
     *
     *   - sets `user.email` / `user.name` so `git merge --no-ff` can
     *     create the merge commit (without identity, git refuses);
     *   - rewrites `origin` to an `https://x-access-token:<token>@…` URL
     *     so `git fetch`/`git push` authenticate with the merge-queue
     *     token regardless of whether `actions/checkout` persisted any
     *     credentials.
     *
     * Idempotent: every call writes the same values, so re-running is
     * safe even if the action runs twice in a single job.
     */
    configureGit(opts: {
        token: string;
        userEmail: string;
        userName: string;
        serverUrl?: string;
    }): Promise<void>;
    /**
     * Verify the runner is actually inside a git working tree with an
     * `origin` remote before we issue any `git` command. Without this
     * check, callers who forgot `actions/checkout` (or ran the action in
     * a directory with no remote) would hit a generic `git ... failed`
     * error deep in the merge flow; this surfaces the real problem early
     * and points at the required workflow step.
     */
    private assertWorktreeReady;
    createBranchFromRef(branch: string, baseRef: string): Promise<void>;
    /**
     * Invoke the pre-merge-commit hook if it exists.
     *
     * Git's pre-merge-commit hook is normally invoked by `git merge` when
     * it creates a commit. Since we use `git merge --no-commit`, we must
     * invoke the hook manually to allow hooks (like mdsmith's) to fix
     * generated sections after all files are merged but before the final
     * commit is created.
     *
     * Returns an ExecResult with code 0 if the hook passed or didn't exist,
     * or non-zero if the hook exists and rejected the merge.
     */
    private invokePreMergeCommitHook;
    mergeBranch(branch: string, sourceRef: string, commitMsg: string): Promise<boolean>;
    getHeadSHA(ref: string): Promise<string>;
    pushBranch(branch: string): Promise<void>;
    fastForwardMain(ref: string): Promise<string>;
    deleteBranch(branch: string): Promise<void>;
}
export {};
