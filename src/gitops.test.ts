import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GitOps, defaultExec, type Exec } from "./gitops.js";
import { ConfigurationError } from "./errors.js";

interface FakeRef {
  ref: string;
  sha: string;
}

function makeFakeOctokit(initialRefs: FakeRef[] = []) {
  const refs = new Map(initialRefs.map((r) => [r.ref, r.sha]));
  const calls: string[] = [];
  const octokit = {
    rest: {
      git: {
        async getRef({ ref }: { owner: string; repo: string; ref: string }) {
          calls.push(`getRef:${ref}`);
          const sha = refs.get(ref);
          if (!sha) throw new Error(`no such ref ${ref}`);
          return { data: { object: { sha } } };
        },
        async createRef({
          ref,
          sha,
        }: {
          owner: string;
          repo: string;
          ref: string;
          sha: string;
        }) {
          calls.push(`createRef:${ref}`);
          refs.set(ref.replace(/^refs\//, ""), sha);
          return { data: {} };
        },
        async updateRef({
          ref,
          sha,
          force,
        }: {
          owner: string;
          repo: string;
          ref: string;
          sha: string;
          force: boolean;
        }) {
          calls.push(`updateRef:${ref}:force=${force}`);
          refs.set(ref, sha);
          return { data: {} };
        },
        async deleteRef({
          ref,
        }: {
          owner: string;
          repo: string;
          ref: string;
        }) {
          calls.push(`deleteRef:${ref}`);
          refs.delete(ref);
          return { data: {} };
        },
      },
    },
  };
  return { octokit, calls, refs };
}

describe("GitOps with injected exec", () => {
  it("createBranchFromRef asserts worktree, calls the API, then fetch+checkout", async () => {
    const { octokit, calls } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });

    await ops.createBranchFromRef("merge-queue/batch-1", "main");

    expect(calls).toEqual([
      "getRef:heads/main",
      "createRef:refs/heads/merge-queue/batch-1",
    ]);
    // Worktree readiness check runs first.
    expect(execCalls[0]).toEqual(["rev-parse", "--is-inside-work-tree"]);
    expect(execCalls[1]).toEqual(["remote", "get-url", "origin"]);
    expect(execCalls[2]).toEqual(["rev-parse", "--is-shallow-repository"]);
    // Then fetch + checkout.
    const fetchCall = execCalls.find((c) => c[0] === "fetch");
    expect(fetchCall).toContain(
      "+refs/heads/merge-queue/batch-1:refs/remotes/origin/merge-queue/batch-1",
    );
    const checkoutCall = execCalls.find((c) => c[0] === "checkout");
    expect(checkoutCall?.slice(0, 3)).toEqual([
      "checkout",
      "-B",
      "merge-queue/batch-1",
    ]);
  });

  it("mergeBranch returns false and cleans up on unresolved conflict", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      // Real merge invocation carries `-c commit.gpgsign=false` before
      // the `merge` subcommand; abort is a bare `["merge", "--abort"]`.
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args[mergeIdx + 1] !== "--abort") {
        // Git writes conflict info to stdout, not stderr.
        return { code: 1, stdout: "CONFLICT (content): Merge conflict in file.txt", stderr: "" };
      }
      // MERGE_HEAD exists after merge with conflicts
      if (args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
        return { code: 0, stdout: "abc1234", stderr: "" };
      }
      // Commit fails due to unresolved conflicts
      if (args.includes("commit") && args.includes("-m")) {
        return { code: 1, stdout: "", stderr: "error: Committing is not possible because you have unmerged files." };
      }
      // Check for unresolved conflicts with `git ls-files -u`
      if (args[0] === "ls-files" && args[1] === "-u") {
        // Simulate unresolved conflicts in the index
        return { code: 0, stdout: "100644 abc123 1\tfile.txt\n100644 def456 2\tfile.txt\n100644 789ghi 3\tfile.txt", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });

    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(false);
    const mergeAbort = execCalls.find(
      (c) => c[0] === "merge" && c[1] === "--abort",
    );
    expect(mergeAbort).toBeDefined();

    // The merge attempt must disable gpg signing so inherited signing
    // config on self-hosted runners can't silently break batching.
    const mergeAttempt = execCalls.find(
      (c) =>
        c.includes("merge") && c[c.indexOf("merge") + 1] !== "--abort",
    );
    expect(mergeAttempt).toContain("commit.gpgsign=false");
  });

  it("mergeBranch succeeds when merge driver resolves all conflicts (exit 1 but no unresolved files)", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args[mergeIdx + 1] !== "--abort") {
        // Merge driver encountered conflicts but resolved them all
        return { code: 1, stdout: "Auto-merging file.md\nCONFLICT (content): Merge conflict in file.md\nmdsmith merge driver: resolved conflict in file.md", stderr: "" };
      }
      // Check for unresolved conflicts with `git ls-files -u`
      if (args[0] === "ls-files" && args[1] === "-u") {
        // No unresolved conflicts — merge driver resolved everything
        return { code: 0, stdout: "", stderr: "" };
      }
      // MERGE_HEAD exists, so commit can proceed
      if (args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
        return { code: 0, stdout: "abc1234", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });

    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(true);

    // Should NOT have aborted the merge
    const mergeAbort = execCalls.find(
      (c) => c[0] === "merge" && c[1] === "--abort",
    );
    expect(mergeAbort).toBeUndefined();

    // Should have committed after merge driver resolved conflicts
    const commitCall = execCalls.find(
      (c) => c.includes("commit") && c.includes("-m"),
    );
    expect(commitCall).toBeDefined();
  });

  it("mergeBranch succeeds when conflict resolution pipeline clears all conflicts (merge exits 1 but ls-files -u is empty)", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args[mergeIdx + 1] !== "--abort") {
        // Merge reports conflicts
        return { code: 1, stdout: "Auto-merging catalog.md\nCONFLICT (content): Merge conflict in catalog.md", stderr: "" };
      }
      // MERGE_HEAD exists after merge with conflicts
      if (args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
        return { code: 0, stdout: "abc1234", stderr: "" };
      }
      // Commit succeeds — pre-merge-commit hook resolved the conflicts
      if (args.includes("commit") && args.includes("-m")) {
        return { code: 0, stdout: "[batch abc1234] msg\n 1 file changed, 5 insertions(+), 2 deletions(-)", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });

    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(true);

    // Should NOT have aborted the merge
    const mergeAbort = execCalls.find(
      (c) => c[0] === "merge" && c[1] === "--abort",
    );
    expect(mergeAbort).toBeUndefined();

    // Should have committed after hook resolved conflicts
    const commitCall = execCalls.find(
      (c) => c.includes("commit") && c.includes("-m"),
    );
    expect(commitCall).toBeDefined();
  });

  it("mergeBranch returns true on clean merge", async () => {
    const { octokit } = makeFakeOctokit();
    const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(true);
  });

  it("mergeBranch returns true without running git commit when already up to date (no MERGE_HEAD)", async () => {
    const { octokit } = makeFakeOctokit();
    const commitCalls: string[][] = [];
    const exec: Exec = async (args) => {
      // merge --no-commit exits 0 ("Already up to date.")
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args.includes("--no-commit")) {
        return { code: 0, stdout: "Already up to date.\n", stderr: "" };
      }
      // MERGE_HEAD does not exist (no merge in progress)
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return {
          code: 128,
          stdout: "",
          stderr: "fatal: not a valid object name MERGE_HEAD",
        };
      }
      if (args.includes("commit")) {
        commitCalls.push(args);
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(true);
    // git commit must NOT have been called — nothing to commit.
    expect(commitCalls).toHaveLength(0);
  });

  it("mergeBranch throws and runs git merge --abort when git commit fails", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      // merge --no-commit exits 0 (merge staged successfully)
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args.includes("--no-commit")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      // MERGE_HEAD exists — merge is in progress
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      // commit step fails (e.g. pre-merge-commit hook rejects)
      if (args.includes("commit")) {
        return { code: 1, stdout: "", stderr: "pre-merge-commit hook failed" };
      }
      // Check for unresolved conflicts with `git ls-files -u`
      if (args[0] === "ls-files" && args[1] === "-u") {
        // No conflicts in index — hook failure, not merge conflict
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(ops.mergeBranch("batch", "sha-1", "msg")).rejects.toThrow(
      "pre-merge-commit hook failed",
    );
    // merge --abort must be attempted to clean up the staged merge state.
    const abortCall = execCalls.find(
      (c) => c[0] === "merge" && c[1] === "--abort",
    );
    expect(abortCall).toBeDefined();
  });

  it("mergeBranch falls back to git reset --hard HEAD when git merge --abort also fails after commit failure", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      // merge --no-commit exits 0 (merge staged successfully)
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args.includes("--no-commit")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      // MERGE_HEAD exists — merge is in progress
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      // commit step fails
      if (args.includes("commit")) {
        return { code: 1, stdout: "", stderr: "pre-merge-commit hook failed" };
      }
      // Check for unresolved conflicts with `git ls-files -u`
      if (args[0] === "ls-files" && args[1] === "-u") {
        // No conflicts in index — hook failure, not merge conflict
        return { code: 0, stdout: "", stderr: "" };
      }
      // merge --abort also fails
      if (mergeIdx >= 0 && args[mergeIdx + 1] === "--abort") {
        return { code: 128, stdout: "", stderr: "fatal: no merge in progress" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(ops.mergeBranch("batch", "sha-1", "msg")).rejects.toThrow(
      "pre-merge-commit hook failed",
    );
    // git reset --hard HEAD must be the fallback cleanup.
    const resetCall = execCalls.find(
      (c) => c[0] === "reset" && c[1] === "--hard" && c[2] === "HEAD",
    );
    expect(resetCall).toBeDefined();
  });

  it("mergeBranch throws (not conflict) when git merge exits with a non-1 error", async () => {
    const { octokit } = makeFakeOctokit();
    const exec: Exec = async (args) => {
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args[mergeIdx + 1] !== "--abort") {
        // e.g. exit 128 — "fatal: not a valid object name"
        return { code: 128, stdout: "", stderr: "fatal: bad revision" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(ops.mergeBranch("batch", "sha-1", "msg")).rejects.toThrow(
      "git merge failed (exit 128)",
    );
  });

  it("createBranchFromRef throws a targeted error when not in a worktree", async () => {
    const { octokit } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 128, stdout: "", stderr: "not a git repo" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(
      ops.createBranchFromRef("merge-queue/batch-1", "main"),
    ).rejects.toThrow(/actions\/checkout/);
  });

  it("throws ConfigurationError when not in a worktree", async () => {
    const { octokit } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 128, stdout: "", stderr: "not a git repo" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const err = await ops
      .createBranchFromRef("merge-queue/batch-1", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
  });

  it("createBranchFromRef throws a targeted error when origin is missing", async () => {
    const { octokit } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 2, stdout: "", stderr: "no such remote" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(
      ops.createBranchFromRef("merge-queue/batch-1", "main"),
    ).rejects.toThrow(/origin/);
  });

  it("throws ConfigurationError when origin remote is missing", async () => {
    const { octokit } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 2, stdout: "", stderr: "no such remote" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const err = await ops
      .createBranchFromRef("merge-queue/batch-1", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
  });

  it("createBranchFromRef throws a targeted error when the clone is shallow", async () => {
    const { octokit } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(
      ops.createBranchFromRef("merge-queue/batch-1", "main"),
    ).rejects.toThrow(/fetch-depth: 0|unshallow/);
  });

  it("throws ConfigurationError when the clone is shallow", async () => {
    const { octokit } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const err = await ops
      .createBranchFromRef("merge-queue/batch-1", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
  });

  it("createBranchFromRef deletes the leaked remote ref if local fetch/checkout fails", async () => {
    const { octokit, calls } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "fetch") {
        return { code: 128, stdout: "", stderr: "fatal: object not found" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(
      ops.createBranchFromRef("merge-queue/batch-1", "main"),
    ).rejects.toThrow("fatal: object not found");
    // Ref was created and then deleted on the failure path.
    expect(calls).toContain("createRef:refs/heads/merge-queue/batch-1");
    expect(calls).toContain("deleteRef:heads/merge-queue/batch-1");
  });

  it("mergeBranch throws when both merge --abort and reset --hard fail", async () => {
    const { octokit } = makeFakeOctokit();
    const exec: Exec = async (args) => {
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args[mergeIdx + 1] !== "--abort") {
        // Git writes conflict info to stdout, not stderr.
        return { code: 1, stdout: "CONFLICT (content): Merge conflict in file.txt", stderr: "" };
      }
      // MERGE_HEAD exists after merge with conflicts
      if (args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
        return { code: 0, stdout: "abc1234", stderr: "" };
      }
      // Commit fails due to unresolved conflicts
      if (args.includes("commit") && args.includes("-m")) {
        return { code: 1, stdout: "", stderr: "error: Committing is not possible because you have unmerged files." };
      }
      // Check for unresolved conflicts with `git ls-files -u`
      if (args[0] === "ls-files" && args[1] === "-u") {
        // Simulate unresolved conflicts in the index
        return { code: 0, stdout: "100644 abc123 1\tfile.txt\n", stderr: "" };
      }
      if (args[0] === "merge" && args[1] === "--abort") {
        return { code: 128, stdout: "", stderr: "abort failed" };
      }
      if (args[0] === "reset" && args[1] === "--hard") {
        return { code: 128, stdout: "", stderr: "reset failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(ops.mergeBranch("batch", "sha-1", "msg")).rejects.toThrow(
      /worktree is in an unknown state/,
    );
  });

  it("gitOrThrow surfaces stderr on non-merge failures", async () => {
    const { octokit } = makeFakeOctokit();
    const exec: Exec = async (args) => {
      if (args[0] === "push") {
        return { code: 128, stdout: "", stderr: "remote rejected" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await expect(ops.pushBranch("batch")).rejects.toThrow("remote rejected");
  });

  it("fastForwardMain uses refs API with force=false and returns SHA", async () => {
    const { octokit, calls } = makeFakeOctokit([
      { ref: "heads/batch", sha: "abc123" },
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r");
    const sha = await ops.fastForwardMain("batch");
    expect(sha).toBe("abc123");
    expect(calls).toContain("updateRef:heads/main:force=false");
  });

  it("configureGit sets identity and rewrites origin with token auth", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "octo", "repo", { exec });
    await ops.configureGit({
      token: "ghs_secret",
      userEmail: "bot@example.com",
      userName: "queue-bot",
    });
    expect(execCalls).toContainEqual([
      "config",
      "user.email",
      "bot@example.com",
    ]);
    expect(execCalls).toContainEqual(["config", "user.name", "queue-bot"]);
    expect(execCalls).toContainEqual([
      "remote",
      "set-url",
      "origin",
      "https://x-access-token:ghs_secret@github.com/octo/repo.git",
    ]);
  });

  it("configureGit honours a custom serverUrl (GHES)", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await ops.configureGit({
      token: "tok",
      userEmail: "a@b",
      userName: "n",
      serverUrl: "https://ghe.example.com/",
    });
    expect(execCalls).toContainEqual([
      "remote",
      "set-url",
      "origin",
      "https://x-access-token:tok@ghe.example.com/o/r.git",
    ]);
  });

  it("configureGit URL-encodes tokens that contain reserved characters", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    await ops.configureGit({
      token: "tok:with@reserved/chars",
      userEmail: "a@b",
      userName: "n",
    });
    const setUrlCall = execCalls.find(
      (c) => c[0] === "remote" && c[1] === "set-url",
    );
    // The URL must contain the encoded form, not the raw bytes —
    // otherwise the `:` and `@` would corrupt the userinfo segment.
    expect(setUrlCall?.[3]).toBe(
      "https://x-access-token:tok%3Awith%40reserved%2Fchars@github.com/o/r.git",
    );
  });

  it("configureGit redacts the token if `git remote set-url` fails", async () => {
    // Regression guard: `gitOrThrow`'s default error message embeds the
    // command args, which include the token-bearing remote URL. The
    // redaction wrapper in configureGit must rethrow without it.
    const { octokit } = makeFakeOctokit();
    const secret = "ghs_supersecret_value_42";
    const exec: Exec = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return { code: 0, stdout: "origin\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "set-url") {
        return {
          code: 128,
          stdout: "",
          stderr: `fatal: bad URL ${args[3]}`,
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const err = await ops
      .configureGit({
        token: secret,
        userEmail: "a@b",
        userName: "n",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // The secret must not appear anywhere — neither in the wrapper
    // text nor in the underlying detail relayed from `gitOrThrow`.
    expect(msg).not.toContain(secret);
    // But the wrapper must include the underlying cause (with the
    // token-bearing URL redacted) so failures stay diagnosable.
    expect(msg).toContain("origin remote URL");
    expect(msg).toContain("[REDACTED]");
    expect(msg).toContain("fatal: bad URL");
  });

  it("deleteBranch deletes via refs API", async () => {
    const { octokit, calls } = makeFakeOctokit([
      { ref: "heads/batch", sha: "abc" },
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r");
    await ops.deleteBranch("batch");
    expect(calls).toContain("deleteRef:heads/batch");
  });
});

describe("GitOps against a real git repo (integration)", () => {
  let tmp: string;
  let bare: string;
  let work: string;

  async function runIn(cwd: string, ...args: string[]): Promise<string> {
    const res = await defaultExec(cwd)(args);
    if (res.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} in ${cwd} failed: ${res.stderr}`,
      );
    }
    return res.stdout.trim();
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "gitops-"));
    bare = join(tmp, "remote.git");
    work = join(tmp, "work");

    await runIn(tmp, "init", "--bare", "-b", "main", bare);
    await runIn(tmp, "clone", bare, work);
    await runIn(work, "config", "user.email", "test@example.com");
    await runIn(work, "config", "user.name", "Test");
    // Disable any signing inherited from /etc/gitconfig or $HOME — the
    // test must not shell out to a signing hook (some CI sandboxes,
    // incl. the Claude Code sandbox, install one globally).
    await runIn(work, "config", "commit.gpgsign", "false");
    await runIn(work, "config", "tag.gpgsign", "false");
    await runIn(work, "config", "gpg.format", "openpgp");
    writeFileSync(join(work, "seed.txt"), "seed\n");
    await runIn(work, "add", "seed.txt");
    await runIn(work, "commit", "-m", "seed");
    await runIn(work, "push", "origin", "main");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function execInWork(): Exec {
    return defaultExec(work);
  }

  function makeOctokitBackedByBare() {
    // Ref operations backed by the bare remote via direct git commands.
    // This avoids needing to mock the GitHub API for flows that care
    // about on-disk correctness after refs API calls.
    const octokit = {
      rest: {
        git: {
          async getRef({ ref }: { ref: string }) {
            // GitOps passes `heads/<name>` (the REST API shape); the
            // bare repo speaks full refs. Normalize so this isn't
            // relying on `rev-parse`'s shorthand resolution.
            const full = ref.startsWith("refs/") ? ref : `refs/${ref}`;
            const sha = await runIn(bare, "rev-parse", full);
            return { data: { object: { sha } } };
          },
          async createRef({ ref, sha }: { ref: string; sha: string }) {
            await runIn(bare, "update-ref", ref, sha);
            return { data: {} };
          },
          async updateRef({ ref, sha }: { ref: string; sha: string }) {
            await runIn(bare, "update-ref", `refs/${ref}`, sha);
            return { data: {} };
          },
          async deleteRef({ ref }: { ref: string }) {
            await runIn(bare, "update-ref", "-d", `refs/${ref}`);
            return { data: {} };
          },
        },
      },
    };
    return octokit;
  }

  it("merges a clean PR branch end-to-end", async () => {
    // Create a PR branch on the remote with a non-conflicting change.
    await runIn(work, "checkout", "-b", "pr-clean");
    writeFileSync(join(work, "a.txt"), "A\n");
    await runIn(work, "add", "a.txt");
    await runIn(work, "commit", "-m", "add a.txt");
    const prSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-clean");
    await runIn(work, "checkout", "main");

    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(makeOctokitBackedByBare() as any, "o", "r", {
      exec: execInWork(),
    });

    await ops.createBranchFromRef("merge-queue/batch-x", "main");
    const ok = await ops.mergeBranch(
      "merge-queue/batch-x",
      prSha,
      "Merge PR #1: add a",
    );
    expect(ok).toBe(true);
    await ops.pushBranch("merge-queue/batch-x");

    // Confirm the batch branch now exists on the bare and contains a.txt
    const branchSha = await runIn(
      bare,
      "rev-parse",
      "refs/heads/merge-queue/batch-x",
    );
    expect(branchSha).toMatch(/^[0-9a-f]{40}$/);

    // The merge commit subject is part of the action's contract with
    // the README ("Merge PR #N: <title>"). Pin it so refactors can't
    // silently change the format downstream reviewers rely on.
    const subject = await runIn(
      work,
      "log",
      "-1",
      "--format=%s",
      "merge-queue/batch-x",
    );
    expect(subject).toBe("Merge PR #1: add a");
  });

  it("reports conflict (returns false) when merge cannot auto-resolve", async () => {
    // Create two PR branches that touch the same line differently.
    await runIn(work, "checkout", "-b", "pr-a");
    writeFileSync(join(work, "conflict.txt"), "from-a\n");
    await runIn(work, "add", "conflict.txt");
    await runIn(work, "commit", "-m", "a version");
    const aSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-a");

    await runIn(work, "checkout", "main");
    await runIn(work, "checkout", "-b", "pr-b");
    writeFileSync(join(work, "conflict.txt"), "from-b\n");
    await runIn(work, "add", "conflict.txt");
    await runIn(work, "commit", "-m", "b version");
    const bSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-b");
    await runIn(work, "checkout", "main");

    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(makeOctokitBackedByBare() as any, "o", "r", {
      exec: execInWork(),
    });

    await ops.createBranchFromRef("merge-queue/batch-c", "main");
    const ok1 = await ops.mergeBranch(
      "merge-queue/batch-c",
      aSha,
      "Merge PR #1",
    );
    expect(ok1).toBe(true);
    const ok2 = await ops.mergeBranch(
      "merge-queue/batch-c",
      bSha,
      "Merge PR #2",
    );
    expect(ok2).toBe(false);

    // Working tree must be clean after aborting the conflicted merge.
    const status = await runIn(work, "status", "--porcelain");
    expect(status).toBe("");
  });

  it("invokes a custom merge driver registered via git config", async () => {
    // Commit a driver script that concatenates both sides, and a
    // .gitattributes that binds it. This simulates the user-side setup
    // documented in README.
    const driverPath = ".merge-drivers/concat.sh";
    writeFileSync(
      join(work, ".gitattributes"),
      "concatme.txt merge=concat\n",
    );
    // Driver script: read %A and %B, write concatenation to %A.
    const driverFile = join(work, driverPath);
    mkdirSync(join(work, ".merge-drivers"), { recursive: true });
    writeFileSync(
      driverFile,
      "#!/bin/sh\nset -eu\nours=\"$2\"\ntheirs=\"$3\"\ncat \"$ours\" \"$theirs\" > \"$ours.merged\"\nmv \"$ours.merged\" \"$ours\"\nexit 0\n",
    );
    chmodSync(driverFile, 0o755);
    writeFileSync(join(work, "concatme.txt"), "base\n");
    await runIn(work, "add", ".gitattributes", driverPath, "concatme.txt");
    await runIn(work, "commit", "-m", "seed driver + attrs");
    await runIn(work, "push", "origin", "main");

    // Register the driver locally. This is what the user's workflow
    // step would do before the action runs.
    await runIn(
      work,
      "config",
      "merge.concat.driver",
      `./${driverPath} %O %A %B %L %P`,
    );

    // Branch A appends "a".
    await runIn(work, "checkout", "-b", "pr-a");
    writeFileSync(join(work, "concatme.txt"), "base\na\n");
    await runIn(work, "add", "concatme.txt");
    await runIn(work, "commit", "-m", "a");
    const aSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-a");

    // Branch B (diverged from main) appends "b" on the same lines.
    await runIn(work, "checkout", "main");
    await runIn(work, "checkout", "-b", "pr-b");
    writeFileSync(join(work, "concatme.txt"), "base\nb\n");
    await runIn(work, "add", "concatme.txt");
    await runIn(work, "commit", "-m", "b");
    const bSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-b");
    await runIn(work, "checkout", "main");

    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(makeOctokitBackedByBare() as any, "o", "r", {
      exec: execInWork(),
    });

    await ops.createBranchFromRef("merge-queue/batch-drv", "main");
    expect(
      await ops.mergeBranch("merge-queue/batch-drv", aSha, "Merge A"),
    ).toBe(true);
    // Without the driver, this would conflict. With the driver, merge
    // succeeds and concatme.txt contains the driver's output.
    expect(
      await ops.mergeBranch("merge-queue/batch-drv", bSha, "Merge B"),
    ).toBe(true);

    const merged = readFileSync(join(work, "concatme.txt"), "utf8");
    // Driver appended B's version onto A's; exact content depends on
    // which side git passes as %A/%B, but both strings must appear.
    expect(merged).toContain("a");
    expect(merged).toContain("b");
  });

  it("invokes pre-merge-commit hook if it exists", async () => {
    // Create a pre-merge-commit hook that modifies a file that's already
    // part of the merge. This simulates hooks like mdsmith that fix
    // generated sections after all files are merged.
    const hooksDir = join(work, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-merge-commit");
    writeFileSync(
      hookPath,
      "#!/bin/sh\nset -eu\necho 'hook modified' >> base.txt\ngit add base.txt\nexit 0\n",
    );
    chmodSync(hookPath, 0o755);

    // Create a file on main
    writeFileSync(join(work, "base.txt"), "base\n");
    await runIn(work, "add", "base.txt");
    await runIn(work, "commit", "-m", "base");
    await runIn(work, "push", "origin", "main");

    // Create a PR branch that adds a new file
    await runIn(work, "checkout", "-b", "pr-hook-test");
    writeFileSync(join(work, "new.txt"), "content\n");
    await runIn(work, "add", "new.txt");
    await runIn(work, "commit", "-m", "add new file");
    const prSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-hook-test");
    await runIn(work, "checkout", "main");

    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(makeOctokitBackedByBare() as any, "o", "r", {
      exec: execInWork(),
    });

    await ops.createBranchFromRef("merge-queue/batch-hook", "main");
    expect(
      await ops.mergeBranch("merge-queue/batch-hook", prSha, "Merge PR"),
    ).toBe(true);

    // Verify the hook ran by checking that base.txt was modified and
    // the modification was committed
    const baseContent = readFileSync(join(work, "base.txt"), "utf8");
    expect(baseContent).toContain("hook modified");
  });

  it("aborts merge if pre-merge-commit hook fails", async () => {
    // Create a hook that rejects the merge
    const hooksDir = join(work, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-merge-commit");
    writeFileSync(
      hookPath,
      "#!/bin/sh\necho 'hook rejected' >&2\nexit 1\n",
    );
    chmodSync(hookPath, 0o755);

    // Create a file on main
    writeFileSync(join(work, "base.txt"), "base\n");
    await runIn(work, "add", "base.txt");
    await runIn(work, "commit", "-m", "base");
    await runIn(work, "push", "origin", "main");

    // Create a PR branch
    await runIn(work, "checkout", "-b", "pr-reject");
    writeFileSync(join(work, "new.txt"), "content\n");
    await runIn(work, "add", "new.txt");
    await runIn(work, "commit", "-m", "add file");
    const prSha = await runIn(work, "rev-parse", "HEAD");
    await runIn(work, "push", "origin", "pr-reject");
    await runIn(work, "checkout", "main");

    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(makeOctokitBackedByBare() as any, "o", "r", {
      exec: execInWork(),
    });

    await ops.createBranchFromRef("merge-queue/batch-reject", "main");

    // mergeBranch should throw when the hook rejects
    await expect(
      ops.mergeBranch("merge-queue/batch-reject", prSha, "Merge PR"),
    ).rejects.toThrow(/pre-merge-commit hook failed/);

    // Verify the working tree is clean after hook failure
    const status = await runIn(work, "status", "--porcelain");
    expect(status.trim()).toBe("");
  });

  // NOTE: The tests above verify that pre-merge-commit hooks are invoked
  // correctly. The action manually invokes the hook after `git merge
  // --no-commit` completes but before `git commit` runs, because git's
  // pre-merge-commit hook is only invoked when `git merge` creates a
  // commit itself (not when using --no-commit).
  //
  // This integration suite exercises the complete merge flow in a real git
  // repo, and the custom merge driver test verifies that merge drivers work
  // correctly with the two-step merge process. The hook tests verify that
  // hooks like mdsmith's catalog regeneration execute at the right time and
  // can modify files before the final merge commit is created.
});
