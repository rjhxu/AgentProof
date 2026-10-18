import {
  Mission,
  newId,
  nowIso,
  type CheckpointId,
  type MissionRequirements,
  type SuccessMilestone,
} from '@agentproof/shared';

/**
 * The five planted-bug scenarios and the bug-free control, transcribed from the storefront answer
 * key (docs/storefront/bugs-and-fixes.md). Mission prompts and requirement JSON are copied
 * verbatim from that document so a scenario run and the grader (`docs/storefront/verify-scenarios.mjs`)
 * test the same thing. The ids match `FixtureMissionRequest.bug` in @agentproof/shared.
 *
 * Expected results are the answer key's, not a verdict: the verifier decides each real run.
 */

export type ScenarioId = 'A' | 'B' | 'C' | 'D' | 'E' | 'control';

export const SCENARIO_IDS: ScenarioId[] = ['A', 'B', 'C', 'D', 'E', 'control'];

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** Product page slug under /products/ */
  productSlug: string;
  /** Comment tag in apps/storefront/src marking the planted bug (none for the control) */
  bugMarker?: string;
  /** The natural-language mission, verbatim from the answer key */
  prompt: string;
  requirements: MissionRequirements;
  successMilestone: SuccessMilestone;
  expected: {
    alpha: 'passed' | 'failed';
    /** Alpha's first failing checkpoint per the answer key */
    failingCheckpoint?: CheckpointId;
    gamma?: 'passed' | 'failed';
  };
  /** Storefront files the answer key names as the bug's source */
  sourceFiles: string[];
}

const HOODIE_PROMPT =
  'Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.';

const HOODIE_REQUIREMENTS: MissionRequirements = {
  product: 'black hoodie',
  category: 'apparel',
  attributes: { color: 'black', size: 'M' },
  quantity: 1,
  maxUnitPrice: 60,
};

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  A: {
    id: 'A',
    title: 'size chips are not form controls',
    productSlug: 'black-hoodie',
    bugMarker: 'DEMO BUG A',
    prompt: HOODIE_PROMPT,
    requirements: { ...HOODIE_REQUIREMENTS, attributes: { ...HOODIE_REQUIREMENTS.attributes } },
    successMilestone: 'checkout_review',
    // Alpha cannot select M (size S in the cart); Gamma on the same mission hits Bug B via the API.
    expected: { alpha: 'failed', failingCheckpoint: 'correct_size_identified', gamma: 'failed' },
    sourceFiles: ['apps/storefront/src/views.ts'],
  },
  B: {
    id: 'B',
    title: 'legacy variant map on the cart API',
    productSlug: 'black-hoodie',
    bugMarker: 'DEMO BUG B',
    prompt: HOODIE_PROMPT,
    requirements: { ...HOODIE_REQUIREMENTS, attributes: { ...HOODIE_REQUIREMENTS.attributes } },
    successMilestone: 'checkout_review',
    // Same mission as A, intended for Gamma: POST /api/cart maps HOODIE-001-M to HOODIE-001-S.
    expected: { alpha: 'failed', failingCheckpoint: 'correct_size_identified', gamma: 'failed' },
    sourceFiles: ['apps/storefront/src/cart.ts', 'apps/storefront/src/server.ts'],
  },
  C: {
    id: 'C',
    title: 'swatch names do not match swatch colors',
    productSlug: 'crewneck-sweatshirt',
    bugMarker: 'DEMO BUG C',
    prompt:
      'Find the crewneck sweatshirt in navy, size L, for under $70, add it to the cart, and reach checkout. Do not place the order.',
    requirements: {
      product: 'crewneck sweatshirt',
      category: 'apparel',
      attributes: { color: 'navy', size: 'L' },
      quantity: 1,
      maxUnitPrice: 70,
    },
    successMilestone: 'checkout_review',
    expected: { alpha: 'failed', failingCheckpoint: 'correct_color_identified', gamma: 'passed' },
    sourceFiles: ['apps/storefront/src/swatches.ts', 'apps/storefront/src/catalog.ts'],
  },
  D: {
    id: 'D',
    title: 'icon-only quantity stepper',
    productSlug: 'merino-socks',
    bugMarker: 'DEMO BUG D',
    prompt:
      'Add 3 pairs of the merino crew socks in size M to the cart and reach checkout. Do not place the order.',
    requirements: {
      product: 'merino crew socks',
      category: 'accessories',
      attributes: { size: 'M' },
      quantity: 3,
    },
    successMilestone: 'checkout_review',
    expected: { alpha: 'failed', failingCheckpoint: 'cart_quantity_correct', gamma: 'passed' },
    sourceFiles: ['apps/storefront/src/quantity-stepper.ts'],
  },
  E: {
    id: 'E',
    title: 'buy box hidden from the accessibility tree',
    productSlug: 'studio-headphones',
    bugMarker: 'DEMO BUG E',
    prompt:
      'Find the studio headphones, wired, under $100, add them to the cart, and reach checkout. Do not place the order.',
    requirements: {
      product: 'studio headphones',
      category: 'audio',
      attributes: { connectivity: 'wired' },
      quantity: 1,
      maxUnitPrice: 100,
    },
    successMilestone: 'checkout_review',
    expected: { alpha: 'failed', failingCheckpoint: 'added_to_cart', gamma: 'passed' },
    sourceFiles: ['apps/storefront/src/feature-layout.ts'],
  },
  control: {
    id: 'control',
    title: 'canvas tote (no bug)',
    productSlug: 'canvas-tote',
    prompt: 'Add the canvas tote to the cart and reach checkout. Do not place the order.',
    requirements: { product: 'canvas tote', attributes: {}, quantity: 1 },
    successMilestone: 'checkout_review',
    expected: { alpha: 'passed', gamma: 'passed' },
    sourceFiles: ['apps/storefront/src/views.ts'],
  },
};

/** "a", "A" or "control" -> ScenarioId; undefined for anything else. */
export function parseScenarioId(raw: string): ScenarioId | undefined {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'control') return 'control';
  const upper = trimmed.toUpperCase();
  return (SCENARIO_IDS as string[]).includes(upper) ? (upper as ScenarioId) : undefined;
}

/**
 * A fresh Mission for a scenario: new id and timestamp, the scenario's verbatim prompt as
 * rawPrompt, and the schema defaults for allowedActions, paymentAuthorized and maxSteps.
 */
export function scenarioMission(id: ScenarioId, storeUrl: string): Mission {
  const scenario = SCENARIOS[id];
  return Mission.parse({
    id: newId('mis'),
    createdAt: nowIso(),
    storeUrl,
    rawPrompt: scenario.prompt,
    requirements: structuredClone(scenario.requirements),
    successMilestone: scenario.successMilestone,
  });
}
