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
export declare class ConfigurationError extends Error {
    constructor(message: string);
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
export declare function isRateLimitedError(err: unknown): boolean;
