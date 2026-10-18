import {
  AgentActionDraft,
  type AgentAction,
  type AgentKind,
  type RunStep,
} from '@agentproof/shared';
import { toStrictJsonSchema } from './llm';
import {
  describeTarget,
  describeTargetGrammar,
  parseTarget,
  targetGrammars,
  targetShape,
} from './targets';

/**
 * Bridge between the model's flat structured output (AgentActionDraft) and the typed
 * AgentAction the policy and the browser execute. Conversion failures return a reason that is
 * shown to the model on its next turn, so every reason says what a valid action looks like.
 */

export const ACTION_SCHEMA_NAME = 'agent_action';

type Viewport = { width: number; height: number };

/** Model-facing field descriptions, injected into the JSON schema. */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  type: 'The single action to take this turn.',
  reason: 'One sentence: why this action. For done it is your summary; for fail, what blocked you.',
  target:
    'Control to act on, in your target grammar (click, type). For select: the option group label as the accessibility tree names it, e.g. Size, or its role:name, e.g. combobox:Size. Null otherwise.',
  url: 'Absolute http(s) URL on the store (navigate only). Null otherwise.',
  text: 'Text to type into the target (type only). Null otherwise.',
  value:
    "The option's exact accessible name as the accessibility tree shows it, case-sensitive, e.g. M or Navy, not the mission's spelling (select only). Null otherwise.",
  direction: 'up or down (scroll only). Null otherwise.',
  what: 'What to read off the page (extract only). Null otherwise.',
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The strict JSON schema requested from the provider for every decide() call: llm.ts's
 * provider-strictness rules (object root, every property required, additionalProperties false,
 * nullable as `type: [T, 'null']` / anyOf + null, no $schema or default keys) applied to
 * AgentActionDraft, plus a model-facing description per field. Built fresh on every call.
 */
export function actionDraftJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const { schema } = toStrictJsonSchema(AgentActionDraft, ACTION_SCHEMA_NAME);
  const props = isObject(schema.properties) ? schema.properties : {};
  const described: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(props)) {
    const description = FIELD_DESCRIPTIONS[name];
    described[name] =
      description && isObject(prop) && !('description' in prop) ? { ...prop, description } : prop;
  }
  return { name: ACTION_SCHEMA_NAME, schema: { ...schema, properties: described } };
}

export type ActionConversion = { ok: true; action: AgentAction } | { ok: false; reason: string };

const DRAFT_OPTIONAL_FIELDS = ['target', 'url', 'text', 'value', 'direction', 'what'] as const;

const fail = (reason: string): ActionConversion => ({ ok: false, reason });
const ok = (action: AgentAction): ActionConversion => ({ ok: true, action });

const clean = (s: string | null | undefined): string => (typeof s === 'string' ? s.trim() : '');

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    if ((first === '"' || first === "'") && first === t[t.length - 1]) return t.slice(1, -1).trim();
  }
  return t;
}

const SELECT_TARGET_HINT =
  'the option group label as the accessibility tree names it (e.g. Size) or its role:name (e.g. combobox:Size)';

/**
 * Why `select` is rejected for Beta. Shown to the model next turn; the Beta system prompt says
 * the same thing, and buildUserTurn() drops select from Beta's allowedActions so the mission JSON
 * never advertises it.
 */
export const BETA_SELECT_REJECTION =
  "this agent picks options by clicking them: use click with the option's x,y";

/**
 * A select target names the option GROUP for chooseOption's ladder (radio -> combobox -> button),
 * which resolves purely through the accessibility tree. So it is either a bare group label such
 * as "Size" or a role:name, and only agents that read the tree may use it: Beta picks options by
 * clicking them, and an x,y target is rejected for everyone (there is no coordinate executor, and
 * routing it to the ladder would hand a vision agent the tree).
 */
function resolveSelectTarget(
  target: string,
  kind: AgentKind,
  viewport?: Viewport,
): { ok: true; target: string } | { ok: false; reason: string } {
  if (!targetGrammars(kind).includes('role:name')) {
    return { ok: false, reason: BETA_SELECT_REJECTION };
  }
  const shape = targetShape(target);
  if (shape === 'x,y') {
    return {
      ok: false,
      reason: `select target "${target}" is x,y coordinates, but select resolves the option group through the accessibility tree; use ${SELECT_TARGET_HINT}, or click the option by x,y`,
    };
  }
  if (shape === 'role:name') {
    const parsed = parseTarget(target, kind, viewport);
    if (parsed.kind === 'invalid') return { ok: false, reason: `select target ${parsed.reason}` };
    return { ok: true, target: describeTarget(parsed) };
  }
  const label = stripQuotes(target);
  if (!label) return { ok: false, reason: `select needs "target": ${SELECT_TARGET_HINT}` };
  return { ok: true, target: label };
}

