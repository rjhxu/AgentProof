'use client';

import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ConnectRepositoryRequest } from '@agentproof/shared';

import { plainDetail, shortName, type ScanSummary } from '../format';
import { CartLines, SenseIcons, TreePanel, VerdictMark } from './agent-bits';
import type { ProblemData, ShopperResult } from './findings-data';
import { ArrowRightIcon, BranchIcon, DownloadIcon, SpinnerIcon } from './icons';
import { FindingsMark } from './illustrations';
import { StepHeader } from './step-header';
import {
  beatsFor,
  currentBeats,
  initialWalkthrough,
  isRecap,
  nextLabel,
  reduceWalkthrough,
  revealedAgents,
  type WalkEvent,
} from './walkthrough';

export type FindingsStepProps = {
  summary: ScanSummary;
  /** The thesis in one sentence, computed from the report, for the recap. */
  thesis: string;
  /** The problems, in the order they broke the purchase path. */
  cards: ProblemData[];
  /** Where the walkthrough opens; 'recap' is the demo shortcut behind ?step=3&t=end. */
  startAt?: 'start' | 'recap';
  connect: 'closed' | 'open' | 'submitting';
  onOpenConnect: () => void;
  onConnect: (request: ConnectRepositoryRequest) => void;
  onDownload: () => void;
};

const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]';
const PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90 disabled:opacity-50';
const ENTER = { opacity: 0, y: 8 };
const SHOWN = { opacity: 1, y: 0 };
const EXIT = { opacity: 0, y: -6, transition: { duration: 0.15 } };

