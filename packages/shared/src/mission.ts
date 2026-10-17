import { z } from 'zod';

/**
 * A Mission is the structured, testable form of a natural-language shopping request.
 * Claude converts the prompt into this shape; everything downstream (agents, verifier,
 * diagnostics) reads only the structured fields, never the raw prompt.
 */

export const SuccessMilestone = z.enum([
  'product_found', // agent located a product page matching the request
  'added_to_cart', // correct variant is in the cart
  'checkout_review', // reached the order review page (NEVER submits payment)
]);
export type SuccessMilestone = z.infer<typeof SuccessMilestone>;

export const AllowedAction = z.enum(['navigate', 'click', 'type', 'select', 'scroll', 'extract']);
export type AllowedAction = z.infer<typeof AllowedAction>;

export const MissionRequirements = z.object({
  /** Free-text product description, e.g. "black hoodie" */
  product: z.string().min(1),
  /** Optional category hint, e.g. "apparel", "audio" */
  category: z.string().optional(),
  /** Required variant attributes, lowercase keys: { size: "M", color: "black" } */
  attributes: z.record(z.string(), z.string()).default({}),
  quantity: z.number().int().positive().default(1),
  /** Maximum acceptable price for a single unit, in the store currency */
  maxUnitPrice: z.number().nonnegative().optional(),
  /** Maximum acceptable cart total (pre-shipping) */
  maxTotalPrice: z.number().nonnegative().optional(),
  shipping: z
    .object({
      deliverBy: z.string().optional(), // ISO date
      region: z.string().optional(),
    })
    .optional(),
});
export type MissionRequirements = z.infer<typeof MissionRequirements>;

export const Mission = z.object({
  id: z.string(),
  createdAt: z.string(), // ISO timestamp
  /** Storefront base URL. Host must be in AGENTPROOF_ALLOWED_HOSTS. */
  storeUrl: z.url(),
  /** The original natural-language request, kept for display only */
  rawPrompt: z.string(),
  requirements: MissionRequirements,
  successMilestone: SuccessMilestone,
  allowedActions: z
    .array(AllowedAction)
    .default(['navigate', 'click', 'type', 'select', 'scroll', 'extract']),
  /** Always false for the hackathon. Agents must never submit payment. */
  paymentAuthorized: z.literal(false).default(false),
  maxSteps: z.number().int().positive().default(25),
});
export type Mission = z.infer<typeof Mission>;

/** What the Mission Generator (Claude) returns: everything except server-assigned fields. */
export const MissionDraft = Mission.omit({
  id: true,
  createdAt: true,
  storeUrl: true,
  rawPrompt: true,
});
export type MissionDraft = z.infer<typeof MissionDraft>;
