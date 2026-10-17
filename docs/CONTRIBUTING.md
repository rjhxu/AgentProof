# Working in this repo (24-hour edition)

## Setup (once per machine)

```bash
npm install -g --allow-scripts=pnpm pnpm@12   # `corepack enable` also works but needs admin on Windows
pnpm install                         # native build scripts are allowlisted in pnpm-workspace.yaml
pnpm playwright:install              # downloads Chromium (~150 MB)
cp .env.example .env                 # then paste your ANTHROPIC_API_KEY
```

## Run everything

```bash
pnpm dev            # web :3000, runner :4000, storefront :5000 in one terminal
```

Or one at a time: `pnpm dev:web`, `pnpm dev:runner`, `pnpm dev:store`.

Sanity checks:

```bash
pnpm typecheck      # all packages
pnpm test           # vitest across the workspace
pnpm --filter @agentproof/agent smoke   # proves API key + Playwright work
curl localhost:4000/health
curl localhost:5000/api/catalog.json
```

## Ownership

| Area                                               | Owner    | Touch freely                             | Ask first                                  |
| -------------------------------------------------- | -------- | ---------------------------------------- | ------------------------------------------ |
| `apps/web`                                         | Dev 1    | everything inside                        | –                                          |
| `packages/agent`                                   | Dev 2    | browser-agent, mission-generator, policy | `claude.ts` (shared client)                |
| `apps/storefront`, `packages/verifier`, `gamma.ts` | Dev 3    | everything inside                        | planted bug markers (demo depends on them) |
| `apps/runner`, `packages/diagnostics`              | Dev 4    | everything inside                        | –                                          |
| `packages/shared`                                  | everyone | add fields with defaults                 | renaming or removing anything              |

Changing a schema in `packages/shared`? Post in the group chat first. Run `pnpm typecheck` to see who you broke.

## Git

- `main` is always runnable. Never push a red `pnpm typecheck` to it.
- Short-lived branches: `dev1/arena-ui`, `dev2/alpha-loop`, etc. Merge often (every 1–2 hours), small PRs or direct merges, no long-lived forks of `shared`.
- Commit messages: `area: what changed` (`runner: stream checkpoints over SSE`).
- Never commit `.env`, `data/`, or screenshots. They are gitignored.

## Conventions

- TypeScript strict, ESM, no build step. Import workspace packages by name (`@agentproof/shared`), never by relative path across packages.
- Validate at the boundary: parse request bodies and Claude outputs with the Zod schemas; trust typed values after that.
- Any Claude call goes through `getClaude()` from `@agentproof/agent` and uses `MODEL`. Use `messages.parse` + `zodOutputFormat` for anything that must come back as JSON.
- Prettier formats on save; `pnpm format` before a merge if your editor did not.
- Put TODOs as `// TODO(devN): ...` so they are greppable per owner.

## Demo safety rails

- Agents can only visit hosts in `AGENTPROOF_ALLOWED_HOSTS`.
- The policy layer refuses to click anything matching "place order", "pay now", etc.
- The storefront returns 403 on `/checkout/place-order` and logs an error if it is ever hit.
- Repairs apply only inside `apps/storefront`.
