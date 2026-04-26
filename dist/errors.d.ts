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
