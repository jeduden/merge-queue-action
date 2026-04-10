package batch

import (
	"context"
	"fmt"
	"testing"
)

type mockGit struct {
	branches      []string
	merges        []string
	pushed        []string
	ffRef         string
	deleted       []string
	conflictOn    string // HeadRef that will conflict
	failOn        string // method name to fail on
}

func (m *mockGit) CreateBranchFromRef(_ context.Context, branch string, _ string) error {
	if m.failOn == "CreateBranchFromRef" {
		return fmt.Errorf("mock error")
	}
	m.branches = append(m.branches, branch)
	return nil
}

func (m *mockGit) MergeBranch(_ context.Context, _ string, sourceBranch string, _ string) (bool, error) {
	if m.failOn == "MergeBranch" {
		return false, fmt.Errorf("mock error")
	}
	if sourceBranch == m.conflictOn {
		return false, nil
	}
	m.merges = append(m.merges, sourceBranch)
	return true, nil
}

func (m *mockGit) PushBranch(_ context.Context, branch string) error {
	if m.failOn == "PushBranch" {
		return fmt.Errorf("mock error")
	}
	m.pushed = append(m.pushed, branch)
	return nil
}

func (m *mockGit) FastForwardMain(_ context.Context, ref string) error {
	if m.failOn == "FastForwardMain" {
		return fmt.Errorf("mock error")
	}
	m.ffRef = ref
	return nil
}

func (m *mockGit) DeleteBranch(_ context.Context, branch string) error {
	if m.failOn == "DeleteBranch" {
		return fmt.Errorf("mock error")
	}
	m.deleted = append(m.deleted, branch)
	return nil
}

func nopLog(string, ...any) {}

func TestCreateAndMerge_AllSuccess(t *testing.T) {
	git := &mockGit{}
	b := New(git, false, nopLog)
	prs := []PR{
		{Number: 1, HeadRef: "feature-a", Title: "Add feature A"},
		{Number: 2, HeadRef: "feature-b", Title: "Add feature B"},
	}

	result, err := b.CreateAndMerge(context.Background(), "test-1", prs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Branch != "merge-queue/batch-test-1" {
		t.Errorf("branch = %q, want %q", result.Branch, "merge-queue/batch-test-1")
	}
	if len(result.Merged) != 2 {
		t.Errorf("merged %d PRs, want 2", len(result.Merged))
	}
	if len(result.Conflicted) != 0 {
		t.Errorf("conflicted %d PRs, want 0", len(result.Conflicted))
	}
	if len(git.branches) != 1 || git.branches[0] != "merge-queue/batch-test-1" {
		t.Errorf("branches = %v", git.branches)
	}
	if len(git.merges) != 2 {
		t.Errorf("merges = %v", git.merges)
	}
	if len(git.pushed) != 1 {
		t.Errorf("pushed = %v", git.pushed)
	}
}

func TestCreateAndMerge_WithConflict(t *testing.T) {
	git := &mockGit{conflictOn: "feature-b"}
	b := New(git, false, nopLog)
	prs := []PR{
		{Number: 1, HeadRef: "feature-a", Title: "A"},
		{Number: 2, HeadRef: "feature-b", Title: "B"},
		{Number: 3, HeadRef: "feature-c", Title: "C"},
	}

	result, err := b.CreateAndMerge(context.Background(), "test-2", prs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(result.Merged) != 2 {
		t.Errorf("merged %d PRs, want 2", len(result.Merged))
	}
	if len(result.Conflicted) != 1 {
		t.Fatalf("conflicted %d PRs, want 1", len(result.Conflicted))
	}
	if result.Conflicted[0].Number != 2 {
		t.Errorf("conflicted PR = #%d, want #2", result.Conflicted[0].Number)
	}
}

func TestCreateAndMerge_DryRun(t *testing.T) {
	git := &mockGit{}
	b := New(git, true, nopLog)
	prs := []PR{{Number: 1, HeadRef: "feature-a", Title: "A"}}

	result, err := b.CreateAndMerge(context.Background(), "dry", prs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(result.Merged) != 1 {
		t.Errorf("expected 1 merged in dry run")
	}
	if len(git.branches) != 0 {
		t.Errorf("dry run should not create branches")
	}
	if len(git.pushed) != 0 {
		t.Errorf("dry run should not push")
	}
}

func TestCreateAndMerge_CreateBranchError(t *testing.T) {
	git := &mockGit{failOn: "CreateBranchFromRef"}
	b := New(git, false, nopLog)
	_, err := b.CreateAndMerge(context.Background(), "err", []PR{{Number: 1, HeadRef: "f", Title: "T"}})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestCreateAndMerge_NoPRs(t *testing.T) {
	git := &mockGit{}
	b := New(git, false, nopLog)
	result, err := b.CreateAndMerge(context.Background(), "empty", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Merged) != 0 {
		t.Errorf("expected no merged PRs")
	}
	// Should still create the branch but not push (no merged PRs)
	if len(git.pushed) != 0 {
		t.Errorf("should not push with no merged PRs")
	}
}

func TestCompleteMerge(t *testing.T) {
	git := &mockGit{}
	b := New(git, false, nopLog)
	err := b.CompleteMerge(context.Background(), "merge-queue/batch-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if git.ffRef != "merge-queue/batch-1" {
		t.Errorf("ffRef = %q", git.ffRef)
	}
	if len(git.deleted) != 1 || git.deleted[0] != "merge-queue/batch-1" {
		t.Errorf("deleted = %v", git.deleted)
	}
}

func TestCompleteMerge_DryRun(t *testing.T) {
	git := &mockGit{}
	b := New(git, true, nopLog)
	err := b.CompleteMerge(context.Background(), "merge-queue/batch-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if git.ffRef != "" {
		t.Errorf("dry run should not fast-forward")
	}
}

func TestCompleteMerge_FFError(t *testing.T) {
	git := &mockGit{failOn: "FastForwardMain"}
	b := New(git, false, nopLog)
	err := b.CompleteMerge(context.Background(), "merge-queue/batch-1")
	if err == nil {
		t.Fatal("expected error")
	}
}
