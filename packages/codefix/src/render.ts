import type { CodeFix } from '@agentproof/shared';
import { escapeModelText } from './untrusted';
import { AGENT_LABELS, CHECKPOINT_LABELS, FAILURE_CATEGORY_LABELS } from '@agentproof/shared';

/** One deterministic sentence, e.g. "Fix for Correct size identified (run run_abc): diff validated, 4 checks passed, 1 skipped; draft PR #12 opened." or "...: no valid diff after 2 attempts." */
export function codeFixHeadline(fix: CodeFix): string {
  const checkpointLabel = CHECKPOINT_LABELS[fix.input?.checkpointId ?? 'product_discovered'];
  const base = `Fix for ${checkpointLabel} (run ${fix.runId})`;

  if (!fix.finalAttempt && fix.finalAttempt !== 0) {
    // No valid diff after attempts
    const attempts = fix.attempts.length;
    return `${base}: no valid diff after ${attempts} attempt${attempts === 1 ? '' : 's'}.`;
  }

  // Has a valid diff; count the validation checks
  const finalAttempt = fix.attempts[fix.finalAttempt];
  if (!finalAttempt?.validation) {
    return `${base}: diff validated (no validation checks).`;
  }

  const checks = finalAttempt.validation.checks;
  const passed = checks.filter((c) => c.status === 'passed').length;
  const failed = checks.filter((c) => c.status === 'failed').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;

  let checkSummary = '';
  const parts = [];
  if (passed > 0) parts.push(`${passed} check${passed === 1 ? '' : 's'} passed`);
  if (failed > 0) parts.push(`${failed} check${failed === 1 ? '' : 's'} failed`);
  if (skipped > 0) parts.push(`${skipped} check${skipped === 1 ? '' : 's'} skipped`);
  checkSummary = parts.join(', ');

  let delivery = '';
  if (fix.delivery.pullRequestNumber !== undefined && fix.delivery.pullRequestNumber !== null) {
    const draftText = fix.delivery.draft ? 'draft ' : '';
    delivery = `; ${draftText}PR #${fix.delivery.pullRequestNumber} opened`;
  } else if (fix.delivery.mode === 'branch' && fix.delivery.branch) {
    delivery = `; branch ${fix.delivery.branch} pushed`;
  } else if (fix.delivery.mode === 'diff') {
    delivery = '; diff produced';
  }

  return `${base}: ${checkSummary}${delivery}.`;
}

/** "AgentProof: <final proposal title>" cut to 72 chars (ellipsis '…' when cut); falls back to "AgentProof: fix for <checkpoint label>" when there is no proposal. */
export function pullRequestTitle(fix: CodeFix): string {
  const finalAttempt =
    fix.finalAttempt !== undefined && fix.finalAttempt !== null
      ? fix.attempts[fix.finalAttempt]
      : undefined;
  const rawTitle = finalAttempt?.proposal?.diagnosis?.title;
  // Model-written: one line, no markup, bounded.
  const title = rawTitle ? escapeModelText(rawTitle, 160).replace(/\s*\n+\s*/g, ' ') : undefined;

  const base = title
    ? `AgentProof: ${title}`
    : `AgentProof: fix for ${CHECKPOINT_LABELS[fix.input?.checkpointId ?? 'product_discovered']}`;

  if (base.length <= 72) {
    return base;
  }
  return base.substring(0, 69) + '…';
}

export interface RenderOptions {
  /** PR mode: the footer says the PR is a draft a human must review and merge; the whole body is cut to maxChars (default 60000) by shortening the diff first, then the evidence. */
  forPullRequest?: boolean;
  maxChars?: number;
  /** When given, artifact paths render as links: `${artifactBaseUrl}/${path}` */
  artifactBaseUrl?: string;
}

export const DIFF_MAX_CHARS = 20000;
export const EVIDENCE_MAX_CHARS_IN_REPORT = 9000;

/** Tool output (git, tsc) and excerpts land in cells: no pipes, no newlines, no raw tags. */
function escapeMarkdownTableCell(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncateString(text: string, maxChars: number, suffix = ' [truncated]'): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.substring(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

function getDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }
  return { added, removed };
}

