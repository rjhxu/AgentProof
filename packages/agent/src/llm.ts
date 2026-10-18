import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LlmUsage } from '@agentproof/shared';
import { FALLBACKS } from './claude';
import type {
  LlmClient,
  LlmContentBlock,
  LlmEffort,
  LlmJsonSchema,
  LlmMessage,
  LlmRequest,
  LlmResponse,
} from './llm-types';
import { estimateCostUsd } from './profiles';

/**
 * The only file that talks to a model provider. Everything else calls getLlm().complete() with
 * the provider-neutral types in llm-types.ts.
 *
 *   xAI (Grok)   createXaiClient: REST via global fetch. "responses" mode posts to /responses
 *                (xAI's recommended API); "chat" mode posts to the legacy /chat/completions.
 *   Anthropic    createAnthropicClient: the fallback provider, via @anthropic-ai/sdk.
 *   mock         createMockLlm: scripted responses for tests.
 *
 * Rules: never log or embed API keys or base64 image data; page content only ever travels in
 * user turns; every call returns an LlmUsage so reports can sum cost.
 */

/**
 * Default output cap. In xAI Responses mode `max_output_tokens` bounds reasoning tokens as well
 * as the visible reply, so a medium/high-effort step whose thinking alone exceeds the cap comes
 * back incomplete with a truncated (unparseable) JSON body. Callers running those efforts should
 * pass a higher `maxTokens` (8192+); the mission generator does.
 */
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 3;
const BODY_EXCERPT_CHARS = 300;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1';

export class LlmError extends Error {
  readonly provider: string;
  readonly status?: number;
  /** First <=300 chars of the provider's error body. Never contains credentials. */
  readonly bodyExcerpt?: string;
  /** True for 429, 5xx, network and timeout failures (the adapter already retried them). */
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      provider: string;
      status?: number;
      bodyExcerpt?: string;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'LlmError';
    this.provider = opts.provider;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.bodyExcerpt !== undefined) this.bodyExcerpt = opts.bodyExcerpt;
    this.retryable = opts.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers shared by the adapters
// ---------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/**
 * Text blocks across every turn; images only from user turns. Assistant turns are replayed as
 * plain text (see textOf), so an image block there is never sent and must not count as input.
 */
function countBlocks(messages: LlmMessage[]): { text: number; images: number } {
  let text = 0;
  let images = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') text += 1;
      else if (message.role === 'user') images += 1;
    }
  }
  return { text, images };
}

