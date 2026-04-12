import * as github from "@actions/github";
import type { PR, GitHubAPI, WorkflowAPI } from "./queue.js";
type Octokit = ReturnType<typeof github.getOctokit>;
/** GitHubClient implements GitHubAPI and WorkflowAPI using the GitHub REST API. */
export declare class GitHubClient implements GitHubAPI, WorkflowAPI {
    readonly octokit: Octokit;
    readonly owner: string;
    readonly repo: string;
    constructor(token: string, owner: string, repo: string);
    listPRsWithLabel(label: string, limit: number): Promise<PR[]>;
    addLabel(prNumber: number, label: string): Promise<void>;
    removeLabel(prNumber: number, label: string): Promise<void>;
    comment(prNumber: number, body: string): Promise<void>;
    createLabel(name: string, color: string, description: string): Promise<void>;
    triggerWorkflow(workflowFile: string, ref: string, inputs?: Record<string, string>): Promise<void>;
    getWorkflowRunStatus(workflowFile: string, ref: string, dispatchedAt: Date): Promise<string>;
    closePR(prNumber: number): Promise<void>;
    getPR(prNumber: number): Promise<PR>;
    getActorPermission(username: string): Promise<string>;
}
export {};
