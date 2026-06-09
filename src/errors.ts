/**
 * Thrown when the merge queue action cannot proceed due to a configuration
 * problem that requires a human to fix — e.g. missing `actions/checkout` step,
 * wrong workflow file name, shallow clone without `fetch-depth: 0`.
 *
 * Unlike transient infrastructure errors (API timeouts, network blips) these
 * will not resolve by simply retrying the queue run.  Callers must NOT requeue
 * affected PRs; instead they should mark those PRs as failed and post an
 * actionable comment so the operator knows exactly what to fix.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Detects a GitHub rate-limit / abuse response. These arrive as a 403
 * (occasionally 429) but are TRANSIENT — they carry a `retry-after` header,
 * an exhausted `x-ratelimit-remaining`, or a rate-limit message.
 *
 * This is the single shared predicate behind two complementary
 * classifications that must stay in agreement: `isHttpConfigError`
 * (action.ts — a rate-limited 403 is NOT a permanent config error) and
 * `isRetryableHttpError` (github.ts — a rate-limited 403 IS worth an
 * in-process retry).
 */
export function isRateLimitedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    response?: { headers?: Record<string, unknown> };
    message?: unknown;
  };
  const headers = e.response?.headers ?? {};
  if (headers["retry-after"] != null) return true;
  if (String(headers["x-ratelimit-remaining"]) === "0") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("rate limit") ||
    msg.includes("secondary rate") ||
    msg.includes("abuse")
  );
}
