'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type {
  CodeFixCheck,
  CodeFixDelivery,
  CodeFixReview,
  Issue,
  Repair,
  RepositoryConnection,
} from '@agentproof/shared';

import { shortModel } from '../format';
import { DiffView } from './diff-view';
import {
  CHECK_LABELS,
  CHECK_ORDER,
  canOpenPullRequests,
  checksSummary,
  deliveryLine,
  reviewLine,
  type CodeFixPreview,
} from './fixes-data';
import { BranchIcon, CheckIcon, CrossIcon, DownloadIcon, ExternalIcon, SpinnerIcon } from './icons';
import { FixesMark } from './illustrations';
import { StepHeader } from './step-header';

export type FixesStepProps = {
  repository: RepositoryConnection;
  phase: 'reading' | 'ready';
  fixes: Array<{ issue: Issue; repair: Repair }>;
  /** Issue id -> the checks, the second opinion and the delivery of its fix. */
  codefixes: Record<string, CodeFixPreview>;
  /** How long the reading beat lasts; the counter runs over it. */
  readMs: number;
};

/** Sandbox beat: how long "open draft pull requests" takes. At wiring, the code-fix events. */
const OPEN_MS = 1600;

function Reading({ repository, readMs }: { repository: RepositoryConnection; readMs: number }) {
  const total = Math.max(1, repository.fileCount);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const interval = Math.max(20, readMs / total);
    const id = setInterval(() => setCount((c) => Math.min(total, c + 1)), interval);
    return () => clearInterval(id);
  }, [readMs, total]);
  const file = repository.files[Math.min(repository.files.length - 1, Math.max(0, count - 1))];
  return (
    <div className="mx-auto mt-8 max-w-[560px]">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-2)]">
        <motion.div
          className="h-full rounded-full bg-[var(--accent)]"
          initial={{ width: '0%' }}
          animate={{ width: `${(count / total) * 100}%` }}
          transition={{ ease: 'linear', duration: 0.15 }}
        />
      </div>
      <p className="mt-3 flex items-baseline justify-between text-sm">
        <span className="tabular-nums">
          {count} of {total} files
        </span>
        <span className="truncate font-mono text-xs text-[var(--muted)]">{file ?? ''}</span>
      </p>
      <p className="mt-6 text-center text-sm text-[var(--muted)]">
        {repository.fullName} · {repository.defaultBranch} · {repository.commitSha.slice(0, 7)}
      </p>
    </div>
  );
}

/** The seven code-written checks as ticks with their details, and the rematch as the proof. */
function Checks({ checks }: { checks: CodeFixCheck[] }) {
  const byId = new Map(checks.map((c) => [c.id, c] as const));
  const summary = checksSummary(checks);
  const rematch = byId.get('rematch');
  return (
    <div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Validation checks">
        {CHECK_ORDER.map((id) => {
          const check = byId.get(id);
          const status = check?.status ?? 'skipped';
          return (
            <li
              key={id}
              title={check?.detail ?? 'not run'}
              className="flex items-center gap-1.5 text-[12px]"
            >
              {status === 'passed' ? (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)]">
                  <CheckIcon size={10} />
                </span>
              ) : status === 'failed' ? (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--fail)] text-white">
                  <CrossIcon size={10} />
                </span>
              ) : (
                <span className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--line-strong)] text-[10px] text-[var(--muted)]">
                  –
                </span>
              )}
              <span className={status === 'skipped' ? 'text-[var(--muted)]' : ''}>
                {CHECK_LABELS[id]}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] text-[var(--muted)]">
        <span className="text-[var(--foreground)]">{summary.line}.</span>
        {rematch?.status === 'passed' && rematch.detail ? ` ${rematch.detail}.` : ''}
      </p>
    </div>
  );
}

/** The reviewer's verdict, labelled as a second opinion, never shown as a status. */
function Review({ review }: { review: CodeFixReview }) {
  return (
    <p className="text-[12px] leading-snug text-[var(--muted)]">
      <span className="mr-1 rounded bg-[var(--panel-2)] px-1 py-px text-[10px] uppercase tracking-wide">
        second opinion · {shortModel(review.model)}
      </span>
      <span className="text-[var(--foreground)]">{reviewLine(review)}</span>
      {review.notes[0] ? ` ${review.notes[0]}` : ''}
    </p>
  );
}

function Delivery({ delivery }: { delivery: CodeFixDelivery }) {
  const line = deliveryLine(delivery);
  return (
    <motion.div
      key={delivery.status}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"
    >
      {delivery.status === 'delivered' ? (
        <>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)]">
            <CheckIcon size={10} />
          </span>
          <span className="min-w-0">{line}</span>
          {delivery.pullRequestUrl ? (
            <a
              href={delivery.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[var(--accent)] underline-offset-4 hover:underline"
            >
              Open on GitHub
              <ExternalIcon size={12} />
            </a>
          ) : null}
          <span className="text-[12px] text-[var(--muted)]">never merged by us</span>
        </>
      ) : delivery.status === 'pending' ? (
        <>
          <SpinnerIcon size={14} />
          <span className="text-[var(--muted)]">{line}</span>
        </>
      ) : delivery.status === 'failed' ? (
        <>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--fail)] text-white">
            <CrossIcon size={10} />
          </span>
          <span>{line}</span>
        </>
      ) : (
        <span className="text-[var(--muted)]">{line}</span>
      )}
    </motion.div>
  );
}

