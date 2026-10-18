'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CHECKPOINT_LABELS, CHECKPOINT_ORDER } from '@agentproof/shared';
import type {
  AgentKind,
  Checkpoint,
  CheckpointId,
  FailurePoint,
  Mission,
  MissionReport,
  ObservedCart,
  RunStep,
} from '@agentproof/shared';

import { CheckpointMatrix } from '../components/checkpoint-matrix';
import { StatusBadge } from '../components/status-badge';
import {
  clickPoint,
  describeMission,
  formatUsd,
  plainAction,
  senses,
  shortModel,
  shortName,
  STAGE_LABELS,
  STAGES,
  stepReason,
  targetLine,
  type ScanSummary,
  type Sense,
  type Stage as PathStage,
} from '../format';
import { isTerminal, type LaneState } from '../replay/reduce';
import {
  ArrowRightIcon,
  BracesIcon,
  CheckIcon,
  CrossIcon,
  EyeIcon,
  SparkIcon,
  TextLinesIcon,
} from './icons';
import { ScanMark } from './illustrations';
import {
  costScale,
  laneAtReview,
  nextLane,
  reviewLabel,
  reviewLength,
  stageLane,
  type StepArtifact,
} from './stage';

export type ScanStepProps = {
  mission: Mission;
  /** In stage order: the agents take the stage in this order and sit in the roster in it. */
  lanes: LaneState[];
  phase: 'running' | 'done';
  summary?: ScanSummary;
  /** The thesis in one sentence, computed from the report, for the closing. */
  thesis?: string;
  /** The finished matrix, for the collapsed "all checkpoints" table. */
  matrix?: MissionReport['matrix'];
  /** The report's cost table, for the multiples on the roster once the scan is done. */
  costComparison?: MissionReport['costComparison'];
  /** Artifact path -> text of the accessibility-tree snapshot an agent read at a step. */
  snapshots: Record<string, string>;
  /** Run id -> where the run diverged, from its report; shown once a lane has failed. */
  failurePoints: Record<string, FailurePoint>;
  /** Run id -> the cart the verifier observed, for the data check's stage. */
  observedCarts: Record<string, ObservedCart>;
  /** Run id -> where each step's frame and snapshot live, for walking back through a run. */
  stepArtifacts: Record<string, StepArtifact[]>;
  resolveArtifactUrl: (path: string | undefined) => string | undefined;
  onContinue: () => void;
};

const DESCRIPTOR: Record<AgentKind, string> = {
  alpha_semantic: 'reads the page as text, like a screen reader',
  beta_vision: 'looks at screenshots and clicks what it sees',
  sigma_hybrid: 'reads and looks, on the strongest model',
  gamma_structured: 'checks the catalog feed against the cart API',
};

/** The shopper that stands for a careful human: every sense, the strongest model, the price. */
const BENCHMARK_KIND: AgentKind = 'sigma_hybrid';

/** What Gamma does, in one line, always visible on its stage. */
const GAMMA_WHAT =
  'Reads the product data your store publishes and tries the cart API with it, the way integrations and AI shoppers do. No browser, no model.';

/** Why a failed data check matters, in plain words. Code-written copy keyed by the checkpoint. */
const GAMMA_WHY: Partial<Record<CheckpointId, string>> = {
  catalog_variant_resolves:
    'The id your catalog publishes for this variant lands in the cart as a different product. Anything shopping from your product data gets the wrong item, unseen.',
  cart_matches_variant:
    'The cart holds a different variant from the one requested by id. Anything shopping from your product data gets the wrong item.',
  catalog_price_matches_page:
    'The price in your product data differs from the page. Anything shopping from the data sees the wrong price.',
};

const GAMMA_ONLY: CheckpointId[] = ['catalog_variant_resolves', 'catalog_price_matches_page'];

/** Which checkpoints a lane is expected to report, so ticks can sit hollow until they arrive. */
function expectedCheckpoints(browses: boolean): CheckpointId[] {
  return browses
    ? CHECKPOINT_ORDER.filter((id) => !GAMMA_ONLY.includes(id))
    : CHECKPOINT_ORDER.filter((id) => id !== 'catalog_price_matches_page');
}

