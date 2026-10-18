import { describe, expect, it } from 'vitest';
import type {
  CodeFix,
  CodeFixAttempt,
  CodeFixCheck,
  CodeFixDelivery,
  CodeFixInput,
  CodeFixRematch,
  CodeFixReview,
  RunComparison,
} from '@agentproof/shared';
import { CodeFix as CodeFixSchema, EMPTY_USAGE } from '@agentproof/shared';
import type { z } from 'zod';
import {
  DIFF_MAX_CHARS,
  EVIDENCE_MAX_CHARS_IN_REPORT,
  codeFixHeadline,
  pullRequestTitle,
  renderCodeFixMarkdown,
} from './render';

// Helper to build a complete fixture
function buildCodeFixFixture(overrides?: Partial<CodeFix>): CodeFix {
  const input: CodeFixInput = {
    agentKind: 'alpha_semantic',
    checkpointId: 'correct_size_identified',
    observed: 'Cart contained size S, mission required M.',
    requirements: {
      product: 'Hoodie',
      category: 'apparel',
      attributes: {
        color: 'black',
        size: 'M',
      },
      quantity: 1,
      maxUnitPrice: 100,
    },
    attributionCategory: 'semantic_interface_problem',
    attributionReason: 'The size picker is not accessible to the text-only agent.',
    evidenceText:
      'Evidence collected from the failed run.\n\nAgent: Alpha (text-only)\nCheckpoint: Correct size identified\nObserved: Cart contained size S, mission required M.\nStep 5: Attempted to find size M\nAgent perceived: A list of size options with values "S", "M", "L", but they are div elements with no role or label.\nCart state: { variant: "HOODIE-BLK-S", quantity: 1, price: 49.99 }\n\nThe problem is that the size picker uses custom div chips with aria-hidden="true" instead of radio buttons or select elements, making them inaccessible to agents that only read the accessibility tree.',
    evidenceChars: 412,
    evidenceFlags: [],
    repositoryUrl: 'https://github.com/example/store',
    commitSha: 'abc1234567890def',
    storeRoot: 'apps/storefront',
  };

  const check1: CodeFixCheck = {
    id: 'paths_in_scope',
    status: 'passed',
    detail: 'All paths are inside src/ with allowed extensions.',
    durationMs: 5,
  };

  const check2: CodeFixCheck = {
    id: 'no_dependency_changes',
    status: 'passed',
    detail: 'No package.json, lockfiles, or config files touched.',
    durationMs: 3,
  };

  const check3: CodeFixCheck = {
    id: 'size_within_bounds',
    status: 'passed',
    detail: '1 file, 8 changed lines.',
    durationMs: 2,
  };

  const check4: CodeFixCheck = {
    id: 'applies_cleanly',
    status: 'failed',
    detail: 'Hunk 1 failed: search string not found at offset 142.',
  };

  const check5: CodeFixCheck = {
    id: 'typecheck',
    status: 'skipped',
    detail: 'Skipped: not executed after earlier check failed.',
  };

  const failedAttempt: CodeFixAttempt = {
    index: 0,
    model: 'claude-haiku-5',
    startedAt: '2026-10-17T12:00:00Z',
    finishedAt: '2026-10-17T12:00:15Z',
    proposal: {
      diagnosis: {
        title: 'Size picker uses inaccessible divs',
        category: 'semantic_interface_problem',
        inferredCause:
          'The size buttons are implemented as custom div elements with aria-hidden="true", making them invisible to accessibility tree parsers used by the alpha agent.',
        confidence: 'high',
        needsFiles: [],
      },
      edits: [
        {
          path: 'src/views.ts',
          search:
            '<div className="size-chips">\n  {sizes.map((s) => (\n    <div key={s} className="chip" onClick={() => setSize(s)}>\n      {s}\n    </div>\n  ))}\n</div>',
          replace:
            '<fieldset className="size-chips">\n  <legend>Size</legend>\n  {sizes.map((s) => (\n    <label key={s} className="chip">\n      <input type="radio" name="size" value={s} onChange={() => setSize(s)} />\n      {s}\n    </label>\n  ))}\n</fieldset>',
          reason:
            'Replace custom div buttons with semantic radio button group to make sizes accessible.',
        },
      ],
      summary: 'Convert size picker from custom divs to semantic radio buttons for accessibility.',
    },
    files: ['src/views.ts'],
    editErrors: ['search string not found at offset 142'],
    validation: {
      checks: [check1, check2, check3, check4, check5],
      passed: false,
    },
    usage: {
      calls: 1,
      inputTokens: 3500,
      outputTokens: 450,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      imageInputs: 0,
      llmLatencyMs: 1500,
      estimatedCostUsd: 0.0061,
    },
  };

  const checkP1: CodeFixCheck = {
    id: 'paths_in_scope',
    status: 'passed',
    detail: 'All paths are inside src/ with allowed extensions.',
    durationMs: 4,
  };

  const checkP2: CodeFixCheck = {
    id: 'no_dependency_changes',
    status: 'passed',
    detail: 'No package.json, lockfiles, or config files touched.',
    durationMs: 3,
  };

  const checkP3: CodeFixCheck = {
    id: 'size_within_bounds',
    status: 'passed',
    detail: '1 file, 8 changed lines.',
    durationMs: 2,
  };

  const checkP4: CodeFixCheck = {
    id: 'applies_cleanly',
    status: 'passed',
    detail: 'Patch applied cleanly with 1 hunk.',
    durationMs: 8,
  };

  const checkP5: CodeFixCheck = {
    id: 'typecheck',
    status: 'skipped',
    detail: 'Skipped: no tsconfig.json in store root (see attempt notes).',
  };

  const successAttempt: CodeFixAttempt = {
    index: 1,
    model: 'claude-haiku-5',
    startedAt: '2026-10-17T12:00:20Z',
    finishedAt: '2026-10-17T12:00:35Z',
    proposal: {
      diagnosis: {
        title: 'Size picker uses inaccessible divs',
        category: 'semantic_interface_problem',
        inferredCause:
          'The size buttons are implemented as custom div elements with aria-hidden="true", making them invisible to accessibility tree parsers used by the alpha agent.',
        confidence: 'high',
        needsFiles: [],
      },
      edits: [
        {
          path: 'src/views.ts',
          search:
            'const SizeChip = ({ label, selected }) => (\n  <div\n    role="button"\n    aria-label={label}\n    onClick={() => setSize(label)}\n    className={`chip ${selected ? "selected" : ""}`}\n  >\n    {label}\n  </div>\n);',
          replace:
            'const SizeChip = ({ label, selected }) => (\n  <label className={`chip ${selected ? "selected" : ""}`}>\n    <input\n      type="radio"\n      name="size"\n      value={label}\n      checked={selected}\n      onChange={() => setSize(label)}\n      className="hidden"\n    />\n    {label}\n  </label>\n);',
          reason: 'Replace custom div button with semantic radio input wrapped in label.',
        },
      ],
      summary: 'Convert custom size picker to semantic radio buttons for accessibility.',
    },
    files: ['src/views.ts'],
    editErrors: [],
    diff: '--- a/src/views.ts\n+++ b/src/views.ts\n@@ -42,14 +42,18 @@ function ProductPage() {\n   const [size, setSize] = useState("S");\n \n   const SizeChip = ({ label, selected }) => (\n-    <div\n-      role="button"\n-      aria-label={label}\n-      onClick={() => setSize(label)}\n-      className={`chip ${selected ? "selected" : ""}`}\n+    <label className={`chip ${selected ? "selected" : ""}`}>\n+      <input\n+        type="radio"\n+        name="size"\n+        value={label}\n+        checked={selected}\n+        onChange={() => setSize(label)}\n+        className="hidden"\n+      />\n       >\n       {label}\n-    </div>\n+    </label>\n   );',
    validation: {
      checks: [checkP1, checkP2, checkP3, checkP4, checkP5],
      passed: true,
    },
    usage: {
      calls: 1,
      inputTokens: 3700,
      outputTokens: 520,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      imageInputs: 0,
      llmLatencyMs: 1700,
      estimatedCostUsd: 0.0068,
    },
  };

  const review: CodeFixReview = {
    verdict: 'concerns',
    humanVisibleChange: true,
    addressesObservedFailure: true,
    minimal: true,
    notes: [
      'The radio button approach is semantically correct and solves the accessibility problem.',
      'Consider adding aria-label="Choose size" to the fieldset for additional clarity.',
    ],
    model: 'claude-haiku-5',
    usage: {
      calls: 1,
      inputTokens: 4200,
      outputTokens: 280,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      imageInputs: 0,
      llmLatencyMs: 1200,
      estimatedCostUsd: 0.0055,
    },
  };

  const delivery: CodeFixDelivery = {
    mode: 'pull_request',
    status: 'delivered',
    branch: 'agentproof/correct-size-fix-abc123',
    commitSha: 'def4567890abc123',
    compareUrl:
      'https://github.com/example/store/compare/main...agentproof/correct-size-fix-abc123',
    pullRequestUrl: 'https://github.com/example/store/pull/12',
    pullRequestNumber: 12,
    draft: true,
    deliveredAt: '2026-10-17T12:00:40Z',
  };

  const deltas: RunComparison['deltas'] = [
    {
      id: 'correct_size_identified',
      before: 'failed',
      after: 'passed',
      change: 'improved',
    },
    {
      id: 'added_to_cart',
      before: 'passed',
      after: 'passed',
      change: 'unchanged',
    },
  ];

  const comparison: RunComparison = {
    originalRunId: 'run_abc123',
    rematchRunId: 'run_def456',
    deltas,
    improved: 1,
    regressed: 0,
    unchanged: 1,
  };

  const rematch: CodeFixRematch = {
    runId: 'run_def456',
    status: 'passed',
    storeUrl: 'http://localhost:5001',
    comparison,
  };

  const base: CodeFix = {
    id: 'fix_abc123def456',
    runId: 'run_original',
    missionId: 'mission_001',
    repositoryId: 'repo_001',
    createdAt: '2026-10-17T12:00:00Z',
    finishedAt: '2026-10-17T12:00:50Z',
    status: 'succeeded',
    stage: 'done',
    mode: 'pull_request',
    options: {
      typecheck: true,
      review: true,
      rematch: true,
      maxAttempts: 2,
      storeRoot: 'apps/storefront',
    },
    input,
    localization: [],
    attempts: [failedAttempt, successAttempt],
    finalAttempt: 1,
    review,
    delivery,
    rematch,
    usage: {
      calls: 3,
      inputTokens: 11400,
      outputTokens: 1250,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      imageInputs: 0,
      llmLatencyMs: 4400,
      estimatedCostUsd: 0.0123,
    },
    timeline: [],
    artifacts: [
      'codefix/fix_abc123def456/codefix.json',
      'codefix/fix_abc123def456/codefix.md',
      'codefix/fix_abc123def456/patch.diff',
    ],
  };

  return CodeFixSchema.parse({ ...base, ...overrides });
}

