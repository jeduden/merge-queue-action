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

## Quick start

### 1. Create the workflow files

**`.github/workflows/merge-queue.yml`** — processes the queue:

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
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0

      # Optional: register any custom merge drivers here, e.g.
      #   git config merge.lockfile.driver ".merge-drivers/lockfile.sh %O %A %B %L %P"

      - uses: jeduden/merge-queue-action@5adb5a76e27e96f1da5efd36f097a2c5233e9ad3 # v0.6.0
        with:
          token: ${{ secrets.MERGE_QUEUE_TOKEN }}
          ci_workflow: .github/workflows/ci.yml
          batch_size: "5"
          bisect: ${{ github.event.inputs.bisect }}
          batch_prs: ${{ github.event.inputs.batch_prs }}
```

The action configures `user.email`, `user.name`, and rewrites `origin`
to embed the merge-queue token before any merge runs, so `actions/checkout`
is the only setup step you need. The default token isn't passed to
checkout because the action overwrites the remote URL itself.

**`.github/workflows/ci.yml`** — your existing CI; just add `workflow_dispatch`:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  workflow_dispatch:   # Required — merge-queue-action triggers CI on batch branches

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false  # CI only reads; no push needed
      - run: npm test
```

### 2. Create a token

The default `GITHUB_TOKEN` cannot trigger `workflow_dispatch` on other
workflows. Create a **fine-grained PAT** (or GitHub App token) with
`contents:write`, `pull-requests:write`, `actions:write`,
`issues:write` and store it as a repository secret named
`MERGE_QUEUE_TOKEN`.

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

