import type { AgentKind, Mission, MissionReport, RunStep } from '@agentproof/shared';

type Action = NonNullable<RunStep['action']>;

/** Where a browsing agent is on the purchase path, read from the page it is on. */
export type Stage = 'find' | 'variant' | 'cart' | 'review';

export const STAGES: readonly Stage[] = ['find', 'variant', 'cart', 'review'];

export const STAGE_LABELS: Record<Stage, string> = {
  find: 'Find',
  variant: 'Choose',
  cart: 'Cart',
  review: 'Checkout',
};

/** "/" find, "/products/*" variant, "/cart" cart, "/checkout*" review. Nothing invented. */
export function stageOf(url: string | undefined): Stage {
  if (!url) return 'find';
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // relative or odd; use as is
  }
  if (path.startsWith('/checkout')) return 'review';
  if (path.startsWith('/cart')) return 'cart';
  if (path.startsWith('/products')) return 'variant';
  return 'find';
}

/** "a black hoodie, size M, under $60" from the mission's requirements. */
export function describeMission(mission: Mission): string {
  const req = mission.requirements;
  const product = req.product.toLowerCase();
  const parts: string[] = [];
  parts.push(req.quantity > 1 ? `${req.quantity} × ${product}` : `a ${product}`);
  for (const [key, value] of Object.entries(req.attributes)) {
    if (product.includes(value.toLowerCase())) continue;
    parts.push(`${key} ${value}`);
  }
  if (req.maxUnitPrice !== undefined) parts.push(`under $${req.maxUnitPrice}`);
  return parts.join(', ');
}

/** "Alpha" from "Agent Alpha". */
export function shortName(name: string): string {
  return name.replace(/^Agent /, '');
}

type CostRow = MissionReport['costComparison'][number];

function multiple(row: CostRow): string {
  const m = row.relativeCost ?? 0;
  if (m <= 0) return 'no cost';
  return `${m.toFixed(m >= 10 ? 0 : 1)}×`;
}

/**
 * One sentence on what the failure cost: who failed, who passed, and what the ones that
 * passed cost relative to the cheapest shopper. Computed from the report's cost table.
 */
export function costLine(
  rows: CostRow[],
  failing: AgentKind,
  names: Partial<Record<AgentKind, string>>,
): string {
  const name = (kind: AgentKind) => shortName(names[kind] ?? kind);
  const failed = rows.find((r) => r.agentKind === failing);
  const passed = rows.filter((r) => r.status === 'passed');
  if (!failed) return '';
  const passedText =
    passed.length === 0
      ? 'no shopper completed the purchase'
      : passed.map((r) => `${name(r.agentKind)} passed at ${multiple(r)}`).join(', ');
  if ((failed.relativeCost ?? 0) === 1) {
    return `${name(failing)}, the cheapest shopper, failed here; ${passedText}.`;
  }
  if ((failed.estimatedCostUsd ?? 0) === 0) {
    return `${name(failing)} runs without a model and costs nothing; ${passedText} through the page.`;
  }
  return `${name(failing)} failed here at ${multiple(failed)} the cheapest shopper; ${passedText}.`;
}

export type ScanSummary = { completed: number; total: number; problems: number; short: string };

/** "2 of 4 shoppers completed the purchase. 2 problems found." Counts, not prose from a model. */
export function summarize(report: MissionReport): ScanSummary {
  const total = report.runs.length;
  const completed = report.runs.filter((r) => r.status === 'passed').length;
  const problems = report.runs.filter((r) => r.status === 'failed').length;
  const short = `${completed} of ${total} shoppers completed the purchase. ${
    problems === 0 ? 'No problems found.' : `${problems} problem${problems === 1 ? '' : 's'} found.`
  }`;
  return { completed, total, problems, short };
}

/** The latest action in plain words for a lane, from the step's action and outcome. */
export function plainAction(step: RunStep): string {
  const action = step.action;
  if (!action) return 'Working';
  const failed = step.outcome !== 'ok';
  switch (action.type) {
    case 'navigate':
      return 'Went to the store';
    case 'click': {
      if (isCoordinateTarget(action.target)) {
        return action.reason.length > 72 ? `${action.reason.slice(0, 69)}…` : action.reason;
      }
      const [role, ...rest] = action.target.split(':');
      const label = rest.join(':') || action.target;
      if (/add to cart/i.test(label)) return failed ? 'Could not add to cart' : 'Added to cart';
      if (/checkout/i.test(label)) return failed ? 'Could not reach checkout' : 'Went to checkout';
      return failed
        ? `Could not open ${label}`
        : role === 'link'
          ? `Opened ${label}`
          : `Clicked ${label}`;
    }
    case 'select':
      return failed
        ? `Tried to pick ${action.target.toLowerCase()} ${action.value}`
        : `Picked ${action.target.toLowerCase()} ${action.value}`;
    case 'type':
      return `Typed "${action.text}"`;
    case 'scroll':
      return `Scrolled ${action.direction}`;
    case 'extract':
      return `Read ${action.what}`;
    case 'done':
      return 'Reached checkout review';
    case 'fail':
      return 'Gave up';
    default:
      return 'Working';
  }
}

/** "$0.0025" under a cent, "$0.054" under a dollar, "$1.20" above; "$0" for nothing spent. */
export function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return 'n/a';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** "850 ms", "4.2 s", "13 s". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** "claude-haiku-5-5" -> "Haiku 5.5"; "none" -> "no model"; anything else unchanged. */
export function shortModel(model: string): string {
  if (model === 'none' || model === '') return 'no model';
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (!match) return model;
  const family = match[1] ?? '';
  const major = match[2] ?? '';
  const minor = match[3] ?? '';
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

/** "semantic_interface_problem" -> "Semantic interface problem". */
export function humanize(id: string): string {
  const words = id.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Beta targets by viewport coordinates: "262,300". */
export function isCoordinateTarget(target: string): boolean {
  return /^\s*\d+\s*,\s*\d+\s*$/.test(target);
}

/**
 * The agent's own one-line reason for a step, when the action itself is not readable: a
 * click by coordinates says nothing to a person, so the panel shows why the agent clicked.
 * Model-written text; the panel shows it muted, under the action, never as a verdict.
 */
export function stepNote(step: RunStep): string | undefined {
  if (step.outcome !== 'ok') return step.outcomeDetail;
  const action = step.action;
  if (action?.type === 'click' && isCoordinateTarget(action.target)) return action.reason;
  return undefined;
}

/** One line per step for the panel's step list. */
export function describeAction(action: Action | undefined): string {
  if (!action) return 'no action';
  switch (action.type) {
    case 'navigate':
      return `open ${action.url}`;
    case 'click':
      return isCoordinateTarget(action.target)
        ? `click at ${action.target.replace(/\s/g, '')}`
        : `click ${action.target}`;
    case 'type':
      return `type "${action.text}" into ${action.target}`;
    case 'select':
      return `select ${action.value} in ${action.target}`;
    case 'scroll':
      return `scroll ${action.direction}`;
    case 'extract':
      return `read ${action.what}`;
    case 'done':
      return `done: ${action.summary}`;
    case 'fail':
      return `gave up: ${action.reason}`;
    default:
      return (action as { type: string }).type;
  }
}
