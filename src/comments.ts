/** Context for building links inside PR comments. */
export interface CommentCtx {
  serverUrl: string;
  ownerRepo: string;
  actionRunUrl: string;
  queueLabel: string;
}

export function formatErrorForComment(err: unknown, maxLen = 200): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    raw = (err as { message: string }).message;
  } else if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    raw = String(err);
  } else {
    raw = "unknown error";
  }
  const oneLine = raw.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  // If the chosen source (e.g. Error.message or a {message} object) was
  // empty or whitespace-only, fall back so requeue comments don't render
  // as a blank blockquote.
  const safeOneLine = oneLine || "unknown error";
  const capped =
    safeOneLine.length > maxLen
      ? `${safeOneLine.slice(0, maxLen - 1)}…`
      : safeOneLine;
  // Inline code neutralizes Markdown in the untrusted fragment: an
  // `@mention` or `[label](url)` smuggled into git/API error text would
  // otherwise render (and notify) inside a trusted bot comment.
  return `\`${capped}\``;
}

function branchLink(ctx: CommentCtx, branch: string): string {
  // Encode each path segment; preserve `/` so nested branch names like
  // `merge-queue/batch-42` render as clean path segments.
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  return `[\`${branch}\`](${ctx.serverUrl}/${ctx.ownerRepo}/tree/${encoded})`;
}

function commitLink(ctx: CommentCtx, sha: string): string {
  const short = sha.slice(0, 7);
  return `[\`${short}\`](${ctx.serverUrl}/${ctx.ownerRepo}/commit/${sha})`;
}

function prList(ns: number[]): string {
  return ns.map((n) => `#${n}`).join(", ");
}

const BRAND = "**Merge Queue**";

export function commentPickedUp(ctx: CommentCtx): string {
  return [
    `🟢 ${BRAND} — picked up`,
    "",
    `This PR is in the queue and will be batched with other \`${ctx.queueLabel}\`-labelled PRs.`,
    "",
    `**Next:** No action needed — you'll get another comment when CI starts on the batch. [View merge queue run](${ctx.actionRunUrl}).`,
  ].join("\n");
}

export function commentCIRunning(
  ctx: CommentCtx,
  batchBranch: string,
  siblingPRs: number[],
  ciRunUrl: string,
): string {
  const siblings =
    siblingPRs.length > 0 ? ` alongside ${prList(siblingPRs)}` : "";
  return [
    `🔵 ${BRAND} — CI running`,
    "",
    `Merged into batch branch ${branchLink(ctx, batchBranch)}${siblings}. [View CI run](${ciRunUrl}).`,
    "",
    "**Next:** No action needed — you'll be notified when CI completes.",
  ].join("\n");
}

export function commentMerged(
  ctx: CommentCtx,
  mergeSha: string,
  ciRunUrl: string,
): string {
  return [
    `✅ ${BRAND} — merged`,
    "",
    `This PR landed on \`main\` via commit ${commitLink(ctx, mergeSha)}. [CI run that validated the merge](${ciRunUrl}).`,
    "",
    "**Next:** Done — nothing more to do here.",
  ].join("\n");
}

export function commentCIFailed(
  ctx: CommentCtx,
  ciRunUrl: string,
  viaBisection: boolean,
): string {
  const headline = viaBisection
    ? `CI failed (identified via bisection)`
    : `CI failed`;
  const detail = viaBisection
    ? `Bisection identified this PR as the failing change. [View CI run that isolated the failure](${ciRunUrl}).`
    : `The [batch CI run](${ciRunUrl}) failed with this PR in it.`;
  return [
    `❌ ${BRAND} — ${headline}`,
    "",
    detail,
    "",
    `**Next:** Fix the failure, push updates, then re-add the \`${ctx.queueLabel}\` label to retry.`,
  ].join("\n");
}

export function commentMergeConflict(ctx: CommentCtx): string {
  return [
    `⚠️ ${BRAND} — merge conflict`,
    "",
    `This PR could not be merged into the batch branch without conflicts with ${branchLink(ctx, "main")} or another queued PR.`,
    "",
    `**Next:** Rebase onto or merge \`main\` into your branch, resolve conflicts, push, then re-add the \`${ctx.queueLabel}\` label.`,
  ].join("\n");
}

export function commentBisecting(
  ctx: CommentCtx,
  batchBranch: string,
  leftCount: number,
  totalCount: number,
  ciRunUrl: string,
): string {
  return [
    `🔍 ${BRAND} — bisecting`,
    "",
    `A larger batch failed CI. Bisection is isolating the culprit: this run tests up to **${leftCount} of ${totalCount}** candidate PRs on ${branchLink(ctx, batchBranch)}. [View current bisect CI run](${ciRunUrl}).`,
    "",
    "**Next:** No action needed — you'll be notified when the culprit is isolated, this PR merges, or this PR returns to the queue for a later batch.",
  ].join("\n");
}

