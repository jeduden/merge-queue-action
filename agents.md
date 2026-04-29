# Agents Guide: merge-queue-action

This document provides guidance for AI agents working with the merge-queue-action codebase. It explains key architectural decisions, workflows, and patterns that may not be immediately obvious from reading the code.

## Core Architecture

### Two-Stage Merge Process

The action uses a **two-step merge process** that is critical to understand:

```
git merge --no-commit <source>
  ↓
invoke pre-merge-commit hook (if present)
  ↓
git commit -m "message"
```

**Why two steps?**
- `git merge --no-commit` stages the merge but doesn't create the commit yet
- The action manually invokes the `pre-merge-commit` hook between merge and commit
- Git does NOT run the hook automatically when `--no-commit` is used
- Using `git merge -m "message"` would bypass both the staged merge and hooks entirely

**Key files:**
- Implementation: `src/gitops.ts:379-560` (GitOps.mergeBranch method)
- Tests: `src/gitops.test.ts:119-280`

## Conflict Resolution Pipeline

The action supports **automated conflict resolution** through two integration points:

### 1. Merge Drivers (run during `git merge`)

Merge drivers are configured via `.gitattributes` and git config:
- Run automatically during `git merge` for files matching patterns
- Can resolve per-file conflicts (e.g., lockfiles, generated files)
- Exit code 0 = resolved, non-zero = unresolved

### 2. Pre-Merge-Commit Hooks (invoked manually before `git commit`)

Pre-merge-commit hooks are invoked manually by the action after `git merge --no-commit` and before `git commit`:
- Can resolve conflicts that merge drivers couldn't fix
- Can regenerate content based on the final merged state
- Can update indexes, catalogs, or other derived files

### Critical Behavior: Hooks Run Even When Conflicts Are Detected

**Important:** When `git merge` returns exit code 1 (conflicts detected), the action does NOT abort immediately. Here's the flow:

```
1. git merge --no-commit returns exit code 1
   ↓
2. Log conflict message but DO NOT check for conflicts yet
   ↓
3. Invoke pre-merge-commit hook manually (if present)
   ↓
4. Check git ls-files -u
   ↓
5. If git ls-files -u shows files → conflicts remain → abort
   ↓
6. If git ls-files -u is empty → run git commit → success
```

**Code location:** `src/gitops.ts:418-560`

**Test coverage:**
- Unresolved conflicts: `src/gitops.test.ts:119` ("mergeBranch returns false and cleans up on unresolved conflict")
- Merge driver resolves: `src/gitops.test.ts:165` ("mergeBranch succeeds when merge driver resolves all conflicts")
- Hook resolves: `src/gitops.test.ts:205` ("mergeBranch succeeds when conflict resolution pipeline clears all conflicts (merge exits 1 but ls-files -u is empty)")

### Why This Matters

Previous implementations checked for conflicts immediately after `git merge` returned exit code 1, which prevented hooks from running. The current implementation:

1. Trusts merge drivers AND hooks to resolve conflicts
2. Only checks for unresolved conflicts AFTER both have run
3. Distinguishes between:
   - Legitimate conflicts (return false, label PR `queue:failed`)
   - Hook failures (throw error with diagnostics)

## Key Implementation Details

### Conflict Detection

**DO NOT** use `git merge` exit code alone to determine if conflicts exist.

**Correct approach:**
```typescript
const checkConflicts = await this.git(["ls-files", "-u"]);
if (checkConflicts.code !== 0) {
  throw new Error(`git ls-files -u failed (exit ${checkConflicts.code}): ${checkConflicts.stderr.trim() || checkConflicts.stdout.trim()}`);
}
const hasUnresolvedConflicts = checkConflicts.stdout.trim().length > 0;
```

`git ls-files -u` lists unmerged files in the index. If stdout is empty, all conflicts were resolved (by drivers, hooks, or both). Always check the exit code before trusting stdout.

### Logging Merge Output

Git writes conflict messages to **stdout**, not stderr:
```typescript
// Correct
const output = merge.stdout.trim() || merge.stderr.trim() || "(no output)";

// Wrong
const output = merge.stderr.trim() || "(no output)";
```

**Why:** Git uses stdout for progress messages and conflict markers. Stderr is for actual errors.

### Hook Failure Handling

When the pre-merge-commit hook fails (exit code != 0), distinguish between:

1. **Hook failed due to unresolved conflicts** (return false):
   - Check `git ls-files -u`
   - If it lists files, conflicts remain
   - Clean up with `git merge --abort`

2. **Hook failed for other reasons** (throw error):
   - Check `git ls-files -u`
   - If empty, no conflicts → hook itself failed
   - Throw descriptive error (not just return false)

**Code location:** `src/gitops.ts:481-525`

## Testing Patterns

### Simulating Merge Scenarios

When writing tests for merge behavior, mock these git operations:

