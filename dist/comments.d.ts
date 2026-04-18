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
export declare function commentRequeued(ctx: CommentCtx, reason: string): string;
