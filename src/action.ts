import {
  Queue,
  queueLabel,
  STATE_ACTIVE,
  MAX_REQUEUE_ATTEMPTS,
  type PR,
  type GitHubAPI,
  type WorkflowAPI,
  type WorkflowRunHandle,
  type WorkflowRunResult,
} from "./queue.js";
import { Batch, type BatchPR, type MergeResult, type GitOperator } from "./batch.js";
import { split } from "./bisect.js";
import {
  errorMessage,
  loggingReporter,
  type Reporter,
} from "./reporter.js";
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
  commentConfigError,
  commentGaveUp,
} from "./comments.js";
import { ConfigurationError, isRateLimitedError } from "./errors.js";

export interface Config {
  ciWorkflow: string;
  batchSize: number;
  queueLabel: string;
  dryRun: boolean;
  batchPrs: string;
  /**
   * Max times a single PR may be requeued before the queue gives up and
   * marks it failed. Bounds every retry path so a deterministic failure
   * cannot re-trigger the workflow forever. Defaults to
   * `MAX_REQUEUE_ATTEMPTS` when unset.
   */
  maxRequeues?: number;
  /** Required by runProcess/runBisect; unused by runSetup. */
  commentCtx?: CommentCtx;
  /**
   * PR number from a `pull_request:labeled` event whose label matches
   * `queueLabel`. When set, runProcess fetches that PR directly if the
   * issues-list endpoint didn't return it — defends against the brief
   * window where the label has been added on the PR but isn't yet
   * reflected in the labels filter, and against subtle label-name
   * encoding mismatches.
   */
  triggerLabeledPR?: number;
}

function requireCtx(cfg: Config): CommentCtx {
  if (!cfg.commentCtx) {
    throw new Error(
      "Config.commentCtx is required for runProcess/runBisect",
    );
  }
  return cfg.commentCtx;
}

/**
 * Parses the batch_prs input string into an array of PR numbers.
 * Accepts:
 *   - A JSON array of positive integers: "[187]" or "[181,187]"
 *   - A single positive integer string: "187" (operator convenience)
 * Returns an empty array for an empty/whitespace-only string.
 * Throws a descriptive error for any other input.
 */
export function parseBatchPrs(input: string): number[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // Convenience form: single integer string "187"
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) return [n];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`invalid batch_prs JSON: ${input}`);
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (n) => typeof n === "number" && Number.isInteger(n) && n > 0,
    )
  ) {
    throw new Error(
      `batch_prs must be a JSON array of positive integers: ${input}`,
    );
  }

  return [...new Set(parsed as number[])];
}

/**
 * Parses the max_requeues input: "" → the default; canonical digits → the
 * number; anything else → NaN. Strict on purpose — parseInt would silently
 * accept numeric-prefix garbage ("1O" → 1) and change the cap, while NaN
 * makes the Queue constructor warn loudly and use the default, matching
 * the documented invalid-input behavior.
 */
export function parseMaxRequeues(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return MAX_REQUEUE_ATTEMPTS;
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : Number.NaN;
}

/** Default for the batch_size input (mirrored in action.yml / README). */
export const DEFAULT_BATCH_SIZE = 5;

/**
 * Parses the batch_size input with the same strictness as
 * `parseMaxRequeues`: "" → the default; canonical digits → the number
 * ("0" means no batch limit, the pre-existing semantics); anything else →
 * the default with the invalid value reported via `warn`. The lenient
 * parseInt this replaces turned "five" into NaN — which disabled both the
 * listing limit and the batch trim, silently batching the entire backlog.
 */
export function parseBatchSize(
  raw: string,
  warn: (msg: string) => void = () => {},
): number {
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_BATCH_SIZE;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  warn(
    `Invalid batch_size ("${raw}"); must be a non-negative integer — using default ${DEFAULT_BATCH_SIZE}`,
  );
  return DEFAULT_BATCH_SIZE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true for GitHub API errors that indicate a PERMANENT problem an
 * operator must fix — never resolved by a retry, so the PR must be marked
 * failed rather than requeued:
 *   - 404: the resource (e.g. a workflow file) doesn't exist
 *   - 422: the request is structurally invalid (e.g. no `workflow_dispatch`)
 *   - 403: the token lacks a required permission (e.g. `actions: write`)
 *
 * Deliberately transient:
 *   - a rate-limited 403 (see `isRateLimitedError`);
 *   - 401 — an expired GitHub App installation token 401s after a long CI
 *     wait, and the next run mints a fresh token; the requeue cap bounds
 *     the genuinely-dead-credential case.
 */
export function isHttpConfigError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("status" in err))
    return false;
  const status = (err as { status: number }).status;
  if (status === 404 || status === 422) return true;
  if (status === 403) return !isRateLimitedError(err);
  return false;
}