export function renderCodeFixMarkdown(fix: CodeFix, opts?: RenderOptions): string {
  const forPullRequest = opts?.forPullRequest ?? false;
  const artifactBaseUrl = opts?.artifactBaseUrl;

  const finalAttempt =
    fix.finalAttempt !== undefined && fix.finalAttempt !== null
      ? fix.attempts[fix.finalAttempt]
      : undefined;
  const proposal = finalAttempt?.proposal;

  // Build sections as parts to allow for truncation later
  const parts: string[] = [];

  // Section 1: Title, headline, status
  const checkpointLabel = CHECKPOINT_LABELS[fix.input?.checkpointId ?? 'product_discovered'];
  const diagnosisTitle = proposal?.diagnosis?.title || checkpointLabel;
  parts.push(`# AgentProof fix: ${diagnosisTitle}`);
  parts.push('');
  parts.push(codeFixHeadline(fix));
  parts.push('');
  parts.push(`Status: ${fix.status} · Stage: ${fix.stage} · Mode: ${fix.mode}`);
  parts.push('');

  if (fix.error) {
    parts.push('## Error');
    parts.push('');
    parts.push(fix.error);
    parts.push('');
  }

  // Section 2: What failed
  parts.push('## What failed (observed by code)');
  parts.push('');
  if (!fix.input) {
    parts.push('Evidence was not collected.');
  } else {
    parts.push(`- **Agent**: ${AGENT_LABELS[fix.input.agentKind].name}`);
    parts.push(`- **Checkpoint** (\`${fix.input.checkpointId}\`): ${checkpointLabel}`);
    parts.push(`- **Observed**: ${fix.input.observed}`);

    let attribution = 'not available';
    if (fix.input.attributionCategory) {
      const catLabel = FAILURE_CATEGORY_LABELS[fix.input.attributionCategory];
      attribution = `${catLabel}${fix.input.attributionReason ? `: ${fix.input.attributionReason}` : ''}`;
    }
    parts.push(`- **Attribution**: ${attribution}`);

    const repoLine = `${fix.input.repositoryUrl} @ ${fix.input.commitSha.substring(0, 7)}, store root: ${fix.input.storeRoot || '(repository root)'}`;
    parts.push(`- **Repository**: ${repoLine}`);
  }
  parts.push('');

  // Section 3: Diagnosis
  parts.push('## Diagnosis (model hypothesis)');
  parts.push('');
  if (!proposal) {
    parts.push('No diagnosis was produced.');
  } else {
    const diagModel = finalAttempt?.model || '(unknown)';
    parts.push(`_Written by ${diagModel}. A hypothesis, not a verdict._`);
    parts.push('');
    parts.push(`**Title**: ${escapeModelText(proposal.diagnosis.title, 160)}`);
    parts.push(`**Category**: ${FAILURE_CATEGORY_LABELS[proposal.diagnosis.category]}`);
    parts.push(`**Confidence**: ${proposal.diagnosis.confidence}`);
    parts.push(`**Cause**: ${escapeModelText(proposal.diagnosis.inferredCause, 2000)}`);
  }
  parts.push('');

  // Section 4: Change
  parts.push('## Change');
  parts.push('');
  if (!proposal) {
    parts.push('No diff was produced.');
  } else {
    parts.push('_Summary written by the model:_');
    parts.push('');
    parts.push(escapeModelText(proposal.summary, 2000));
    parts.push('');

    const files = finalAttempt?.files ?? [];
    if (files.length > 0) {
      parts.push('**Files**:');
      for (const file of files) {
        parts.push(`- ${file}`);
      }
    }

    if (finalAttempt?.diff) {
      const { added, removed } = getDiffLines(finalAttempt.diff);
      const fileStat = files.length > 0 ? `\n\n` : '';
      parts.push(fileStat + `+${added} −${removed} lines`);
      parts.push('');

      const diffCap = forPullRequest
        ? Math.min(DIFF_MAX_CHARS, (opts?.maxChars ?? 60000) - 8000)
        : DIFF_MAX_CHARS;
      const truncatedDiff = truncateString(
        finalAttempt.diff,
        diffCap,
        '\n[diff truncated; full patch attached as patch.diff]',
      );

      parts.push('```diff');
      parts.push(truncatedDiff);
      parts.push('```');
    }
  }
  parts.push('');

  // Section 5: Validation
  parts.push('## Validation (run by code)');
  parts.push('');
  const validationReport =
    finalAttempt?.validation ||
    (fix.attempts.length > 0 ? fix.attempts[fix.attempts.length - 1]?.validation : undefined);

  if (!validationReport) {
    parts.push('No validation was run.');
  } else {
    // Build validation table
    const tableRows = validationReport.checks.map((check) => {
      const resultText =
        check.status === 'passed' ? 'passed' : check.status === 'failed' ? 'failed' : 'skipped';
      const detail = escapeMarkdownTableCell(check.detail);
      const time = check.durationMs !== undefined ? `${check.durationMs} ms` : '−';
      return `| ${check.id} | ${resultText} | ${detail} | ${time} |`;
    });

    parts.push('| Check | Result | Detail | Time |');
    parts.push('|---|---|---|---|');
    parts.push(...tableRows);
    parts.push('');

    // Earlier attempts summary
    if (fix.attempts.length > 1) {
      parts.push(`Attempts: ${fix.attempts.length}.`);
      parts.push('');
      for (let i = 0; i < fix.attempts.length - 1; i++) {
        const attempt = fix.attempts[i];
        if (!attempt) continue;
        const attemptModel = attempt.model || '(unknown)';
        let detail = '';

        if (attempt.validation) {
          const firstFailed = attempt.validation.checks.find((c) => c.status === 'failed');
          if (firstFailed) {
            detail = `${firstFailed.id}: ${escapeMarkdownTableCell(firstFailed.detail)}`;
          }
        }

        if (!detail && attempt.editErrors && attempt.editErrors.length > 0) {
          const firstError = attempt.editErrors[0];
          if (firstError) {
            detail = escapeMarkdownTableCell(firstError);
          }
        }

        if (!detail && attempt.error) {
          detail = escapeMarkdownTableCell(attempt.error);
        }

        if (!detail) {
          detail = '(no details recorded)';
        }

        const attemptLine = `Attempt ${i + 1} (${attemptModel}): ${detail}`;
        const truncated = truncateString(attemptLine, 200);
        parts.push(`- ${truncated}`);
      }
    }
  }
  parts.push('');

  // Section 6: Review
  parts.push('## Review (second model opinion, advisory)');
  parts.push('');
  if (!fix.review) {
    parts.push('Not run.');
  } else {
    const reviewModel = fix.review.model || '(unknown)';
    parts.push(`_Written by ${reviewModel}. Advisory only; it never changes the verdict above._`);
    parts.push('');
    parts.push(`**Verdict**: ${fix.review.verdict}`);
    parts.push(`**Human-visible change**: ${fix.review.humanVisibleChange ? 'yes' : 'no'}`);
    parts.push(
      `**Addresses the observed failure**: ${fix.review.addressesObservedFailure ? 'yes' : 'no'}`,
    );
    parts.push(`**Minimal**: ${fix.review.minimal ? 'yes' : 'no'}`);
    if (fix.review.notes.length > 0) {
      parts.push('');
      for (const note of fix.review.notes) {
        parts.push(`- ${escapeModelText(note, 600)}`);
      }
    }
  }
  parts.push('');

  // Section 7: Rematch
  parts.push('## Rematch (real rerun on the patched store)');
  parts.push('');
  if (!fix.rematch) {
    parts.push('Not run.');
  } else {
    if (fix.rematch.error) {
      parts.push(`**Error**: ${fix.rematch.error}`);
      parts.push('');
    } else {
      parts.push(`**Run**: ${fix.rematch.runId}`);
      parts.push(`**Status**: ${fix.rematch.status}`);
      parts.push(`**Store**: ${fix.rematch.storeUrl}`);
      parts.push('');

      if (fix.rematch.comparison) {
        const comp = fix.rematch.comparison;
        parts.push(
          `Improved ${comp.improved}, regressed ${comp.regressed}, unchanged ${comp.unchanged}`,
        );
        parts.push('');

        if (comp.deltas.length > 0) {
          parts.push('| Checkpoint | Before | After | Change |');
          parts.push('|---|---|---|---|');
          for (const delta of comp.deltas) {
            const cpLabel = CHECKPOINT_LABELS[delta.id];
            const before = escapeMarkdownTableCell(delta.before);
            const after = escapeMarkdownTableCell(delta.after);
            parts.push(
              `| ${escapeMarkdownTableCell(cpLabel)} | ${before} | ${after} | ${delta.change} |`,
            );
          }
        }
      }
    }
  }
  parts.push('');

  // Section 8: Delivery
  parts.push('## Delivery');
  parts.push('');
  parts.push(`**Mode**: ${fix.delivery.mode}`);
  parts.push(`**Status**: ${fix.delivery.status}`);
  if (fix.delivery.branch) {
    parts.push(`**Branch**: ${fix.delivery.branch}`);
  }
  if (fix.delivery.commitSha) {
    parts.push(`**Commit**: ${fix.delivery.commitSha.substring(0, 7)}`);
  }
  if (fix.delivery.compareUrl) {
    parts.push(`**Compare**: [${fix.delivery.compareUrl}](${fix.delivery.compareUrl})`);
  }
  if (fix.delivery.pullRequestNumber !== undefined && fix.delivery.pullRequestNumber !== null) {
    const prLink = fix.delivery.pullRequestUrl
      ? `[#${fix.delivery.pullRequestNumber}](${fix.delivery.pullRequestUrl})`
      : `#${fix.delivery.pullRequestNumber}`;
    const draftText = fix.delivery.draft ? ', draft' : '';
    parts.push(`**Pull request**: ${prLink}${draftText}`);
  }
  if (fix.delivery.error) {
    parts.push(`**Error**: ${fix.delivery.error}`);
  }
  parts.push('');

  // Section 9: Cost
  parts.push('## Cost');
  parts.push('');
  const allAttempts = fix.attempts;
  const totalInputTokens =
    allAttempts.reduce((sum, a) => sum + (a.usage?.inputTokens ?? 0), 0) +
    (fix.review?.usage?.inputTokens ?? 0);
  const totalOutputTokens =
    allAttempts.reduce((sum, a) => sum + (a.usage?.outputTokens ?? 0), 0) +
    (fix.review?.usage?.outputTokens ?? 0);
  const totalCalls = allAttempts.length + (fix.review ? 1 : 0);
  const estimatedCost = fix.usage?.estimatedCostUsd ?? 0;

  let costText = `${totalCalls} model call${totalCalls === 1 ? '' : 's'}, ${totalInputTokens} input tokens, ${totalOutputTokens} output tokens`;
  if (estimatedCost !== undefined && estimatedCost !== null && estimatedCost >= 0) {
    const costStr = estimatedCost === 0 ? '0.0000' : estimatedCost.toFixed(4);
    costText += `, estimated $${costStr}`;
  } else {
    costText += ', estimated $unknown';
  }
  parts.push(costText);
  parts.push('');

  // Section 10: Evidence
  if (fix.input?.evidenceText) {
    parts.push('## Evidence given to the model');
    parts.push('');
    const truncatedEvidence = truncateString(fix.input.evidenceText, EVIDENCE_MAX_CHARS_IN_REPORT);
    parts.push('<details><summary>Show the exact evidence text</summary>');
    parts.push('');
    parts.push('```text');
    parts.push(truncatedEvidence);
    parts.push('```');
    parts.push('');
    parts.push('</details>');
    parts.push('');
  }

  // Section 11: Footer
  if (forPullRequest) {
    parts.push(
      '_Opened as a draft by AgentProof. A human reviews and merges; the agent cannot merge, approve, or mark this ready for review._',
    );
  } else {
    parts.push('_AgentProof never merges: this record is a proposal for a human to review._');
  }

  let markdown = parts.join('\n');

  // Apply maxChars truncation if needed
  if (forPullRequest && opts?.maxChars && markdown.length > opts.maxChars) {
    const maxChars = opts.maxChars;
    // Truncate diff first, then evidence
    let truncated = markdown;

    // Try truncating the diff
    const diffBlockMatch = truncated.match(/```diff\n[\s\S]*?\n```\n/);
    if (diffBlockMatch) {
      const originalDiffBlock = diffBlockMatch[0];
      const lines = originalDiffBlock.split('\n');
      let newDiff: string | undefined = lines[0]; // ```diff
      let lineCount = 1;
      for (let i = 1; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line) continue;
        const proposedLength = (newDiff?.length ?? 0) + line.length + 1;
        if (truncated.length - originalDiffBlock.length + proposedLength > maxChars - 100) {
          newDiff = (newDiff ?? '') + '\n[diff truncated; full patch attached as patch.diff]\n```';
          break;
        }
        newDiff = (newDiff ?? '') + '\n' + line;
        lineCount++;
      }
      if (lineCount === lines.length - 2) {
        const penultimate = lines[lines.length - 2];
        const last = lines[lines.length - 1];
        if (penultimate && last) {
          newDiff = (newDiff ?? '') + '\n' + penultimate + '\n' + last;
        }
      }
      if (newDiff) {
        truncated = truncated.replace(originalDiffBlock, newDiff);
      }
    }

    // Try truncating the evidence
    if (truncated.length > maxChars) {
      const evidenceMatch = truncated.match(/```text\n[\s\S]*?\n```/);
      if (evidenceMatch) {
        const originalEvidence = evidenceMatch[0];
        const evidenceContent = originalEvidence.slice(7, -3); // Remove ```text and ```
        const availableChars = maxChars - (truncated.length - originalEvidence.length);
        const truncatedEvidenceContent =
          evidenceContent.substring(0, availableChars - 20) + '\n[truncated]';
        const newEvidence = '```text\n' + truncatedEvidenceContent + '\n```';
        truncated = truncated.replace(originalEvidence, newEvidence);
      }
    }

    markdown = truncated.substring(0, maxChars);
  }

  return markdown;
}