/**
 * Validate a raw structured-output object and convert it into a typed AgentAction.
 * Missing optional fields, and empty strings in them, are treated as null (a model that fills
 * every unused slot with "" must not lose its click). Reasons are specific: they are what the
 * model reads next turn.
 */
export function toAgentAction(
  draft: unknown,
  kind: AgentKind,
  viewport?: Viewport,
): ActionConversion {
  if (!isObject(draft)) {
    return fail(`action must be a JSON object with a "type" field, got ${describeValue(draft)}`);
  }
  const normalized: Record<string, unknown> = { ...draft };
  for (const field of DRAFT_OPTIONAL_FIELDS) {
    const v = normalized[field];
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) normalized[field] = null;
  }
  const parsed = AgentActionDraft.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return fail(`action does not match the schema: ${issues}`);
  }
  const d = parsed.data;
  const reason = clean(d.reason);

  const needsBrowser = d.type === 'click' || d.type === 'type' || d.type === 'select';
  if (needsBrowser && targetGrammars(kind).length === 0) {
    return fail(`agent ${kind} does not take browser actions (it has no browser)`);
  }

  switch (d.type) {
    case 'navigate': {
      const url = clean(d.url);
      if (!url) return fail('navigate needs "url": an absolute http(s) URL on the store');
      let protocol = '';
      try {
        protocol = new URL(url).protocol;
      } catch {
        return fail(`navigate url "${url}" is not an absolute http(s) URL`);
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        return fail(`navigate url "${url}" must use http or https`);
      }
      return ok({ type: 'navigate', url, reason });
    }
    case 'click': {
      const target = clean(d.target);
      if (!target) return fail(`click needs "target": ${describeTargetGrammar(kind)}`);
      const t = parseTarget(target, kind, viewport);
      if (t.kind === 'invalid') return fail(`click target ${t.reason}`);
      return ok({ type: 'click', target: describeTarget(t), reason });
    }
    case 'type': {
      const target = clean(d.target);
      if (!target) return fail(`type needs "target": ${describeTargetGrammar(kind)}`);
      if (d.text === null) return fail('type needs "text": the text to type into the target');
      const t = parseTarget(target, kind, viewport);
      if (t.kind === 'invalid') return fail(`type target ${t.reason}`);
      return ok({ type: 'type', target: describeTarget(t), text: d.text, reason });
    }
    case 'select': {
      const target = clean(d.target);
      const value = clean(d.value);
      if (!target) return fail(`select needs "target": ${SELECT_TARGET_HINT}`);
      if (!value) {
        return fail(
          'select needs "value": the option\'s exact accessible name as the accessibility tree shows it (case-sensitive), e.g. M or Navy',
        );
      }
      const resolved = resolveSelectTarget(target, kind, viewport);
      if (!resolved.ok) return fail(resolved.reason);
      return ok({ type: 'select', target: resolved.target, value, reason });
    }
    case 'scroll': {
      if (d.direction === null) return fail('scroll needs "direction": up or down');
      return ok({ type: 'scroll', direction: d.direction, reason });
    }
    case 'extract': {
      const what = clean(d.what);
      if (!what) return fail('extract needs "what": what to read off the page');
      return ok({ type: 'extract', what, reason });
    }
    case 'done':
      return ok({ type: 'done', summary: reason || 'milestone reached (no summary given)' });
    case 'fail':
      return ok({ type: 'fail', reason: reason || 'agent gave up without giving a reason' });
  }
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

const ACTION_SUMMARY_MAX = 120;
const DETAIL_MAX = 200;

/** Collapse whitespace (Playwright errors are multi-line) and cap the length. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/** `click button:Add to cart`, `select Size = M`, `done: ...` (<= 120 chars). */
export function summarizeAction(action: AgentAction): string {
  let line: string;
  switch (action.type) {
    case 'navigate':
      line = `navigate ${action.url}`;
      break;
    case 'click':
      line = `click ${action.target}`;
      break;
    case 'type':
      line = `type "${action.text}" into ${action.target}`;
      break;
    case 'select':
      line = `select ${action.target} = ${action.value}`;
      break;
    case 'scroll':
      line = `scroll ${action.direction}`;
      break;
    case 'extract':
      line = `extract ${action.what}`;
      break;
    case 'done':
      line = `done: ${action.summary}`;
      break;
    case 'fail':
      line = `fail: ${action.reason}`;
      break;
  }
  return oneLine(line, ACTION_SUMMARY_MAX);
}

/** `#3 click button:Add to cart -> ok`, `#4 select Size = M -> error: no radio "M", ...`. */
export function summarizeStep(step: RunStep): string {
  const what = step.action ? summarizeAction(step.action) : '(no action)';
  const detail = step.outcomeDetail ? `: ${oneLine(step.outcomeDetail, DETAIL_MAX)}` : '';
  return `#${step.index} ${what} -> ${step.outcome}${detail}`;
}
