# Code-fix agent: live results

The code-fix agent ([CODEFIX.md](./CODEFIX.md)) run for real against the private store repository, with the proposer and the reviewer on `claude-haiku-5-5`. Produced on 2026-10-18 through the runner API with `scripts/run-mission.mjs` and `scripts/codefix.mjs`. Records live under `data/artifacts/codefix/<fixId>/` (gitignored); the fix ids are listed so the files can be found on the machine that ran them.

Setup: the bugged store (`apps/storefront`, same source as the export) on port 5050; the repository `https://github.com/rjhxu/northwind-storefront` (blind export, `baseline` = `d51f863`, 23 files). Scenarios A to E below were connected and delivered with the `rjhxu` token (the GitHub App was registered later in the session); the final run in "GitHub App" below used the app for both. Every fix ran in `pull_request` mode with `typecheck`, `review` and `rematch` on, store root `''`.

## The question this answers

Does the agent fix the planted bug without altering the store beyond the cause, and at what cost? Three judges, in order of authority: Ryan's grader (`docs/storefront/verify-scenarios.mjs`) on the pull-request branch, the agent's own rematch (a real rerun of the failing agent on the patched store), and the advisory model review.

## Scenario A: size chips without semantics (Alpha)

| Item                 | Result                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed run           | `run_f527d60dd60a` (mission `mis_c960e9a04673`), Alpha, 7 steps, $0.0033, `correct_size_identified`: required M, observed S                                                                                                                                            |
| Fix                  | `fix_34c85d45e822`, one attempt, 5 edits in `src/views.ts`, diff +5/−4 (9 changed lines)                                                                                                                                                                               |
| Evidence shown       | 2,213 characters; 5 files in full (`views.ts`, `catalog.ts`, `swatches.ts`, `controls.ts`, `quantity-stepper.ts`), `views.ts` ranked first                                                                                                                             |
| Checks (code)        | `paths_in_scope`, `no_dependency_changes`, `size_within_bounds`, `content_policy` (22 rules, 0 violations), `applies_cleanly`, `typecheck` (`tsc --noEmit` in the worktree): all passed                                                                                |
| Rematch              | `run_1148ddb5c393`: Alpha **passed** on the patched store, 2 checkpoints improved, 0 regressed, 6 unchanged                                                                                                                                                            |
| Review (advisory)    | **reject**: it judged the added `tabindex` and Enter/Space handling as a human-visible change. That reading was wrong for an accessibility fix (keyboard operability is part of a correct radio group) and the reviewer prompt now says so; the other notes were sound |
| Delivery             | branch `agentproof/classic-template-size-chips-are-unlabele-34c85d45` (`8e06286`), draft PR [#1](https://github.com/rjhxu/northwind-storefront/pull/1)                                                                                                                 |
| Grader on the branch | **A FIXED** (agent cart `HOODIE-001-M`, human cart `HOODIE-001-M`), control OK, B to E unchanged: no collateral damage, no HUMAN BROKEN                                                                                                                                |
| Cost of the fix      | 2 model calls, 15,178 input / 4,390 output tokens, **$0.0037**; with the original run and the rematch about $0.010 for the scenario                                                                                                                                    |

What the diff does: it keeps the existing chips and adds `role="radiogroup"` with an accessible name, `role="radio"`, `aria-label`, `aria-checked`, `aria-disabled` for sold-out sizes, roving `tabindex` and Enter/Space handling, and it keeps `aria-checked` in sync in the existing click handler. The hidden `size` input, its posted name and values, and the visible chips are untouched. The reference patch (+3/−42) instead replaces the chips with the store's own `optionGroup()` helper; the agent's change is smaller and surgical, the reference is the better refactor. Both satisfy the rubric ("any fix that gets the semantic shopper to the correct cart without breaking the human shopper").

## Scenario B: legacy variant map on the cart API (Gamma)

| Item                 | Result                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed run           | `run_060afe8488ac` (mission `mis_5a6218f8ca32`), Gamma, $0, `cart_matches_variant` and `catalog_variant_resolves` failed                                                                                                                                |
| Fix                  | `fix_4259e7e2078b`, one attempt, 1 edit in `src/cart.ts`, diff +0/−1: the `'HOODIE-001-M': 'HOODIE-001-S'` entry removed from `LEGACY_VARIANT_MAP`                                                                                                      |
| Evidence shown       | 1,859 characters; 5 files in full, `catalog.ts` and `cart.ts` first                                                                                                                                                                                     |
| Checks (code)        | all six passed (`content_policy`: 0 added lines, 1 removed line)                                                                                                                                                                                        |
| Rematch              | `run_1cfde1d8e660`: Gamma **passed** on the patched store, 2 improved, 0 regressed, 7 unchanged                                                                                                                                                         |
| Review (advisory)    | **concerns**, with checkable notes: confirm every caller of `resolveVariantId()`, confirm the HTML `/cart/add` path does not use the map, confirm the empty map still typechecks. All three hold (the typecheck ran; the grader's human shopper passed) |
| Delivery             | branch `agentproof/structured-cart-api-maps-hoodie-001-m-to-4259e7e2` (`eb7ddb2`), draft PR [#2](https://github.com/rjhxu/northwind-storefront/pull/2)                                                                                                  |
| Grader on the branch | **B FIXED**, control OK, A, C, D, E unchanged                                                                                                                                                                                                           |
| Cost of the fix      | 2 model calls, 15,189 input / 1,828 output tokens, **$0.0024**                                                                                                                                                                                          |

The reference patch is +1/−3 (it empties the map); the agent's one-line removal is the same change.

## Scenarios C, D, E (Alpha)

Same setup, same models, same request. Every fix passed on its first attempt, every rematch passed, and every branch grades FIXED with the human shopper and the control unaffected.

| Scenario | Failed run                            | Fix                                                                                                                                  | Diff  | Checks        | Rematch                                            | Review (advisory)                                                                  | Draft PR                                                   | Fix cost |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| C        | `run_be5edc5ec1a8`, 12 steps, $0.0053 | `fix_fca71d3f042e`: `src/catalog.ts`, `swatchLabels` reordered to match the variant order (navy first)                               | +1/−1 | 7 of 7 passed | `run_7cb65683a136` passed, 2 improved, 0 regressed | concerns: verify the label indexing and other consumers of `swatchLabels`          | [#3](https://github.com/rjhxu/northwind-storefront/pull/3) | $0.0027  |
| D        | `run_1c1964681185`, 7 steps, $0.0030  | `fix_5f393cb011d0`: `src/quantity-stepper.ts`, `aria-label` on the plus and minus buttons, `role="group"` with a name on the wrapper | +3/−3 | 7 of 7 passed | `run_a4487530d349` passed, 1 improved, 0 regressed | concerns: confirm the visible label is not duplicated; suggests exposing the value | [#4](https://github.com/rjhxu/northwind-storefront/pull/4) | $0.0028  |
| E        | `run_fc02eb3088d7`, 6 steps, $0.0026  | `fix_96a077ee5541`: `src/feature-layout.ts`, `aria-hidden="true"` removed from the stage that wraps the buy form                     | +1/−1 | 7 of 7 passed | `run_2fe2e44c2b8c` passed, 5 improved, 0 regressed | approve                                                                            | [#5](https://github.com/rjhxu/northwind-storefront/pull/5) | $0.0025  |

Grader on each branch: C FIXED (agent and human carts `CREW-001-NVY-L`), D FIXED (`SOCK-001-M x3` for both), E FIXED (`HP-100-WIRED x1` for both); the control is OK and the other four scenarios keep their previous status on every branch.

Against the reference patches: C +4/−16 (the reference fixes `swatches.ts` and the data), D +9/−14, E +3/−9. The agent's C fix changes only the data half, which is sufficient because the swatch template indexes labels by position; a reviewer may still prefer the reference's template fix. D and E are the reference fixes' intent in fewer lines.

## All five scenarios

Merged together into one checkout (5 files, +10/−10), the five branches grade FIXED on every scenario with the control OK, and the agents pass every mission against that store (see the end of this document).

| Scenario | Root-cause file (answer key) | Agent's file          | Agent diff | Reference diff | Grader | Rematch | Fix cost |
| -------- | ---------------------------- | --------------------- | ---------- | -------------- | ------ | ------- | -------- |
| A        | `views.ts`                   | `views.ts`            | +5/−4      | +3/−42         | FIXED  | passed  | $0.0037  |
| B        | `cart.ts`                    | `cart.ts`             | +0/−1      | +1/−3          | FIXED  | passed  | $0.0024  |
| C        | `swatches.ts`, `catalog.ts`  | `catalog.ts`          | +1/−1      | +4/−16         | FIXED  | passed  | $0.0027  |
| D        | `quantity-stepper.ts`        | `quantity-stepper.ts` | +3/−3      | +9/−14         | FIXED  | passed  | $0.0028  |
| E        | `feature-layout.ts`          | `feature-layout.ts`   | +1/−1      | +3/−9          | FIXED  | passed  | $0.0025  |

Totals for the five scenarios end to end: fixes $0.0141 (10 Haiku calls), the failing agent runs $0.0142, the proof reruns $0.0105; about **$0.039** in model time. Every fix was a first attempt, so no retry budget was spent.

## Reading the numbers

- **Minimality.** Every diff touches exactly one file, the root-cause file the answer key names (for C, the data half of a two-file cause), in one or two hunks. Scope and size checks bound a fix to 5 files and 300 changed lines; the live fixes used 1 file and between 1 and 9 lines.
- **Cost.** A fix is two Haiku calls: about 15k input tokens (the evidence plus five source files under the 24,000-character budget) and 2k to 4k output tokens, under half a cent. The agent runs around it cost about $0.003 each. A full scenario, including the proof rerun, is about a cent; all five were under four cents. The cost line that matters for the thesis is that the cheapest agent then passes.
- **What the model got wrong.** Nothing in the diffs. The Haiku reviewer's "reject" on A was a definitional error about keyboard support, not a defect in the fix, and it is advisory by design. Sonnet on the `review` role (`AGENTPROOF_MODEL_REVIEW=claude-sonnet-5-5`) is the recommended upgrade if the review is going to be shown to judges.
- **What the code checks caught.** Nothing had to be rejected: all five first attempts passed every check. The checks still ran and are in the record, which is the point: the PR body shows them.
- **Grading tip.** To grade several branches at once, fetch each with an explicit refspec (`git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`) and check out `origin/<branch>`; parallel fetches that rely on `FETCH_HEAD` race and serve the same commit.

## GitHub App

Registered by the owner through the one-click manifest flow (GitHub rejected a first manifest because an inactive webhook still needs a public URL, so the manifest now carries no webhook block, and it required sudo-mode confirmation, which only the account owner can give). The app `agentproof-fcb9` (id 5365747) is installed on the `rjhxu` account (installation 172611536), and the runner loads its key from `data/github-app.json` (mode 0600, now gitignored).

Live through the app, with no token in any request: the private repository was cloned with an installation token scoped to `contents: read` (`RepositoryConnection.accessVia = github_app`), and a second fix of scenario B pushed its branch and opened draft PR [#6](https://github.com/rjhxu/northwind-storefront/pull/6) with a token scoped to `contents: write` and `pull_requests: write`, each token good for an hour and never stored. One defect surfaced and was fixed on the way: GitHub's current installation tokens are a few hundred characters long and contain dots and hyphens, which the token validators (`TOKEN_PATTERN` in the runner, the request schemas in shared) did not allow.

The app code is covered by 79 unit tests (JWT signature verified against the public key, token scoping, 0600 key file, manifest conversion) and by this live run.

## Reproduce

```bash
pnpm dev:runner                                                   # with ANTHROPIC_API_KEY in .env
STOREFRONT_PORT=5050 pnpm dev:store
node scripts/run-mission.mjs --bug A --agents alpha --store http://localhost:5050
GITHUB_TOKEN=$(gh auth token) node scripts/codefix.mjs --run <runId> \
  --repo https://github.com/rjhxu/northwind-storefront --store-root "" \
  --mode pull_request --token-env GITHUB_TOKEN --rematch
# external oracle: serve the PR branch and grade it
git -C ../northwind-storefront fetch origin <branch> && git -C ../northwind-storefront worktree add ../northwind-fix FETCH_HEAD
(cd ../northwind-fix && npm ci --ignore-scripts && STOREFRONT_PORT=5051 npm run start)
STORE_URL=http://localhost:5051 node docs/storefront/verify-scenarios.mjs
```
