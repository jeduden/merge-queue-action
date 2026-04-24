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
     * Verify the runner is actually inside a git working tree with an
     * `origin` remote before we issue any `git` command. Without this
     * check, callers who forgot `actions/checkout` (or ran the action in
     * a directory with no remote) would hit a generic `git ... failed`
     * error deep in the merge flow; this surfaces the real problem early
     * and points at the required workflow step.
     */
    private assertWorktreeReady;
    createBranchFromRef(branch: string, baseRef: string): Promise<void>;
    mergeBranch(branch: string, sourceRef: string, commitMsg: string): Promise<boolean>;
    pushBranch(branch: string): Promise<void>;
    fastForwardMain(ref: string): Promise<string>;
    deleteBranch(branch: string): Promise<void>;
}
export {};