/** Assistant turns are replayed as plain text; images never belong in them. */
function textOf(content: LlmContentBlock[]): string {
  return content
    .filter((block): block is Extract<LlmContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function dataUrl(block: Extract<LlmContentBlock, { type: 'image' }>): string {
  return `data:${block.mediaType};base64,${block.base64}`;
}

/** Non-reasoning Grok models reject a reasoning effort, so the hint is dropped for them. */
function effortFor(req: LlmRequest): LlmEffort | undefined {
  if (!req.effort) return undefined;
  return req.model.includes('non-reasoning') ? undefined : req.effort;
}

/** The parsed JSON of a structured-output reply, or undefined when it is not a JSON object/array. */
function parseJsonText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildUsage(
  raw: RawUsage,
  imageInputs: number,
  latencyMs: number,
  models: string[],
): LlmUsage {
  const tokens = {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cachedInputTokens: raw.cachedInputTokens,
  };
  let cost: number | undefined;
  if (raw.costTicks !== undefined) {
    cost = raw.costTicks / 1e10;
  } else {
    for (const model of models) {
      cost = estimateCostUsd(model, tokens);
      if (cost !== undefined) break;
    }
  }
  return {
    calls: 1,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    reasoningTokens: raw.reasoningTokens,
    cachedInputTokens: raw.cachedInputTokens,
    imageInputs,
    llmLatencyMs: Math.max(0, Math.round(latencyMs)),
    ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
  };
}

function debugLog(
  label: string,
  model: string,
  blocks: { text: number; images: number },
  usage: LlmUsage,
): void {
  if (process.env.AGENTPROOF_LLM_DEBUG !== '1') return;
  const cost =
    usage.estimatedCostUsd === undefined ? 'n/a' : `$${usage.estimatedCostUsd.toFixed(5)}`;
  console.error(
    `[llm] ${label} model=${model} blocks=text:${blocks.text},image:${blocks.images} ` +
      `tokens=in:${usage.inputTokens}(cached:${usage.cachedInputTokens}),out:${usage.outputTokens}` +
      `(reasoning:${usage.reasoningTokens}) latency=${usage.llmLatencyMs}ms cost=${cost}`,
  );
}

/** Finish reasons that mean the output cap cut the reply (Responses, chat and Anthropic). */
const TRUNCATED_FINISH_REASONS = new Set(['max_output_tokens', 'length', 'max_tokens']);

/**
 * AGENTPROOF_LLM_DEBUG=1 only. A structured reply cut off at the output cap is the usual cause
 * of "json undefined" on a high-effort step, and in Responses mode the cap includes reasoning.
 */
function debugTruncated(
  label: string,
  req: LlmRequest,
  finishReason: string | undefined,
  json: unknown,
): void {
  if (process.env.AGENTPROOF_LLM_DEBUG !== '1') return;
  if (!req.jsonSchema || json !== undefined) return;
  if (finishReason === undefined || !TRUNCATED_FINISH_REASONS.has(finishReason)) return;
  console.error(
    `[llm] ${label} model=${req.model} structured reply truncated at ` +
      `maxTokens=${req.maxTokens ?? DEFAULT_MAX_TOKENS} (finishReason=${finishReason}); ` +
      'the cap includes reasoning tokens, raise maxTokens for medium/high effort',
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 250);
}

/** Retry-After as seconds (the common form) or an HTTP date; capped so a bad header cannot stall a run. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Inline image payloads a provider may echo back in an error body. */
const DATA_URL_RE = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi;
/** Any long base64 run, so a payload echoed without its data: prefix still never reaches a log. */
const LONG_BASE64_RE = /[A-Za-z0-9+/]{100,}={0,2}/g;

/** Error-body excerpt safe for logs: key redacted, image data and long base64 runs replaced. */
function excerpt(body: string, secret: string): string {
  const redacted = (secret ? body.split(secret).join('[redacted]') : body)
    .replace(DATA_URL_RE, '[image]')
    .replace(LONG_BASE64_RE, '[base64]');
  return redacted.replace(/\s+/g, ' ').trim().slice(0, BODY_EXCERPT_CHARS);
}

// ---------------------------------------------------------------------------------------------
// xAI (Grok)
// ---------------------------------------------------------------------------------------------

export type XaiApiMode = 'responses' | 'chat';

export interface XaiClientOptions {
  apiKey: string;
  /** Default https://api.x.ai/v1 */
  baseUrl?: string;
  /** "responses" (default, xAI's recommended API) or "chat" (legacy OpenAI-compatible) */
  mode?: XaiApiMode;
  fetchImpl?: typeof fetch;
  /** Retries on 429 / 5xx / network / timeout. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Detail hint sent with every image. Default "high". */
  imageDetail?: 'low' | 'high';
}

interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  /** xAI: 1e10 ticks = 1 USD */
  costTicks?: number;
}

interface ParsedReply {
  text: string;
  model?: string;
  finishReason?: string;
  usage: RawUsage;
}

function buildResponsesBody(req: LlmRequest, detail: 'low' | 'high'): JsonObject {
  const input: unknown[] = [{ role: 'system', content: req.system }];
  for (const message of req.messages) {
    if (message.role === 'assistant') {
      input.push({ role: 'assistant', content: textOf(message.content) });
      continue;
    }
    input.push({
      role: 'user',
      content: message.content.map((block) =>
        block.type === 'text'
          ? { type: 'input_text', text: block.text }
          : { type: 'input_image', image_url: dataUrl(block), detail },
      ),
    });
  }
  const effort = effortFor(req);
  return {
    model: req.model,
    store: false,
    input,
    max_output_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.jsonSchema === undefined
      ? {}
      : {
          text: {
            format: {
              type: 'json_schema',
              name: req.jsonSchema.name,
              schema: req.jsonSchema.schema,
              strict: true,
            },
          },
        }),
  };
}

