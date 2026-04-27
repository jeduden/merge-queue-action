import { describe, expect, it, afterEach } from "vitest";
import {
  eventTriggerLabeledPR,
  hasWritePermission,
  selfWorkflowFile,
  parseBatchPrs,
  runProcess,
  runBisect,
  runSetup,
  type FullAPI,
  type Config,
} from "./action.js";
import { ConfigurationError } from "./errors.js";
import type {
  PR,
  WorkflowRunHandle,
  WorkflowRunResult,
} from "./queue.js";
import type { GitOperator } from "./batch.js";

const CTX = {
  serverUrl: "https://github.com",
  ownerRepo: "owner/repo",
  actionRunUrl: "https://github.com/owner/repo/actions/runs/999",
  queueLabel: "queue",
};
const CI_RUN_URL =
  "https://github.com/owner/repo/actions/runs/1234567";
/** Unique path fragment of CI_RUN_URL — used in assertions so they don't
 *  look like URL allowlist checks to static analysis. */
const CI_RUN_PATH_FRAGMENT = "/actions/runs/1234567";
const MERGE_SHA = "abcdef1234567890";

// --- mocks ---

function makePR(
  n: number,
  headRef = `branch-${n}`,
  state: "open" | "closed" = "open",
): PR {
  return {
    number: n,
    headRef,
    headSHA: `sha-${n}`,
    title: `PR #${n}`,
    state,
    createdAt: n * 100,
  };
}

function newMockAPI(): FullAPI & {
  prs: Map<string, PR[]>;
  labels: Map<number, string[]>;
  comments: Map<number, string[]>;
  workflows: { file: string; ref: string; inputs?: Record<string, string> }[];
  ciConclusion: string;
  actorPerms: Map<string, string>;
  createdLabels: { name: string; color: string; desc: string }[];
  closedPRs: number[];
} {
  const mock = {
    prs: new Map<string, PR[]>(),
    labels: new Map<number, string[]>(),
    comments: new Map<number, string[]>(),
    workflows: [] as {
      file: string;
      ref: string;
      inputs?: Record<string, string>;
    }[],
    ciConclusion: "success",
    actorPerms: new Map<string, string>(),
    createdLabels: [] as { name: string; color: string; desc: string }[],
    closedPRs: [] as number[],

    async listPRsWithLabel(label: string, _limit: number): Promise<PR[]> {
      return mock.prs.get(label) ?? [];
    },
    async addLabel(prNumber: number, label: string): Promise<void> {
      const labels = mock.labels.get(prNumber) ?? [];
      labels.push(label);
      mock.labels.set(prNumber, labels);
    },
    async removeLabel(prNumber: number, label: string): Promise<void> {
      const labels = mock.labels.get(prNumber) ?? [];
      const idx = labels.indexOf(label);
      if (idx >= 0) labels.splice(idx, 1);
      mock.labels.set(prNumber, labels);
    },
    async comment(prNumber: number, body: string): Promise<void> {
      const comments = mock.comments.get(prNumber) ?? [];
      comments.push(body);
      mock.comments.set(prNumber, comments);
    },
    async createLabel(
      name: string,
      color: string,
      desc: string,
    ): Promise<void> {
      mock.createdLabels.push({ name, color, desc });
    },
    async triggerWorkflow(
      file: string,
      ref: string,
      inputs?: Record<string, string>,
    ): Promise<void> {
      mock.workflows.push({ file, ref, inputs });
    },
    async findWorkflowRun(): Promise<WorkflowRunHandle> {
      return { runId: 1234567, htmlUrl: CI_RUN_URL };
    },
    async waitForWorkflowRun(): Promise<WorkflowRunResult> {
      return { conclusion: mock.ciConclusion, htmlUrl: CI_RUN_URL };
    },
    async closePR(prNumber: number): Promise<void> {
      mock.closedPRs.push(prNumber);
    },
    async getPR(prNumber: number): Promise<PR> {
      // Search across all label sets for the PR
      for (const prs of mock.prs.values()) {
        const pr = prs.find((p) => p.number === prNumber);
        if (pr) return pr;
      }
      throw new Error(`PR #${prNumber} not found`);
    },
    async getActorPermission(username: string): Promise<string> {
      return mock.actorPerms.get(username) ?? "none";
    },
  };
  return mock;
}

function newMockGit(): GitOperator & {
  branches: string[];
  merges: string[];
  pushed: string[];
  ffRef: string;
  deleted: string[];
  conflictOn: string;
  failOn: string;
} {
  const mock = {
    branches: [] as string[],
    merges: [] as string[],
    pushed: [] as string[],
    ffRef: "",
    deleted: [] as string[],
    conflictOn: "",
    failOn: "",

    async createBranchFromRef(branch: string) {
      if (mock.failOn === "createBranchFromRef")
        throw new Error("mock error");
      mock.branches.push(branch);
    },
    async mergeBranch(_branch: string, sourceRef: string) {
      if (mock.failOn === "mergeBranch") throw new Error("mock error");
      if (sourceRef === mock.conflictOn) return false;
      mock.merges.push(sourceRef);
      return true;
    },
    async pushBranch(branch: string) {
      if (mock.failOn === "pushBranch") throw new Error("mock error");
      mock.pushed.push(branch);
    },
    async fastForwardMain(ref: string) {
      if (mock.failOn === "fastForwardMain") throw new Error("mock error");
      mock.ffRef = ref;
      return MERGE_SHA;
    },
    async deleteBranch(branch: string) {
      if (mock.failOn === "deleteBranch") throw new Error("mock error");
      mock.deleted.push(branch);
    },
  };
  return mock;
}

const nop = () => {};

function baseCfg(overrides?: Partial<Config>): Config {
  return {
    ciWorkflow: ".github/workflows/ci.yml",
    batchSize: 5,
    queueLabel: "queue",
    dryRun: true,
    batchPrs: "",
    commentCtx: CTX,
    ...overrides,
  };
}

// --- tests ---

describe("hasWritePermission", () => {
  it.each([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
    ["", false],
  ])("%s -> %s", (perm, want) => {
    expect(hasWritePermission(perm)).toBe(want);
  });
});

