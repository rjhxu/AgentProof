import {
  AGENT_LABELS,
  CHECKPOINT_LABELS,
  EMPTY_USAGE,
  type AgentClaim,
  type AgentKind,
  type Checkpoint,
  type LlmUsage,
  type Mission,
  type RunStep,
} from '@agentproof/shared';
import { summarizeStep } from './actions';
import { LlmError, getLlm } from './llm';
import type { LlmClient } from './llm-types';
import { resolveModel } from './profiles';
import { buildNarrativePrompt } from './prompts';

/**
 * The agent's own account of a run, written after the run from its step log and the verifier's
 * checkpoint table. Reports carry it verbatim, labelled as the agent's narrative, never as a
 * verdict. Gamma runs no model and gets the deterministic summary; every browser agent gets one
 * narrator call, and any failure of that call falls back to the deterministic summary so a
 * report is always produced.
 */

export const NARRATIVE_MAX_TOKENS = 700;
export const NARRATIVE_TIMEOUT_MS = 60_000;
export const NARRATIVE_UNAVAILABLE_PREFIX = 'Narrative unavailable';

export interface DeterministicNarrativeArgs {
  kind: AgentKind;
  steps: RunStep[];
  claim?: AgentClaim;
  checkpoints: Checkpoint[];
  /** Human-readable senses, e.g. ["accessibility tree (roles + accessible names)"] */
  perceives: string[];
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Two to four factual sentences built from counts, the stopping claim and the first failed
 * checkpoint. Used for Gamma and as the fallback when the narrator call fails.
 */
export function deterministicNarrative(args: DeterministicNarrativeArgs): string {
  const { kind, steps, claim, checkpoints, perceives } = args;
  const name = AGENT_LABELS[kind].name;
  const senses = perceives.length ? joinList(perceives) : 'nothing listed';
  const sentences: string[] = [];

  if (steps.length === 0) {
    sentences.push(`${name} recorded no browser steps; it perceived ${senses}.`);
  } else {
    const executed = steps.filter((s) => s.outcome === 'ok').length;
    const notExecuted = steps.length - executed;
    const byOutcome = new Map<string, number>();
    for (const s of steps) {
      if (s.outcome === 'ok') continue;
      byOutcome.set(s.outcome, (byOutcome.get(s.outcome) ?? 0) + 1);
    }
    const breakdown = [...byOutcome.entries()]
      .map(([outcome, n]) => `${n} ${outcome.replace(/_/g, ' ')}`)
      .join(', ');
    const executionClause =
      notExecuted === 0
        ? 'every action executed'
        : `${pluralize(notExecuted, 'action')} did not execute (${breakdown})`;
    sentences.push(
      `${name} took ${pluralize(steps.length, 'step')} perceiving ${senses}; ${executionClause}.`,
    );
    const firstProblem = steps.find((s) => s.outcome !== 'ok');
    if (firstProblem)
      sentences.push(`The first action that did not execute was ${summarizeStep(firstProblem)}.`);
  }

  if (claim)
    sentences.push(`It stopped with ${claim.outcome}: ${claim.summary}`.replace(/\.?$/, '.'));

  if (checkpoints.length === 0) {
    sentences.push('No checkpoints were evaluated.');
  } else {
    const passed = checkpoints.filter((c) => c.status === 'passed').length;
    const first = checkpoints.find((c) => c.status === 'failed');
    const verdict = `The verifier passed ${passed} of ${pluralize(checkpoints.length, 'checkpoint')}`;
    if (first) {
      const detail = first.detail ? ` (${first.detail.replace(/\.?$/, '')})` : '';
      sentences.push(`${verdict}; the first failure was ${CHECKPOINT_LABELS[first.id]}${detail}.`);
    } else {
      sentences.push(`${verdict}; none failed.`);
    }
  }

  return sentences.join(' ');
}

export interface GenerateNarrativeArgs extends DeterministicNarrativeArgs {
  mission: Mission;
  /** Injected client (tests use createMockLlm); defaults to getLlm() */
  llm?: LlmClient;
  /** Model override; defaults to resolveModel('narrator', provider) */
  model?: string;
}

/** Short category for the fallback note. Never the raw message: it stays free of provider detail. */
export function narrativeFailureReason(err: unknown): string {
  if (err instanceof LlmError) {
    if (err.provider === 'none') return 'no LLM provider configured';
    if (err.status !== undefined) return `${err.provider} HTTP ${err.status}`;
    if (err.retryable) return `${err.provider} unreachable or timed out`;
    return `${err.provider} error`;
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timed out';
    return err.name && err.name !== 'Error' ? err.name : 'error';
  }
  return 'error';
}

function fallback(args: DeterministicNarrativeArgs, reason: string): string {
  return `${NARRATIVE_UNAVAILABLE_PREFIX} (${reason}); deterministic summary follows. ${deterministicNarrative(args)}`;
}

/**
 * One narrator call for a browser agent's run; the deterministic summary for Gamma. Never
 * throws: on any error the deterministic summary is returned with a leading note and zero usage.
 */
export async function generateNarrative(
  args: GenerateNarrativeArgs,
): Promise<{ narrative: string; usage: LlmUsage }> {
  const { kind, mission, steps, claim, checkpoints, perceives } = args;
  const base: DeterministicNarrativeArgs = {
    kind,
    steps,
    checkpoints,
    perceives,
    ...(claim ? { claim } : {}),
  };
  if (kind === 'gamma_structured') {
    return { narrative: deterministicNarrative(base), usage: { ...EMPTY_USAGE } };
  }

  try {
    const client = args.llm ?? getLlm();
    const model = args.model ?? resolveModel('narrator', client.provider);
    const { system, user } = buildNarrativePrompt({
      kind,
      mission,
      steps,
      checkpoints,
      perceives,
      ...(claim ? { claim } : {}),
    });
    const response = await client.complete({
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: NARRATIVE_MAX_TOKENS,
      timeoutMs: NARRATIVE_TIMEOUT_MS,
    });
    const narrative = response.text.trim();
    if (!narrative) {
      // The call was made and billed, so its usage is kept even though the text is replaced.
      return { narrative: fallback(base, 'empty response'), usage: response.usage };
    }
    return { narrative, usage: response.usage };
  } catch (err) {
    return { narrative: fallback(base, narrativeFailureReason(err)), usage: { ...EMPTY_USAGE } };
  }
}
