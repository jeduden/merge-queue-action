# merge-queue-action

Bors-style merge queue for GitHub, implemented as a GitHub Action. Label a PR to
enqueue it, and the action batches PRs together, runs CI on the batch, and
fast-forwards `main`. When a batch fails, binary bisection isolates the
culprit in `ceil(log2(N)) + 1` CI runs.

No external server. No GitHub native merge queue. Distributed as a pre-compiled
Go binary.

## How it works

1. PRs labelled `queue` are collected oldest-first.
2. Up to `batch_size` PRs are merged (server-side) into a temporary
   `merge-queue/batch-*` branch.
3. CI is triggered on the batch branch via `workflow_dispatch`.
4. **CI passes** — `main` is fast-forwarded, batch branch deleted.
5. **CI fails, batch = 1** — the PR is labelled `queue:failed` with a comment.
6. **CI fails, batch > 1** — the action dispatches itself to bisect the batch,
   recursively splitting until the failing PR is isolated.

### Label state machine

| Label | Meaning |
|-------|---------|
| `queue` | PR is waiting to be processed |
| `queue:active` | PR is currently in a batch |
| `queue:failed` | PR failed CI or had a merge conflict |

## Integration

### 1. Create a merge-queue workflow

```yaml
# .github/workflows/merge-queue.yml
name: Merge Queue
on:
  pull_request:
    types: [labeled]
  workflow_dispatch:
    inputs:
      batch_prs:
        type: string
        required: false
      bisect:
        type: boolean
        default: false

concurrency:
  group: merge-queue
  cancel-in-progress: false

jobs:
  queue:
    runs-on: ubuntu-latest
    steps:
      - uses: jeduden/merge-queue-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          ci_workflow: .github/workflows/ci.yml
          batch_size: "5"
```

### 2. Ensure your CI workflow supports `workflow_dispatch`

The `ci_workflow` input must point to a workflow file that has
`workflow_dispatch` in its `on:` triggers so the action can run CI
on batch branches.

### 3. Create the queue labels (one-time)

```bash
# Using the binary directly:
merge-queue setup --token "$GITHUB_TOKEN"
```

Or run the action with `setup` to create `queue`, `queue:active`, and
`queue:failed` labels automatically.

### 4. Use it

Add the `queue` label to a PR. The merge-queue workflow triggers, batches
it with any other queued PRs, runs CI, and merges on success.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | — | GitHub token with `contents:write`, `pull-requests:write`, `actions:write`, `issues:write` |
| `ci_workflow` | yes | — | Workflow file supporting `workflow_dispatch` (e.g. `.github/workflows/ci.yml`) |
| `batch_size` | no | `5` | Max PRs per batch |
| `queue_label` | no | `queue` | Label that enqueues a PR |
| `dry_run` | no | `false` | Log intent without mutating |

## CLI

The action wraps a Go binary with three subcommands:

```
merge-queue process   # Main flow: collect, batch, verify, merge
merge-queue bisect    # Bisection flow (called via dispatch)
merge-queue setup     # Create labels in a repo
```

## Development

### Prerequisites

- Go 1.24+

### Build

```bash
go build -o merge-queue ./cmd/merge-queue
```

### Test

```bash
go test -race ./...
```

### Lint

```bash
# Install golangci-lint: https://golangci-lint.run/welcome/install/
golangci-lint run
```

### Project structure

```
cmd/merge-queue/        CLI entry point, GitHub client, git operations
internal/bisect/        Pure Split() function for binary bisection
internal/queue/         Label state machine, GitHubAPI interface
internal/batch/         Batch branch creation and multi-PR merge
```

All git operations (branch creation, merge, fast-forward, delete) use the
GitHub REST API server-side — no local `git` binary is required.

## When to upgrade to a full merge-queue server

Consider migrating to Bors-NG, Mergify, or Kodiak when:

- Queue exceeds ~10 PRs regularly
- CI takes longer than 15 minutes (bisection rounds compound)
- You need priority merges, cross-repo deps, or stacked PRs
- Label race conditions become a recurring problem

## License

MIT
