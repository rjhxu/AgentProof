import { actionIsAllowed, type AgentAction, type Mission } from '@agentproof/shared';

/**
 * Execution policy enforced by the runner BEFORE any Playwright call.
 * The agent proposes; the policy disposes. All page content is untrusted input.
 */

export function allowedHosts(): string[] {
  return (process.env.AGENTPROOF_ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function hostIsAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts().includes(host);
  } catch {
    return false;
  }
}

/**
 * Text that indicates a payment submission control. Never click, type into or choose these.
 * The anchored patterns run against the trimmed text and, for a role:name target such as
 * "button:Pay", against the accessible name alone.
 */
const PAYMENT_PATTERNS = [
  /place\s*order/i,
  /pay\s*now/i,
  /submit\s*payment/i,
  /confirm\s*purchase/i,
  /buy\s*now/i,
  /complete\s*(?:order|purchase)/i,
  /confirm\s*order/i,
  /submit\s*order/i,
  /^pay$/i,
  /^pay\s+[$€£\d]/i,
];

/** "button:Pay" -> "Pay". */
const ROLE_PREFIX = /^[a-z]+\s*:\s*/i;

/**
 * True when a control's text (visible text, accessible name, value, or a role:name target)
 * reads like a payment submission. checkAction() applies it to click and type targets and to
 * both halves of a select (chooseOption's last rung clicks a button named after the value); the
 * browser agent applies it to the element under an x,y coordinate before a vision agent clicks
 * it, since a coordinate target carries no text for checkAction() to read.
 */
export function isPaymentControl(text: string): boolean {
  const trimmed = text.trim();
  const name = trimmed.replace(ROLE_PREFIX, '').trim();
  return PAYMENT_PATTERNS.some((p) => p.test(trimmed) || p.test(name));
}

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

export function checkAction(
  mission: Mission,
  action: AgentAction,
  stepIndex: number,
): PolicyVerdict {
  if (stepIndex >= mission.maxSteps) {
    return { ok: false, reason: `Step limit ${mission.maxSteps} reached` };
  }
  if (!actionIsAllowed(action, mission.allowedActions)) {
    return { ok: false, reason: `Action "${action.type}" is not permitted by the mission` };
  }
  if (action.type === 'navigate' && !hostIsAllowed(action.url)) {
    return { ok: false, reason: `Host of ${action.url} is not in AGENTPROOF_ALLOWED_HOSTS` };
  }
  if (action.type === 'click' && isPaymentControl(action.target)) {
    return { ok: false, reason: 'Clicking a payment-submission control is never permitted' };
  }
  if (action.type === 'type' && isPaymentControl(action.target)) {
    return { ok: false, reason: 'Typing into a payment-submission control is never permitted' };
  }
  // chooseOption() resolves the value through radio -> combobox -> button, so a select whose
  // value (or group) names a payment control would click it.
  if (
    action.type === 'select' &&
    (isPaymentControl(action.value) || isPaymentControl(action.target))
  ) {
    return { ok: false, reason: 'Selecting a payment-submission control is never permitted' };
  }
  return { ok: true };
}