function buildChatBody(req: LlmRequest, detail: 'low' | 'high'): JsonObject {
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  for (const message of req.messages) {
    if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: textOf(message.content) });
      continue;
    }
    messages.push({
      role: 'user',
      content: message.content.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'image_url', image_url: { url: dataUrl(block), detail } },
      ),
    });
  }
  const effort = effortFor(req);
  return {
    model: req.model,
    messages,
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.jsonSchema === undefined
      ? {}
      : {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: req.jsonSchema.name,
              schema: req.jsonSchema.schema,
              strict: true,
            },
          },
        }),
  };
}

function parseResponsesReply(body: JsonObject, status: number): ParsedReply {
  if (isRecord(body.error)) {
    throw new LlmError(
      `xAI responses API error: ${asString(body.error.message) ?? 'unknown error'}`,
      { provider: 'xai', status, bodyExcerpt: excerpt(JSON.stringify(body.error), '') },
    );
  }
  const responseStatus = asString(body.status);
  const output = Array.isArray(body.output) ? body.output : [];
  let text = '';
  let refusal: string | undefined;
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (part.type === 'output_text') text += asString(part.text) ?? '';
      else if (part.type === 'refusal') refusal = asString(part.refusal) ?? 'no reason given';
    }
    break; // the first message item is the reply; later ones are not expected
  }
  if (responseStatus === 'failed') {
    throw new LlmError('xAI responses API reported status "failed"', {
      provider: 'xai',
      status,
      bodyExcerpt: excerpt(JSON.stringify(body.incomplete_details ?? body.status ?? ''), ''),
    });
  }
  if (!text && refusal !== undefined) {
    throw new LlmError(`xAI model refused the request: ${refusal}`, { provider: 'xai', status });
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const incomplete = isRecord(body.incomplete_details) ? body.incomplete_details : {};
  const finishReason = asString(incomplete.reason) ?? responseStatus;
  const costTicks = asNumber(usage.cost_in_usd_ticks);
  return {
    text,
    ...(asString(body.model) === undefined ? {} : { model: asString(body.model) }),
    ...(finishReason === undefined ? {} : { finishReason }),
    usage: {
      inputTokens: asNumber(usage.input_tokens) ?? 0,
      outputTokens: asNumber(usage.output_tokens) ?? 0,
      reasoningTokens: asNumber(outputDetails.reasoning_tokens) ?? 0,
      cachedInputTokens: asNumber(inputDetails.cached_tokens) ?? 0,
      ...(costTicks === undefined ? {} : { costTicks }),
    },
  };
}

function parseChatReply(body: JsonObject, status: number): ParsedReply {
  if (isRecord(body.error)) {
    throw new LlmError(
      `xAI chat completions error: ${asString(body.error.message) ?? 'unknown error'}`,
      { provider: 'xai', status, bodyExcerpt: excerpt(JSON.stringify(body.error), '') },
    );
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  const choice = isRecord(first) ? first : {};
  const message = isRecord(choice.message) ? choice.message : {};
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (isRecord(part) && part.type === 'text') text += asString(part.text) ?? '';
    }
  }
  const refusal = asString(message.refusal);
  if (!text && refusal) {
    throw new LlmError(`xAI model refused the request: ${refusal}`, { provider: 'xai', status });
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const finishReason = asString(choice.finish_reason);
  const costTicks = asNumber(usage.cost_in_usd_ticks);
  return {
    text,
    ...(asString(body.model) === undefined ? {} : { model: asString(body.model) }),
    ...(finishReason === undefined ? {} : { finishReason }),
    usage: {
      inputTokens: asNumber(usage.prompt_tokens) ?? 0,
      outputTokens: asNumber(usage.completion_tokens) ?? 0,
      reasoningTokens: asNumber(completionDetails.reasoning_tokens) ?? 0,
      cachedInputTokens: asNumber(promptDetails.cached_tokens) ?? 0,
      ...(costTicks === undefined ? {} : { costTicks }),
    },
  };
}

