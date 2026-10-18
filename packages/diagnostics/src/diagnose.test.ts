import { afterEach, describe, expect, it } from 'vitest';
import { createMockLlm, setLlmForTests } from '@agentproof/agent';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';

import { diagnose, renderDiagnosisPrompt } from './diagnose';

/*
 * The diagnosis goes through getLlm() like every other model call: a scripted client stands in,
 * so the test proves the request shape, the parsing and the code-written fields without a key.
 */

const checkpoint = alphaFailedRun.verification!.firstFailure!;

afterEach(() => setLlmForTests(undefined));

describe('diagnose', () => {
  it('asks for a strict DiagnosisDraft and keeps observed and evidence code-written', async () => {
    const draft = {
      category: 'semantic_interface_problem',
      title: 'Size chips are not form controls',
      inferredCause: 'The size options are plain text, so a screen-reader agent cannot select M.',
      confidence: 'high',
      suggestedRepair: 'Render the size chips as a radio group with labels.',
      suspectedFiles: [],
    };
    const llm = createMockLlm([{ text: JSON.stringify(draft), json: draft }]);
    setLlmForTests(llm);

    const issue = await diagnose({
      mission: hoodieMission,
      run: alphaFailedRun,
      checkpoint,
      evidence: alphaFailedRun.evidence,
    });

    expect(issue.runId).toBe(alphaFailedRun.id);
    expect(issue.checkpointId).toBe(checkpoint.id);
    expect(issue.observed).toBe(checkpoint.detail);
    expect(issue.evidenceIds).toEqual(checkpoint.evidenceIds);
    expect(issue.title).toBe(draft.title);
    expect(issue.category).toBe('semantic_interface_problem');
    expect(issue.id).toMatch(/^iss_[a-f0-9]{12}$/);

    const request = llm.requests[0]!;
    expect(request.jsonSchema?.name).toBe('diagnosis_draft');
    expect(request.model).toBeTruthy();
    // Page content is data in the user turn, never in the system prompt.
    expect(request.system).not.toContain(checkpoint.detail ?? '');
  });

  it('puts the mission, the checkpoint, the steps and the evidence in the user turn', () => {
    const text = renderDiagnosisPrompt({
      mission: hoodieMission,
      run: alphaFailedRun,
      checkpoint,
      evidence: alphaFailedRun.evidence,
      repoFiles: ['src/views.ts'],
    });
    expect(text).toContain('## Failed checkpoint');
    expect(text).toContain(checkpoint.id);
    expect(text).toContain('## Repository files\nsrc/views.ts');
  });

  it('fails loudly when the model returns no JSON', async () => {
    setLlmForTests(createMockLlm([{ text: 'not json' }]));
    await expect(
      diagnose({ mission: hoodieMission, run: alphaFailedRun, checkpoint, evidence: [] }),
    ).rejects.toThrow(/no JSON/);
  });
});
