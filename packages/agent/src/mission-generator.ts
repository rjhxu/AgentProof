import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MissionDraft, type Mission, newId, nowIso } from '@agentproof/shared';
import { FALLBACKS, MODEL, getClaude } from './claude';

const SYSTEM = `You convert a shopper's natural-language request into a structured shopping mission for an automated test.
Rules:
- Extract only what the request states. Do not invent attributes, budgets, or shipping constraints.
- Normalize attribute keys to lowercase ("size", "color"). Normalize sizes to S/M/L/XL style when the request uses words.
- successMilestone: "checkout_review" if the request mentions checkout; "added_to_cart" if it mentions cart only; otherwise "product_found".
- paymentAuthorized is always false. Tests never place orders.`;

/** Feature 1: Shopping Mission Generator. */
export async function generateMission(storeUrl: string, prompt: string): Promise<Mission> {
  const client = getClaude();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: zodOutputFormat(MissionDraft) },
    ...FALLBACKS,
  });

  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new Error(`Mission generation failed (stop_reason=${response.stop_reason})`);
  }

  return {
    ...response.parsed_output,
    id: newId('mis'),
    createdAt: nowIso(),
    storeUrl,
    rawPrompt: prompt,
  };
}
