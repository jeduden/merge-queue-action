import {
  Queue,
  queueLabel,
  STATE_ACTIVE,
  type PR,
  type GitHubAPI,
  type WorkflowAPI,
  type WorkflowRunHandle,
  type WorkflowRunResult,
} from "./queue.js";
import { Batch, type BatchPR, type MergeResult, type GitOperator } from "./batch.js";
import { split } from "./bisect.js";
import {
  type CommentCtx,
  formatErrorForComment,
  commentPickedUp,
  commentCIRunning,
  commentMerged,
  commentCIFailed,
  commentMergeConflict,
  commentBisecting,
  commentRequeued,
} from "./comments.js";

export interface Config {
  ciWorkflow: string;
  batchSize: number;
  queueLabel: string;
  dryRun: boolean;
  batchPrs: string;
  /** Required by runProcess/runBisect; unused by runSetup. */
  commentCtx?: CommentCtx;
}

function requireCtx(cfg: Config): CommentCtx {
  if (!cfg.commentCtx) {
    throw new Error(
      "Config.commentCtx is required for runProcess/runBisect",
    );
  }
  return cfg.commentCtx;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { CommentCtx };

/** FullAPI combines all GitHub API interfaces needed by the orchestration. */
export interface FullAPI extends GitHubAPI, WorkflowAPI {
  getActorPermission(username: string): Promise<string>;
  /** Fetch a single PR by number. Throws if not found. */
  getPR(prNumber: number): Promise<PR>;
}

export function hasWritePermission(perm: string): boolean {
  return perm === "write" || perm === "maintain" || perm === "admin";
}

/**
 * Returns the repo-relative workflow path for dispatch.
 * Reads MERGE_QUEUE_WORKFLOW_FILE if set, otherwise parses GITHUB_WORKFLOW_REF.
 */
export function selfWorkflowFile(): string {
  const override = process.env.MERGE_QUEUE_WORKFLOW_FILE;
  if (override) return override;

  let ref = process.env.GITHUB_WORKFLOW_REF;
  if (!ref) {
    throw new Error(
      "GITHUB_WORKFLOW_REF is not set; set MERGE_QUEUE_WORKFLOW_FILE when running outside GitHub Actions",
    );
  }

  const atIdx = ref.indexOf("@");
  if (atIdx > 0) ref = ref.slice(0, atIdx);

  const parts = ref.split("/");
  if (parts.length < 3 || !parts[2]) {
    throw new Error(`invalid GITHUB_WORKFLOW_REF "${ref}"`);
  }
  return parts.slice(2).join("/");
}

async function postComment(
  api: GitHubAPI,
  prNumber: number,
  body: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await api.comment(prNumber, body);
  } catch (err) {
    log(`Warning: failed to comment on PR #${prNumber}: ${err}`);
  }
}

async function ensurePRClosedAfterMerge(
  api: FullAPI,
  prNumber: number,
  log: (msg: string) => void,
): Promise<void> {
  const attempts = 3;
  let confirmedOpen = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const current = await api.getPR(prNumber);
      if (current.state === "closed") return;
      confirmedOpen = true;
    } catch (err) {
      log(`Warning: failed to read PR #${prNumber} state after merge: ${err}`);
    }
    if (i < attempts - 1) await sleep(50);
  }
  if (confirmedOpen) {
    log(`PR #${prNumber} is still open after merge; closing explicitly`);
  } else {
    log(
      `PR #${prNumber}: unable to confirm PR is closed; attempting to close explicitly`,
    );
  }
  try {
    await api.closePR(prNumber);
  } catch (err) {
    log(`Warning: failed to close PR #${prNumber}: ${err}`);
  }
}

async function handleCIFailure(
  api: FullAPI,
  cfg: Config,
  ctx: CommentCtx,
  q: Queue,
  gitOps: GitOperator,
  prs: PR[],
  result: MergeResult,
  ciRunUrl: string,
  log: (msg: string) => void,
): Promise<void> {
  // Clean up the failed batch branch
  try {
    await gitOps.deleteBranch(result.branch);
  } catch (err) {
    log(`Warning: failed to delete batch branch ${result.branch}: ${err}`);
  }

  if (result.merged.length === 1) {
    // Single PR failed — mark it
    const pr = prs.find((p) => p.number === result.merged[0].number);
    if (pr) {
      await q.markFailed(pr, "CI failed");
      if (!cfg.dryRun) {
        await postComment(
          api,
          pr.number,
          commentCIFailed(ctx, ciRunUrl, false),
          log,
        );
      }
    }
    return;
  }

  // Multiple PRs failed — trigger bisection
  const prNumbers = result.merged.map((mp) => mp.number);
  const prJSON = JSON.stringify(prNumbers);
  log(`CI failed for batch, triggering bisection for PRs: ${prNumbers}`);

  if (!cfg.dryRun) {
    const wf = selfWorkflowFile();
    await api.triggerWorkflow(wf, "main", {
      batch_prs: prJSON,
      bisect: "true",
    });
  }
}

