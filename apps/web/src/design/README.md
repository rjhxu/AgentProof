# Design sandbox

This folder and the routes under `src/app/design/` exist to settle the dashboard's interface and experience before anything is wired to the runner. The brief, the decisions log and the wiring plan are in [`docs/DESIGN.md`](../../../../docs/DESIGN.md).

## Rules

1. **Nothing here imports `src/lib/api.ts`, fetches, or opens an event stream.** Screens render fixtures only. Wiring happens later, outside this folder.
2. **Components take props and nothing else.** Types come from `@agentproof/shared`. No module-level state, no environment variables.
3. **Fixtures are recorded reports, not hand-written objects.** `fixtures/index.ts` parses each JSON with the shared Zod schema, so a backend schema change shows up at `pnpm typecheck` and `pnpm --filter @agentproof/web test`, not at wiring time. The two hand-written exceptions (the Gamma hypothesis text and the repository connection) are flagged in the index.
4. **Do not touch `src/app/page.tsx`, `src/app/layout.tsx`, `src/components/`, or `src/lib/`** from this branch. The Gamma flow keeps working underneath until a designed screen replaces it.
5. **No new dependencies without a line in the decisions table** in `docs/DESIGN.md`.

## Layout

```
src/design/
  README.md          this file
  format.ts          formatting and plain-language helpers shared by every screen
  screen-shell.tsx   frame for the first-pass sandbox screens
  components/        first-pass components (status badge, matrix, panels); see its README
  fixtures/          recorded reports, composed issues and repairs, frames, a typed index
  replay/            recorded reports -> timed run events -> lane state (the wiring seam)
  flow/              the four-step flow: machine, stepper, one component per step, diff view,
                     illustrations, icons, dev controls
src/app/design/
  page.tsx           index of screens
  flow/page.tsx      the four-step flow (server boundary; the only importer of the fixtures)
  arena/ launch/ report/ issue/ rematch/   first-pass screens, superseded, kept for reference
```

## Running it

```
pnpm --filter @agentproof/web dev
```

Then open http://localhost:3000/design/flow. The runner and the storefront do not need to be up. `?step=1..4` opens a step directly; `?speed=` and `?t=end` drive the scan replay; the dev pill in the corner does the same by click and is rendered in development only.
