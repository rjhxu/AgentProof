# Security

AgentProof points AI agents at a live store and lets a model propose changes to that store's source code. This document covers what each component may do, what it trusts, and what is still open.

## Trust boundaries

| Input                                   | Trusted? | Handling                                                                                                                                           |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The mission (structured, Zod-validated) | yes      | The only instruction the agents receive. `decide()` never sees the raw prompt.                                                                     |
| Page content (tree, text, screenshots)  | no       | Passed to the model as data in the user turn. Each agent kind has a fixed system prompt that never contains page content.                          |
| Model output                            | no       | Parsed against a strict JSON schema and a Zod schema. Actions pass the policy check, and diffs pass the validation ladder. It never sets a status. |
| Repository content                      | no       | Read from a bare clone, never executed during analysis, sanitized, scanned and fenced before a model sees it.                                      |
| Credentials (model key, GitHub App key) | secret   | Kept in `.env`, which is gitignored. They are never logged, never rendered and never passed to child processes.                                    |

## Safeguards

**Verdicts.** Checkpoint status, budget arithmetic, variant comparison and attribution are pure functions in `packages/verifier`. The model writes narratives and hypotheses, stored in fields labelled as inferred. A fix counts as proven only after a real rerun.

**Agent actions** (`packages/agent/src/policy.ts`). Every action passes `checkAction()` before Playwright runs it:

- Hosts are limited to `AGENTPROOF_ALLOWED_HOSTS` (default `localhost,127.0.0.1`). The runner also refuses missions for other hosts.
- Action types must be in the mission's `allowedActions`. Runs have a step cap (`AGENTPROOF_MAX_STEPS`, default 25).
- Controls that read as payment ("place order", "pay now", "buy now", ...) are refused for clicks, typing and both halves of a select.
- A coordinate click first reads the element under the point and gets the same check. Coordinate typing never presses Enter.
- Each run gets a fresh browser context or cookie session, so carts never leak between runs.
- The test store returns 403 on `/checkout/place-order` and logs an error if it is ever hit.

**Code-fix pipeline** (`packages/codefix`, details in [CODEFIX.md](CODEFIX.md#6-threat-model-and-mitigations)):

- **Prompt injection.** Evidence text is stripped of control, zero-width and bidi characters and scanned for instruction-like content. It sits inside an `UNTRUSTED` fence keyed by a per-fix nonce. Only `<storeRoot>/src/**` source files are shown, never `docs/`. Files that are binary, oversized, credential-bearing or contain invisible characters are excluded.
- **Over-reaching edits.** Edits must be exact, unique matches in files the model saw in full, and code generates the diff. Checks: `paths_in_scope`, `no_dependency_changes` (no manifests, lockfiles, CI, `.env`, scripts), `size_within_bounds` (at most 5 files and 300 lines), and `content_policy` (no external URLs, network calls, dynamic code, process or filesystem access, script injection, obfuscation, secrets, new imports, hidden controls or removed payment guards). Then come `git apply --check`, `tsc --noEmit`, and the opt-in rematch. A fix whose rematch fails is not delivered.
- **Repository code execution.** Reads use `git show` on a bare clone with hooks disabled, and `file:` and `ext:` protocols are refused. Installs use `npm ci --ignore-scripts`. Repository code runs only during the opt-in rematch: in a worktree, on loopback, with a scrubbed environment (no `*KEY*`, `*TOKEN*`, `GIT_*`, `npm_config_*`), and killed after a timeout.
- **Model text shown to people.** Model text in pull request bodies and reports is HTML-escaped, stripped of invisible characters, capped and labelled as a hypothesis.
- **Runaway cost.** At most 2 attempts plus one file-request round. Every model call has a token cap, and git, install, typecheck, boot and the rematch each have a timeout.

**GitHub access** ([CODEFIX.md section 2](CODEFIX.md#2-github-access)):

- The GitHub App is the primary identity. Each operation signs a short-lived JWT and mints an installation token scoped to one repository and the minimum permissions: `contents: read` to clone, `contents: write` and `pull_requests: write` to deliver. Tokens expire within an hour and are never persisted. A per-request fine-grained token is the fallback, and it is held in memory only.
- Git receives tokens only through environment variables: never on argv, in a remote URL or on disk.
- The client allowlists six REST operations. A merge, approval, ready-for-review, branch deletion or default-branch write cannot be expressed. Pushes go only to `agentproof/*` branches and are never forced.
- Pull requests are always opened as drafts, so GitHub itself blocks a merge until a human marks the pull request ready.
- The app's private key lives in `.env` or a `0600` file. `GET /github/app` describes the app without exposing the key.

**Auditability.** Each `CodeFix` record stores the exact evidence text the model saw and a SHA-256 fingerprint of every prompt. It also stores every attempt, check, flag and credential kind (`delivery.actor`, `accessVia`). Every model call records tokens and estimated cost.

## Known limitations

These are acceptable for a local, single-operator deployment. Address them before you run AgentProof as a shared or hosted service.

- **No authentication on the runner.** It binds `0.0.0.0` with permissive CORS. Mission and run routes are open to anyone who can reach the port. Repository, code-fix and GitHub App routes accept loopback callers only. Put the runner behind authentication, or bind it to localhost.
- **Single node.** Jobs run in an in-process queue (concurrency 2) and state lives in SQLite. A restart drops queued jobs.
- **Line-level tripwires.** The content policy and injection scans match patterns. They raise the cost of an attack but are not a proof of safety. The rematch is opt-in, and the model reviewer is advisory. Requiring a passing rematch before every delivery, and reviewing with a stronger model, would tighten the loop.
- **Browser isolation.** Agents run headless Chromium in the runner's own process space. Production use against untrusted stores needs a sandboxed browser (a container or a separate VM).
- **Shared credentials.** Teammates share one `.env` out of band. Production needs a secrets manager and per-operator identities.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
