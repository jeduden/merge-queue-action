package main

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/go-github/v68/github"
)

// GitOps implements batch.GitOperator using the GitHub API.
// All operations are server-side — no local git binary required.
type GitOps struct {
	client *github.Client
	owner  string
	repo   string
	log    func(string, ...any)
}

// NewGitOps creates a new GitOps backed by the GitHub API.
func NewGitOps(client *github.Client, owner, repo string, logFunc func(string, ...any)) *GitOps {
	return &GitOps{
		client: client,
		owner:  owner,
		repo:   repo,
		log:    logFunc,
	}
}

func (g *GitOps) CreateBranchFromRef(ctx context.Context, branch string, baseRef string) error {
	g.log("Creating branch %s from %s", branch, baseRef)

	// Get the SHA of the base ref
	ref, _, err := g.client.Git.GetRef(ctx, g.owner, g.repo, "heads/"+baseRef)
	if err != nil {
		return fmt.Errorf("getting ref %s: %w", baseRef, err)
	}
	sha := ref.GetObject().GetSHA()

	// Create the new branch
	_, _, err = g.client.Git.CreateRef(ctx, g.owner, g.repo, &github.Reference{
		Ref:    github.Ptr("refs/heads/" + branch),
		Object: &github.GitObject{SHA: github.Ptr(sha)},
	})
	if err != nil {
		return fmt.Errorf("creating branch %s: %w", branch, err)
	}
	return nil
}

func (g *GitOps) MergeBranch(ctx context.Context, branch string, sourceBranch string, commitMsg string) (bool, error) {
	g.log("Merging %s into %s", sourceBranch, branch)

	_, resp, err := g.client.Repositories.Merge(ctx, g.owner, g.repo, &github.RepositoryMergeRequest{
		Base:          github.Ptr(branch),
		Head:          github.Ptr(sourceBranch),
		CommitMessage: github.Ptr(commitMsg),
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusConflict {
			return false, nil
		}
		return false, fmt.Errorf("merging %s into %s: %w", sourceBranch, branch, err)
	}
	return true, nil
}

func (g *GitOps) PushBranch(_ context.Context, branch string) error {
	// Server-side merges are already pushed — nothing to do
	g.log("Branch %s already up to date on remote", branch)
	return nil
}

func (g *GitOps) FastForwardMain(ctx context.Context, ref string) error {
	g.log("Fast-forwarding main to %s", ref)

	// Get the SHA of the source ref
	srcRef, _, err := g.client.Git.GetRef(ctx, g.owner, g.repo, "heads/"+ref)
	if err != nil {
		return fmt.Errorf("getting ref %s: %w", ref, err)
	}
	sha := srcRef.GetObject().GetSHA()

	// Update main to point to the same SHA
	_, _, err = g.client.Git.UpdateRef(ctx, g.owner, g.repo, &github.Reference{
		Ref:    github.Ptr("refs/heads/main"),
		Object: &github.GitObject{SHA: github.Ptr(sha)},
	}, false)
	if err != nil {
		return fmt.Errorf("updating main to %s: %w", sha, err)
	}
	return nil
}

func (g *GitOps) DeleteBranch(ctx context.Context, branch string) error {
	g.log("Deleting branch %s", branch)
	_, err := g.client.Git.DeleteRef(ctx, g.owner, g.repo, "heads/"+branch)
	if err != nil {
		return fmt.Errorf("deleting branch %s: %w", branch, err)
	}
	return nil
}
