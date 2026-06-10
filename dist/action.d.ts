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
    /**
     * Max times a single PR may be requeued before the queue gives up and
     * marks it failed. Bounds every retry path so a deterministic failure
     * cannot re-trigger the workflow forever. Defaults to
     * `MAX_REQUEUE_ATTEMPTS` when unset.
     */
    maxRequeues?: number;
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
/**
 * Parses the max_requeues input: "" → the default; canonical digits → the
 * number; anything else → NaN. Strict on purpose — parseInt would silently
 * accept numeric-prefix garbage ("1O" → 1) and change the cap, while NaN
 * makes the Queue constructor warn loudly and use the default, matching
 * the documented invalid-input behavior.
 */
export declare function parseMaxRequeues(raw: string): number;
/** Default for the batch_size input (mirrored in action.yml / README). */
export declare const DEFAULT_BATCH_SIZE = 5;
/**
 * Parses the batch_size input with the same strictness as
 * `parseMaxRequeues`: "" → the default; canonical digits → the number
 * ("0" means no batch limit, the pre-existing semantics); anything else →
 * the default with the invalid value reported via `warn`. The lenient
 * parseInt this replaces turned "five" into NaN — which disabled both the
 * listing limit and the batch trim, silently batching the entire backlog.
 */
export declare function parseBatchSize(raw: string, warn?: (msg: string) => void): number;
/**
 * Parses the ci_wait_minutes input with the house strictness: "" → the
 * default; canonical digits ≥ 1 → the number; anything else → the default
 * with a warning.
 */
export declare function parseCiWaitMinutes(raw: string, fallback: number, warn?: (msg: string) => void): number;
/**
 * Returns true for GitHub API errors that indicate a PERMANENT problem an
 * operator must fix — never resolved by a retry, so the PR must be marked
 * failed rather than requeued:
 *   - 404: the resource (e.g. a workflow file) doesn't exist
 *   - 422: the request is structurally invalid (e.g. no `workflow_dispatch`)
 *   - 403: the token lacks a required permission (e.g. `actions: write`)
 *
 * Deliberately transient:
 *   - a rate-limited 403 (see `isRateLimitedError`);
 *   - 401 — an expired GitHub App installation token 401s after a long CI
 *     wait, and the next run mints a fresh token; the requeue cap bounds
 *     the genuinely-dead-credential case.
 */
export declare function isHttpConfigError(err: unknown): boolean;
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