describe("eventTriggerLabeledPR", () => {
  it("returns the PR number when label matches", () => {
    const ctx = {
      eventName: "pull_request",
      payload: {
        action: "labeled",
        label: { name: "queue" },
        pull_request: { number: 173 },
      },
    };
    expect(eventTriggerLabeledPR(ctx, "queue")).toBe(173);
  });

  it("returns undefined for non-pull_request events", () => {
    const ctx = {
      eventName: "push",
      payload: { action: "labeled", label: { name: "queue" } },
    };
    expect(eventTriggerLabeledPR(ctx, "queue")).toBeUndefined();
  });

  it("returns undefined when the action is not 'labeled'", () => {
    const ctx = {
      eventName: "pull_request",
      payload: {
        action: "opened",
        label: { name: "queue" },
        pull_request: { number: 1 },
      },
    };
    expect(eventTriggerLabeledPR(ctx, "queue")).toBeUndefined();
  });

  it("returns undefined when the label does not match", () => {
    const ctx = {
      eventName: "pull_request",
      payload: {
        action: "labeled",
        label: { name: "wip" },
        pull_request: { number: 1 },
      },
    };
    expect(eventTriggerLabeledPR(ctx, "queue")).toBeUndefined();
  });

  it("matches case-sensitively (queue vs Queue)", () => {
    const ctx = {
      eventName: "pull_request",
      payload: {
        action: "labeled",
        label: { name: "Queue" },
        pull_request: { number: 1 },
      },
    };
    expect(eventTriggerLabeledPR(ctx, "queue")).toBeUndefined();
  });

  it("returns undefined when payload is missing fields", () => {
    expect(
      eventTriggerLabeledPR({ eventName: "pull_request", payload: {} }, "queue"),
    ).toBeUndefined();
    expect(
      eventTriggerLabeledPR(
        { eventName: "pull_request", payload: { action: "labeled" } },
        "queue",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for non-object payloads (null / string / number)", () => {
    expect(
      eventTriggerLabeledPR(
        { eventName: "pull_request", payload: null },
        "queue",
      ),
    ).toBeUndefined();
    expect(
      eventTriggerLabeledPR(
        { eventName: "pull_request", payload: "labeled" },
        "queue",
      ),
    ).toBeUndefined();
    expect(
      eventTriggerLabeledPR(
        { eventName: "pull_request", payload: 42 },
        "queue",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when pull_request.number is not a positive integer", () => {
    const mk = (number: unknown) =>
      eventTriggerLabeledPR(
        {
          eventName: "pull_request",
          payload: {
            action: "labeled",
            label: { name: "queue" },
            pull_request: { number },
          },
        },
        "queue",
      );
    expect(mk("173")).toBeUndefined();
    expect(mk(0)).toBeUndefined();
    expect(mk(-1)).toBeUndefined();
    expect(mk(1.5)).toBeUndefined();
    expect(mk(Number.NaN)).toBeUndefined();
    expect(mk(null)).toBeUndefined();
  });
});

describe("selfWorkflowFile", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("reads MERGE_QUEUE_WORKFLOW_FILE override", () => {
    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    expect(selfWorkflowFile()).toBe(".github/workflows/mq.yml");
  });

  it("parses GITHUB_WORKFLOW_REF", () => {
    delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/merge-queue.yml@refs/heads/main";
    expect(selfWorkflowFile()).toBe(".github/workflows/merge-queue.yml");
  });

  it("throws when GITHUB_WORKFLOW_REF is not set", () => {
    delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    delete process.env.GITHUB_WORKFLOW_REF;
    expect(() => selfWorkflowFile()).toThrow("GITHUB_WORKFLOW_REF is not set");
  });

  it("throws on invalid GITHUB_WORKFLOW_REF", () => {
    delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    process.env.GITHUB_WORKFLOW_REF = "bad";
    expect(() => selfWorkflowFile()).toThrow("invalid GITHUB_WORKFLOW_REF");
  });
});

describe("runProcess", () => {
  it("skips when actor lacks write permission", async () => {
    const api = newMockAPI();
    api.actorPerms.set("bot", "read");
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(api, git, baseCfg(), (m) => logs.push(m), "bot");
    expect(logs.some((l) => l.includes("skipping"))).toBe(true);
    expect(git.branches).toHaveLength(0);
  });

  it("returns when queue is empty", async () => {
    const api = newMockAPI();
    api.actorPerms.set("user", "write");
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(api, git, baseCfg(), (m) => logs.push(m), "user");
    expect(logs).toContain("No PRs in queue");
  });

  it("falls back to event-labeled PR when issues-list misses it", async () => {
    const api = newMockAPI();
    // Issues-list returns nothing (e.g. label-name discrepancy or
    // brief indexing lag after the labeled webhook fires).
    api.prs.set("queue", []);
    const eventPR = { ...makePR(173), labels: ["queue"] };
    // getPR can find it directly even though listPRsWithLabel can't.
    api.getPR = async (n: number) => {
      if (n !== 173) throw new Error("not found");
      return eventPR;
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 173 }),
      (m) => logs.push(m),
    );
    expect(logs.some((l) => l.includes("PR #173 (event-labeled"))).toBe(true);
    expect(logs.some((l) => l.includes("Processing 1 PRs"))).toBe(true);
  });

  it("does not double-include the event-labeled PR when issues-list already has it", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(173)]);
    let getPRCalls = 0;
    api.getPR = async (n: number) => {
      getPRCalls++;
      return { ...makePR(n), labels: ["queue"] };
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 173 }),
      (m) => logs.push(m),
    );
    // Should not log the fallback message and should not call getPR for fallback.
    expect(logs.some((l) => l.includes("missing from issues-list"))).toBe(false);
    expect(getPRCalls).toBe(0);
    expect(logs.some((l) => l.includes("Processing 1 PRs"))).toBe(true);
  });

  it("skips event-labeled PR fallback when the PR is closed", async () => {
    const api = newMockAPI();
    api.prs.set("queue", []);
    api.getPR = async (n: number) => ({
      ...makePR(n, `branch-${n}`, "closed"),
      labels: ["queue"],
    });
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 99 }),
      (m) => logs.push(m),
    );
    expect(logs.some((l) => l.includes("PR #99 is closed"))).toBe(true);
    expect(logs).toContain("No PRs in queue");
  });

  it("skips event-labeled PR fallback when the queue label was removed before runProcess", async () => {
    const api = newMockAPI();
    api.prs.set("queue", []);
    // Label was added (firing the webhook) and then removed before this run.
    api.getPR = async (n: number) => ({ ...makePR(n), labels: ["other"] });
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 99 }),
      (m) => logs.push(m),
    );
    expect(
      logs.some((l) =>
        l.includes(`PR #99 no longer has "queue" label`),
      ),
    ).toBe(true);
    expect(logs).toContain("No PRs in queue");
  });

  it("treats a PR with empty labels (legacy mock) as not queue-labeled", async () => {
    const api = newMockAPI();
    api.prs.set("queue", []);
    // No labels field — defensive: should not be processed.
    api.getPR = async (n: number) => makePR(n);
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 99 }),
      (m) => logs.push(m),
    );
    expect(
      logs.some((l) => l.includes(`PR #99 no longer has "queue" label`)),
    ).toBe(true);
    expect(logs).toContain("No PRs in queue");
  });

  it("logs and continues when fetching event-labeled PR fails", async () => {
    const api = newMockAPI();
    api.prs.set("queue", []);
    api.getPR = async () => {
      throw new Error("boom");
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 99 }),
      (m) => logs.push(m),
    );
    expect(
      logs.some(
        (l) =>
          l.includes("Warning: failed to fetch event-labeled PR #99") &&
          l.includes("boom"),
      ),
    ).toBe(true);
    expect(logs).toContain("No PRs in queue");
  });

  it("formats non-Error rejections via errorMessage in fetch-failure log", async () => {
    const api = newMockAPI();
    api.prs.set("queue", []);
    // A plain object — `${err}` would render this as "[object Object]".
    api.getPR = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: exercising non-Error throw
      throw { message: "octokit boom" } as any;
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 99 }),
      (m) => logs.push(m),
    );
    const warn = logs.find((l) => l.includes("failed to fetch event-labeled"));
    expect(warn).toBeDefined();
    expect(warn).not.toContain("[object Object]");
    expect(warn).toContain("octokit boom");
  });

  it("respects batch size when adding event-labeled PR", async () => {
    const api = newMockAPI();
    // Five PRs already in queue, batch size 5, plus a 6th from the event payload.
    api.prs.set(
      "queue",
      [10, 20, 30, 40, 50].map((n) => makePR(n)),
    );
    api.getPR = async (n: number) => ({ ...makePR(n), labels: ["queue"] });
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ triggerLabeledPR: 5, batchSize: 5 }),
      (m) => logs.push(m),
    );
    // Event PR #5 sorts earliest (createdAt = 500); the latest (#50) drops out.
    expect(logs.some((l) => l.includes("Processing 5 PRs"))).toBe(true);
  });

  it("processes PRs in dry-run mode", async () => {
    const api = newMockAPI();
    api.actorPerms.set("user", "admin");
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(api, git, baseCfg(), (m) => logs.push(m), "user");
    expect(logs.some((l) => l.includes("Processing 2 PRs"))).toBe(true);
    expect(logs.some((l) => l.includes("Batch merge complete"))).toBe(true);
    // dry-run: no real git operations
    expect(git.branches).toHaveLength(0);
  });

  it("processes without actor", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(api, git, baseCfg(), (m) => logs.push(m));
    expect(logs.some((l) => l.includes("Processing 1 PRs"))).toBe(true);
  });

  it("handles all PRs conflicting", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1, "branch-1")]);
    const git = newMockGit();
    git.conflictOn = "sha-1";
    const logs: string[] = [];
    const cfg = baseCfg({ dryRun: false });

    await runProcess(api, git, cfg, (m) => logs.push(m));
    expect(logs.some((l) => l.includes("No PRs merged successfully"))).toBe(
      true,
    );
    expect(api.labels.get(1)).toContain("queue:failed");
  });

  it("triggers CI and completes merge on success", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    await runProcess(api, git, cfg, nop);
    expect(api.workflows).toHaveLength(1);
    expect(git.ffRef).toContain("merge-queue/batch-");
    const c1 = api.comments.get(1) ?? [];
    expect(c1.some((s) => s.includes("Merge Queue** — picked up"))).toBe(true);
    expect(c1.some((s) => s.includes("Merge Queue** — CI running"))).toBe(
      true,
    );
    expect(c1.some((s) => s.includes(CI_RUN_PATH_FRAGMENT))).toBe(true);
    expect(c1.some((s) => s.includes("Merge Queue** — merged"))).toBe(true);
    expect(c1.some((s) => s.includes(MERGE_SHA))).toBe(true);
  });

  it("requeues stale batch when a merged PR head drifts before fast-forward", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    api.getPR = async (prNumber: number) => ({
      ...makePR(prNumber),
      headSHA: `sha-${prNumber}-new`,
      state: "open",
    });

    await runProcess(api, git, cfg, nop);

    expect(git.ffRef).toBe("");
    expect(git.deleted.length).toBeGreaterThan(0);
    expect(api.labels.get(1)).toContain("queue");
    const c = api.comments.get(1) ?? [];
    expect(
      c.some(
        (s) =>
          s.includes("Merge Queue** — requeued") &&
          s.includes("head changed while batch CI was running"),
      ),
    ).toBe(true);
  });

  it("cleans up, requeues, and throws when getPR fails during drift check", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    api.getPR = async () => {
      throw new Error("API unavailable");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "checking PR drift after CI",
    );

    expect(git.ffRef).toBe("");
    expect(git.deleted.length).toBeGreaterThan(0);
    expect(api.labels.get(1)).toContain("queue");
    const c = api.comments.get(1) ?? [];
    expect(
      c.some(
        (s) =>
          s.includes("Merge Queue** — requeued") &&
          s.includes("failed to verify PR state after CI"),
      ),
    ).toBe(true);
  });

  it("explicitly closes merged PR when it remains open after retries", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    let getPRCalls = 0;

    api.getPR = async (prNumber: number) => {
      getPRCalls++;
      return makePR(prNumber, `branch-${prNumber}`, "open");
    };

    await runProcess(api, git, cfg, nop);

    expect(getPRCalls).toBeGreaterThanOrEqual(4);
    expect(api.closedPRs).toContain(1);
    const c = api.comments.get(1) ?? [];
    expect(c.some((s) => s.includes("Merge Queue** — merged"))).toBe(true);
    expect(c.some((s) => s.includes(MERGE_SHA))).toBe(true);
  });

  it("still closes merged PR when getPR keeps failing during close-check retries", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    let driftCheckDone = false;

    api.getPR = async (prNumber: number) => {
      // First call (drift check before FF) returns matching SHA so we proceed
      if (!driftCheckDone) {
        driftCheckDone = true;
        return makePR(prNumber, `branch-${prNumber}`, "open");
      }
      // All subsequent calls (close-check retries) fail
      throw new Error("read timeout");
    };

    const logs: string[] = [];
    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(api.closedPRs).toContain(1);
    expect(logs.some((l) => l.includes("failed to read PR #1 state after merge"))).toBe(true);
    const c = api.comments.get(1) ?? [];
    expect(c.some((s) => s.includes("Merge Queue** — merged"))).toBe(true);
  });

  it("posts error comments when CI trigger fails and requeues", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.triggerWorkflow = async () => {
      throw new Error("boom");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI",
    );

    for (const n of [1, 2]) {
      const c = api.comments.get(n) ?? [];
      expect(
        c.some((s) => s.includes("Merge Queue** — requeued") && s.includes("failed to trigger CI")),
      ).toBe(true);
    }
  });

  it("falls back to 'unknown error' for Errors with an empty message", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.triggerWorkflow = async () => {
      throw new Error("");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    const comments = api.comments.get(1) ?? [];
    const errComment = comments.find((s) => s.includes("— requeued"));
    expect(errComment).toBeDefined();
    expect(errComment!).toContain("unknown error");
    // Blockquote must not be blank (the `> ` would be followed by empty)
    expect(errComment!).not.toMatch(/^> *$/m);
  });

  it("renders opaque non-Error thrown values as 'unknown error'", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    // A plain object with no `message` property: must NOT leak as
    // "[object Object]" to user-facing PR comments.
    api.triggerWorkflow = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: exercising unknown-error path
      throw { weird: true } as any;
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    const comments = api.comments.get(1) ?? [];
    const errComment = comments.find((s) =>
      s.includes("Merge Queue** — requeued"),
    );
    expect(errComment).toBeDefined();
    expect(errComment!).not.toContain("[object Object]");
    expect(errComment!).toContain("unknown error");
    // The embedded sanitized error message itself must be single-line.
    // The comment template is multi-line, so check the blockquote line only.
    const quoteLine = errComment!
      .split("\n")
      .find((l) => l.startsWith("> "));
    expect(quoteLine).toBeDefined();
    expect(quoteLine!.includes("\n")).toBe(false);
  });

  it("handles thrown strings directly", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.triggerWorkflow = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: exercising thrown-string path
      throw "bare string err" as any;
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    const comments = api.comments.get(1) ?? [];
    const errComment = comments.find((s) =>
      s.includes("Merge Queue** — requeued"),
    );
    expect(errComment).toBeDefined();
    expect(errComment!).toContain("bare string err");
  });

  it("handles thrown primitive numbers", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.triggerWorkflow = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: exercising thrown-number path
      throw 42 as any;
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    const comments = api.comments.get(1) ?? [];
    const errComment = comments.find((s) =>
      s.includes("Merge Queue** — requeued"),
    );
    expect(errComment).toBeDefined();
    expect(errComment!).toContain("42");
    expect(errComment!).not.toContain("[object");
  });

  it("uses the `message` field of plain-object errors", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.triggerWorkflow = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: exercising unknown-error path
      throw { message: "pretty error" } as any;
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    const comments = api.comments.get(1) ?? [];
    const errComment = comments.find((s) =>
      s.includes("Merge Queue** — requeued"),
    );
    expect(errComment).toBeDefined();
    expect(errComment!).toContain("pretty error");
  });

  it("truncates overly long error messages in requeue comments", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const longMsg = "x".repeat(500);
    api.triggerWorkflow = async () => {
      throw new Error(longMsg);
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    const comments = api.comments.get(1) ?? [];
    const errComment = comments.find((s) =>
      s.includes("Merge Queue** — requeued"),
    );
    expect(errComment).toBeDefined();
    expect(errComment!).toContain("…");
    // 500 x's should have been truncated well below their original length
    expect(errComment!.length).toBeLessThan(longMsg.length);
  });

  it("tolerates failures when posting the CI-running status comment", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    const origComment = api.comment;
    api.comment = async (n, body) => {
      if (body.includes("Merge Queue** — CI running")) {
        throw new Error("rate limited");
      }
      return origComment(n, body);
    };

    // Should still complete the merge flow despite the comment failure
    await runProcess(api, git, cfg, (m) => logs.push(m));
    expect(git.ffRef).toContain("merge-queue/batch-");
    expect(logs.some((l) => l.includes("failed to comment on PR #1"))).toBe(
      true,
    );
  });

  it("requeues with a reason when bisect dispatch fails on CI failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    const origTrigger = api.triggerWorkflow.bind(api);
    api.triggerWorkflow = async (file, ref, inputs) => {
      // Let the initial CI dispatch succeed; fail the bisect dispatch so
      // handleCIFailure throws and the outer error-handling path runs.
      if (inputs?.bisect === "true") throw new Error("dispatch boom");
      return origTrigger(file, ref, inputs);
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    for (const n of [1, 2]) {
      const c = api.comments.get(n) ?? [];
      expect(
        c.some(
          (s) =>
            s.includes("Merge Queue** — requeued") &&
            s.includes("error handling CI failure"),
        ),
      ).toBe(true);
    }
  });

  it("requeues all PRs when createAndMerge fails with a transient error", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    git.failOn = "createBranchFromRef";
    const cfg = baseCfg({ dryRun: false });

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();
    // Both PRs should be requeued (transient error)
    expect(api.labels.get(1)).toContain("queue");
    expect(api.labels.get(2)).toContain("queue");
  });

  it("warns when markFailed throws during createAndMerge ConfigurationError handling in runProcess", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    git.createBranchFromRef = async () => {
      throw new ConfigurationError("not in a git worktree");
    };
    const origAdd = api.addLabel.bind(api);
    api.addLabel = async (n, label) => {
      if (label === "queue:failed") throw new Error("addLabel failed");
      return origAdd(n, label);
    };

    await expect(
      runProcess(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow();
    expect(
      logs.some((l) => l.includes("Warning: failed to mark PR")),
    ).toBe(true);
  });

  it("marks PRs failed and posts config error when createAndMerge throws ConfigurationError", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    git.createBranchFromRef = async () => {
      throw new ConfigurationError(
        "merge-queue-action must run in a checked-out git working tree",
      );
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();

    // PRs must be marked failed (not requeued) — operator must fix config
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue:failed");
      expect(api.labels.get(n)).not.toContain("queue");
      const c = api.comments.get(n) ?? [];
      const configComment = c.find(
        (s) =>
          s.includes("Merge Queue** — action misconfigured") &&
          s.includes("checked-out git working tree"),
      );
      expect(configComment).toBeDefined();
      // Config error comment must tell the operator to act, not say "no action needed"
      expect(configComment!).toContain("Fix the configuration issue");
      expect(configComment!).not.toContain("No action needed");
    }
  });

  it("cleans up and requeues on CI trigger failure with a transient error", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    api.triggerWorkflow = async () => {
      throw new Error("dispatch failed");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI",
    );
    // Transient error → branch cleaned up, PR requeued
    expect(git.deleted.length).toBeGreaterThan(0);
    expect(api.labels.get(1)).toContain("queue");
  });

  it("warns when markFailed throws during CI trigger 404 handling in runProcess", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };
    const origAdd = api.addLabel.bind(api);
    api.addLabel = async (n, label) => {
      if (label === "queue:failed") throw new Error("addLabel failed");
      return origAdd(n, label);
    };

    await expect(
      runProcess(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow("triggering CI");
    expect(
      logs.some((l) => l.includes("Warning: failed to mark PR")),
    ).toBe(true);
  });

  it("skips excluded (conflicted) PRs in the CI trigger 404 handler in runProcess", async () => {
    // PR#1 conflicts → excluded; PR#2 merges; CI trigger returns 404.
    // Verifies that the `if (excluded.has(pr.number)) continue` branch is taken.
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    git.conflictOn = "sha-1"; // PR#1 conflicts → excluded before CI trigger
    const cfg = baseCfg({ dryRun: false });

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow("triggering CI");
    // PR#1 was excluded: gets queue:failed from the conflict, NOT a config-error comment
    expect(api.labels.get(1)).toContain("queue:failed");
    const c1 = api.comments.get(1) ?? [];
    expect(c1.some((s) => s.includes("action misconfigured"))).toBe(false);
    // PR#2: gets the config-error treatment
    expect(api.labels.get(2)).toContain("queue:failed");
    const c2 = api.comments.get(2) ?? [];
    expect(c2.some((s) => s.includes("action misconfigured"))).toBe(true);
  });

  it("marks PRs failed and posts config error when CI trigger returns 404", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI",
    );

    // HTTP 404 = config error → PRs marked failed, not requeued
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue:failed");
      expect(api.labels.get(n)).not.toContain("queue");
      const c = api.comments.get(n) ?? [];
      expect(
        c.some(
          (s) =>
            s.includes("Merge Queue** — action misconfigured") &&
            s.includes("ci_workflow"),
        ),
      ).toBe(true);
    }
    // Branch should still be cleaned up
    expect(git.deleted.length).toBeGreaterThan(0);
  });

  it("marks PRs failed and posts config error when CI trigger returns 422", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Unprocessable Entity"), { status: 422 });
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI",
    );

    expect(api.labels.get(1)).toContain("queue:failed");
    const c = api.comments.get(1) ?? [];
    expect(
      c.some(
        (s) =>
          s.includes("Merge Queue** — action misconfigured") &&
          s.includes("workflow_dispatch"),
      ),
    ).toBe(true);
  });

  it("cleans up and requeues on CI status check failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.waitForWorkflowRun = async () => {
      throw new Error("timeout");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "getting CI status",
    );
    expect(git.deleted.length).toBeGreaterThan(0);
    expect(api.labels.get(1)).toContain("queue");
  });

  it("cleans up and requeues when the CI run cannot be located", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.findWorkflowRun = async () => {
      throw new Error("not found");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "locating CI run",
    );
    expect(git.deleted.length).toBeGreaterThan(0);
    expect(api.labels.get(1)).toContain("queue");
  });

  it("cleans up and requeues on completeMerge failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    git.failOn = "fastForwardMain";
    const cfg = baseCfg({ dryRun: false });

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();
    expect(api.labels.get(1)).toContain("queue");
  });

  it("marks single PR as failed on CI failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    await runProcess(api, git, cfg, nop);
    expect(api.labels.get(1)).toContain("queue:failed");
    const c = api.comments.get(1) ?? [];
    expect(c.some((s) => s.includes("Merge Queue** — CI failed"))).toBe(true);
    expect(c.some((s) => s.includes(CI_RUN_PATH_FRAGMENT))).toBe(true);
  });

  it("triggers bisection on multi-PR CI failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await runProcess(api, git, cfg, nop);
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // Should have dispatched CI + bisection
    expect(api.workflows).toHaveLength(2);
    expect(api.workflows[1].inputs?.bisect).toBe("true");
  });

  it("tolerates deleteBranch failure when all runProcess PRs conflict", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    git.conflictOn = "sha-1"; // PR#1 conflicts → result.merged is empty
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("Warning: failed to delete empty batch branch")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("No PRs merged successfully"))).toBe(
      true,
    );
  });

  it("tolerates removeLabel failure when posting merged comments in runProcess", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });

    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n, label) => {
      if (label === "queue:active") throw new Error("removeLabel failed");
      return origRemove(n, label);
    };

    await runProcess(api, git, cfg, nop);

    // PR should still receive a merged comment despite the removeLabel failure
    const c = api.comments.get(1) ?? [];
    expect(c.some((s) => s.includes("merged"))).toBe(true);
  });

  it("warns when requeue fails inside requeueAll", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    git.failOn = "createBranchFromRef"; // createAndMerge throws → requeueAll called
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    // addLabel throws for "queue" → q.requeue throws inside requeueAll
    api.addLabel = async (_n, label) => {
      if (label === "queue") throw new Error("addLabel failed");
    };

    await expect(
      runProcess(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow();

    expect(
      logs.some((l) =>
        l.includes("Warning: failed to requeue PR #1 after error"),
      ),
    ).toBe(true);
  });

  it("warns when cleanupBranch deleteBranch fails", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    // Return a drifted PR so cleanupBranch is called
    api.getPR = async (prNumber: number) => ({
      ...makePR(prNumber),
      headSHA: `sha-${prNumber}-new`,
      state: "open" as const,
    });
    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) =>
        l.includes("Warning: failed to delete batch branch"),
      ),
    ).toBe(true);
  });

  it("warns when marking conflicted PR as failed throws in runProcess", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    git.conflictOn = "sha-1"; // PR#1 conflicts
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    // addLabel throws for "queue:failed" → q.markFailed throws
    api.addLabel = async (_n, label) => {
      if (label === "queue:failed") throw new Error("addLabel failed");
    };

    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("Warning: failed to mark PR #1 as failed")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("No PRs merged successfully"))).toBe(
      true,
    );
  });

  it("warns when handleCIFailure deleteBranch throws", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("Warning: failed to delete batch branch")),
    ).toBe(true);
  });

  it("logs uncertainty when all getPR calls throw in ensurePRClosedAfterMerge", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    // Allow the first getPR call (drift check) to succeed, then always throw
    let getPRCallCount = 0;
    const originalGetPR = api.getPR.bind(api);
    api.getPR = async (n: number) => {
      getPRCallCount++;
      if (getPRCallCount === 1) return originalGetPR(n);
      throw new Error("API timeout");
    };

    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("unable to confirm PR is closed")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("is still open"))).toBe(false);
  });

  it("warns when closePR throws in ensurePRClosedAfterMerge", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    const logs: string[] = [];

    // closePR throws — the warning must be logged and the function must not throw
    api.closePR = async () => {
      throw new Error("closePR failed");
    };

    await runProcess(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("Warning: failed to close PR #1")),
    ).toBe(true);
  });
});

