import * as core from "@actions/core";
import * as github from "@actions/github";
import { GitHubClient } from "./github.js";
import { GitOps } from "./gitops.js";
import { runProcess, runBisect, type Config } from "./action.js";
import type { CommentCtx } from "./comments.js";

interface EntryInputs {
  token: string;
  ciWorkflow: string;
  batchSize: number;
  queueLabel: string;
  dryRun: boolean;
  batchPrs: string;
  bisect: boolean;
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
  const { owner, repo } = github.context.repo;
  const log = core.info;
  const client = new GitHubClient(inputs.token, owner, repo, log);
  const gitOps = new GitOps(client.octokit, owner, repo, log);
  log(
    `Repository context: ${owner}/${repo} (GITHUB_REPOSITORY=${process.env.GITHUB_REPOSITORY ?? "unset"})`,
  );
  log(
    `Queue label: "${inputs.queueLabel}" batchSize=${inputs.batchSize} dryRun=${inputs.dryRun} bisect=${inputs.bisect}`,
  );
  const actor = process.env.GITHUB_ACTOR;

  const cfg: Config = {
    ciWorkflow: inputs.ciWorkflow,
    batchSize: inputs.batchSize,
    queueLabel: inputs.queueLabel,
    dryRun: inputs.dryRun,
    batchPrs: inputs.batchPrs,
    commentCtx: buildCommentCtx(owner, repo, inputs.queueLabel),
  };

  if (inputs.bisect) {
    await runBisect(client, gitOps, cfg, log);
  } else {
    await runProcess(client, gitOps, cfg, log, actor);
  }
}

run().catch((err) =>
  core.setFailed(err instanceof Error ? err.message : String(err)),
);
