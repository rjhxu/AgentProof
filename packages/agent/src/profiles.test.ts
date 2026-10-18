import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_LABELS, AgentConfig, type AgentKind } from '@agentproof/shared';
import {
  AGENT_PROFILES,
  PRICE_TABLE,
  ROLE_MODELS,
  estimateCostUsd,
  findModelPrice,
  profileSummary,
  resolveModel,
  resolveRunSettings,
  stepCapFromEnv,
} from './profiles';

const MODEL_ENV = [
  'AGENTPROOF_MODEL',
  'AGENTPROOF_MODEL_ALPHA',
  'AGENTPROOF_MODEL_BETA',
  'AGENTPROOF_MODEL_SIGMA',
  'AGENTPROOF_MODEL_GAMMA',
  'AGENTPROOF_MODEL_NARRATOR',
  'AGENTPROOF_MODEL_MISSION',
  'AGENTPROOF_MODEL_DIAGNOSIS',
  'AGENTPROOF_MAX_STEPS',
];

function clearEnv(): void {
  for (const name of MODEL_ENV) vi.stubEnv(name, '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AGENT_PROFILES', () => {
  it('covers every agent kind with names and strategies matching AGENT_LABELS', () => {
    for (const kind of Object.keys(AGENT_LABELS) as AgentKind[]) {
      const profile = AGENT_PROFILES[kind];
      expect(profile.kind).toBe(kind);
      expect(profile.name).toBe(AGENT_LABELS[kind].name);
      expect(profile.strategy).toBe(AGENT_LABELS[kind].strategy);
      expect(profile.perceivesLabels.length).toBeGreaterThan(0);
    }
  });

  it('encodes the thesis: Alpha is text-only and cheapest, Sigma sees everything', () => {
    expect(AGENT_PROFILES.alpha_semantic.perceives).toEqual(['tree', 'text']);
    expect(AGENT_PROFILES.alpha_semantic.targetGrammars).toEqual(['role:name']);
    expect(AGENT_PROFILES.alpha_semantic.defaultEffort).toBe('low');
    expect(AGENT_PROFILES.beta_vision.perceives).toEqual(['screenshot']);
    expect(AGENT_PROFILES.beta_vision.targetGrammars).toEqual(['x,y']);
    expect(AGENT_PROFILES.beta_vision.imageDetail).toBe('high');
    expect(AGENT_PROFILES.sigma_hybrid.perceives).toEqual(['tree', 'screenshot', 'text']);
    expect(AGENT_PROFILES.sigma_hybrid.targetGrammars).toEqual(['role:name', 'x,y']);
    expect(AGENT_PROFILES.sigma_hybrid.defaultEffort).toBe('high');
    expect(AGENT_PROFILES.sigma_hybrid.defaultMaxSteps).toBe(30);
    expect(AGENT_PROFILES.gamma_structured.perceives).toEqual([]);
    expect(AGENT_PROFILES.gamma_structured.targetGrammars).toEqual([]);
    expect(AGENT_PROFILES.gamma_structured.defaultModel.xai).toBe('none');
    expect(AGENT_PROFILES.gamma_structured.defaultMaxSteps).toBe(1);
  });

  it('never defaults any model to Opus, for either provider', () => {
    const defaults = [
      ...Object.values(AGENT_PROFILES).map((profile) => profile.defaultModel),
      ...Object.values(ROLE_MODELS),
    ];
    for (const model of defaults) {
      expect(model.xai.toLowerCase()).not.toContain('opus');
      expect(model.anthropic.toLowerCase()).not.toContain('opus');
    }
  });

  it('prices every default model so reports can show cost', () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      if (profile.defaultModel.xai === 'none') continue;
      expect(findModelPrice(profile.defaultModel.xai)).toBeDefined();
      expect(findModelPrice(profile.defaultModel.anthropic)).toBeDefined();
    }
    for (const role of Object.values(ROLE_MODELS)) {
      expect(findModelPrice(role.xai)).toBeDefined();
      expect(findModelPrice(role.anthropic)).toBeDefined();
    }
  });
});

