/** PR represents a pull request in the merge queue. */
export interface PR {
  number: number;
  headRef: string;
  headSHA: string;
  title: string;
  state?: "open" | "closed";
  createdAt: number; // unix timestamp for ordering
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

export const STATE_PENDING: LabelState = "";
export const STATE_ACTIVE: LabelState = "active";
export const STATE_FAILED: LabelState = "failed";

/**
 * Default cap on how many times a single PR may be requeued before the queue
 * gives up and marks it failed. This is the backstop that GUARANTEES a
 * deterministic failure can never re-trigger the workflow forever: error
 * classification (ConfigurationError, HTTP 404/422, …) can never be complete
 * over an open-ended failure space, so a root-cause-agnostic attempt cap
 * bounds every requeue path — including ones whose permanent failure slips
 * past classification.
 */
export const MAX_REQUEUE_ATTEMPTS = 10;

const ATTEMPT_INFIX = ":attempt-";

/** The attempt-counter label for a given count, e.g. `queue:attempt-3`. */
export function attemptLabel(base: string, n: number): string {
  return `${base}${ATTEMPT_INFIX}${n}`;
}

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
export function readAttemptCount(
  base: string,
  labels: string[] | undefined,
): { count: number; labels: string[] } {
  const prefix = `${base}${ATTEMPT_INFIX}`;
  let count = 0;
  const found: string[] = [];
  for (const l of labels ?? []) {
    if (!l.startsWith(prefix)) continue;
    const suffix = l.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    found.push(l);
    const n = Number(suffix);
    if (n > count) count = n;
  }
  return { count, labels: found };
}

/** Returns the full label string for a given state. */
export function queueLabel(base: string, state: LabelState): string {
  if (state === "") return base;
  return `${base}:${state}`;
}

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
  triggerWorkflow(
    workflowFile: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void>;
  /** Waits for the dispatched workflow run to appear and returns its URL. */
  findWorkflowRun(
    workflowFile: string,
    ref: string,
    dispatchedAt: Date,
    headSha?: string,
  ): Promise<WorkflowRunHandle>;
  /** Polls an already-located run until it completes. */
  waitForWorkflowRun(runId: number): Promise<WorkflowRunResult>;
  closePR(prNumber: number): Promise<void>;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.status !== 422) return false;
  const resp = e.response as Record<string, unknown> | undefined;
  const data = resp?.data as Record<string, unknown> | undefined;
  const errors = data?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (error: Record<string, unknown>) => error.code === "already_exists",
  );
}

type LogFunc = (msg: string) => void;

/** Queue manages the merge queue label state machine. Comment composition lives at the orchestration layer. */
export class Queue {
  private api: GitHubAPI;
  private label: string;
  private dryRun: boolean;
  private log: LogFunc;
  private maxAttempts: number;

  constructor(
    api: GitHubAPI,
    label: string,
    dryRun: boolean,
    log?: LogFunc,
    maxAttempts: number = MAX_REQUEUE_ATTEMPTS,
  ) {
    this.api = api;
    this.label = label;
    this.dryRun = dryRun;
    this.log = log ?? (() => {});
    // Guard against a misconfigured 0/negative/NaN cap silently disabling
    // the backstop; fall back to the default so the loop stays bounded,
    // and say so — the operator asked for something else.
    const valid = Number.isInteger(maxAttempts) && maxAttempts > 0;
    this.maxAttempts = valid ? maxAttempts : MAX_REQUEUE_ATTEMPTS;
    if (!valid) {
      this.log(
        `Invalid max requeue attempts (${maxAttempts}); must be a positive integer — using default ${MAX_REQUEUE_ATTEMPTS}`,
      );
    }
  }

  /** The effective requeue cap (after validation), for comment text. */
  get attemptCap(): number {
    return this.maxAttempts;
  }

