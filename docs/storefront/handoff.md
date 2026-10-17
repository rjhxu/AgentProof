# AgentProof — Product & Demo Handoff

## 1. Purpose

**AgentProof is a testing and repair workbench for AI-powered commerce.**

It runs shopping missions against a storefront, independently verifies whether the browser agent fulfilled the shopper's intent, diagnoses failures using browser evidence and relevant source code, proposes a reviewable code patch, applies an approved patch to an authorized demo repository, and reruns the same mission to verify whether the repair worked.

**Demo tagline:** Test the agents. Fix the failures. Prove the purchase path works.

This is a hackathon prototype, not a production-ready autonomous code-repair service.

## 2. Core demo story

The flagship demo should show this complete loop:

1. A user creates or selects a shopping mission.
2. AgentProof launches a real browser agent against the demo storefront.
3. The agent encounters a reproducible agent/storefront compatibility problem.
4. The independent verifier records a failure and supporting evidence.
5. The diagnosis model explains the likely cause and points to relevant source code.
6. AgentProof proposes a real source-code diff.
7. A human reviews and approves the patch.
8. AgentProof applies the patch to the authorized storefront repository.
9. The storefront reloads and the same mission runs again.
10. The verifier checks the actual outcome and reports **pass** or **fail**, with before/after evidence.

The demo must not fake a passing result by changing a status field, bypassing the browser, or directly editing cart state from the verifier.

## 3. Intended architecture and responsibilities

### AgentProof dashboard
- Create/select missions and start test runs.
- Show run status, browser actions, screenshots, console/network errors when useful, and verifier results.
- Show diagnosis, source references, proposed diff, approval control, patch outcome, and retest results.
- Present a clear before/after comparison.

### Browser shopping agent
- Uses Playwright to interact with the storefront through its user-facing UI.
- Starts with a natural-language mission such as:
  > Find the black hoodie, size M, priced under $60, and add it to the cart.
- Does not read the target repository or receive hidden expected answers.
- Should use semantic locators where possible, so accessibility and interaction semantics matter.
- Is restricted to the authorized demo storefront and allowed actions.

### Independent verifier
- Converts mission requirements into explicit assertions.
- Checks observable application state and, where possible, independently queries a trusted test interface or database/read-only state endpoint.
- Verifies product identity, variant/size, price constraints, and cart contents.
- Distinguishes a browser interaction failure from an incorrect final cart.
- Stores evidence and does not assume that a successful click means the mission succeeded.

### Diagnosis model
- Receives the mission, browser trace, screenshots/DOM evidence, verifier output, and only the relevant source snippets.
- Produces a concise explanation of the likely root cause and a proposed repair.
- Must distinguish observed facts from hypotheses.
- Does not have arbitrary shell access or unrestricted filesystem access.

### Patch engine
- Produces a reviewable diff for the authorized storefront repo.
- Restricts writes to the configured repository and allowed paths.
- Validates the diff and rejects path traversal, unexpected files, and overly broad changes.
- Requires human approval before applying a patch in the MVP.
- Applies the patch through a controlled mechanism, reloads/restarts the app if needed, and reruns the same mission.
- Reports the actual result, including if the patch fails or causes a regression.

## 4. Demo storefront

Create a separate repository for the target app, provisionally named **`northstar-storefront`**. It should look like a small but credible merchant website rather than a generic test page.

Keep it deliberately small:
- A few products, including a black hoodie.
- Product detail page with variant/size selection.
- Price and availability display.
- Add-to-cart interaction.
- Cart page or drawer that exposes selected variants and quantities.
- Checkout review page only, if useful.
- No real payments, shipping, user accounts, or production customer data.

Keep the storefront and AgentProof in separate repos/apps. AgentProof should interact with the storefront through a real browser; the verifier should not manipulate the cart to force success.

## 5. Proposed bugs / failure scenarios

The current plan is **one storefront with three independently testable failure scenarios**, not three separate websites. Build and perfect the first scenario before attempting the others.

### Bug A — Semantically invisible size selector (flagship; implement first)

**Human experience:** The product page visually shows size buttons such as S, M, L, and XL. A person can understand and click them.

**Agent-facing problem:** The controls have weak or missing accessible names, roles, or selected-state semantics. A semantic Playwright agent cannot reliably identify the intended size or confirm which size is selected. The agent may fail to locate the control or may be unable to verify the selection.

**Potential repair:** Give controls clear accessible names and appropriate semantics; expose selection state with `aria-pressed`, a correctly implemented radio group, or another suitable pattern. The exact fix should match the component's implementation and semantics.

**Verification:**
- Before: the same mission reproducibly fails or cannot establish the selected size.
- Patch: the source diff changes the actual control semantics.
- After: the same browser agent can select size M, and the independent verifier confirms that the cart contains the black hoodie in size M.

**Important:** Do not make the test pass solely because an ARIA attribute exists. Verify the actual selected variant and cart state. The bug should be reproducible, and the patch must genuinely improve the interaction contract.

### Bug B — Rendered product information conflicts with structured product data (implement second)

**Human experience:** The product page visibly shows the correct price, available sizes, or stock status.

**Agent-facing problem:** Structured data or an agent-facing product data endpoint omits a variant, has a stale price, or disagrees with the rendered UI. An agent that relies on structured information may choose incorrectly or reject a valid item, even though a human can see the right information.

**Potential repair:** Correct the source of truth or data mapping so structured product information and rendered product information agree.