/**
 * Wraps an error thrown by the merge queue's SELF-dispatch (the
 * `workflow_dispatch` that starts a bisection run), so callers can
 * distinguish a rejected dispatch from other failures raised inside the
 * same handling path and attribute the config-error diagnosis precisely.
 */
class SelfDispatchError extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super(`dispatching bisection: ${errorMessage(inner)}`);
    this.name = "SelfDispatchError";
    this.inner = inner;
  }
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
 * If the workflow was triggered by a `pull_request: labeled` event whose
 * label matches `queueLabel`, return that PR's number. Otherwise undefined.
 *
 * The webhook payload is the authoritative signal for the just-added
 * label and is delivered before the issues-list endpoint is guaranteed to
 * reflect it. Surfacing the PR number here lets `runProcess` fetch the PR
 * directly when the label-filtered list omits it (indexing lag, label-name
 * encoding mismatch, replication moment).
 *
 * Pure-functional shape so the caller (main.ts) injects `github.context`
 * and unit tests can hand in a synthetic context.
 */
export function eventTriggerLabeledPR(
  ctx: { eventName: string; payload: unknown },
  queueLabel: string,
): number | undefined {
  if (ctx.eventName !== "pull_request") return undefined;
  const payload = ctx.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as {
    action?: unknown;
    label?: { name?: unknown } | null;
    pull_request?: { number?: unknown } | null;
  };
  if (p.action !== "labeled") return undefined;
  if (p.label?.name !== queueLabel) return undefined;
  const num = p.pull_request?.number;
  if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
    return undefined;
  }
  return num;
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

/**
 * Resolves PR numbers to their PR objects, dropping excluded numbers and
 * any number without a prMap entry. The shared front half of every bisect
 * rescue/fail path — keeping it in one place stops the filter conventions
 * from drifting between call sites.
 */
function resolvePRs(
  nums: number[],
  prMap: Map<number, PR>,
  excluded: Set<number>,
): PR[] {
  return nums
    .filter((n) => !excluded.has(n))
    .map((n) => prMap.get(n))
    .filter((pr): pr is PR => pr !== undefined);
}

/**
 * Marks every given PR failed and posts an actionable config-error comment
 * carrying `detail`. Shared by the permanent-failure handlers (batch
 * creation, CI dispatch, fast-forward) so a misconfiguration stops the queue
 * with one consistent treatment instead of requeueing. Callers pass an
 * already-filtered PR list (see `candidates`).
 */
async function failAllWithConfigError(
  api: GitHubAPI,
  q: Queue,
  ctx: CommentCtx,
  prs: PR[],
  detail: string,
  log: (msg: string) => void,
): Promise<void> {
  for (const pr of prs) {
    try {
      await q.markFailed(pr, "action misconfigured");
    } catch (markErr) {
      log(`Warning: failed to mark PR #${pr.number} as failed: ${markErr}`);
    }
    await postComment(api, pr.number, commentConfigError(ctx, detail), log);
  }
}

/**
 * Requeues each PR through the attempt-cap chokepoint, logging (never
 * propagating) per-PR failures so one label-API error cannot abort the
 * rescue of the remaining PRs. Every multi-PR requeue path routes through
 * here; the only per-site variation is the PR list and the reason.
 */
async function requeueMany(
  api: GitHubAPI,
  q: Queue,
  ctx: CommentCtx,
  prs: PR[],
  reason: string | undefined,
  log: (msg: string) => void,
): Promise<void> {
  for (const pr of prs) {
    try {
      await requeueOrGiveUp(api, q, ctx, pr, reason, log);
    } catch (err) {
      log(`Warning: failed to requeue PR #${pr.number}: ${err}`);
    }
  }
}

