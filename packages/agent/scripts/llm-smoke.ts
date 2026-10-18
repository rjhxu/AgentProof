/**
 * Live check of the configured LLM provider and key, in two cheap calls:
 *   1. a tiny strict-JSON request (proves auth, endpoint mode, schema acceptance, usage/cost parsing)
 *   2. generateMission() on the flagship prompt (proves the mission schema round-trip)
 *
 *   pnpm --filter @agentproof/agent exec tsx --env-file=../../.env scripts/llm-smoke.ts
 */
import { getLlm } from '../src/llm';
import { resolveModel } from '../src/profiles';
import { generateMission } from '../src/mission-generator';

const llm = getLlm();
const model = resolveModel('mission', llm.provider);
console.log(`provider=${llm.provider} model=${model}`);

const ping = await llm.complete({
  model,
  system: 'Answer with JSON only.',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is 2 + 2? Reply as {"answer": <integer>, "note": <string or null>}',
        },
      ],
    },
  ],
  jsonSchema: {
    name: 'ping',
    schema: {
      type: 'object',
      properties: { answer: { type: 'integer' }, note: { type: ['string', 'null'] } },
      required: ['answer', 'note'],
      additionalProperties: false,
    },
  },
  effort: 'low',
  maxTokens: 512,
});
console.log('ping json:', JSON.stringify(ping.json), 'finish:', ping.finishReason);
console.log('ping usage:', JSON.stringify(ping.usage), `latency=${ping.latencyMs}ms`);

const mission = await generateMission(
  process.env.STOREFRONT_URL ?? 'http://localhost:5000',
  'Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout. Do not place the order.',
);
console.log(
  'mission requirements:',
  JSON.stringify(mission.requirements),
  'milestone:',
  mission.successMilestone,
);
