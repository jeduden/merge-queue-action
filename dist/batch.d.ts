import { type Reporter } from "./reporter.js";
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
    mergeBranch(branch: string, sourceRef: string, commitMsg: string): Promise<boolean>;
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
export declare class Batch {
    private git;
    private dryRun;
    private log;
    private reporter;
    constructor(git: GitOperator, dryRun: boolean, log?: LogFunc, reporter?: Reporter);
    /**
     * Creates a batch branch from main and merges each PR into it.
     * PRs that conflict are recorded in the result but do not stop the process.
     */
    createAndMerge(batchID: string, prs: BatchPR[]): Promise<MergeResult>;
    /** Fast-forwards main to the batch branch and cleans up. Returns the new main SHA. */
    completeMerge(branch: string): Promise<string>;
}
export {};
