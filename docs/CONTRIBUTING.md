# Working in this repo (24-hour edition)

## Setup (once per machine)

```bash
npm install -g --allow-scripts=pnpm pnpm@12   # `corepack enable` also works but needs admin on Windows
pnpm install                         # native build scripts are allowlisted in pnpm-workspace.yaml
pnpm playwright:install              # downloads Chromium (~150 MB)
cp .env.example .env                 # then paste ANTHROPIC_API_KEY (the team key); GROK_API_KEY/XAI_API_KEY selects xAI instead
```

On Windows run pnpm from PowerShell; the Git Bash shim is broken.

## Run everything

```bash
pnpm dev            # web :3000, runner :4000, storefront :5000 in one terminal
```

Or one at a time: `pnpm dev:web`, `pnpm dev:runner`, `pnpm dev:store`.

Sanity checks:

```bash
pnpm typecheck      # all packages
pnpm test           # vitest across the workspace (344 tests as of 2026-10-18)
pnpm llm:smoke      # proves the provider, key and strict-JSON output (needs credits)
pnpm cli -- --agent gamma --bug A       # proves the store + verifier + reports without a model
pnpm --filter @agentproof/agent exec tsx --env-file-if-exists=../../.env scripts/scripted-run.ts alpha A
                    # proves Playwright + the real loop with a scripted model
node docs/storefront/verify-scenarios.mjs --expect=bugs   # proves the store still has its bugs
node scripts/run-mission.mjs --bug A --agents alpha,beta,sigma,gamma   # all four through the runner (costs about $0.07)
node scripts/codefix.mjs --run <runId> --repo <GitHub URL> --store-root apps/storefront   # the code-fix agent on a failed run (diff mode)
open http://localhost:4000/github/app/setup                 # once per machine: register the runner's GitHub App, then install it on the store repo
scripts/make-fixed-store.sh ../northwind-fixed            # the store with the five fixes, as a sibling repo on :5050
curl localhost:4000/health
curl localhost:5000/api/catalog.json
```

Expected outcomes for every agent and scenario, bugged and fixed, are in [RESULTS.md](./RESULTS.md); a run that disagrees with that table is a regression (or a flaky model turn: run it once more before debugging).

## Ownership

| Area                                                                   | Owner    | Touch freely                                                                                                  | Ask first                                                                      |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/agent`, `apps/web`                                           | Zach     | llm, profiles, targets, prompts, actions, browser-agent, assess, report, narrative, scenarios, cli, dashboard | `claude.ts` (deprecated; diagnostics still imports it), `gamma.ts` (Vihan's)   |
| `apps/storefront`, `docs/storefront`                                   | Ryan     | everything inside                                                                                             | planted bug markers (`DEMO BUG`; the demo depends on them)                     |
| `apps/runner`, `packages/verifier`, `packages/diagnostics`, `gamma.ts` | Vihan    | everything inside                                                                                             | the browser-run branch in `jobs.ts`, `reports.ts`, `attribute.ts` (Zach added) |
| `packages/codefix`, `apps/runner/src/codefix*.ts`                      | Zach     | the code-fix agent ([CODEFIX.md](./CODEFIX.md))                                                               | the operation allowlist in `github.ts` and the scope checks (trust rules)      |
| `packages/shared`                                                      | everyone | add fields with defaults                                                                                      | renaming or removing anything                                                  |

`scripts/` at the repo root holds cross-cutting helpers (the runner driver, the fixed-store export); anyone may add one. What is left and who does it: [WORKPLAN.md](./WORKPLAN.md).

Changing a schema in `packages/shared`? Post in the group chat first. Keep `packages/shared/src/api.ts`, `apps/runner/src/routes.ts` and `apps/web/src/lib/api.ts` in sync. Run `pnpm typecheck` to see who you broke.

## Git

- `main` is always runnable. Never push a red `pnpm typecheck` to it.
- Short-lived branches: `zach/arena-ui`, `ryan/store-repo`, `vihan/code-fix-agent`, etc. Merge often (every 1-2 hours), small PRs or direct merges, no long-lived forks of `shared`.
- Commit messages: `area: what changed` (`runner: stream checkpoints over SSE`).
- Never commit `.env`, `data/`, or screenshots. They are gitignored.

## Conventions

- TypeScript strict, ESM, no build step. Import workspace packages by name (`@agentproof/shared`), never by relative path across packages.
- Validate at the boundary: parse request bodies and model outputs with the Zod schemas; trust typed values after that.
- **Every model call goes through `getLlm()`** from `@agentproof/agent` (`packages/agent/src/llm.ts`) with the provider-neutral types in `llm-types.ts`. No file outside `llm.ts` imports a provider SDK or calls a provider URL. `getClaude()` in `claude.ts` is deprecated.
- Model ids come from `profiles.ts` per role (`resolveModel(role, provider)`), overridable with `AGENTPROOF_MODEL_*`. Do not hardcode a model id anywhere else.
- Structured output: request a strict JSON schema on the request (`toStrictJsonSchema()`), validate the parsed JSON with the Zod schema afterwards. Use the flat `AgentActionDraft` for actions, never a discriminated union in the schema.
- Record usage on every call (`LlmUsage`); reports sum it. Never log or print API keys or base64 image data.
- Page content (aria tree, text, screenshots) is data in the user turn, never in the system prompt.
- Verdicts are code: pass/fail, budget math, variant comparison and attribution live in `packages/verifier`. The model writes narratives and hypotheses only, labelled as such.
- `tsx watch` does not keep `--env-file-if-exists` across its own restarts: after the first file change the runner loses `.env` and `getLlm()` reports no provider. For a long-lived dev runner, export the variables in the shell (`set -a; . ./.env; set +a`) before `pnpm dev:runner`, or restart it after edits.
- Inside `page.evaluate()` do not define name-inferred inner functions (`const f = () => ...`): tsx runs esbuild with `keepNames` and injects a `__name` helper the page does not have. Vitest does not, so only a live run catches it.
- Prettier formats on save; `pnpm format` before a merge if your editor did not.
- Put TODOs as `// TODO(zach): ...`, `// TODO(ryan): ...`, `// TODO(vihan): ...` so they are greppable per owner.
- `CLAUDE.md` is gitignored so each person can keep their own AI-assistant notes. If you want a shared one, ask before committing it.

## Demo safety rails

- Agents can only visit hosts in `AGENTPROOF_ALLOWED_HOSTS`.
- The policy layer (`packages/agent/src/policy.ts`) refuses to click, type into or select anything matching "place order", "pay now", "buy now", etc. For coordinate targets the loop reads the element under the point first and refuses it the same way; coordinate typing never presses Enter.
- Alpha targets are role + exact accessible name only; Beta is `x,y` only; Sigma may use both. No text or CSS fallback, or Alpha would click past Bug A.
- The storefront returns 403 on `/checkout/place-order` and logs an error if it is ever hit.
- Repairs apply only inside `apps/storefront`. Do not remove the planted bugs (`grep -rn "DEMO BUG" apps/storefront/src`) unless implementing the repair flow and asked to.