export async function runProcess(
  api: FullAPI,
  gitOps: GitOperator,
  cfg: Config,
  log: (msg: string) => void,
  actor?: string,
): Promise<void> {
  const ctx = requireCtx(cfg);

  // Check actor permission
  if (actor) {
    const perm = await api.getActorPermission(actor);
    if (!hasWritePermission(perm)) {
      log(
        `Actor ${actor} has "${perm}" permission, write or above required — skipping`,
      );
      return;
    }
    log(`Actor ${actor} has "${perm}" permission, proceeding`);
  }

  const q = new Queue(api, cfg.queueLabel, cfg.dryRun, log);
  const b = new Batch(gitOps, cfg.dryRun, log);

  // 1. Collect queued PRs
  const prs = await q.collect(cfg.batchSize);
  if (prs.length === 0) {
    log("No PRs in queue");
    return;
  }
  log(`Processing ${prs.length} PRs`);

  // 2. Activate PRs and post the "picked up" comment
  await q.activate(prs);
  if (!cfg.dryRun) {
    for (const pr of prs) {
      await postComment(api, pr.number, commentPickedUp(ctx), log);
    }
  }

  const excluded = new Set<number>();

  const requeueAll = async (reason?: string): Promise<void> => {
    if (cfg.dryRun) return;
    for (const pr of prs) {
      if (excluded.has(pr.number)) continue;
      try {
        await q.requeue(pr);
      } catch (err) {
        log(
          `Warning: failed to requeue PR #${pr.number} after error: ${err}`,
        );
        continue;
      }
      if (reason) {
        await postComment(
          api,
          pr.number,
          commentRequeued(ctx, reason),
          log,
        );
      }
    }
  };

  const cleanupBranch = async (branch: string): Promise<void> => {
    if (!cfg.dryRun && branch) {
      try {
        await gitOps.deleteBranch(branch);
      } catch (err) {
        log(`Warning: failed to delete branch ${branch}: ${err}`);
      }
    }
  };

  // 3. Create batch branch and merge PRs
  const batchPRs: BatchPR[] = prs.map((pr) => ({
    number: pr.number,
    headRef: pr.headRef,
    headSHA: pr.headSHA,
    title: pr.title,
  }));

  const batchID = `${prs[0].number}-${Math.floor(Date.now() / 1000)}`;
  let result: MergeResult;
  try {
    result = await b.createAndMerge(batchID, batchPRs);
  } catch (err) {
    await requeueAll(`batch creation failed: ${formatErrorForComment(err)}`);
    throw err;
  }

  // 4. Eject conflicted PRs
  for (const cp of result.conflicted) {
    const pr = prs.find((p) => p.number === cp.number);
    if (pr) {
      try {
        await q.markFailed(pr, "merge conflict");
        excluded.add(pr.number);
        if (!cfg.dryRun) {
          await postComment(
            api,
            pr.number,
            commentMergeConflict(ctx),
            log,
          );
        }
      } catch (err) {
        log(`Warning: failed to mark PR #${pr.number} as failed: ${err}`);
      }
    }
  }

  if (result.merged.length === 0) {
    log("No PRs merged successfully");
    if (!cfg.dryRun) {
      try {
        await gitOps.deleteBranch(result.branch);
      } catch (err) {
        log(`Warning: failed to delete empty batch branch: ${err}`);
      }
    }
    return;
  }

  // 5. Trigger CI, announce the run URL to PRs as soon as it appears,
  //    then wait for completion.
  log(`Triggering CI workflow ${cfg.ciWorkflow} on ${result.branch}`);
  let ciRunUrl = "";
  if (!cfg.dryRun) {
    const dispatchedAt = new Date();
    try {
      await api.triggerWorkflow(cfg.ciWorkflow, result.branch);
    } catch (err) {
      await cleanupBranch(result.branch);
      await requeueAll(
        `failed to trigger CI: ${formatErrorForComment(err)}`,
      );
      throw new Error(`triggering CI: ${formatErrorForComment(err)}`);
    }

    let runHandle: WorkflowRunHandle;
    try {
      runHandle = await api.findWorkflowRun(
        cfg.ciWorkflow,
        result.branch,
        dispatchedAt,
      );
    } catch (err) {
      await cleanupBranch(result.branch);
      await requeueAll(
        `failed to locate CI run: ${formatErrorForComment(err)}`,
      );
      throw new Error(`locating CI run: ${formatErrorForComment(err)}`);
    }
    ciRunUrl = runHandle.htmlUrl;

    // Announce CI-running state now — before blocking on completion.
    for (const mp of result.merged) {
      const siblings = result.merged
        .filter((p) => p.number !== mp.number)
        .map((p) => p.number);
      await postComment(
        api,
        mp.number,
        commentCIRunning(ctx, result.branch, siblings, ciRunUrl),
        log,
      );
    }

    log("Waiting for CI result...");
    let runResult: WorkflowRunResult;
    try {
      runResult = await api.waitForWorkflowRun(runHandle.runId);
    } catch (err) {
      await cleanupBranch(result.branch);
      await requeueAll(
        `failed to read CI status: ${formatErrorForComment(err)}`,
      );
      throw new Error(`getting CI status: ${formatErrorForComment(err)}`);
    }

    if (runResult.conclusion !== "success") {
      try {
        await handleCIFailure(
          api,
          cfg,
          ctx,
          q,
          gitOps,
          prs,
          result,
          ciRunUrl,
          log,
        );
      } catch (err) {
        await requeueAll(
          `error handling CI failure: ${formatErrorForComment(err)}`,
        );
        throw err;
      }
      return;
    }
  }

  // 6. CI passed — merge to main
  if (!cfg.dryRun) {
    const drifted = [] as { number: number; snapshot: string; current: string }[];
    try {
      for (const mp of result.merged) {
        const current = await api.getPR(mp.number);
        if (current.headSHA !== mp.headSHA) {
          drifted.push({
            number: mp.number,
            snapshot: mp.headSHA,
            current: current.headSHA,
          });
        }
      }
    } catch (err) {
      await cleanupBranch(result.branch);
      await requeueAll(
        `failed to verify PR state after CI: ${formatErrorForComment(err)}`,
      );
      throw new Error(
        `checking PR drift after CI: ${formatErrorForComment(err)}`,
      );
    }
    if (drifted.length > 0) {
      for (const d of drifted) {
        log(
          `PR #${d.number} head changed while CI ran (${d.snapshot} -> ${d.current}); skipping stale batch`,
        );
      }
      await cleanupBranch(result.branch);
      await requeueAll(
        "PR head changed while batch CI was running; queue will retry with a fresh batch",
      );
      return;
    }
  }

  let mergeSha = "";
  try {
    mergeSha = await b.completeMerge(result.branch);
  } catch (err) {
    await cleanupBranch(result.branch);
    await requeueAll(
      `failed to fast-forward main: ${formatErrorForComment(err)}`,
    );
    throw err;
  }

  // Clean up labels and comment on merged PRs
  for (const pr of prs) {
    if (!result.merged.some((mp) => mp.number === pr.number)) continue;
    log(`PR #${pr.number} merged successfully`);
    if (!cfg.dryRun) {
      try {
        await api.removeLabel(
          pr.number,
          queueLabel(cfg.queueLabel, STATE_ACTIVE),
        );
      } catch {
        /* best effort */
      }
      await ensurePRClosedAfterMerge(api, pr.number, log);
      await postComment(
        api,
        pr.number,
        commentMerged(ctx, mergeSha, ciRunUrl),
        log,
      );
    }
  }

  log("Batch merge complete");
}

