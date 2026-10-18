# AgentProof

**Product Vision, Problem Statement, Proposed Solution & Engineering Blueprint**

> **Tagline:** The testing ground for AI-powered commerce.
>
> **One-line pitch:** AgentProof tests whether AI shopping agents can reliably purchase from online stores, diagnoses compatibility failures, and verifies that proposed repairs work.
>
> **Target:** DubHacks 2026 — Visa Reimagine Shopping
>
> **Build constraints:** Three developers, 24 hours, one polished three-minute video.
>
> **Status (2026-10-18):** this is the original spec from the start of the hackathon, kept for intent. The as-built state is in README.md, docs/ARCHITECTURE.md, docs/AGENTS.md and docs/RESULTS.md; where they differ from this document, the code and those docs win.

---

## Table of contents

1. [The Problem](#1-the-problem)
2. [The Proposed Solution](#2-the-proposed-solution)
3. [Examples of AgentProof in Action](#3-examples-of-agentproof-in-action)
4. [The Recommended Technology Stack](#4-the-recommended-technology-stack)
5. [System Architecture](#5-system-architecture)
6. [Recommended Infrastructure](#6-recommended-infrastructure)
7. [The Shopping Agents](#7-the-shopping-agents)
8. [The AI and Verification Pipeline](#8-the-ai-and-verification-pipeline)
9. [The Flagship DubHacks Demonstration](#9-the-flagship-dubhacks-demonstration)
10. [MVP Scope for 24 Hours](#10-mvp-scope-for-24-hours)
11. [Team Organization](#11-team-organization)
12. [Development Schedule](#12-development-schedule)
13. [Definition of Success](#13-definition-of-success)
14. [Long-Term Product Vision](#14-long-term-product-vision)
15. [Final Positioning](#15-final-positioning)

---

## 1. The Problem

### E-commerce is entering the age of AI agents

Online shopping has traditionally been designed around a human browsing a website. The customer searches for a product, evaluates different offers, chooses a variant, adds it to a cart, reviews the total, and proceeds through checkout.

AI agents are beginning to perform these same tasks on behalf of consumers. Instead of opening several stores and comparing options manually, a customer might instruct an AI agent:

> "Find me a pair of black running shoes in size 10 for under $100, with delivery by Friday."

The agent must discover suitable products, correctly interpret product attributes, respect the user's constraints, and interact with the merchant's purchasing infrastructure.

This creates a new challenge for online retailers. A store that functions correctly for a human does not necessarily provide every AI shopping agent with a reliable, verifiable purchasing experience.

However, the problem is not simply that AI agents struggle to click buttons. Modern agents can interpret screenshots, browse websites, and operate many existing e-commerce interfaces successfully.

**The deeper challenge is commerce interoperability and reliability.**

An AI shopping experience depends on several systems agreeing about what the customer wants, what the merchant is offering, which product variant is being purchased, what it costs, and whether the transaction is authorized. Failures can occur even when every individual button appears to work.

### The five key problems

#### Problem 1: Inconsistent product information

An AI agent may discover a product through structured data, a shopping feed, an API, or a rendered webpage. These different sources may not agree.

A product feed might advertise a hoodie for $49, while the specific medium variant costs $65. Or a product identifier might point to the wrong color or size.

An agent needs to determine which information is authoritative and whether the offer actually satisfies the customer's requirements.

#### Problem 2: Different agents interact with websites differently

Some AI agents rely heavily on semantic information, such as accessible labels and HTML structure. Others use screenshots, visual reasoning, and simulated mouse interactions. Still others use merchant APIs and structured commerce protocols.

A storefront could work perfectly for one type of agent but fail for another. This is why a single generic "AI-ready" score is insufficient.

#### Problem 3: Successful actions do not guarantee correct outcomes

A browser agent may successfully click Add to Cart, but the resulting cart might not meet the customer's requirements. For example, the agent may have selected the wrong product variant, misunderstood a promotional price, or failed to recognize that delivery is unavailable.

A test should verify the resulting cart against the original purchasing instructions, rather than treating successful clicks as proof of success.

#### Problem 4: Authorized checkout requires trust

AI agents cannot simply assume they are permitted to complete any purchase. Merchants must manage authentication, purchase authorization, payment requirements, fraud prevention, and other safeguards.

A legitimate AI agent may encounter a challenge because the merchant does not support its authorization mechanism. That is different from a broken button or malformed product listing.

#### Problem 5: Merchants lack task-specific verification

Traditional testing tools examine accessibility, UI behavior, server errors, and other website characteristics. Those tools remain valuable, but they do not always answer the complete business question:

> "Can this particular AI agent successfully fulfill a real customer's shopping request on our store?"

Even when a problem is discovered, a merchant needs evidence explaining the failure and a way to verify the repair.

---

## 2. The Proposed Solution

### AgentProof: An AI Commerce Testing Arena

AgentProof is a web application that allows merchants and developers to simulate AI shopping experiences, inspect failures, and improve compatibility.

The user enters a storefront and describes a shopping mission. For example:

> "Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order."

AgentProof launches controlled shopping-agent tests against the store. The interface displays the agents' progress, including the pages they visit, the actions they attempt, and the purchasing requirements they must satisfy.

The platform independently verifies the final state. If an agent cannot complete the task correctly, AgentProof captures the relevant execution evidence and explains what went wrong.

When merchant source code is available, AgentProof can generate a proposed repair. The merchant reviews the change, applies it to an authorized test environment, and runs the same test again. The resulting comparison demonstrates whether the repair actually improves compatibility.

### The six core product features

#### Feature 1 — Shopping Mission Generator

Users can describe realistic purchase goals in natural language. AgentProof converts these requests into structured, testable requirements.

A mission defines:

- The requested product or category.
- Required attributes such as size, color, and configuration.
- Maximum permitted price.
- Quantity.
- Optional shipping or delivery restrictions.
- The milestone that constitutes success.
- Actions the agent is authorized to perform.

For the hackathon, every test will stop before submitting payment.

#### Feature 2 — AI Shopping Arena

The centerpiece of the product is a visual mission-control interface. Multiple test sessions can attempt the same purchasing objective using different interaction strategies or configurations.

| Agent                                           | Strategy                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Agent Alpha** — Semantic Browser Agent        | Uses accessible page structure and semantic controls to identify and interact with product pages.      |
| **Agent Beta** — Vision-Assisted Browser Agent  | Uses screenshots and visual reasoning alongside browser interaction tools.                             |
| **Agent Gamma** — Structured Commerce Inspector | Examines machine-readable product information and, where supported, merchant API or protocol behavior. |

These are distinct testing approaches, not necessarily three entirely different AI models. For the MVP, Alpha and Beta are the primary browser agents. Gamma is a smaller structured-data test module.

The interface shows agent progress, screenshots, execution milestones, and final outcomes.

#### Feature 3 — Evidence-Based Compatibility Reports

AgentProof evaluates shopping tasks against explicit success criteria. A typical result:

| Shopping checkpoint            | Result       |
| ------------------------------ | ------------ |
| Product discovered             | Passed       |
| Correct color identified       | Passed       |
| Correct size identified        | Passed       |
| Product added to cart          | Passed       |
| Cart matches requested variant | **Failed**   |
| Final price satisfies budget   | Not verified |
| Checkout review reached        | Not tested   |

The platform distinguishes genuine failures from unsupported operations, access restrictions, and steps that were never attempted. Where possible, every issue links to screenshots, browser traces, relevant page structure, or observed application responses.

#### Feature 4 — AI Root Cause Analysis

Once an issue is detected, AgentProof analyzes the available evidence. It identifies the observed failure, suggests a likely explanation, and recommends a targeted improvement.

- **Observed:** The agent requested a medium hoodie, but the cart contained small.
- **Evidence:** The product page reported one variant ID, while the cart response contained another.
- **Potential cause:** Inconsistent variant mapping between product selection and cart creation.
- **Suggested repair:** Correct the variant identifier mapping and verify the resulting cart state.

The platform separates observed facts from inferred causes. It should not fabricate explanations when the evidence is insufficient.

#### Feature 5 — Reviewable Repair Suggestions

For a connected repository or an owned demonstration storefront, AgentProof can suggest source-code changes:

- Correcting product variant identifiers.
- Repairing inconsistent product metadata.
- Improving form control semantics.
- Fixing cart-state synchronization.
- Correcting a checkout API response.
- Validating advertised protocol capabilities.

The proposed change is displayed as a code diff. The merchant remains in control of whether that change is applied.

#### Feature 6 — The Rematch

This is the product's defining interaction. After a repair has been applied, the user clicks **Run Rematch**. AgentProof repeats the original shopping task using the same test configuration.

The system compares the original and repaired runs. It displays which checkpoints improved, which problems remain, and whether the intended shopping outcome can now be verified.

The result is a clear before-and-after demonstration of actual system behavior.

#### The user flow — URL first, repository second

The product asks for the least it needs at each step. It never asks for source access before it has shown the merchant something worth fixing.

| Step                                    | What the user gives                                 | What AgentProof shows                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Launch**                          | The storefront URL and a natural-language mission.  | The arena starts. Nothing else is required; a merchant can try the product with zero commitment.                                                                                                        |
| **2 — Live-page inspection**            | Nothing.                                            | A fast pass over the live product page while the agents run: structured catalog variant IDs compared with the DOM, controls with no accessible name, missing prices. Needs only the URL, not the repo. |
| **3 — Agents run and are verified**     | Nothing.                                            | One panel per agent, the checkpoint matrix, the deterministic verdict, cross-agent attribution and cost per agent.                                                                                       |
| **4 — Issues with evidence**            | Nothing.                                            | Each issue with its observed facts and a labelled hypothesis. The report is complete and shareable at this point, with or without a repository.                                                          |
| **5 — Connect the repository**          | GitHub access, asked for on the issue, not up front. | The ask is concrete: *connect your repo and we will propose a patch for this issue.* The code-fix agent reads the reports and the repository snapshot and returns a reviewable diff.                     |
| **6 — Apply and Rematch**               | A review of the diff and a click.                   | The repair is applied to the owned test storefront and the same mission runs again. The before/after table shows which checkpoints now pass.                                                            |

Why the URL comes first:

- **The product tests the live store, not the code.** Agent Alpha fails on an unlabelled size selector at runtime. A repository lint cannot see that the way an agent does, and the verifier checks a real cart, not source. Asking for GitHub first would make the product look like static analysis.
- **Value before permission.** A URL costs nothing to paste. An OAuth grant to source code, asked for before the merchant has seen a result, is where most users leave.
- **Repository access is optional.** Features 1 to 4 work without it. Only the diff (Feature 5) and the rematch after an applied repair (Feature 6) need it, so it is requested where it is used.
- **Demo risk.** The GitHub connection is the step most likely to break on camera. Placed at step 5, scenes 1 through 4 have already landed if it does.

Two refinements:

- **Early connection is allowed, never required.** The launch form has an optional *connect a repository now* field so a merchant who already trusts the product, or a demo recording, gets the diff instantly.
- **Any lint runs against the live page, not the repository.** The metadata consistency inspector from the high-value enhancements is that step: fetch the product page, compare the catalog variant IDs with the DOM, flag unlabelled controls. It gives the dashboard something to show in the first ten seconds.

---

## 3. Examples of AgentProof in Action

### Example A — The Visually Functional Store

A clothing store has a custom size selector. The selector is obvious in a screenshot, but its accessible representation does not identify the control or options clearly.

A vision-assisted agent may successfully choose medium. A semantic browser agent may be unable to find the appropriate control reliably.

AgentProof detects the difference. It reports that the store works under the visual interaction strategy but fails under the tested semantic interaction strategy. It recommends improving the form control's accessible structure.

After the merchant applies the repair, the semantic agent repeats the task successfully. This demonstrates a genuine difference between AI interaction methods rather than a generic shopping-cart bug.

### Example B — The Incorrect Product Variant

A store exposes a machine-readable product catalog. The catalog identifies variant `HOODIE-001-M` as medium. However, an authorized cart request using that identifier resolves to the small variant because the merchant's mapping is incorrect.

A browser shopper might never encounter the issue because the website uses a different product-selection path.

AgentProof compares the catalog and cart results and identifies the inconsistency. It proposes a correction to the mapping. After the fix, the same structured commerce test returns the correct variant.

This demonstrates why testing agent-facing commerce interfaces matters.

### Example C — The Misleading Price

A shopping agent is asked to find headphones under $100. It discovers a product advertised for $89. However, the particular configuration selected by the agent costs $119.

The agent's initial discovery step was valid, but the final purchase does not satisfy the user's budget.

AgentProof verifies the final cart against the original objective. It reports whether the discrepancy reflects incorrect merchant metadata, unclear offer conditions, or an agent decision error. The repair might require correcting the catalog, clarifying pricing conditions, or improving the agent's selection strategy.

Not every failed test is automatically the merchant's fault.

### Example D — The Checkout Integration

A merchant advertises support for a structured agent-commerce interface. An authorized test client attempts to create a checkout session. The merchant returns an invalid response or omits required cart information.

AgentProof identifies the incompatibility, shows the expected versus actual response, and proposes an implementation change. The developer repairs the endpoint and reruns the conformance test.

This would be a strong future extension, but full protocol integration is not essential to the first 24-hour MVP.

---

## 4. The Recommended Technology Stack

The goal is to maximize reliability and visual quality without introducing unnecessary infrastructure.

| Component            | Recommended technology       | Purpose                                       |
| -------------------- | ---------------------------- | --------------------------------------------- |
| Frontend             | Next.js + React + TypeScript | Web application and dashboard                 |
| Styling              | Tailwind CSS                 | Rapid UI development                          |
| UI components        | shadcn/ui                    | Professional dashboard components             |
| Animation            | Motion                       | Transitions and mission-control effects       |
| AI development       | Claude Code                  | Generate, debug, and test implementation      |
| Runtime intelligence | Claude API                   | Shopping decisions and diagnosis              |
| Browser automation   | Playwright                   | Control browsers and capture evidence         |
| Validation           | Zod                          | Enforce structured mission and result schemas |
| API service          | Node.js + Fastify            | Manage agent runs and test orchestration      |
| Local persistence    | SQLite                       | Store missions, runs, and results             |
| Evidence storage     | Local filesystem             | Screenshots, traces, and recordings           |
| Packaging            | Docker                       | Reproducible browser execution                |
| Optional hosting     | Vercel + a container host    | Public dashboard and browser runner           |
| Video recording      | OBS                          | Capture real browser-agent executions         |
| Video editing        | CapCut or DaVinci Resolve    | Produce the three-minute submission           |

### Why this stack?

**Next.js** lets us build a polished, interactive dashboard quickly. We can create custom components for agent windows, execution timelines, issue reports, code diffs, and before-and-after comparisons.

**Claude API** acts as the reasoning layer. It interprets shopping objectives, selects permitted browser actions, and analyzes failures. Claude Code is used to develop the product; it is not automatically the runtime agent powering the product.

**Playwright** is the execution layer. It launches actual browser sessions, interacts with webpages, captures screenshots, and records traces. This is far easier and more reliable than implementing a browser automation system ourselves.

**Fastify** is a lightweight Node.js service that coordinates long-running tests outside the frontend request lifecycle. It can launch browser jobs, collect results, and expose run status to the dashboard.

**SQLite**: for a 24-hour demo, we do not need a complex database. SQLite can store structured missions, test status, checkpoint results, issue metadata, and paths to evidence artifacts. The browser recordings and screenshots themselves can live in a local directory.

**Docker**: browser automation depends on a compatible operating system and installed browser binaries. Using a container gives the browser runner a consistent execution environment.

We do not need Kubernetes, Redis, a distributed task queue, or a collection of microservices for this prototype.

---

## 5. System Architecture

AgentProof consists of four main runtime components.

### Component A — Dashboard

**Technology:** Next.js, React, Tailwind CSS, Motion.

**Responsibilities:** Accept a store and shopping mission. Display live progress. Show browser captures and agent states. Visualize shopping checkpoints. Present diagnostic reports. Show proposed repairs. Trigger a rematch. Compare test runs.

### Component B — Test Orchestrator

**Technology:** Fastify, TypeScript, Zod.

**Responsibilities:** Validate mission requirements. Create test jobs. Select agent configurations. Enforce allowed domains and actions. Start and stop execution. Track run status. Publish progress to the frontend.

For the MVP, this can be a simple asynchronous job manager with one or two browser runs active at a time.

### Component C — Browser Agent Engine

**Technology:** Playwright, Claude API.

The agent runs in a loop:

1. Inspect the current page.
2. Provide the relevant page state to Claude.
3. Receive the next proposed action.
4. Validate the action against the test policy.
5. Execute it through Playwright.
6. Record the result.
7. Continue until success, failure, or a configured stopping condition.

This layer also captures screenshots, traces, action logs, and relevant cart information.

### Component D — Verification and Repair Engine

**Technology:** TypeScript, Zod, Claude API.

**Responsibilities:** Compare expected and observed shopping outcomes. Classify failures. Attach supporting evidence. Generate potential root causes. Suggest code-level fixes when repository access exists. Compare original and repaired runs.

> **Important design principle:** Claude performs reasoning, but ordinary application code determines whether concrete constraints have been satisfied. Budget arithmetic and variant-ID comparisons should not depend on an LLM's opinion.

---

## 6. Recommended Infrastructure

### Development environment

During the hackathon, run the entire system locally. The dashboard runs on a Next.js development server. The test orchestrator runs as a separate Node.js service. Playwright launches local Chromium sessions. SQLite stores execution records, and a dedicated directory holds screenshots and browser traces.

| Directory              | Responsibility                             |
| ---------------------- | ------------------------------------------ |
| `apps/web`             | Next.js frontend                           |
| `apps/runner`          | Fastify API and browser-job manager        |
| `apps/storefront`      | Synthetic e-commerce testing environment   |
| `packages/shared`      | Shared types and Zod schemas               |
| `packages/agent`       | Claude + Playwright agent execution        |
| `packages/verifier`    | Deterministic shopping-result verification |
| `packages/diagnostics` | Failure analysis and repair generation     |
| `data/artifacts`       | Test screenshots, traces, and recordings   |

Use a single GitHub repository with separate work areas for the four developers.

### Production-style deployment

For the first release, the simplest robust approach is a container-based backend supporting long-running Playwright tasks. The frontend can be hosted separately on Vercel if desired. A container host such as Railway, Render, or Fly.io can run the browser service, subject to current resource limits and pricing.

Avoid attempting to execute long-running Playwright browser sessions inside ordinary serverless request handlers.

If only the recorded demo is required, local execution is sufficient, and you can prioritize a stable local environment over a complicated cloud deployment.

### Communication between components

The frontend starts an agent run by calling the orchestration API. The backend returns a run identifier. The frontend then receives progress updates through polling or Server-Sent Events.

Each run records: mission information, agent configuration, current checkpoint, execution status, screenshot references, browser trace references, verified result, and diagnostic findings.

Polling is sufficient for the initial MVP. More elaborate real-time infrastructure is unnecessary.

### Browser isolation

Each shopping test should run in an isolated browser context. The system should limit which domains can be accessed, what browser actions can be performed, and how many steps an agent may take.

Agent access should be restricted to an owned or explicitly authorized test storefront for the full hackathon workflow.

Do not give the browser agent arbitrary filesystem access, production payment credentials, or unrestricted network access. **All merchant-page content must be treated as untrusted input.**

---

## 7. The Shopping Agents

The multi-agent display is the most visually distinctive feature of the project. However, we should implement it in a way that is achievable within 24 hours.

### Agent Alpha — Semantic Navigation

The agent uses page structure and semantically identified controls whenever possible. It searches for products, identifies selectors, adds items to carts, and validates the result. This approach is efficient and can expose missing or ambiguous semantic controls.

### Agent Beta — Visual Navigation

The agent uses screenshots and visual interpretation to navigate the same store. It attempts the same mission while relying more heavily on the rendered interface. This allows AgentProof to compare whether a website behaves differently under visual and semantic interaction.

### Agent Gamma — Structured Data Inspector

This module examines available product metadata and supported commerce interfaces. For the hackathon, it should initially validate product identifiers, variants, advertised prices, and consistency with the test storefront's cart service.

Full UCP, ACP, or Visa protocol conformance testing is a stretch goal.

### Recording versus live execution

To minimize demo risk, execute real tests and persist their recordings. The dashboard can then replay multiple genuine runs side by side, synchronized on a timeline.

This creates the visual effect of an arena without requiring three expensive, long-running browser sessions to complete simultaneously during the video.

**Replays must be identified as recordings rather than represented as currently running agents.**

---

## 8. The AI and Verification Pipeline

The runtime process should follow a strict sequence.

### Step 1 — Convert intent into a test specification

Claude translates a natural-language mission into structured requirements.

```
Product:            Black hoodie
Size:               Medium
Quantity:           1
Maximum item price: $60
Target:             Checkout review
Payment:            Not authorized
```

### Step 2 — Execute the agent

The browser runner performs the permitted interactions. It captures evidence at important checkpoints.

### Step 3 — Verify the outcome

The verification module examines the resulting cart or test API response. It checks: correct product, correct variant, correct quantity, acceptable price, required checkout milestone.

### Step 4 — Classify failures

Failures are labeled according to their likely category:

- Agent execution error.
- Semantic interface problem.
- Product data inconsistency.
- Cart or checkout defect.
- Authorization or access restriction.
- Unsupported integration.
- Transient error.
- Insufficient evidence.

### Step 5 — Generate diagnosis

Claude examines the relevant evidence and returns a proposed explanation. For a connected repository, it can also inspect the likely source-code area.

### Step 6 — Propose repair

The platform generates a reviewable code diff or configuration recommendation. For the hackathon storefront, the repair can be applied to a controlled staging instance.

### Step 7 — Rerun and compare

The original mission executes again. The dashboard displays the newly verified result alongside the previous result.

A successful retest establishes that the repaired environment passed that particular test. It does not guarantee universal compatibility with every AI agent.

---

## 9. The Flagship DubHacks Demonstration

We should build one exceptionally clear demonstration.

### Scenario: A store with conflicting product-variant information

Our synthetic storefront sells a black hoodie in small, medium, and large. The product pages look professional and work for a normal shopper.

However, one agent-facing representation contains an incorrect variant mapping. A structured catalog test attempts to use the medium identifier, but the resulting cart contains the small variant.

Separately, the store's custom size selector is difficult for a semantic browser agent to interpret, while a vision-assisted agent may still operate it.

These failures demonstrate different compatibility problems.

| Scene                       | What happens                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Launch the arena**    | The user enters the storefront URL and the shopping mission. AgentProof starts its test sessions. The dashboard displays each agent's progress.                                                                                     |
| **2 — The failures appear** | The structured commerce test identifies the wrong variant mapping. The semantic browser agent encounters the ambiguous selector. The visual agent may succeed, highlighting that compatibility depends on the interaction strategy. |
| **3 — Diagnose**            | AgentProof presents the captured evidence. The user selects an issue. If no repository is connected yet, AgentProof asks for it here (see the user flow in section 2), then shows the suggested source-code repair. |
| **4 — Apply the repair**    | The developer reviews the proposed patch and applies it to the controlled test storefront.                                                                                                                                          |
| **5 — Run Rematch**         | AgentProof reruns the affected tests. The corrected storefront now returns the expected variant, and the semantic agent can interact with the selector. The dashboard displays the improved test results side by side.              |

This is the signature moment: we are not merely announcing that the store is more agent-compatible. We are demonstrating which tests now pass.

---

## 10. MVP Scope for 24 Hours

### Must-have features

- A visually polished AgentProof dashboard.
- A functional synthetic online store.
- Natural-language shopping mission input.
- At least one genuinely autonomous Playwright shopping agent.
- Screenshots and recorded execution traces.
- Independent verification of cart correctness.
- Evidence-backed failure diagnosis.
- A reviewable repair to the owned storefront.
- A real before-and-after retest.
- An impressive replay/comparison interface.

### High-value enhancements

- A second browser-agent configuration.
- Side-by-side agent replay.
- A product metadata consistency inspector.
- A shareable compatibility report.
- Timeline animations and interactive issue markers.

### Features to avoid in the initial build

- Arbitrary automated code changes to third-party websites.
- Real payment execution.
- Production merchant authentication.
- Complete certification of every commerce protocol.
- Browser CAPTCHA bypass.
- A distributed fleet of dozens of autonomous agents.
- A sophisticated enterprise user-management system.
- Custom-trained AI models.

---

## 11. Team Organization

For a three-person team, assign work by subsystem. See [WORKPLAN.md](./WORKPLAN.md) for the hour-by-hour split.

| Developer | Primary responsibility                                                                        | Owns                                                                                      |
| --------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Zach      | Claude + Playwright browser agents (Alpha, Beta), human replay, Next.js dashboard, demo video | `packages/agent`, `apps/web`                                                              |
| Ryan      | Synthetic storefront, planted bug scenarios, product data, answer key and patches             | `apps/storefront`, `docs/storefront`                                                      |
| Vihan     | Orchestrator, verification, Gamma, diagnosis, repair, GitHub connection, integration          | `apps/runner`, `packages/verifier`, `packages/diagnostics`, `packages/agent/src/gamma.ts` |

The shared mission and result schemas should be finalized at the beginning so developers can work independently. They live in `packages/shared`.

Use fixtures and recorded sample runs to let the frontend team develop the dashboard while the browser engine is still being implemented. Fixtures live in `packages/shared/fixtures`.

---

## 12. Development Schedule

| Time        | Deliverable                                          |
| ----------- | ---------------------------------------------------- |
| Hours 0–3   | Project setup, shared schemas, storefront foundation |
| Hours 3–6   | First autonomous browser shopping mission            |
| Hours 6–9   | Test recording, screenshots, objective verification  |
| Hours 9–12  | AgentProof dashboard and execution timeline          |
| Hours 12–15 | AI diagnosis and targeted repair                     |
| Hours 15–18 | Retesting and before/after comparison                |
| Hours 18–20 | Optional second agent, visual polish, bug fixes      |
| Hours 20–24 | Video recording, editing, testing, submission        |

**The most important milestone is a working shopping-agent test within six hours.** If we cannot reliably complete one test, we should simplify rather than build a beautiful dashboard that only displays mock results.

---

## 13. Definition of Success

A successful hackathon prototype must demonstrate that:

1. An AI agent actually interacts with a functioning online store.
2. The system identifies a measurable mismatch between the requested and observed shopping outcome.
3. The failure is backed by browser or application evidence.
4. A specific repair is proposed and reviewed.
5. The same shopping task is rerun after the repair.
6. The resulting improvement is independently verified.
7. The dashboard communicates the entire sequence clearly in three minutes.

The product does not need to handle every merchant or every agent architecture. It needs to prove the value of the testing and repair workflow through one convincing end-to-end example.

---

## 14. Long-Term Product Vision

AgentProof could eventually become continuous integration infrastructure for AI-driven commerce. Merchants would connect their storefronts and repositories. AgentProof would maintain representative shopping missions and execute them whenever the merchant releases changes.

If an update breaks a supported agent shopping workflow, the development team receives the failed trace, likely cause, and suggested repair.

Over time, AgentProof could add:

- Multiple independent shopping-agent providers.
- Supported agent-commerce protocol tests.
- Trusted-agent authentication verification.
- Merchant-catalog consistency monitoring.
- Automated pull-request feedback.
- Historical reliability metrics.
- Production-compatible regression testing.

The business model could resemble developer testing infrastructure: merchants and agencies pay for recurring verified shopping tests, integrations, and regression monitoring. This remains a potential business model, not an established source of revenue.

---

## 15. Final Positioning

AgentProof is not another chatbot, an accessibility checker with an AI label, or a static score generator.

It is a platform for testing the reliability of AI-driven shopping. It turns an abstract problem—whether AI agents can interact with a merchant—into an observable experiment.

An agent receives a shopping objective, attempts the task, and produces an outcome. AgentProof verifies the result, explains failures, and measures whether a repair improves performance.

Our vision is to make automated commerce compatibility testing a standard part of building and maintaining online stores.

> **AgentProof** — Test the agents. Fix the failures. Prove the purchase path works.
