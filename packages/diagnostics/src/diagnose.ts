import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { FALLBACKS, MODEL, getClaude } from '@agentproof/agent';
import {
  DiagnosisDraft,
  type Checkpoint,
  type Evidence,
  type Issue,
  type Mission,
  type Run,
  newId,
} from '@agentproof/shared';

/**
 * Feature 4: AI Root Cause Analysis.
 * Input is ONLY evidence the runner captured. Claude returns a hypothesis + category.
 * The `observed` field of the Issue is written by code from the checkpoint, never by Claude.
 *
 * OWNER: Developer 4.
 */

const SYSTEM = `You are diagnosing why an automated shopping-agent test failed against an online store.
You will receive the structured mission, the failed checkpoint, the agent's step log, and evidence excerpts.
Rules:
- Base every claim on the evidence provided. If the evidence is insufficient, set category to "insufficient_evidence" and confidence "low".
- Distinguish a store defect from an agent decision error. Not every failure is the merchant's fault.
- suggestedRepair must be a concrete, minimal change. Prefer semantic HTML and data-mapping fixes.
- suspectedFiles: only list paths that appear in the provided repository file list.`;

export interface DiagnoseInput {
  mission: Mission;
  run: Run;
  checkpoint: Checkpoint;
  evidence: Evidence[];
  /** Relative paths of storefront source files, when a repo is connected */
  repoFiles?: string[];
  /** Optional source excerpts keyed by path */
  sourceExcerpts?: Record<string, string>;
}

export async function diagnose(input: DiagnoseInput): Promise<Issue> {
  const client = getClaude();
  const { mission, run, checkpoint, evidence } = input;

  const observed = checkpoint.detail ?? `Checkpoint ${checkpoint.id} failed`;
  const evidenceText = evidence
    .map(
      (e) =>
        `[${e.id}] ${e.kind}${e.label ? ` - ${e.label}` : ''}\n${e.data ? JSON.stringify(e.data, null, 2) : (e.path ?? '')}`,
    )
    .join('\n\n');
  const stepsText = run.steps
    .map(
      (s) =>
        `${s.index}. ${s.url ?? ''} ${s.action ? JSON.stringify(s.action) : ''} -> ${s.outcome}${s.outcomeDetail ? `: ${s.outcomeDetail}` : ''}`,
    )
    .join('\n');

  const user = [
    `## Mission\n${JSON.stringify(mission.requirements, null, 2)}\nSuccess milestone: ${mission.successMilestone}`,
    `## Failed checkpoint\n${checkpoint.id}: ${observed}`,
    `## Agent (${run.agent.kind}) steps\n${stepsText || '(none)'}`,
    `## Evidence\n${evidenceText || '(none)'}`,
    input.repoFiles ? `## Repository files\n${input.repoFiles.join('\n')}` : '',
    input.sourceExcerpts
      ? `## Source excerpts\n${Object.entries(input.sourceExcerpts)
          .map(([p, s]) => `### ${p}\n\`\`\`\n${s}\n\`\`\``)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
    output_config: { format: zodOutputFormat(DiagnosisDraft) },
    ...FALLBACKS,
  });

  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new Error(`Diagnosis failed (stop_reason=${response.stop_reason})`);
  }

  return {
    id: newId('iss'),
    runId: run.id,
    checkpointId: checkpoint.id,
    observed,
    evidenceIds: checkpoint.evidenceIds,
    ...response.parsed_output,
  };
}
