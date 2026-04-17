import { describe, expect, it, afterEach } from "vitest";
import {
  hasWritePermission,
  selfWorkflowFile,
  runProcess,
  runBisect,
  runSetup,
  type FullAPI,
  type Config,
} from "./action.js";
import type { PR } from "./queue.js";
import type { GitOperator } from "./batch.js";

// --- mocks ---

function makePR(n: number, headRef = `branch-${n}`): PR {
  return {
    number: n,
    headRef,
    headSHA: `sha-${n}`,
    title: `PR #${n}`,
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
    async getWorkflowRunStatus(): Promise<string> {
      return mock.ciConclusion;
    },
    async closePR(): Promise<void> {},
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
    expect(api.comments.get(1)?.[0]).toBe("Merge queue: merged to main");
  });

  it("requeues all PRs when createAndMerge fails", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1), makePR(2)]);
    const git = newMockGit();
    git.failOn = "createBranchFromRef";
    const cfg = baseCfg({ dryRun: false });

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow();
    // Both PRs should be requeued
    expect(api.labels.get(1)).toContain("queue");
    expect(api.labels.get(2)).toContain("queue");
  });

  it("cleans up and requeues on CI trigger failure", async () => {
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
    // Branch should be cleaned up and PR requeued
    expect(git.deleted.length).toBeGreaterThan(0);
    expect(api.labels.get(1)).toContain("queue");
  });

  it("cleans up and requeues on CI status check failure", async () => {
    const api = newMockAPI();
    api.prs.set("queue", [makePR(1)]);
    const git = newMockGit();
    const cfg = baseCfg({ dryRun: false });
    api.getWorkflowRunStatus = async () => {
      throw new Error("timeout");
    };

    await expect(runProcess(api, git, cfg, nop)).rejects.toThrow(
      "getting CI status",
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
    expect(api.comments.get(1)?.[0]).toBe("Merge queue: CI failed");
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

  it("cleans up and throws on CI trigger failure in bisect", async () => {
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
    expect(git.deleted.length).toBeGreaterThan(0);
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
});
