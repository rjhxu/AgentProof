import { describe, expect, it } from 'vitest';
import { alphaFailedRun } from '@agentproof/shared/fixtures';
import type { AgentKind, CheckpointStatus, Run } from '@agentproof/shared';
import {
  attributeCheckpoint,
  attributeMission,
  latestRunsByKind,
  recommendationsFrom,
} from './attribute';

/** Build a finished run for `kind` whose checkpoints match the fixture's ids with the given statuses. */
function runFor(
  kind: AgentKind,
  statuses: Partial<Record<string, CheckpointStatus>>,
  id = `run_${kind}`,
): Run {
  const checkpoints = alphaFailedRun.verification!.checkpoints.map((c) => ({
    ...c,
    status: statuses[c.id] ?? ('passed' as const),
    detail: undefined,
    evidenceIds: [],
  }));
  const failed = checkpoints.some((c) => c.status === 'failed');
  return {
    ...alphaFailedRun,
    id,
    agent: { ...alphaFailedRun.agent, kind },
    status: failed ? 'failed' : 'passed',
    createdAt: `2026-10-17T20:0${id.length % 10}:00.000Z`,
    verification: {
      ...alphaFailedRun.verification!,
      checkpoints,
      firstFailure: checkpoints.find((c) => c.status === 'failed'),
    },
  };
}

const alphaFail = runFor('alpha_semantic', {
  correct_size_identified: 'failed',
  cart_matches_variant: 'failed',
});
const betaPass = runFor('beta_vision', {});
const sigmaPass = runFor('sigma_hybrid', {});
const gammaFail = runFor('gamma_structured', { cart_matches_variant: 'failed' });

describe('attributeCheckpoint', () => {
  it('Sigma pass + Alpha fail => semantic_interface_problem', () => {
    const byKind = latestRunsByKind([alphaFail, sigmaPass]);
    const [a] = attributeCheckpoint('correct_size_identified', byKind);
    expect(a?.category).toBe('semantic_interface_problem');
    expect(a?.reference).toBe('sigma_hybrid');
    expect(a?.failingAgents).toEqual(['alpha_semantic']);
    expect(a?.reason).toContain('Agent Sigma passed');
  });

  it('falls back to Beta as reference when Sigma did not run', () => {
    const [a] = attributeCheckpoint(
      'correct_size_identified',
      latestRunsByKind([alphaFail, betaPass]),
    );
    expect(a?.category).toBe('semantic_interface_problem');
    expect(a?.reference).toBe('beta_vision');
  });

  it('browser pass + Gamma fail => product_data_inconsistency, and Alpha fail on the same checkpoint is attributed separately', () => {
    const out = attributeCheckpoint(
      'cart_matches_variant',
      latestRunsByKind([alphaFail, sigmaPass, gammaFail]),
    );
    expect(out.map((a) => a.category).sort()).toEqual([
      'product_data_inconsistency',
      'semantic_interface_problem',
    ]);
    expect(out.find((a) => a.category === 'product_data_inconsistency')?.failingAgents).toEqual([
      'gamma_structured',
    ]);
  });

  it('Sigma fail => cart_checkout_defect for every failing agent', () => {
    const sigmaFail = runFor('sigma_hybrid', { added_to_cart: 'failed' });
    const alphaAlsoFail = runFor('alpha_semantic', { added_to_cart: 'failed' }, 'run_alpha2');
    const [a] = attributeCheckpoint('added_to_cart', latestRunsByKind([sigmaFail, alphaAlsoFail]));
    expect(a?.category).toBe('cart_checkout_defect');
    expect(a?.failingAgents.sort()).toEqual(['alpha_semantic', 'sigma_hybrid']);
  });

  it('Sigma fail + Alpha pass => agent_execution_error on the reference', () => {
    const sigmaFail = runFor('sigma_hybrid', { added_to_cart: 'failed' });
    const alphaPass = runFor('alpha_semantic', {});
    const [a] = attributeCheckpoint('added_to_cart', latestRunsByKind([sigmaFail, alphaPass]));
    expect(a?.category).toBe('agent_execution_error');
    expect(a?.failingAgents).toEqual(['sigma_hybrid']);
  });

  it('returns nothing with a single run', () => {
    expect(attributeCheckpoint('correct_size_identified', latestRunsByKind([alphaFail]))).toEqual(
      [],
    );
  });

  it('ignores errored runs and uses the latest run per kind', () => {
    const errored: Run = {
      ...sigmaPass,
      id: 'run_err',
      status: 'error',
      createdAt: '2026-10-17T23:00:00.000Z',
    };
    const byKind = latestRunsByKind([alphaFail, sigmaPass, errored]);
    expect(byKind.sigma_hybrid?.id).toBe(sigmaPass.id);
  });
});

describe('attributeMission + recommendations', () => {
  it('covers every failed checkpoint in order and derives distinct recommendations', () => {
    const attributions = attributeMission([alphaFail, sigmaPass, gammaFail]);
    expect(attributions.map((a) => a.checkpointId)).toEqual([
      'correct_size_identified',
      'cart_matches_variant',
      'cart_matches_variant',
    ]);
    const recs = recommendationsFrom(attributions);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatch(/accessible name/);
    expect(recs[1]).toMatch(/catalog/);
  });
});
