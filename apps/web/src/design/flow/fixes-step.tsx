'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { Issue, Repair, RepositoryConnection } from '@agentproof/shared';

import { DiffView } from './diff-view';
import { FixesMark } from './illustrations';
import { StepHeader } from './step-header';

export type FixesStepProps = {
  repository: RepositoryConnection;
  phase: 'reading' | 'ready';
  fixes: Array<{ issue: Issue; repair: Repair }>;
  /** How long the reading beat lasts; the counter runs over it. */
  readMs: number;
};

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

function FixCard({ issue, repair }: { issue: Issue; repair: Repair }) {
  return (
    <motion.article
      variants={{ hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0 } }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="rounded-lg border border-[var(--line)] bg-[var(--background)] p-6"
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        For: {issue.title}
      </p>
      <h3 className="mt-1 text-[18px] font-semibold leading-snug">{repair.summary}</h3>
      <p className="mt-1 font-mono text-xs text-[var(--muted)]">{repair.files.join(', ')}</p>
      <div className="mt-4">
        <DiffView diff={repair.diff} />
      </div>
    </motion.article>
  );
}

/** Step 4: a short reading beat, then one card per problem with its patch. */
export function FixesStep(p: FixesStepProps) {
  const count = p.fixes.length;
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
            : 'Each change is a patch against your repository. Review it, apply it, deploy, and scan again.'
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
              <FixCard issue={fix.issue} repair={fix.repair} />
            </li>
          ))}
        </motion.ol>
      )}

      {p.phase === 'ready' ? (
        <p className="mt-8 text-center text-sm text-[var(--muted)]">
          Apply the patches, deploy, and scan again to see the shoppers get through.
        </p>
      ) : null}
    </div>
  );
}
