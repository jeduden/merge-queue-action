package batch

import (
	"context"
	"fmt"
)

// GitOperator defines the interface for git operations.
type GitOperator interface {
	// CreateBranchFromRef creates a new branch from the given ref (e.g., "main").
	CreateBranchFromRef(ctx context.Context, branch string, baseRef string) error

	// MergeBranch merges a source branch into the current branch.
	// Returns false if there is a merge conflict.
	MergeBranch(ctx context.Context, branch string, sourceBranch string, commitMsg string) (bool, error)

	// PushBranch pushes a branch to the remote.
	PushBranch(ctx context.Context, branch string) error

	// FastForwardMain fast-forwards the main branch to the given ref.
	FastForwardMain(ctx context.Context, ref string) error

	// DeleteBranch deletes a remote branch.
	DeleteBranch(ctx context.Context, branch string) error
}

// PR holds the minimal info needed for batch operations.
type PR struct {
	Number  int
	HeadRef string
	Title   string
}

// Batch manages batch branch creation and merging.
type Batch struct {
	git    GitOperator
	dryRun bool
	log    func(string, ...any)
}

// New creates a new Batch operator. If logFunc is nil, logging is silently discarded.
func New(git GitOperator, dryRun bool, logFunc func(string, ...any)) *Batch {
	if logFunc == nil {
		logFunc = func(string, ...any) {}
	}
	return &Batch{
		git:    git,
		dryRun: dryRun,
		log:    logFunc,
	}
}

// MergeResult describes the outcome of merging PRs into a batch branch.
type MergeResult struct {
	Branch     string
	Merged     []PR // PRs that were successfully merged
	Conflicted []PR // PRs that had merge conflicts
}

// CreateAndMerge creates a batch branch from main and merges each PR into it.
// PRs that conflict are recorded in the result but do not stop the process.
func (b *Batch) CreateAndMerge(ctx context.Context, batchID string, prs []PR) (*MergeResult, error) {
	branch := fmt.Sprintf("merge-queue/batch-%s", batchID)
	result := &MergeResult{Branch: branch}

	b.log("Creating batch branch %s from main", branch)
	if !b.dryRun {
		if err := b.git.CreateBranchFromRef(ctx, branch, "main"); err != nil {
			return nil, fmt.Errorf("creating batch branch: %w", err)
		}
	}

	for _, pr := range prs {
		b.log("Merging PR #%d (%s) into %s", pr.Number, pr.HeadRef, branch)
		if b.dryRun {
			result.Merged = append(result.Merged, pr)
			continue
		}

		msg := fmt.Sprintf("Merge PR #%d: %s", pr.Number, pr.Title)
		ok, err := b.git.MergeBranch(ctx, branch, pr.HeadRef, msg)
		if err != nil {
			// Best-effort cleanup of the batch branch
			if delErr := b.git.DeleteBranch(ctx, branch); delErr != nil {
				b.log("Warning: failed to delete batch branch %s: %v", branch, delErr)
			}
			return nil, fmt.Errorf("merging PR #%d: %w", pr.Number, err)
		}
		if !ok {
			result.Conflicted = append(result.Conflicted, pr)
			continue
		}
		result.Merged = append(result.Merged, pr)
	}

	if len(result.Merged) > 0 && !b.dryRun {
		b.log("Pushing batch branch %s", branch)
		if err := b.git.PushBranch(ctx, branch); err != nil {
			return nil, fmt.Errorf("pushing batch branch: %w", err)
		}
	}

	return result, nil
}

// CompleteMerge fast-forwards main to the batch branch and cleans up.
func (b *Batch) CompleteMerge(ctx context.Context, branch string) error {
	b.log("Fast-forwarding main to %s", branch)
	if b.dryRun {
		return nil
	}
	if err := b.git.FastForwardMain(ctx, branch); err != nil {
		return fmt.Errorf("fast-forwarding main: %w", err)
	}
	b.log("Deleting batch branch %s", branch)
	if err := b.git.DeleteBranch(ctx, branch); err != nil {
		return fmt.Errorf("deleting batch branch: %w", err)
	}
	return nil
}
