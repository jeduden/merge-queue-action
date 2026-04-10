package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/go-github/v68/github"
	"github.com/jeduden/merge-queue-action/internal/queue"
)

// GitHubClient implements queue.GitHubAPI using the GitHub API.
type GitHubClient struct {
	client *github.Client
	owner  string
	repo   string
}

// NewGitHubClient creates a new GitHub API client.
func NewGitHubClient(token string) (*GitHubClient, error) {
	client := github.NewClient(nil).WithAuthToken(token)

	owner, repo, err := getOwnerRepo()
	if err != nil {
		return nil, err
	}

	return &GitHubClient{
		client: client,
		owner:  owner,
		repo:   repo,
	}, nil
}

func getOwnerRepo() (string, string, error) {
	repo := os.Getenv("GITHUB_REPOSITORY")
	if repo == "" {
		return "", "", fmt.Errorf("GITHUB_REPOSITORY environment variable is not set")
	}
	parts := strings.SplitN(repo, "/", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("GITHUB_REPOSITORY %q is not in owner/repo format", repo)
	}
	return parts[0], parts[1], nil
}

func (g *GitHubClient) ListPRsWithLabel(ctx context.Context, label string) ([]queue.PR, error) {
	var result []queue.PR
	opts := &github.PullRequestListOptions{
		State:     "open",
		Sort:      "created",
		Direction: "asc",
		ListOptions: github.ListOptions{
			PerPage: 100,
		},
	}

	for {
		prs, resp, err := g.client.PullRequests.List(ctx, g.owner, g.repo, opts)
		if err != nil {
			return nil, fmt.Errorf("listing PRs: %w", err)
		}

		for _, pr := range prs {
			for _, l := range pr.Labels {
				if l.GetName() == label {
					result = append(result, queue.PR{
						Number:    pr.GetNumber(),
						HeadRef:   pr.GetHead().GetRef(),
						HeadSHA:   pr.GetHead().GetSHA(),
						Title:     pr.GetTitle(),
						CreatedAt: pr.GetCreatedAt().Unix(),
					})
					break
				}
			}
		}

		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}

	return result, nil
}

func (g *GitHubClient) AddLabel(ctx context.Context, prNumber int, label string) error {
	_, _, err := g.client.Issues.AddLabelsToIssue(ctx, g.owner, g.repo, prNumber, []string{label})
	return err
}

func (g *GitHubClient) RemoveLabel(ctx context.Context, prNumber int, label string) error {
	_, err := g.client.Issues.RemoveLabelForIssue(ctx, g.owner, g.repo, prNumber, label)
	return err
}

func (g *GitHubClient) Comment(ctx context.Context, prNumber int, body string) error {
	_, _, err := g.client.Issues.CreateComment(ctx, g.owner, g.repo, prNumber, &github.IssueComment{
		Body: github.Ptr(body),
	})
	return err
}

func (g *GitHubClient) ClosePR(ctx context.Context, prNumber int) error {
	_, _, err := g.client.PullRequests.Edit(ctx, g.owner, g.repo, prNumber, &github.PullRequest{
		State: github.Ptr("closed"),
	})
	return err
}

func (g *GitHubClient) TriggerWorkflow(ctx context.Context, workflowFile string, ref string, inputs map[string]interface{}) error {
	_, err := g.client.Actions.CreateWorkflowDispatchEventByFileName(ctx, g.owner, g.repo, workflowFile, github.CreateWorkflowDispatchEventRequest{
		Ref:    ref,
		Inputs: inputs,
	})
	return err
}

func (g *GitHubClient) GetWorkflowRunStatus(ctx context.Context, workflowFile string, ref string) (string, error) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for i := 0; i < 360; i++ {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
		}

		runs, _, err := g.client.Actions.ListWorkflowRunsByFileName(ctx, g.owner, g.repo, workflowFile, &github.ListWorkflowRunsOptions{
			Branch: ref,
			ListOptions: github.ListOptions{
				PerPage: 1,
			},
		})
		if err != nil {
			return "", fmt.Errorf("listing workflow runs: %w", err)
		}

		if len(runs.WorkflowRuns) == 0 {
			continue
		}

		run := runs.WorkflowRuns[0]
		if run.GetStatus() == "completed" {
			return run.GetConclusion(), nil
		}
	}

	return "", fmt.Errorf("timed out waiting for workflow run")
}

func (g *GitHubClient) CreateLabel(ctx context.Context, name string, color string, description string) error {
	_, _, err := g.client.Issues.CreateLabel(ctx, g.owner, g.repo, &github.Label{
		Name:        github.Ptr(name),
		Color:       github.Ptr(color),
		Description: github.Ptr(description),
	})
	return err
}