**Verification:**
- Compare rendered UI values with structured product data.
- Have the agent complete a mission using the relevant product/variant.
- Independently verify that the selected item, price, and cart contents meet the mission.

**Scope note:** Make the discrepancy realistic and observable. Do not create a contrived mismatch that no actual agent path uses.

### Bug C — Cart state is difficult to confirm after an asynchronous update (stretch)

**Human experience:** After clicking “Add to cart,” a person sees the cart badge, loading indicator, or updated drawer and can usually tell what happened.

**Agent-facing problem:** The UI updates asynchronously or optimistically, without a clear completion signal. The agent may navigate too early, repeat an action, or report success before the cart has actually updated.

**Potential repair:** Synchronize the cart update with the authoritative state and expose a meaningful completion signal, accessible status message, or reliable UI state.

**Verification:**
- Capture the initial state and the result of the add-to-cart action.
- Wait for an explicit, meaningful completion condition rather than an arbitrary sleep.
- Verify the final cart quantity and variant.
- Ensure retries do not accidentally add duplicates.

**Scope note:** This is a reliability issue that may affect humans too; it can disproportionately confuse automation but should not be presented as an AI-exclusive bug.

## 6. Mission definition and verification contract

Suggested flagship mission:

> Find the black hoodie, size M, priced under $60, and add exactly one to the cart.

The verifier should evaluate at least:
- Correct product.
- Correct color.
- Correct size/variant.
- Price is below the mission's limit.
- Exactly one intended item is in the cart.
- The cart state is observed after the UI reports completion.

Use stable product/variant IDs in the test fixture, for example:
- `HOODIE-BLK-S`
- `HOODIE-BLK-M`
- `HOODIE-BLK-L`

These IDs are examples, not a requirement for a particular data model. The verifier's expected outcome must be established independently from the shopping agent's actions.

## 7. Patch workflow and safety boundaries

For the hackathon MVP:
- Configure an explicit target-repository path.
- Limit browser access to the demo storefront and approved routes.
- Give the shopping agent browser access only; do not expose source-code tools to it.
- Give the diagnosis model relevant source excerpts rather than unrestricted filesystem access.
- Validate all generated edits before applying them.
- Reject writes outside the target repo and unexpected changes to lockfiles, secrets, configuration, or unrelated files unless explicitly allowed.
- Show a diff and require human approval before application.
- Never execute arbitrary shell commands supplied by the model.
- Rerun the original test after applying a patch.
- Keep screenshots, traces, verifier assertions, and before/after outcomes as evidence.
- If the repair fails, show the failure honestly and preserve the diff for review or rollback.

The demo may use a constrained repair mechanism for known bug classes, but the UI and pitch must accurately describe what is automated versus constrained or human-approved. Do not imply that it can safely repair arbitrary merchant repositories.

## 8. Suggested implementation order

1. Build the small storefront and Bug A.
2. Write a deterministic verifier for the flagship mission.
3. Build a Playwright agent that can run the mission and capture evidence.
4. Make the pre-patch failure reproducible.
5. Implement source inspection and AI diagnosis.
6. Generate and display a real diff.
7. Apply an approved patch to the storefront repo.
8. Reload the app and rerun the same mission.
9. Show an independent pass/fail result and before/after evidence.
10. Polish the dashboard/replay experience.
11. Add Bug B; add Bug C only if time remains.

A single fully working failure → diagnosis → patch → retest loop is more valuable than three superficial scenarios or multiple agents with unreliable repairs.

## 9. Demo UX / pitch priorities

The demo should lead with the product behavior, not the architecture:
- **Failure:** Show the mission and the agent's inability to interact reliably with the size selector.
- **Evidence:** Show the exact failed action and verifier result.
- **Diagnosis:** Explain the source-level cause in plain language.
- **Repair:** Show a small, reviewable code diff.
- **Proof:** Apply it, rerun the same mission, and show the verified cart outcome.

The main differentiator is the closed loop: AgentProof does not merely observe a failure or suggest a fix; it tests the repaired application and reports whether the intended shopping outcome now works.

## 10. MVP acceptance criteria

The flagship demo is ready when all of these are true:
- [ ] The storefront is a separate target app/repo.
- [ ] Bug A fails reproducibly before repair.
- [ ] The shopping agent interacts with the real UI using Playwright.
- [ ] The verifier independently detects the failure and records evidence.
- [ ] Diagnosis references relevant source code and observed evidence.
- [ ] A real source diff is shown to the user.
- [ ] The user can approve or reject the patch.
- [ ] An approved patch modifies the target repo.
- [ ] The same mission reruns against the patched app.
- [ ] The verifier checks the actual final cart and reports pass/fail.
- [ ] The UI preserves the before/after evidence.
- [ ] No payment is submitted and no real customer data is used.

## 11. Open decisions

- Whether the verifier reads cart state through a read-only test endpoint, a test database, or the rendered cart UI. Prefer a source independent from the agent's own internal state, while keeping the demo architecture simple.
- Whether patches are emitted as unified diffs or structured edits. Unified diffs are easier for reviewers to understand; structured edits can be easier to validate.
- Whether to support one constrained patch type initially or allow a model-generated diff. Prioritize reliability; a narrow but genuine repair is acceptable for the MVP if the limitation is transparent.
- Whether Bugs B and C make the cut after Bug A is end-to-end reliable.

---

**Product principle:** AgentProof must prove the repair through a real rerun and independent verification. A plausible diagnosis, a displayed diff, or a green status badge alone is not proof.
