import * as core from "@actions/core";
import * as github from "@actions/github";
import { GitHubClient } from "./github.js";
import { GitOps } from "./gitops.js";
import { PRReporter } from "./reporter.js";
import {
  hasWritePermission,
  runProcess,
  runBisect,
  type Config,
} from "./action.js";
import type { CommentCtx } from "./comments.js";

interface EntryInputs {
  token: string;
  ciWorkflow: string;
  batchSize: number;
  queueLabel: string;
  dryRun: boolean;
  batchPrs: string;
  bisect: boolean;
  gitUserEmail: string;
  gitUserName: string;
}

function loadInputs(): EntryInputs {
  return {
    token: core.getInput("token", { required: true }),
    ciWorkflow: core.getInput("ci_workflow", { required: true }),
    batchSize: parseInt(core.getInput("batch_size") || "5", 10),
    queueLabel: core.getInput("queue_label") || "queue",
    dryRun: core.getInput("dry_run") === "true",
    batchPrs: core.getInput("batch_prs") || "",
    bisect: core.getInput("bisect") === "true",
    gitUserEmail:
      core.getInput("git_user_email") ||
      "merge-queue@users.noreply.github.com",
    gitUserName: core.getInput("git_user_name") || "merge-queue-bot",
  };
}

function buildCommentCtx(
  owner: string,
  repo: string,
  queueLabel: string,
): CommentCtx {
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const ownerRepo =
    process.env.GITHUB_REPOSITORY || `${owner}/${repo}`;
  const runId = process.env.GITHUB_RUN_ID || "";
  const actionRunUrl = runId
    ? `${serverUrl}/${ownerRepo}/actions/runs/${runId}`
    : `${serverUrl}/${ownerRepo}/actions`;
  return { serverUrl, ownerRepo, actionRunUrl, queueLabel };
}

async function run(): Promise<void> {
  const inputs = loadInputs();
  // Register the merge-queue token as a secret immediately so it is
  // masked in any subsequent log line, error message, or failure
  // emitted by downstream code (git, octokit, reporter). `getInput`
  // does not register secrets automatically — only inputs sourced
  // from `secrets.*` are pre-masked by the runner — so we set it
  // explicitly to defend against a workflow that passes the token
  // via `env:` or similar. Also mask the URL-encoded form because
  // `configureGit` embeds `encodeURIComponent(token)` in the remote
  // URL, and a token with reserved characters would render in git
  // stderr in its encoded form rather than its raw form.
  if (inputs.token) {
    core.setSecret(inputs.token);
    const encoded = encodeURIComponent(inputs.token);
    if (encoded !== inputs.token) core.setSecret(encoded);
  }
  const { owner, repo } = github.context.repo;
  const log = core.info;
  const client = new GitHubClient(inputs.token, owner, repo, log);
  const commentCtx = buildCommentCtx(owner, repo, inputs.queueLabel);
  const reporter = new PRReporter({
    poster: client,
    ctx: commentCtx,
    log,
    dryRun: inputs.dryRun,
  });
  const gitOps = new GitOps(client.octokit, owner, repo, { log, reporter });
  log(
    `Repository context: ${owner}/${repo} (GITHUB_REPOSITORY=${process.env.GITHUB_REPOSITORY ?? "unset"})`,
  );
  log(
    `Queue label: "${inputs.queueLabel}" batchSize=${inputs.batchSize} dryRun=${inputs.dryRun} bisect=${inputs.bisect}`,
  );
  const actor = process.env.GITHUB_ACTOR;

  // Pre-flight actor permission check. `runProcess` re-checks this as
  // defense in depth, but doing it here lets us short-circuit before
  // mutating the worktree via `configureGit`. Skipped in `bisect`
  // mode because the entry point for bisect is `workflow_dispatch`,
  // which is already restricted by repo settings.
  if (!inputs.bisect && actor) {
    const perm = await client.getActorPermission(actor);
    if (!hasWritePermission(perm)) {
      log(
        `Actor ${actor} has "${perm}" permission, write or above required — skipping`,
      );
      return;
    }
  }

  const cfg: Config = {
    ciWorkflow: inputs.ciWorkflow,
    batchSize: inputs.batchSize,
    queueLabel: inputs.queueLabel,
    dryRun: inputs.dryRun,
    batchPrs: inputs.batchPrs,
    commentCtx,
  };

  // Configure git identity and rewrite the `origin` remote to embed
  // the merge-queue token. Done here (not in the user's workflow) so
  // consumers only need an `actions/checkout` step before this action.
  // Skipped in `dry_run` so the contract "log intent without mutating"
  // also holds for `.git/config`.
  if (!inputs.dryRun) {
    await gitOps.configureGit({
      token: inputs.token,
      userEmail: inputs.gitUserEmail,
      userName: inputs.gitUserName,
      serverUrl: process.env.GITHUB_SERVER_URL,
    });
  } else {
    log("dry_run enabled — skipping git identity/remote configuration");
  }

  if (inputs.bisect) {
    await runBisect(client, gitOps, cfg, log, reporter);
  } else {
    await runProcess(client, gitOps, cfg, log, actor, reporter);
  }
}

run().catch((err) =>
  core.setFailed(err instanceof Error ? err.message : String(err)),
);