export function createXaiClient(opts: XaiClientOptions): LlmClient {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new LlmError('xAI API key is empty', { provider: 'xai' });
  const baseUrl = (opts.baseUrl ?? XAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const mode: XaiApiMode = opts.mode ?? 'responses';
  const url = `${baseUrl}/${mode === 'responses' ? 'responses' : 'chat/completions'}`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
  const sleep = opts.sleep ?? defaultSleep;
  const detail = opts.imageDetail ?? 'high';
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    if (typeof fetchImpl !== 'function') {
      throw new LlmError('global fetch is not available; pass fetchImpl', { provider: 'xai' });
    }
    const blocks = countBlocks(req.messages);
    const body = JSON.stringify(
      mode === 'responses' ? buildResponsesBody(req, detail) : buildChatBody(req, detail),
    );
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let waitedMs = 0;

    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      let res: Response;
      let rawText = '';
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        // The timeout keeps running while the body downloads, so a slow or dropped body is a
        // timeout/network failure like the request itself and takes the same retry branch.
        if (res.ok) rawText = await res.text();
      } catch (err) {
        waitedMs += Date.now() - started;
        const timedOut = isAbortError(err);
        const error = new LlmError(
          `xAI ${mode} request ${timedOut ? `timed out after ${timeoutMs}ms` : 'failed'}: ${errorMessage(err)}`,
          { provider: 'xai', retryable: true, cause: err },
        );
        if (attempt >= maxRetries) throw error;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        waitedMs += Date.now() - started;
        const bodyExcerpt = excerpt(await safeText(res), apiKey);
        const retryable = res.status === 429 || res.status >= 500;
        const error = new LlmError(
          `xAI ${mode} request failed with HTTP ${res.status}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`,
          { provider: 'xai', status: res.status, bodyExcerpt, retryable },
        );
        if (!retryable || attempt >= maxRetries) throw error;
        await sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt));
        continue;
      }

      waitedMs += Date.now() - started;
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        throw new LlmError('xAI returned a non-JSON body', {
          provider: 'xai',
          status: res.status,
          bodyExcerpt: excerpt(rawText, apiKey),
        });
      }
      if (!isRecord(parsedBody)) {
        throw new LlmError('xAI returned an unexpected body shape', {
          provider: 'xai',
          status: res.status,
          bodyExcerpt: excerpt(rawText, apiKey),
        });
      }
      const reply =
        mode === 'responses'
          ? parseResponsesReply(parsedBody, res.status)
          : parseChatReply(parsedBody, res.status);
      const model = reply.model ?? req.model;
      const usage = buildUsage(reply.usage, blocks.images, waitedMs, [model, req.model]);
      const json = req.jsonSchema ? parseJsonText(reply.text) : undefined;
      debugLog(`xai/${mode}`, model, blocks, usage);
      debugTruncated(`xai/${mode}`, req, reply.finishReason, json);
      return {
        text: reply.text,
        ...(json === undefined ? {} : { json }),
        usage,
        model,
        provider: 'xai',
        latencyMs: usage.llmLatencyMs,
        ...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason }),
      };
    }
  }

  return { provider: 'xai', complete };
}

// ---------------------------------------------------------------------------------------------
// Anthropic (fallback provider)
// ---------------------------------------------------------------------------------------------

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  /** Injectable for tests; forwarded to the SDK's own `fetch` option. */
  fetchImpl?: typeof fetch;
}

function toAnthropicBlock(block: LlmContentBlock): Anthropic.Beta.Messages.BetaContentBlockParam {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.mediaType, data: block.base64 },
  };
}

function toAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    return new LlmError(
      `Anthropic request failed with HTTP ${status ?? 'unknown'}: ${excerpt(err.message, '')}`,
      {
        provider: 'anthropic',
        ...(status === undefined ? {} : { status }),
        bodyExcerpt: excerpt(err.message, ''),
        retryable: status === 429 || (status ?? 0) >= 500,
        cause: err,
      },
    );
  }
  return new LlmError(`Anthropic request failed: ${errorMessage(err)}`, {
    provider: 'anthropic',
    retryable: isAbortError(err),
    cause: err,
  });
}

