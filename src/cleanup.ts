// Post-step cleanup for the merge-queue action.
//
// `configureGit` rewrites `origin` to an `https://x-access-token:<token>@…`
// URL so merges and pushes authenticate with the merge-queue token. That
// URL lives in `.git/config` for the rest of the job — actions/checkout's
// own post cleanup removes only the credentials IT configured — so any
// step running after this action could read the high-privilege token.
// This post hook (wired via `post:` in action.yml, runs even when the
// main step failed) resets `origin` to the token-less URL.
//
// Deliberately dependency-free and best-effort: a cleanup failure must
// never fail the job, and the runner is ephemeral anyway — this just
// closes the same-job window.
import { spawnSync } from "node:child_process";

/** Token-less origin URL for the current repository. */
export function tokenlessOriginUrl(
  serverUrl: string | undefined,
  repository: string | undefined,
): string | undefined {
  if (!repository) return undefined;
  const server = serverUrl || "https://github.com";
  return `${server.replace(/\/+$/, "")}/${repository}.git`;
}

function run(): void {
  const url = tokenlessOriginUrl(
    process.env.GITHUB_SERVER_URL,
    process.env.GITHUB_REPOSITORY,
  );
  if (!url) {
    console.log("cleanup: GITHUB_REPOSITORY not set; nothing to scrub");
    return;
  }
  const inside = spawnSync(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    console.log("cleanup: no git worktree; nothing to scrub");
    return;
  }
  const result = spawnSync("git", ["remote", "set-url", "origin", url], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    console.log(`cleanup: reset origin to token-less URL (${url})`);
  } else {
    // Best-effort: log and exit 0 so the post step never fails the job.
    console.log(
      `cleanup: failed to reset origin (exit ${result.status}): ${(result.stderr || "").trim()}`,
    );
  }
}

// Only execute when running as the action's post step — importing this
// module from tests must not touch git.
if (process.env.GITHUB_ACTIONS === "true") {
  run();
}
