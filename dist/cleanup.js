import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ // The require scope
/******/ var __nccwpck_require__ = {};
/******/ 
/************************************************************************/
/******/ /* webpack/runtime/define property getters */
/******/ (() => {
/******/ 	// define getter functions for harmony exports
/******/ 	__nccwpck_require__.d = (exports, definition) => {
/******/ 		for(var key in definition) {
/******/ 			if(__nccwpck_require__.o(definition, key) && !__nccwpck_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ })();
/******/ 
/******/ /* webpack/runtime/hasOwnProperty shorthand */
/******/ (() => {
/******/ 	__nccwpck_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ })();
/******/ 
/******/ /* webpack/runtime/compat */
/******/ 
/******/ if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = new URL('.', import.meta.url).pathname.slice(import.meta.url.match(/^file:\/\/\/\w:/) ? 1 : 0, -1) + "/";
/******/ 
/************************************************************************/
var __webpack_exports__ = {};

// EXPORTS
__nccwpck_require__.d(__webpack_exports__, {
  q: () => (/* binding */ tokenlessOriginUrl)
});

;// CONCATENATED MODULE: external "node:child_process"
const external_node_child_process_namespaceObject = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:child_process");
;// CONCATENATED MODULE: ./src/cleanup.ts
// Post-step cleanup for the merge-queue action.
//
// `configureGit` rewrites `origin` to an `https://x-access-token:<token>@…`
// URL so merges and pushes authenticate with the merge-queue token. That
// URL lives in `.git/config` for the rest of the job — actions/checkout's
// own post cleanup removes only the credentials IT configured — so any
// step running after this action could read the high-privilege token.
// This post hook (wired via `post:` in action.yml, runs even when the
// main step failed) resets `origin` to the token-less URL.
//
// Deliberately dependency-free and best-effort: a cleanup failure must
// never fail the job, and the runner is ephemeral anyway — this just
// closes the same-job window.

/** Token-less origin URL for the current repository. */
function tokenlessOriginUrl(serverUrl, repository) {
    if (!repository)
        return undefined;
    const server = serverUrl || "https://github.com";
    return `${server.replace(/\/+$/, "")}/${repository}.git`;
}
function run() {
    const url = tokenlessOriginUrl(process.env.GITHUB_SERVER_URL, process.env.GITHUB_REPOSITORY);
    if (!url) {
        console.log("cleanup: GITHUB_REPOSITORY not set; nothing to scrub");
        return;
    }
    const inside = (0,external_node_child_process_namespaceObject.spawnSync)("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
        console.log("cleanup: no git worktree; nothing to scrub");
        return;
    }
    const result = (0,external_node_child_process_namespaceObject.spawnSync)("git", ["remote", "set-url", "origin", url], {
        encoding: "utf8",
    });
    if (result.status === 0) {
        console.log(`cleanup: reset origin to token-less URL (${url})`);
    }
    else {
        // Best-effort: log and exit 0 so the post step never fails the job.
        console.log(`cleanup: failed to reset origin (exit ${result.status}): ${(result.stderr || "").trim()}`);
    }
}
// Only execute when running as the action's post step — importing this
// module from tests must not touch git.
if (process.env.GITHUB_ACTIONS === "true") {
    run();
}

var __webpack_exports__tokenlessOriginUrl = __webpack_exports__.q;
export { __webpack_exports__tokenlessOriginUrl as tokenlessOriginUrl };
