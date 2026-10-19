# Dashboard design

The dashboard (`apps/web`) is a four-step flow that gives the merchant one thing at a time. It is designed for 1440×900 first and adapts down to laptop and projector heights.

## The flow

| Step         | The user                | The screen                                                                                                                                                                                                                                  |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Store    | Pastes a store URL      | One field and one button. The first submit derives the mission and starts the scan. Coming back shows the mission, with **Change**.                                                                                                         |
| 2 · Scan     | Watches                 | One shopper on stage at a time (Alpha, Beta, Gamma, Sigma), showing the store as that shopper perceives it and its latest action in plain words. A roster with verdicts and cost bars stays on screen. Fits the viewport without scrolling. |
| 3 · Findings | Reads the problems      | A problem list and the selected problem: where it broke, what was observed, how each shopper did, and what to change. **All checkpoints** shows the matrix. Nothing about code.                                                             |
| 4 · Fixes    | Connects the repository | Install or connect, then one card per problem: the seven checks, the second opinion, the folded patch and the draft pull request. The flow ends here; merging stays with the merchant.                                                      |

A stepper in the header shows progress. Completed steps can be revisited, and nothing from a later step shows before its time.

## Principles

- **Verdicts are code.** The UI shows the verifier's statuses and the report's headline and attribution verbatim. Model text is labelled as a hypothesis or as the model's summary.
- **Evidence before explanation.** Observed facts come before any hypothesis.
- **Cost is a first-class number.** Every shopper shows its cost on one shared scale, and Sigma's multiple of Alpha is stated.
- **Ask for the repository only on Fixes.** Launch takes a URL and nothing else.
- **Agents never pay.** The mission and the scan both say the shoppers stop before payment.
- **Recordings are labelled.** A replayed run says "recording", not "live".

## Visual system

- **Palette.** A light theme scoped by `data-theme="light"`. The neutrals are `#ffffff`, `#15181e` ink, `#5b6170` muted, `#f6f7f9` and `#eceef2` panels, and `#e2e5ea` lines. One accent, `#2563eb`, marks progress, primary actions and diff additions. One failure color, `#dc2626`, marks failures and diff removals. A pass is ink with a check mark, never green. Both colors clear 3:1 on white and stay distinguishable under protanopia.
- **Identity.** Agents are identified by name, position and sense icons, never by hue. Color is reserved for verdicts.
- **Type.** System sans: 28 px semibold titles, 15 px body, 13 px meta, tabular numbers.
- **Motion.** `motion/react` inside `MotionConfig reducedMotion="user"`. Transitions are short fades and rises (about 220 ms). Replay pacing is content and survives reduced motion.
- **Icons.** Hand-drawn inline SVG, 1.5 px strokes in `currentColor`, with no icon library.

## Code

| Path                            | Purpose                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/page.tsx`, `src/live/` | The live flow. It is the only code that talks to the runner (through `src/lib/api.ts`). A sequencer paces the four parallel runs onto the stage one at a time. |
| `src/design/flow/`              | Props-only step components, the flow state machine, the stepper, the diff view, icons and illustrations                                                        |
| `src/design/replay/`            | Turns run events into per-shopper lane state. The live stream and the fixture replay feed the same reducer.                                                    |
| `src/design/fixtures/`          | Recorded reports parsed with the shared Zod schemas, for the sandbox at `/design/flow`                                                                         |
| `src/app/gamma/`                | The older single-agent Gamma page, which applies the demo repair and shows the rematch                                                                         |

Sandbox rules are in [`apps/web/src/design/README.md`](../apps/web/src/design/README.md).

## Key decisions

- **Four steps instead of a dense arena.** One screen per step and one primary action per screen. The first-pass Arena screens remain under `/design` for reference.
- **The URL is the only input.** The mission is derived from the store's catalog feed. All four agents run, with no picker.
- **The fixture replay and the live flow share one code path.** The sandbox emits real `RunEvent`s from recorded reports, so wiring didn't change the Scan screen.
- **Checkpoint ticks fill when a run verifies, not during it.** That is when the runner emits them.
- **Problems are ordered by where they broke on the purchase path, not by cost.**
- **Fixes are delivered as draft pull requests,** with patch download as the fallback. Auto-merge and redeploy were rejected.
- **The token field is hidden when the GitHub App is configured.** The token remains a fallback for repositories without the app.
