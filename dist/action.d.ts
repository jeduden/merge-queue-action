import { type PR, type GitHubAPI, type WorkflowAPI } from "./queue.js";
import { type GitOperator } from "./batch.js";
export interface Config {
    ciWorkflow: string;
    batchSize: number;
    queueLabel: string;
    dryRun: boolean;
    batchPrs: string;
}
/** FullAPI combines all GitHub API interfaces needed by the orchestration. */
export interface FullAPI extends GitHubAPI, WorkflowAPI {
    getActorPermission(username: string): Promise<string>;
    /** Fetch a single PR by number. Throws if not found. */
    getPR(prNumber: number): Promise<PR>;
}
export declare function hasWritePermission(perm: string): boolean;
/**
 * Returns the repo-relative workflow path for dispatch.
 * Reads MERGE_QUEUE_WORKFLOW_FILE if set, otherwise parses GITHUB_WORKFLOW_REF.
 */
export declare function selfWorkflowFile(): string;
export declare function runProcess(api: FullAPI, gitOps: GitOperator, cfg: Config, log: (msg: string) => void, actor?: string): Promise<void>;
export declare function runBisect(api: FullAPI, gitOps: GitOperator, cfg: Config, log: (msg: string) => void): Promise<void>;
export declare function runSetup(api: GitHubAPI, cfg: Config, log: (msg: string) => void): Promise<void>;
