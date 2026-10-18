import {
  CodeFixProposal,
  CodeFixReviewDraft,
  EMPTY_USAGE,
  type LlmUsage,
} from '@agentproof/shared';
import {
  LlmError,
  estimateCostUsd,
  fromStrictJson,
  getLlm,
  resolveModel,
  toStrictJsonSchema,
  type LlmClient,
} from '@agentproof/agent';
import { createHash } from 'node:crypto';
import {
  PROPOSE_SYSTEM,
  REVIEW_SYSTEM,
  buildProposeUserTurn,
  buildReviewUserTurn,
  type ProposeUserTurnArgs,
  type ReviewUserTurnArgs,
} from './prompts';

/**
 * The two model calls of the code-fix agent, both through getLlm() with strict JSON schemas and
 * Zod validation afterwards. The proposer (role `codefix`) returns a diagnosis and edits; the
 * reviewer (role `review`) returns an advisory verdict. Neither decides anything: code validates
 * the edits and writes every status.
 */

export const PROPOSE_MAX_TOKENS = 8192;
export const REVIEW_MAX_TOKENS = 4096;
export const MODEL_TIMEOUT_MS = 120_000;

export interface ModelCallResult<T> {
  value: T;
  model: string;
  usage: LlmUsage;
  /** SHA-256 over the exact system and user text sent, for the record */
  promptSha256: string;
  promptChars: number;
}

function promptDigest(system: string, user: string): { promptSha256: string; promptChars: number } {
  const text = `${system}\n${user}`;
  return {
    promptSha256: createHash('sha256').update(text).digest('hex'),
    promptChars: text.length,
  };
}

function withCost(model: string, usage: LlmUsage): LlmUsage {
  const estimatedCostUsd = estimateCostUsd(model, usage);
  return estimatedCostUsd === undefined ? usage : { ...usage, estimatedCostUsd };
}

export async function proposeFix(
  args: ProposeUserTurnArgs,
  client: LlmClient = getLlm(),
): Promise<ModelCallResult<CodeFixProposal>> {
  const model = resolveModel('codefix', client.provider);
  const user = buildProposeUserTurn(args);
  const response = await client.complete({
    model,
    system: PROPOSE_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    jsonSchema: toStrictJsonSchema(CodeFixProposal, 'codefix_proposal'),
    effort: 'medium',
    maxTokens: PROPOSE_MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  const usage = withCost(model, response.usage ?? EMPTY_USAGE);
  if (response.json === undefined) {
    throw new LlmError(
      `Fix proposal returned no JSON (finishReason=${response.finishReason ?? 'unknown'})`,
      { provider: client.provider, bodyExcerpt: response.text.slice(0, 300) },
    );
  }
  const parsed = CodeFixProposal.safeParse(fromStrictJson(CodeFixProposal, response.json));
  if (!parsed.success) {
    throw new LlmError('Fix proposal returned JSON that does not match CodeFixProposal', {
      provider: client.provider,
      bodyExcerpt: parsed.error.message.slice(0, 300),
    });
  }
  return { value: parsed.data, model, usage, ...promptDigest(PROPOSE_SYSTEM, user) };
}

export async function reviewFix(
  args: ReviewUserTurnArgs,
  client: LlmClient = getLlm(),
): Promise<ModelCallResult<CodeFixReviewDraft>> {
  const model = resolveModel('review', client.provider);
  const user = buildReviewUserTurn(args);
  const response = await client.complete({
    model,
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    jsonSchema: toStrictJsonSchema(CodeFixReviewDraft, 'codefix_review'),
    effort: 'medium',
    maxTokens: REVIEW_MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  const usage = withCost(model, response.usage ?? EMPTY_USAGE);
  if (response.json === undefined) {
    throw new LlmError(
      `Fix review returned no JSON (finishReason=${response.finishReason ?? 'unknown'})`,
      { provider: client.provider, bodyExcerpt: response.text.slice(0, 300) },
    );
  }
  const parsed = CodeFixReviewDraft.safeParse(fromStrictJson(CodeFixReviewDraft, response.json));
  if (!parsed.success) {
    throw new LlmError('Fix review returned JSON that does not match CodeFixReviewDraft', {
      provider: client.provider,
      bodyExcerpt: parsed.error.message.slice(0, 300),
    });
  }
  return { value: parsed.data, model, usage, ...promptDigest(REVIEW_SYSTEM, user) };
}