export function createAnthropicClient(opts: AnthropicClientOptions): LlmClient {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new LlmError('Anthropic API key is empty', { provider: 'anthropic' });
  const client = new Anthropic({
    apiKey,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    const blocks = countBlocks(req.messages);
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = req.messages.map((message) =>
      message.role === 'assistant'
        ? { role: 'assistant', content: textOf(message.content) }
        : { role: 'user', content: message.content.map(toAnthropicBlock) },
    );
    const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
    if (req.effort) outputConfig.effort = req.effort;
    if (req.jsonSchema)
      outputConfig.format = { type: 'json_schema', schema: req.jsonSchema.schema };
    // The beta Messages resource is the one whose params declare `betas` and `fallbacks`: its
    // create() moves `betas` into the anthropic-beta header and posts `fallbacks` in the body
    // (the server-side refusal fallback, see ./claude). The non-beta resource would send both
    // as unknown body fields and the API would reject every request with a 400.
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: req.system,
      messages,
      betas: [...FALLBACKS.betas],
      fallbacks: FALLBACKS.fallbacks,
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    };

    const started = Date.now();
    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await client.beta.messages.create(params, {
        timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      throw toAnthropicError(err);
    }
    const latencyMs = Date.now() - started;

    if (message.stop_reason === 'refusal') {
      throw new LlmError('Anthropic model refused the request (stop_reason=refusal)', {
        provider: 'anthropic',
      });
    }
    const text = message.content
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const u = message.usage;
    const cached = u.cache_read_input_tokens ?? 0;
    // Anthropic reports cache reads/writes separately from input_tokens; LlmUsage.inputTokens is
    // the whole prompt, with cachedInputTokens as the subset billed at the cached rate.
    const raw: RawUsage = {
      inputTokens: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
      reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
      cachedInputTokens: cached,
    };
    const usage = buildUsage(raw, blocks.images, latencyMs, [message.model, req.model]);
    const json = req.jsonSchema ? parseJsonText(text) : undefined;
    debugLog('anthropic', message.model, blocks, usage);
    debugTruncated('anthropic', req, message.stop_reason ?? undefined, json);
    return {
      text,
      ...(json === undefined ? {} : { json }),
      usage,
      model: message.model,
      provider: 'anthropic',
      latencyMs: usage.llmLatencyMs,
      ...(message.stop_reason === null ? {} : { finishReason: message.stop_reason }),
    };
  }

  return { provider: 'anthropic', complete };
}

// ---------------------------------------------------------------------------------------------
// Mock (tests)
// ---------------------------------------------------------------------------------------------

/** A scripted reply: any subset of LlmResponse, with usage itself allowed to be partial. */
export type MockLlmPartialResponse = Omit<Partial<LlmResponse>, 'usage'> & {
  usage?: Partial<LlmUsage>;
};

export type MockLlmScriptEntry =
  | MockLlmPartialResponse
  | ((req: LlmRequest) => MockLlmPartialResponse);

export interface MockLlmClient extends LlmClient {
  provider: 'mock';
  /** Every request received, in order */
  requests: LlmRequest[];
}

/**
 * Returns the scripted responses in order and keeps replaying the last one. Each entry may be a
 * partial response (text and/or json) or a function of the request. Usage defaults to one call
 * with zero tokens, counting the images actually sent.
 */
export function createMockLlm(script: MockLlmScriptEntry[]): MockLlmClient {
  const requests: LlmRequest[] = [];
  let index = 0;

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    requests.push(req);
    const entry = script[Math.min(index, script.length - 1)];
    index += 1;
    const partial: MockLlmPartialResponse =
      entry === undefined ? {} : typeof entry === 'function' ? entry(req) : entry;
    const text = partial.text ?? (partial.json === undefined ? '' : JSON.stringify(partial.json));
    let json = partial.json;
    if (json === undefined && req.jsonSchema && text) json = parseJsonText(text);
    const blocks = countBlocks(req.messages);
    const usage: LlmUsage = {
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      imageInputs: blocks.images,
      llmLatencyMs: 0,
      ...partial.usage,
    };
    return {
      text,
      ...(json === undefined ? {} : { json }),
      usage,
      model: partial.model ?? req.model,
      provider: 'mock',
      latencyMs: partial.latencyMs ?? 0,
      finishReason: partial.finishReason ?? 'stop',
    };
  }

  return { provider: 'mock', requests, complete };
}

