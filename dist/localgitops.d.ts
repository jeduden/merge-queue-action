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
 * LocalGitOps implements GitOperator by shelling out to a local `git`
 * binary in the runner's working tree. This path respects
 * `.gitattributes` and `merge.<name>.driver` config, so repositories
 * with custom merge drivers can use them during batch merges.
 *
 * Branch creation, fast-forward and deletion still go through the Git
 * Data API so they remain atomic and ruleset-friendly; only the actual
 * merges run locally.
 */
export declare class LocalGitOps implements GitOperator {
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
