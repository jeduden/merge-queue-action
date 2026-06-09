/** PR represents a pull request in the merge queue. */
export interface PR {
    number: number;
    headRef: string;
    headSHA: string;
    title: string;
    state?: "open" | "closed";
    createdAt: number;
    /**
     * Current label names on the PR — LOAD-BEARING for the requeue cap.
     * `readAttemptCount` derives the cross-run attempt counter from the
     * `<base>:attempt-N` labels in this snapshot, so every `GitHubAPI`
     * implementation MUST populate it on both the list path
     * (`listPRsWithLabel`) and the single-PR path (`getPR`); an
     * implementation that omits it silently resets every PR's budget and
     * re-arms the unbounded-retry loop the cap exists to stop. Optional
     * only because test fixtures construct partial PRs.
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
 * multiple/stale attempt labels by taking the max. Only canonical
 * `attemptLabel` forms count — a strictly numeric suffix — so a stray
 * human label like `queue:attempt-2-old` (or an exotic numeral like
 * `queue:attempt-1e9`) neither inflates the count nor gets deleted by
 * the cleanup that consumes `labels`.
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
    /**
     * Removes the given attempt labels from the PR. Takes the parsed list
     * (from a single `readAttemptCount` pass) rather than re-deriving it, so
     * the labels removed remotely and any in-memory bookkeeping the caller
     * does are guaranteed to come from the same parse.
     */
    private clearAttemptLabels;
    /**
     * Resets a PR's requeue-attempt counter. Called when the PR makes real
     * progress — it merged, or its head changed (the author pushed) — so the
     * budget never penalises progress-driven retries. Also strips the attempt
     * labels from the in-memory `pr.labels` snapshot, so a `requeue` later in
     * the same run starts counting from zero instead of the stale snapshot.
     */
    resetAttempts(pr: PR): Promise<void>;
    /** Returns open PRs with the queue label, sorted oldest first. */
    collect(limit: number): Promise<PR[]>;
    /**
     * Transitions PRs from pending to active state. Returns the numbers of
     * PRs that were SKIPPED because their base label disappeared between
     * listing and activation — with `requireBaseLabel`, a 404 removing the
     * base label is treated as the author de-queueing in that window, the
     * `:active` label is rolled back, and the PR must not be batched.
     * Without the option (the manual `batch_prs` path, which is documented
     * to work on unlabelled PRs), a missing base label is tolerated as
     * before and nothing is skipped.
     */
    activate(prs: PR[], opts?: {
        requireBaseLabel?: boolean;
    }): Promise<number[]>;
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
     *
     * Action-layer callers must route through `requeueOrGiveUp` (action.ts)
     * rather than calling this directly: a `false` return means the cap
     * marked the PR failed, and only the wrapper posts the operator-facing
     * "retry limit reached" comment — a direct call gives up silently.
     */
    requeue(pr: PR): Promise<boolean>;
    /** Creates the queue labels in the repository. */
    setupLabels(): Promise<void>;
}
export {};
