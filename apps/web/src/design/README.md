# Design sandbox

This folder and the routes under `src/app/design/` exist to settle the dashboard's interface and experience before anything is wired to the runner. The brief, the screen inventory and the decisions log are in [`docs/DESIGN.md`](../../../../docs/DESIGN.md).

## Rules

1. **Nothing here imports `src/lib/api.ts`, fetches, or opens an event stream.** Screens render fixtures only. Wiring happens later, outside this folder.
2. **Components take props and nothing else.** Types come from `@agentproof/shared`. No module-level state, no environment variables.
3. **Fixtures are recorded reports, not hand-written objects.** `fixtures/index.ts` parses each JSON with the shared Zod schema, so a backend schema change shows up at `pnpm typecheck` and `pnpm --filter @agentproof/web test`, not at wiring time.
4. **Do not touch `src/app/page.tsx`, `src/components/`, or `src/lib/`** from this branch. The Gamma flow keeps working underneath until a designed screen replaces it.
5. **No new dependencies without a line in the decisions table** in `docs/DESIGN.md`.

## Layout

```
src/design/
  README.md          this file
  screen-shell.tsx   frame every sandbox screen renders inside: name, flow step, fixture, placeholder area
  components/        designed, props-only components (empty until the design pass produces them)
  fixtures/          recorded reports as JSON plus a typed index
src/app/design/
  page.tsx           index of screens
  launch/  arena/  report/  issue/  rematch/     one placeholder page per screen
```

## Running it

```
pnpm --filter @agentproof/web dev
```

Then open http://localhost:3000/design. The runner and the storefront do not need to be up.
