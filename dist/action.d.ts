import { type PR, type GitHubAPI, type WorkflowAPI } from "./queue.js";
import { type GitOperator } from "./batch.js";
import { type Reporter } from "./reporter.js";
import { type CommentCtx } from "./comments.js";
export interface Config {
    ciWorkflow: string;
    batchSize: number;
    queueLabel: string;
    dryRun: boolean;
    batchPrs: string;
    /** Required by runProcess/runBisect; unused by runSetup. */
    commentCtx?: CommentCtx;
    /**
     * PR number from a `pull_request:labeled` event whose label matches
     * `queueLabel`. When set, runProcess fetches that PR directly if the
     * issues-list endpoint didn't return it — defends against the brief
     * window where the label has been added on the PR but isn't yet
     * reflected in the labels filter, and against subtle label-name
     * encoding mismatches.
     */
    triggerLabeledPR?: number;
}
/**
 * Parses the batch_prs input string into an array of PR numbers.
 * Accepts:
 *   - A JSON array of positive integers: "[187]" or "[181,187]"
 *   - A single positive integer string: "187" (operator convenience)
 * Returns an empty array for an empty/whitespace-only string.
 * Throws a descriptive error for any other input.
 */
export declare function parseBatchPrs(input: string): number[];
export type { CommentCtx };
/** FullAPI combines all GitHub API interfaces needed by the orchestration. */
export interface FullAPI extends GitHubAPI, WorkflowAPI {
    getActorPermission(username: string): Promise<string>;
    /** Fetch a single PR by number. Throws if not found. */
    getPR(prNumber: number): Promise<PR>;
}
export declare function hasWritePermission(perm: string): boolean;
/**
 * If the workflow was triggered by a `pull_request: labeled` event whose
 * label matches `queueLabel`, return that PR's number. Otherwise undefined.
 *
 * The webhook payload is the authoritative signal for the just-added
 * label and is delivered before the issues-list endpoint is guaranteed to
 * reflect it. Surfacing the PR number here lets `runProcess` fetch the PR
 * directly when the label-filtered list omits it (indexing lag, label-name
 * encoding mismatch, replication moment).
 *
 * Pure-functional shape so the caller (main.ts) injects `github.context`
 * and unit tests can hand in a synthetic context.
 */
export declare function eventTriggerLabeledPR(ctx: {
    eventName: string;
    payload: unknown;
}, queueLabel: string): number | undefined;
/**
 * Returns the repo-relative workflow path for dispatch.
 * Reads MERGE_QUEUE_WORKFLOW_FILE if set, otherwise parses GITHUB_WORKFLOW_REF.
 */
export declare function selfWorkflowFile(): string;
export declare function runProcess(api: FullAPI, gitOps: GitOperator, cfg: Config, log: (msg: string) => void, actor?: string, reporterArg?: Reporter): Promise<void>;
export declare function runBisect(api: FullAPI, gitOps: GitOperator, cfg: Config, log: (msg: string) => void, reporterArg?: Reporter): Promise<void>;
export declare function runSetup(api: GitHubAPI, cfg: Config, log: (msg: string) => void): Promise<void>;
