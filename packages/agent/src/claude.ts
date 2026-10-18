import Anthropic from '@anthropic-ai/sdk';
import { resolveModel } from './profiles';

/**
 * @deprecated Use getLlm() from ./llm (provider-neutral; xAI Grok by default, Anthropic as the
 * fallback). This file stays only until packages/diagnostics moves off getClaude()/MODEL; new
 * code must not import it. FALLBACKS is still read by the Anthropic adapter in ./llm.
 *
 * Single shared Claude client. Resolves credentials from ANTHROPIC_API_KEY.
 * MODEL comes from the `diagnosis` role in profiles.ts (Haiku by default on Anthropic, never
 * Opus). Override with AGENTPROOF_MODEL_DIAGNOSIS, or AGENTPROOF_MODEL for every role.
 */
export const MODEL = resolveModel('diagnosis', 'anthropic');

let client: Anthropic | undefined;
/** @deprecated See the file header: use getLlm() from ./llm. */
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
