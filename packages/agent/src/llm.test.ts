import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentActionDraft, MissionDraft } from '@agentproof/shared';
import {
  LlmError,
  createLlmFromEnv,
  createMockLlm,
  createXaiClient,
  fromStrictJson,
  getLlm,
  setLlmForTests,
  stripNulls,
  toStrictJsonSchema,
} from './llm';
import type { LlmRequest } from './llm-types';

const API_KEY = 'xai-test-key-do-not-print';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** fetch mock that replays the given responses (or errors) in order and records each call. */
function fetchScript(script: Array<Response | Error | (() => Response | Error)>) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const entry = script[Math.min(index, script.length - 1)];
    index += 1;
    const value = typeof entry === 'function' ? entry() : entry;
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('fetch script exhausted');
    return value;
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function bodyOf(call: FetchCall | undefined): Record<string, any> {
  return JSON.parse(String(call?.init.body)) as Record<string, any>;
}

const zeroSleep = vi.fn(async (_ms: number) => {});

const RESPONSES_FIXTURE = {
  id: 'resp_123',
  status: 'completed',
  model: 'grok-4.3',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '{"type":"click","reason":"go"}', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    input_tokens_details: { cached_tokens: 200 },
    output_tokens_details: { reasoning_tokens: 120 },
    cost_in_usd_ticks: 12500000,
  },
};

const visionRequest: LlmRequest = {
  model: 'grok-4.3',
  system: 'You are a test agent.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Mission JSON here' },
        { type: 'image', mediaType: 'image/png', base64: PNG_BASE64 },
      ],
    },
  ],
  jsonSchema: {
    name: 'agent_action',
    schema: {
      type: 'object',
      properties: { type: { type: 'string' }, reason: { type: 'string' } },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  },
  effort: 'low',
  temperature: 0.2,
};

afterEach(() => {
  vi.unstubAllEnvs();
  setLlmForTests(undefined);
  zeroSleep.mockClear();
});