// ---------------------------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------------------------

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

const PROVIDER_HELP =
  'Set GROK_API_KEY (or XAI_API_KEY) for xAI Grok, or ANTHROPIC_API_KEY for Anthropic; ' +
  'AGENTPROOF_LLM_PROVIDER=xai|anthropic forces one. See .env.example.';

/**
 * xAI endpoint root: XAI_BASE_URL when set (a gateway or proxy in front of api.x.ai, e.g. a
 * hackathon relay), else https://api.x.ai/v1. The adapter appends /responses or
 * /chat/completions, so the value must end at the API version segment.
 */
export function resolveXaiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (envValue(env, 'XAI_BASE_URL') ?? XAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Test hooks for createLlmFromEnv(); production callers pass nothing. */
export interface LlmEnvOverrides {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Build a client from the environment (no singleton). getLlm() caches the result. */
export function createLlmFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: LlmEnvOverrides = {},
): LlmClient {
  const xaiKey = envValue(env, 'XAI_API_KEY') ?? envValue(env, 'GROK_API_KEY');
  const anthropicKey = envValue(env, 'ANTHROPIC_API_KEY');
  const forced = envValue(env, 'AGENTPROOF_LLM_PROVIDER')?.toLowerCase();
  const provider = forced ?? (xaiKey ? 'xai' : anthropicKey ? 'anthropic' : undefined);
  const hooks = {
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  };

  if (provider === 'xai') {
    if (!xaiKey) {
      throw new LlmError(`AGENTPROOF_LLM_PROVIDER=xai but no key is set. ${PROVIDER_HELP}`, {
        provider: 'xai',
      });
    }
    const modeRaw = envValue(env, 'XAI_API_MODE')?.toLowerCase() ?? 'responses';
    if (modeRaw !== 'responses' && modeRaw !== 'chat') {
      throw new LlmError(`XAI_API_MODE must be "responses" or "chat", got "${modeRaw}"`, {
        provider: 'xai',
      });
    }
    return createXaiClient({
      apiKey: xaiKey,
      mode: modeRaw,
      baseUrl: resolveXaiBaseUrl(env),
      ...hooks,
    });
  }
  if (provider === 'anthropic') {
    if (!anthropicKey) {
      throw new LlmError(
        `AGENTPROOF_LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. ${PROVIDER_HELP}`,
        { provider: 'anthropic' },
      );
    }
    return createAnthropicClient({
      apiKey: anthropicKey,
      ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
    });
  }
  if (provider !== undefined) {
    throw new LlmError(`Unknown AGENTPROOF_LLM_PROVIDER "${provider}". ${PROVIDER_HELP}`, {
      provider,
    });
  }
  throw new LlmError(`No LLM provider configured. ${PROVIDER_HELP}`, { provider: 'none' });
}

let singleton: LlmClient | undefined;

/** The process-wide client. Chosen from env on first use; see createLlmFromEnv(). */
export function getLlm(): LlmClient {
  if (!singleton) singleton = createLlmFromEnv();
  return singleton;
}

/** Inject (or clear, with undefined) the singleton. Tests use createMockLlm() here. */
export function setLlmForTests(client: LlmClient | undefined): void {
  singleton = client;
}

// ---------------------------------------------------------------------------------------------
// Strict JSON schema from Zod
// ---------------------------------------------------------------------------------------------

/**
 * Keywords strict-mode decoders reject or ignore. Zod re-validates the parsed JSON anyway, so
 * dropping these loses nothing but a hint; `enum`, `description` and the structure stay.
 */
const DROPPED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  'id',
  'default',
  'examples',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

const RECORD_HINT = 'Map encoded as a list of {key, value} pairs.';

function hasType(schema: JsonObject, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function wrapNullable(schema: JsonObject): JsonObject {
  const { description, ...rest } = schema;
  return {
    ...(typeof description === 'string' ? { description } : {}),
    anyOf: [rest, { type: 'null' }],
  };
}

/** Make a property schema accept null (the strict-mode spelling of "optional"). */
function nullable(schema: JsonObject): JsonObject {
  if (Array.isArray(schema.anyOf)) {
    const already = schema.anyOf.some((option) => isRecord(option) && option.type === 'null');
    return already ? schema : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  }
  if ('enum' in schema) return wrapNullable(schema);
  if (typeof schema.type === 'string') {
    return schema.type === 'null' ? schema : { ...schema, type: [schema.type, 'null'] };
  }
  if (Array.isArray(schema.type)) {
    return schema.type.includes('null') ? schema : { ...schema, type: [...schema.type, 'null'] };
  }
  return wrapNullable(schema);
}

function strictify(node: unknown): JsonObject {
  if (!isRecord(node)) return {};
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!DROPPED_SCHEMA_KEYS.has(key)) out[key] = value;
  }
  if ('const' in out) {
    out.enum = [out.const];
    delete out.const;
  }
  if ('oneOf' in out) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  for (const key of ['anyOf', 'allOf'] as const) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map(strictify);
  }
  if (isRecord(out.$defs)) {
    out.$defs = Object.fromEntries(
      Object.entries(out.$defs).map(([key, value]) => [key, strictify(value)]),
    );
  }
  if (isRecord(out.items)) out.items = strictify(out.items);
  else if (Array.isArray(out.items)) out.items = out.items.map(strictify);
  if (Array.isArray(out.prefixItems)) out.prefixItems = out.prefixItems.map(strictify);

  if (hasType(out, 'object')) {
    if (isRecord(out.properties)) {
      const wasRequired = new Set(
        Array.isArray(out.required) ? out.required.filter((k) => typeof k === 'string') : [],
      );
      const properties: JsonObject = {};
      for (const [key, value] of Object.entries(out.properties)) {
        const strict = strictify(value);
        properties[key] = wasRequired.has(key) ? strict : nullable(strict);
      }
      out.properties = properties;
      out.required = Object.keys(properties);
      out.additionalProperties = false;
      return out;
    }
    // A record/map (z.record): strict mode forbids open objects, so it becomes a list of
    // {key, value} pairs. fromStrictJson() folds it back into an object before Zod parses it.
    const valueSchema = isRecord(out.additionalProperties)
      ? strictify(out.additionalProperties)
      : { type: 'string' };
    const description = typeof out.description === 'string' ? out.description : undefined;
    return {
      type: 'array',
      description: description ? `${description} ${RECORD_HINT}` : RECORD_HINT,
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, value: valueSchema },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    };
  }
  return out;
}

