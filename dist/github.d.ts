import * as github from "@actions/github";
import type { PR, WorkflowRunHandle, WorkflowRunResult } from "./queue.js";
import type { FullAPI } from "./action.js";
type Octokit = ReturnType<typeof github.getOctokit>;
type LogFunc = (msg: string) => void;
/**
 * Classifies a thrown value as a TRANSIENT GitHub API error worth retrying
 * in-process (before the caller falls back to a full workflow re-run):
 * 429 / 5xx, or a rate-limit 403 (see `isRateLimitedError`). Permanent
 * errors (401/403-permission/404/422) are NOT retryable — they propagate
 * immediately so the orchestrator can mark the PR failed. Note octokit
 * wraps network-level failures (ECONNRESET, DNS, aborts) in a status-500
 * RequestError, so they are covered by the 5xx branch.
 */
export declare function isRetryableHttpError(err: unknown): boolean;
/**
 * Retry predicate for NON-IDEMPOTENT requests (workflow dispatch): only
 * throttle responses (429 / rate-limit 403), which GitHub rejects before
 * processing, are safe to resend. A 5xx is ambiguous — the dispatch may
 * have been registered before the error — and re-sending it would start a
 * duplicate workflow run, so it propagates to the requeue path instead
 * (which rebuilds the batch branch, making the orphan run harmless).
 */
export declare function isThrottleError(err: unknown): boolean;
/** Default minutes to wait for a dispatched CI run to complete. */
export declare const DEFAULT_CI_WAIT_MINUTES = 60;
/**
 * Poll attempts (10s apart) for a given CI wait budget. Floors at one
 * minute so a typo can't reduce the wait below a useful minimum.
 */
export declare function ciWaitAttempts(minutes: number): number;
/**
 * Runs `fn`, retrying transient GitHub API errors with exponential backoff.
 * A transient blip is absorbed in-run instead of failing the job and forcing
 * a full requeue; a permanent error (or one past `attempts`) propagates so
 * the caller classifies/requeues. `retryIf` narrows what counts as
 * retryable (e.g. `isThrottleError` for non-idempotent requests);
 * `sleepFn` is injectable for tests.
 */
export declare function withRetry<T>(fn: () => Promise<T>, opts?: {
    attempts?: number;
    baseMs?: number;
    retryIf?: (err: unknown) => boolean;
    log?: LogFunc;
    sleepFn?: (ms: number) => Promise<void>;
}): Promise<T>;
/**
 * GitHubClient implements FullAPI (GitHubAPI + WorkflowAPI + the PR/actor
 * lookups) using the GitHub REST API. Declaring the full interface here —
 * not just at the runProcess call site — makes any signature drift surface
 * on the drifted method instead of as an opaque assignability error in
 * main.ts.
 */
export declare class GitHubClient implements FullAPI {
    readonly octokit: Octokit;
    readonly owner: string;
    readonly repo: string;
    private readonly log;
    private readonly waitAttempts;
    constructor(token: string, owner: string, repo: string, log?: LogFunc, opts?: {
        ciWaitMinutes?: number;
    });
    listPRsWithLabel(label: string, limit: number): Promise<PR[]>;
    addLabel(prNumber: number, label: string): Promise<void>;
    removeLabel(prNumber: number, label: string): Promise<void>;
    comment(prNumber: number, body: string): Promise<void>;
    createLabel(name: string, color: string, description: string): Promise<void>;
    triggerWorkflow(workflowFile: string, ref: string, inputs?: Record<string, string>): Promise<void>;
    findWorkflowRun(workflowFile: string, ref: string, dispatchedAt: Date, headSha?: string): Promise<WorkflowRunHandle>;
    waitForWorkflowRun(runId: number): Promise<WorkflowRunResult>;
    closePR(prNumber: number): Promise<void>;
    getPR(prNumber: number): Promise<PR>;
    getActorPermission(username: string): Promise<string>;
}
export {};
