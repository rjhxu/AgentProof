import {
  AGENT_LABELS,
  type AgentConfig,
  type AgentKind,
  type AgentProfileSummary,
} from '@agentproof/shared';
import type { LlmEffort } from './llm-types';

/**
 * Agent profiles: what each agent kind perceives, how it names targets, and which model it runs
 * on per provider. The thesis lives here as numbers: Alpha is the cheapest agent (text only, low
 * effort, cheapest model) and the store must work for it; Beta and Sigma show what stronger,
 * costlier agents achieve on the same store. Reports read these profiles to make the cost
 * difference visible.
 *
 * Model ids are never hardcoded elsewhere: every caller goes through resolveModel(), which
 * applies the AGENTPROOF_MODEL_* env overrides.
 */

export type Perception = 'tree' | 'screenshot' | 'text';
export type TargetGrammar = 'role:name' | 'x,y';
export type LlmProviderName = 'xai' | 'anthropic' | 'mock';

export interface AgentProfile {
  kind: AgentKind;
  name: string;
  strategy: string;
  perceives: Perception[];
  /** Human-readable version of `perceives`, copied into AgentProfileSummary */
  perceivesLabels: string[];
  targetGrammars: TargetGrammar[];
  defaultModel: { xai: string; anthropic: string };
  defaultEffort?: LlmEffort;
  defaultMaxSteps: number;
  /** Image detail hint for vision requests */
  imageDetail?: 'low' | 'high';
  /** One sentence for the report: why this agent costs what it costs */
  costNote: string;
}

export const AGENT_PROFILES: Record<AgentKind, AgentProfile> = {
  alpha_semantic: {
    kind: 'alpha_semantic',
    name: AGENT_LABELS.alpha_semantic.name,
    strategy: AGENT_LABELS.alpha_semantic.strategy,
    perceives: ['tree', 'text'],
    perceivesLabels: ['accessibility tree (roles + accessible names)', 'page text excerpt'],
    targetGrammars: ['role:name'],
    defaultModel: { xai: 'grok-4.3', anthropic: 'claude-haiku-5-5' },
    defaultEffort: 'low',
    defaultMaxSteps: 20,
    costNote:
      'Cheapest agent: text tokens only, no images, low effort, cheapest model. The store must work for this one.',
  },
  beta_vision: {
    kind: 'beta_vision',
    name: AGENT_LABELS.beta_vision.name,
    strategy: AGENT_LABELS.beta_vision.strategy,
    perceives: ['screenshot'],
    perceivesLabels: ['viewport screenshot'],
    targetGrammars: ['x,y'],
    defaultModel: { xai: 'grok-4.3', anthropic: 'claude-haiku-5-5' },
    defaultEffort: 'medium',
    defaultMaxSteps: 20,
    imageDetail: 'high',
    costNote:
      'Every step sends a screenshot (image tokens) at medium effort: what vision buys and what it costs.',
  },
  gamma_structured: {
    kind: 'gamma_structured',
    name: AGENT_LABELS.gamma_structured.name,
    strategy: AGENT_LABELS.gamma_structured.strategy,
    perceives: [],
    perceivesLabels: ['catalog feed (JSON)', 'cart API (JSON)'],
    targetGrammars: [],
    defaultModel: { xai: 'none', anthropic: 'none' },
    defaultMaxSteps: 1,
    costNote: 'Deterministic, no model calls: zero LLM cost. Only as correct as the merchant data.',
  },
  sigma_hybrid: {
    kind: 'sigma_hybrid',
    name: AGENT_LABELS.sigma_hybrid.name,
    strategy: AGENT_LABELS.sigma_hybrid.strategy,
    perceives: ['tree', 'screenshot', 'text'],
    perceivesLabels: [
      'accessibility tree (roles + accessible names)',
      'viewport screenshot',
      'page text excerpt',
    ],
    targetGrammars: ['role:name', 'x,y'],
    defaultModel: { xai: 'grok-4.7', anthropic: 'claude-sonnet-5-5' },
    defaultEffort: 'high',
    defaultMaxSteps: 30,
    imageDetail: 'high',
    costNote:
      'Most expensive: screenshot plus tree plus text every step, strongest model, high effort. A reference run, not a per-commit check.',
  },
};

/** Non-agent model roles: report narration and mission generation. */
export const ROLE_MODELS: Record<'narrator' | 'mission', { xai: string; anthropic: string }> = {
  narrator: { xai: 'grok-4.20-0309-non-reasoning', anthropic: 'claude-haiku-5-5' },
  mission: { xai: 'grok-4.3', anthropic: 'claude-haiku-5-5' },
};

export type ModelRole = AgentKind | keyof typeof ROLE_MODELS;

const ROLE_ENV_SUFFIX: Record<ModelRole, string> = {
  alpha_semantic: 'ALPHA',
  beta_vision: 'BETA',
  sigma_hybrid: 'SIGMA',
  gamma_structured: 'GAMMA',
  narrator: 'NARRATOR',
  mission: 'MISSION',
};

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function isRoleKey(role: ModelRole): role is keyof typeof ROLE_MODELS {
  return role in ROLE_MODELS;
}

