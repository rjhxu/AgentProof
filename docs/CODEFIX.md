# The code-fix agent

Turns a failed run into a reviewable fix of the store's source: a validated unified diff, optionally pushed to an `agentproof/*` branch or opened as a **draft** pull request. It never merges. Live results are in [RESULTS.md](RESULTS.md#code-fix-agent-on-the-private-store-repository).

## 1. What it does, and never does

**Does**

- Reads the evidence AgentProof already wrote for the failed run: the failed checkpoint, the cross-agent attribution, the failure point with what the agent perceived, the step log and the observed cart.
- Finds the files most likely to hold the cause by code, before any model sees source.
- Asks a cheap model for a diagnosis and a minimal change, as exact search/replace edits. Code turns the edits into the diff.
- Validates the diff with code and, optionally, proves it with a real rerun of the failing agent against the patched store.
- Records everything (evidence, files, every attempt, every check, cost, timeline) in one `CodeFix` document with a Markdown rendering.

**Never**

- Merges, approves, marks ready for review, pushes to the default branch, force-pushes or deletes a branch. The GitHub client cannot express those operations, and tests assert it.
- Stores or logs a token.
- Runs repository code outside the opt-in rematch.
- Lets the model decide a status. Model text lives in `proposal`, `review` and `inferred*` fields and is rendered as a hypothesis.
- Shows the model anything outside the store's `src/` directory.

## 2. GitHub access

**The GitHub App is the primary identity.** A per-request fine-grained token is the fallback.

- **Registration.** Start the runner and open `http://localhost:4000/github/app/setup`. One click runs GitHub's manifest flow, and the runner writes `AGENTPROOF_GITHUB_APP_ID`, `AGENTPROOF_GITHUB_APP_PRIVATE_KEY` (or `_PRIVATE_KEY_FILE`) and `_SLUG` into `.env` (owner-only permissions). Then install the app on the repositories AgentProof may work on. `GET /github/app` reports the install URL.
- **Permissions.** Contents (read and write), Pull requests (read and write), Metadata (read). The app has no webhook.
- **Tokens.** Each operation signs an RS256 JWT (valid for about 10 minutes) and mints an installation token scoped to one repository and the minimum permissions: `contents: read` to clone, `contents: write` and `pull_requests: write` to deliver. Tokens expire within an hour and are never persisted. When the app isn't installed on the repository, the request token is used. Without either, the clone is anonymous and delivery is refused with the install link.
- **Allowlist.** The client permits exactly `GET /repos/{o}/{r}`, `POST /repos/{o}/{r}/pulls`, `GET /repos/{o}/{r}/installation`, `POST /app/installations/{id}/access_tokens`, `GET /app/installations` and `GET /installation/repositories`, the last two with pagination only.
- **Drafts.** Pull requests are always drafts, so GitHub blocks a merge until a human marks one ready.

The app is private to the account that registered it, so it can only be installed on repositories that account administers.

## 3. The pipeline

Each stage writes into the `CodeFix` document and publishes a `CodeFixEvent` on `GET /codefix/:id/events`.

```
collect  ->  localize  ->  propose  ->  validate  ->  review  ->  rematch (opt-in)  ->  deliver
(code)       (code)        (model)      (code)        (model)     (code + real run)      (code)
```