describe('resolveModel', () => {
  it('uses the profile default per provider when nothing overrides it', () => {
    clearEnv();
    expect(resolveModel('alpha_semantic', 'xai')).toBe('grok-4.3');
    expect(resolveModel('alpha_semantic', 'anthropic')).toBe('claude-haiku-5-5');
    expect(resolveModel('beta_vision', 'xai')).toBe('grok-4.3');
    expect(resolveModel('beta_vision', 'anthropic')).toBe('claude-sonnet-5-5');
    expect(resolveModel('sigma_hybrid', 'xai')).toBe('grok-4.7');
    expect(resolveModel('sigma_hybrid', 'anthropic')).toBe('claude-sonnet-5-5');
    expect(resolveModel('narrator', 'xai')).toBe('grok-4.20-0309-non-reasoning');
    expect(resolveModel('mission', 'anthropic')).toBe('claude-haiku-5-5');
    expect(resolveModel('gamma_structured', 'xai')).toBe('none');
  });

  it('defaults the diagnosis role to a cheap model per provider', () => {
    clearEnv();
    expect(resolveModel('diagnosis', 'anthropic')).toBe('claude-haiku-5-5');
    expect(resolveModel('diagnosis', 'xai')).toBe('grok-4.3');
  });

  it('lets AGENTPROOF_MODEL_DIAGNOSIS and AGENTPROOF_MODEL override the diagnosis role', () => {
    clearEnv();
    vi.stubEnv('AGENTPROOF_MODEL_DIAGNOSIS', 'foo');
    expect(resolveModel('diagnosis', 'anthropic')).toBe('foo');
    vi.stubEnv('AGENTPROOF_MODEL_DIAGNOSIS', '');
    vi.stubEnv('AGENTPROOF_MODEL', 'bar');
    expect(resolveModel('diagnosis', 'anthropic')).toBe('bar');
  });

  it('returns the xai default for the mock provider', () => {
    clearEnv();
    expect(resolveModel('alpha_semantic', 'mock')).toBe('grok-4.3');
    expect(resolveModel('mission', 'mock')).toBe('grok-4.3');
  });

  it('applies precedence: override > AGENTPROOF_MODEL_<ROLE> > AGENTPROOF_MODEL > default', () => {
    clearEnv();
    vi.stubEnv('AGENTPROOF_MODEL', 'global-model');
    expect(resolveModel('alpha_semantic', 'xai')).toBe('global-model');
    expect(resolveModel('narrator', 'anthropic')).toBe('global-model');

    vi.stubEnv('AGENTPROOF_MODEL_ALPHA', 'alpha-model');
    expect(resolveModel('alpha_semantic', 'xai')).toBe('alpha-model');
    expect(resolveModel('beta_vision', 'xai')).toBe('global-model');

    expect(resolveModel('alpha_semantic', 'xai', 'explicit-model')).toBe('explicit-model');
    expect(resolveModel('alpha_semantic', 'xai', '   ')).toBe('alpha-model');
  });

  it('keeps Gamma at "none" under a global override but honours its own override', () => {
    clearEnv();
    vi.stubEnv('AGENTPROOF_MODEL', 'global-model');
    expect(resolveModel('gamma_structured', 'xai')).toBe('none');
    vi.stubEnv('AGENTPROOF_MODEL_GAMMA', 'gamma-model');
    expect(resolveModel('gamma_structured', 'xai')).toBe('gamma-model');
  });
});

