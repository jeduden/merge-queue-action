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
  return safeOneLine.length > maxLen
    ? `${safeOneLine.slice(0, maxLen - 1)}…`
    : safeOneLine;
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
    "**Next:** No action needed — you'll be notified when the culprit is isolated or this PR merges.",
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
  const quoted = trimmed
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    "<!-- merge-queue:warning -->",
    `⚠️ ${BRAND} — queue warning`,
    "",
    "The merge queue hit a non-fatal issue while processing this PR:",
    "",
    quoted,
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
    "The merge queue hit an error while processing this PR:",
    "",
    `> ${reason}`,
    "",
    `[View merge queue run](${ctx.actionRunUrl}).`,
    "",
    "**Next:** No action needed — the queue will retry on the next tick.",
  ].join("\n");
}