function Tick({ id, status }: { id: CheckpointId; status?: string }) {
  const label = CHECKPOINT_LABELS[id];
  const base = 'flex h-4 w-4 items-center justify-center rounded-full border';
  if (!status) {
    return <span title={`${label}: pending`} className={`${base} border-[var(--line-strong)]`} />;
  }
  const passed = status === 'passed';
  const failed = status === 'failed';
  return (
    <motion.span
      title={`${label}: ${status.replace(/_/g, ' ')}`}
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 28 }}
      className={[
        base,
        passed
          ? 'border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]'
          : failed
            ? 'border-[var(--fail)] bg-[var(--fail)] text-white'
            : 'border-[var(--line-strong)] text-[var(--muted)]',
      ].join(' ')}
    >
      {passed ? <CheckIcon size={10} /> : failed ? <CrossIcon size={10} /> : '–'}
    </motion.span>
  );
}

/** The purchase path for a shopper; the two data stages for the catalog check. */
function Track({ stage, browses }: { stage: PathStage; browses: boolean }) {
  const stages: PathStage[] = browses ? [...STAGES] : ['find', 'cart'];
  const labels: Record<PathStage, string> = browses
    ? STAGE_LABELS
    : { find: 'Catalog feed', variant: '', cart: 'Cart API', review: '' };
  const index = Math.max(0, stages.indexOf(stage));
  const pct = stages.length > 1 ? (index / (stages.length - 1)) * 100 : 0;
  return (
    <div className="relative mt-3">
      <div className="h-px w-full bg-[var(--line)]" />
      <motion.div
        className="absolute top-0 h-px bg-[var(--accent)]"
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      />
      <motion.span
        className="absolute -top-[5px] h-[11px] w-[11px] -translate-x-1/2 rounded-full border-2 border-[var(--accent)] bg-[var(--background)]"
        initial={false}
        animate={{ left: `${pct}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      />
      <ol className="mt-2 flex justify-between text-[11px] text-[var(--muted)]">
        {stages.map((s, i) => (
          <li key={s} className={i <= index ? 'text-[var(--foreground)]' : undefined}>
            {labels[s]}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What an agent perceives, as three small marks: lit when it has that sense. */
function SenseIcons({ kind, size = 12 }: { kind: AgentKind; size?: number }) {
  const has = senses(kind);
  if (has.includes('api')) {
    return (
      <span title={DESCRIPTOR[kind]} className="text-[var(--muted)]">
        <BracesIcon size={size} />
      </span>
    );
  }
  const all: Array<{ sense: Sense; icon: ReactNode; label: string }> = [
    { sense: 'reads', icon: <TextLinesIcon size={size} />, label: 'reads the page as text' },
    { sense: 'looks', icon: <EyeIcon size={size} />, label: 'looks at screenshots' },
    { sense: 'strongest', icon: <SparkIcon size={size} />, label: 'strongest model' },
  ];
  return (
    <span className="inline-flex items-center gap-1" aria-label={DESCRIPTOR[kind]}>
      {all.map(({ sense, icon, label }) => (
        <span
          key={sense}
          title={label}
          className={has.includes(sense) ? 'text-[var(--foreground)]' : 'text-[var(--line)]'}
        >
          {icon}
        </span>
      ))}
    </span>
  );
}

function VerdictMark({ lane, active }: { lane: LaneState; active: boolean }) {
  const base = 'flex h-4 w-4 shrink-0 items-center justify-center rounded-full';
  if (lane.status === 'passed') {
    return (
      <span className={`${base} bg-[var(--foreground)] text-[var(--background)]`}>
        <CheckIcon size={10} />
      </span>
    );
  }
  if (lane.status === 'failed' || lane.status === 'error' || lane.status === 'cancelled') {
    return (
      <span className={`${base} bg-[var(--fail)] text-white`}>
        <CrossIcon size={10} />
      </span>
    );
  }
  if (active || lane.status === 'running' || lane.status === 'verifying') {
    return (
      <span className={`${base} border border-[var(--accent)]`}>
        <motion.span
          className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      </span>
    );
  }
  return <span className={`${base} border border-[var(--line-strong)]`} />;
}

type RosterRole = 'done' | 'active' | 'next' | 'waiting';

function statusWord(lane: LaneState, role: RosterRole): string {
  const browses = lane.agent.kind !== 'gamma_structured';
  if (!browses) {
    if (lane.status === 'passed') return 'no problem found';
    if (lane.status === 'failed') return 'found a problem';
    if (lane.status === 'queued') return role === 'next' ? 'up next' : 'waiting';
    if (isTerminal(lane.status)) return 'stopped';
    return 'checking the catalog';
  }
  if (lane.status === 'passed') return 'completed the purchase';
  if (lane.status === 'failed') return 'did not complete it';
  if (lane.status === 'error' || lane.status === 'cancelled') return 'stopped';
  if (lane.status === 'verifying') return 'checking the cart';
  if (lane.status === 'running') return 'shopping now';
  return role === 'next' ? 'up next' : 'waiting';
}

type FinalCost = { costUsd: number; multiple?: string };

function RosterChip({
  lane,
  role,
  scale,
  final,
  selected = false,
  onSelect,
}: {
  lane: LaneState;
  role: RosterRole;
  /** The most expensive agent so far; every cost bar is drawn against it. */
  scale: number;
  /** From the report once the scan is done: the exact cost and "22× Alpha". */
  final?: FinalCost;
  /** This agent is the one under review. */
  selected?: boolean;
  /** Once the scan is done, a chip opens that agent's review. */
  onSelect?: () => void;
}) {
  const browses = lane.agent.kind !== 'gamma_structured';
  const cost = final?.costUsd ?? lane.costUsd;
  const pct = scale > 0 && cost > 0 ? Math.max(3, (cost / scale) * 100) : 0;
  return (
    <li
      className={[
        'relative min-w-0 flex-1 rounded-md border bg-[var(--background)] px-3 py-2',
        role === 'active' || selected ? 'border-[var(--accent)]' : 'border-[var(--line)]',
        role === 'waiting' ? 'opacity-60' : '',
        onSelect && !selected ? 'hover:border-[var(--line-strong)]' : '',
      ].join(' ')}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Look back at ${shortName(lane.agent.name)}`}
          title={`Look back at ${shortName(lane.agent.name)}`}
          className="absolute inset-0 z-10 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      ) : null}
      {role === 'active' ? (
        <motion.span
          className="pointer-events-none absolute -inset-px rounded-md border border-[var(--accent)]"
          animate={{ opacity: [0.6, 0], scale: [1, 1.04] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
        />
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <VerdictMark lane={lane} active={role === 'active'} />
          <span className="truncate text-[13px] font-semibold">{shortName(lane.agent.name)}</span>
          <SenseIcons kind={lane.agent.kind} />
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted)]">
          {browses ? formatUsd(cost) : '$0'}
          {final?.multiple ? (
            <span className="text-[var(--foreground)]"> · {final.multiple}</span>
          ) : null}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-[var(--muted)]">
        {lane.agent.kind === BENCHMARK_KIND ? (
          <span className="text-[var(--foreground)]">benchmark shopper · </span>
        ) : !browses ? (
          <span className="text-[var(--foreground)]">catalog check · </span>
        ) : null}
        {statusWord(lane, role)}
      </p>
      <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded bg-[var(--panel-2)]">
        <motion.div
          className="h-full bg-[var(--foreground)]"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        />
      </div>
    </li>
  );
}

/** The accessibility tree as the agent read it, the line it aimed at marked. */
function TreePanel({
  text,
  target,
  failed,
}: {
  text: string | undefined;
  target: string | undefined;
  failed: boolean;
}) {
  const lines = text ? text.split('\n') : [];
  const hit = targetLine(lines, target);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center' });
  }, [hit, text]);
  if (!text) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-[var(--muted)]">
        reading the page
      </div>
    );
  }
  return (
    <pre className="thin-scroll h-full overflow-auto p-3 font-mono text-[11px] leading-[1.5] text-[var(--foreground)]">
      {lines.map((line, i) => (
        <span
          key={i}
          ref={i === hit ? ref : undefined}
          className={[
            '-mx-1 block rounded-sm px-1',
            i === hit
              ? failed
                ? 'bg-[var(--fail-soft)] outline outline-1 outline-[var(--fail)]'
                : 'bg-[var(--accent-soft)]'
              : '',
          ].join(' ')}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

/** The screenshot as the agent saw it, with a ring where it clicked by coordinates. */
function ShotPanel({
  url,
  target,
  running,
}: {
  url: string | undefined;
  target: string | undefined;
  running: boolean;
}) {
  const point = clickPoint(target);
  return (
    <div className="relative h-full w-full">
      <AnimatePresence mode="popLayout" initial={false}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <motion.img
            key={url}
            src={url}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <motion.div
            key="empty"
            exit={{ opacity: 0 }}
            className={`absolute inset-0 ${running ? 'shimmer' : ''}`}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {point ? (
          <motion.span
            key={target}
            className="pointer-events-none absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-[var(--accent)] bg-[var(--accent-soft)]/60"
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            initial={{ scale: 1.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 22 }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function frameClass(failed: boolean): string {
  return [
    'stage-box relative overflow-hidden rounded-md border bg-[var(--panel)]',
    failed ? 'border-[var(--fail)] ring-4 ring-[var(--fail-soft)]' : 'border-[var(--line)]',
  ].join(' ');
}

/** The store as a shopper sees it: text, pixels, or both. */
function PerceptionPanel({
  kind,
  shotUrl,
  snapshot,
  target,
  failed,
  running,
}: {
  kind: AgentKind;
  shotUrl: string | undefined;
  snapshot: string | undefined;
  target: string | undefined;
  failed: boolean;
  running: boolean;
}) {
  const has = senses(kind);
  const reads = has.includes('reads');
  const looks = has.includes('looks');
  const frame = frameClass(failed);
  if (reads && looks) {
    return (
      <div className={`${frame} grid grid-cols-[3fr_2fr]`}>
        <div className="relative min-w-0 overflow-hidden">
          <ShotPanel url={shotUrl} target={target} running={running} />
        </div>
        <div className="h-full min-h-0 min-w-0 overflow-hidden border-l border-[var(--line)] bg-[var(--background)]">
          <TreePanel text={snapshot} target={target} failed={failed} />
        </div>
      </div>
    );
  }
  if (reads) {
    return (
      <div className={`${frame} bg-[var(--background)]`}>
        <TreePanel text={snapshot} target={target} failed={failed} />
      </div>
    );
  }
  return (
    <div className={frame}>
      <ShotPanel url={shotUrl} target={target} running={running} />
    </div>
  );
}

/** A value that follows `value` after a delay, so a second beat lands after the first. */
function useDelayedValue<T>(value: T, delayMs: number): T {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    if (Object.is(delayed, value)) return;
    const id = setTimeout(() => setDelayed(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs, delayed]);
  return delayed;
}

/** The recorded detail without its JSON parentheticals: "Requested HOODIE-001-M; cart returned HOODIE-001-S." */
function plainDetail(detail: string | undefined): string | undefined {
  return detail?.replace(/\s*\(\{[^)]*\}\)/g, '');
}

function Beat({
  status,
  text,
  placeholder,
}: {
  status: string;
  text?: string;
  placeholder: string;
}) {
  const resolved = status === 'passed' || status === 'failed';
  return (
    <motion.div
      key={resolved ? 'resolved' : 'pending'}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="flex min-w-0 items-start gap-2"
    >
      {status === 'failed' ? (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--fail)] text-white">
          <CrossIcon size={10} />
        </span>
      ) : status === 'passed' ? (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)]">
          <CheckIcon size={10} />
        </span>
      ) : (
        <span
          className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border border-[var(--line-strong)] ${status === 'running' ? 'animate-pulse' : ''}`}
        />
      )}
      <span className={`min-w-0 leading-snug ${resolved ? '' : 'text-[var(--muted)]'}`}>
        {resolved ? text : placeholder}
      </span>
    </motion.div>
  );
}

/** The cart the verifier read back through the API, line by line. */
function CartLines({ cart, failed }: { cart: ObservedCart; failed: boolean }) {
  return (
    <ul className="mt-2 space-y-1 font-mono text-[11px] leading-snug">
      {cart.items.map((item) => (
        <li key={item.variantId} className="flex flex-wrap gap-x-2">
          <span className={failed ? 'font-semibold text-[var(--fail)]' : 'font-semibold'}>
            {item.variantId}
          </span>
          <span className="text-[var(--muted)]">
            {item.quantity} × {item.name},{' '}
            {Object.entries(item.attributes)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}
            , ${item.unitPrice.toFixed(2)}
          </span>
        </li>
      ))}
      {cart.items.length === 0 ? <li className="text-[var(--muted)]">empty cart</li> : null}
    </ul>
  );
}

/**
 * The store as Gamma sees it: the catalog feed and the cart API, played as two beats from the
 * recorded checkpoints, catalog then cart a moment later, with the cart it read back.
 */
function DataPanel({
  lane,
  mission,
  observedCart,
  failed,
}: {
  lane: LaneState;
  mission: Mission;
  observedCart?: ObservedCart;
  failed: boolean;
}) {
  const byId = new Map(lane.checkpoints.map((c) => [c.id, c] as const));
  const catalog = byId.get('product_discovered') ?? byId.get('correct_size_identified');
  const cart = byId.get('catalog_variant_resolves') ?? byId.get('cart_matches_variant');
  const running = lane.status === 'running' || lane.status === 'verifying';
  const pendingWord = running ? 'running' : 'pending';
  const catalogStatus = catalog?.status ?? pendingWord;
  // The cart beat lands a moment after the catalog beat, even though the runner sends both at once.
  const cartStatus = useDelayedValue(cart?.status ?? pendingWord, 500);
  const cartResolved = cartStatus === 'passed' || cartStatus === 'failed';
  return (
    <div
      className={`${frameClass(failed)} flex flex-col gap-4 bg-[var(--background)] p-4 text-[13px]`}
    >
      <section>
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
          Catalog feed · JSON
        </p>
        <div className="mt-1.5">
          <Beat
            status={catalogStatus}
            text={catalog?.detail}
            placeholder={`asking the catalog for ${describeMission(mission)}`}
          />
        </div>
      </section>
      <section>
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
          Cart API · JSON
        </p>
        <div className="mt-1.5">
          <Beat
            status={cartStatus}
            text={plainDetail(cart?.detail)}
            placeholder="putting that variant id in a cart and reading the cart back"
          />
          {cartResolved && observedCart ? (
            <CartLines cart={observedCart} failed={cartStatus === 'failed'} />
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** The checkpoint a failed lane is captioned with: Gamma's cart beat first, else the first failure. */
function captionCheckpoint(lane: LaneState, browses: boolean): Checkpoint | undefined {
  if (!browses) {
    const cart = lane.checkpoints.find(
      (c) => c.id === 'catalog_variant_resolves' && c.status === 'failed',
    );
    if (cart) return cart;
  }
  return lane.checkpoints.find((c) => c.status === 'failed');
}

function Stage({
  lane,
  mission,
  snapshots,
  failurePoint,
  observedCart,
  resolveArtifactUrl,
  review = false,
}: {
  lane: LaneState;
  mission: Mission;
  snapshots: Record<string, string>;
  failurePoint?: FailurePoint;
  observedCart?: ObservedCart;
  resolveArtifactUrl: ScanStepProps['resolveArtifactUrl'];
  /** Looking back after the scan: the lane is rebuilt at a step, so no live status chip. */
  review?: boolean;
}) {
  const browses = lane.agent.kind !== 'gamma_structured';
  const terminal = isTerminal(lane.status);
  const failed = lane.status === 'failed';
  const lastStep: RunStep | undefined = lane.steps[lane.steps.length - 1];
  // Live, the latest step; after a failure, where the report says the run diverged.
  const frozen = failed && failurePoint ? failurePoint : undefined;
  const shownStep = frozen
    ? (lane.steps.find((s) => s.index === frozen.stepIndex) ?? lastStep)
    : lastStep;
  const shotUrl = resolveArtifactUrl(frozen?.screenshotPath ?? lane.latestScreenshotPath);
  const snapshotPath = frozen?.snapshotPath ?? lane.latestSnapshotPath;
  const snapshot = snapshotPath ? snapshots[snapshotPath] : undefined;
  const target =
    shownStep?.action && 'target' in shownStep.action ? shownStep.action.target : undefined;
  const reason = browses ? stepReason(shownStep) : undefined;
  const caption = failed ? captionCheckpoint(lane, browses) : undefined;
  const why = !browses && caption ? GAMMA_WHY[caption.id] : undefined;
  const byId = new Map(lane.checkpoints.map((c) => [c.id, c.status] as const));
  const expected = expectedCheckpoints(browses);

  const action = browses
    ? terminal
      ? lane.status === 'passed'
        ? 'Completed the purchase path'
        : lane.status === 'failed'
          ? 'Did not complete the purchase path'
          : 'Stopped'
      : lane.status === 'verifying'
        ? 'Checking the cart'
        : lastStep
          ? plainAction(lastStep)
          : 'Opening the store'
    : lane.status === 'passed'
      ? 'The product data checks out'
      : lane.status === 'failed'
        ? 'Found a problem in the product data'
        : terminal
          ? 'Stopped'
          : lane.status === 'verifying'
            ? 'Trying the cart API'
            : 'Reading the catalog feed';

  return (
    <div className="stage-grid grid h-full min-h-0 grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-h-0 min-w-0 items-start">
        {browses ? (
          <PerceptionPanel
            kind={lane.agent.kind}
            shotUrl={shotUrl}
            snapshot={snapshot}
            target={target}
            failed={failed}
            running={lane.status === 'running'}
          />
        ) : (
          <DataPanel lane={lane} mission={mission} observedCart={observedCart} failed={failed} />
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-[17px] font-semibold">{shortName(lane.agent.name)}</h2>
          <SenseIcons kind={lane.agent.kind} size={13} />
          <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
            {lane.agent.kind === BENCHMARK_KIND ? 'benchmark shopper · ' : ''}
            {!browses ? 'catalog check · ' : ''}
            {shortModel(lane.agent.model)}
          </span>
        </div>
        <p className="scan-descriptor mt-0.5 text-[13px] text-[var(--muted)]">
          {DESCRIPTOR[lane.agent.kind]}
        </p>
        {!browses ? (
          <p className="scan-descriptor mt-1 text-[12px] leading-snug text-[var(--muted)]">
            {GAMMA_WHAT}
          </p>
        ) : null}

        {/* Keyed so each new action rises in; no exit, so two lines never overlap mid-fade. */}
        <motion.p
          key={`${lane.status}-${shownStep?.index ?? -1}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="scan-action mt-4 text-[20px] font-medium leading-snug"
        >
          {action}
        </motion.p>
        {reason && !terminal ? (
          <p className="scan-reason mt-1.5 line-clamp-3 text-[12px] leading-snug text-[var(--muted)]">
            <span className="mr-1 rounded bg-[var(--panel-2)] px-1 py-px text-[10px] uppercase tracking-wide">
              its reason
            </span>
            {reason}
          </p>
        ) : null}

        {caption ? (
          <div className="mt-3 rounded-md border border-[var(--fail)] bg-[var(--fail-soft)] px-3 py-2 text-[13px] leading-snug">
            <span className="mr-1.5 inline-flex align-middle text-[var(--fail)]">
              <CrossIcon size={12} />
            </span>
            <span className="font-medium">{CHECKPOINT_LABELS[caption.id]}.</span>{' '}
            {plainDetail(caption.detail)}
          </div>
        ) : null}
        {why ? (
          <p className="mt-2 text-[12px] leading-snug text-[var(--muted)]">
            <span className="font-medium text-[var(--foreground)]">Why it matters.</span> {why}
          </p>
        ) : null}
        {lane.status === 'passed' ? (
          <div className="mt-3 flex items-center gap-1.5 text-[13px]">
            <CheckIcon size={12} />
            {browses
              ? 'Every checkpoint passed, up to checkout review.'
              : 'The catalog and the cart agree on every check.'}
          </div>
        ) : null}

        <div className="mt-auto pt-4">
          <Track stage={lane.stage} browses={browses} />
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[12px] tabular-nums text-[var(--muted)]">
              {browses ? (
                <>
                  {lane.steps.length} step{lane.steps.length === 1 ? '' : 's'} ·{' '}
                  <span className="text-[var(--foreground)]">{formatUsd(lane.costUsd)}</span> so far
                </>
              ) : (
                <>
                  no model · <span className="text-[var(--foreground)]">$0</span>
                </>
              )}
            </span>
            <div className="flex items-center gap-1.5" aria-label="Checkpoints">
              {expected.map((id) => (
                <Tick key={id} id={id} status={byId.get(id)} />
              ))}
            </div>
          </div>
          {review ? null : (
            <div className="scan-status mt-3">
              <StatusBadge status={lane.status} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Above the stage while looking back: who, which step, and a scrubber through the process. */
function ReviewBar({
  lane,
  position,
  onPosition,
  onClose,
}: {
  lane: LaneState;
  position: number;
  onPosition: (position: number) => void;
  onClose: () => void;
}) {
  const length = reviewLength(lane);
  const last = length - 1;
  const browses = lane.agent.kind !== 'gamma_structured';
  const step = browses && position < last ? lane.steps[position] : undefined;
  const label = reviewLabel(lane, position);
  const arrow =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--line)] text-[var(--foreground)] transition hover:border-[var(--line-strong)] disabled:opacity-30 disabled:hover:border-[var(--line)]';
  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[13px]">
      <button
        type="button"
        className={arrow}
        disabled={position <= 0}
        onClick={() => onPosition(position - 1)}
        aria-label="Previous step"
      >
        <ArrowRightIcon size={14} className="rotate-180" />
      </button>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{shortName(lane.agent.name)}</span>
        <span className="text-[var(--muted)]"> · {label}</span>
        {step ? <span> · {plainAction(step)}</span> : null}
      </span>
      <ol className="flex shrink-0 items-center gap-1.5" aria-label="Positions">
        {Array.from({ length }, (_, i) => {
          const verdict = i === last;
          const failed = lane.status !== 'passed';
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => onPosition(i)}
                aria-label={reviewLabel(lane, i)}
                aria-current={i === position ? 'step' : undefined}
                title={reviewLabel(lane, i)}
                className={[
                  'block rounded-full transition',
                  verdict ? 'h-3 w-3' : 'h-2.5 w-2.5',
                  i === position
                    ? 'bg-[var(--accent)]'
                    : verdict
                      ? failed
                        ? 'bg-[var(--fail)]'
                        : 'bg-[var(--foreground)]'
                      : i < position
                        ? 'bg-[var(--foreground)]'
                        : 'border border-[var(--line-strong)]',
                ].join(' ')}
              />
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className={arrow}
        disabled={position >= last}
        onClick={() => onPosition(position + 1)}
        aria-label="Next step"
      >
        <ArrowRightIcon size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 text-[var(--muted)] underline-offset-4 hover:underline"
      >
        Back to results
      </button>
    </div>
  );
}

function Closing({
  summary,
  thesis,
  matrix,
  agents,
  onContinue,
  onReview,
}: {
  summary: ScanSummary;
  thesis?: string;
  matrix?: MissionReport['matrix'];
  agents: Array<{ kind: AgentKind; name: string }>;
  onContinue: () => void;
  /** Opens the first agent's review. */
  onReview?: () => void;
}) {
  return (
    <motion.section
      key="closing"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="thin-scroll flex h-full flex-col items-center justify-center overflow-auto text-center"
    >
      <p className="text-[24px] font-semibold leading-tight tracking-tight">{summary.short}</p>
      {thesis ? (
        <p className="mt-2 max-w-[560px] text-[16px] leading-relaxed text-[var(--muted)]">
          {thesis}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onContinue}
        className="mt-5 inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90"
      >
        See what we found
        <ArrowRightIcon />
      </button>
      {onReview ? (
        <button
          type="button"
          onClick={onReview}
          className="mt-4 text-sm text-[var(--muted)] underline-offset-4 hover:underline"
        >
          Look back at how each agent did it
        </button>
      ) : null}
      {matrix ? (
        <details className="mt-5 w-full max-w-[880px] text-left">
          <summary className="cursor-pointer text-center text-sm text-[var(--muted)]">
            All checkpoints
          </summary>
          <div className="mt-3">
            <CheckpointMatrix matrix={matrix} agents={agents} />
          </div>
        </details>
      ) : null}
    </motion.section>
  );
}

/**
 * Once the report is in, each agent's exact cost and, for every shopper dearer than the
 * cheapest, "22× Alpha". The live figures are sums of step usage and can run a little under.
 */
function finalCosts(
  rows: MissionReport['costComparison'] | undefined,
  lanes: LaneState[],
): Record<string, FinalCost> {
  if (!rows) return {};
  const cheapest = rows.find((r) => r.relativeCost === 1);
  const names = new Map(lanes.map((l) => [l.agent.kind, shortName(l.agent.name)]));
  const out: Record<string, FinalCost> = {};
  for (const lane of lanes) {
    const row = rows.find((r) => r.agentKind === lane.agent.kind);
    if (!row) continue;
    const m = row.relativeCost;
    const dearer = cheapest && m !== undefined && m > 1 && row.agentKind !== cheapest.agentKind;
    const entry: FinalCost = { costUsd: row.estimatedCostUsd ?? lane.costUsd };
    if (dearer) {
      entry.multiple = `${m >= 10 ? Math.round(m) : m.toFixed(1)}× ${names.get(cheapest.agentKind) ?? 'the cheapest'}`;
    }
    out[lane.runId] = entry;
  }
  return out;
}

type Review = { runId: string; position: number };

/**
 * Step 2: one agent on stage at a time, all four on the roster, then one line and one button.
 * Once the scan is done, any roster chip opens that agent's review: the same stage, rebuilt at
 * each step of its process, with a scrubber and the arrow keys.
 */
export function ScanStep(p: ScanStepProps) {
  const onStage = stageLane(p.lanes) ?? p.lanes[0];
  const next = nextLane(p.lanes);
  const finals = finalCosts(p.costComparison, p.lanes);
  const scale = Math.max(costScale(p.lanes), ...Object.values(finals).map((f) => f.costUsd));
  const agents = p.lanes.map((l) => ({ kind: l.agent.kind, name: l.agent.name }));
  const done = p.phase === 'done';

  const [review, setReview] = useState<Review | null>(null);
  const reviewLane = review ? p.lanes.find((l) => l.runId === review.runId) : undefined;
  useEffect(() => {
    if (!done) setReview(null);
  }, [done]);
  const openReview = (lane: LaneState) => setReview({ runId: lane.runId, position: 0 });
  const moveReview = (position: number) => {
    if (!reviewLane) return;
    const clamped = Math.min(reviewLength(reviewLane) - 1, Math.max(0, position));
    setReview({ runId: reviewLane.runId, position: clamped });
  };
  useEffect(() => {
    if (!review || !reviewLane) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') moveReview(review.position + 1);
      else if (e.key === 'ArrowLeft') moveReview(review.position - 1);
      else if (e.key === 'Escape') setReview(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="scan-root flex flex-col gap-4">
      <div className="scan-head flex items-center gap-4">
        <span className="scan-mark shrink-0 text-[var(--accent)] [&>svg]:h-11 [&>svg]:w-11">
          <ScanMark />
        </span>
        <div className="min-w-0">
          <h1 className="scan-title text-[24px] font-semibold leading-tight tracking-tight">
            {done ? 'Scan complete' : 'Shopping your store'}
          </h1>
          <p className="scan-subtitle mt-0.5 truncate text-[14px] text-[var(--muted)]">
            {done
              ? `Three shoppers tried to buy ${describeMission(p.mission)}, one at a time, and Gamma checked your product data against the cart.`
              : `Three shoppers try to buy ${describeMission(p.mission)}, one at a time, and Gamma checks your product data against the cart.`}
          </p>
        </div>
      </div>

      <ol className="flex gap-3" aria-label="Agents">
        {p.lanes.map((lane) => (
          <RosterChip
            key={lane.runId}
            lane={lane}
            role={
              isTerminal(lane.status)
                ? 'done'
                : !done && onStage?.runId === lane.runId
                  ? 'active'
                  : next?.runId === lane.runId
                    ? 'next'
                    : 'waiting'
            }
            scale={scale}
            final={finals[lane.runId]}
            selected={review?.runId === lane.runId}
            onSelect={done ? () => openReview(lane) : undefined}
          />
        ))}
      </ol>

      {done && review && reviewLane ? (
        <ReviewBar
          lane={reviewLane}
          position={review.position}
          onPosition={moveReview}
          onClose={() => setReview(null)}
        />
      ) : null}

      <div className="stage-frame min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {done && review && reviewLane ? (
            <motion.div
              key={`review-${review.runId}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="h-full min-h-0"
            >
              <Stage
                lane={laneAtReview(
                  reviewLane,
                  p.stepArtifacts[reviewLane.runId] ?? [],
                  review.position,
                )}
                mission={p.mission}
                snapshots={p.snapshots}
                failurePoint={p.failurePoints[reviewLane.runId]}
                observedCart={p.observedCarts[reviewLane.runId]}
                resolveArtifactUrl={p.resolveArtifactUrl}
                review
              />
            </motion.div>
          ) : done && p.summary ? (
            <Closing
              key="closing"
              summary={p.summary}
              thesis={p.thesis}
              matrix={p.matrix}
              agents={agents}
              onContinue={p.onContinue}
              onReview={p.lanes[0] ? () => openReview(p.lanes[0]!) : undefined}
            />
          ) : onStage ? (
            <motion.div
              key={onStage.runId}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="h-full min-h-0"
            >
              <Stage
                lane={onStage}
                mission={p.mission}
                snapshots={p.snapshots}
                failurePoint={p.failurePoints[onStage.runId]}
                observedCart={p.observedCarts[onStage.runId]}
                resolveArtifactUrl={p.resolveArtifactUrl}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