describe("parseBatchPrs", () => {
  it("returns empty array for empty string", () => {
    expect(parseBatchPrs("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseBatchPrs("  ")).toEqual([]);
  });

  it("parses a JSON array of integers", () => {
    expect(parseBatchPrs("[187]")).toEqual([187]);
    expect(parseBatchPrs("[181,187]")).toEqual([181, 187]);
    expect(parseBatchPrs("[]")).toEqual([]);
  });

  it("parses a single integer string as a convenience form", () => {
    expect(parseBatchPrs("187")).toEqual([187]);
    expect(parseBatchPrs("1")).toEqual([1]);
  });

  it("throws on invalid JSON that is not a plain integer", () => {
    expect(() => parseBatchPrs("not json")).toThrow("invalid batch_prs JSON");
  });

  it("throws on a JSON non-array (object)", () => {
    expect(() => parseBatchPrs('{"a":1}')).toThrow(
      "batch_prs must be a JSON array of integers",
    );
  });

  it("throws on a JSON array containing non-integers", () => {
    expect(() => parseBatchPrs("[1, 2.5]")).toThrow(
      "batch_prs must be a JSON array of integers",
    );
    expect(() => parseBatchPrs('["abc"]')).toThrow(
      "batch_prs must be a JSON array of integers",
    );
  });
});

describe("runProcess — explicit batchPrs (manual dispatch)", () => {
  it("processes an explicit PR by number without requiring the queue label", async () => {
    const api = newMockAPI();
    // PR #187 has no queue label — the test uses getPR directly
    const pr187 = makePR(187);
    api.getPR = async (n: number) => {
      if (n !== 187) throw new Error("not found");
      return pr187;
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "[187]" }),
      (m) => logs.push(m),
    );
    expect(
      logs.some((l) => l.includes("explicit PRs") && l.includes("187")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("Processing 1 PRs"))).toBe(true);
  });

  it("processes an explicit PR given as a bare integer string (convenience form)", async () => {
    const api = newMockAPI();
    const pr5 = makePR(5);
    api.getPR = async (n: number) => {
      if (n !== 5) throw new Error("not found");
      return pr5;
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "5" }),
      (m) => logs.push(m),
    );
    expect(logs.some((l) => l.includes("Processing 1 PRs"))).toBe(true);
  });

  it("skips closed PRs in explicit batchPrs", async () => {
    const api = newMockAPI();
    api.getPR = async (n: number) => makePR(n, `branch-${n}`, "closed");
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "[99]" }),
      (m) => logs.push(m),
    );
    expect(logs.some((l) => l.includes("PR #99 is closed"))).toBe(true);
    expect(logs).toContain("No PRs in queue");
  });

  it("skips not-found PRs in explicit batchPrs and logs a warning", async () => {
    const api = newMockAPI();
    // getPR throws for any PR (simulates 404)
    api.getPR = async () => {
      throw new Error("Not Found");
    };
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "[999]" }),
      (m) => logs.push(m),
    );
    expect(
      logs.some(
        (l) =>
          l.includes("Warning: PR #999 not found") &&
          l.includes("Not Found"),
      ),
    ).toBe(true);
    expect(logs).toContain("No PRs in queue");
  });

  it("respects batchSize when explicit batchPrs has more PRs than allowed", async () => {
    const api = newMockAPI();
    api.getPR = async (n: number) => makePR(n);
    const git = newMockGit();
    const logs: string[] = [];

    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "[1,2,3,4,5,6]", batchSize: 3 }),
      (m) => logs.push(m),
    );
    expect(logs.some((l) => l.includes("Trimming explicit PR list"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("Processing 3 PRs"))).toBe(true);
  });

  it("does not call listPRsWithLabel when explicit batchPrs is provided", async () => {
    const api = newMockAPI();
    let listCalled = false;
    api.listPRsWithLabel = async (_label, _limit) => {
      listCalled = true;
      return [];
    };
    api.getPR = async (n: number) => makePR(n);
    const git = newMockGit();

    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "[1]" }),
      nop,
    );
    expect(listCalled).toBe(false);
  });

  it("processes multiple explicit PRs and triggers CI in non-dry-run mode", async () => {
    const api = newMockAPI();
    api.getPR = async (n: number) => makePR(n);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });

    await runProcess(api, git, cfg, nop);
    expect(api.workflows).toHaveLength(1);
    expect(git.ffRef).toContain("merge-queue/batch-");
  });

  it("does not use triggerLabeledPR fallback when explicit batchPrs is provided", async () => {
    const api = newMockAPI();
    let getPRCallCount = 0;
    api.getPR = async (n: number) => {
      getPRCallCount++;
      return makePR(n);
    };
    const git = newMockGit();
    const logs: string[] = [];

    // Both batchPrs and triggerLabeledPR are set; triggerLabeledPR should be ignored
    await runProcess(
      api,
      git,
      baseCfg({ batchPrs: "[1]", triggerLabeledPR: 99 }),
      (m) => logs.push(m),
    );
    // getPR should only be called for PR #1 (from batchPrs), not PR #99
    expect(getPRCallCount).toBe(1);
    expect(logs.some((l) => l.includes("event-labeled"))).toBe(false);
  });

  it("throws on invalid batchPrs JSON in runProcess", async () => {
    const api = newMockAPI();
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "not valid json" });

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "invalid batch_prs JSON",
    );
  });
});

