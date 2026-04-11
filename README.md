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

### How merging works in detail

The action never uses `git` locally. Every git operation is performed
server-side through the GitHub REST API:

1. **Batch branch creation** — A new branch `merge-queue/batch-<ID>` is
   created from the current tip of `main` using the
   [Create a reference](https://docs.github.com/en/rest/git/refs#create-a-reference)
   API (`POST /repos/{owner}/{repo}/git/refs`).

2. **Server-side merges** — Each PR's head ref is merged into the batch
   branch using the
   [Merge a branch](https://docs.github.com/en/rest/branches/branches#merge-a-branch)
   API (`POST /repos/{owner}/{repo}/merges`). This creates a merge commit
   on the batch branch for each PR (message: `Merge PR #N: <title>`).
   If a PR produces a merge conflict (HTTP 409), it is skipped and
   labelled `queue:failed`; remaining PRs continue.

3. **CI verification** — The CI workflow is triggered on the batch branch
   via `workflow_dispatch`. The action polls
   `GET /repos/{owner}/{repo}/actions/workflows/{id}/runs` every 10 seconds
   (up to 1 hour) until the run completes.

4. **Fast-forward to main** — When CI passes, the action updates `main` to
   point to the batch branch's HEAD SHA using the
   [Update a reference](https://docs.github.com/en/rest/git/refs#update-a-reference)
   API (`PATCH /repos/{owner}/{repo}/git/refs/heads/main`) with `force=false`.
   This is a **fast-forward only** operation — it will fail if `main` has
   moved ahead of the batch branch's base (e.g. another push landed while
   CI was running).

5. **Cleanup** — The batch branch is deleted and `queue:active` labels are
   removed from the merged PRs.

Because `main` is updated via the Refs API (a direct SHA update), this
**bypasses the Pull Requests merge API entirely**. PRs are not "merged"
through GitHub's normal merge button — their commits land on `main` via
the fast-forward, and GitHub automatically closes the PRs once their
commits appear on the target branch.

### Bisection on failure

When a batch of two or more PRs fails CI, the action dispatches a new run
of itself in `bisect` mode via `workflow_dispatch`:

1. The batch is split in half: `left = ceil(N/2)`, `right = remainder`.
2. A new batch branch is created with only the left-half PRs.
3. CI runs on the left half.
4. **Left passes** — merge it to `main`, then dispatch bisection for the
   right half.
5. **Left fails, single PR** — that PR is the culprit; mark it
   `queue:failed` and requeue the right half.
6. **Left fails, multiple PRs** — dispatch another bisection to split the
   left half further.

Worst case: `ceil(log₂(N)) + 1` CI runs to isolate a single failing PR.

## Repository setup

### Required repository / ruleset configuration

The action updates `main` by directly moving the branch ref via the Git
Refs API. This means your branch protection rules **must** allow the
merge-queue token to push to `main`. There are two ways to set this up:

#### Option A: Repository rulesets (recommended)

GitHub rulesets provide fine-grained control. Create a ruleset for `main`
that enforces your desired checks for normal development, then **bypass**
the ruleset for the merge-queue actor:

1. Go to **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
2. Set **Target branches** to `main` (or your default branch).
3. Under **Bypass list**, add the actor whose token the action uses:
   - If using a **GitHub App**: add the app (e.g. "My Merge Queue App").
   - If using a **PAT (classic or fine-grained)**: add the user who owns
     the PAT, or add the user to a team and add that team.
4. Enable whichever rules you want for regular development (require PR,
   require status checks, require linear history, etc.).
5. Save.

The bypass ensures the action's `UpdateRef` call (fast-forward) is not
blocked by rules that would otherwise reject a direct push.

#### Option B: Branch protection rules (classic)

If you use legacy branch protection instead of rulesets:

1. Go to **Settings → Branches → Branch protection rules** and edit the
   rule for `main`.
2. You can enable "Require a pull request before merging" and "Require
   status checks to pass before merging" for normal development.
3. Under **"Restrict who can push to matching branches"**, add the user
   or app whose token the action uses — or leave this unchecked to allow
   all collaborators with write access to push.
4. If you have "Require a pull request before merging" enabled, the
   merge-queue token's actor **must** be excluded from this restriction.
   The simplest way is to add the actor to the **"Allow specified actors
   to bypass required pull requests"** list (available under the same
   protection rule).

> **Important:** If branch protection requires pull requests before
> merging and the merge-queue token's actor is not bypassed, the
> fast-forward will be rejected with a 422 error ("Changes must be made
> through a pull request").

#### What about "Require linear history"?

The batch branch contains merge commits (one per PR merged into the batch).
When `main` is fast-forwarded to the batch branch, those merge commits
land on `main`. If you enable **"Require linear history"** in your ruleset
or branch protection, the fast-forward will be rejected because merge
commits are present.

**Do not enable "Require linear history"** unless you modify the action
to rebase/squash instead of merge. The action's merge strategy produces a
non-linear history by design — each PR's merge commit preserves the
original branch context.

#### Summary of ruleset/protection settings

| Setting | Compatible? | Notes |
|---------|-------------|-------|
| Require a pull request before merging | Yes | Merge-queue actor must be in the bypass list |
| Require status checks to pass | Yes | Merge-queue actor must be in the bypass list |
| Require linear history | **No** | Batch branches contain merge commits |
| Require signed commits | Depends | The API-created merge commits are unsigned; bypass the actor or disable |
| Restrict who can push | Yes | Merge-queue actor must be allowed |
| Require deployments to succeed | Yes | Merge-queue actor must be in the bypass list |
| Block force pushes | Yes | The action uses `force=false` (fast-forward only) |

### Token requirements

The default `GITHUB_TOKEN` **cannot** trigger `workflow_dispatch` events
on other workflows (GitHub prevents recursive triggering). You must use
one of:

- **Fine-grained PAT** with repository permissions: `contents:write`,
  `pull-requests:write`, `actions:write`, `issues:write`.
- **Classic PAT** with `repo` scope.
- **GitHub App installation token** with the same permissions.

Store the token as a repository secret (e.g. `MERGE_QUEUE_TOKEN`).

### CI workflow requirements

Your CI workflow (`ci_workflow` input) must:

1. Include `workflow_dispatch` in its `on:` triggers so the action can
   run it on batch branches.
2. Run the same checks you care about (tests, linting, builds, etc.).
3. Complete within 1 hour (the action's polling timeout).

Example minimal CI workflow:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  workflow_dispatch:   # Required for merge-queue-action

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

### Concurrency

The merge-queue workflow **must** use a concurrency group with
`cancel-in-progress: false`:

```yaml
concurrency:
  group: merge-queue
  cancel-in-progress: false
```

This ensures that when multiple PRs are labelled in quick succession,
the runs queue up rather than cancelling each other. Each run processes
whatever is in the queue at that moment.

## Quick start

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
      - uses: jeduden/merge-queue-action@v0.2.0
        with:
          token: ${{ secrets.MERGE_QUEUE_TOKEN }}
          ci_workflow: .github/workflows/ci.yml
          batch_size: "5"
          bisect: ${{ github.event.inputs.bisect }}
          batch_prs: ${{ github.event.inputs.batch_prs }}
```

### 2. Set up your CI workflow and token

See [CI workflow requirements](#ci-workflow-requirements) and
[Token requirements](#token-requirements) above.

### 3. Configure branch protection

The action fast-forwards `main` via the Git Refs API, so the merge-queue
token's actor must be allowed to push. See
[Required repository / ruleset configuration](#required-repository--ruleset-configuration)
for detailed setup.

### 4. Create the queue labels (one-time)

```bash
# Using the binary directly (GITHUB_REPOSITORY must be set):
GITHUB_REPOSITORY=owner/repo merge-queue setup --token "$GITHUB_TOKEN"
```

Or run the action with `setup` to create `queue`, `queue:active`, and
`queue:failed` labels automatically.

### 5. Use it

Add the `queue` label to a PR. The merge-queue workflow triggers, batches
it with any other queued PRs, runs CI, and merges on success.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | — | PAT or GitHub App token with `contents:write`, `pull-requests:write`, `actions:write`, `issues:write` (the default `GITHUB_TOKEN` cannot dispatch workflows) |
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