/**
 * Operator-facing warning posted when the queue hits a non-fatal but
 * worth-surfacing condition (leaked refs, teardown failures,
 * unexpected cleanup paths). The leading HTML comment is a dedup
 * marker so future tooling can recognise and collapse these.
 */
export function commentOperatorWarning(ctx: CommentCtx, msg: string): string {
  // Normalise `msg` for Markdown: prefix every line with `> ` so a
  // multi-line error (typically stderr/stdout from a failed
  // subprocess) stays inside the blockquote, and cap the total
  // length so a stray 100 KiB stderr doesn't blow up the PR thread.
  // Backticks are left alone — inside a blockquote they render as
  // inline code, which is the right treatment for command output.
  const MAX = 4000;
  // First normalise line endings: git on Windows runners emits CRLF,
  // and a lone `\r` (classic Mac, occasional carriage-return-only
  // progress lines from some subprocesses) shouldn't survive into
  // the rendered Markdown either. Normalising before truncation
  // also means the cap counts characters of normalised text.
  const normalised = msg.replace(/\r\n?/g, "\n");
  const trimmed =
    normalised.length > MAX ? `${normalised.slice(0, MAX - 1)}…` : normalised;
  // Tilde-fenced code block: renders the raw subprocess/API output inert
  // (no @mentions, no links) — a backtick in the content cannot close a
  // tilde fence, and tilde runs are broken up so the content cannot
  // close it either.
  const fenced = ["~~~text", trimmed.replace(/~{3,}/g, "~ ~ ~"), "~~~"].join(
    "\n",
  );
  return [
    "<!-- merge-queue:warning -->",
    `⚠️ ${BRAND} — queue warning`,
    "",
    "The merge queue hit a non-fatal issue while processing this PR:",
    "",
    fenced,
    "",
    `[View merge queue run](${ctx.actionRunUrl}).`,
    "",
    "**Next:** No action needed — the queue will continue. If the warning repeats across runs, investigate via the run log.",
  ].join("\n");
}

export function commentRequeued(ctx: CommentCtx, reason: string): string {
  return [
    `⏳ ${BRAND} — requeued`,
    "",
    "The merge queue hit a transient error while processing this PR:",
    "",
    `> ${reason}`,
    "",
    `[View merge queue run](${ctx.actionRunUrl}).`,
    "",
    "**Next:** No action needed — the queue will retry automatically on the next run.",
  ].join("\n");
}

/**
 * Posted when the queue stops retrying a PR because it has reached the
 * requeue-attempt limit without succeeding. This is the circuit-breaker
 * backstop: it fires for any failure — permanent or stubbornly transient —
 * that survived the retry budget, so the queue can never retry a PR
 * forever. Unlike `commentRequeued`, the operator must act before the PR is
 * retried.
 *
 * `lastReason` is rendered raw in a blockquote, exactly like
 * `commentRequeued` renders the same string — callers (requeueOrGiveUp)
 * already pass a one-line, `formatErrorForComment`-sanitised reason, and
 * re-formatting here would truncate it a second time.
 */
export function commentGaveUp(
  ctx: CommentCtx,
  maxAttempts: number,
  lastReason?: string,
): string {
  const lines = [
    `🔴 ${BRAND} — retry limit reached`,
    "",
    `This PR reached the merge queue's retry limit (${maxAttempts} requeue attempts) without succeeding, so the queue has stopped retrying it.`,
  ];
  if (lastReason) {
    lines.push("", "Most recent error:", "", `> ${lastReason}`);
  }
  // Without a captured reason there is no "failure above" to point at —
  // send the reader to the run log instead.
  const investigate = lastReason
    ? "Investigate the failure above"
    : "Investigate via the merge queue run linked above";
  lines.push(
    "",
    `[View merge queue run](${ctx.actionRunUrl}).`,
    "",
    `**Next:** ${investigate}, fix the underlying problem, then re-add the \`${ctx.queueLabel}\` label to try again with a fresh retry budget.`,
  );
  return lines.join("\n");
}

/**
 * Posted when the merge queue action cannot proceed because the workflow is
 * misconfigured (e.g. missing `actions/checkout`, shallow clone, wrong CI
 * workflow name).  Unlike `commentRequeued`, this error will NOT resolve by
 * itself — the operator must fix the issue before the PR can be retried.
 */
export function commentConfigError(ctx: CommentCtx, detail: string): string {
  const normalised = detail.replace(/\r\n?/g, "\n");
  const quoted = normalised
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return [
    `🔴 ${BRAND} — action misconfigured`,
    "",
    "The merge queue cannot proceed because the workflow is misconfigured:",
    "",
    quoted,
    "",
    `[View merge queue run](${ctx.actionRunUrl}).`,
    "",
    `**Next:** Fix the configuration issue above, then re-add the \`${ctx.queueLabel}\` label to re-enter the queue.`,
  ].join("\n");
}
