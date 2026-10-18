import { MissionDraft, type Mission, newId, nowIso } from '@agentproof/shared';
import { LlmError, fromStrictJson, getLlm, toStrictJsonSchema } from './llm';
import { resolveModel } from './profiles';

const SYSTEM = `You convert a shopper's natural-language request into a structured shopping mission for an automated test.
Rules:
- Extract only what the request states. Do not invent attributes, budgets, or shipping constraints.
- Normalize attribute keys to lowercase ("size", "color"). Normalize sizes to S/M/L/XL style when the request uses words.
- attributes is a list of {key, value} pairs, e.g. [{"key":"size","value":"M"},{"key":"color","value":"black"}]. Leave it empty when the request names none.
- successMilestone: "checkout_review" if the request mentions checkout; "added_to_cart" if it mentions cart only; otherwise "product_found".
- paymentAuthorized is always false. Tests never place orders.
- Return null for allowedActions and maxSteps; the harness applies its defaults.
- Return null for any optional field the request does not state.`;

/** Feature 1: Shopping Mission Generator. One structured-output call through getLlm(). */
export async function generateMission(storeUrl: string, prompt: string): Promise<Mission> {
  const client = getLlm();
  const model = resolveModel('mission', client.provider);
  const response = await client.complete({
    model,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    jsonSchema: toStrictJsonSchema(MissionDraft, 'mission_draft'),
    maxTokens: 4096,
  });

  if (response.json === undefined) {
    throw new LlmError(
      `Mission generation returned no JSON (finishReason=${response.finishReason ?? 'unknown'})`,
      { provider: client.provider, bodyExcerpt: response.text.slice(0, 300) },
    );
  }

  const parsed = MissionDraft.safeParse(fromStrictJson(MissionDraft, response.json));
  if (!parsed.success) {
    throw new LlmError(`Mission generation returned JSON that does not match MissionDraft`, {
      provider: client.provider,
      bodyExcerpt: parsed.error.message.slice(0, 300),
    });
  }

  return {
    ...parsed.data,
    id: newId('mis'),
    createdAt: nowIso(),
    storeUrl,
    rawPrompt: prompt,
  };
}
