/**
 * Fixtures let the dashboard team build against realistic data before the browser
 * engine produces real runs. Keep them valid against the schemas (see fixtures.test.ts).
 */
import type { Mission, Run, Issue, Repair } from '../src';

export const hoodieMission: Mission = {
  id: 'mis_demo00000001',
  createdAt: '2026-10-17T20:00:00.000Z',
  storeUrl: 'http://localhost:5000',
  rawPrompt:
    'Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.',
  requirements: {
    product: 'black hoodie',
    category: 'apparel',
    attributes: { color: 'black', size: 'M' },
    quantity: 1,
    maxUnitPrice: 60,
  },
  successMilestone: 'checkout_review',
  allowedActions: ['navigate', 'click', 'type', 'select', 'scroll', 'extract'],
  paymentAuthorized: false,
  maxSteps: 25,
};

/** Agent Alpha fails on the custom size selector (Example A in the spec). */
export const alphaFailedRun: Run = {
  id: 'run_demo0000alpha',
  missionId: hoodieMission.id,
  agent: {
    kind: 'alpha_semantic',
    model: 'claude-opus-5-5',
    viewport: { width: 1280, height: 800 },
    headed: false,
  },
  status: 'failed',
  label: 'original',
  createdAt: '2026-10-17T20:00:05.000Z',
  startedAt: '2026-10-17T20:00:06.000Z',
  finishedAt: '2026-10-17T20:01:12.000Z',
  steps: [
    {
      index: 0,
      at: '2026-10-17T20:00:07.000Z',
      url: 'http://localhost:5000/',
      action: { type: 'click', target: 'link:Black Hoodie', reason: 'Matches requested product' },
      outcome: 'ok',
      screenshotEvidenceId: 'ev_demo00000001',
      durationMs: 820,
    },
    {
      index: 1,
      at: '2026-10-17T20:00:10.000Z',
      url: 'http://localhost:5000/products/black-hoodie',
      action: {
        type: 'select',
        target: 'combobox:Size',
        value: 'M',
        reason: 'Mission requires size M',
      },
      outcome: 'error',
      outcomeDetail: 'No element with role=combobox and name "Size" found in accessibility tree',
      screenshotEvidenceId: 'ev_demo00000002',
      durationMs: 5100,
    },
    {
      index: 2,
      at: '2026-10-17T20:00:16.000Z',
      url: 'http://localhost:5000/products/black-hoodie',
      action: { type: 'click', target: 'button:Add to cart', reason: 'Proceed with default size' },
      outcome: 'ok',
      screenshotEvidenceId: 'ev_demo00000003',
      durationMs: 640,
    },
  ],
  evidence: [
    {
      id: 'ev_demo00000001',
      runId: 'run_demo0000alpha',
      kind: 'screenshot',
      stepIndex: 0,
      capturedAt: '2026-10-17T20:00:07.500Z',
      path: 'run_demo0000alpha/step-000.png',
    },
    {
      id: 'ev_demo00000002',
      runId: 'run_demo0000alpha',
      kind: 'dom_snapshot',
      stepIndex: 1,
      capturedAt: '2026-10-17T20:00:15.000Z',
      label: 'Accessibility tree around size selector',
      data: {
        excerpt:
          '<div class="size-picker"><div class="chip">S</div><div class="chip">M</div><div class="chip">L</div></div>',
        roles: [],
      },
    },
    {
      id: 'ev_demo00000003',
      runId: 'run_demo0000alpha',
      kind: 'cart_state',
      stepIndex: 2,
      capturedAt: '2026-10-17T20:00:17.000Z',
      data: {
        items: [
          {
            productId: 'HOODIE-001',
            variantId: 'HOODIE-001-S',
            name: 'Black Hoodie',
            attributes: { color: 'black', size: 'S' },
            unitPrice: 49,
            quantity: 1,
          },
        ],
        subtotal: 49,
        currency: 'USD',
        source: 'api',
      },
    },
  ],
  verification: {
    verifiedAt: '2026-10-17T20:01:12.000Z',
    observedCart: {
      items: [
        {
          productId: 'HOODIE-001',
          variantId: 'HOODIE-001-S',
          name: 'Black Hoodie',
          attributes: { color: 'black', size: 'S' },
          unitPrice: 49,
          quantity: 1,
        },
      ],
      subtotal: 49,
      currency: 'USD',
      source: 'api',
    },
    checkpoints: [
      { id: 'product_discovered', status: 'passed', evidenceIds: ['ev_demo00000001'] },
      { id: 'correct_color_identified', status: 'passed', evidenceIds: ['ev_demo00000001'] },
      {
        id: 'correct_size_identified',
        status: 'failed',
        detail: 'Agent could not locate a size control in the accessibility tree.',
        evidenceIds: ['ev_demo00000002'],
      },
      { id: 'added_to_cart', status: 'passed', evidenceIds: ['ev_demo00000003'] },
      {
        id: 'cart_matches_variant',
        status: 'failed',
        detail: 'Cart contained size S; mission required size M.',
        evidenceIds: ['ev_demo00000003'],
      },
      { id: 'cart_quantity_correct', status: 'passed', evidenceIds: ['ev_demo00000003'] },
      { id: 'price_within_budget', status: 'passed', detail: '$49.00 <= $60.00', evidenceIds: [] },
      { id: 'checkout_review_reached', status: 'not_tested', evidenceIds: [] },
    ],
    firstFailure: {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Agent could not locate a size control in the accessibility tree.',
      evidenceIds: ['ev_demo00000002'],
    },
  },
};

export const alphaIssue: Issue = {
  id: 'iss_demo00000001',
  runId: alphaFailedRun.id,
  checkpointId: 'correct_size_identified',
  category: 'semantic_interface_problem',
  title: 'Size selector is not exposed to assistive technology',
  observed:
    'The agent requested role=combobox name="Size". The accessibility tree contained no form control for size; the size chips are plain <div> elements without role, name, or keyboard handling. The cart subsequently contained size S.',
  evidenceIds: ['ev_demo00000002', 'ev_demo00000003'],
  inferredCause:
    'The custom size picker renders non-semantic <div> chips. Semantic agents cannot discover or operate it, so the default (first) size is used.',
  confidence: 'high',
  suggestedRepair:
    'Render the size picker as a <fieldset> of <input type="radio"> + <label> elements (or buttons with role="radio" and aria-checked), with a visible legend "Size".',
  suspectedFiles: ['apps/storefront/src/views/product.ts'],
};

export const alphaRepair: Repair = {
  id: 'rep_demo00000001',
  issueId: alphaIssue.id,
  summary: 'Make the size picker a semantic radio group',
  files: ['apps/storefront/src/views/product.ts'],
  status: 'proposed',
  createdAt: '2026-10-17T20:02:00.000Z',
  diff: `--- a/apps/storefront/src/views/product.ts
+++ b/apps/storefront/src/views/product.ts
@@ -40,9 +40,13 @@
-<div class="size-picker">
-  \${sizes.map((s) => \`<div class="chip" data-size="\${s}">\${s}</div>\`).join('')}
-</div>
+<fieldset class="size-picker">
+  <legend>Size</legend>
+  \${sizes
+    .map((s) => \`<label class="chip"><input type="radio" name="size" value="\${s}"> \${s}</label>\`)
+    .join('')}
+</fieldset>
`,
};
