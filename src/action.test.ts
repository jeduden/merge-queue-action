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
