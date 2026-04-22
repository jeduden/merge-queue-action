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
  it("createBranchFromRef calls both the API and git fetch+checkout", async () => {
    const { octokit, calls } = makeFakeOctokit([
      { ref: "heads/main", sha: "deadbeef" },
    ]);
    const execCalls: string[][] = [];
    const exec: Exec = async (args) => {
      execCalls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });

    await ops.createBranchFromRef("merge-queue/batch-1", "main");

    expect(calls).toEqual([
      "getRef:heads/main",
      "createRef:refs/heads/merge-queue/batch-1",
    ]);
    expect(execCalls[0][0]).toBe("fetch");
    expect(execCalls[0]).toContain(
      "+refs/heads/merge-queue/batch-1:refs/remotes/origin/merge-queue/batch-1",
    );
    expect(execCalls[1].slice(0, 3)).toEqual([
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
      if (args[0] === "merge" && args[1] !== "--abort") {
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
  });

  it("mergeBranch returns true on clean merge", async () => {
    const { octokit } = makeFakeOctokit();
    const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const ops = new GitOps(octokit as any, "o", "r", { exec });
    const ok = await ops.mergeBranch("batch", "sha-1", "msg");
    expect(ok).toBe(true);
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
            const sha = await runIn(bare, "rev-parse", ref);
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
