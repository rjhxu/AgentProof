'use client';

import { useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type {
  AgentKind,
  Attribution,
  ConnectRepositoryRequest,
  Issue,
  RunStatus,
} from '@agentproof/shared';

import { shortName, type ScanSummary } from '../format';
import { BranchIcon, CheckIcon, CrossIcon, DownloadIcon, SpinnerIcon } from './icons';
import { FindingsMark } from './illustrations';
import { StepHeader } from './step-header';

export type IssueCardData = {
  issue: Issue;
  attribution?: Attribution;
  /** The viewport at the failing step, when the agent had one. */
  screenshotUrl?: string;
  /** What the agent perceived at the failing step (an accessibility-tree excerpt). */
  excerpt?: string;
  affected: Array<{ kind: AgentKind; name: string; status: RunStatus | 'not_run' | string }>;
  cost: string;
  recommendation?: string;
};

export type FindingsStepProps = {
  summary: ScanSummary;
  cards: IssueCardData[];
  connect: 'closed' | 'open' | 'submitting';
  onOpenConnect: () => void;
  onConnect: (request: ConnectRepositoryRequest) => void;
  onDownload: () => void;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4 text-sm">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 leading-relaxed">{children}</dd>
    </div>
  );
}

function IssueCard({ card }: { card: IssueCardData }) {
  const { issue } = card;
  return (
    <motion.article
      variants={{ hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0 } }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="rounded-lg border border-[var(--line)] bg-[var(--background)] p-6"
    >
      <h3 className="text-[18px] font-semibold leading-snug">{issue.title}</h3>

      <div className="mt-4 grid grid-cols-[200px_1fr] gap-5">
        {card.screenshotUrl ? (
          <figure className="overflow-hidden rounded border border-[var(--line)] bg-[var(--panel)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={card.screenshotUrl}
              alt=""
              className="aspect-[16/10] w-full object-cover object-top"
            />
          </figure>
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center rounded border border-[var(--line)] bg-[var(--panel)] text-[11px] text-[var(--muted)]">
            read through the API
          </div>
        )}
        <div className="min-w-0 text-sm">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
            What we saw
          </p>
          <p className="mt-1 leading-relaxed">{issue.observed}</p>
          {card.excerpt ? (
            <pre className="thin-scroll mt-2 max-h-28 overflow-auto rounded bg-[var(--panel)] p-2 text-[11px] leading-snug text-[var(--muted)]">
              {card.excerpt}
            </pre>
          ) : null}
        </div>
      </div>

      <dl className="mt-5 space-y-2.5 border-t border-[var(--line)] pt-4">
        <Field label="Who it affects">
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {card.affected.map((a) => {
              const failed = a.status === 'failed';
              const passed = a.status === 'passed';
              return (
                <span key={a.kind} className="inline-flex items-center gap-1">
                  <span className={failed ? 'text-[var(--fail)]' : 'text-[var(--foreground)]'}>
                    {failed ? <CrossIcon size={12} /> : passed ? <CheckIcon size={12} /> : '–'}
                  </span>
                  {shortName(a.name)}{' '}
                  <span className="text-[var(--muted)]">{String(a.status).replace(/_/g, ' ')}</span>
                </span>
              );
            })}
          </span>
        </Field>
        <Field label="What it cost">{card.cost}</Field>
        {issue.inferredCause ? (
          <Field label="Likely cause">
            {issue.inferredCause}{' '}
            <span className="whitespace-nowrap rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
              hypothesis{issue.confidence ? ` · ${issue.confidence} confidence` : ''}
            </span>
          </Field>
        ) : null}
        {card.recommendation ? <Field label="Recommended">{card.recommendation}</Field> : null}
      </dl>
    </motion.article>
  );
}

function ConnectForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (request: ConnectRepositoryRequest) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const ready = url.trim() !== '' && consent && !busy;
  return (
    <form
      className="mx-auto mt-5 max-w-[520px] space-y-3 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        const token = tokenRef.current?.value.trim();
        if (tokenRef.current) tokenRef.current.value = '';
        onSubmit({ url: url.trim(), ...(token ? { token } : {}), consent: true });
      }}
    >
      <label className="block text-sm" htmlFor={`${id}-url`}>
        <span className="text-[var(--muted)]">Repository</span>
        <input
          id={`${id}-url`}
          type="url"
          placeholder="https://github.com/owner/repository"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mt-1 h-11 w-full rounded-md border border-[var(--line-strong)] bg-[var(--background)] px-3 text-[15px] outline-none focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)]"
        />
      </label>
      <label className="block text-sm" htmlFor={`${id}-token`}>
        <span className="text-[var(--muted)]">Read-only token, only for private repositories</span>
        <input
          id={`${id}-token`}
          ref={tokenRef}
          type="password"
          autoComplete="off"
          className="mt-1 h-11 w-full rounded-md border border-[var(--line-strong)] bg-[var(--background)] px-3 text-[15px] outline-none focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)]"
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 h-4 w-4 accent-[var(--accent)]"
        />
        <span className="text-[var(--muted)]">
          We may clone this repository to read it. Nothing is written to it, and a token is used
          once and never stored.
        </span>
      </label>
      <button
        type="submit"
        disabled={!ready}
        className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <SpinnerIcon /> : <BranchIcon />}
        {busy ? 'Connecting' : 'Connect and read the code'}
      </button>
    </form>
  );
}

/** Step 3: the problems, evidence first, then one way forward. */
export function FindingsStep(p: FindingsStepProps) {
  const count = p.cards.length;
  return (
    <div>
      <StepHeader
        mark={<FindingsMark />}
        title={
          count === 0 ? 'No problems found' : `${count} problem${count === 1 ? '' : 's'} found`
        }
        subtitle={p.summary.short}
      />

      <motion.ol
        className="mt-8 space-y-4"
        initial="hidden"
        animate="shown"
        variants={{ shown: { transition: { staggerChildren: 0.08 } } }}
      >
        {p.cards.map((card) => (
          <li key={card.issue.id}>
            <IssueCard card={card} />
          </li>
        ))}
      </motion.ol>

      <section className="mt-8 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 text-center">
        <h3 className="text-[18px] font-semibold">Get fixes for these problems</h3>
        <p className="mx-auto mt-1 max-w-[480px] text-sm leading-relaxed text-[var(--muted)]">
          Connect the store's repository. We read the code behind each problem and suggest the
          change; you decide what to apply.
        </p>
        <AnimatePresence mode="wait" initial={false}>
          {p.connect === 'closed' ? (
            <motion.div key="button" exit={{ opacity: 0 }} className="mt-5">
              <button
                type="button"
                onClick={p.onOpenConnect}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90"
              >
                <BranchIcon />
                Connect GitHub
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <ConnectForm busy={p.connect === 'submitting'} onSubmit={p.onConnect} />
            </motion.div>
          )}
        </AnimatePresence>
        <button
          type="button"
          onClick={p.onDownload}
          className="mt-5 inline-flex items-center gap-1.5 text-sm text-[var(--muted)] underline-offset-4 hover:underline"
        >
          <DownloadIcon size={14} />
          Download the report
        </button>
      </section>
    </div>
  );
}
