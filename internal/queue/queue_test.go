package queue

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// mockAPI implements GitHubAPI for testing.
type mockAPI struct {
	prs          map[string][]PR // label -> PRs
	labels       map[int][]string
	comments     map[int][]string
	closedPRs    []int
	dispatches []dispatch
	createdLabels []createdLabel
	failOn       string // method name to fail on
}

type dispatch struct {
	workflowFile string
	ref          string
	inputs       map[string]interface{}
}

type createdLabel struct {
	name  string
	color string
	desc  string
}

func newMockAPI() *mockAPI {
	return &mockAPI{
		prs:      make(map[string][]PR),
		labels:   make(map[int][]string),
		comments: make(map[int][]string),
	}
}

func (m *mockAPI) ListPRsWithLabel(_ context.Context, label string) ([]PR, error) {
	if m.failOn == "ListPRsWithLabel" {
		return nil, fmt.Errorf("mock error")
	}
	return m.prs[label], nil
}

func (m *mockAPI) AddLabel(_ context.Context, prNumber int, label string) error {
	if m.failOn == "AddLabel" {
		return fmt.Errorf("mock error")
	}
	m.labels[prNumber] = append(m.labels[prNumber], label)
	return nil
}

func (m *mockAPI) RemoveLabel(_ context.Context, prNumber int, label string) error {
	if m.failOn == "RemoveLabel" {
		return fmt.Errorf("mock error")
	}
	labels := m.labels[prNumber]
	for i, l := range labels {
		if l == label {
			m.labels[prNumber] = append(labels[:i], labels[i+1:]...)
			break
		}
	}
	return nil
}

func (m *mockAPI) Comment(_ context.Context, prNumber int, body string) error {
	if m.failOn == "Comment" {
		return fmt.Errorf("mock error")
	}
	m.comments[prNumber] = append(m.comments[prNumber], body)
	return nil
}

func (m *mockAPI) ClosePR(_ context.Context, prNumber int) error {
	m.closedPRs = append(m.closedPRs, prNumber)
	return nil
}

func (m *mockAPI) TriggerWorkflow(_ context.Context, workflowFile string, ref string, inputs map[string]interface{}) error {
	m.dispatches = append(m.dispatches, dispatch{workflowFile, ref, inputs})
	return nil
}

func (m *mockAPI) GetWorkflowRunStatus(_ context.Context, _ string, _ string, _ time.Time) (string, error) {
	return "success", nil
}

func (m *mockAPI) CreateLabel(_ context.Context, name string, color string, desc string) error {
	if m.failOn == "CreateLabel" {
		return fmt.Errorf("mock error")
	}
	m.createdLabels = append(m.createdLabels, createdLabel{name, color, desc})
	return nil
}

func nopLog(string, ...any) {}

func TestCollect_SortsOldestFirst(t *testing.T) {
	api := newMockAPI()
	api.prs["queue"] = []PR{
		{Number: 3, CreatedAt: 300},
		{Number: 1, CreatedAt: 100},
		{Number: 2, CreatedAt: 200},
	}

	q := New(api, "queue", false, nopLog)
	prs, err := q.Collect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(prs) != 3 {
		t.Fatalf("expected 3 PRs, got %d", len(prs))
	}
	if prs[0].Number != 1 || prs[1].Number != 2 || prs[2].Number != 3 {
		t.Errorf("wrong order: %v", prs)
	}
}

func TestCollect_Empty(t *testing.T) {
	api := newMockAPI()
	q := New(api, "queue", false, nopLog)
	prs, err := q.Collect(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(prs) != 0 {
		t.Errorf("expected 0 PRs, got %d", len(prs))
	}
}

func TestCollect_APIError(t *testing.T) {
	api := newMockAPI()
	api.failOn = "ListPRsWithLabel"
	q := New(api, "queue", false, nopLog)
	_, err := q.Collect(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestActivate(t *testing.T) {
	api := newMockAPI()
	api.labels[1] = []string{"queue"}
	api.labels[2] = []string{"queue"}

	q := New(api, "queue", false, nopLog)
	prs := []PR{{Number: 1}, {Number: 2}}
	err := q.Activate(context.Background(), prs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for _, pr := range prs {
		labels := api.labels[pr.Number]
		hasActive := false
		for _, l := range labels {
			if l == "queue:active" {
				hasActive = true
			}
			if l == "queue" {
				t.Errorf("PR #%d still has pending label", pr.Number)
			}
		}
		if !hasActive {
			t.Errorf("PR #%d missing active label", pr.Number)
		}
	}
}

func TestActivate_DryRun(t *testing.T) {
	api := newMockAPI()
	api.labels[1] = []string{"queue"}

	q := New(api, "queue", true, nopLog)
	err := q.Activate(context.Background(), []PR{{Number: 1}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// In dry run, labels should not change
	if len(api.labels[1]) != 1 || api.labels[1][0] != "queue" {
		t.Errorf("dry run modified labels: %v", api.labels[1])
	}
}

func TestMarkFailed(t *testing.T) {
	api := newMockAPI()
	api.labels[5] = []string{"queue:active"}

	q := New(api, "queue", false, nopLog)
	err := q.MarkFailed(context.Background(), PR{Number: 5}, "CI failed")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	hasFailed := false
	for _, l := range api.labels[5] {
		if l == "queue:failed" {
			hasFailed = true
		}
	}
	if !hasFailed {
		t.Error("PR missing failed label")
	}

	if len(api.comments[5]) != 1 {
		t.Fatalf("expected 1 comment, got %d", len(api.comments[5]))
	}
	if api.comments[5][0] != "Merge queue: CI failed" {
		t.Errorf("unexpected comment: %s", api.comments[5][0])
	}
}

func TestRequeue(t *testing.T) {
	api := newMockAPI()
	api.labels[3] = []string{"queue:active"}

	q := New(api, "queue", false, nopLog)
	err := q.Requeue(context.Background(), PR{Number: 3})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	hasPending := false
	for _, l := range api.labels[3] {
		if l == "queue" {
			hasPending = true
		}
	}
	if !hasPending {
		t.Error("PR missing pending label after requeue")
	}
}

func TestSetupLabels(t *testing.T) {
	api := newMockAPI()
	q := New(api, "queue", false, nopLog)
	err := q.SetupLabels(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(api.createdLabels) != 3 {
		t.Fatalf("expected 3 labels, got %d", len(api.createdLabels))
	}
	names := map[string]bool{}
	for _, l := range api.createdLabels {
		names[l.name] = true
	}
	for _, want := range []string{"queue", "queue:active", "queue:failed"} {
		if !names[want] {
			t.Errorf("missing label %q", want)
		}
	}
}

func TestQueueLabel(t *testing.T) {
	tests := []struct {
		base  string
		state LabelState
		want  string
	}{
		{"queue", StatePending, "queue"},
		{"queue", StateActive, "queue:active"},
		{"queue", StateFailed, "queue:failed"},
		{"mq", StateActive, "mq:active"},
	}
	for _, tt := range tests {
		got := QueueLabel(tt.base, tt.state)
		if got != tt.want {
			t.Errorf("QueueLabel(%q, %q) = %q, want %q", tt.base, tt.state, got, tt.want)
		}
	}
}
