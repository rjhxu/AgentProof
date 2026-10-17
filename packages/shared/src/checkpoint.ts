import { z } from 'zod';

/**
 * Checkpoints are the rows of the compatibility report. They are evaluated by deterministic
 * code in @agentproof/verifier, not by the agent's own claims.
 */
export const CheckpointId = z.enum([
  'product_discovered',
  'correct_color_identified',
  'correct_size_identified',
  'added_to_cart',
  'cart_matches_variant',
  'cart_quantity_correct',
  'price_within_budget',
  'checkout_review_reached',
  // Gamma-only
  'catalog_variant_resolves',
  'catalog_price_matches_page',
]);
export type CheckpointId = z.infer<typeof CheckpointId>;

export const CheckpointStatus = z.enum([
  'passed',
  'failed',
  'not_verified', // attempted, but not enough evidence to decide
  'not_tested', // never attempted (e.g. an earlier checkpoint failed)
  'unsupported', // store does not expose the capability needed to test this
  'blocked', // authorization / access restriction, not a store defect
]);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;

export const CHECKPOINT_LABELS: Record<CheckpointId, string> = {
  product_discovered: 'Product discovered',
  correct_color_identified: 'Correct color identified',
  correct_size_identified: 'Correct size identified',
  added_to_cart: 'Product added to cart',
  cart_matches_variant: 'Cart matches requested variant',
  cart_quantity_correct: 'Cart quantity correct',
  price_within_budget: 'Final price satisfies budget',
  checkout_review_reached: 'Checkout review reached',
  catalog_variant_resolves: 'Catalog variant ID resolves to the advertised variant',
  catalog_price_matches_page: 'Catalog price matches product page',
};

/** Order in which checkpoints appear in reports. */
export const CHECKPOINT_ORDER: CheckpointId[] = CheckpointId.options;

export const Checkpoint = z.object({
  id: CheckpointId,
  status: CheckpointStatus,
  /** Short, factual explanation: "Cart contained size S, mission required M." */
  detail: z.string().optional(),
  /** Evidence ids supporting this verdict */
  evidenceIds: z.array(z.string()).default([]),
});
export type Checkpoint = z.infer<typeof Checkpoint>;