  /**
   * Removes the given attempt labels from the PR. Takes the parsed list
   * (from a single `readAttemptCount` pass) rather than re-deriving it, so
   * the labels removed remotely and any in-memory bookkeeping the caller
   * does are guaranteed to come from the same parse.
   */
  private async clearAttemptLabels(
    prNumber: number,
    labels: string[],
  ): Promise<void> {
    for (const l of labels) {
      try {
        await this.api.removeLabel(prNumber, l);
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
  }

  /**
   * Resets a PR's requeue-attempt counter. Called when the PR makes real
   * progress — it merged, or its head changed (the author pushed) — so the
   * budget never penalises progress-driven retries. Also strips the attempt
   * labels from the in-memory `pr.labels` snapshot, so a `requeue` later in
   * the same run starts counting from zero instead of the stale snapshot.
   */
  async resetAttempts(pr: PR): Promise<void> {
    const { labels } = readAttemptCount(this.label, pr.labels);
    if (labels.length === 0) return;
    this.log(`Resetting requeue-attempt counter for PR #${pr.number}`);
    if (this.dryRun) return;
    await this.clearAttemptLabels(pr.number, labels);
    if (pr.labels) {
      pr.labels = pr.labels.filter((l) => !labels.includes(l));
    }
  }

  /** Returns open PRs with the queue label, sorted oldest first. */
  async collect(limit: number): Promise<PR[]> {
    const prs = await this.api.listPRsWithLabel(this.label, limit);
    prs.sort((a, b) => a.createdAt - b.createdAt);
    return prs;
  }

  /** Transitions PRs from pending to active state. */
  async activate(prs: PR[]): Promise<void> {
    for (const pr of prs) {
      this.log(`Activating PR #${pr.number}`);
      if (this.dryRun) continue;
      await this.api.addLabel(
        pr.number,
        queueLabel(this.label, STATE_ACTIVE),
      );
      try {
        await this.api.removeLabel(
          pr.number,
          queueLabel(this.label, STATE_PENDING),
        );
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
      // Clear any lingering queue:failed label — a PR re-entering the queue
      // after a failure has the base label re-added by the author, but
      // activate() must clean up the old failed state so it doesn't persist
      // after a subsequent successful merge.
      try {
        await this.api.removeLabel(
          pr.number,
          queueLabel(this.label, STATE_FAILED),
        );
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
  }

  /** Transitions a PR to the failed state. */
  async markFailed(pr: PR, reason: string): Promise<void> {
    this.log(`Marking PR #${pr.number} as failed: ${reason}`);
    if (this.dryRun) return;
    // Terminal label FIRST: if any later cleanup call fails, the PR is
    // already visibly failed (and stale attempt labels merely over-count,
    // which is safe) — instead of being stripped of every queue label with
    // its budget erased, invisible to both the trigger and `collect`.
    await this.api.addLabel(
      pr.number,
      queueLabel(this.label, STATE_FAILED),
    );
    try {
      await this.api.removeLabel(
        pr.number,
        queueLabel(this.label, STATE_ACTIVE),
      );
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    try {
      await this.api.removeLabel(
        pr.number,
        queueLabel(this.label, STATE_PENDING),
      );
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    // Reset the requeue-attempt counter: a PR leaving the queue (failed or,
    // later, re-added by the author) must start from a fresh budget.
    const { labels } = readAttemptCount(this.label, pr.labels);
    await this.clearAttemptLabels(pr.number, labels);
  }

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
  async requeue(pr: PR): Promise<boolean> {
    const { count, labels: staleAttempts } = readAttemptCount(
      this.label,
      pr.labels,
    );
    const next = count + 1;
    if (next > this.maxAttempts) {
      this.log(
        `PR #${pr.number} reached the requeue cap (${this.maxAttempts}); marking failed instead of requeueing`,
      );
      await this.markFailed(
        pr,
        `exceeded ${this.maxAttempts} requeue attempts`,
      );
      return false;
    }
    this.log(
      `Requeuing PR #${pr.number} (attempt ${next}/${this.maxAttempts})`,
    );
    if (this.dryRun) return true;
    // Stamp the NEW attempt label before any other label change. The order
    // is load-bearing: `readAttemptCount` takes the max over attempt labels,
    // so add-then-clear is monotone — an API failure mid-sequence can only
    // leave the count over-stated (self-correcting), never erased. The
    // reverse order (clear-then-add) would let a single failed call reset
    // the budget and re-arm the unbounded-retry loop the cap exists to stop.
    // The just-added label is not in the `pr.labels` snapshot, so the clear
    // below removes only the stale lower-numbered ones.
    await this.api.addLabel(pr.number, attemptLabel(this.label, next));
    await this.clearAttemptLabels(pr.number, staleAttempts);
    try {
      await this.api.removeLabel(
        pr.number,
        queueLabel(this.label, STATE_ACTIVE),
      );
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    try {
      await this.api.removeLabel(
        pr.number,
        queueLabel(this.label, STATE_FAILED),
      );
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    await this.api.addLabel(
      pr.number,
      queueLabel(this.label, STATE_PENDING),
    );
    return true;
  }

  /** Creates the queue labels in the repository. */
  async setupLabels(): Promise<void> {
    const labels = [
      {
        name: queueLabel(this.label, STATE_PENDING),
        color: "0e8a16",
        desc: "PR is queued for merging",
      },
      {
        name: queueLabel(this.label, STATE_ACTIVE),
        color: "1d76db",
        desc: "PR is being processed by merge queue",
      },
      {
        name: queueLabel(this.label, STATE_FAILED),
        color: "d93f0b",
        desc: "PR failed in merge queue",
      },
    ];

    for (const l of labels) {
      this.log(`Creating label "${l.name}"`);
      if (this.dryRun) continue;
      try {
        await this.api.createLabel(l.name, l.color, l.desc);
      } catch (err) {
        if (!isAlreadyExistsError(err)) throw err;
        this.log(`Label "${l.name}" already exists, skipping`);
      }
    }
  }
}
