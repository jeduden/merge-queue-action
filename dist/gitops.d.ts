import type * as github from "@actions/github";
import type { GitOperator } from "./batch.js";
type Octokit = ReturnType<typeof github.getOctokit>;
/**
 * GitOps implements GitOperator using the GitHub API.
 * All operations are server-side — no local git binary required.
 */
export declare class GitOps implements GitOperator {
    private octokit;
    private owner;
    private repo;
    private log;
    constructor(octokit: Octokit, owner: string, repo: string, log?: (msg: string) => void);
    createBranchFromRef(branch: string, baseRef: string): Promise<void>;
    mergeBranch(branch: string, sourceRef: string, commitMsg: string): Promise<boolean>;
    pushBranch(branch: string): Promise<void>;
    fastForwardMain(ref: string): Promise<void>;
    deleteBranch(branch: string): Promise<void>;
}
export {};
