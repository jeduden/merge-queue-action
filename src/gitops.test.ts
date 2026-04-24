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

  it("mergeBranch returns false and cleans up on conflict exit code", async () => {
    const { octokit } = makeFakeOctokit();
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      // Real merge invocation carries `-c commit.gpgsign=false` before
      // the `merge` subcommand; abort is a bare `["merge", "--abort"]`.
      const mergeIdx = args.indexOf("merge");
      if (mergeIdx >= 0 && args[mergeIdx + 1] !== "--abort") {
        return { code: 1, stdout: "", stderr: "CONFLICT (content)" };
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

  it("mergeBranch returns true on clean merge", async () => {
    const { octokit } = makeFakeOctokit();
    const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(true);
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
        return { code: 1, stdout: "", stderr: "CONFLICT (content)" };
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
});
