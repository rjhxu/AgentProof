# Dashboard design: brief, screens, decisions

Owner: **Zach**. Branch: `design/arena-ui`. Sandbox: `apps/web/src/design/` (components and fixtures) and `apps/web/src/app/design/` (one route per screen). Nothing in the sandbox talks to the runner; every screen renders recorded reports from `apps/web/src/design/fixtures/`. The point of this phase is to settle the interface and the experience before wiring. Wiring is a later step and is described at the end.

The sandbox rules are in [`apps/web/src/design/README.md`](../apps/web/src/design/README.md). The intent behind the product is in [SPEC.md](./SPEC.md); the flow the screens follow is the subsection *The user flow — URL first, repository second* in section 2.

## What the dashboard has to do

From [SPEC.md section 10](./SPEC.md#10-mvp-scope-for-24-hours) and the dashboard row in [WORKPLAN.md](./WORKPLAN.md):

- Take a storefront URL and a natural-language mission.
- Let the user pick agents, then show one panel per run with the latest screenshot and the steps so far, live.
- Show the checkpoint matrix: checkpoints down, agents across, pass / fail / not run.
- Show the attribution line (which agent passed, which failed, what that says about the store) and the cost per agent.
- Link to the agent and mission reports.
- Show each issue with its evidence, the labelled hypothesis, the connect-repository ask, the diff and Apply.
- Show the rematch: the same matrix before and after the repair.
- Keep the existing Gamma flow (today's `apps/web/src/app/page.tsx`) working underneath until the new screens replace it.

The demo is a three-minute recorded video at desktop width. Design for 1440 by 900 first. Phone layouts are not required.

## The flow the screens follow

| Step | What the user does                       | Screen        | Sandbox route     |
| ---- | ---------------------------------------- | ------------- | ----------------- |
| 1    | Pastes the URL and the mission           | Launch        | `/design/launch`  |
| 2, 3 | Watches the agents run and get verified  | Arena         | `/design/arena`   |
| 4    | Reads the issues and the evidence        | Report        | `/design/report`  |
| 5    | Connects the repository, reviews the diff | Issue         | `/design/issue`   |
| 6    | Applies, reruns, compares                | Rematch       | `/design/rematch` |

`/design` is the index: links to every screen and its status.

## Screen inventory

| Screen  | Must show                                                                                                                                                     | Fixture                                                                            | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| Launch  | URL field, mission field with an example, agent checkboxes (Alpha, Beta, Sigma, Gamma) with model and cost hint, optional *connect a repository now*, Start   | `hoodieMission` from `@agentproof/shared/fixtures`                                 | todo   |
| Arena   | One panel per agent: name, strategy, model, latest screenshot, step list, status; live-page inspection results while agents run; the checkpoint matrix filling in | `missionABugged` (four agents on Bug A)                                             | todo   |
| Report  | Verdict per agent, the attribution sentence, cost per agent, issue cards (observed facts first, hypothesis labelled), report links                             | `missionABugged`, `runAlphaABugged`                                                | todo   |
| Issue   | One issue: evidence (screenshot, tree excerpt, cart response), the hypothesis, *connect your repo to get a patch for this issue*, the diff, Apply               | `alphaIssue`, `alphaRepair` from `@agentproof/shared/fixtures`                     | todo   |
| Rematch | Before and after: the same matrix twice or one matrix with deltas, which checkpoints flipped, cost of both runs                                                | `missionABugged` vs `missionAFixed`                                                | todo   |

## Principles the design must respect

These come from the project rules and are not open for debate in the design pass.

- **Verdicts are code.** Pass, fail and budget math come from the verifier. The UI never softens or reinterprets them. Anything written by the model is shown as a narrative or a hypothesis and labelled as such.
- **Cost is a first-class number.** Every agent shows what it cost. The thesis is that the cheapest agent (Alpha, text only) should pass. When Alpha fails and a dearer agent passes, the screen says so in one line.
- **Evidence before explanation.** Observed facts (which variant the page showed, which the cart returned) come before any hypothesis.
- **The repository is asked for on the issue, not at launch.** Launch takes a URL and a mission. The connect-repository ask lives on the issue card, with an optional early link on the launch form.
- **Agents never pay.** Checkout review is the last checkpoint. The UI makes *stopped before payment* an explicit, visible state, not an absence.

## Visual language today

`apps/web/src/app/globals.css` defines a dark mission-control palette: `--background`, `--foreground`, `--muted`, `--panel`, `--line`, `--accent`, `--pass`, `--fail`, `--warn`. Tailwind 4 via PostCSS, `motion` for animation, no component library yet. Everything else (type scale, density, agent colour coding, how pass / fail / warn read at a glance, what moves) is for this phase to decide.

## The data the screens render

Recorded on 2026-10-18 through the runner; details in [RESULTS.md](./RESULTS.md) and the table in [DEMO.md](./DEMO.md).

- **Bug A, bugged store, four agents.** Alpha fails *Correct size identified* (no size control in the accessibility tree) and ends with size S in the cart. Beta and Sigma pass. Gamma fails *Cart matches variant* through the cart API (medium id maps to small). Attribution: a semantic interface problem and a product data inconsistency. Costs: Alpha and Beta a quarter of a cent each, Sigma about five cents, Gamma nothing.
- **Bug A, fixed store.** The same Alpha passes in five steps.
- **Control product.** Every agent passes.

## Open questions for this phase

- Arena layout: four panels in a row, two by two, or one focused panel with thumbnails?
- Checkpoint matrix: the DEMO.md table shape (checkpoints down, agents across) or a per-agent timeline?
- Where the attribution sentence lives: banner above the matrix, or caption below it?
- How cost reads: a column, a badge on each panel, or a bar comparing agents?
- Issue card: how much evidence inline before a drawer or detail view?
- Connect repository: inline on the card, or a modal?
- Rematch: two matrices side by side, or one matrix with deltas?
- Motion: what is worth animating (steps arriving, a checkpoint flipping, the rematch delta)?
- Does the sandbox stay in the repo after wiring, or get deleted?

## Decisions

| Date       | Decision                                                                                                         | Why                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 2026-10-18 | Design in a sandbox inside `apps/web` (`src/design`, routes under `/design`) rather than a separate app          | Same Next, Tailwind and types as the real dashboard, so components move over unchanged; no second app to maintain |
| 2026-10-18 | Screens render recorded reports parsed with the shared Zod schemas, never hand-written mock objects              | Real shapes and real numbers; a schema change by the backend shows up at typecheck instead of at wiring |

## Wiring plan (later, not in this phase)

- Components under `apps/web/src/design/components/` take props typed from `@agentproof/shared` and nothing else. Wiring means a page under `apps/web/src/app/` fetches through `apps/web/src/lib/api.ts`, subscribes to run events, and passes the same types in. The components do not change.
- The fixtures are parsed with the shared Zod schemas, so if the runner adds a field the sandbox still typechecks (fields are added with defaults) and the new field is there to design for.
- When wiring is done, the `/design` routes are deleted or gated to development.

Mockups first is fine: `/design <brief>` in Claude Code produces a Claude Design canvas to iterate on before a screen is coded. Link any such artifact in the decisions table.
