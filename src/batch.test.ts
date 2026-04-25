import { describe, expect, it } from "vitest";
import { Batch, type GitOperator, type BatchPR } from "./batch.js";

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

    async createBranchFromRef(branch: string, _baseRef: string) {
      if (mock.failOn === "createBranchFromRef")
        throw new Error("mock error");
      mock.branches.push(branch);
    },

    async mergeBranch(
      _branch: string,
      sourceRef: string,
      _commitMsg: string,
    ) {
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
      return "abc123";
    },

    async deleteBranch(branch: string) {
      if (mock.failOn === "deleteBranch") throw new Error("mock error");
      mock.deleted.push(branch);
    },
  };
  return mock;
}

const nop = () => {};

describe("CreateAndMerge", () => {
  it("merges all PRs successfully", async () => {
    const git = newMockGit();
    const b = new Batch(git, false, nop);
    const prs: BatchPR[] = [
      {
        number: 1,
        headRef: "feature-a",
        headSHA: "sha-a",
        title: "Add feature A",
      },
      {
        number: 2,
        headRef: "feature-b",
        headSHA: "sha-b",
        title: "Add feature B",
      },
    ];

    const result = await b.createAndMerge("test-1", prs);

    expect(result.branch).toBe("merge-queue/batch-test-1");
    expect(result.merged).toHaveLength(2);
    expect(result.conflicted).toHaveLength(0);
    expect(git.branches).toEqual(["merge-queue/batch-test-1"]);
    expect(git.merges).toHaveLength(2);
    expect(git.pushed).toHaveLength(1);
  });

  it("records conflicting PRs", async () => {
    const git = newMockGit();
    git.conflictOn = "sha-b";
    const b = new Batch(git, false, nop);
    const prs: BatchPR[] = [
      { number: 1, headRef: "feature-a", headSHA: "sha-a", title: "A" },
      { number: 2, headRef: "feature-b", headSHA: "sha-b", title: "B" },
      { number: 3, headRef: "feature-c", headSHA: "sha-c", title: "C" },
    ];

    const result = await b.createAndMerge("test-2", prs);

    expect(result.merged).toHaveLength(2);
    expect(result.conflicted).toHaveLength(1);
    expect(result.conflicted[0].number).toBe(2);
  });

  it("dry run does not create branches or push", async () => {
    const git = newMockGit();
    const b = new Batch(git, true, nop);
    const prs: BatchPR[] = [
      { number: 1, headRef: "feature-a", headSHA: "sha-a", title: "A" },
    ];

    const result = await b.createAndMerge("dry", prs);

    expect(result.merged).toHaveLength(1);
    expect(git.branches).toHaveLength(0);
    expect(git.pushed).toHaveLength(0);
  });

  it("cleans up branch on MergeBranch error", async () => {
    const git = newMockGit();
    git.failOn = "mergeBranch";
    const b = new Batch(git, false, nop);
    await expect(
      b.createAndMerge("err", [
        { number: 1, headRef: "f", headSHA: "sha-f", title: "T" },
      ]),
    ).rejects.toThrow("merging PR #1");
    expect(git.deleted).toContain("merge-queue/batch-err");
  });

  it("warns via Reporter when the cleanup deleteBranch also fails", async () => {
    // Two-level failure: mergeBranch throws (triggers cleanup), and
    // the deleteBranch teardown itself throws. The Reporter.warn call
    // should surface the teardown failure; the original merge error
    // still propagates as the thrown exception.
    const git: GitOperator = {
      async createBranchFromRef() {},
      async mergeBranch() {
        throw new Error("boom-merge");
      },
      async pushBranch() {},
      async fastForwardMain() {
        return "sha";
      },
      async deleteBranch() {
        throw new Error("boom-delete");
      },
    };
    const warned: Array<{ msg: string; scope: number[] }> = [];
    let scope: number[] = [];
    const reporter = {
      info: () => {},
      async warn(msg: string) {
        warned.push({ msg, scope: [...scope] });
      },
      async withScope<T>(prs: number[], fn: () => Promise<T>) {
        const prev = scope;
        scope = prs;
        try {
          return await fn();
        } finally {
          scope = prev;
        }
      },
    };
    const b = new Batch(git, false, nop, reporter);
    await expect(
      b.createAndMerge("err", [
        { number: 7, headRef: "f", headSHA: "sha-f", title: "T" },
      ]),
    ).rejects.toThrow("merging PR #7");

    expect(warned).toHaveLength(1);
    expect(warned[0].msg).toContain("failed to delete batch branch");
    expect(warned[0].msg).toContain("boom-delete");
    // The warning is scoped to the batch's PRs (7) at the moment it
    // fires — confirming Batch.createAndMerge set scope via
    // reporter.withScope before calling GitOps.
    expect(warned[0].scope).toEqual([7]);
  });

  it("propagates CreateBranchFromRef error", async () => {
    const git = newMockGit();
    git.failOn = "createBranchFromRef";
    const b = new Batch(git, false, nop);
    await expect(
      b.createAndMerge("err", [
        { number: 1, headRef: "f", headSHA: "sha-f", title: "T" },
      ]),
    ).rejects.toThrow();
  });

  it("handles empty PR list", async () => {
    const git = newMockGit();
    const b = new Batch(git, false, nop);
    const result = await b.createAndMerge("empty", []);

    expect(result.merged).toHaveLength(0);
    expect(git.pushed).toHaveLength(0);
  });
});

describe("CompleteMerge", () => {
  it("fast-forwards main and deletes branch", async () => {
    const git = newMockGit();
    const b = new Batch(git, false, nop);
    await b.completeMerge("merge-queue/batch-1");

    expect(git.ffRef).toBe("merge-queue/batch-1");
    expect(git.deleted).toEqual(["merge-queue/batch-1"]);
  });

  it("dry run does not fast-forward", async () => {
    const git = newMockGit();
    const b = new Batch(git, true, nop);
    await b.completeMerge("merge-queue/batch-1");

    expect(git.ffRef).toBe("");
  });

  it("propagates FastForwardMain error", async () => {
    const git = newMockGit();
    git.failOn = "fastForwardMain";
    const b = new Batch(git, false, nop);
    await expect(
      b.completeMerge("merge-queue/batch-1"),
    ).rejects.toThrow();
  });
});
