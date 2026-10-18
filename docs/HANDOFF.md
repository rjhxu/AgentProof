# Handoff: AgentProof as of 2026-10-18

**This document is for the team to keep working from.** It says what exists on `main`, how to run and test every part, what was validated live, and what to do next. Everything referenced is in the repo except the two secrets in `.env` (the model key and the GitHub App key), which are shared out of band, never through git.

## 1. What we built, in one paragraph

AgentProof runs four AI shopping agents (Alpha: accessibility tree only; Beta: screenshots; Sigma: both; Gamma: catalog and cart API, no model) against a synthetic store with five planted agent-compatibility bugs. Deterministic code verifies each run, attributes failures across agents, and writes per-run and per-mission reports. The code-fix agent then reads those reports and a snapshot of the store's GitHub repository, asks a cheap model for a minimal source change, turns the model's edits into a diff by code, validates the diff with seven code-written checks (scope, dependencies, size, content policy, `git apply`, `tsc`, and a real rerun of the failing agent on the patched store), and delivers it as a diff, a branch, or a **draft pull request**. It never merges. On the private test repo it fixed all five bugs on the first attempt, in 1 to 9 lines each, for about four cents of model time in total, and the agents then pass every mission on the repaired store.

## 2. Where things are

| What                                                    | Where                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Architecture, routes, disk layout                       | [ARCHITECTURE.md](./ARCHITECTURE.md)                                                                      |
| The four agents                                         | [AGENTS.md](./AGENTS.md); live results on the bugged and fixed store: [RESULTS.md](./RESULTS.md)          |
| The code-fix agent: design, threat model, GitHub access | [CODEFIX.md](./CODEFIX.md)                                                                                |
| The code-fix agent: live results and costs              | [CODEFIX-RESULTS.md](./CODEFIX-RESULTS.md)                                                                |
| The five planted bugs and reference fixes               | [storefront/bugs-and-fixes.md](./storefront/bugs-and-fixes.md); grader: `storefront/verify-scenarios.mjs` |
| Demo runbook                                            | [DEMO.md](./DEMO.md)                                                                                      |
| Conventions, ownership, gotchas                         | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                      |
| Remaining tasks by owner                                | [WORKPLAN.md](./WORKPLAN.md)                                                                              |
| Deadlines and judging criteria                          | [TRACKS.md](./TRACKS.md)                                                                                  |

Repositories:

- `zacharyli293680/DubHacks` (this monorepo; `main` is always green).
- `rjhxu/northwind-storefront` (private): the blind export of the store, tag `baseline` = every bug present. The code-fix agent's six draft pull requests are open there (#1 to #5 opened with Ryan's token, #6 opened by the GitHub App). Anyone who should test pull requests or merge them there needs collaborator access from Ryan; the app never merges, and neither should a demo.

Secrets in `.env` (copy from `.env.example`, then fill):

- `ANTHROPIC_API_KEY`: the team model key.
- `AGENTPROOF_GITHUB_APP_ID`, `AGENTPROOF_GITHUB_APP_PRIVATE_KEY`, `AGENTPROOF_GITHUB_APP_SLUG`: the runner's GitHub App `agentproof-fcb9`, installed on the `rjhxu` account. With these three lines every teammate acts as the same app: private repos it is installed on clone without a token, and pull requests open as the app. The runner's one-click setup page writes exactly these lines, so re-registering is also a one-click affair if the key is ever rotated.

## 3. How to run it

```bash
pnpm install && pnpm playwright:install
cp .env.example .env            # add ANTHROPIC_API_KEY and the AGENTPROOF_GITHUB_APP_* lines
STOREFRONT_PORT=5050 pnpm dev:store              # macOS holds :5000 (AirPlay)
set -a; . ./.env; set +a; STOREFRONT_URL=http://localhost:5050 pnpm dev:runner   # see the tsx watch note below
pnpm dev:web                                      # http://localhost:3000 (Gamma flow + repository connection today)
pnpm typecheck && pnpm test && pnpm format:check  # what CI runs; 885 tests
```

`tsx watch` (the `dev` scripts) drops `--env-file-if-exists` when it restarts after a file change, so a long-lived dev runner silently loses `.env`. Export the variables in the shell first, as above, or restart the runner after edits.

## 4. How to test each part

**The store and the planted bugs**

```bash
node docs/storefront/verify-scenarios.mjs --expect=bugs      # every bug present, control OK
curl localhost:5050/health                                   # {"hoodieVariantId":"HOODIE-001-S"} is Bug B showing
```

**One agent, one scenario, no runner**

```bash
pnpm cli -- --agent gamma --bug A        # no model: Gamma fails Bug B through the cart API
pnpm cli -- --agent alpha --bug A        # Alpha fails on the size picker; report under data/artifacts/cli/<runId>
```

**All agents through the runner, with the mission report**

```bash
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma --store http://localhost:5050
```

Expected outcomes for every agent and scenario are the tables in [RESULTS.md](./RESULTS.md).

**The code-fix agent, end to end** (needs a failed run and the store repo)

```bash
node scripts/run-mission.mjs --bug A --agents alpha --store http://localhost:5050     # prints the run id
node scripts/codefix.mjs --run <runId> --repo https://github.com/rjhxu/northwind-storefront \
  --store-root "" --mode pull_request --rematch
```