/**
 * Operator-facing detail for a rejected merge-queue SELF-dispatch (the
 * `workflow_dispatch` that starts a bisection run). Includes the HTTP
 * status so 404/422 (workflow or inputs missing on `main`) is
 * distinguishable from 403 (token permission). Callers gate on
 * `isHttpConfigError(err)`, which guarantees `status` is present.
 */
function selfDispatchConfigDetail(err: unknown, what: string): string {
  const status = (err as { status: number }).status;
  return (
    `the merge queue could not dispatch ${what} (${status}): ${formatErrorForComment(err)}.` +
    ` Check that the merge-queue workflow on \`main\` has a \`workflow_dispatch\` trigger with \`batch_prs\`/\`bisect\` inputs and the token has \`actions: write\`.`
  );
}

/** Operator-facing detail for a permanently rejected CI-workflow dispatch. */
function ciTriggerConfigDetail(ciWorkflow: string, err: unknown): string {
  return (
    `CI workflow \`${ciWorkflow}\` could not be triggered` +
    ` (${(err as { status: number }).status}): ${formatErrorForComment(err)}.` +
    ` Check that the \`ci_workflow\` input names a workflow with a \`workflow_dispatch\` trigger, and that the merge-queue token has \`actions: write\` permission.`
  );
}

/**
 * Requeues a PR, or — when it has hit the attempt cap — leaves it in the
 * terminal failed state (set inside `Queue.requeue`) and posts a "gave up"
 * comment. This is the single chokepoint that makes EVERY retry path
 * bounded: callers must route requeues through here rather than calling
 * `q.requeue` directly, so a deterministic failure that slips past error
 * classification still cannot re-trigger the workflow forever. Returns
 * whether the PR was requeued (false ⇒ it was failed at the cap).
 *
 * Only called from non-dry-run paths: `requeueAll` returns early in
 * dry-run, and the bisect requeue sites sit behind CI having actually run.
 */
async function requeueOrGiveUp(
  api: GitHubAPI,
  q: Queue,
  ctx: CommentCtx,
  pr: PR,
  reason: string | undefined,
  log: (msg: string) => void,
): Promise<boolean> {
  const requeued = await q.requeue(pr);
  if (requeued) {
    if (reason) {
      await postComment(api, pr.number, commentRequeued(ctx, reason), log);
    }
  } else {
    await postComment(
      api,
      pr.number,
      commentGaveUp(ctx, q.attemptCap, reason),
      log,
    );
  }
  return requeued;
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
  reporter: Reporter,
  prs: PR[],
  result: MergeResult,
  ciRunUrl: string,
  log: (msg: string) => void,
): Promise<void> {
  // Clean up the failed batch branch
  try {
    await gitOps.deleteBranch(result.branch);
  } catch (err) {
    const detail = errorMessage(err);
    await reporter.withScope(prs.map((p) => p.number), () =>
      reporter.warn(
        `failed to delete batch branch \`${result.branch}\` after CI failure: ${detail}`,
      ),
    );
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
    try {
      await api.triggerWorkflow(wf, "main", {
        batch_prs: prJSON,
        bisect: "true",
      });
    } catch (err) {
      // Tag the failure so the caller can attribute a permanent HTTP error
      // to the SELF-DISPATCH specifically — other throws from this function
      // (e.g. a label-API error inside markFailed) must not be blamed on a
      // bisection-dispatch misconfiguration.
      throw new SelfDispatchError(err);
    }
  }
}