/**
 * Cleans up a bisect batch branch and requeues the still-candidate PRs with
 * an explanatory comment. Used when the bisect CI run cannot be located or
 * observed (timeout/API error) — without this, the batch branch would leak
 * and the PRs would be stuck in `queue:active`.
 */
async function handleBisectObservationFailure(
  api: FullAPI,
  ctx: CommentCtx,
  q: Queue,
  gitOps: GitOperator,
  prMap: Map<number, PR>,
  prNumbers: number[],
  excluded: Set<number>,
  branch: string,
  reason: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await gitOps.deleteBranch(branch);
  } catch (err) {
    log(`Warning: failed to delete bisect branch ${branch}: ${err}`);
  }
  for (const n of prNumbers) {
    if (excluded.has(n)) continue;
    const pr = prMap.get(n);
    if (!pr) continue;
    try {
      await q.requeue(pr);
    } catch (reqErr) {
      log(`Warning: failed to requeue PR #${n}: ${reqErr}`);
      continue;
    }
    await postComment(api, n, commentRequeued(ctx, reason), log);
  }
}

export async function runBisect(
  api: FullAPI,
  gitOps: GitOperator,
  cfg: Config,
  log: (msg: string) => void,
): Promise<void> {
  const ctx = requireCtx(cfg);
  const prListStr = cfg.batchPrs;
  if (!prListStr) {
    throw new Error("batch_prs input is required for bisect mode");
  }

  let prNumbers: number[];
  try {
    prNumbers = JSON.parse(prListStr);
  } catch {
    throw new Error(`invalid batch_prs JSON: ${prListStr}`);
  }
  if (
    !Array.isArray(prNumbers) ||
    !prNumbers.every((n) => typeof n === "number" && Number.isInteger(n))
  ) {
    throw new Error(`batch_prs must be a JSON array of integers: ${prListStr}`);
  }
  if (prNumbers.length === 0) {
    log("No PRs to bisect");
    return;
  }

  const q = new Queue(api, cfg.queueLabel, cfg.dryRun, log);
  const b = new Batch(gitOps, cfg.dryRun, log);

  // Fetch only the specific PRs we are bisecting (avoids listing entire active queue)
  const prMap = new Map<number, PR>();
  for (const n of prNumbers) {
    try {
      prMap.set(n, await api.getPR(n));
    } catch {
      throw new Error(`bisect PR #${n} not found`);
    }
  }

  const [left, right] = split(prNumbers);
  log(`Bisecting: left=${JSON.stringify(left)}, right=${JSON.stringify(right)}`);

  // Build batch from left half
  const leftPRs: BatchPR[] = left.map((n) => {
    const pr = prMap.get(n)!;
    return {
      number: pr.number,
      headRef: pr.headRef,
      headSHA: pr.headSHA,
      title: pr.title,
    };
  });

  const batchID = `bisect-${left[0]}-${Math.floor(Date.now() / 1000)}`;
  const result = await b.createAndMerge(batchID, leftPRs);

  // Handle conflicts immediately — track so we never requeue them
  const excluded = new Set<number>();
  for (const cp of result.conflicted) {
    const pr = prMap.get(cp.number);
    if (pr) {
      try {
        await q.markFailed(pr, "merge conflict");
        excluded.add(cp.number);
        if (!cfg.dryRun) {
          await postComment(
            api,
            pr.number,
            commentMergeConflict(ctx),
            log,
          );
        }
      } catch (err) {
        log(`Warning: failed to mark PR #${cp.number} as failed: ${err}`);
      }
    }
  }

  // Narrow left to only actually-merged PRs
  const mergedLeft = result.merged.map((mp) => mp.number);

  if (mergedLeft.length === 0) {
    log("No PRs merged in bisect batch, nothing to test");
    if (!cfg.dryRun) {
      try {
        await gitOps.deleteBranch(result.branch);
      } catch {
        /* best effort */
      }
    }
    return;
  }

  // Run CI on left half
  log(`Running CI on left half: ${JSON.stringify(mergedLeft)}`);
  let conclusion = "success";
  let ciRunUrl = "";
  if (!cfg.dryRun) {
    const dispatchedAt = new Date();
    try {
      await api.triggerWorkflow(cfg.ciWorkflow, result.branch);
    } catch (err) {
      try {
        await gitOps.deleteBranch(result.branch);
      } catch {
        /* best effort */
      }
      throw new Error(
        `triggering CI for bisect: ${formatErrorForComment(err)}`,
      );
    }

    const runHandle = await (async () => {
      try {
        return await api.findWorkflowRun(
          cfg.ciWorkflow,
          result.branch,
          dispatchedAt,
        );
      } catch (err) {
        await handleBisectObservationFailure(
          api,
          ctx,
          q,
          gitOps,
          prMap,
          prNumbers,
          excluded,
          result.branch,
          `failed to locate bisect CI run: ${formatErrorForComment(err)}`,
          log,
        );
        throw new Error(
          `locating bisect CI run: ${formatErrorForComment(err)}`,
        );
      }
    })();
    ciRunUrl = runHandle.htmlUrl;

    // Post bisection status comment to each still-candidate PR as soon as
    // the run is known. Skip any PR already failed via merge conflict in
    // this bisect run, and report the actually-tested count.
    for (const n of prNumbers) {
      if (excluded.has(n)) continue;
      await postComment(
        api,
        n,
        commentBisecting(
          ctx,
          result.branch,
          mergedLeft.length,
          prNumbers.length - excluded.size,
          ciRunUrl,
        ),
        log,
      );
    }

    let runResult: WorkflowRunResult;
    try {
      runResult = await api.waitForWorkflowRun(runHandle.runId);
    } catch (err) {
      await handleBisectObservationFailure(
        api,
        ctx,
        q,
        gitOps,
        prMap,
        prNumbers,
        excluded,
        result.branch,
        `failed to read bisect CI status: ${formatErrorForComment(err)}`,
        log,
      );
      throw new Error(
        `getting bisect CI status: ${formatErrorForComment(err)}`,
      );
    }
    conclusion = runResult.conclusion;
  }

  if (conclusion === "success") {
    // Left half passes — merge it to main
    log("Left half passed, merging to main");
    const mergeSha = await b.completeMerge(result.branch);

    for (const n of mergedLeft) {
      log(`PR #${n} merged successfully`);
      if (!cfg.dryRun) {
        try {
          await api.removeLabel(
            n,
            queueLabel(cfg.queueLabel, STATE_ACTIVE),
          );
        } catch {
          /* best effort */
        }
        await postComment(
          api,
          n,
          commentMerged(ctx, mergeSha, ciRunUrl),
          log,
        );
      }
    }

    // Dispatch bisection for right half if needed
    if (right.length > 0) {
      const rightJSON = JSON.stringify(right);
      log(`Dispatching bisection for right half: ${JSON.stringify(right)}`);
      if (!cfg.dryRun) {
        const wf = selfWorkflowFile();
        try {
          await api.triggerWorkflow(wf, "main", {
            batch_prs: rightJSON,
            bisect: "true",
          });
        } catch (err) {
          for (const n of right) {
            if (excluded.has(n)) continue;
            try {
              await q.requeue(prMap.get(n)!);
            } catch (reqErr) {
              log(`Warning: failed to requeue PR #${n}: ${reqErr}`);
              continue;
            }
            await postComment(
              api,
              n,
              commentRequeued(
                ctx,
                `failed to dispatch bisect for right half: ${formatErrorForComment(err)}`,
              ),
              log,
            );
          }
          throw new Error(
            `dispatching bisect for right half: ${formatErrorForComment(err)}`,
          );
        }
      }
    }
  } else {
    // Left half fails — clean up bisect branch
    try {
      await gitOps.deleteBranch(result.branch);
    } catch (err) {
      log(
        `Warning: failed to delete bisect branch ${result.branch}: ${err}`,
      );
    }

    if (mergedLeft.length === 1) {
      // Single PR is the culprit
      const pr = prMap.get(mergedLeft[0])!;
      log(`PR #${mergedLeft[0]} is the culprit`);
      await q.markFailed(pr, "CI failed (identified via bisection)");
      if (!cfg.dryRun) {
        await postComment(
          api,
          pr.number,
          commentCIFailed(ctx, ciRunUrl, true),
          log,
        );
      }
      // Requeue right half (skip any already marked failed)
      for (const n of right) {
        if (excluded.has(n)) continue;
        try {
          await q.requeue(prMap.get(n)!);
        } catch (err) {
          log(`Warning: failed to requeue PR #${n}: ${err}`);
        }
      }
    } else {
      // Split left further
      const leftJSON = JSON.stringify(mergedLeft);
      log(`Left half failed, splitting further: ${JSON.stringify(mergedLeft)}`);
      if (!cfg.dryRun) {
        const wf = selfWorkflowFile();
        try {
          await api.triggerWorkflow(wf, "main", {
            batch_prs: leftJSON,
            bisect: "true",
          });
        } catch (err) {
          // Requeue non-excluded PRs on dispatch failure
          for (const n of prNumbers) {
            if (excluded.has(n)) continue;
            try {
              await q.requeue(prMap.get(n)!);
            } catch (reqErr) {
              log(`Warning: failed to requeue PR #${n}: ${reqErr}`);
              continue;
            }
            await postComment(
              api,
              n,
              commentRequeued(
                ctx,
                `failed to dispatch follow-up bisect: ${formatErrorForComment(err)}`,
              ),
              log,
            );
          }
          throw new Error(
            `dispatching follow-up bisect: ${formatErrorForComment(err)}`,
          );
        }
      }
    }
  }
}

export async function runSetup(
  api: GitHubAPI,
  cfg: Config,
  log: (msg: string) => void,
): Promise<void> {
  const q = new Queue(api, cfg.queueLabel, cfg.dryRun, log);
  log("Setting up labels for merge queue");
  await q.setupLabels();
}