1. **collect.** Builds an evidence bundle from existing report fields only: mission requirements, the failed checkpoint and its code-written detail, the attribution, the failure point, at most 30 step lines and the observed cart. It is capped at about 9,000 characters and stored verbatim in `input.evidenceText`. No screenshots or traces.
2. **localize.** Derives weighted search terms (product, variant ids, attributes, the accessible names the agent looked for, category keywords such as `aria-hidden` or `role=`). It reads `src/**` source files from the bare snapshot with `git show` and ranks them by hits. The top files go to the model in full within a character budget, and the rest as outlines. The ranking is stored, so the UI can show why each file was picked.
3. **propose.** One `getLlm()` call on the `codefix` role (Haiku by default). Strict JSON returns a diagnosis, `edits` as `{ path, search, replace, reason }` and a summary. The model may instead ask for files it saw only as outlines (`needsFiles`), once. Each edit must match exactly once in its file. Code writes the diff and its hunk headers.
4. **validate.** Code only: `paths_in_scope`, `no_dependency_changes`, `size_within_bounds`, `content_policy`, `applies_cleanly` (`git apply --check` in a fresh worktree) and `typecheck` (`npm ci --ignore-scripts` and `tsc --noEmit`, or `skipped` when there is no lockfile or tsconfig). If a check fails, its details go back to the model for one more attempt (`maxAttempts`, default 2).
5. **review** (on by default). One call on the `review` role returns `approve`, `concerns` or `reject` with notes. It is advisory and never changes the diff or the status. Sonnet (`AGENTPROOF_MODEL_REVIEW=claude-sonnet-5-5`) is the recommended upgrade.
6. **rematch** (`rematch: true`). Boots the patched store from the worktree on a free loopback port with a scrubbed environment, reruns the same agent on the same mission, stops the store and stores the `RunComparison`. A fix whose rematch fails is not delivered.
7. **deliver.**
   - `diff` stores and serves the patch.
   - `branch` commits as `AgentProof <bot@agentproof.local>` on `agentproof/<scenario>-<id>` (validated against `^agentproof/[a-z0-9][a-z0-9._-]{0,60}$`), pushes, and records a prefilled "open a pull request" link.
   - `pull_request` does the same, then opens a draft with the Markdown record as its body.

There is no orchestrator model. Sequencing, selection and verdicts are code. A fix costs two to three cheap model calls.

## 4. The record

`CodeFix` is defined in `packages/shared/src/codefix.ts`.

| Field                 | Written by | Contents                                                                                       |
| --------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `status`, `stage`     | code       | Running, succeeded or failed, and the current stage                                            |
| `input`               | code       | Observed failure, attribution, the exact evidence text the model received                      |
| `localization[]`      | code       | Ranked files, matched terms, whether each was sent in full, flags                              |
| `attempts[]`          | mixed      | Model, proposal (inferred), diff and edit errors (code), validation (code), prompt fingerprint |
| `finalAttempt`        | code       | Which attempt produced the delivered diff                                                      |
| `review`              | model      | Advisory verdict and notes, rendered as a second opinion                                       |
| `delivery`            | code       | Mode, branch, commit, compare URL, PR URL, draft flag, actor, error                            |
| `rematch`             | code       | Rerun id and the before/after comparison                                                       |
| `usage`, `timeline[]` | code       | Tokens and cost across all calls, timestamped stage log                                        |

The Markdown rendering (`renderCodeFixMarkdown`) is the pull request body. It contains the observed failure, the labelled hypothesis, the diff, the check table, the labelled review, the rematch, the cost, and the line "Opened as a draft by AgentProof. A human reviews and merges; the agent cannot."

## 5. Validation checks

| Check                   | Fails when                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `paths_in_scope`        | A path is absolute, contains `..`, is not an allowlisted source file, or is outside `<storeRoot>/src` |
| `no_dependency_changes` | A change touches `package.json`, lockfiles, `.github/`, `.env*`, scripts or Dockerfiles               |
| `size_within_bounds`    | The diff exceeds 5 files or 300 changed lines                                                         |
| `content_policy`        | Added or removed lines break a rule (see section 6)                                                   |
| `applies_cleanly`       | `git apply --check` fails in a fresh worktree at the snapshot commit                                  |
| `typecheck`             | `tsc --noEmit` exits non-zero                                                                         |
| `rematch`               | The rerun doesn't pass, or a checkpoint regresses                                                     |

## 6. Threat model and mitigations

