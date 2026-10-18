'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { AgentKind, MissionReport } from '@agentproof/shared';

import { CheckpointMatrix } from '../components/checkpoint-matrix';
import { plainDetail, shortName, type ScanSummary } from '../format';
import { CartLines, SenseIcons, TreePanel, VerdictMark } from './agent-bits';
import type { ProblemData, RosterEntry, ShopperResult } from './findings-data';
import { ArrowRightIcon, DownloadIcon } from './icons';

export type FindingsStepProps = {
  summary: ScanSummary;
  /** The thesis in one sentence, computed from the report. */
  thesis: string;
  /** The problems, in the order they broke the purchase path. */
  cards: ProblemData[];
  /** One entry per shopper that ran, in stage order. */
  roster: RosterEntry[];
  /** The finished matrix, shown from "All checkpoints". */
  matrix?: MissionReport['matrix'];
  /** Column order for the matrix, in stage order. */
  agents: Array<{ kind: AgentKind; name: string }>;
  /** A shopper chip opens that shopper's scan review. */
  onReviewShopper: (kind: AgentKind) => void;
  onDownload: () => void;
  /**
   * Leave for Fixes. Only navigates: the connect form lives on that step. Omit it when there
   * is nothing to fix.
   */
  onGetFixes?: () => void;
  /** The repository is already connected and the fixes are ready: the button says "See the fixes". */
  fixesReady?: boolean;
};

type Selection = { kind: 'problem'; index: number } | { kind: 'matrix' };

const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]';
const PRIMARY =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3.5 text-sm font-medium text-[var(--accent-ink)] transition hover:opacity-90 disabled:opacity-50';

function findingsSubtitle(summary: ScanSummary, thesis: string): string {
  const count = `${summary.completed} of ${summary.total} shoppers completed the purchase.`;
  return thesis ? `${count} ${thesis}` : count;
}

