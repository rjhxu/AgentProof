import Anthropic from '@anthropic-ai/sdk';

/**
 * Single shared Claude client. Resolves credentials from ANTHROPIC_API_KEY.
 * Model is configurable via AGENTPROOF_MODEL so the whole team can switch at once.
 */
export const MODEL = process.env.AGENTPROOF_MODEL ?? 'claude-opus-5-5';

let client: Anthropic | undefined;
export function getClaude(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.');
    }
    client = new Anthropic();
  }
  return client;
}

/**
 * Server-side refusal fallback. If a safety classifier declines a request on claude-opus-5-5,
 * the API retries on a fallback model instead of returning stop_reason "refusal".
 * Spread this into every messages.create / messages.parse call.
 */
export const FALLBACKS = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
} as const;
