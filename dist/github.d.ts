import * as github from "@actions/github";
import type { PR, GitHubAPI, WorkflowAPI, WorkflowRunHandle, WorkflowRunResult } from "./queue.js";
type Octokit = ReturnType<typeof github.getOctokit>;
type LogFunc = (msg: string) => void;
/**
 * Classifies a thrown value as a TRANSIENT GitHub API error worth retrying
 * in-process (before the caller falls back to a full workflow re-run):
 * 429 / 5xx, or a secondary-rate-limit 403 (retry-after, exhausted quota, or
 * a rate-limit message). Permanent errors (401/403-permission/404/422) are
 * NOT retryable — they propagate immediately so the orchestrator can mark
 * the PR failed.
 */
export declare function isRetryableHttpError(err: unknown): boolean;
/**
 * Runs `fn`, retrying transient GitHub API errors with exponential backoff.
 * A transient blip is absorbed in-run instead of failing the job and forcing
 * a full requeue; a permanent error (or one past `attempts`) propagates so
 * the caller classifies/requeues. `sleepFn` is injectable for tests.
 */
export declare function withRetry<T>(fn: () => Promise<T>, opts?: {
    attempts?: number;
    baseMs?: number;
    log?: LogFunc;
    sleepFn?: (ms: number) => Promise<void>;
}): Promise<T>;
/** GitHubClient implements GitHubAPI and WorkflowAPI using the GitHub REST API. */
export declare class GitHubClient implements GitHubAPI, WorkflowAPI {
    readonly octokit: Octokit;
    readonly owner: string;
    readonly repo: string;
    private readonly log;
    constructor(token: string, owner: string, repo: string, log?: LogFunc);
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
