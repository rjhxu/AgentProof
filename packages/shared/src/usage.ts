import { z } from 'zod';

/**
 * LLM usage accounting. Every model call records one of these; runs and reports sum them.
 * Cost is an estimate from a static price table (see @agentproof/agent profiles) and is
 * labelled as such wherever it is shown.
 */
export const LlmUsage = z.object({
  calls: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  /** Number of images sent as input across all calls (vision cost driver). */
  imageInputs: z.number().int().nonnegative().default(0),
  /** USD, estimated from the price table; absent when the model's price is unknown. */
  estimatedCostUsd: z.number().nonnegative().optional(),
  /** Wall-clock spent waiting on the model, summed across calls. */
  llmLatencyMs: z.number().int().nonnegative().default(0),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

export const EMPTY_USAGE: LlmUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  imageInputs: 0,
  llmLatencyMs: 0,
};

export function addUsage(a: LlmUsage, b: Partial<LlmUsage>): LlmUsage {
  const cost =
    a.estimatedCostUsd === undefined && b.estimatedCostUsd === undefined
      ? undefined
      : (a.estimatedCostUsd ?? 0) + (b.estimatedCostUsd ?? 0);
  return {
    calls: a.calls + (b.calls ?? 0),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    reasoningTokens: a.reasoningTokens + (b.reasoningTokens ?? 0),
    cachedInputTokens: a.cachedInputTokens + (b.cachedInputTokens ?? 0),
    imageInputs: a.imageInputs + (b.imageInputs ?? 0),
    llmLatencyMs: a.llmLatencyMs + (b.llmLatencyMs ?? 0),
    ...(cost === undefined ? {} : { estimatedCostUsd: Math.round(cost * 1e6) / 1e6 }),
  };
}
