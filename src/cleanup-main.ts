// Entry point for the action's `post:` step (bundled to dist/cleanup.js).
// Kept separate from cleanup.ts so tests can import the logic without any
// module-level execution: an env-based gate is NOT enough — GitHub CI
// runners set GITHUB_ACTIONS=true for the test job too, so a gated call
// in the shared module would run `git remote set-url` during vitest's
// import of the module.
import { runCleanup } from "./cleanup.js";

runCleanup();