With the app lines in `.env`, no token is needed: the connection shows `accessVia: github_app`, and the fix runs collect, localize, propose, validate, review, rematch (it boots the patched store from a worktree and reruns the same agent), then pushes an `agentproof/*` branch and opens a draft PR as the app. `--mode diff` keeps everything local; `--mode branch` pushes and gives you the "open a pull request" link instead. The record is at `GET /codefix/<id>` (JSON), `/codefix/<id>/report.md` (what the PR body shows) and `/codefix/<id>/patch.diff`; artifacts are under `data/artifacts/codefix/<id>/`. Expected: one attempt, one file, 1 to 9 changed lines, all seven checks passed, cost under half a cent. If the review says "concerns", read its notes: it is advisory and sometimes strict.

**Testing a pull request the agent opened**

```bash
cd ../northwind-storefront                                        # or clone the repo
git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>
git worktree add ../northwind-fix origin/<branch>
(cd ../northwind-fix && npm ci --ignore-scripts && STOREFRONT_PORT=5051 npm run start)
STORE_URL=http://localhost:5051 node docs/storefront/verify-scenarios.mjs   # the scenario reads FIXED, nothing else moves
node scripts/run-mission.mjs --bug A --agents alpha --store http://localhost:5051        # Alpha passes
```

Fetch branches with explicit refspecs as above; several parallel fetches that rely on `FETCH_HEAD` race and serve the same commit. To test all five together, merge the five `origin/agentproof/*` branches into a scratch checkout of `main` (they touch disjoint files) and run the grader with `--expect=fixed`.

**Merging a pull request.** Review it on GitHub like any other PR: the body shows the observed failure, the labelled hypothesis, the diff, the check table, the review and the rematch. Mark it ready and merge it yourself; the agent cannot. Remember that merging into the test repo's `main` removes a bug from the demo baseline; the `baseline` tag and the branch-per-PR keep the "before" available.

**The GitHub App itself**

```bash
curl -H 'Origin: http://localhost:3000' localhost:4000/github/app     # configured, app id, slug, install URL; never the key
open http://localhost:4000/github/app/setup                           # register a new app in one click (writes .env)
```

Install the app on a repository at the install URL the status returns. An app is private to the account that registered it, so it can only be installed on repositories that account administers; teammates who want their own test repo either get the current app installed there by its owner or register their own with the setup page.

**The unit and integration tests**

```bash
pnpm --filter @agentproof/codefix test        # 526 tests: evidence, localization, edits/diff round-trips through git, scope, content policy, toolchain, GitHub client allowlist, GitHub App JWT and token scoping, renderer
pnpm --filter @agentproof/runner test         # 49 tests, including the code-fix pipeline end to end with a scripted model and real git
```

## 5. What was validated live

- Every agent on every scenario on the bugged and the reference-fixed store: [RESULTS.md](./RESULTS.md).
- The code-fix agent on the private repo: five bugs, five first-attempt fixes, five passing rematches, five FIXED grades with the human path intact; the five merged together grade FIXED on everything and the agents pass every mission; one more fix delivered entirely through the GitHub App: [CODEFIX-RESULTS.md](./CODEFIX-RESULTS.md).

## 6. Suggested next steps

In priority order against the deadlines (Devpost draft Saturday 10:30 PM, final Sunday 10:00 AM, judging 11:30 AM):

1. **Dashboard** (Zach). The multi-agent arena on top of the Gamma page, plus a code-fix panel: start a fix from a failed run, show the stepper from `GET /codefix/:id/events`, the check table, the diff, the labelled review, the rematch before/after and the PR link. The client methods exist in `apps/web/src/lib/api.ts` (`startCodeFix`, `getCodeFix`, `subscribeCodeFix`, `getGitHubApp`).
2. **Demo and Devpost** (everyone). Extend [DEMO.md](./DEMO.md) with the fix loop: failed Alpha run, connect the repo, the record filling in stage by stage, the draft PR on GitHub as the app, Alpha green on the rematch. Rehearse once; keep the fix ids in CODEFIX-RESULTS.md as the recorded fallback. Say "discovery" and "trust" in the writeup.
3. **Reviewer model.** Haiku's advisory review is sometimes too strict (it rejected fix A over keyboard support before the prompt was corrected). `AGENTPROOF_MODEL_REVIEW=claude-sonnet-5-5` costs about a cent per fix and reads better to judges; compare once on scenario A.
4. **Route the Gamma dashboard repair through the code-fix agent.** `apps/runner/src/gamma-demo.ts` is the last hand-written repair; replacing it removes the only non-generic path.
5. **Vihan's two small items**: move `diagnose()` from the deprecated `getClaude()` to `getLlm()` with the `diagnosis` role, and the one-line `registerErrorHandler()` swap in the runner's `server.ts`.
6. **Hardening left open** (see CODEFIX.md section 6): the content policy and injection scans are line-level tripwires; a second reviewer pass on a stronger model, or a requirement that the rematch pass before any delivery (today it is opt-in with `--rematch`), would tighten the loop for a production story.
7. **Housekeeping**: shrink `apps/storefront/public/images/canvas-tote.jpeg` in the monorepo too (it is only shrunk in the export); delete the handful of errored runs created when a runner lost its key; add teammates as collaborators on the private store repo.

## 7. Things that bit us, so they don't bite you

- Port 5000 is held by macOS; use 5050 and keep `STOREFRONT_URL` in sync.
- A runner without the model key fails runs instantly with `No LLM provider configured`; check `pnpm llm:smoke` first.
- GitHub rejects an app manifest whose webhook URL is not public, even inactive; the manifest carries no webhook block.
- GitHub installation tokens are a few hundred characters with dots and hyphens; validators must allow `[A-Za-z0-9._-]`.
- The Claude-in-Chrome extension cannot drive `localhost` pages; open the runner's setup page in a normal browser tab.
- After a non-additive change to a shared schema, old rows in `data/agentproof.db` fail to parse; delete the database.
