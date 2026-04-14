# merge-queue-action

[![CI](https://github.com/jeduden/merge-queue-action/actions/workflows/ci.yml/badge.svg)](https://github.com/jeduden/merge-queue-action/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/jeduden/merge-queue-action/branch/main/graph/badge.svg)](https://codecov.io/gh/jeduden/merge-queue-action)
[![lint: biome](https://img.shields.io/badge/lint-biome-60a5fa?logo=biome)](https://biomejs.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Bors-style merge queue for GitHub, implemented as a GitHub Action. Label a PR to
enqueue it, and the action batches PRs together, runs CI on the batch, and
fast-forwards `main`. When a batch fails, binary bisection isolates the
culprit in `ceil(log2(N)) + 1` CI runs.

No external server. No GitHub native merge queue. Runs as a single
Node.js-based GitHub Action — no compiled binary required.

## How it works

1. PRs labelled `queue` are collected oldest-first.
2. Up to `batch_size` PRs are merged (server-side) into a temporary
   `merge-queue/batch-*` branch.
3. CI is triggered on the batch branch (the merged result of all PRs
   combined with `main`) via `workflow_dispatch`.
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
   API (`POST /repos/{owner}/{repo}/merges`). This merges each PR into
   the batch branch, typically producing a merge commit when the histories
   have diverged (using the message `Merge PR #N: <title>` when such a
   merge commit is created). If a PR produces a merge conflict (HTTP 409),
   it is skipped and labelled `queue:failed`; remaining PRs continue.

3. **CI verification** — The CI workflow is triggered on the batch branch
   via `workflow_dispatch`. Because the batch branch contains the result
   of merging every queued PR on top of `main`, **CI runs against the
   exact combined commit that will become `main`** — not against each PR
   in isolation. This guarantees that the commit landing on `main` has
   passed CI. The action polls
   `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` every
   10 seconds (up to 1 hour) until the run completes, where
   `{workflow_id}` is the workflow file path provided by the
   `ci_workflow` input.

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

Worst case: after the initial failed full-batch CI run, bisection needs
`ceil(log₂(N)) + 1` additional CI runs to isolate a single failing PR.

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
2. Set **Target branches** to `main`.
3. Under **Bypass list**, add the actor whose token the action uses:
   - If using a **GitHub App**: add the app (e.g. "My Merge Queue App").
   - If using a **PAT (classic or fine-grained)**: add the user who owns
     the PAT, or add the user to a team and add that team.
4. Enable whichever rules you want for regular development (require PR,
   require status checks, etc.).
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

When batching multiple independent PRs, the batch branch will typically
contain merge commits. When `main` is fast-forwarded to the batch branch,
those merge commits land on `main`. If you enable **"Require linear
history"** in your ruleset or branch protection, the fast-forward will be
rejected because merge commits are present.

**Do not enable "Require linear history"** unless you modify the action
to rebase/squash instead of merge. The action's merge strategy produces a
non-linear history by design — each PR's merge commit preserves the
original branch context.

#### Summary of ruleset/protection settings

| Setting | Compatible? | Notes |
|---------|-------------|-------|
| Require a pull request before merging | Yes | Merge-queue actor must be in the bypass list so the direct ref update is allowed |
| Require status checks to pass | Yes | Ensure required checks run on the batch commit SHA; bypass only if you intentionally trust the action alone |
| Require linear history | **No** | Batch branches contain merge commits |
| Require signed commits | Depends | The API-created merge commits are unsigned; bypass the actor or disable |
| Restrict who can push | Yes | Merge-queue actor must be allowed |
| Require deployments to succeed | Yes | Ensure required deployments are reported on the batch commit SHA; bypass only if intentional |
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

#### Example: overlapping label events

Consider this timeline:

1. PR #1 is labelled `queue` → workflow run **A** starts.
2. Run A collects PR #1, moves it to `queue:active`, creates a batch
   branch, triggers CI, and **blocks while polling** for the CI result.
3. While CI is still running, PR #2 is labelled `queue` → workflow
   run **B** is triggered.
4. Because of the concurrency group, GitHub Actions holds run B in
   **pending** state — it cannot start until run A finishes.
5. Run A's CI completes. PR #1 is merged to `main` (or marked failed).
   Run A exits.
6. Run B starts. It collects PRs with the `queue` label — PR #1 no
   longer has it (it was moved to `queue:active` then removed), so only
   PR #2 is collected. Run B processes PR #2 normally.

If PR #2 had been labelled before run A collected PRs (step 2), both
PRs would have been batched together in run A and tested as a single
combined commit. The concurrency group serialises _workflow runs_, not
individual PRs — the batch size is determined by how many PRs carry the
`queue` label at the moment a run starts collecting.

#### When does batching actually happen?

With only the `pull_request: labeled` trigger, each label event fires
its own workflow run. Because the concurrency group serialises runs,
**in practice each run usually processes just one PR**. Batching only
occurs when multiple PRs accumulate the `queue` label while an earlier
run is still in progress — the next pending run will pick them all up.

To get more consistent batching, add a `schedule` trigger so the
workflow runs periodically and scoops up all queued PRs at once:

```yaml
on:
  pull_request:
    types: [labeled]
  schedule:
    - cron: "*/5 * * * *"   # every 5 minutes
  workflow_dispatch:
    inputs:
      batch_prs:
        type: string
        required: false
      bisect:
        type: boolean
        default: false
```

With a schedule trigger, PRs labelled between runs accumulate and are
tested together in a single batch, reducing total CI runs.

> **What if `cancel-in-progress` is `true`?** Run A would be cancelled
> when run B is triggered, leaving PR #1 stuck in `queue:active` with
> no run to finish it. Always use `cancel-in-progress: false`.

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
      - uses: jeduden/merge-queue-action@v0.3.0
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

The action uses three labels based on the `queue_label` input (default
`queue`): `<base>`, `<base>:active`, and `<base>:failed`. Create them in
your repository from the GitHub UI under **Issues → Labels** or with the
GitHub CLI:

```bash
# Using the default queue_label ("queue"):
gh label create queue --repo owner/repo
gh label create queue:active --repo owner/repo
gh label create queue:failed --repo owner/repo
```

### 5. Use it

Add your queue label (default `queue`) to a PR. The merge-queue workflow
triggers, batches it with any other queued PRs, runs CI, and merges on
success.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | — | PAT or GitHub App token with `contents:write`, `pull-requests:write`, `actions:write`, `issues:write` (the default `GITHUB_TOKEN` cannot dispatch workflows) |
| `ci_workflow` | yes | — | Workflow file supporting `workflow_dispatch` (e.g. `.github/workflows/ci.yml`) |
| `batch_size` | no | `5` | Max PRs per batch |
| `queue_label` | no | `queue` | Label that enqueues a PR |
| `dry_run` | no | `false` | Log intent without mutating |

## Development

### Prerequisites

- Node.js 24+

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Type check

```bash
npm run typecheck
```

### Project structure

```
src/main.ts             Entry point
src/action.ts           Action orchestration (process & bisect flows)
src/github.ts           GitHub REST API client
src/gitops.ts           Server-side git operations (branch, merge, fast-forward)
src/queue.ts            Label state machine
src/batch.ts            Batch branch creation and multi-PR merge
src/bisect.ts           Pure split function for binary bisection
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