/** One revealed beat: rises in under the one before it, fades when the reader steps back. */
function BeatBlock({ children }: { children: ReactNode }) {
  return (
    <motion.section
      initial={ENTER}
      animate={SHOWN}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="mt-6 border-t border-[var(--line)] pt-5"
    >
      {children}
    </motion.section>
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
      <div
        className={`mt-4 grid gap-4 ${card.excerpt ? 'grid-cols-[220px_minmax(0,1fr)]' : 'grid-cols-1'}`}
      >
        {card.screenshotUrl ? (
          <figure className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={card.screenshotUrl}
              alt={`The page as ${name} saw it at the failing step`}
              className="aspect-[16/10] w-full object-cover object-top"
            />
            <figcaption className="px-2 py-1 text-[11px] text-[var(--muted)]">
              {card.failingStep ? `step ${card.failingStep}, ` : ''}as {name} saw it
            </figcaption>
          </figure>
        ) : card.observedCart ? (
          <div className="max-w-[560px] rounded-md border border-[var(--line)] bg-[var(--panel)] p-3">
            <p className={LABEL}>read through the cart API</p>
            <CartLines cart={card.observedCart} failed />
          </div>
        ) : (
          <div className="flex aspect-[16/10] max-w-[220px] items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel)] text-[11px] text-[var(--muted)]">
            read through the API
          </div>
        )}
        {card.excerpt ? (
          <div className="min-w-0">
            <p className={LABEL}>what {name} read</p>
            <div className="mt-1 h-[160px] overflow-hidden rounded-md border border-[var(--fail)] bg-[var(--background)] ring-4 ring-[var(--fail-soft)]">
              <TreePanel text={card.excerpt} target={card.target} failed follow={false} />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** One shopper's result on the row. Laid out from the first shopper beat on; filled when its beat arrives. */
function ShopperChip({ shopper, revealed }: { shopper: ShopperResult; revealed: boolean }) {
  return (
    <li
      className={[
        'min-w-0 rounded-md border bg-[var(--background)] px-3 py-2 transition-colors duration-200',
        revealed ? 'border-[var(--line-strong)]' : 'border-[var(--line)] opacity-60',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5">
        {revealed ? (
          <motion.span
            className="flex"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
          >
            <VerdictMark status={shopper.status} />
          </motion.span>
        ) : (
          <VerdictMark status="queued" />
        )}
        <span className="truncate text-[13px] font-semibold">{shortName(shopper.name)}</span>
        <SenseIcons kind={shopper.kind} />
      </div>
      {revealed ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, delay: 0.05 }}
        >
          {shopper.benchmark ? (
            <p className="mt-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
              benchmark shopper
            </p>
          ) : null}
          <p className="mt-1.5 text-[13px] leading-snug">{shopper.line}</p>
          <p className="mt-1.5 text-[12px] tabular-nums text-[var(--muted)]">
            <span className="text-[var(--foreground)]">{shopper.cost}</span>
            {shopper.multiple
              ? ` · ${shopper.multiple}`
              : shopper.cost === '$0'
                ? ' · no model'
                : ''}
          </p>
          {shopper.attributedTo !== undefined ? (
            <p className="mt-1 text-[11px] text-[var(--muted)]">
              attributed to problem {shopper.attributedTo + 1}
            </p>
          ) : null}
        </motion.div>
      ) : null}
    </li>
  );
}

function Shoppers({ card, revealed }: { card: ProblemData; revealed: number }) {
  return (
    <>
      <h3 className={LABEL}>How each shopper did on &quot;{card.rowLabel}&quot;</h3>
      <ol
        className="mt-3 grid gap-3"
        style={{ gridTemplateColumns: `repeat(${card.shoppers.length}, minmax(0, 1fr))` }}
        aria-label="Shoppers"
      >
        {card.shoppers.map((s, i) => (
          <ShopperChip key={s.kind} shopper={s} revealed={i < revealed} />
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

function ProgressRow({
  count,
  current,
  reached,
  titles,
  locked,
  onGo,
}: {
  count: number;
  current: number;
  reached: number;
  titles: string[];
  locked: boolean;
  onGo: (problem: number) => void;
}) {
  const atRecap = current >= count;
  return (
    <div className="mt-8 flex items-center justify-center gap-4">
      <span className="text-[13px] text-[var(--muted)]">
        {atRecap ? 'Summary' : `Problem ${current + 1} of ${count}`}
      </span>
      <ol className="flex items-center gap-1.5" aria-label="Problems">
        {Array.from({ length: count + 1 }, (_, i) => {
          const isCurrent = i === current;
          const seen = i <= reached;
          const label = i < count ? `Problem ${i + 1}: ${titles[i] ?? ''}` : 'Summary';
          return (
            <li key={i}>
              <button
                type="button"
                aria-label={label}
                aria-current={isCurrent ? 'step' : undefined}
                disabled={!seen || locked}
                onClick={() => onGo(i)}
                className="flex h-6 w-6 items-center justify-center rounded-full disabled:cursor-default"
              >
                <span
                  className={[
                    'flex h-3 w-3 items-center justify-center rounded-full border transition-colors duration-200',
                    isCurrent
                      ? 'border-[var(--accent)]'
                      : seen
                        ? 'border-[var(--foreground)] bg-[var(--foreground)]'
                        : 'border-[var(--line-strong)]',
                  ].join(' ')}
                >
                  {isCurrent ? (
                    <motion.span
                      layoutId="findings-dot"
                      className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                    />
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
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
      <button type="submit" disabled={!ready} className={PRIMARY}>
        {busy ? <SpinnerIcon /> : <BranchIcon />}
        {busy ? 'Connecting' : 'Connect and read the code'}
      </button>
    </form>
  );
}

/** The one action of the step: connect the repository, or download the report instead. */
function ConnectPanel({
  connect,
  onOpenConnect,
  onConnect,
  onDownload,
}: Pick<FindingsStepProps, 'connect' | 'onOpenConnect' | 'onConnect' | 'onDownload'>) {
  return (
    <section className="mt-8 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6 text-center">
      <h3 className="text-[18px] font-semibold">Get fixes for these problems</h3>
      <p className="mx-auto mt-1 max-w-[480px] text-sm leading-relaxed text-[var(--muted)]">
        Connect the store&apos;s repository. We read the code behind each problem and suggest the
        change; you decide what to apply.
      </p>
      <AnimatePresence mode="wait" initial={false}>
        {connect === 'closed' ? (
          <motion.div key="button" exit={{ opacity: 0 }} className="mt-5">
            <button type="button" onClick={onOpenConnect} className={PRIMARY}>
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
            <ConnectForm busy={connect === 'submitting'} onSubmit={onConnect} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-5">
        <DownloadLink onClick={onDownload} />
      </div>
    </section>
  );
}

/** Every problem in one line each, the thesis, then the action. */
function Recap({
  cards,
  thesis,
  onOpen,
  ...connect
}: {
  cards: ProblemData[];
  thesis: string;
  onOpen: (problem: number) => void;
} & Pick<FindingsStepProps, 'connect' | 'onOpenConnect' | 'onConnect' | 'onDownload'>) {
  return (
    <motion.section
      initial={ENTER}
      animate={SHOWN}
      exit={EXIT}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      <motion.ol
        className="space-y-3"
        initial="hidden"
        animate="shown"
        variants={{ shown: { transition: { staggerChildren: 0.08 } } }}
        aria-label="Problems found"
      >
        {cards.map((card, i) => (
          <motion.li
            key={card.issue.id}
            variants={{ hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <button
              type="button"
              onClick={() => onOpen(i)}
              className="flex w-full items-start gap-3 rounded-lg border border-[var(--line)] bg-[var(--background)] p-4 text-left transition hover:border-[var(--line-strong)]"
            >
              <span className="mt-0.5">
                <VerdictMark status="failed" />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium leading-snug">
                  <span className="text-[var(--muted)]">{card.where} · </span>
                  {card.issue.title}
                </span>
                {card.cost ? (
                  <span className="mt-1 block text-[13px] leading-relaxed text-[var(--muted)]">
                    {card.cost}
                  </span>
                ) : null}
              </span>
            </button>
          </motion.li>
        ))}
      </motion.ol>
      <p className="mx-auto mt-6 max-w-[560px] text-center text-[16px] leading-relaxed text-[var(--muted)]">
        {thesis}
      </p>
      <ConnectPanel {...connect} />
    </motion.section>
  );
}

/**
 * Step 3: one problem at a time, told in beats on a click or a key. Where it broke, what we saw,
 * each shopper's result one by one, what it means, what to change. Then a recap and one action.
 */
export function FindingsStep(p: FindingsStepProps) {
  const count = p.cards.length;
  const [w, dispatch] = useReducer(reduceWalkthrough, undefined, () =>
    initialWalkthrough(p.cards.map(beatsFor), p.startAt ?? 'start'),
  );
  const recap = isRecap(w);
  const card = recap ? undefined : p.cards[w.pos.problem];
  const has = new Set(currentBeats(w).map((b) => b.kind));
  const revealed = revealedAgents(w);
  const label = nextLabel(w);
  const canBack = w.pos.problem > 0 || w.pos.beat > 0;
  // With the connect form open, nothing moves: the form must not disappear under a key press.
  const locked = p.connect !== 'closed';

  const lastEvent = useRef<WalkEvent['type'] | null>(null);
  const send = (e: WalkEvent) => {
    lastEvent.current = e.type;
    dispatch(e);
  };

  useEffect(() => {
    if (count === 0 || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      // A focused button already clicks on Enter and Space; only the arrows add to that.
      const onControl = Boolean(target?.closest('button, a'));
      const forward =
        e.key === 'ArrowRight' || (!onControl && (e.key === ' ' || e.key === 'Enter'));
      const backward = e.key === 'ArrowLeft' || e.key === 'Backspace';
      if (!forward && !backward) return;
      e.preventDefault();
      lastEvent.current = forward ? 'NEXT' : 'BACK';
      dispatch(forward ? { type: 'NEXT' } : { type: 'BACK' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, locked]);

  // After a press, keep the controls in view inside a problem; start a new problem or the recap at the top.
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const kind = lastEvent.current;
    lastEvent.current = null;
    if (!kind) return;
    const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
    if (!isRecap(w) && w.pos.beat > 0) {
      controlsRef.current?.scrollIntoView({ block: 'nearest', behavior });
    } else {
      stageRef.current?.scrollIntoView({ block: 'start', behavior });
    }
  }, [w, reduceMotion]);

  if (count === 0) {
    return (
      <div>
        <StepHeader mark={<FindingsMark />} title="No problems found" subtitle={p.summary.short} />
        <p className="mx-auto mt-8 max-w-[560px] text-center text-[16px] leading-relaxed text-[var(--muted)]">
          {p.thesis}
        </p>
        <div className="mt-6 text-center">
          <DownloadLink onClick={p.onDownload} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <StepHeader
        mark={<FindingsMark />}
        title={`${count} problem${count === 1 ? '' : 's'} found`}
        subtitle={p.summary.short}
      />
      <ProgressRow
        count={count}
        current={w.pos.problem}
        reached={w.reached.problem}
        titles={p.cards.map((c) => c.issue.title)}
        locked={locked}
        onGo={(problem) => send({ type: 'GO_TO_PROBLEM', problem })}
      />

      <div
        ref={stageRef}
        aria-live="polite"
        className="mt-6 scroll-mt-[calc(var(--stepper-h)+24px)]"
      >
        <AnimatePresence mode="wait" initial={false}>
          {card ? (
            <motion.article
              key={w.pos.problem}
              initial={ENTER}
              animate={SHOWN}
              exit={EXIT}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="rounded-lg border border-[var(--line)] bg-[var(--background)] p-6"
            >
              <Intro card={card} />
              <AnimatePresence initial={false}>
                {has.has('evidence') ? (
                  <BeatBlock key="evidence">
                    <Evidence card={card} />
                  </BeatBlock>
                ) : null}
                {has.has('agent') ? (
                  <BeatBlock key="shoppers">
                    <Shoppers card={card} revealed={revealed} />
                  </BeatBlock>
                ) : null}
                {has.has('meaning') ? (
                  <BeatBlock key="meaning">
                    <Meaning card={card} />
                  </BeatBlock>
                ) : null}
                {has.has('change') && card.recommendation ? (
                  <BeatBlock key="change">
                    <h3 className={LABEL}>What to change on the page</h3>
                    <p className="mt-2 text-[15px] leading-relaxed">{card.recommendation}</p>
                  </BeatBlock>
                ) : null}
              </AnimatePresence>

              <div
                ref={controlsRef}
                className="mt-6 flex scroll-mb-20 items-center justify-between gap-3 border-t border-[var(--line)] pt-4"
              >
                <button
                  type="button"
                  onClick={() => send({ type: 'BACK' })}
                  disabled={!canBack || locked}
                  className="text-sm text-[var(--muted)] underline-offset-4 hover:underline disabled:invisible"
                >
                  ‹ Back
                </button>
                <button
                  type="button"
                  onClick={() => send({ type: 'NEXT' })}
                  className={`${PRIMARY} min-w-[240px]`}
                >
                  {label}
                  <ArrowRightIcon />
                </button>
              </div>
            </motion.article>
          ) : (
            <Recap
              key="recap"
              cards={p.cards}
              thesis={p.thesis}
              onOpen={(problem) => send({ type: 'GO_TO_PROBLEM', problem })}
              connect={p.connect}
              onOpenConnect={p.onOpenConnect}
              onConnect={p.onConnect}
              onDownload={p.onDownload}
            />
          )}
        </AnimatePresence>
      </div>

      {!recap ? (
        <p className="mt-3 text-center text-[12px] text-[var(--muted)]">
          Press → or Space to continue
        </p>
      ) : null}
    </div>
  );
}
