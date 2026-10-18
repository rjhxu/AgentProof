import { describe, it, expect } from 'vitest';
import {
  buildEvidenceBundle,
  renderEvidenceBundle,
  EVIDENCE_MAX_CHARS,
  MAX_STEP_LINES,
} from './evidence';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';
import type {
  Checkpoint,
  Run,
  RunStep,
  MissionReport,
  Attribution,
  AgentKind,
} from '@agentproof/shared';
import { CHECKPOINT_LABELS } from '@agentproof/shared';

describe('evidence.ts', () => {
  it('buildEvidenceBundle picks checkpoint label, observed text, requirements, and visitedUrls', () => {
    const checkpoint: Checkpoint = alphaFailedRun.verification!.firstFailure ?? {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Cart contained size S, mission required M.',
      evidenceIds: [],
    };

    const bundle = buildEvidenceBundle({
      mission: hoodieMission,
      run: alphaFailedRun,
      checkpoint,
    });

    expect(bundle.checkpointLabel).toBe(CHECKPOINT_LABELS[checkpoint.id]);
    expect(bundle.observed).toBe(checkpoint.detail);
    expect(bundle.requirements).toEqual(hoodieMission.requirements);
    expect(bundle.visitedUrls).toContain('/');
    expect(bundle.visitedUrls).toContain('/products/black-hoodie');
    expect(bundle.stepLines.length).toBeLessThanOrEqual(
      Math.min(MAX_STEP_LINES, alphaFailedRun.steps.length),
    );
    expect(bundle.stepsTotal).toBe(alphaFailedRun.steps.length);
  });

  it('carries attribution category, reason and pattern when missionReport is provided', () => {
    const checkpoint: Checkpoint = {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Agent could not locate a size control in the accessibility tree.',
      evidenceIds: ['ev_demo00000002'],
    };

    const missionReport: MissionReport = {
      id: 'mrep_test',
      missionId: hoodieMission.id,
      generatedAt: '2026-10-17T21:00:00Z',
      mission: hoodieMission,
      storeUrl: hoodieMission.storeUrl,
      runs: [],
      matrix: {
        correct_size_identified: {
          alpha_semantic: 'failed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        product_discovered: {
          alpha_semantic: 'passed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        correct_color_identified: {
          alpha_semantic: 'passed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        added_to_cart: {
          alpha_semantic: 'passed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        cart_matches_variant: {
          alpha_semantic: 'failed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        cart_quantity_correct: {
          alpha_semantic: 'passed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        price_within_budget: {
          alpha_semantic: 'passed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        checkout_review_reached: {
          alpha_semantic: 'passed',
          beta_vision: 'passed',
          gamma_structured: 'passed',
          sigma_hybrid: 'passed',
        },
        catalog_variant_resolves: {
          alpha_semantic: 'not_run',
          beta_vision: 'not_run',
          gamma_structured: 'passed',
          sigma_hybrid: 'not_run',
        },
        catalog_price_matches_page: {
          alpha_semantic: 'not_run',
          beta_vision: 'not_run',
          gamma_structured: 'passed',
          sigma_hybrid: 'not_run',
        },
      },
      attributions: [
        {
          checkpointId: checkpoint.id,
          category: 'semantic_interface_problem',
          reason: 'The size selector lacks semantic markup; Alpha cannot interact with it.',
          reference: 'alpha_semantic',
          pattern: {
            alpha_semantic: 'failed',
            beta_vision: 'passed',
            gamma_structured: 'passed',
            sigma_hybrid: 'passed',
          },
          failingAgents: ['alpha_semantic'],
        },
      ],
      costComparison: [],
      headline: '1 of 4 agents failed on size selection.',
      recommendations: [],
    };

    const bundle = buildEvidenceBundle({
      mission: hoodieMission,
      run: alphaFailedRun,
      checkpoint,
      missionReport,
    });

    expect(bundle.attributionCategory).toBe('semantic_interface_problem');
    expect(bundle.attributionReason).toBe(
      'The size selector lacks semantic markup; Alpha cannot interact with it.',
    );
    expect(bundle.attributionPattern).toEqual({
      alpha_semantic: 'failed',
      beta_vision: 'passed',
      gamma_structured: 'passed',
      sigma_hybrid: 'passed',
    });
  });

  it('renderEvidenceBundle includes all expected headings and observed text, with cart when present', () => {
    const checkpoint: Checkpoint = {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Test observed detail',
      evidenceIds: [],
    };

    const bundle = buildEvidenceBundle({
      mission: hoodieMission,
      run: alphaFailedRun,
      checkpoint,
    });

    const rendered = renderEvidenceBundle(bundle);

    expect(rendered).toContain('## Mission');
    expect(rendered).toContain('## Failed checkpoint (observed by code)');
    expect(rendered).toContain('## Steps');
    expect(rendered).toContain('## Pages visited');
    expect(rendered).toContain('Test observed detail');

    if (bundle.observedCart) {
      expect(rendered).toContain('## Cart as observed through the store API');
    }

    expect(rendered.length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS);
  });

  it('handles 80-step run with 30-line window centered on failure at step 50', () => {
    // Create a synthetic 80-step run with failure at step 50
    const steps: RunStep[] = [];
    for (let i = 0; i < 80; i++) {
      steps.push({
        index: i,
        at: `2026-10-17T20:00:${String(i).padStart(2, '0')}.000Z`,
        url: 'http://localhost:5000/page',
        action: {
          type: 'click',
          target: `button:Action ${i}`,
          reason: `Step ${i}`,
        },
        outcome: i === 50 ? 'error' : 'ok',
        outcomeDetail: i === 50 ? 'This action failed at step 50' : undefined,
        durationMs: 100,
      });
    }

    const syntheticRun: Run = {
      id: 'run_synthetic_80',
      missionId: hoodieMission.id,
      agent: alphaFailedRun.agent,
      status: 'failed',
      label: 'original',
      createdAt: '2026-10-17T20:00:05.000Z',
      startedAt: '2026-10-17T20:00:06.000Z',
      finishedAt: '2026-10-17T20:01:12.000Z',
      steps,
      evidence: [],
      verification: {
        verifiedAt: '2026-10-17T20:01:12.000Z',
        checkpoints: [
          {
            id: 'correct_size_identified',
            status: 'failed',
            detail: 'Failure at step 50',
            evidenceIds: [],
          },
        ],
        firstFailure: {
          id: 'correct_size_identified',
          status: 'failed',
          detail: 'Failure at step 50',
          evidenceIds: [],
        },
      },
    };

    const checkpoint: Checkpoint = {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Failure at step 50',
      evidenceIds: [],
    };

    const bundle = buildEvidenceBundle({
      mission: hoodieMission,
      run: syntheticRun,
      checkpoint,
    });

    expect(bundle.stepLines.length).toBeLessThanOrEqual(MAX_STEP_LINES);
    expect(bundle.stepsTotal).toBe(80);

    const rendered = renderEvidenceBundle(bundle);
    expect(rendered).toContain('(30 of 80)');
    expect(rendered).toContain('#50');

    // Check that neighbors around 50 are present
    const has35ish = rendered.match(/#(3[5-9]|4[0-9]|5[0-5])/);
    const has65ish = rendered.match(/#(5[5-9]|6[0-4])/);
    expect(has35ish || has65ish).toBeTruthy();
  });

  it('truncates oversized perceived text and stays under EVIDENCE_MAX_CHARS', () => {
    const checkpoint: Checkpoint = {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Failure on size',
      evidenceIds: [],
    };

    const hugePerceived = 'x'.repeat(20000);

    const bundle: ReturnType<typeof buildEvidenceBundle> = {
      agentKind: 'alpha_semantic',
      checkpointId: checkpoint.id,
      checkpointLabel: CHECKPOINT_LABELS[checkpoint.id],
      observed: checkpoint.detail ?? 'Checkpoint failed',
      attributionCategory: undefined,
      attributionReason: undefined,
      attributionPattern: undefined,
      requirements: hoodieMission.requirements,
      successMilestone: hoodieMission.successMilestone,
      storeUrl: hoodieMission.storeUrl,
      stepLines: ['#0 click -> ok', '#1 click -> ok'],
      stepsTotal: 2,
      failurePoint: {
        stepIndex: 1,
        url: 'http://localhost:5000/page',
        attempted: 'click on size control',
        outcome: 'error: not found',
        perceived: hugePerceived,
      },
      observedCart: undefined,
      catalogRecord: undefined,
      cartApi: undefined,
      claim: undefined,
      visitedUrls: ['/', '/page'],
    };

    const rendered = renderEvidenceBundle(bundle);

    expect(rendered.length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS);
    expect(rendered).toContain('[truncated]');
  });

  it('is deterministic: same bundle renders identically twice', () => {
    const checkpoint: Checkpoint = {
      id: 'correct_size_identified',
      status: 'failed',
      detail: 'Determinism test',
      evidenceIds: [],
    };

    const bundle = buildEvidenceBundle({
      mission: hoodieMission,
      run: alphaFailedRun,
      checkpoint,
    });

    const render1 = renderEvidenceBundle(bundle);
    const render2 = renderEvidenceBundle(bundle);

    expect(render1).toBe(render2);
  });
});
