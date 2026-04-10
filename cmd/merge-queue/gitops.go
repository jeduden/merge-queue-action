package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// GitOps implements batch.GitOperator by shelling out to git CLI.
type GitOps struct {
	dryRun bool
	log    func(string, ...any)
}

// NewGitOps creates a new GitOps.
func NewGitOps(dryRun bool, logFunc func(string, ...any)) *GitOps {
	return &GitOps{
		dryRun: dryRun,
		log:    logFunc,
	}
}

func (g *GitOps) run(ctx context.Context, args ...string) (string, error) {
	g.log("git %s", strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, "git", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %s: %w", strings.Join(args, " "), string(out), err)
	}
	return string(out), nil
}

func (g *GitOps) CreateBranchFromRef(ctx context.Context, branch string, baseRef string) error {
	// Fetch latest base ref
	if _, err := g.run(ctx, "fetch", "origin", baseRef); err != nil {
		return err
	}
	// Create branch from the base ref
	if _, err := g.run(ctx, "checkout", "-b", branch, "origin/"+baseRef); err != nil {
		return err
	}
	return nil
}

func (g *GitOps) MergeBranch(ctx context.Context, branch string, sourceBranch string, commitMsg string) (bool, error) {
	// Ensure we're on the target branch
	if _, err := g.run(ctx, "checkout", branch); err != nil {
		return false, err
	}
	// Fetch the source branch
	if _, err := g.run(ctx, "fetch", "origin", sourceBranch); err != nil {
		return false, err
	}
	// Attempt merge
	_, err := g.run(ctx, "merge", "--no-ff", "-m", commitMsg, "origin/"+sourceBranch)
	if err != nil {
		// Check if it's a merge conflict
		if _, abortErr := g.run(ctx, "merge", "--abort"); abortErr == nil {
			return false, nil // conflict, successfully aborted
		}
		return false, err
	}
	return true, nil
}

func (g *GitOps) PushBranch(ctx context.Context, branch string) error {
	_, err := g.run(ctx, "push", "origin", branch)
	return err
}

func (g *GitOps) FastForwardMain(ctx context.Context, ref string) error {
	if _, err := g.run(ctx, "checkout", "main"); err != nil {
		return err
	}
	if _, err := g.run(ctx, "merge", "--ff-only", ref); err != nil {
		return err
	}
	if _, err := g.run(ctx, "push", "origin", "main"); err != nil {
		return err
	}
	return nil
}

func (g *GitOps) DeleteBranch(ctx context.Context, branch string) error {
	_, err := g.run(ctx, "push", "origin", "--delete", branch)
	return err
}