function FixCard({
  issue,
  repair,
  preview,
  delivery,
}: {
  issue: Issue;
  repair: Repair;
  preview?: CodeFixPreview;
  delivery: CodeFixDelivery;
}) {
  return (
    <motion.article
      variants={{ hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0 } }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="rounded-lg border border-[var(--line)] bg-[var(--background)] p-6"
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        For: {issue.title}
      </p>
      <h3 className="mt-1 text-[18px] font-semibold leading-snug">
        {repair.summary}{' '}
        <span className="align-middle whitespace-nowrap rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--muted)]">
          the model&apos;s summary
        </span>
      </h3>
      <p className="mt-1 font-mono text-xs text-[var(--muted)]">{repair.files.join(', ')}</p>

      {preview ? (
        <div className="mt-4 space-y-3 border-t border-[var(--line)] pt-4">
          <Checks checks={preview.checks} />
          {preview.review ? <Review review={preview.review} /> : null}
        </div>
      ) : null}

      <div className="mt-4">
        <DiffView diff={repair.diff} />
      </div>

      <div className="mt-4 border-t border-[var(--line)] pt-3">
        <Delivery delivery={delivery} />
      </div>
    </motion.article>
  );
}

/**
 * Step 4: a short reading beat, then one card per problem with its checks, the second opinion
 * and its patch, and one action: open a draft pull request per fix. Merging stays with the
 * merchant; the patches are the fallback when the app is not installed on the repository.
 */
export function FixesStep(p: FixesStepProps) {
  const count = p.fixes.length;
  const canOpen = canOpenPullRequests(p.repository);
  const [opening, setOpening] = useState<'idle' | 'pending' | 'done'>('idle');

  // Sandbox beat. At wiring: startCodeFix(runId, { mode: 'pull_request', consent: true })
  // per failed run, then subscribeCodeFix until `done`; the record's delivery fills each card.
  useEffect(() => {
    if (opening !== 'pending') return;
    const id = setTimeout(() => setOpening('done'), OPEN_MS);
    return () => clearTimeout(id);
  }, [opening]);

  const deliveryFor = (issue: Issue): CodeFixDelivery => {
    const preview = p.codefixes[issue.id];
    if (!preview) return { mode: 'diff', status: 'not_requested' };
    if (opening === 'done' && preview.opened) return preview.opened;
    if (opening === 'pending') return { mode: 'pull_request', status: 'pending' };
    return preview.delivery;
  };

  const downloadPatches = () => {
    const text = p.fixes.map((f) => f.repair.diff.replace(/\n?$/, '\n')).join('\n');
    const blob = new Blob([text], { type: 'text/x-patch' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `agentproof-fixes-${p.repository.fullName.replace('/', '-')}.patch`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div>
      <StepHeader
        mark={<FixesMark />}
        title={
          p.phase === 'reading'
            ? 'Reading your code'
            : `${count} suggested change${count === 1 ? '' : 's'}`
        }
        subtitle={
          p.phase === 'reading'
            ? `Looking through ${p.repository.fullName} for the code behind each problem.`
            : 'Each change was applied, compiled and rerun against a patched copy of your store before you see it. Open it as a draft pull request, review, and merge when you are happy.'
        }
      />

      {p.phase === 'reading' ? (
        <Reading repository={p.repository} readMs={p.readMs} />
      ) : (
        <motion.ol
          className="mt-8 space-y-4"
          initial="hidden"
          animate="shown"
          variants={{ shown: { transition: { staggerChildren: 0.08 } } }}
        >
          {p.fixes.map((fix) => (
            <li key={fix.repair.id}>
              <FixCard
                issue={fix.issue}
                repair={fix.repair}
                preview={p.codefixes[fix.issue.id]}
                delivery={deliveryFor(fix.issue)}
              />
            </li>
          ))}
        </motion.ol>
      )}

      {p.phase === 'ready' ? (
        <section className="mt-8 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 text-center">
          <h3 className="text-[18px] font-semibold">Get these changes into your repository</h3>
          <p className="mx-auto mt-1 max-w-[520px] text-sm leading-relaxed text-[var(--muted)]">
            {canOpen
              ? 'One draft pull request per change, each on a branch of its own. You review and merge; we never merge.'
              : `Opening pull requests needs the AgentProof GitHub App installed on ${p.repository.fullName}. Until then, download the patches and apply them yourself.`}
          </p>
          <AnimatePresence mode="wait" initial={false}>
            {canOpen && opening === 'done' ? (
              <motion.p
                key="opened"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-5 inline-flex items-center gap-2 text-[15px] font-medium"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)]">
                  <CheckIcon size={12} />
                </span>
                {count} draft pull request{count === 1 ? '' : 's'} opened
              </motion.p>
            ) : (
              <motion.div key="action" exit={{ opacity: 0 }} className="mt-5">
                {canOpen ? (
                  <button
                    type="button"
                    disabled={opening === 'pending'}
                    onClick={() => setOpening('pending')}
                    className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90 disabled:opacity-60"
                  >
                    {opening === 'pending' ? <SpinnerIcon /> : <BranchIcon />}
                    {opening === 'pending'
                      ? 'Opening'
                      : `Open ${count} draft pull request${count === 1 ? '' : 's'}`}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={downloadPatches}
                    className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90"
                  >
                    <DownloadIcon />
                    Download the patches
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {canOpen ? (
            <button
              type="button"
              onClick={downloadPatches}
              className="mt-5 inline-flex items-center gap-1.5 text-sm text-[var(--muted)] underline-offset-4 hover:underline"
            >
              <DownloadIcon size={14} />
              Download the patches instead
            </button>
          ) : null}
        </section>
      ) : null}

      {p.phase === 'ready' ? (
        <p className="mt-8 text-center text-sm text-[var(--muted)]">
          Review the pull requests, merge when you are happy, and scan again once you deploy.
        </p>
      ) : null}
    </div>
  );
}