describe('createXaiClient (responses mode)', () => {
  it('maps the request to the Responses API and parses the reply', async () => {
    const { calls, fetchImpl } = fetchScript([jsonResponse(RESPONSES_FIXTURE)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    expect(client.provider).toBe('xai');

    const res = await client.complete(visionRequest);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.x.ai/v1/responses');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization?.startsWith('Bearer ')).toBe(true);
    expect(headers.Authorization?.length).toBeGreaterThan('Bearer '.length);
    expect(headers['Content-Type']).toBe('application/json');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    const body = bodyOf(call);
    expect(body.model).toBe('grok-4.3');
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(4096);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.temperature).toBe(0.2);
    expect(body.input[0]).toEqual({ role: 'system', content: 'You are a test agent.' });
    expect(body.input[1].role).toBe('user');
    expect(body.input[1].content[0]).toEqual({ type: 'input_text', text: 'Mission JSON here' });
    expect(body.input[1].content[1]).toEqual({
      type: 'input_image',
      image_url: `data:image/png;base64,${PNG_BASE64}`,
      detail: 'high',
    });
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.name).toBe('agent_action');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema).toEqual(visionRequest.jsonSchema!.schema);

    expect(res.provider).toBe('xai');
    expect(res.model).toBe('grok-4.3');
    expect(res.text).toBe('{"type":"click","reason":"go"}');
    expect(res.json).toEqual({ type: 'click', reason: 'go' });
    expect(res.finishReason).toBe('completed');
    expect(res.usage.calls).toBe(1);
    expect(res.usage.inputTokens).toBe(1200);
    expect(res.usage.outputTokens).toBe(300);
    expect(res.usage.reasoningTokens).toBe(120);
    expect(res.usage.cachedInputTokens).toBe(200);
    expect(res.usage.imageInputs).toBe(1);
    expect(res.usage.estimatedCostUsd).toBeCloseTo(0.00125, 10);
    expect(res.usage.llmLatencyMs).toBeGreaterThanOrEqual(0);
    expect(res.latencyMs).toBe(res.usage.llmLatencyMs);
  });

  it('estimates cost from the price table when cost_in_usd_ticks is absent', async () => {
    const fixture = {
      ...RESPONSES_FIXTURE,
      usage: { input_tokens: 1000, output_tokens: 500 },
    };
    const { fetchImpl } = fetchScript([jsonResponse(fixture)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    const res = await client.complete({ ...visionRequest, messages: [], effort: undefined });
    expect(res.usage.estimatedCostUsd).toBeCloseTo(0.0025, 10);
    expect(res.usage.imageInputs).toBe(0);
    expect(res.usage.reasoningTokens).toBe(0);
    expect(res.usage.cachedInputTokens).toBe(0);
  });

  it('omits reasoning, temperature and schema when the request has none', async () => {
    const { calls, fetchImpl } = fetchScript([jsonResponse(RESPONSES_FIXTURE)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    const res = await client.complete({
      model: 'grok-4.20-0309-non-reasoning',
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
      effort: 'high',
      maxTokens: 512,
    });
    const body = bodyOf(calls[0]);
    expect(body.reasoning).toBeUndefined(); // non-reasoning model: effort hint dropped
    expect(body.temperature).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(body.max_output_tokens).toBe(512);
    expect(body.input[2]).toEqual({ role: 'assistant', content: 'earlier reply' });
    expect(res.json).toBeUndefined(); // no schema requested, so no json even though text parses
  });

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    const { calls, fetchImpl } = fetchScript([
      jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '2' }),
      jsonResponse(RESPONSES_FIXTURE),
    ]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    const res = await client.complete(visionRequest);
    expect(res.text).toContain('click');
    expect(calls).toHaveLength(2);
    expect(zeroSleep).toHaveBeenCalledTimes(1);
    expect(zeroSleep).toHaveBeenCalledWith(2000);
  });

  it('retries a 5xx with exponential backoff', async () => {
    const { calls, fetchImpl } = fetchScript([
      jsonResponse({ error: 'bad gateway' }, 502),
      jsonResponse({ error: 'still bad' }, 503),
      jsonResponse(RESPONSES_FIXTURE),
    ]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    await client.complete(visionRequest);
    expect(calls).toHaveLength(3);
    const waits = zeroSleep.mock.calls.map((c) => c[0]);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(1300);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
    expect(waits[1]).toBeLessThan(2300);
  });

  it('gives up after maxRetries on persistent 429s', async () => {
    const { calls, fetchImpl } = fetchScript([jsonResponse({ error: 'rate limited' }, 429)]);
    const client = createXaiClient({
      apiKey: API_KEY,
      fetchImpl,
      sleep: zeroSleep,
      maxRetries: 2,
    });
    const err = await client.complete(visionRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(429);
    expect((err as LlmError).retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('throws LlmError with status and a body excerpt on a 400, without retrying', async () => {
    const longBody = { error: { message: 'invalid schema: ' + 'x'.repeat(600), secret: API_KEY } };
    const { calls, fetchImpl } = fetchScript([jsonResponse(longBody, 400)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    const err = await client.complete(visionRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    const llmErr = err as LlmError;
    expect(llmErr.status).toBe(400);
    expect(llmErr.provider).toBe('xai');
    expect(llmErr.retryable).toBe(false);
    expect(llmErr.bodyExcerpt).toContain('invalid schema');
    expect(llmErr.bodyExcerpt!.length).toBeLessThanOrEqual(300);
    expect(llmErr.bodyExcerpt).not.toContain(API_KEY);
    expect(llmErr.message).not.toContain(API_KEY);
    expect(calls).toHaveLength(1);
    expect(zeroSleep).not.toHaveBeenCalled();
  });

  it('retries timeouts and network errors, then throws', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const { calls, fetchImpl } = fetchScript([timeoutError]);
    const client = createXaiClient({
      apiKey: API_KEY,
      fetchImpl,
      sleep: zeroSleep,
      maxRetries: 2,
    });
    const err = await client
      .complete({ ...visionRequest, timeoutMs: 1234 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toContain('timed out after 1234ms');
    expect((err as LlmError).status).toBeUndefined();
    expect((err as LlmError).retryable).toBe(true);
    expect(calls).toHaveLength(3);
    expect(zeroSleep).toHaveBeenCalledTimes(2);
  });

  it('recovers from a timeout on the next attempt', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { calls, fetchImpl } = fetchScript([abortError, jsonResponse(RESPONSES_FIXTURE)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    const res = await client.complete(visionRequest);
    expect(res.json).toEqual({ type: 'click', reason: 'go' });
    expect(calls).toHaveLength(2);
  });

  it('leaves json undefined when the structured reply does not parse', async () => {
    const fixture = {
      ...RESPONSES_FIXTURE,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"type":"click","rea' }],
        },
      ],
    };
    const { fetchImpl } = fetchScript([jsonResponse(fixture)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    const res = await client.complete(visionRequest);
    expect(res.text).toBe('{"type":"click","rea');
    expect(res.json).toBeUndefined();
    expect(res.finishReason).toBe('max_output_tokens');
  });

  it('turns a refusal part into an LlmError', async () => {
    const fixture = {
      ...RESPONSES_FIXTURE,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        },
      ],
    };
    const { fetchImpl } = fetchScript([jsonResponse(fixture)]);
    const client = createXaiClient({ apiKey: API_KEY, fetchImpl, sleep: zeroSleep });
    await expect(client.complete(visionRequest)).rejects.toThrow(/refused/);
  });

  it('respects a custom base URL', async () => {
    const { calls, fetchImpl } = fetchScript([jsonResponse(RESPONSES_FIXTURE)]);
    const client = createXaiClient({
      apiKey: API_KEY,
      fetchImpl,
      sleep: zeroSleep,
      baseUrl: 'http://localhost:9999/v1/',
    });
    await client.complete(visionRequest);
    expect(calls[0]?.url).toBe('http://localhost:9999/v1/responses');
  });
});

describe('createXaiClient (chat mode)', () => {
  const CHAT_FIXTURE = {
    id: 'chatcmpl_1',
    model: 'grok-4.3',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"type":"done","reason":"ok"}' },
      },
    ],
    usage: {
      prompt_tokens: 800,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 100, image_tokens: 500 },
      completion_tokens_details: { reasoning_tokens: 40 },
    },
  };

  it('maps to /chat/completions with image_url objects and response_format', async () => {
    const { calls, fetchImpl } = fetchScript([jsonResponse(CHAT_FIXTURE)]);
    const client = createXaiClient({
      apiKey: API_KEY,
      fetchImpl,
      sleep: zeroSleep,
      mode: 'chat',
    });
    const res = await client.complete(visionRequest);

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    const body = bodyOf(calls[0]);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a test agent.' });
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'Mission JSON here' });
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_BASE64}`, detail: 'high' },
    });
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.reasoning_effort).toBe('low');
    expect(body.temperature).toBe(0.2);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('agent_action');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.store).toBeUndefined();

    expect(res.text).toBe('{"type":"done","reason":"ok"}');
    expect(res.json).toEqual({ type: 'done', reason: 'ok' });
    expect(res.finishReason).toBe('stop');
    expect(res.usage.inputTokens).toBe(800);
    expect(res.usage.outputTokens).toBe(100);
    expect(res.usage.cachedInputTokens).toBe(100);
    expect(res.usage.reasoningTokens).toBe(40);
    expect(res.usage.imageInputs).toBe(1);
    // (800 - 100) * 1.25 + 100 * 0.2 + 100 * 2.5 = 875 + 20 + 250 = 1145 per 1M
    expect(res.usage.estimatedCostUsd).toBeCloseTo(0.001145, 10);
  });
});

describe('createMockLlm', () => {
  it('returns scripted responses in order, loops the last one, and records requests', async () => {
    const mock = createMockLlm([
      { text: 'first' },
      (req) => ({ json: { echo: req.model }, usage: { inputTokens: 7 } as never }),
    ]);
    expect(mock.provider).toBe('mock');
    const req: LlmRequest = {
      model: 'grok-4.3',
      system: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'image', mediaType: 'image/png', base64: PNG_BASE64 },
          ],
        },
      ],
      jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
    };
    const first = await mock.complete(req);
    expect(first.text).toBe('first');
    expect(first.provider).toBe('mock');
    expect(first.usage.calls).toBe(1);
    expect(first.usage.imageInputs).toBe(1);
    expect(first.usage.inputTokens).toBe(0);

    const second = await mock.complete(req);
    expect(second.json).toEqual({ echo: 'grok-4.3' });
    expect(second.text).toBe('{"echo":"grok-4.3"}');
    expect(second.usage.inputTokens).toBe(7);

    const third = await mock.complete(req);
    expect(third.json).toEqual({ echo: 'grok-4.3' });
    expect(mock.requests).toHaveLength(3);
    expect(mock.requests[0]).toBe(req);
  });

  it('parses json from scripted text when a schema was requested', async () => {
    const mock = createMockLlm([{ text: '{"ok":true}' }]);
    const withSchema = await mock.complete({
      model: 'm',
      system: 's',
      messages: [],
      jsonSchema: { name: 'x', schema: {} },
    });
    expect(withSchema.json).toEqual({ ok: true });
    const withoutSchema = await mock.complete({ model: 'm', system: 's', messages: [] });
    expect(withoutSchema.json).toBeUndefined();
  });
});

describe('getLlm / provider selection', () => {
  function clearProviderEnv(): void {
    for (const name of [
      'AGENTPROOF_LLM_PROVIDER',
      'XAI_API_KEY',
      'GROK_API_KEY',
      'ANTHROPIC_API_KEY',
      'XAI_API_MODE',
      'XAI_BASE_URL',
    ]) {
      vi.stubEnv(name, '');
    }
  }

  it('returns an injected client and resets when cleared', () => {
    clearProviderEnv();
    const mock = createMockLlm([]);
    setLlmForTests(mock);
    expect(getLlm()).toBe(mock);
    setLlmForTests(undefined);
    expect(() => getLlm()).toThrow(LlmError);
  });

  it('auto-selects xai from GROK_API_KEY and anthropic from ANTHROPIC_API_KEY', () => {
    clearProviderEnv();
    vi.stubEnv('GROK_API_KEY', 'xai-test');
    expect(getLlm().provider).toBe('xai');
    expect(getLlm()).toBe(getLlm()); // singleton

    setLlmForTests(undefined);
    clearProviderEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    expect(getLlm().provider).toBe('anthropic');

    setLlmForTests(undefined);
    clearProviderEnv();
    vi.stubEnv('XAI_API_KEY', 'xai-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    expect(getLlm().provider).toBe('xai'); // xai wins when both keys are present
  });

  it('honours AGENTPROOF_LLM_PROVIDER and explains missing keys', () => {
    clearProviderEnv();
    vi.stubEnv('XAI_API_KEY', 'xai-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('AGENTPROOF_LLM_PROVIDER', 'anthropic');
    expect(createLlmFromEnv().provider).toBe('anthropic');

    vi.stubEnv('AGENTPROOF_LLM_PROVIDER', 'xai');
    vi.stubEnv('XAI_API_KEY', '');
    expect(() => createLlmFromEnv()).toThrow(/GROK_API_KEY/);

    vi.stubEnv('AGENTPROOF_LLM_PROVIDER', 'openai');
    expect(() => createLlmFromEnv()).toThrow(/Unknown AGENTPROOF_LLM_PROVIDER/);

    clearProviderEnv();
    const err = (() => {
      try {
        createLlmFromEnv();
        return undefined;
      } catch (e) {
        return e as LlmError;
      }
    })();
    expect(err).toBeInstanceOf(LlmError);
    expect(err?.message).toMatch(/GROK_API_KEY|XAI_API_KEY/);
    expect(err?.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('rejects an invalid XAI_API_MODE', () => {
    clearProviderEnv();
    vi.stubEnv('GROK_API_KEY', 'xai-test');
    vi.stubEnv('XAI_API_MODE', 'legacy');
    expect(() => createLlmFromEnv()).toThrow(/XAI_API_MODE/);
    vi.stubEnv('XAI_API_MODE', 'chat');
    expect(createLlmFromEnv().provider).toBe('xai');
  });
});

/** Recursive check of the strict-mode rules the providers enforce. */
function assertStrict(node: unknown, path = '$'): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertStrict(item, `${path}[${i}]`));
    return;
  }
  const schema = node as Record<string, unknown>;
  for (const key of ['$schema', 'default', 'propertyNames', 'const', 'oneOf']) {
    expect(schema, `${path} must not carry ${key}`).not.toHaveProperty(key);
  }
  const isObject =
    schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
  if (isObject) {
    expect(schema.properties, `${path} object needs properties`).toBeTypeOf('object');
    expect(schema.additionalProperties, `${path} additionalProperties`).toBe(false);
    const keys = Object.keys(schema.properties as Record<string, unknown>);
    expect([...(schema.required as string[])].sort(), `${path} required`).toEqual([...keys].sort());
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum' || key === 'required') continue;
    assertStrict(value, `${path}.${key}`);
  }
}

describe('toStrictJsonSchema', () => {
  it('produces a strict schema for MissionDraft', () => {
    const { name, schema } = toStrictJsonSchema(MissionDraft, 'mission_draft');
    expect(name).toBe('mission_draft');
    expect(schema.type).toBe('object');
    assertStrict(schema);

    const props = schema.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(
      [
        'allowedActions',
        'maxSteps',
        'paymentAuthorized',
        'requirements',
        'successMilestone',
      ].sort(),
    );
    // required field keeps its single type; optional/defaulted ones become nullable
    expect(props.successMilestone.type).toBe('string');
    expect(props.successMilestone.enum).toEqual([
      'product_found',
      'added_to_cart',
      'checkout_review',
    ]);
    expect(props.maxSteps.type).toEqual(['integer', 'null']);
    expect(props.allowedActions.type).toEqual(['array', 'null']);
    expect(props.paymentAuthorized.anyOf).toEqual([
      { type: 'boolean', enum: [false] },
      { type: 'null' },
    ]);

    const req = props.requirements;
    expect(req.type).toBe('object');
    expect(req.properties.product).toEqual({ type: 'string' });
    expect(req.properties.category.type).toEqual(['string', 'null']);
    expect(req.properties.maxUnitPrice.type).toEqual(['number', 'null']);
    expect(req.properties.shipping.type).toEqual(['object', 'null']);
    expect(req.properties.shipping.required).toEqual(['deliverBy', 'region']);
    // the attributes record becomes a nullable list of key/value pairs
    expect(req.properties.attributes.type).toEqual(['array', 'null']);
    expect(req.properties.attributes.items).toEqual({
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
      additionalProperties: false,
    });
  });

  it('keeps AgentActionDraft flat with nullable fields and an enum type', () => {
    const { schema } = toStrictJsonSchema(AgentActionDraft, 'agent_action');
    assertStrict(schema);
    const props = schema.properties as Record<string, any>;
    expect(schema.required).toEqual([
      'type',
      'reason',
      'target',
      'url',
      'text',
      'value',
      'direction',
      'what',
    ]);
    expect(props.type.enum).toContain('click');
    expect(props.target.type).toEqual(['string', 'null']);
    expect(props.direction.anyOf).toEqual([
      { type: 'string', enum: ['up', 'down'] },
      { type: 'null' },
    ]);
  });

  it('round-trips a strict reply back into a MissionDraft', () => {
    const reply = {
      requirements: {
        product: 'black hoodie',
        category: null,
        attributes: [
          { key: 'size', value: 'M' },
          { key: 'color', value: 'black' },
        ],
        quantity: null,
        maxUnitPrice: 60,
        maxTotalPrice: null,
        shipping: null,
      },
      successMilestone: 'checkout_review',
      allowedActions: null,
      paymentAuthorized: null,
      maxSteps: null,
    };
    const draft = MissionDraft.parse(fromStrictJson(MissionDraft, reply));
    expect(draft.requirements.attributes).toEqual({ size: 'M', color: 'black' });
    expect(draft.requirements.quantity).toBe(1);
    expect(draft.requirements.maxUnitPrice).toBe(60);
    expect(draft.requirements).not.toHaveProperty('category');
    expect(draft.allowedActions).toEqual([
      'navigate',
      'click',
      'type',
      'select',
      'scroll',
      'extract',
    ]);
    expect(draft.paymentAuthorized).toBe(false);
    expect(draft.maxSteps).toBe(25);
  });
});

describe('stripNulls', () => {
  it('removes null-valued keys recursively but keeps null array items and falsy values', () => {
    expect(
      stripNulls({
        a: null,
        b: 0,
        c: '',
        d: false,
        e: { f: null, g: [null, { h: null, i: 1 }] },
      }),
    ).toEqual({ b: 0, c: '', d: false, e: { g: [null, { i: 1 }] } });
    expect(stripNulls(null)).toBeNull();
    expect(stripNulls('x')).toBe('x');
  });
});
