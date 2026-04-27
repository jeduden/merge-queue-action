import * as github from "@actions/github";
import type { PR, GitHubAPI, WorkflowAPI, WorkflowRunHandle, WorkflowRunResult } from "./queue.js";
type Octokit = ReturnType<typeof github.getOctokit>;
type LogFunc = (msg: string) => void;
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