1. **Merge with conflicts:**
   ```typescript
   if (args.indexOf("merge") >= 0 && args[args.indexOf("merge") + 1] !== "--abort") {
     return { code: 1, stdout: "CONFLICT (content): Merge conflict in file.txt", stderr: "" };
   }
   ```

2. **MERGE_HEAD check** (indicates merge in progress):
   ```typescript
   if (args[0] === "rev-parse" && args[2] === "MERGE_HEAD") {
     return { code: 0, stdout: "abc1234", stderr: "" };
   }
   ```

3. **Commit success/failure:**
   ```typescript
   if (args.includes("commit") && args.includes("-m")) {
     return { code: 0, stdout: "[branch abc1234] msg", stderr: "" }; // success
     // OR
     return { code: 1, stdout: "", stderr: "error: Committing is not possible" }; // failure
   }
   ```

4. **Conflict check:**
   ```typescript
   if (args[0] === "ls-files" && args[1] === "-u") {
     return { code: 0, stdout: "", stderr: "" }; // no conflicts
     // OR
     return { code: 0, stdout: "100644 abc123 1\tfile.txt\n...", stderr: "" }; // conflicts
   }
   ```

### Test Structure Examples

See `src/gitops.test.ts` for complete examples:
- Line 119: Unresolved conflict test (commit fails, `ls-files -u` shows files)
- Line 165: Merge driver resolves (exit 1, but `ls-files -u` empty, commit succeeds)
- Line 205: Hook resolves (exit 1, commit succeeds despite initial conflict)
- Line 283: Hook failure (commit fails, but `ls-files -u` empty → throw error)

## Common Pitfalls

### 1. Don't abort on `git merge` exit code 1

❌ **Wrong:**
```typescript
if (merge.code === 1) {
  await this.git(["merge", "--abort"]);
  return false;
}
```

✅ **Correct:**
```typescript
if (merge.code === 1) {
  this.log("Conflicts detected, proceeding to commit to allow hooks to resolve...");
}
// Continue to git commit...
```

### 2. Don't skip MERGE_HEAD check

The MERGE_HEAD check distinguishes between:
- Actual merge in progress → proceed to commit
- Already up-to-date → skip commit (nothing to commit)

**Code location:** `src/gitops.ts:375-383`

### 3. Don't confuse hook failures with conflicts

When commit fails:
- Check `git ls-files -u` to determine root cause
- Files listed → conflict (return false)
- Empty → hook failure (throw error with details)

## Memory / Context Storage

When discovering facts about this codebase, store them using the `store_memory` tool with proper citations:

**Example facts worth storing:**
- "GitOps.mergeBranch uses git merge --no-commit followed by git commit to allow pre-merge-commit hooks to run"
- "Conflict detection uses git ls-files -u, not git merge exit code, to determine if conflicts remain after hooks run"
- "Git writes merge conflict messages to stdout, not stderr"

**Citations should reference:**
- File paths with line ranges: `src/gitops.ts:318-413`
- README sections: `README.md:691-742`
- Test names: `src/gitops.test.ts:119` (test name)

## Workflow Integration

### Merge Queue Workflow Setup

The merge-queue workflow must:
1. Run `actions/checkout` with `fetch-depth: 0` (no shallow clones)
2. Optionally install merge drivers before the action runs
3. Optionally register git config for merge drivers
4. Run the merge-queue-action

**Example:**
```yaml
- uses: actions/checkout@<SHA>
  with:
    fetch-depth: 0

- name: Install merge driver tools
  run: |
    # Install any binaries the driver needs

- name: Register merge drivers
  run: |
    git config merge.lockfile.driver ".merge-drivers/lockfile.sh %O %A %B %L %P"

- uses: jeduden/merge-queue-action@<SHA>
  with:
    token: ${{ secrets.MERGE_QUEUE_TOKEN }}
    ci_workflow: .github/workflows/ci.yml
```

### Security Considerations

Merge drivers and hooks execute **during the merge** with access to:
- `MERGE_QUEUE_TOKEN` (if exposed to the workflow)
- The runner environment
- Push access to the repository

**Implications:**
- Treat `.merge-drivers/**` and `.git/hooks/` as trusted code
- Require code-owner review for changes to these paths
- Pin all workflow actions to commit SHAs, not tags
- Verify binary checksums when installing tools

## Further Reading

- **README.md lines 146-178:** Detailed merge process explanation
- **README.md lines 691-766:** Merge driver and hook setup guide
- **src/gitops.ts:** Complete implementation
- **src/gitops.test.ts:** Comprehensive test coverage

## Questions?

If you're implementing features related to merge behavior, conflict resolution, or git operations:

1. Read `src/gitops.ts:271-420` (mergeBranch method) carefully
2. Review the test cases in `src/gitops.test.ts` for expected behavior
3. Check the README for user-facing documentation
4. Store any new patterns you discover using `store_memory` with citations
