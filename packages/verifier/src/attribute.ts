import {
  AGENT_LABELS,
  AgentKind,
  CHECKPOINT_LABELS,
  CHECKPOINT_ORDER,
  type Attribution,
  type CheckpointId,
  type FailureCategory,
  type PatternStatus,
  type Run,
} from '@agentproof/shared';

/**
 * Cross-agent attribution. Deterministic: no LLM.
 *
 * Each agent isolates one way of perceiving a store. When the reference agent (Sigma, the
 * hybrid that perceives everything; Beta when Sigma did not run) completes a checkpoint and a
 * narrower agent does not, the narrower agent's blind spot is the bug:
 *
 *   reference pass, Alpha fail  -> semantic_interface_problem   (controls lack roles/names)
 *   any browser pass, Gamma fail -> product_data_inconsistency   (feed / API disagree with page)
 *   reference pass, Beta fail   -> agent_execution_error        (vision/coordinate mistake)
 *   reference fail              -> cart_checkout_defect         (broken for every agent, or
 *                                                                 the mission is infeasible)
 *   reference fail, Alpha pass  -> agent_execution_error (reference)
 *
 * Decision recorded in docs/AGENTS.md: a Sigma failure means the store is broken for everyone.
 */

export const REFERENCE_ORDER: AgentKind[] = ['sigma_hybrid', 'beta_vision'];
const BROWSER_AGENTS: AgentKind[] = ['alpha_semantic', 'beta_vision', 'sigma_hybrid'];

/** Latest finished run per agent kind. Errored runs count as not run (infra, not a verdict). */
export function latestRunsByKind(runs: Run[]): Partial<Record<AgentKind, Run>> {
  const out: Partial<Record<AgentKind, Run>> = {};
  const sorted = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of sorted) {
    if (run.status !== 'passed' && run.status !== 'failed') continue;
    out[run.agent.kind] = run;
  }
  return out;
}

export function patternFor(
  checkpointId: CheckpointId,
  byKind: Partial<Record<AgentKind, Run>>,
): Record<AgentKind, PatternStatus> {
  const pattern = {} as Record<AgentKind, PatternStatus>;
  for (const kind of AgentKind.options) {
    const run = byKind[kind];
    const cp = run?.verification?.checkpoints.find((c) => c.id === checkpointId);
    pattern[kind] = cp?.status ?? 'not_run';
  }
  return pattern;
}

const name = (k: AgentKind) => AGENT_LABELS[k].name;

/** Attributions for one checkpoint. Empty when fewer than two agents produced a verdict. */
export function attributeCheckpoint(
  checkpointId: CheckpointId,
  byKind: Partial<Record<AgentKind, Run>>,
): Attribution[] {
  const pattern = patternFor(checkpointId, byKind);
  const label = CHECKPOINT_LABELS[checkpointId];
  const ran = AgentKind.options.filter((k) => pattern[k] !== 'not_run');
  if (ran.length < 2) return [];

  const reference = REFERENCE_ORDER.find((k) => pattern[k] !== 'not_run');
  const out: Attribution[] = [];
  const push = (category: FailureCategory, failingAgents: AgentKind[], reason: string) =>
    out.push({ checkpointId, category, reason, reference, pattern, failingAgents });

  const alpha = pattern.alpha_semantic;
  const gamma = pattern.gamma_structured;
  const anyBrowserPassed = BROWSER_AGENTS.some((k) => pattern[k] === 'passed');

  // Gamma is judged against any browser agent: if a browser path worked, the data path is wrong.
  if (gamma === 'failed' && anyBrowserPassed) {
    const witness = BROWSER_AGENTS.find((k) => pattern[k] === 'passed')!;
    push(
      'product_data_inconsistency',
      ['gamma_structured'],
      `${name(witness)} passed through the page while ${name('gamma_structured')} failed through the catalog and cart API on "${label}"`,
    );
  }

  if (!reference) return out;
  const refStatus = pattern[reference];

  if (refStatus === 'passed') {
    if (alpha === 'failed') {
      push(
        'semantic_interface_problem',
        ['alpha_semantic'],
        `${name(reference)} passed and ${name('alpha_semantic')} failed on "${label}": the control was usable on screen but not through the accessibility tree`,
      );
    }
    if (reference === 'sigma_hybrid' && pattern.beta_vision === 'failed') {
      push(
        'agent_execution_error',
        ['beta_vision'],
        `${name('sigma_hybrid')} passed and ${name('beta_vision')} failed on "${label}": likely a vision or coordinate mistake rather than a store defect`,
      );
    }
    if (gamma === 'failed' && !anyBrowserPassed) {
      // unreachable (reference passed implies a browser agent passed) but keeps the table total
    }
    return out;
  }

  if (refStatus === 'failed') {
    if (alpha === 'passed') {
      push(
        'agent_execution_error',
        [reference],
        `${name(reference)} failed where ${name('alpha_semantic')} passed on "${label}": the reference agent made a mistake`,
      );
      return out;
    }
    const failing = AgentKind.options.filter((k) => pattern[k] === 'failed');
    push(
      'cart_checkout_defect',
      failing,
      `${name(reference)}, the most capable agent, failed on "${label}": the store is broken for every agent on this path, or the mission is infeasible on this store`,
    );
  }
  return out;
}

/** Attributions for every failed checkpoint across a mission's runs, in checkpoint order. */
export function attributeMission(runs: Run[]): Attribution[] {
  const byKind = latestRunsByKind(runs);
  const out: Attribution[] = [];
  for (const checkpointId of CHECKPOINT_ORDER) {
    const anyFailed = Object.values(byKind).some((run) =>
      run?.verification?.checkpoints.some((c) => c.id === checkpointId && c.status === 'failed'),
    );
    if (!anyFailed) continue;
    out.push(...attributeCheckpoint(checkpointId, byKind));
  }
  return out;
}

/** What the store must change so the cheapest agent succeeds. Deterministic, from attributions. */
export function recommendationsFrom(attributions: Attribution[]): string[] {
  const byCategory = new Map<FailureCategory, string[]>();
  for (const a of attributions) {
    const labels = byCategory.get(a.category) ?? [];
    const label = CHECKPOINT_LABELS[a.checkpointId];
    if (!labels.includes(label)) labels.push(label);
    byCategory.set(a.category, labels);
  }
  const quoted = (labels: string[]) => labels.map((l) => `"${l}"`).join(', ');
  const out: string[] = [];
  for (const [category, labels] of byCategory) {
    switch (category) {
      case 'semantic_interface_problem':
        out.push(
          `Expose the controls behind ${quoted(labels)} with a real role and accessible name (native inputs, labels, aria-*), so a text-only agent can find and operate them without screenshots.`,
        );
        break;
      case 'product_data_inconsistency':
        out.push(
          `Make the structured catalog and the cart API agree with the product page for ${quoted(labels)}: an agent that never renders the page must get the same variant and price a shopper sees.`,
        );
        break;
      case 'cart_checkout_defect':
        out.push(
          `Fix the purchase path behind ${quoted(labels)}: the most capable agent could not complete it, so this is not a perception problem.`,
        );
        break;
      case 'agent_execution_error':
        out.push(
          `Re-run ${quoted(labels)} for the failing agent before changing the store; the evidence points at the agent, not the site.`,
        );
        break;
      default:
        break;
    }
  }
  return out;
}
