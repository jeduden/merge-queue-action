/** PR represents a pull request in the merge queue. */
export interface PR {
  number: number;
  headRef: string;
  headSHA: string;
  title: string;
  state?: "open" | "closed";
  createdAt: number; // unix timestamp for ordering
  /**
   * Current label names on the PR. Optional because the issues-list
   * code path filters by label and so callers don't need them; populated
   * by `getPR` so callers can re-validate label state on a single PR.
   */
  labels?: string[];
}

export type LabelState = "" | "active" | "failed";

export const STATE_PENDING: LabelState = "";
export const STATE_ACTIVE: LabelState = "active";
export const STATE_FAILED: LabelState = "failed";

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

  constructor(
    api: GitHubAPI,
    label: string,
    dryRun: boolean,
    log?: LogFunc,
  ) {
    this.api = api;
    this.label = label;
    this.dryRun = dryRun;
    this.log = log ?? (() => {});
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
    await this.api.addLabel(
      pr.number,
      queueLabel(this.label, STATE_FAILED),
    );
  }

  /** Moves a PR back to pending state. */
  async requeue(pr: PR): Promise<void> {
    this.log(`Requeuing PR #${pr.number}`);
    if (this.dryRun) return;
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
