package queue

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// PR represents a pull request in the merge queue.
type PR struct {
	Number    int
	HeadRef   string
	HeadSHA   string
	Title     string
	CreatedAt int64 // unix timestamp for ordering
}

// LabelState represents the lifecycle of a PR in the queue.
type LabelState string

const (
	StatePending LabelState = ""       // just the queue label
	StateActive  LabelState = "active" // being processed
	StateFailed  LabelState = "failed" // CI failed or conflict
)

// QueueLabel returns the full label string for a given state.
func QueueLabel(base string, state LabelState) string {
	if state == StatePending {
		return base
	}
	return fmt.Sprintf("%s:%s", base, string(state))
}

// GitHubAPI defines the interface for GitHub operations needed by the queue.
type GitHubAPI interface {
	// ListPRsWithLabel returns open PRs that have the given label, oldest first.
	ListPRsWithLabel(ctx context.Context, label string) ([]PR, error)

	// AddLabel adds a label to a PR.
	AddLabel(ctx context.Context, prNumber int, label string) error

	// RemoveLabel removes a label from a PR.
	RemoveLabel(ctx context.Context, prNumber int, label string) error

	// Comment posts a comment on a PR.
	Comment(ctx context.Context, prNumber int, body string) error

	// CreateLabel creates a label in the repository.
	CreateLabel(ctx context.Context, name string, color string, description string) error
}

// WorkflowAPI defines the interface for workflow dispatch and polling.
// Kept separate from GitHubAPI to reduce coupling — the queue package
// does not use these methods.
type WorkflowAPI interface {
	// TriggerWorkflow dispatches a workflow.
	TriggerWorkflow(ctx context.Context, workflowFile string, ref string, inputs map[string]interface{}) error

	// GetWorkflowRunStatus polls for the latest run of a workflow on a ref
	// created after dispatchedAt and returns its conclusion.
	GetWorkflowRunStatus(ctx context.Context, workflowFile string, ref string, dispatchedAt time.Time) (conclusion string, err error)

	// ClosePR closes a pull request.
	ClosePR(ctx context.Context, prNumber int) error
}

// Queue manages the merge queue state machine.
type Queue struct {
	api      GitHubAPI
	label    string
	dryRun   bool
	logFunc  func(string, ...any)
}

// New creates a new Queue.
func New(api GitHubAPI, label string, dryRun bool, logFunc func(string, ...any)) *Queue {
	return &Queue{
		api:     api,
		label:   label,
		dryRun:  dryRun,
		logFunc: logFunc,
	}
}

// Collect returns open PRs with the queue label, sorted oldest first.
func (q *Queue) Collect(ctx context.Context) ([]PR, error) {
	prs, err := q.api.ListPRsWithLabel(ctx, q.label)
	if err != nil {
		return nil, fmt.Errorf("listing queued PRs: %w", err)
	}
	sort.Slice(prs, func(i, j int) bool {
		return prs[i].CreatedAt < prs[j].CreatedAt
	})
	return prs, nil
}

// Activate transitions PRs from pending to active state.
func (q *Queue) Activate(ctx context.Context, prs []PR) error {
	for _, pr := range prs {
		q.logFunc("Activating PR #%d", pr.Number)
		if q.dryRun {
			continue
		}
		if err := q.api.AddLabel(ctx, pr.Number, QueueLabel(q.label, StateActive)); err != nil {
			return fmt.Errorf("adding active label to #%d: %w", pr.Number, err)
		}
		if err := q.api.RemoveLabel(ctx, pr.Number, QueueLabel(q.label, StatePending)); err != nil && !isNotFoundError(err) {
			return fmt.Errorf("removing pending label from #%d: %w", pr.Number, err)
		}
	}
	return nil
}

// MarkFailed transitions a PR to the failed state and posts a comment.
func (q *Queue) MarkFailed(ctx context.Context, pr PR, reason string) error {
	q.logFunc("Marking PR #%d as failed: %s", pr.Number, reason)
	if q.dryRun {
		return nil
	}
	// Remove active label if present (ignore 404)
	if err := q.api.RemoveLabel(ctx, pr.Number, QueueLabel(q.label, StateActive)); err != nil && !isNotFoundError(err) {
		return fmt.Errorf("removing active label from #%d: %w", pr.Number, err)
	}
	// Remove pending label if present (ignore 404)
	if err := q.api.RemoveLabel(ctx, pr.Number, QueueLabel(q.label, StatePending)); err != nil && !isNotFoundError(err) {
		return fmt.Errorf("removing pending label from #%d: %w", pr.Number, err)
	}
	if err := q.api.AddLabel(ctx, pr.Number, QueueLabel(q.label, StateFailed)); err != nil {
		return fmt.Errorf("adding failed label to #%d: %w", pr.Number, err)
	}
	if err := q.api.Comment(ctx, pr.Number, fmt.Sprintf("Merge queue: %s", reason)); err != nil {
		return fmt.Errorf("commenting on #%d: %w", pr.Number, err)
	}
	return nil
}

// Requeue moves a PR back to pending state.
func (q *Queue) Requeue(ctx context.Context, pr PR) error {
	q.logFunc("Requeuing PR #%d", pr.Number)
	if q.dryRun {
		return nil
	}
	if err := q.api.RemoveLabel(ctx, pr.Number, QueueLabel(q.label, StateActive)); err != nil && !isNotFoundError(err) {
		return fmt.Errorf("removing active label from #%d: %w", pr.Number, err)
	}
	if err := q.api.RemoveLabel(ctx, pr.Number, QueueLabel(q.label, StateFailed)); err != nil && !isNotFoundError(err) {
		return fmt.Errorf("removing failed label from #%d: %w", pr.Number, err)
	}
	if err := q.api.AddLabel(ctx, pr.Number, QueueLabel(q.label, StatePending)); err != nil {
		return fmt.Errorf("requeuing #%d: %w", pr.Number, err)
	}
	return nil
}

// SetupLabels creates the queue labels in the repository.
func (q *Queue) SetupLabels(ctx context.Context) error {
	labels := []struct {
		name  string
		color string
		desc  string
	}{
		{QueueLabel(q.label, StatePending), "0e8a16", "PR is queued for merging"},
		{QueueLabel(q.label, StateActive), "1d76db", "PR is being processed by merge queue"},
		{QueueLabel(q.label, StateFailed), "d93f0b", "PR failed in merge queue"},
	}
	for _, l := range labels {
		q.logFunc("Creating label %q", l.name)
		if q.dryRun {
			continue
		}
		if err := q.api.CreateLabel(ctx, l.name, l.color, l.desc); err != nil {
			// Ignore "already_exists" errors to make setup idempotent
			if !isAlreadyExistsError(err) {
				return fmt.Errorf("creating label %q: %w", l.name, err)
			}
			q.logFunc("Label %q already exists, skipping", l.name)
		}
	}
	return nil
}

// HTTPError is an interface for errors that carry an HTTP status code.
type HTTPError interface {
	error
	StatusCode() int
}

// AlreadyExistsError is an optional interface for errors that indicate
// a resource already exists (e.g. duplicate label).
type AlreadyExistsError interface {
	AlreadyExists() bool
}

func isAlreadyExistsError(err error) bool {
	var ae AlreadyExistsError
	if errors.As(err, &ae) {
		return ae.AlreadyExists()
	}
	return false
}

func isNotFoundError(err error) bool {
	var httpErr HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode() == http.StatusNotFound
	}
	return false
}
