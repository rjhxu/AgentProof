import { z } from 'zod';
import {
  AgentActionDraft,
  type AgentAction,
  type AgentKind,
  type RunStep,
} from '@agentproof/shared';
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
    'Control to act on, in your target grammar (click, type). For select: the option group label as the accessibility tree names it, e.g. Size. Null otherwise.',
  url: 'Absolute http(s) URL on the store (navigate only). Null otherwise.',
  text: 'Text to type into the target (type only). Null otherwise.',
  value: 'The option to choose, e.g. M (select only). Null otherwise.',
  direction: 'up or down (scroll only). Null otherwise.',
  what: 'What to read off the page (extract only). Null otherwise.',
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Strict-mode rules shared by the providers' JSON-schema modes: object roots, every property
 * required, additionalProperties false, no $schema / default keys. Nullable fields stay as
 * `type: [T, 'null']` or `anyOf: [..., { type: 'null' }]`, which is what z.toJSONSchema emits.
 */
function strictify(node: unknown, path: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => strictify(n, path));
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'default') continue;
    if (key === 'properties' && isObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(value)) {
        const strictProp = strictify(prop, [...path, name]);
        const description = path.length === 0 ? FIELD_DESCRIPTIONS[name] : undefined;
        props[name] =
          description && isObject(strictProp) && !('description' in strictProp)
            ? { ...strictProp, description }
            : strictProp;
      }
      out.properties = props;
      out.required = Object.keys(props);
      out.additionalProperties = false;
      continue;
    }
    if (key === 'required' || key === 'additionalProperties') continue; // rewritten above
    out[key] = strictify(value, path);
  }
  return out;
}

/** The strict JSON schema requested from the provider for every decide() call. */
export function actionDraftJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const raw = z.toJSONSchema(AgentActionDraft);
  const schema = strictify(raw) as Record<string, unknown>;
  schema.type = 'object';
  return { name: ACTION_SCHEMA_NAME, schema };
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
  const allowed = targetGrammars(kind);
  if (allowed.length === 0) {
    return { ok: false, reason: `agent ${kind} does not take actions (it has no browser)` };
  }
  if (!allowed.includes('role:name')) {
    return {
      ok: false,
      reason:
        'select is not available to this agent: it resolves options through the accessibility tree, which this agent cannot see; click the option directly with its x,y (for a dropdown, click it open, then click the option)',
    };
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
      if (!value) return fail('select needs "value": the option to choose, e.g. M');
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