export async function runProcess(
  api: FullAPI,
  gitOps: GitOperator,
  cfg: Config,
  log: (msg: string) => void,
  actor?: string,
  reporterArg?: Reporter,
): Promise<void> {
  const ctx = requireCtx(cfg);
  // Default to a log-only reporter so warnings always reach the run
  // log even when callers (typically tests) don't thread a Reporter.
  // Production callers (main.ts) pass a PRReporter that also posts
  // PR comments.
  const reporter: Reporter = reporterArg ?? loggingReporter(log);

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

  const q = new Queue(api, cfg.queueLabel, cfg.dryRun, log, cfg.maxRequeues);
  const b = new Batch(gitOps, cfg.dryRun, log, reporter);

  // 1. Collect queued PRs
  let prs: PR[];
  if (cfg.batchPrs) {
    // Manual dispatch with explicit PR numbers — fetch directly without
    // requiring the queue label. This is the recommended fallback for
    // conflicted PRs whose `pull_request: labeled` event did not fire.
    const prNumbers = parseBatchPrs(cfg.batchPrs);
    log(`Manual dispatch: processing explicit PRs ${JSON.stringify(prNumbers)}`);
    const fetched: PR[] = [];
    for (const n of prNumbers) {
      try {
        const pr = await api.getPR(n);
        if (pr.state !== "open") {
          log(`PR #${n} is ${pr.state}; skipping`);
          continue;
        }
        fetched.push(pr);
      } catch (err) {
        log(
          `Warning: PR #${n} not found or inaccessible; skipping: ${errorMessage(err)}`,
        );
      }
    }
    fetched.sort((a, b) => a.createdAt - b.createdAt);
    if (cfg.batchSize > 0 && fetched.length > cfg.batchSize) {
      log(
        `Trimming explicit PR list from ${fetched.length} to batch size ${cfg.batchSize}`,
      );
      fetched.length = cfg.batchSize;
    }
    prs = fetched;
  } else {
    prs = await q.collect(cfg.batchSize);
    if (
      cfg.triggerLabeledPR !== undefined &&
      !prs.some((p) => p.number === cfg.triggerLabeledPR)
    ) {
      log(
        `PR #${cfg.triggerLabeledPR} (event-labeled with "${cfg.queueLabel}") missing from issues-list result; fetching directly`,
      );
      try {
        const eventPR = await api.getPR(cfg.triggerLabeledPR);
        if (eventPR.state !== "open") {
          log(
            `PR #${cfg.triggerLabeledPR} is ${eventPR.state}; not adding to batch`,
          );
        } else if (!eventPR.labels?.includes(cfg.queueLabel)) {
          // Label was removed between webhook firing and our run — don't
          // requeue a PR that the author has explicitly de-queued.
          log(
            `PR #${cfg.triggerLabeledPR} no longer has "${cfg.queueLabel}" label; not adding to batch`,
          );
        } else {
          prs.push(eventPR);
          prs.sort((a, b) => a.createdAt - b.createdAt);
          if (cfg.batchSize > 0 && prs.length > cfg.batchSize) {
            prs.length = cfg.batchSize;
          }
        }
      } catch (err) {
        log(
          `Warning: failed to fetch event-labeled PR #${cfg.triggerLabeledPR}: ${errorMessage(err)}`,
        );
      }
    }
  }
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
  const activePRs = () => prs.filter((p) => !excluded.has(p.number));

  const requeueAll = async (reason?: string): Promise<void> => {
    if (cfg.dryRun) return;
    // Routes through the attempt-cap chokepoint: a PR that has already
    // been requeued the maximum number of times is marked failed there
    // instead of looping again.
    await requeueMany(api, q, ctx, activePRs(), reason, log);
  };

  const cleanupBranch = async (branch: string): Promise<void> => {
    if (!cfg.dryRun && branch) {
      try {
        await gitOps.deleteBranch(branch);
      } catch (err) {
        const detail = errorMessage(err);
        await reporter.withScope(prs.map((p) => p.number), () =>
          reporter.warn(
            `failed to delete batch branch \`${branch}\`: ${detail}`,
          ),
        );
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
    if (err instanceof ConfigurationError && !cfg.dryRun) {
      // Permanent misconfiguration — mark all PRs failed so the queue
      // stops looping, and post an actionable comment.
      await failAllWithConfigError(api, q, ctx, activePRs(), err.message, log);
    } else {
      await requeueAll(`batch creation failed: ${formatErrorForComment(err)}`);
    }
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
        const detail = errorMessage(err);
        await reporter.withScope(prs.map((p) => p.number), () =>
          reporter.warn(
            `failed to delete empty batch branch \`${result.branch}\`: ${detail}`,
          ),
        );
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
      if (isHttpConfigError(err)) {
        // Workflow file not found (404) or not dispatchable (422) — this
        // will not resolve without a config fix, so mark PRs failed instead
        // of requeueing them indefinitely.
        const detail = ciTriggerConfigDetail(cfg.ciWorkflow, err);
        await failAllWithConfigError(api, q, ctx, activePRs(), detail, log);
      } else {
        await requeueAll(`failed to trigger CI: ${formatErrorForComment(err)}`);
      }
      throw new Error(`triggering CI: ${formatErrorForComment(err)}`);
    }

    let runHandle: WorkflowRunHandle;
    try {
      runHandle = await api.findWorkflowRun(
        cfg.ciWorkflow,
        result.branch,
        dispatchedAt,
        result.headSHA,
      );
    } catch (err) {
      await cleanupBranch(result.branch);
      if (isHttpConfigError(err)) {
        // e.g. a 403 listing workflow runs: the token lost `actions: read`.
        // Retrying would dispatch a fresh CI run each cycle whose result is
        // never observed — fail fast instead of burning the requeue budget.
        const detail =
          `the dispatched CI run could not be located` +
          ` (${(err as { status: number }).status}): ${formatErrorForComment(err)}.` +
          ` Check that the merge-queue token can read Actions runs (\`actions: read\`).`;
        await failAllWithConfigError(api, q, ctx, activePRs(), detail, log);
      } else {
        await requeueAll(
          `failed to locate CI run: ${formatErrorForComment(err)}`,
        );
      }
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
      if (isHttpConfigError(err)) {
        const detail =
          `the CI run's status could not be read` +
          ` (${(err as { status: number }).status}): ${formatErrorForComment(err)}.` +
          ` Check that the merge-queue token can read Actions runs (\`actions: read\`).`;
        await failAllWithConfigError(api, q, ctx, activePRs(), detail, log);
      } else {
        await requeueAll(
          `failed to read CI status: ${formatErrorForComment(err)}`,
        );
      }
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
          reporter,
          prs,
          result,
          ciRunUrl,
          log,
        );
      } catch (err) {
        if (err instanceof SelfDispatchError && isHttpConfigError(err.inner)) {
          // The bisect self-dispatch is permanently rejected (404/422: the
          // merge-queue workflow on `main` is missing or lacks a
          // `workflow_dispatch` trigger; 403: token can't dispatch).
          // Requeueing would re-run the whole failing batch each cycle.
          // Only SelfDispatchError carries this diagnosis — a label-API
          // error from markFailed inside the same handler must not be
          // blamed on the dispatch configuration.
          const detail = selfDispatchConfigDetail(
            err.inner,
            "its own bisection run",
          );
          await failAllWithConfigError(api, q, ctx, activePRs(), detail, log);
        } else {
          await requeueAll(
            `error handling CI failure: ${formatErrorForComment(err)}`,
          );
        }
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
      // A new head means an author pushed — that's progress, not a failure,
      // so the requeue budget starts fresh for EVERY batch member: the
      // non-drifted PRs didn't fail either, and each drift cycle requires a
      // fresh external push, so the reset cannot sustain a loop by itself.
      // (resetAttempts also strips the in-memory snapshot, so the requeue
      // below stamps attempt-1 rather than resuming the count.)
      for (const pr of prs) {
        if (excluded.has(pr.number)) continue;
        try {
          await q.resetAttempts(pr);
        } catch (resetErr) {
          log(
            `Warning: failed to reset attempt counter for PR #${pr.number}: ${resetErr}`,
          );
        }
      }
      await cleanupBranch(result.branch);
      await requeueAll("PR head changed while batch CI was running");
      return;
    }
  }

  let mergeSha = "";
  try {
    mergeSha = await b.completeMerge(result.branch);
  } catch (err) {
    await cleanupBranch(result.branch);
    if (err instanceof ConfigurationError && !cfg.dryRun) {
      // Permanent: e.g. branch protection forbids the token from updating
      // `main`. Retrying re-runs CI and fails the same way, so mark failed
      // instead of requeueing.
      await failAllWithConfigError(api, q, ctx, activePRs(), err.message, log);
    } else {
      await requeueAll(
        `failed to fast-forward main: ${formatErrorForComment(err)}`,
      );
    }
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
      // The PR left the queue successfully — drop its requeue counter so
      // the merged (closed) PR doesn't wear a stale bookkeeping label.
      try {
        await q.resetAttempts(pr);
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
 * Cleans up a bisect batch branch and routes the still-candidate PRs out of
 * `queue:active` after the bisect CI run could not be observed (dispatch,
 * locate, or status failure). A permanent HTTP error (`isHttpConfigError`)
 * marks them failed with an actionable comment; anything else requeues them
 * (cap-bounded). Without this, the batch branch would leak and the PRs
 * would be stranded.
 */
async function handleBisectObservationFailure(
  api: FullAPI,
  ctx: CommentCtx,
  q: Queue,
  gitOps: GitOperator,
  reporter: Reporter,
  prMap: Map<number, PR>,
  prNumbers: number[],
  excluded: Set<number>,
  branch: string,
  cause: unknown,
  reason: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await gitOps.deleteBranch(branch);
  } catch (err) {
    const detail = errorMessage(err);
    const candidateNums = prNumbers.filter((n) => !excluded.has(n));
    await reporter.withScope(candidateNums, () =>
      reporter.warn(
        `failed to delete bisect branch \`${branch}\` during observation-failure cleanup: ${detail}`,
      ),
    );
  }
  const affected = resolvePRs(prNumbers, prMap, excluded);
  if (isHttpConfigError(cause)) {
    // The advice goes on its own line (commentConfigError blockquotes each
    // line) so it doesn't glue punctuation onto the formatted error text.
    const detail = `${reason}\nCheck the merge-queue token's Actions permissions (\`actions: read\` / \`actions: write\`).`;
    await failAllWithConfigError(api, q, ctx, affected, detail, log);
    return;
  }
  await requeueMany(api, q, ctx, affected, reason, log);
}

export async function runBisect(
  api: FullAPI,
  gitOps: GitOperator,
  cfg: Config,
  log: (msg: string) => void,
  reporterArg?: Reporter,
): Promise<void> {
  // Same default rationale as runProcess: warnings should reach the
  // run log even without an explicit reporter.
  const reporter: Reporter = reporterArg ?? loggingReporter(log);
  const ctx = requireCtx(cfg);
  const prListStr = cfg.batchPrs;
  if (!prListStr) {
    throw new Error("batch_prs input is required for bisect mode");
  }

  const prNumbers = parseBatchPrs(prListStr);
  if (prNumbers.length === 0) {
    log("No PRs to bisect");
    return;
  }

  const q = new Queue(api, cfg.queueLabel, cfg.dryRun, log, cfg.maxRequeues);
  const b = new Batch(gitOps, cfg.dryRun, log, reporter);

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
  let result: MergeResult;
  try {
    result = await b.createAndMerge(batchID, leftPRs);
  } catch (err) {
    if (err instanceof ConfigurationError && !cfg.dryRun) {
      await failAllWithConfigError(
        api,
        q,
        ctx,
        [...prMap.values()],
        err.message,
        log,
      );
    } else if (!cfg.dryRun) {
      // Transient error — requeue all candidates so they aren't stuck in
      // queue:active (bounded by the attempt cap so a deterministic failure
      // here can't loop forever).
      await requeueMany(
        api,
        q,
        ctx,
        [...prMap.values()],
        formatErrorForComment(err),
        log,
      );
    }
    throw err;
  }

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
      // Every left PR conflicted (marked failed above) — but the RIGHT half
      // is untested and still `queue:active`. Returning without requeueing
      // it would strand those PRs: no base label, so neither the trigger
      // nor collect() would ever see them again.
      await requeueMany(
        api,
        q,
        ctx,
        resolvePRs(right, prMap, excluded),
        undefined,
        log,
      );
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
      if (isHttpConfigError(err)) {
        try {
          await gitOps.deleteBranch(result.branch);
        } catch {
          /* best effort */
        }
        await failAllWithConfigError(
          api,
          q,
          ctx,
          resolvePRs(prNumbers, prMap, excluded),
          ciTriggerConfigDetail(cfg.ciWorkflow, err),
          log,
        );
      } else {
        // Transient error — requeue all still-candidate PRs so they don't get stuck
        // in queue:active with no path forward (same recovery as findWorkflowRun failures).
        await handleBisectObservationFailure(
          api,
          ctx,
          q,
          gitOps,
          reporter,
          prMap,
          prNumbers,
          excluded,
          result.branch,
          err,
          `failed to trigger bisect CI: ${formatErrorForComment(err)}`,
          log,
        );
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
          result.headSHA,
        );
      } catch (err) {
        await handleBisectObservationFailure(
          api,
          ctx,
          q,
          gitOps,
          reporter,
          prMap,
          prNumbers,
          excluded,
          result.branch,
          err,
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
        reporter,
        prMap,
        prNumbers,
        excluded,
        result.branch,
        err,
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
    let mergeSha = "";
    try {
      mergeSha = await b.completeMerge(result.branch);
    } catch (err) {
      // Without this, a failed fast-forward here propagates straight to
      // `setFailed`, stranding the candidate PRs in `queue:active`. The
      // rescue must cover BOTH halves: the tested left PRs and the
      // untested right ones — the right-half dispatch below is never
      // reached, and a PR stuck in `queue:active` has no base label, so
      // neither the trigger nor `collect` would ever see it again.
      if (!cfg.dryRun) {
        // completeMerge deletes the branch only after a successful
        // fast-forward; clean up the leaked ref (mirrors runProcess).
        try {
          await gitOps.deleteBranch(result.branch);
        } catch (delErr) {
          const candidates = prNumbers.filter((n) => !excluded.has(n));
          await reporter.withScope(candidates, () =>
            reporter.warn(
              `failed to delete bisect branch \`${result.branch}\` after a fast-forward failure: ${errorMessage(delErr)}`,
            ),
          );
        }
        const affected = resolvePRs(
          [...mergedLeft, ...right],
          prMap,
          excluded,
        );
        if (err instanceof ConfigurationError) {
          await failAllWithConfigError(api, q, ctx, affected, err.message, log);
        } else {
          await requeueMany(
            api,
            q,
            ctx,
            affected,
            `failed to fast-forward main after bisect: ${formatErrorForComment(err)}`,
            log,
          );
        }
      }
      throw err;
    }

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
        // The PR left the queue successfully — drop its requeue counter so
        // the merged (closed) PR doesn't wear a stale bookkeeping label.
        const mergedPR = prMap.get(n);
        if (mergedPR) {
          try {
            await q.resetAttempts(mergedPR);
          } catch {
            /* best effort */
          }
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
          const rightPRs = resolvePRs(right, prMap, excluded);
          if (isHttpConfigError(err)) {
            // The self-dispatch is permanently rejected — retrying the
            // right half would re-fail identically every cycle.
            const detail = selfDispatchConfigDetail(
              err,
              "its own bisection run for the remaining PRs",
            );
            await failAllWithConfigError(api, q, ctx, rightPRs, detail, log);
          } else {
            await requeueMany(
              api,
              q,
              ctx,
              rightPRs,
              `failed to dispatch bisect for right half: ${formatErrorForComment(err)}`,
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
      const detail = errorMessage(err);
      const candidates = prNumbers.filter((n) => !excluded.has(n));
      await reporter.withScope(candidates, () =>
        reporter.warn(
          `failed to delete bisect branch \`${result.branch}\` after left-half CI failure: ${detail}`,
        ),
      );
    }

    if (mergedLeft.length === 1) {
      // Single PR is the culprit
      const pr = prMap.get(mergedLeft[0])!;
      log(`PR #${mergedLeft[0]} is the culprit`);
      // Guarded so a label-API failure here cannot abort the function
      // before the right-half requeue below — that would strand every
      // untested PR in `queue:active`.
      try {
        await q.markFailed(pr, "CI failed (identified via bisection)");
        if (!cfg.dryRun) {
          await postComment(
            api,
            pr.number,
            commentCIFailed(ctx, ciRunUrl, true),
            log,
          );
        }
      } catch (markErr) {
        log(
          `Warning: failed to mark culprit PR #${pr.number} as failed: ${markErr}`,
        );
      }
      // Requeue right half (not yet tested)
      await requeueMany(
        api,
        q,
        ctx,
        resolvePRs(right, prMap, excluded),
        undefined,
        log,
      );
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
          const remaining = resolvePRs(prNumbers, prMap, excluded);
          if (isHttpConfigError(err)) {
            // Permanently rejected self-dispatch: requeueing would re-run
            // the identical failing batch each cycle.
            const detail = selfDispatchConfigDetail(
              err,
              "its own follow-up bisection run",
            );
            await failAllWithConfigError(api, q, ctx, remaining, detail, log);
          } else {
            // Requeue non-excluded PRs on dispatch failure
            await requeueMany(
              api,
              q,
              ctx,
              remaining,
              `failed to dispatch follow-up bisect: ${formatErrorForComment(err)}`,
              log,
            );
          }
          throw new Error(
            `dispatching follow-up bisect: ${formatErrorForComment(err)}`,
          );
        }
      }
      // Requeue right half since it hasn't been tested yet
      await requeueMany(
        api,
        q,
        ctx,
        resolvePRs(right, prMap, excluded),
        undefined,
        log,
      );
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
