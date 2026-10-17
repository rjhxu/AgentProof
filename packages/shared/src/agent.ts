import { z } from 'zod';
import type { AllowedAction } from './mission';

/** The three testing strategies. Alpha and Beta are browser agents; Gamma inspects structured data. */
export const AgentKind = z.enum(['alpha_semantic', 'beta_vision', 'gamma_structured']);
export type AgentKind = z.infer<typeof AgentKind>;

export const AGENT_LABELS: Record<AgentKind, { name: string; strategy: string }> = {
  alpha_semantic: {
    name: 'Agent Alpha',
    strategy: 'Semantic browser agent (accessibility tree + DOM)',
  },
  beta_vision: {
    name: 'Agent Beta',
    strategy: 'Vision-assisted browser agent (screenshots + coordinates)',
  },
  gamma_structured: {
    name: 'Agent Gamma',
    strategy: 'Structured commerce inspector (catalog feed + cart API)',
  },
};

export const AgentConfig = z.object({
  kind: AgentKind,
  model: z.string().default('claude-opus-5-5'),
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
 * `target` semantics differ per agent: Alpha uses a role/name pair or CSS selector,
 * Beta uses "x,y" viewport coordinates.
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

export function isMutatingAction(action: AgentAction): boolean {
  return action.type === 'click' || action.type === 'type' || action.type === 'select';
}

export function actionIsAllowed(action: AgentAction, allowed: AllowedAction[]): boolean {
  if (action.type === 'done' || action.type === 'fail') return true;
  return (allowed as string[]).includes(action.type);
}
