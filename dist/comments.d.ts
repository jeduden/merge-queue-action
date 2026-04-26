/** Context for building links inside PR comments. */
export interface CommentCtx {
    serverUrl: string;
    ownerRepo: string;
    actionRunUrl: string;
    queueLabel: string;
}
export declare function formatErrorForComment(err: unknown, maxLen?: number): string;
export declare function commentPickedUp(ctx: CommentCtx): string;
export declare function commentCIRunning(ctx: CommentCtx, batchBranch: string, siblingPRs: number[], ciRunUrl: string): string;
export declare function commentMerged(ctx: CommentCtx, mergeSha: string, ciRunUrl: string): string;
export declare function commentCIFailed(ctx: CommentCtx, ciRunUrl: string, viaBisection: boolean): string;
export declare function commentMergeConflict(ctx: CommentCtx): string;
export declare function commentBisecting(ctx: CommentCtx, batchBranch: string, leftCount: number, totalCount: number, ciRunUrl: string): string;
/**
 * Operator-facing warning posted when the queue hits a non-fatal but
 * worth-surfacing condition (leaked refs, teardown failures,
 * unexpected cleanup paths). The leading HTML comment is a dedup
 * marker so future tooling can recognise and collapse these.
 */
export declare function commentOperatorWarning(ctx: CommentCtx, msg: string): string;
export declare function commentRequeued(ctx: CommentCtx, reason: string): string;
/**
 * Posted when the merge queue action cannot proceed because the workflow is
 * misconfigured (e.g. missing `actions/checkout`, shallow clone, wrong CI
 * workflow name).  Unlike `commentRequeued`, this error will NOT resolve by
 * itself — the operator must fix the issue before the PR can be retried.
 */
export declare function commentConfigError(ctx: CommentCtx, detail: string): string;