describe('resolveRunSettings', () => {
  it('takes the lower of config/profile maxSteps and the AGENTPROOF_MAX_STEPS cap', () => {
    clearEnv();
    const alpha = resolveRunSettings(AgentConfig.parse({ kind: 'alpha_semantic' }), 'xai');
    expect(alpha.maxSteps).toBe(20); // profile 20 < default cap 25
    expect(alpha.model).toBe('grok-4.3');
    expect(alpha.effort).toBe('low');
    expect(alpha.profile.kind).toBe('alpha_semantic');

    const sigma = resolveRunSettings(AgentConfig.parse({ kind: 'sigma_hybrid' }), 'xai');
    expect(sigma.maxSteps).toBe(25); // profile 30 > default cap 25

    const big = resolveRunSettings(
      AgentConfig.parse({ kind: 'alpha_semantic', maxSteps: 40 }),
      'xai',
    );
    expect(big.maxSteps).toBe(25);

    vi.stubEnv('AGENTPROOF_MAX_STEPS', '50');
    expect(resolveRunSettings(AgentConfig.parse({ kind: 'sigma_hybrid' }), 'xai').maxSteps).toBe(
      30,
    );
    expect(
      resolveRunSettings(AgentConfig.parse({ kind: 'sigma_hybrid', maxSteps: 12 }), 'xai').maxSteps,
    ).toBe(12);

    vi.stubEnv('AGENTPROOF_MAX_STEPS', 'not-a-number');
    expect(stepCapFromEnv()).toBe(25);
  });

  it('prefers the config model and effort over the profile', () => {
    clearEnv();
    const settings = resolveRunSettings(
      AgentConfig.parse({ kind: 'beta_vision', model: 'grok-4.7', effort: 'high' }),
      'anthropic',
    );
    expect(settings.model).toBe('grok-4.7');
    expect(settings.effort).toBe('high');
    const gamma = resolveRunSettings(AgentConfig.parse({ kind: 'gamma_structured' }), 'xai');
    expect(gamma.effort).toBeUndefined();
    expect(gamma.maxSteps).toBe(1);
  });
});

describe('profileSummary', () => {
  it('matches the shared AgentProfileSummary shape', () => {
    const summary = profileSummary('alpha_semantic', 'grok-4.3', 'xai', 'low');
    expect(summary).toEqual({
      kind: 'alpha_semantic',
      name: 'Agent Alpha',
      strategy: AGENT_LABELS.alpha_semantic.strategy,
      perceives: ['accessibility tree (roles + accessible names)', 'page text excerpt'],
      targetGrammars: ['role:name'],
      model: 'grok-4.3',
      provider: 'xai',
      effort: 'low',
    });
    expect(profileSummary('gamma_structured', 'none', 'none')).not.toHaveProperty('effort');
  });
});

describe('estimateCostUsd', () => {
  it('prices grok-4.3 from the table', () => {
    // 1000 * 1.25 + 500 * 2.5 = 2500 per 1M tokens
    expect(estimateCostUsd('grok-4.3', { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(
      0.0025,
      10,
    );
    // cached input at the cached rate: 500 * 1.25 + 500 * 0.2 + 500 * 2.5 = 1975
    expect(
      estimateCostUsd('grok-4.3', { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 500 }),
    ).toBeCloseTo(0.001975, 10);
  });

  it('returns undefined for unknown models and matches date-suffixed ids', () => {
    expect(estimateCostUsd('grok-99-ultra', { inputTokens: 10, outputTokens: 10 })).toBeUndefined();
    expect(estimateCostUsd('none', { inputTokens: 0, outputTokens: 0 })).toBeUndefined();
    expect(findModelPrice('grok-4.3-20260901')).toEqual(PRICE_TABLE['grok-4.3']);
    expect(findModelPrice('claude-sonnet-5-5-2026-09-01')).toEqual(
      PRICE_TABLE['claude-sonnet-5-5'],
    );
    expect(findModelPrice('grok-4.20-0309-reasoning')).toEqual(
      PRICE_TABLE['grok-4.20-0309-reasoning'],
    );
  });

  it('makes the tier ordering visible: Alpha < Beta/Sigma per token', () => {
    const usage = { inputTokens: 10_000, outputTokens: 1_000 };
    const alpha = estimateCostUsd(AGENT_PROFILES.alpha_semantic.defaultModel.xai, usage)!;
    const sigma = estimateCostUsd(AGENT_PROFILES.sigma_hybrid.defaultModel.xai, usage)!;
    expect(alpha).toBeLessThan(sigma);
  });
});