The action runs in a job that has already checked out the repository
(see [Quick start](#quick-start) for the required steps). Branch
creation, fast-forward and deletion go through the GitHub Git Data
API; the per-PR merge step runs `git merge` in the runner's working
tree so committed `.gitattributes` and `merge.<name>.driver` config
take effect. See [Custom merge drivers](#custom-merge-drivers) for the
driver setup.

1. **Batch branch creation** — A new branch `merge-queue/batch-<ID>` is
   created from the current tip of `main` using the
   [Create a reference](https://docs.github.com/en/rest/git/refs#create-a-reference)
   API (`POST /repos/{owner}/{repo}/git/refs`), then fetched and
   checked out locally.

2. **Local merges** — Each PR's head SHA is fetched and merged into
   the batch branch with `git merge --no-ff -m "Merge PR #N: <title>"`.
   Because the merge runs locally, `.gitattributes` and any registered
   `merge.<name>.driver` config are consulted exactly as they would be
   for a developer running `git merge`. If a PR still conflicts after
   drivers run, the action aborts that merge, leaves the working tree
   clean, skips the PR, and labels it `queue:failed`; remaining PRs
   continue. The resulting batch branch is pushed to `origin` before
   CI is triggered.

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

### Workflow requirements

The merge-queue workflow must include an `actions/checkout` step
**before** the `merge-queue-action` step, with `fetch-depth: 0`:

```yaml
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
  with:
    fetch-depth: 0
```

- **`fetch-depth: 0`** — the action refuses early on a shallow clone;
  local merges of PR head SHAs need full history.

That's the entire workflow-side setup. The action itself runs
`git config user.email/.name` and `git remote set-url origin
https://x-access-token:<token>@…` against the checked-out worktree,
so you don't need to pass `token:` to `actions/checkout` or add a
separate "Configure git" step. The token used is whatever you pass
as the `token` input (typically `secrets.MERGE_QUEUE_TOKEN`).

Override the identity via the `git_user_email` / `git_user_name`
inputs if you need a different author on the merge commits.

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
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
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

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | yes | — | PAT or GitHub App token with `contents:write`, `pull-requests:write`, `actions:write`, `issues:write` (the default `GITHUB_TOKEN` cannot dispatch workflows) |
| `ci_workflow` | yes | — | Workflow file supporting `workflow_dispatch` (e.g. `.github/workflows/ci.yml`) |
| `batch_size` | no | `5` | Max PRs per batch |
| `queue_label` | no | `queue` | Label that enqueues a PR |
| `dry_run` | no | `false` | Log intent without mutating |
| `git_user_email` | no | `merge-queue@users.noreply.github.com` | `user.email` set on the local repo before merging |
| `git_user_name` | no | `merge-queue-bot` | `user.name` set on the local repo before merging |

## Custom merge drivers

Git supports [custom merge drivers](https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver)
for resolving conflicts on specific file types — e.g. auto-merging
`package-lock.json`, `Cargo.lock`, `CHANGELOG.md`, or generated files
that would otherwise conflict on every parallel PR.

### How it works

Per-PR merges run via `git merge` in the runner's checked-out working
tree, so `git` consults your committed `.gitattributes` and dispatches
to any registered `merge.<name>.driver`. Batch branch creation,
fast-forward and deletion still go through the Git Data API, so
rulesets and fast-forward-only semantics are unchanged. If a merge
still conflicts after the driver runs, the PR is reported as
conflicted and labelled `queue:failed`.

> **Security note:** custom merge drivers execute arbitrary code in
> the runner on every batched merge, with access to the runner's
> environment — including `MERGE_QUEUE_TOKEN` if the workflow exposes
> it. Anyone who can land a commit on a branch that feeds the queue
> can change what the driver does, so treat `.merge-drivers/**` and
> `.gitattributes` as protected paths: require code-owner review, or
> gate them behind a ruleset the same way you gate `.github/workflows/`.

### Repository-side setup

The driver script **must be committed to the repository** so it is on
disk after `actions/checkout` — if it isn't in the working tree at
merge time, `git merge` has nothing to exec.

1. **Commit the driver** into the repo, e.g.
   `.merge-drivers/lockfile-merge.sh`. Make it executable and record the
   bit in git:

   ```bash
   chmod +x .merge-drivers/lockfile-merge.sh
   git add .merge-drivers/lockfile-merge.sh
   git update-index --chmod=+x .merge-drivers/lockfile-merge.sh
   ```

   The driver must write the resolved content to `%A` and exit `0` on
   success, non-zero on unresolvable conflict. See
   [gitattributes(5)](https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver)
   for the full contract.

2. **Commit `.gitattributes`** mapping paths to the driver name:

   ```gitattributes
   package-lock.json merge=lockfile
   pnpm-lock.yaml    merge=lockfile
   CHANGELOG.md      merge=union
   ```

   (`union` is a built-in driver; `lockfile` above is the custom one.)

3. **Register the driver at runtime.** `merge.<name>.driver` lives in
   `.git/config`, which is not tracked. The merge-queue workflow must
   set it after checkout and before the merge-queue action runs:

   ```yaml
   - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
     with:
       fetch-depth: 0

   - name: Register custom merge drivers
     run: |
       git config merge.lockfile.name "Auto-merge lockfiles"
       git config merge.lockfile.driver ".merge-drivers/lockfile-merge.sh %O %A %B %L %P"
       git config merge.lockfile.recursive binary
   ```

   The `%` placeholders are defined by git:

   | Placeholder | Meaning |
   |-------------|---------|
   | `%O` | path to the common-ancestor version |
   | `%A` | path to the current/ours version (driver writes result here) |
   | `%B` | path to the other/theirs version |
   | `%L` | conflict-marker size |
   | `%P` | pathname of the file being merged |

4. **Install any interpreters or tooling the driver needs** (Node,
   Python, a specific CLI) as earlier steps in the same job, before the
   merge-queue action runs.

5. **Do not rely on `~/.gitconfig`** or user-scoped config — Actions
   runners are ephemeral and the config must be set on every run.

### Wiring it into the workflow

Extend the [Quick start](#quick-start) workflow with a step that
registers the driver between `actions/checkout` and `merge-queue-action`:

```yaml
- name: Register merge drivers
  run: |
    git config merge.lockfile.name   "Auto-merge lockfiles"
    git config merge.lockfile.driver ".merge-drivers/lockfile-merge.sh %O %A %B %L %P"
    git config merge.lockfile.recursive binary
```

The action picks the driver up from `.git/config` the moment it runs
`git merge`. Identity (`user.email`/`user.name`) is set by the action
itself, so you don't need to add it to this step.

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
src/gitops.ts           Git operations: branch refs via REST API, per-PR merges via local `git`
src/queue.ts            Label state machine
src/batch.ts            Batch branch creation and multi-PR merge
src/bisect.ts           Pure split function for binary bisection
```

## When to upgrade to a full merge-queue server

Consider migrating to Bors-NG, Mergify, or Kodiak when:

- Queue exceeds ~10 PRs regularly
- CI takes longer than 15 minutes (bisection rounds compound)
- You need priority merges, cross-repo deps, or stacked PRs
- Label race conditions become a recurring problem

## License

MIT
