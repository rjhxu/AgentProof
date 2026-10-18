# Designed components

Empty until the design pass produces them. Every component here takes props typed from `@agentproof/shared` and nothing else, so it moves to the wired dashboard unchanged.

Planned, from the screen inventory in `docs/DESIGN.md`:

- `agent-panel` — one agent: name, strategy, model, latest screenshot, steps, status, cost.
- `checkpoint-matrix` — checkpoints down, agents across, pass / fail / not run.
- `attribution-line` — the one sentence that says which agent passed, which failed, and what that means for the store.
- `cost-strip` — cost per agent, with the cheapest-agent thesis visible.
- `issue-card` — observed facts first, hypothesis labelled, the connect-repository ask, link to the diff.
- `diff-view` — the proposed patch and Apply.
- `before-after` — the rematch comparison.

Add a line to the decisions table in `docs/DESIGN.md` when a component is added or renamed.