/**
 * Model id for a role. Precedence: explicit override > AGENTPROOF_MODEL_<ROLE> > AGENTPROOF_MODEL
 * > profile default for the provider ('mock' uses the xAI default).
 *
 * Gamma runs no model, so it ignores the global AGENTPROOF_MODEL and resolves to "none" unless
 * explicitly overridden; otherwise a demo-wide override would show a model on a zero-cost agent.
 */
export function resolveModel(
  role: ModelRole,
  provider: LlmProviderName,
  override?: string,
): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  const roleEnv = envString(`AGENTPROOF_MODEL_${ROLE_ENV_SUFFIX[role]}`);
  if (roleEnv) return roleEnv;
  if (role !== 'gamma_structured') {
    const globalEnv = envString('AGENTPROOF_MODEL');
    if (globalEnv) return globalEnv;
  }
  const defaults = isRoleKey(role) ? ROLE_MODELS[role] : AGENT_PROFILES[role].defaultModel;
  return provider === 'anthropic' ? defaults.anthropic : defaults.xai;
}

export interface RunSettings {
  profile: AgentProfile;
  model: string;
  effort?: LlmEffort;
  maxSteps: number;
}

const DEFAULT_STEP_CAP = 25;

/** Hard cap from AGENTPROOF_MAX_STEPS (default 25); non-numeric values fall back to the default. */
export function stepCapFromEnv(): number {
  const raw = process.env.AGENTPROOF_MAX_STEPS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STEP_CAP;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_STEP_CAP;
}

/**
 * Profile + config + env, resolved once per run. maxSteps is the lower of the config/profile
 * value and the AGENTPROOF_MAX_STEPS cap; the mission's own maxSteps still applies in policy.
 */
export function resolveRunSettings(config: AgentConfig, provider: LlmProviderName): RunSettings {
  const profile = AGENT_PROFILES[config.kind];
  const model = resolveModel(config.kind, provider, config.model);
  const effort = config.effort ?? profile.defaultEffort;
  const maxSteps = Math.min(config.maxSteps ?? profile.defaultMaxSteps, stepCapFromEnv());
  return { profile, model, maxSteps, ...(effort === undefined ? {} : { effort }) };
}

/** The agent block of an AgentReport: what this agent could perceive and what it ran on. */
export function profileSummary(
  kind: AgentKind,
  model: string,
  provider: string,
  effort?: LlmEffort,
): AgentProfileSummary {
  const profile = AGENT_PROFILES[kind];
  return {
    kind,
    name: profile.name,
    strategy: profile.strategy,
    perceives: [...profile.perceivesLabels],
    targetGrammars: [...profile.targetGrammars],
    model,
    provider,
    ...(effort === undefined ? {} : { effort }),
  };
}

/** USD per 1M tokens. Verified against the providers' price pages on 2026-10-17. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export const PRICE_TABLE: Record<string, ModelPrice> = {
  'grok-4.7': { input: 2.0, cachedInput: 0.5, output: 6.0 },
  'grok-4.6': { input: 2.0, cachedInput: 0.5, output: 6.0 },
  'grok-4.5': { input: 2.0, cachedInput: 0.3, output: 6.0 },
  'grok-4.3': { input: 1.25, cachedInput: 0.2, output: 2.5 },
  'grok-4.20-0309-reasoning': { input: 1.25, cachedInput: 0.2, output: 2.5 },
  'grok-4.20-0309-non-reasoning': { input: 1.25, cachedInput: 0.2, output: 2.5 },
  'grok-build-0.1': { input: 1.0, cachedInput: 0.2, output: 2.0 },
  'claude-opus-5-5': { input: 4.0, cachedInput: 0.2, output: 20.0 },
  'claude-sonnet-5-5': { input: 2.0, cachedInput: 0.2, output: 10.0 },
  'claude-haiku-5-5': { input: 0.1, cachedInput: 0.01, output: 0.5 },
};

/** Trailing date suffixes providers append to pinned snapshots: -20260301, -2026-03-01, -0309. */
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;

/** Price for a model id: exact match first, then the id with a trailing date suffix removed. */
export function findModelPrice(model: string): ModelPrice | undefined {
  const id = model.trim().toLowerCase();
  const exact = PRICE_TABLE[id];
  if (exact) return exact;
  const withoutDate = id.replace(DATE_SUFFIX, '');
  return withoutDate !== id ? PRICE_TABLE[withoutDate] : undefined;
}

/**
 * Estimated USD cost from the static price table. Cached input tokens are a subset of
 * inputTokens and are billed at the cached rate. Undefined for unknown models, so reports can
 * say "unknown" instead of printing a wrong number.
 */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number | undefined {
  const price = findModelPrice(model);
  if (!price) return undefined;
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  const usd =
    (fresh * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}
