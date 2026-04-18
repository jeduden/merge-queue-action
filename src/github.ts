import * as github from "@actions/github";
import type {
  PR,
  GitHubAPI,
  WorkflowAPI,
  WorkflowRunHandle,
  WorkflowRunResult,
} from "./queue.js";

type Octokit = ReturnType<typeof github.getOctokit>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GitHubClient implements GitHubAPI and WorkflowAPI using the GitHub REST API. */
export class GitHubClient implements GitHubAPI, WorkflowAPI {
  public readonly octokit: Octokit;
  public readonly owner: string;
  public readonly repo: string;

  constructor(token: string, owner: string, repo: string) {
    this.octokit = github.getOctokit(token);
    this.owner = owner;
    this.repo = repo;
  }

  async listPRsWithLabel(label: string, limit: number): Promise<PR[]> {
    const result: PR[] = [];
    let page = 1;

    for (;;) {
      const { data: issues } =
        await this.octokit.rest.issues.listForRepo({
          owner: this.owner,
          repo: this.repo,
          state: "open",
          labels: label,
          sort: "created",
          direction: "asc",
          per_page: 100,
          page,
        });

      for (const issue of issues) {
        if (!issue.pull_request) continue;

        const { data: pr } = await this.octokit.rest.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: issue.number,
        });

        const headRef = pr.head.label || pr.head.ref;
        result.push({
          number: pr.number,
          headRef,
          headSHA: pr.head.sha,
          title: pr.title,
          createdAt: Math.floor(
            new Date(pr.created_at).getTime() / 1000,
          ),
        });

        if (limit > 0 && result.length >= limit) return result;
      }

      if (issues.length < 100) break;
      page++;
    }

    return result;
  }

  async addLabel(prNumber: number, label: string): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      labels: [label],
    });
  }

  async removeLabel(prNumber: number, label: string): Promise<void> {
    await this.octokit.rest.issues.removeLabel({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      name: label,
    });
  }

  async comment(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    });
  }

  async createLabel(
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    await this.octokit.rest.issues.createLabel({
      owner: this.owner,
      repo: this.repo,
      name,
      color,
      description,
    });
  }

  async triggerWorkflow(
    workflowFile: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void> {
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner: this.owner,
      repo: this.repo,
      workflow_id: workflowFile,
      ref,
      inputs,
    });
  }

  async findWorkflowRun(
    workflowFile: string,
    ref: string,
    dispatchedAt: Date,
  ): Promise<WorkflowRunHandle> {
    const createdAfter = new Date(dispatchedAt.getTime() - 5000);

    // Poll up to ~10 min for the run to appear. Check immediately first,
    // then sleep between attempts so we can post the "CI running" comment
    // the moment GitHub registers the dispatched run.
    for (let i = 0; i < 60; i++) {
      const { data: runs } =
        await this.octokit.rest.actions.listWorkflowRuns({
          owner: this.owner,
          repo: this.repo,
          workflow_id: workflowFile,
          branch: ref,
          event: "workflow_dispatch",
          created: `>=${createdAfter.toISOString()}`,
          per_page: 1,
        });

      if (runs.workflow_runs.length > 0) {
        const run = runs.workflow_runs[0];
        return { runId: run.id, htmlUrl: run.html_url };
      }

      await sleep(10_000);
    }

    throw new Error("timed out waiting for workflow run to appear");
  }

  async waitForWorkflowRun(runId: number): Promise<WorkflowRunResult> {
    // Poll up to ~1h for completion.
    for (let i = 0; i < 360; i++) {
      const { data: run } = await this.octokit.rest.actions.getWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
      });

      if (run.status === "completed") {
        return {
          conclusion: run.conclusion ?? "unknown",
          htmlUrl: run.html_url,
        };
      }

      await sleep(10_000);
    }

    throw new Error("timed out waiting for workflow run to complete");
  }

  async closePR(prNumber: number): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      state: "closed",
    });
  }

  async getPR(prNumber: number): Promise<PR> {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    const headRef = pr.head.label || pr.head.ref;
    return {
      number: pr.number,
      headRef,
      headSHA: pr.head.sha,
      title: pr.title,
      createdAt: Math.floor(new Date(pr.created_at).getTime() / 1000),
    };
  }

  async getActorPermission(username: string): Promise<string> {
    try {
      const { data } =
        await this.octokit.rest.repos.getCollaboratorPermissionLevel({
          owner: this.owner,
          repo: this.repo,
          username,
        });
      return data.permission;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 403) return "none";
      throw err;
    }
  }
}