| Threat                                      | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection through page content       | `sanitizeEvidenceText()` strips control, zero-width and bidi characters and cuts long lines. `scanUntrustedText()` records `evidenceFlags`. The text sits inside an `UNTRUSTED` fence keyed by an unpredictable per-fix nonce, and the system prompt states the trust boundary.                                                                                                                                                         |
| Prompt injection through repository content | Only regular `<storeRoot>/src/**` source files (no symlinks, submodules or `docs/`). Binary, oversized, invisible-character and credential-bearing files are excluded and can't be edited. Instruction-like files are fenced and flagged.                                                                                                                                                                                               |
| Malicious or over-reaching model output     | Zod bounds on edit count and lengths. Edits must be unique verbatim matches in files shown in full. Scope, dependency and size checks run first. `content_policy` rejects external URLs, network calls, dynamic code, process or filesystem access, script injection, obfuscation, invisible characters, secrets, new package imports, CSS that hides controls and removed payment guards. Then `git apply`, `tsc` and the rematch run. |
| Model text reaching people and other bots   | `escapeModelText()` HTML-escapes, strips invisible characters and caps model text in titles and bodies. Every model field is labelled as a hypothesis.                                                                                                                                                                                                                                                                                  |
| Credential exposure                         | Tokens are request-scoped or minted per operation and never persisted. Git gets them only through the environment. Child processes get an allowlisted environment (no `*KEY*`, `*TOKEN*`, `GIT_*`, `npm_config_*`). The app key never leaves the runner. Errors never echo tokens.                                                                                                                                                      |
| Repository code execution                   | Reads use a bare clone, `git show` and `git worktree`, with hooks disabled. Installs use `npm ci --ignore-scripts`. The rematch is opt-in, loopback-only, time-boxed and killed afterwards.                                                                                                                                                                                                                                             |
| Destructive GitHub actions                  | The operation allowlist; pushes only to `agentproof/*`, never forced; drafts only; one repository and the minimum permissions per token.                                                                                                                                                                                                                                                                                                |
| Runaway cost or time                        | At most 2 attempts plus one file round, with token caps on each call. Timeouts: 120 s per model call, 60 s for git, 180 s install, 120 s typecheck, 45 s boot, 10 min rematch. One fix per run at a time.                                                                                                                                                                                                                               |
| Audit                                       | Exact evidence text, a SHA-256 and character count of every prompt, and every attempt, check, flag and credential kind are stored with the record.                                                                                                                                                                                                                                                                                      |

Known gaps are listed in [SECURITY.md](SECURITY.md#known-limitations).

## 7. Module map

| Path                                                      | Contents                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/codefix/src/evidence.ts`                        | Evidence bundle and its text rendering                                        |
| `packages/codefix/src/localize.ts`                        | Search terms, candidate filter, ranking, outlines                             |
| `packages/codefix/src/prompts.ts`, `propose.ts`           | Proposer and reviewer prompts and calls                                       |
| `packages/codefix/src/edits.ts`                           | Exact edits to a git-compatible unified diff                                  |
| `packages/codefix/src/scope.ts`, `content-policy.ts`      | Path, dependency, size and content checks                                     |
| `packages/codefix/src/toolchain.ts`                       | `git apply`, install and `tsc` with timeouts and a scrubbed environment       |
| `packages/codefix/src/untrusted.ts`                       | Nonce fences, sanitizing, injection and secret scans, escaping                |
| `packages/codefix/src/github.ts`, `github-app.ts`         | Allowlisted client, draft PRs, branch names, app JWT, scoped tokens, manifest |
| `packages/codefix/src/render.ts`                          | Markdown record and pull request title                                        |
| `apps/runner/src/codefix.ts`, `codefix-routes.ts`         | Orchestrator and HTTP routes                                                  |
| `apps/runner/src/github-app.ts`, `github-app-routes.ts`   | Credential resolution (app first, token fallback), setup and status routes    |
| `apps/runner/src/repositories.ts`, `repository-routes.ts` | Hardened git wrapper, snapshot reads, worktrees, commit and push              |

## 8. Running it

```bash
node scripts/run-mission.mjs --bug A --agents alpha                     # a failed Alpha run; prints the run id
node scripts/codefix.mjs --run <runId> --repo https://github.com/<owner>/<repo> \
  --store-root "" --mode pull_request --rematch
```

`--store-root` is the store's directory inside the repository: `apps/storefront` for this monorepo, empty for a standalone store. Nothing outside it is read or written. `--mode diff` keeps everything local, `--mode branch` pushes and prints the "open a pull request" link, and `--token-env GITHUB_TOKEN` supplies a token when the app isn't installed. The record is at `GET /codefix/<id>`, `/report.md` and `/patch.diff`.