function ShopperStrip({
  roster,
  onReview,
}: {
  roster: RosterEntry[];
  onReview: (kind: AgentKind) => void;
}) {
  return (
    <ol className="mt-3 flex flex-wrap justify-start gap-2" aria-label="Shoppers">
      {roster.map((shopper) => (
        <li key={shopper.kind}>
          <button
            type="button"
            onClick={() => onReview(shopper.kind)}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--background)] px-3 py-1.5 text-[13px] transition hover:border-[var(--line-strong)]"
          >
            <VerdictMark status={shopper.status} />
            <span className="font-semibold">{shortName(shopper.name)}</span>
            <span className="tabular-nums text-[var(--muted)]">
              {shopper.cost}
              {shopper.multiple ? (
                <span className="text-[var(--foreground)]"> {shopper.multiple}</span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function Intro({ card }: { card: ProblemData }) {
  return (
    <header>
      <h2 className="text-[22px] font-semibold leading-snug tracking-tight">{card.issue.title}</h2>
      <p className="mt-2 text-[14px] text-[var(--muted)]">
        Broke at <span className="font-medium text-[var(--foreground)]">{card.where}</span> ·{' '}
        {card.checkpointLabel}
      </p>
    </header>
  );
}

/** The failing shopper's evidence: the observed fact, its viewport (or the cart Gamma read back) and what it read. */
function Evidence({ card }: { card: ProblemData }) {
  const name = shortName(card.shoppers.find((s) => s.failing)?.name ?? 'the shopper');
  return (
    <>
      <h3 className={LABEL}>What we saw</h3>
      <p className="mt-2 text-[15px] leading-relaxed">{plainDetail(card.issue.observed)}</p>
      <div className="mt-3 flex flex-wrap items-start gap-4">
        {card.screenshotUrl ? (
          <a
            href={card.screenshotUrl}
            target="_blank"
            rel="noreferrer"
            className="block w-full max-w-[420px] shrink-0 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={card.screenshotUrl}
              alt={`The page as ${name} saw it at the failing step`}
              className="h-[320px] w-full object-cover object-top"
            />
            <span className="block px-2 py-1 text-[11px] text-[var(--muted)]">
              {card.failingStep ? `step ${card.failingStep}, ` : ''}as {name} saw it · full size
            </span>
          </a>
        ) : card.observedCart ? (
          <div className="w-full max-w-[420px] shrink-0 rounded-md border border-[var(--line)] bg-[var(--panel)] p-3">
            <p className={LABEL}>read through the cart API</p>
            <CartLines cart={card.observedCart} failed />
          </div>
        ) : (
          <div className="flex h-24 w-full max-w-[420px] shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-[11px] text-[var(--muted)]">
            read through the API
          </div>
        )}
        {card.excerpt ? (
          <div className="min-w-[240px] flex-1">
            <p className={LABEL}>what {name} read</p>
            <div className="mt-1 overflow-hidden rounded-md border border-[var(--fail)] bg-[var(--background)] ring-4 ring-[var(--fail-soft)]">
              <TreePanel text={card.excerpt} target={card.target} failed follow={false} wrap />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function ShopperRow({
  shopper,
  onSeeProblem,
}: {
  shopper: ShopperResult;
  onSeeProblem: (index: number) => void;
}) {
  const other = shopper.attributedTo;
  return (
    <li className="flex items-start gap-2 border-b border-[var(--line)] py-2.5 last:border-b-0">
      <span className="mt-0.5">
        <VerdictMark status={shopper.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold">{shortName(shopper.name)}</span>
            <SenseIcons kind={shopper.kind} />
            {shopper.benchmark ? (
              <span className="shrink-0 rounded bg-[var(--panel-2)] px-1 py-px text-[9px] font-medium uppercase tracking-wide text-[var(--muted)]">
                benchmark
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-[var(--muted)]">
            <span className="text-[var(--foreground)]">{shopper.cost}</span>
            {shopper.multiple
              ? ` · ${shopper.multiple}`
              : shopper.cost === '$0'
                ? ' · no model'
                : ''}
          </span>
        </div>
        <p className="mt-0.5 text-[13px] leading-snug">{shopper.line}</p>
        {other !== undefined ? (
          <button
            type="button"
            onClick={() => onSeeProblem(other)}
            className="mt-1 text-[12px] text-[var(--accent)] underline-offset-4 hover:underline"
          >
            see problem {other + 1}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function Shoppers({
  card,
  onSeeProblem,
}: {
  card: ProblemData;
  onSeeProblem: (index: number) => void;
}) {
  return (
    <>
      <h3 className={LABEL}>How each shopper did</h3>
      <ol className="mt-1" aria-label="Shoppers">
        {card.shoppers.map((shopper) => (
          <ShopperRow key={shopper.kind} shopper={shopper} onSeeProblem={onSeeProblem} />
        ))}
      </ol>
    </>
  );
}

function Meaning({ card }: { card: ProblemData }) {
  return (
    <>
      <h3 className={LABEL}>What it means</h3>
      {card.attribution ? (
        <p className="mt-2 text-[15px] leading-relaxed">{card.attribution.reason}</p>
      ) : null}
      {card.cost ? (
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--muted)]">{card.cost}</p>
      ) : null}
    </>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <section className="mt-5 border-t border-[var(--line)] pt-4">{children}</section>;
}

function DownloadLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-sm text-[var(--muted)] underline-offset-4 hover:underline"
    >
      <DownloadIcon size={14} />
      Download the report
    </button>
  );
}

/** Leave for Fixes. The button only navigates; connecting happens on that step. */
function GetFixes({ onGetFixes, fixesReady }: { onGetFixes: () => void; fixesReady?: boolean }) {
  return (
    <button type="button" onClick={onGetFixes} className={PRIMARY}>
      {fixesReady ? 'See the fixes' : 'Get fixes'}
      <ArrowRightIcon />
    </button>
  );
}

function ProblemDetail({
  card,
  index,
  count,
  onSelect,
}: {
  card: ProblemData;
  index: number;
  count: number;
  onSelect: (index: number) => void;
}) {
  return (
    <article>
      <Intro card={card} />
      <Section>
        <Evidence card={card} />
      </Section>
      <Section>
        <Shoppers card={card} onSeeProblem={onSelect} />
      </Section>
      {card.attribution || card.cost ? (
        <Section>
          <Meaning card={card} />
        </Section>
      ) : null}
      {card.recommendation ? (
        <Section>
          <h3 className={LABEL}>What to change on the page</h3>
          <p className="mt-2 text-[15px] leading-relaxed">{card.recommendation}</p>
        </Section>
      ) : null}
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
        <button
          type="button"
          onClick={() => onSelect(index - 1)}
          disabled={index <= 0}
          className="inline-flex items-center gap-1 text-sm text-[var(--muted)] underline-offset-4 hover:underline disabled:invisible"
        >
          <ArrowRightIcon size={14} className="rotate-180" />
          Previous
        </button>
        <button
          type="button"
          onClick={() => onSelect(index + 1)}
          disabled={index >= count - 1}
          className="inline-flex items-center gap-1 text-sm font-medium text-[var(--foreground)] underline-offset-4 hover:underline disabled:invisible"
        >
          Next problem
          <ArrowRightIcon size={14} />
        </button>
      </div>
    </article>
  );
}

function FindingsHeader({
  title,
  subtitle,
  onGetFixes,
  fixesReady,
  onDownload,
}: {
  title: string;
  subtitle: string;
  onGetFixes?: () => void;
  fixesReady?: boolean;
  onDownload: () => void;
}) {
  return (
    <header className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{title}</h1>
        <p className="mt-1 text-[14px] leading-snug text-[var(--muted)]">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {onGetFixes ? <GetFixes onGetFixes={onGetFixes} fixesReady={fixesReady} /> : null}
        <DownloadLink onClick={onDownload} />
      </div>
    </header>
  );
}

const TAB = 'border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap transition';

function tabClass(selected: boolean): string {
  return [
    TAB,
    selected
      ? 'border-[var(--accent)] bg-[var(--background)] text-[var(--foreground)]'
      : 'border-transparent text-[var(--muted)] hover:text-[var(--foreground)]',
  ].join(' ');
}

/**
 * Step 3: every problem at once. A compact header, shoppers on the left, and short tabs on the
 * top edge of the full-width detail. "Get fixes" only leaves for the Fixes step.
 */
export function FindingsStep(p: FindingsStepProps) {
  const count = p.cards.length;
  const [selection, setSelection] = useState<Selection>({ kind: 'problem', index: 0 });
  const index =
    selection.kind === 'problem' ? Math.min(selection.index, Math.max(0, count - 1)) : -1;
  const card = index >= 0 ? p.cards[index] : undefined;

  const selectProblem = (next: number) => {
    if (next < 0 || next >= count) return;
    setSelection({ kind: 'problem', index: next });
  };

  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      if (!forward && !backward) return;
      e.preventDefault();
      setSelection((current) => {
        if (current.kind === 'matrix') {
          return backward ? { kind: 'problem', index: count - 1 } : current;
        }
        const next = current.index + (forward ? 1 : -1);
        if (next < 0 || next >= count) return current;
        return { kind: 'problem', index: next };
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count]);

  const subtitle = findingsSubtitle(p.summary, p.thesis);

  if (count === 0) {
    return (
      <div>
        <FindingsHeader title="No problems found" subtitle={subtitle} onDownload={p.onDownload} />
        <ShopperStrip roster={p.roster} onReview={p.onReviewShopper} />
        {p.matrix ? (
          <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--background)] p-5">
            <CheckpointMatrix matrix={p.matrix} agents={p.agents} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <FindingsHeader
        title={`${count} problem${count === 1 ? '' : 's'} found`}
        subtitle={subtitle}
        onGetFixes={p.onGetFixes}
        fixesReady={p.fixesReady}
        onDownload={p.onDownload}
      />
      <ShopperStrip roster={p.roster} onReview={p.onReviewShopper} />

      <div className="mt-4 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--background)]">
        <div
          role="tablist"
          aria-label="Problems"
          className="flex items-end border-b border-[var(--line)] bg-[var(--panel)]"
        >
          {p.cards.map((problem, i) => (
            <button
              key={problem.issue.id}
              type="button"
              role="tab"
              aria-selected={index === i}
              onClick={() => selectProblem(i)}
              className={tabClass(index === i)}
            >
              {i + 1} · {problem.where}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={selection.kind === 'matrix'}
            onClick={() => setSelection({ kind: 'matrix' })}
            className={`${tabClass(selection.kind === 'matrix')} ml-auto`}
          >
            All checkpoints
          </button>
        </div>
        <div className="p-5">
          <AnimatePresence mode="wait" initial={false}>
            {card ? (
              <motion.div
                key={card.issue.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22 }}
              >
                <ProblemDetail card={card} index={index} count={count} onSelect={selectProblem} />
              </motion.div>
            ) : p.matrix ? (
              <motion.div
                key="matrix"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22 }}
              >
                <h2 className="text-[18px] font-semibold">All checkpoints</h2>
                <div className="mt-4">
                  <CheckpointMatrix matrix={p.matrix} agents={p.agents} />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
