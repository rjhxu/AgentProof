import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type Checkpoint, type RunStep } from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import { LlmError, createMockLlm } from './llm';
import type { LlmClient } from './llm-types';
import {
  NARRATIVE_MAX_TOKENS,
  NARRATIVE_TIMEOUT_MS,
  NARRATIVE_UNAVAILABLE_PREFIX,
  deterministicNarrative,
  generateNarrative,
  narrativeFailureReason,
} from './narrative';
import { AGENT_PROFILES, resolveModel } from './profiles';

const checkpoints: Checkpoint[] = alphaFailedRun.verification!.checkpoints;
const steps: RunStep[] = alphaFailedRun.steps;
const perceives = AGENT_PROFILES.alpha_semantic.perceivesLabels;
const claim = { outcome: 'done' as const, summary: 'Reached the checkout review page' };

const sentenceCount = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z])/).length;

function failingLlm(err: unknown): LlmClient {
  return {
    provider: 'mock',
    complete: async () => {
      throw err;
    },
  };
}

describe('deterministicNarrative', () => {
  it('writes 2-4 factual sentences from counts, the claim and the first failure', () => {
    const text = deterministicNarrative({
      kind: 'alpha_semantic',
      steps,
      claim,
      checkpoints,
      perceives,
    });
    expect(text).toContain('Agent Alpha took 3 steps');
    expect(text).toContain('1 action did not execute (1 error)');
    expect(text).toContain('#1 select combobox:Size = M -> error');
    expect(text).toContain('It stopped with done: Reached the checkout review page.');
    expect(text).toContain(
      'passed 6 of 8 checkpoints; the first failure was Correct size identified',
    );
    expect(text).toContain('accessibility tree (roles + accessible names) and page text excerpt');
    expect(sentenceCount(text)).toBeGreaterThanOrEqual(2);
    expect(sentenceCount(text)).toBeLessThanOrEqual(4);
    expect(text).not.toContain(hoodieMission.rawPrompt);
  });

  it('handles a run with no steps, no claim and no checkpoints', () => {
    const text = deterministicNarrative({
      kind: 'gamma_structured',
      steps: [],
      checkpoints: [],
      perceives: AGENT_PROFILES.gamma_structured.perceivesLabels,
    });
    expect(text).toBe(
      'Agent Gamma recorded no browser steps; it perceived catalog feed (JSON) and cart API (JSON). No checkpoints were evaluated.',
    );
  });

  it('says so when every action executed and nothing failed', () => {
    const okSteps = steps.map((s) => ({ ...s, outcome: 'ok' as const, outcomeDetail: undefined }));
    const passed = checkpoints.map((c) => ({ ...c, status: 'passed' as const }));
    const text = deterministicNarrative({
      kind: 'beta_vision',
      steps: okSteps,
      checkpoints: passed,
      perceives: ['viewport screenshot'],
    });
    expect(text).toBe(
      'Agent Beta took 3 steps perceiving viewport screenshot; every action executed. The verifier passed 8 of 8 checkpoints; none failed.',
    );
  });
});