describe("runBisect", () => {
  it("throws when batch_prs is empty string", async () => {
    const api = newMockAPI();
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "" });

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "batch_prs input is required",
    );
  });

  it("throws on invalid batch_prs JSON", async () => {
    const api = newMockAPI();
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "not json" });

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "invalid batch_prs JSON",
    );
  });

  it("throws on non-array batch_prs", async () => {
    const api = newMockAPI();
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: '{"a":1}' });

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "batch_prs must be a JSON array of integers",
    );
  });

  it("throws when bisect PR not found via getPR", async () => {
    const api = newMockAPI();
    // No PRs registered in mock — getPR will throw
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[99]" });

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "bisect PR #99 not found",
    );
  });

  it("returns when PR list is empty array", async () => {
    const api = newMockAPI();
    const git = newMockGit();
    const logs: string[] = [];
    const cfg = baseCfg({ batchPrs: "[]" });

    await runBisect(api, git, cfg, (m) => logs.push(m));
    expect(logs).toContain("No PRs to bisect");
  });

  it("throws when bisect PR not in active queue", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", []);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[99]" });

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "bisect PR #99 not found",
    );
  });

  it("bisects in dry-run mode — left passes", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    const git = newMockGit();
    const logs: string[] = [];
    const cfg = baseCfg({ batchPrs: "[1,2,3]" });

    await runBisect(api, git, cfg, (m) => logs.push(m));
    expect(logs.some((l) => l.includes("Bisecting"))).toBe(true);
    expect(logs.some((l) => l.includes("Left half passed"))).toBe(true);
  });

  it("tolerates failures when posting the bisection status comment", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    const origComment = api.comment;
    api.comment = async (n, body) => {
      if (body.includes("Merge Queue** — bisecting")) {
        throw new Error("rate limited");
      }
      return origComment(n, body);
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await runBisect(api, git, cfg, (m) => logs.push(m));
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // Both PRs got a comment-post attempt; we logged warnings but the bisect
    // still completed its left-half merge.
    expect(logs.some((l) => l.includes("failed to comment on PR #1"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("failed to comment on PR #2"))).toBe(
      true,
    );
  });

  it("identifies single culprit when left half fails", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });

    await runBisect(api, git, cfg, nop);
    // Left is [1], right is [2]. Left fails → PR#1 is culprit
    expect(api.labels.get(1)).toContain("queue:failed");
    // Right half requeued
    expect(api.labels.get(2)).toContain("queue");
    // Both PRs receive the bisection status comment with a CI run link
    for (const n of [1, 2]) {
      const c = api.comments.get(n) ?? [];
      expect(
        c.some(
          (s) =>
            s.includes("Merge Queue** — bisecting") && s.includes(CI_RUN_PATH_FRAGMENT),
        ),
      ).toBe(true);
    }
  });

  it("splits further when left half with multiple PRs fails", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await runBisect(api, git, cfg, nop);
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // Should trigger CI, then dispatch further bisection for left half
    expect(api.workflows.length).toBeGreaterThanOrEqual(2);
    const bisectDispatch = api.workflows[api.workflows.length - 1];
    expect(bisectDispatch.inputs?.bisect).toBe("true");
  });

  it("dispatches right half when left half passes (non-dry-run)", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await runBisect(api, git, cfg, nop);
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // Left [1,2] should be merged, right [3] dispatched for bisection
    expect(git.ffRef).toContain("merge-queue/batch-");
    const dispatches = api.workflows.filter(
      (w) => w.inputs?.bisect === "true",
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].inputs?.batch_prs).toBe("[3]");
  });

  it("requeues right half when right dispatch fails", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });

    const origTrigger = api.triggerWorkflow.bind(api);
    api.triggerWorkflow = async (file, ref, inputs) => {
      // Let CI trigger succeed, but fail the bisect dispatch
      if (inputs?.bisect === "true") throw new Error("dispatch failed");
      return origTrigger(file, ref, inputs);
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
        "dispatching bisect for right half",
      );
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // Right half (PR#3) should be requeued
    expect(api.labels.get(3)).toContain("queue");
  });

  it("requeues all on follow-up bisect dispatch failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });

    const origTrigger = api.triggerWorkflow.bind(api);
    api.triggerWorkflow = async (file, ref, inputs) => {
      // Let CI trigger succeed, but fail the follow-up bisect
      if (inputs?.bisect === "true") throw new Error("dispatch failed");
      return origTrigger(file, ref, inputs);
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
        "dispatching follow-up bisect",
      );
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // All PRs should be requeued
    expect(api.labels.get(1)).toContain("queue");
    expect(api.labels.get(2)).toContain("queue");
    expect(api.labels.get(3)).toContain("queue");
  });

  it("requeues PRs and throws on transient CI trigger failure in bisect", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    api.triggerWorkflow = async () => {
      throw new Error("dispatch failed");
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI for bisect",
    );
    // Transient error: branch cleaned up and PRs requeued (not stuck in queue:active)
    expect(git.deleted.length).toBeGreaterThan(0);
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue");
      const c = api.comments.get(n) ?? [];
      expect(c.some((s) => s.includes("— requeued"))).toBe(true);
    }
  });

  it("marks PRs failed when ConfigurationError thrown from bisect createAndMerge", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });

    git.createBranchFromRef = async () => {
      throw new ConfigurationError(
        "merge-queue-action requires a full-history clone, but the working tree is a shallow repository",
      );
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow();

    // Both PRs must be marked failed — not requeued
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue:failed");
      expect(api.labels.get(n)).not.toContain("queue");
      const c = api.comments.get(n) ?? [];
      expect(
        c.some(
          (s) =>
            s.includes("Merge Queue** — action misconfigured") &&
            s.includes("shallow repository"),
        ),
      ).toBe(true);
    }
  });

  it("warns when markFailed throws during bisect createAndMerge ConfigurationError handling", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    git.createBranchFromRef = async () => {
      throw new ConfigurationError("not in a git worktree");
    };
    const origAdd = api.addLabel.bind(api);
    api.addLabel = async (n, label) => {
      if (label === "queue:failed") throw new Error("addLabel failed");
      return origAdd(n, label);
    };

    await expect(
      runBisect(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow();
    expect(
      logs.some((l) => l.includes("Warning: failed to mark PR")),
    ).toBe(true);
  });

  it("requeues all PRs when createAndMerge throws a transient error in runBisect", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });

    git.createBranchFromRef = async () => {
      throw new Error("network timeout");
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow("network timeout");

    // Transient error: PRs should be requeued (not marked failed)
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue");
      expect(api.labels.get(n)).not.toContain("queue:failed");
      const c = api.comments.get(n) ?? [];
      expect(c.some((s) => s.includes("— requeued"))).toBe(true);
      expect(c.some((s) => s.includes("action misconfigured"))).toBe(false);
    }
  });

  it("warns when requeue throws during transient createAndMerge error handling in runBisect", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    git.createBranchFromRef = async () => {
      throw new Error("network timeout");
    };
    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n, label) => {
      if (label === "queue:active") throw new Error("removeLabel failed");
      return origRemove(n, label);
    };

    await expect(
      runBisect(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow("network timeout");
    expect(
      logs.some((l) => l.includes("Warning: failed to requeue PR")),
    ).toBe(true);
  });

  it("tolerates deleteBranch failure inside bisect CI trigger 404 handler", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };
    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI for bisect",
    );
    // PRs should still be marked failed despite the branch-delete failure
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue:failed");
    }
  });

  it("warns when markFailed throws during bisect CI trigger 404 handling", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };
    const origAdd = api.addLabel.bind(api);
    api.addLabel = async (n, label) => {
      if (label === "queue:failed") throw new Error("addLabel failed");
      return origAdd(n, label);
    };

    await expect(
      runBisect(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow("triggering CI for bisect");
    expect(
      logs.some((l) => l.includes("Warning: failed to mark PR")),
    ).toBe(true);
  });

  it("skips conflicted (excluded) PRs in the CI trigger 404 handler in runBisect", async () => {
    // PRs [1,2,3]: left=[1,2], right=[3]. PR#1 conflicts → excluded.
    // CI trigger returns 404. n=1 hits the `excluded.has(n)` continue branch (line 723).
    // PR#2 and PR#3 should be marked failed; PR#1 should not get a config-error comment.
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    const git = newMockGit();
    git.conflictOn = "sha-1"; // PR#1 conflicts → excluded before CI trigger
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI for bisect",
    );

    // PR#1 was excluded due to conflict: should NOT get a config-error comment
    const c1 = api.comments.get(1) ?? [];
    expect(c1.some((s) => s.includes("action misconfigured"))).toBe(false);

    // PR#2 and PR#3 should be marked failed with a config-error comment
    for (const n of [2, 3]) {
      expect(api.labels.get(n)).toContain("queue:failed");
      const c = api.comments.get(n) ?? [];
      expect(
        c.some(
          (s) =>
            s.includes("Merge Queue** — action misconfigured") &&
            s.includes("ci_workflow"),
        ),
      ).toBe(true);
    }
  });

  it("marks PRs failed and posts config error when bisect CI trigger returns 404", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });

    api.triggerWorkflow = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "triggering CI for bisect",
    );

    // HTTP 404 on CI trigger = config error → mark both PRs failed
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue:failed");
      expect(api.labels.get(n)).not.toContain("queue");
      const c = api.comments.get(n) ?? [];
      expect(
        c.some(
          (s) =>
            s.includes("Merge Queue** — action misconfigured") &&
            s.includes("ci_workflow"),
        ),
      ).toBe(true);
    }
  });

  it("cleans up and requeues when bisect CI run cannot be located", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    api.findWorkflowRun = async () => {
      throw new Error("timeout");
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "locating bisect CI run",
    );
    // Bisect branch was cleaned up
    expect(git.deleted.length).toBeGreaterThan(0);
    // Both candidate PRs requeued with a requeued status comment
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue");
      const c = api.comments.get(n) ?? [];
      expect(c.some((s) => s.includes("— requeued"))).toBe(true);
    }
  });

  it("cleans up and requeues when bisect CI status cannot be read", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    api.waitForWorkflowRun = async () => {
      throw new Error("timeout");
    };

    await expect(runBisect(api, git, cfg, nop)).rejects.toThrow(
      "getting bisect CI status",
    );
    expect(git.deleted.length).toBeGreaterThan(0);
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue");
      const c = api.comments.get(n) ?? [];
      expect(c.some((s) => s.includes("— requeued"))).toBe(true);
    }
  });

  it("handles no merged PRs in bisect batch", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1, "conflict-branch")]);
    const git = newMockGit();
    git.conflictOn = "sha-1";
    const logs: string[] = [];
    const cfg = baseCfg({ batchPrs: "[1]", dryRun: false });

    await runBisect(api, git, cfg, (m) => logs.push(m));
    expect(
      logs.some((l) => l.includes("No PRs merged in bisect batch")),
    ).toBe(true);
    expect(api.labels.get(1)).toContain("queue:failed");
  });

  it("warns but continues when requeue fails inside handleBisectObservationFailure", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    // findWorkflowRun throws → triggers handleBisectObservationFailure
    api.findWorkflowRun = async () => {
      throw new Error("timeout");
    };
    // addLabel throws for the pending "queue" label → q.requeue throws
    api.addLabel = async (_n, label) => {
      if (label === "queue") throw new Error("rate limited");
    };

    await expect(
      runBisect(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow("locating bisect CI run");

    // Both PRs should log a requeue warning
    expect(
      logs.some((l) => l.includes("Warning: failed to requeue PR #1")),
    ).toBe(true);
    expect(
      logs.some((l) => l.includes("Warning: failed to requeue PR #2")),
    ).toBe(true);
    // continue was hit — no requeued comment posted
    expect(api.comments.size).toBe(0);
  });

  it("warns when deleteBranch fails inside handleBisectObservationFailure", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    // findWorkflowRun throws → triggers handleBisectObservationFailure
    api.findWorkflowRun = async () => {
      throw new Error("timeout");
    };
    // deleteBranch throws — should log a warning then continue with requeue
    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await expect(
      runBisect(api, git, cfg, (m) => logs.push(m)),
    ).rejects.toThrow("locating bisect CI run");

    expect(
      logs.some((l) =>
        l.includes("Warning: failed to delete bisect branch"),
      ),
    ).toBe(true);
    // PRs should still be requeued despite the branch-delete failure
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue");
    }
  });

  it("warns but continues when marking conflicted PR as failed throws", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1)]);
    const git = newMockGit();
    git.conflictOn = "sha-1"; // PR#1 conflicts → no merged PRs
    const cfg = baseCfg({ batchPrs: "[1]", dryRun: false });
    const logs: string[] = [];

    // addLabel throws for "queue:failed" → q.markFailed throws
    api.addLabel = async (_n, label) => {
      if (label === "queue:failed") throw new Error("addLabel failed");
    };

    await runBisect(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("Warning: failed to mark PR #1 as failed")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("No PRs merged in bisect batch"))).toBe(
      true,
    );
  });

  it("tolerates deleteBranch failure when all bisect PRs conflict (no merged)", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1)]);
    const git = newMockGit();
    git.conflictOn = "sha-1"; // PR#1 conflicts → mergedLeft = []
    const cfg = baseCfg({ batchPrs: "[1]", dryRun: false });
    const logs: string[] = [];

    // Override deleteBranch to throw — should be silently swallowed
    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await runBisect(api, git, cfg, (m) => logs.push(m));

    expect(logs.some((l) => l.includes("No PRs merged in bisect batch"))).toBe(
      true,
    );
  });

  it("requeues PRs and warns when deleteBranch also fails on transient CI trigger failure in bisect", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    // CI trigger throws with a transient error
    api.triggerWorkflow = async () => {
      throw new Error("trigger failed");
    };
    // deleteBranch also throws inside handleBisectObservationFailure
    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await expect(runBisect(api, git, cfg, (m) => logs.push(m))).rejects.toThrow(
      "triggering CI for bisect",
    );
    // handleBisectObservationFailure logs a warning for the branch-delete failure
    expect(
      logs.some((l) => l.includes("Warning: failed to delete bisect branch")),
    ).toBe(true);
    // PRs must still be requeued (not stuck in queue:active)
    for (const n of [1, 2]) {
      expect(api.labels.get(n)).toContain("queue");
    }
  });

  it("tolerates removeLabel failure when posting merged comments in bisect", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });

    const origRemove = api.removeLabel.bind(api);
    api.removeLabel = async (n, label) => {
      if (label === "queue:active") throw new Error("removeLabel failed");
      return origRemove(n, label);
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await runBisect(api, git, cfg, nop);
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // Merged PR (#1, #2) should still receive a merged comment despite the
    // removeLabel failure being swallowed
    for (const n of [1, 2]) {
      const c = api.comments.get(n) ?? [];
      expect(c.some((s) => s.includes("merged"))).toBe(true);
    }
  });

  it("warns when requeue fails during right-half dispatch failure in bisect", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "success";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });
    const logs: string[] = [];

    const origTrigger = api.triggerWorkflow.bind(api);
    api.triggerWorkflow = async (file, ref, inputs) => {
      if (inputs?.bisect === "true") throw new Error("dispatch failed");
      return origTrigger(file, ref, inputs);
    };
    // addLabel throws for "queue" → q.requeue throws for right-half PR#3
    api.addLabel = async (_n, label) => {
      if (label === "queue") throw new Error("addLabel failed");
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await expect(
        runBisect(api, git, cfg, (m) => logs.push(m)),
      ).rejects.toThrow("dispatching bisect for right half");
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    expect(
      logs.some((l) => l.includes("Warning: failed to requeue PR #3")),
    ).toBe(true);
  });

  it("warns but continues when deleting bisect branch fails after CI failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    // Override deleteBranch to throw — warning should be logged
    git.deleteBranch = async () => {
      throw new Error("delete failed");
    };

    await runBisect(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) =>
        l.includes("Warning: failed to delete bisect branch"),
      ),
    ).toBe(true);
  });

  it("warns when requeue fails for right-half after identifying single culprit", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2]", dryRun: false });
    const logs: string[] = [];

    // addLabel throws for "queue" → q.requeue throws for right-half PR#2
    // (markFailed for the culprit PR#1 adds "queue:failed", which is unaffected)
    api.addLabel = async (_n, label) => {
      if (label === "queue") throw new Error("addLabel failed");
    };

    await runBisect(api, git, cfg, (m) => logs.push(m));

    expect(
      logs.some((l) => l.includes("Warning: failed to requeue PR #2")),
    ).toBe(true);
  });

  it("warns when requeue fails during follow-up bisect dispatch failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue:active", [makePR(1), makePR(2), makePR(3)]);
    api.ciConclusion = "failure";
    const git = newMockGit();
    const cfg = baseCfg({ batchPrs: "[1,2,3]", dryRun: false });
    const logs: string[] = [];

    const origTrigger = api.triggerWorkflow.bind(api);
    api.triggerWorkflow = async (file, ref, inputs) => {
      if (inputs?.bisect === "true") throw new Error("dispatch failed");
      return origTrigger(file, ref, inputs);
    };
    // addLabel throws for "queue" → q.requeue throws for all requeue attempts
    api.addLabel = async (_n, label) => {
      if (label === "queue") throw new Error("addLabel failed");
    };

    process.env.MERGE_QUEUE_WORKFLOW_FILE = ".github/workflows/mq.yml";
    try {
      await expect(
        runBisect(api, git, cfg, (m) => logs.push(m)),
      ).rejects.toThrow("dispatching follow-up bisect");
    } finally {
      delete process.env.MERGE_QUEUE_WORKFLOW_FILE;
    }

    // All three PRs should log a requeue warning
    for (const n of [1, 2, 3]) {
      expect(
        logs.some((l) => l.includes(`Warning: failed to requeue PR #${n}`)),
      ).toBe(true);
    }
  });
});

describe("runSetup", () => {
  it("creates queue labels", async () => {
    const api = newMockAPI();
    const logs: string[] = [];
    const cfg = baseCfg({ dryRun: false });

    await runSetup(api, cfg, (m) => logs.push(m));
    expect(api.createdLabels).toHaveLength(3);
    expect(logs.some((l) => l.includes("Setting up labels"))).toBe(true);
  });

  it("does not require commentCtx", async () => {
    const api = newMockAPI();
    const cfg: Config = {
      ciWorkflow: ".github/workflows/ci.yml",
      batchSize: 5,
      queueLabel: "queue",
      dryRun: false,
      batchPrs: "",
    };
    await runSetup(api, cfg, nop);
    expect(api.createdLabels).toHaveLength(3);
  });
});

describe("commentCtx requirement", () => {
  it("runProcess throws a clear error when commentCtx is missing", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg: Config = {
      ciWorkflow: ".github/workflows/ci.yml",
      batchSize: 5,
      queueLabel: "queue",
      dryRun: false,
      batchPrs: "",
    };
    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "commentCtx is required",
    );
  });
});
