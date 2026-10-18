# First-pass components

Built for the Arena screen on 2026-10-18 and superseded the same day by the four-step flow under `../flow/`. Every component here takes props typed from `@agentproof/shared` and nothing else.

| File                    | Renders                                                                    | Still used by                                     |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `status-badge.tsx`      | A verdict chip: mark, word and colour; goes monotone under the light theme | The flow's Scan lanes, the Arena                  |
| `checkpoint-matrix.tsx` | Checkpoints down, agents across, with a legend                             | The flow's collapsed "all checkpoints", the Arena |
| `mission-bar.tsx`       | The mission, store host, agent count, elapsed, total spent                 | The Arena only                                    |
| `inspection-strip.tsx`  | Sample live-page findings                                                  | The Arena only                                    |
| `agent-panel.tsx`       | One agent's panel with viewport, steps and verdict                         | The Arena only                                    |
| `cost-strip.tsx`        | Cost bars per agent and the computed headline                              | The Arena only                                    |
| `attribution-list.tsx`  | Attribution sentences with categories                                      | The Arena only                                    |

When the flow is accepted, delete the Arena page and the five Arena-only files in one commit. Formatting helpers live in `../format.ts`.