describe('generateNarrative', () => {
  const base = { mission: hoodieMission, steps, claim, checkpoints, perceives };

  it('is deterministic with zero usage for Gamma and never calls the model', async () => {
    const llm = createMockLlm([{ text: 'should not be used' }]);
    const out = await generateNarrative({
      ...base,
      kind: 'gamma_structured',
      perceives: AGENT_PROFILES.gamma_structured.perceivesLabels,
      llm,
    });
    expect(out.narrative).toContain('Agent Gamma');
    expect(out.narrative).not.toContain('should not be used');
    expect(out.usage).toEqual(EMPTY_USAGE);
    expect(llm.requests).toHaveLength(0);
  });

  it('returns the model text, trimmed, with the usage of the call', async () => {
    const usage = {
      ...EMPTY_USAGE,
      calls: 1,
      inputTokens: 900,
      outputTokens: 150,
      llmLatencyMs: 320,
    };
    const llm = createMockLlm([
      { text: '  At step #1 I looked for a size control and found none.\n', usage },
    ]);
    const out = await generateNarrative({ ...base, kind: 'alpha_semantic', llm });
    expect(out.narrative).toBe('At step #1 I looked for a size control and found none.');
    expect(out.usage).toEqual(usage);

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.model).toBe(resolveModel('narrator', 'mock'));
    expect(req.maxTokens).toBe(NARRATIVE_MAX_TOKENS);
    expect(req.timeoutMs).toBe(NARRATIVE_TIMEOUT_MS);
    expect(req.jsonSchema).toBeUndefined();
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
    const userText = req.messages[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join(
      '',
    );
    // Page content and the step log travel in the user turn; the system prompt stays fixed.
    expect(userText).toContain('#1 select combobox:Size = M -> error');
    expect(userText).toContain('correct_size_identified: failed');
    expect(req.system).not.toContain('combobox:Size');
    expect(req.system).not.toContain(hoodieMission.rawPrompt);
    expect(userText).not.toContain(hoodieMission.rawPrompt);
  });

  it('honours an explicit model override', async () => {
    const llm = createMockLlm([{ text: 'ok' }]);
    await generateNarrative({ ...base, kind: 'sigma_hybrid', llm, model: 'narrator-test-model' });
    expect(llm.requests[0]!.model).toBe('narrator-test-model');
  });

  it('falls back to the deterministic summary with a note when the model call throws', async () => {
    const llm = failingLlm(
      new LlmError('rate limited', { provider: 'mock', status: 429, retryable: true }),
    );
    const out = await generateNarrative({ ...base, kind: 'alpha_semantic', llm });
    expect(
      out.narrative.startsWith(
        `${NARRATIVE_UNAVAILABLE_PREFIX} (mock HTTP 429); deterministic summary follows.`,
      ),
    ).toBe(true);
    expect(out.narrative).toContain('Agent Alpha took 3 steps');
    expect(out.narrative).toContain('the first failure was Correct size identified');
    expect(out.usage).toEqual(EMPTY_USAGE);
  });

  it('never throws, whatever the failure', async () => {
    const plain = await generateNarrative({
      ...base,
      kind: 'beta_vision',
      llm: failingLlm(new Error('socket hang up')),
    });
    expect(plain.narrative.startsWith('Narrative unavailable (error);')).toBe(true);
    const weird = await generateNarrative({
      ...base,
      kind: 'beta_vision',
      llm: failingLlm('string thrown'),
    });
    expect(weird.narrative.startsWith('Narrative unavailable (error);')).toBe(true);
    const noProvider = await generateNarrative({
      ...base,
      kind: 'beta_vision',
      llm: failingLlm(new LlmError('No LLM provider configured.', { provider: 'none' })),
    });
    expect(
      noProvider.narrative.startsWith('Narrative unavailable (no LLM provider configured);'),
    ).toBe(true);
  });

  it('treats an empty model reply as unavailable but keeps the billed usage', async () => {
    const usage = { ...EMPTY_USAGE, calls: 1, inputTokens: 500, outputTokens: 0 };
    const llm = createMockLlm([{ text: '   \n', usage }]);
    const out = await generateNarrative({ ...base, kind: 'alpha_semantic', llm });
    expect(out.narrative.startsWith('Narrative unavailable (empty response);')).toBe(true);
    expect(out.usage).toEqual(usage);
  });
});

describe('narrativeFailureReason', () => {
  it('classifies errors without leaking provider detail', () => {
    expect(narrativeFailureReason(new LlmError('x', { provider: 'xai', status: 500 }))).toBe(
      'xai HTTP 500',
    );
    expect(narrativeFailureReason(new LlmError('x', { provider: 'xai', retryable: true }))).toBe(
      'xai unreachable or timed out',
    );
    expect(narrativeFailureReason(new LlmError('x', { provider: 'anthropic' }))).toBe(
      'anthropic error',
    );
    const timeout = new Error('t');
    timeout.name = 'TimeoutError';
    expect(narrativeFailureReason(timeout)).toBe('timed out');
    expect(narrativeFailureReason(new TypeError('fetch failed'))).toBe('TypeError');
    expect(narrativeFailureReason(42)).toBe('error');
  });
});
