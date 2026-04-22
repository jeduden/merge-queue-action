import type * as github from "@actions/github";
import type { GitOperator } from "./batch.js";
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
    constructor(octokit: Octokit, owner: string, repo: string, opts?: {
        exec?: Exec;
        log?: LogFunc;
    });
    private git;
    private gitOrThrow;
    createBranchFromRef(branch: string, baseRef: string): Promise<void>;
    mergeBranch(branch: string, sourceRef: string, commitMsg: string): Promise<boolean>;
    pushBranch(branch: string): Promise<void>;
    fastForwardMain(ref: string): Promise<string>;
    deleteBranch(branch: string): Promise<void>;
}
export {};
