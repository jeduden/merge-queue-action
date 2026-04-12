import * as core from "@actions/core";
import * as github from "@actions/github";
import { GitHubClient } from "./github.js";
import { GitOps } from "./gitops.js";
import { runProcess, runBisect } from "./action.js";

interface EntryConfig {
  token: string;
  ciWorkflow: string;
  batchSize: number;
  queueLabel: string;
  dryRun: boolean;
  batchPrs: string;
  bisect: boolean;
}

function loadConfig(): EntryConfig {
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

async function run(): Promise<void> {
  const cfg = loadConfig();
  const { owner, repo } = github.context.repo;
  const client = new GitHubClient(cfg.token, owner, repo);
  const gitOps = new GitOps(client.octokit, owner, repo, core.info);
  const log = core.info;
  const actor = process.env.GITHUB_ACTOR;

  if (cfg.bisect) {
    await runBisect(client, gitOps, cfg, log);
  } else {
    await runProcess(client, gitOps, cfg, log, actor);
  }
}

run().catch((err) =>
  core.setFailed(err instanceof Error ? err.message : String(err)),
);
