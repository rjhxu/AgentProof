import { z } from 'zod';
import type { AllowedAction } from './mission';

/**
 * The agent strategies. Alpha, Beta, and Sigma are LLM-driven browser agents that differ only in
 * what they are allowed to perceive; Gamma is a deterministic structured-data inspector.
 *
 * Thesis: a store should be navigable by the cheapest agent (Alpha: text-only accessibility
 * tree). Beta and Sigma exist to show what stronger, costlier agents achieve on the same store.
 */
export const AgentKind = z.enum([
  'alpha_semantic',
  'beta_vision',
  'gamma_structured',
  'sigma_hybrid',
]);
export type AgentKind = z.infer<typeof AgentKind>;

export const AGENT_LABELS: Record<AgentKind, { name: string; strategy: string }> = {
  alpha_semantic: {
    name: 'Agent Alpha',
    strategy: 'Semantic browser agent (accessibility tree only, text model)',
  },
  beta_vision: {
    name: 'Agent Beta',
    strategy: 'Vision browser agent (screenshots + coordinates)',
  },
  gamma_structured: {
    name: 'Agent Gamma',
    strategy: 'Structured commerce inspector (catalog feed + cart API, no LLM)',
  },
  sigma_hybrid: {
    name: 'Agent Sigma',
    strategy: 'Hybrid reference agent (accessibility tree + screenshots + text, strongest model)',
  },
};

export const AgentEffort = z.enum(['low', 'medium', 'high']);
export type AgentEffort = z.infer<typeof AgentEffort>;

export const AgentConfig = z.object({
  kind: AgentKind,
  /** LLM model id. When omitted, the agent profile's default for this kind is used. */
  model: z.string().optional(),
  /** Reasoning effort hint, mapped per provider. When omitted, the profile default is used. */
  effort: AgentEffort.optional(),
  /** Per-run step cap. The mission's maxSteps still applies; the lower of the two wins. */
  maxSteps: z.number().int().positive().optional(),
  /** Playwright viewport */
  viewport: z
    .object({ width: z.number().int(), height: z.number().int() })
    .default({ width: 1280, height: 800 }),
  headed: z.boolean().default(false),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

/**
 * Actions the browser agent may propose. The runner validates each one against the
 * Mission's allowedActions and the allowed-host list BEFORE executing it.
 *
 * `target` grammar depends on the agent:
 *   - Alpha: `role:name` only (exact accessible name), e.g. `button:Add to cart`, `radio:M`.
 *   - Beta:  `x,y` viewport coordinates, e.g. `412,388`.
 *   - Sigma: either grammar.
 */
export const AgentAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.url(), reason: z.string() }),
  z.object({ type: z.literal('click'), target: z.string(), reason: z.string() }),
  z.object({ type: z.literal('type'), target: z.string(), text: z.string(), reason: z.string() }),
  z.object({
    type: z.literal('select'),
    target: z.string(),
    value: z.string(),
    reason: z.string(),
  }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), reason: z.string() }),
  z.object({ type: z.literal('extract'), what: z.string(), reason: z.string() }),
  /** Agent believes the milestone is reached. The verifier decides whether that is true. */
  z.object({ type: z.literal('done'), summary: z.string() }),
  /** Agent gives up. The reason is recorded as evidence, not treated as the diagnosis. */
  z.object({ type: z.literal('fail'), reason: z.string() }),
]);
export type AgentAction = z.infer<typeof AgentAction>;

/**
 * Flat shape the LLM is asked to produce (structured output). Discriminated unions are
 * unreliable across providers' JSON-schema modes, so the model fills one flat object and
 * `toAgentAction()` in @agentproof/agent converts and validates it.
 */
export const AgentActionDraft = z.object({
  type: z.enum(['navigate', 'click', 'type', 'select', 'scroll', 'extract', 'done', 'fail']),
  /** Why this action, one sentence. For done/fail this is the summary / reason. */
  reason: z.string(),
  target: z.string().nullable(),
  url: z.string().nullable(),
  text: z.string().nullable(),
  value: z.string().nullable(),
  direction: z.enum(['up', 'down']).nullable(),
  what: z.string().nullable(),
});
export type AgentActionDraft = z.infer<typeof AgentActionDraft>;

export function isMutatingAction(action: AgentAction): boolean {
  return action.type === 'click' || action.type === 'type' || action.type === 'select';
}

export function actionIsAllowed(action: AgentAction, allowed: AllowedAction[]): boolean {
  if (action.type === 'done' || action.type === 'fail') return true;
  return (allowed as string[]).includes(action.type);
}
