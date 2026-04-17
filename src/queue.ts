/** PR represents a pull request in the merge queue. */
export interface PR {
  number: number;
  headRef: string;
  headSHA: string;
  title: string;
  createdAt: number; // unix timestamp for ordering
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
  getWorkflowRunStatus(
    workflowFile: string,
    ref: string,
    dispatchedAt: Date,
  ): Promise<string>;
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

/** Queue manages the merge queue state machine. */
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
      try {
        await this.api.comment(
          pr.number,
          "Merge queue: picked up, processing this PR",
        );
      } catch (err) {
        this.log(`Warning: failed to comment on PR #${pr.number}: ${err}`);
      }
    }
  }

  /** Transitions a PR to the failed state and posts a comment. */
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
    await this.api.comment(pr.number, `Merge queue: ${reason}`);
  }

  /** Moves a PR back to pending state. Posts a comment if a reason is given. */
  async requeue(pr: PR, reason?: string): Promise<void> {
    this.log(`Requeuing PR #${pr.number}${reason ? `: ${reason}` : ""}`);
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
    if (reason) {
      try {
        await this.api.comment(
          pr.number,
          `Merge queue: requeued — ${reason}`,
        );
      } catch (err) {
        this.log(`Warning: failed to comment on PR #${pr.number}: ${err}`);
      }
    }
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
