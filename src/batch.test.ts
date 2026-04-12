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
      sourceBranch: string,
      _commitMsg: string,
    ) {
      if (mock.failOn === "mergeBranch") throw new Error("mock error");
      if (sourceBranch === mock.conflictOn) return false;
      mock.merges.push(sourceBranch);
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

describe("CreateAndMerge", () => {
  it("merges all PRs successfully", async () => {
    const git = newMockGit();
    const b = new Batch(git, false, nop);
    const prs: BatchPR[] = [
      { number: 1, headRef: "feature-a", title: "Add feature A" },
      { number: 2, headRef: "feature-b", title: "Add feature B" },
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
    git.conflictOn = "feature-b";
    const b = new Batch(git, false, nop);
    const prs: BatchPR[] = [
      { number: 1, headRef: "feature-a", title: "A" },
      { number: 2, headRef: "feature-b", title: "B" },
      { number: 3, headRef: "feature-c", title: "C" },
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
      { number: 1, headRef: "feature-a", title: "A" },
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
        { number: 1, headRef: "f", title: "T" },
      ]),
    ).rejects.toThrow("merging PR #1");
    expect(git.deleted).toContain("merge-queue/batch-err");
  });

  it("propagates CreateBranchFromRef error", async () => {
    const git = newMockGit();
    git.failOn = "createBranchFromRef";
    const b = new Batch(git, false, nop);
    await expect(
      b.createAndMerge("err", [
        { number: 1, headRef: "f", title: "T" },
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
