/**
 * @agentproof/codefix: the code-fix agent (docs/CODEFIX.md).
 *
 * Pure and tool-running modules live here so they can be tested without the runner; the
 * orchestrator that wires them to the database, the event bus and the repository snapshot is
 * apps/runner/src/codefix.ts.
 *
 *   evidence   the compact, capped evidence text the model receives (code)
 *   localize   search terms and file ranking: code picks the files before any model sees source
 *   prompts    the two fixed system prompts and their user turns
 *   propose    the proposer and reviewer calls through getLlm(), strict JSON + Zod
 *   edits      exact search/replace edits -> git-compatible unified diff (no model-written hunks)
 *   scope      paths_in_scope, no_dependency_changes, size_within_bounds
 *   toolchain  git apply --check, npm install --ignore-scripts, tsc, with timeouts and a scrubbed env
 *   github     REST client with an operation allowlist (draft PRs only; merging cannot be expressed)
 *   github-app GitHub App identity: RS256 JWT, installation lookup, scoped short-lived tokens, manifest flow
 *   untrusted  fences, scans and sanitizes page- and repo-derived text; escapes model text for humans
 *   content-policy  code-written check on the diff's added and removed lines
 *   render     the Markdown record: PR body and codefix.md
 */
export * from './evidence';
export * from './localize';
export * from './prompts';
export * from './propose';
export * from './edits';
export * from './scope';
export * from './toolchain';
export * from './github';
export * from './github-app';
export * from './untrusted';
export * from './content-policy';
export * from './render';