/**
 * JSON schema for provider structured output in strict mode: object root, every property
 * required (optional ones become nullable), additionalProperties false everywhere, no $schema /
 * default keys, const turned into a one-value enum, records turned into key/value pair lists.
 * Built from the Zod *input* type, so fields with .default() may be null and Zod fills them in.
 */
export function toStrictJsonSchema(zodSchema: z.ZodType, name: string): LlmJsonSchema {
  const raw = z.toJSONSchema(zodSchema, { io: 'input', unrepresentable: 'any' });
  const schema = strictify(raw);
  if (schema.type !== 'object' || !isRecord(schema.properties)) {
    throw new LlmError(`Strict JSON schema "${name}" needs an object root with properties`, {
      provider: 'schema',
    });
  }
  return { name, schema };
}

/**
 * Recursively drop every null-valued object key. Schema-blind: it cannot tell an optional field
 * (null means "absent") from a .nullable() one (null is a value), so prefer fromStrictJson(),
 * which knows the difference. Kept for callers that have no Zod schema at hand.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => stripNulls(item)) as T;
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null) out[key] = stripNulls(item);
    }
    return out as T;
  }
  return value;
}

/**
 * The slice of Zod's internal definition (`schema._zod.def`) that decodeStrict() reads. This is
 * not public API: the field names are the ones Zod 4.6 uses. The "round-trips every wrapper
 * kind" test in llm.test.ts exercises each case below on the installed Zod, so a rename in a
 * future Zod release fails that test instead of silently breaking mission or action parsing.
 */
