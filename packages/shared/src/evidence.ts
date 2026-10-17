import { z } from 'zod';

/** Anything the runner captured that a human or the diagnoser can inspect. */
export const EvidenceKind = z.enum([
  'screenshot',
  'trace', // Playwright trace zip
  'dom_snapshot', // accessibility tree or HTML excerpt
  'network', // request/response pair
  'cart_state', // JSON cart as observed from the store
  'catalog_record', // JSON product record from the structured feed
  'agent_note', // the agent's own reasoning for a step (NOT authoritative)
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  id: z.string(),
  runId: z.string(),
  kind: EvidenceKind,
  /** Step index this was captured at, if any */
  stepIndex: z.number().int().nonnegative().optional(),
  capturedAt: z.string(),
  /** Path relative to AGENTPROOF_DATA_DIR/artifacts for file-backed evidence */
  path: z.string().optional(),
  /** Inline payload for small JSON evidence (cart_state, catalog_record, network) */
  data: z.unknown().optional(),
  label: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Normalized cart as observed from the storefront (via page or API). Verifier input. */
export const ObservedCartItem = z.object({
  productId: z.string(),
  variantId: z.string().optional(),
  name: z.string(),
  attributes: z.record(z.string(), z.string()).default({}),
  unitPrice: z.number(),
  quantity: z.number().int(),
});
export type ObservedCartItem = z.infer<typeof ObservedCartItem>;

export const ObservedCart = z.object({
  items: z.array(ObservedCartItem),
  subtotal: z.number(),
  currency: z.string().default('USD'),
  /** Where this cart came from. Makes "page vs API disagree" findings expressible. */
  source: z.enum(['page', 'api']),
});
export type ObservedCart = z.infer<typeof ObservedCart>;
