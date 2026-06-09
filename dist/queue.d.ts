/** PR represents a pull request in the merge queue. */
export interface PR {
    number: number;
    headRef: string;
    headSHA: string;
    title: string;
    state?: "open" | "closed";
    createdAt: number;
    /**
     * Current label names on the PR. Optional because the issues-list
     * code path filters by label and so callers don't need them; populated
     * by `getPR` so callers can re-validate label state on a single PR.
     */
    labels?: string[];
}
export type LabelState = "" | "active" | "failed";
export declare const STATE_PENDING: LabelState;
export declare const STATE_ACTIVE: LabelState;
export declare const STATE_FAILED: LabelState;
/**
 * Default cap on how many times a single PR may be requeued before the queue
 * gives up and marks it failed. This is the backstop that GUARANTEES a
 * deterministic failure can never re-trigger the workflow forever: error
 * classification (ConfigurationError, HTTP 404/422, …) can never be complete
 * over an open-ended failure space, so a root-cause-agnostic attempt cap
 * bounds every requeue path — including ones whose permanent failure slips
 * past classification.
 */
export declare const MAX_REQUEUE_ATTEMPTS = 10;
/** The attempt-counter label for a given count, e.g. `queue:attempt-3`. */
export declare function attemptLabel(base: string, n: number): string;
/**
 * Reads the highest requeue-attempt count encoded in a PR's labels
 * (`<base>:attempt-N`), returning 0 when none is present, alongside the
 * concrete attempt-label names found so callers can clear them. Tolerates
 * multiple/stale attempt labels by taking the max.
 */
export declare function readAttemptCount(base: string, labels: string[] | undefined): {
    count: number;
    labels: string[];
};
/** Returns the full label string for a given state. */
export declare function queueLabel(base: string, state: LabelState): string;
/** Identifies a workflow run that has been dispatched. */
export interface WorkflowRunHandle {
    runId: number;
    htmlUrl: string;
}
/** Final result of a workflow run once it has completed. */
export interface WorkflowRunResult {
    conclusion: string;
    htmlUrl: string;
}
/** GitHubAPI defines the interface for GitHub operations needed by the queue. */
export interface GitHubAPI {
    listPRsWithLabel(label: string, limit: number): Promise<PR[]>;
    addLabel(prNumber: number, label: string): Promise<void>;
    removeLabel(prNumber: number, label: string): Promise<void>;
    comment(prNumber: number, body: string): Promise<void>;
    createLabel(name: string, color: string, description: string): Promise<void>;
}
/** WorkflowAPI defines the interface for workflow dispatch and polling. */
export interface WorkflowAPI {
    triggerWorkflow(workflowFile: string, ref: string, inputs?: Record<string, string>): Promise<void>;
    /** Waits for the dispatched workflow run to appear and returns its URL. */
    findWorkflowRun(workflowFile: string, ref: string, dispatchedAt: Date, headSha?: string): Promise<WorkflowRunHandle>;
    /** Polls an already-located run until it completes. */
    waitForWorkflowRun(runId: number): Promise<WorkflowRunResult>;
    closePR(prNumber: number): Promise<void>;
}
type LogFunc = (msg: string) => void;
/** Queue manages the merge queue label state machine. Comment composition lives at the orchestration layer. */
export declare class Queue {
    private api;
    private label;
    private dryRun;
    private log;
    private maxAttempts;
    constructor(api: GitHubAPI, label: string, dryRun: boolean, log?: LogFunc, maxAttempts?: number);
    /** The effective requeue cap (after validation), for comment text. */
    get attemptCap(): number;
    /** Removes every `<base>:attempt-N` label currently known on the PR. */
    private clearAttemptLabels;
    /** Returns open PRs with the queue label, sorted oldest first. */
    collect(limit: number): Promise<PR[]>;
    /** Transitions PRs from pending to active state. */
    activate(prs: PR[]): Promise<void>;
    /** Transitions a PR to the failed state. */
    markFailed(pr: PR, reason: string): Promise<void>;
    /**
     * Moves a PR back to pending state so the queue retries it — UNLESS it has
     * already been requeued `maxAttempts` times, in which case it is marked
     * failed instead. Returns `true` if the PR was requeued, `false` if the
     * attempt cap was reached (the PR is now in the failed state).
     *
     * The cap is the root-cause-agnostic backstop: even a permanent failure
     * that error classification fails to recognise can re-enter the queue at
     * most `maxAttempts` times before this turns it into the terminal
     * `failed` state, which the workflow's label trigger no longer matches.
     */
    requeue(pr: PR): Promise<boolean>;
    /** Creates the queue labels in the repository. */
    setupLabels(): Promise<void>;
}
export {};
