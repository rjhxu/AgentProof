import type { LlmUsage } from '@agentproof/shared';

/**
 * Provider-neutral LLM contract. Prompts are built against these types; adapters in llm.ts
 * translate to the provider's wire format (xAI Grok via the OpenAI-compatible API, or Anthropic).
 * Nothing outside llm.ts may import a provider SDK.
 */

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContentBlock[];
}

export type LlmEffort = 'low' | 'medium' | 'high';

export interface LlmJsonSchema {
  /** Short identifier, e.g. "agent_action" */
  name: string;
  /** JSON Schema (draft 2020-12 subset): object root, all properties required, additionalProperties false */
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  /** When set, the provider is asked for schema-constrained JSON and `json` is populated. */
  jsonSchema?: LlmJsonSchema;
  maxTokens?: number;
  effort?: LlmEffort;
  temperature?: number;
  /** Abort after this many ms (adapter default: 90s) */
  timeoutMs?: number;
}

export interface LlmResponse {
  /** Raw text of the first choice (for JSON requests, the JSON string) */
  text: string;
  /** Parsed JSON when `jsonSchema` was requested and the output parsed; otherwise undefined */
  json?: unknown;
  usage: LlmUsage;
  model: string;
  provider: 'xai' | 'anthropic' | 'mock';
  latencyMs: number;
  finishReason?: string;
}

export interface LlmClient {
  provider: LlmResponse['provider'];
  complete(request: LlmRequest): Promise<LlmResponse>;
}
