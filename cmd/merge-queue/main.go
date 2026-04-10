package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/jeduden/merge-queue-action/internal/batch"
	"github.com/jeduden/merge-queue-action/internal/bisect"
	"github.com/jeduden/merge-queue-action/internal/queue"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: merge-queue <process|bisect|setup>\n")
		os.Exit(1)
	}

	ctx := context.Background()

	switch os.Args[1] {
	case "process":
		if err := runProcess(ctx); err != nil {
			log.Fatalf("process: %v", err)
		}
	case "bisect":
		if err := runBisect(ctx); err != nil {
			log.Fatalf("bisect: %v", err)
		}
	case "setup":
		if err := runSetup(ctx); err != nil {
			log.Fatalf("setup: %v", err)
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

type config struct {
	token      string
	ciWorkflow string
	batchSize  int
	queueLabel string
	dryRun     bool
}

func loadConfig() config {
	batchSize := 5
	if s := getFlag("--batch-size"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			batchSize = n
		}
	}

	label := "queue"
	if s := getFlag("--queue-label"); s != "" {
		label = s
	}

	dryRun := false
	if s := getFlag("--dry-run"); s == "true" {
		dryRun = true
	}

	return config{
		token:      getFlag("--token"),
		ciWorkflow: getFlag("--ci-workflow"),
		batchSize:  batchSize,
		queueLabel: label,
		dryRun:     dryRun,
	}
}

func getFlag(name string) string {
	for i, arg := range os.Args {
		if arg == name && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return ""
}

func runProcess(ctx context.Context) error {
	cfg := loadConfig()
	logf := log.Printf

	if cfg.token == "" {
		return fmt.Errorf("--token is required")
	}
	if cfg.ciWorkflow == "" {
		return fmt.Errorf("--ci-workflow is required")
	}

	api := NewGitHubClient(cfg.token)
	gitOps := NewGitOps(cfg.dryRun, logf)
	q := queue.New(api, cfg.queueLabel, cfg.dryRun, logf)
	b := batch.New(gitOps, cfg.dryRun, logf)

	// 1. Collect queued PRs
	prs, err := q.Collect(ctx)
	if err != nil {
		return err
	}
	if len(prs) == 0 {
		logf("No PRs in queue")
		return nil
	}

	// Limit to batch size
	if len(prs) > cfg.batchSize {
		prs = prs[:cfg.batchSize]
	}
	logf("Processing %d PRs", len(prs))

	// 2. Activate PRs
	if err := q.Activate(ctx, prs); err != nil {
		return err
	}

	// 3. Create batch branch and merge PRs
	batchPRs := make([]batch.PR, len(prs))
	for i, pr := range prs {
		batchPRs[i] = batch.PR{Number: pr.Number, HeadRef: pr.HeadRef, Title: pr.Title}
	}

	batchID := fmt.Sprintf("%d", prs[0].Number)
	result, err := b.CreateAndMerge(ctx, batchID, batchPRs)
	if err != nil {
		return err
	}

	// 4. Eject conflicted PRs
	for _, cp := range result.Conflicted {
		for _, pr := range prs {
			if pr.Number == cp.Number {
				if err := q.MarkFailed(ctx, pr, "merge conflict"); err != nil {
					logf("Warning: failed to mark PR #%d as failed: %v", pr.Number, err)
				}
				break
			}
		}
	}

	if len(result.Merged) == 0 {
		logf("No PRs merged successfully")
		return nil
	}

	// 5. Trigger CI and wait
	logf("Triggering CI workflow %s on %s", cfg.ciWorkflow, result.Branch)
	if !cfg.dryRun {
		if err := api.TriggerWorkflow(ctx, cfg.ciWorkflow, result.Branch, nil); err != nil {
			return fmt.Errorf("triggering CI: %w", err)
		}

		logf("Waiting for CI result...")
		conclusion, err := api.GetWorkflowRunStatus(ctx, cfg.ciWorkflow, result.Branch)
		if err != nil {
			return fmt.Errorf("getting CI status: %w", err)
		}

		if conclusion != "success" {
			return handleCIFailure(ctx, cfg, q, b, prs, result, api)
		}
	}

	// 6. CI passed — merge to main
	if err := b.CompleteMerge(ctx, result.Branch); err != nil {
		return err
	}

	// Close PRs and clean up labels
	for _, pr := range prs {
		found := false
		for _, mp := range result.Merged {
			if mp.Number == pr.Number {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		logf("PR #%d merged successfully", pr.Number)
		if !cfg.dryRun {
			_ = api.RemoveLabel(ctx, pr.Number, queue.QueueLabel(cfg.queueLabel, queue.StateActive))
			_ = api.Comment(ctx, pr.Number, "Merge queue: merged to main")
		}
	}

	logf("Batch merge complete")
	return nil
}

func handleCIFailure(ctx context.Context, cfg config, q *queue.Queue, _ *batch.Batch, prs []queue.PR, result *batch.MergeResult, api *GitHubClient) error {
	logf := log.Printf

	if len(result.Merged) == 1 {
		// Single PR failed — mark it
		for _, pr := range prs {
			if pr.Number == result.Merged[0].Number {
				return q.MarkFailed(ctx, pr, "CI failed")
			}
		}
	}

	// Multiple PRs failed — trigger bisection
	prNumbers := make([]int, len(result.Merged))
	for i, mp := range result.Merged {
		prNumbers[i] = mp.Number
	}

	prJSON, _ := json.Marshal(prNumbers)
	logf("CI failed for batch, triggering bisection for PRs: %v", prNumbers)

	if !cfg.dryRun {
		return api.TriggerWorkflow(ctx, cfg.ciWorkflow, "main", map[string]interface{}{
			"batch_prs": string(prJSON),
			"bisect":    "true",
		})
	}
	return nil
}

func runBisect(ctx context.Context) error {
	cfg := loadConfig()
	logf := log.Printf

	if cfg.token == "" {
		return fmt.Errorf("--token is required")
	}

	prListStr := getFlag("--prs")
	if prListStr == "" {
		return fmt.Errorf("--prs is required (JSON array of PR numbers)")
	}

	var prNumbers []int
	if err := json.Unmarshal([]byte(prListStr), &prNumbers); err != nil {
		return fmt.Errorf("parsing --prs: %w", err)
	}

	if len(prNumbers) == 0 {
		logf("No PRs to bisect")
		return nil
	}

	api := NewGitHubClient(cfg.token)
	gitOps := NewGitOps(cfg.dryRun, logf)
	q := queue.New(api, cfg.queueLabel, cfg.dryRun, logf)
	b := batch.New(gitOps, cfg.dryRun, logf)

	// Get PR details
	allPRs, err := api.ListPRsWithLabel(ctx, queue.QueueLabel(cfg.queueLabel, queue.StateActive))
	if err != nil {
		return fmt.Errorf("listing active PRs: %w", err)
	}

	// Filter to only the PRs we're bisecting
	prMap := make(map[int]queue.PR)
	for _, pr := range allPRs {
		prMap[pr.Number] = pr
	}

	left, right := bisect.Split(prNumbers)
	logf("Bisecting: left=%v, right=%v", left, right)

	// Build batch from left half
	var leftPRs []batch.PR
	for _, n := range left {
		if pr, ok := prMap[n]; ok {
			leftPRs = append(leftPRs, batch.PR{Number: pr.Number, HeadRef: pr.HeadRef, Title: pr.Title})
		}
	}

	batchID := fmt.Sprintf("bisect-%d", left[0])
	result, err := b.CreateAndMerge(ctx, batchID, leftPRs)
	if err != nil {
		return fmt.Errorf("creating bisect batch: %w", err)
	}

	// Run CI on left half
	logf("Running CI on left half: %v", left)
	conclusion := "success"
	if !cfg.dryRun {
		if err := api.TriggerWorkflow(ctx, cfg.ciWorkflow, result.Branch, nil); err != nil {
			return fmt.Errorf("triggering CI for bisect: %w", err)
		}
		conclusion, err = api.GetWorkflowRunStatus(ctx, cfg.ciWorkflow, result.Branch)
		if err != nil {
			return fmt.Errorf("getting CI status for bisect: %w", err)
		}
	}

	if conclusion == "success" {
		// Left half passes — merge it to main
		logf("Left half passed, merging to main")
		if err := b.CompleteMerge(ctx, result.Branch); err != nil {
			return err
		}
		for _, n := range left {
			if pr, ok := prMap[n]; ok {
				logf("PR #%d merged successfully", n)
				if !cfg.dryRun {
					_ = api.RemoveLabel(ctx, pr.Number, queue.QueueLabel(cfg.queueLabel, queue.StateActive))
					_ = api.Comment(ctx, pr.Number, "Merge queue: merged to main")
				}
			}
		}

		// Dispatch bisection for right half if needed
		if len(right) > 0 {
			rightJSON, _ := json.Marshal(right)
			logf("Dispatching bisection for right half: %v", right)
			if !cfg.dryRun {
				return api.TriggerWorkflow(ctx, cfg.ciWorkflow, "main", map[string]interface{}{
					"batch_prs": string(rightJSON),
					"bisect":    "true",
				})
			}
		}
	} else {
		// Left half fails
		if len(left) == 1 {
			// Single PR is the culprit
			if pr, ok := prMap[left[0]]; ok {
				logf("PR #%d is the culprit", left[0])
				if err := q.MarkFailed(ctx, pr, "CI failed (identified via bisection)"); err != nil {
					return err
				}
			}
			// Requeue right half
			for _, n := range right {
				if pr, ok := prMap[n]; ok {
					if err := q.Requeue(ctx, pr); err != nil {
						logf("Warning: failed to requeue PR #%d: %v", n, err)
					}
				}
			}
		} else {
			// Split left further
			leftJSON, _ := json.Marshal(left)
			logf("Left half failed, splitting further: %v", left)
			if !cfg.dryRun {
				return api.TriggerWorkflow(ctx, cfg.ciWorkflow, "main", map[string]interface{}{
					"batch_prs": string(leftJSON),
					"bisect":    "true",
				})
			}
		}
	}

	return nil
}

func runSetup(ctx context.Context) error {
	cfg := loadConfig()
	logf := log.Printf

	if cfg.token == "" {
		return fmt.Errorf("--token is required")
	}

	api := NewGitHubClient(cfg.token)
	q := queue.New(api, cfg.queueLabel, cfg.dryRun, logf)

	logf("Setting up labels for merge queue")
	return q.SetupLabels(ctx)
}