interface ZodDefLike {
  type: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
  valueType?: unknown;
  options?: unknown[];
  in?: unknown;
  getter?: () => unknown;
  left?: unknown;
  right?: unknown;
}

function zodDef(schema: unknown): ZodDefLike | undefined {
  const def = (schema as { _zod?: { def?: ZodDefLike } } | undefined)?._zod?.def;
  return def && typeof def.type === 'string' ? def : undefined;
}

/** Public Zod API, used to pick the union branch a decoded value belongs to. */
function zodAccepts(schema: unknown, value: unknown): boolean {
  const candidate = schema as { safeParse?: (v: unknown) => { success: boolean } } | undefined;
  return typeof candidate?.safeParse === 'function' && candidate.safeParse(value).success;
}

/**
 * Marker for "leave this key out". JSON never carries undefined, so it cannot collide with data;
 * object decoding turns it into a missing key, which is what Zod's optional/default expect.
 */
const DROP = undefined;

/**
 * Walk the Zod schema beside the decoded JSON and undo the strict encoding:
 *   optional / default   null means "absent": drop the key so Zod applies the default
 *   nullable             null is a value: keep it
 *   record               a {key, value} pair list folds back into an object
 * Everything else passes through untouched, so a null where the schema allows none still
 * reaches Zod and produces a precise validation error rather than a silent drop.
 */
function decodeStrict(schema: unknown, value: unknown): unknown {
  const def = zodDef(schema);
  if (!def) return value;
  switch (def.type) {
    case 'optional':
    case 'default':
    case 'prefault':
      return value === null ? DROP : decodeStrict(def.innerType, value);
    case 'nullable':
      return value === null ? null : decodeStrict(def.innerType, value);
    case 'nonoptional':
    case 'readonly':
    case 'catch':
    case 'promise':
      return decodeStrict(def.innerType, value);
    case 'pipe':
      return decodeStrict(def.in, value);
    case 'lazy':
      return decodeStrict(def.getter?.(), value);
    case 'intersection':
      return decodeStrict(def.right, decodeStrict(def.left, value));
    case 'union': {
      if (value === null) return null;
      const options = def.options ?? [];
      let first: unknown = value;
      let seen = false;
      for (const option of options) {
        const decoded = decodeStrict(option, value);
        if (zodAccepts(option, decoded)) return decoded;
        if (!seen) {
          first = decoded;
          seen = true;
        }
      }
      return first;
    }
    case 'object': {
      if (!isRecord(value) || !def.shape) return value;
      const out: JsonObject = {};
      for (const [key, item] of Object.entries(value)) {
        const child = def.shape[key];
        const decoded = child === undefined ? item : decodeStrict(child, item);
        if (decoded !== DROP) out[key] = decoded;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return value;
      return value.map((item: unknown) => decodeStrict(def.element, item));
    }
    case 'record': {
      if (Array.isArray(value)) {
        const out: JsonObject = {};
        for (const pair of value) {
          if (isRecord(pair) && typeof pair.key === 'string') {
            out[pair.key] = decodeStrict(def.valueType, pair.value);
          }
        }
        return out;
      }
      if (isRecord(value)) {
        const out: JsonObject = {};
        for (const [key, item] of Object.entries(value)) {
          out[key] = decodeStrict(def.valueType, item);
        }
        return out;
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * Undo the strict-schema encoding of toStrictJsonSchema() with the Zod schema as the guide: null
 * on an optional/default field drops the key, null on a .nullable() field stays null, and
 * {key, value} pair lists fold back into records. The result is ready for `zodSchema.parse()`.
 */
export function fromStrictJson(zodSchema: z.ZodType, json: unknown): unknown {
  return decodeStrict(zodSchema, json);
}