describe('renderCodeFixMarkdown', () => {
  it('includes all 11 headings and footers in order', () => {
    const fix = buildCodeFixFixture();
    const md = renderCodeFixMarkdown(fix, { forPullRequest: true });

    const headings = [
      '# AgentProof fix:',
      '## What failed (observed by code)',
      '## Diagnosis (model hypothesis)',
      '## Change',
      '## Validation (run by code)',
      '## Review (second model opinion, advisory)',
      '## Rematch (real rerun on the patched store)',
      '## Delivery',
      '## Cost',
      '## Evidence given to the model',
    ];

    let lastIndex = -1;
    for (const heading of headings) {
      const index = md.indexOf(heading);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }

    // Check footer
    expect(md).toContain('_Opened as a draft by AgentProof');
  });

  it('includes hypothesis label and review label with advisory text', () => {
    const fix = buildCodeFixFixture();
    const md = renderCodeFixMarkdown(fix);

    expect(md).toContain('A hypothesis, not a verdict.');
    expect(md).toContain('Advisory only; it never changes the verdict above.');
    expect(md).toContain('```diff');
  });

  it('includes validation table with skipped typecheck check', () => {
    const fix = buildCodeFixFixture();
    const md = renderCodeFixMarkdown(fix);

    expect(md).toContain('| Check | Result | Detail | Time |');
    expect(md).toContain('| typecheck | skipped |');
  });

  it('summarizes earlier failed attempt under Attempts section', () => {
    const fix = buildCodeFixFixture();
    const md = renderCodeFixMarkdown(fix);

    expect(md).toContain('Attempts: 2.');
    expect(md).toContain('Attempt 1 (claude-haiku-5):');
    expect(md).toContain('applies_cleanly');
  });

  it('renders different footers for PR mode vs non-PR mode', () => {
    const fix = buildCodeFixFixture();
    const mdNonPr = renderCodeFixMarkdown(fix, { forPullRequest: false });
    const mdPr = renderCodeFixMarkdown(fix, { forPullRequest: true });

    expect(mdNonPr).toContain(
      '_AgentProof never merges: this record is a proposal for a human to review._',
    );
    expect(mdPr).toContain(
      '_Opened as a draft by AgentProof. A human reviews and merges; the agent cannot merge, approve, or mark this ready for review._',
    );
  });

  it('respects maxChars in PR mode and contains Delivery and truncation line', () => {
    const fix = buildCodeFixFixture();
    const md = renderCodeFixMarkdown(fix, { forPullRequest: true, maxChars: 3000 });

    expect(md.length).toBeLessThanOrEqual(3000);
    expect(md).toContain('## Delivery');
    expect(md).toContain('diff truncated');
  });

  it('codeFixHeadline mentions checkpoint label, check counts, and draft PR', () => {
    const fix = buildCodeFixFixture();
    const headline = codeFixHeadline(fix);

    expect(headline).toContain('Correct size identified');
    expect(headline).toContain('4 checks passed');
    expect(headline).toContain('1 check skipped');
    expect(headline).toContain('draft PR #12');
  });

  it('codeFixHeadline for failed fix says no valid diff after N attempts', () => {
    const fix = buildCodeFixFixture({
      finalAttempt: undefined,
      attempts: [
        {
          index: 0,
          model: 'claude-haiku-5',
          startedAt: '2026-10-17T12:00:00Z',
          finishedAt: '2026-10-17T12:00:15Z',
          files: [],
          editErrors: ['search string not found'],
          usage: {
            calls: 1,
            inputTokens: 3500,
            outputTokens: 450,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            imageInputs: 0,
            llmLatencyMs: 1500,
            estimatedCostUsd: 0.0061,
          },
        },
        {
          index: 1,
          model: 'claude-haiku-5',
          startedAt: '2026-10-17T12:00:20Z',
          finishedAt: '2026-10-17T12:00:35Z',
          files: [],
          editErrors: ['path not in scope'],
          usage: {
            calls: 1,
            inputTokens: 3700,
            outputTokens: 520,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            imageInputs: 0,
            llmLatencyMs: 1700,
            estimatedCostUsd: 0.0068,
          },
        },
      ],
    });
    const headline = codeFixHeadline(fix);

    expect(headline).toContain('no valid diff after 2 attempts');
  });

  it('pullRequestTitle is at most 72 chars with ellipsis when truncated', () => {
    const fix = buildCodeFixFixture({
      attempts: [
        {
          index: 0,
          model: 'claude-haiku-5',
          startedAt: '2026-10-17T12:00:00Z',
          finishedAt: '2026-10-17T12:00:15Z',
          proposal: {
            diagnosis: {
              title:
                'A very long title that exceeds the seventy two character limit and must be truncated with an ellipsis',
              category: 'semantic_interface_problem',
              inferredCause: 'Test',
              confidence: 'high',
              needsFiles: [],
            },
            edits: [],
            summary: 'Test',
          },
          files: [],
          editErrors: [],
          usage: {
            calls: 1,
            inputTokens: 3500,
            outputTokens: 450,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            imageInputs: 0,
            llmLatencyMs: 1500,
            estimatedCostUsd: 0.0061,
          },
        },
      ],
      finalAttempt: 0,
    });

    const title = pullRequestTitle(fix);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toContain('…');
    expect(title).toContain('AgentProof:');
  });

  it('pullRequestTitle falls back to checkpoint label when no proposal', () => {
    const fix = buildCodeFixFixture({
      finalAttempt: undefined,
      attempts: [],
    });

    const title = pullRequestTitle(fix);
    expect(title).toContain('AgentProof: fix for Correct size identified');
    expect(title.length).toBeLessThanOrEqual(72);
  });

  it('renders minimal CodeFix without throwing', () => {
    const fix = buildCodeFixFixture({
      status: 'running',
      stage: 'collect',
      input: undefined,
      attempts: [],
      finalAttempt: undefined,
      review: undefined,
      rematch: undefined,
      delivery: {
        mode: 'diff',
        status: 'not_requested',
      },
    });

    const md = renderCodeFixMarkdown(fix);

    expect(md).toContain('Evidence was not collected.');
    expect(md).toContain('No diagnosis was produced.');
    expect(md).toContain('No diff was produced.');
    expect(md).toContain('No validation was run.');
    expect(md).toContain('Not run.');
  });

  it('exports correct constants', () => {
    expect(DIFF_MAX_CHARS).toBe(20000);
    expect(EVIDENCE_MAX_CHARS_IN_REPORT).toBe(9000);
  });

  it('escapes markdown table cell pipes and newlines', () => {
    const fix = buildCodeFixFixture({
      attempts: [
        {
          index: 0,
          model: 'claude-haiku-5',
          startedAt: '2026-10-17T12:00:00Z',
          finishedAt: '2026-10-17T12:00:15Z',
          files: [],
          editErrors: [],
          validation: {
            checks: [
              {
                id: 'paths_in_scope',
                status: 'failed',
                detail: 'Path contains pipe | and newline\ncharacters',
              },
            ],
            passed: false,
          },
          usage: {
            calls: 1,
            inputTokens: 3500,
            outputTokens: 450,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            imageInputs: 0,
            llmLatencyMs: 1500,
            estimatedCostUsd: 0.0061,
          },
        },
      ],
      finalAttempt: 0,
    });

    const md = renderCodeFixMarkdown(fix);

    // The table should escape pipes and collapse newlines
    expect(md).toContain('Path contains pipe \\|');
    expect(md).toContain('newline characters');
    expect(md).not.toContain('| Path contains pipe | and newline\ncharacters |');
  });
});
