import {
  CHECKPOINT_ORDER,
  type Checkpoint,
  type CheckpointId,
  type Mission,
  type ObservedCart,
  type VerificationResult,
  nowIso,
} from '@agentproof/shared';

/**
 * Everything the verifier needs. The runner assembles this from evidence it captured.
 * Fields are optional because a run may end before some were observable.
 */
export interface VerificationInput {
  mission: Mission;
  /** Cart as observed from the store API (preferred) or the cart page */
  cart?: ObservedCart;
  /** Evidence ids to attach to cart-derived checkpoints */
  cartEvidenceIds?: string[];
  /** Did the agent land on a product page whose title/attributes match the request? */
  productPage?: {
    found: boolean;
    name?: string;
    attributes?: Record<string, string>;
    evidenceIds?: string[];
  };
  /** Did the agent reach the order review page? */
  checkoutReached?: { reached: boolean; evidenceIds?: string[] };
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

function attributeMatches(required: string, observed: string | undefined): boolean {
  if (observed === undefined) return false;
  const r = norm(required);
  const o = norm(observed);
  if (r === o) return true;
  // Tolerate common size spellings: "M" vs "medium"
  const sizeAliases: Record<string, string[]> = {
    xs: ['extra small', 'x-small'],
    s: ['small'],
    m: ['medium', 'med'],
    l: ['large'],
    xl: ['extra large', 'x-large'],
  };
  const aliases = sizeAliases[r] ?? [];
  return aliases.includes(o) || (sizeAliases[o] ?? []).includes(r);
}

/**
 * Deterministic verification. Budget arithmetic and variant comparisons live here, never in an LLM.
 * Checkpoints after the first hard failure are marked not_tested unless evidence exists for them.
 */
export function verify(input: VerificationInput): VerificationResult {
  const { mission, cart } = input;
  const req = mission.requirements;
  const out = new Map<CheckpointId, Checkpoint>();
  const set = (c: Checkpoint) => out.set(c.id, c);

  // --- product page checkpoints -------------------------------------------------
  const pp = input.productPage;
  if (!pp) {
    set({ id: 'product_discovered', status: 'not_verified', evidenceIds: [] });
  } else {
    set({
      id: 'product_discovered',
      status: pp.found ? 'passed' : 'failed',
      detail: pp.found
        ? `Landed on "${pp.name ?? 'product page'}"`
        : 'No matching product page reached',
      evidenceIds: pp.evidenceIds ?? [],
    });
  }

  for (const [attr, cpId] of [
    ['color', 'correct_color_identified'],
    ['size', 'correct_size_identified'],
  ] as const) {
    const required = req.attributes[attr];
    if (required === undefined) continue; // mission does not care about this attribute
    const observed = pp?.attributes?.[attr] ?? cart?.items[0]?.attributes[attr];
    if (!pp && !cart) {
      set({ id: cpId, status: 'not_tested', evidenceIds: [] });
    } else if (observed === undefined) {
      set({
        id: cpId,
        status: 'not_verified',
        detail: `No ${attr} value observable`,
        evidenceIds: pp?.evidenceIds ?? [],
      });
    } else {
      set({
        id: cpId,
        status: attributeMatches(required, observed) ? 'passed' : 'failed',
        detail: `Required ${attr} "${required}", observed "${observed}"`,
        evidenceIds: [...(pp?.evidenceIds ?? []), ...(input.cartEvidenceIds ?? [])],
      });
    }
  }

  // --- cart checkpoints ----------------------------------------------------------
  const cartEv = input.cartEvidenceIds ?? [];
  if (!cart) {
    set({
      id: 'added_to_cart',
      status: 'not_verified',
      detail: 'No cart observed',
      evidenceIds: [],
    });
    set({ id: 'cart_matches_variant', status: 'not_tested', evidenceIds: [] });
    set({ id: 'cart_quantity_correct', status: 'not_tested', evidenceIds: [] });
    set({ id: 'price_within_budget', status: 'not_tested', evidenceIds: [] });
  } else if (cart.items.length === 0) {
    set({ id: 'added_to_cart', status: 'failed', detail: 'Cart is empty', evidenceIds: cartEv });
    set({ id: 'cart_matches_variant', status: 'not_tested', evidenceIds: [] });
    set({ id: 'cart_quantity_correct', status: 'not_tested', evidenceIds: [] });
    set({ id: 'price_within_budget', status: 'not_tested', evidenceIds: [] });
  } else {
    set({
      id: 'added_to_cart',
      status: 'passed',
      detail: `${cart.items.length} line item(s) in cart`,
      evidenceIds: cartEv,
    });

    // Find the line item that best matches the requested product name.
    const wanted = norm(req.product);
    const item =
      cart.items.find((i) => wanted.split(/\s+/).every((w) => norm(i.name).includes(w))) ??
      cart.items[0]!;

    const mismatches = Object.entries(req.attributes)
      .filter(([k, v]) => !attributeMatches(v, item.attributes[k]))
      .map(([k, v]) => `${k}: required "${v}", cart has "${item.attributes[k] ?? 'none'}"`);
    set({
      id: 'cart_matches_variant',
      status: mismatches.length === 0 ? 'passed' : 'failed',
      detail:
        mismatches.length === 0
          ? `Cart variant ${item.variantId ?? item.productId} matches all requested attributes`
          : mismatches.join('; '),
      evidenceIds: cartEv,
    });

    set({
      id: 'cart_quantity_correct',
      status: item.quantity === req.quantity ? 'passed' : 'failed',
      detail: `Required ${req.quantity}, cart has ${item.quantity}`,
      evidenceIds: cartEv,
    });

    const budgetProblems: string[] = [];
    if (req.maxUnitPrice !== undefined && item.unitPrice > req.maxUnitPrice) {
      budgetProblems.push(
        `unit $${item.unitPrice.toFixed(2)} > max $${req.maxUnitPrice.toFixed(2)}`,
      );
    }
    if (req.maxTotalPrice !== undefined && cart.subtotal > req.maxTotalPrice) {
      budgetProblems.push(
        `subtotal $${cart.subtotal.toFixed(2)} > max $${req.maxTotalPrice.toFixed(2)}`,
      );
    }
    if (req.maxUnitPrice === undefined && req.maxTotalPrice === undefined) {
      set({
        id: 'price_within_budget',
        status: 'passed',
        detail: 'No budget constraint',
        evidenceIds: [],
      });
    } else {
      set({
        id: 'price_within_budget',
        status: budgetProblems.length === 0 ? 'passed' : 'failed',
        detail:
          budgetProblems.length === 0
            ? `unit $${item.unitPrice.toFixed(2)}, subtotal $${cart.subtotal.toFixed(2)} within budget`
            : budgetProblems.join('; '),
        evidenceIds: cartEv,
      });
    }
  }

  // --- checkout ------------------------------------------------------------------
  if (mission.successMilestone === 'checkout_review') {
    const co = input.checkoutReached;
    set({
      id: 'checkout_review_reached',
      status: !co ? 'not_tested' : co.reached ? 'passed' : 'failed',
      evidenceIds: co?.evidenceIds ?? [],
    });
  }

  const checkpoints = CHECKPOINT_ORDER.filter((id) => out.has(id)).map((id) => out.get(id)!);
  const firstFailure = checkpoints.find((c) => c.status === 'failed');
  return { checkpoints, observedCart: cart, firstFailure, verifiedAt: nowIso() };
}

/** Overall verdict for a run from its verification. */
export function overallStatus(v: VerificationResult): 'passed' | 'failed' {
  return v.checkpoints.some((c) => c.status === 'failed') ? 'failed' : 'passed';
}
