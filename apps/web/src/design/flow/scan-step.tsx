'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CHECKPOINT_LABELS, CHECKPOINT_ORDER } from '@agentproof/shared';
import type {
  AgentKind,
  CheckpointId,
  FailurePoint,
  Mission,
  MissionReport,
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
import { browsingLanes, costScale, gammaLane, nextLane, stageLane } from './stage';

export type ScanStepProps = {
  mission: Mission;
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

function Track({ stage }: { stage: PathStage }) {
  const index = Math.max(0, STAGES.indexOf(stage));
  const pct = (index / (STAGES.length - 1)) * 100;
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
        {STAGES.map((s, i) => (
          <li key={s} className={i <= index ? 'text-[var(--foreground)]' : undefined}>
            {STAGE_LABELS[s]}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What a shopper perceives, as three small marks: lit when it has that sense. */
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
    if (lane.status === 'queued') return 'waiting';
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

function RosterChip({
  lane,
  role,
  scale,
  final,
}: {
  lane: LaneState;
  role: RosterRole;
  /** The most expensive shopper so far; every cost bar is drawn against it. */
  scale: number;
  /** From the report once the scan is done: the exact cost and "22× Alpha". */
  final?: FinalCost;
}) {
  const browses = lane.agent.kind !== 'gamma_structured';
  const cost = final?.costUsd ?? lane.costUsd;
  const pct = scale > 0 && cost > 0 ? Math.max(3, (cost / scale) * 100) : 0;
  return (
    <li
      className={[
        'relative min-w-0 flex-1 rounded-md border bg-[var(--background)] px-3 py-2',
        role === 'active' ? 'border-[var(--accent)]' : 'border-[var(--line)]',
        role === 'waiting' ? 'opacity-60' : '',
      ].join(' ')}
    >
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
            'block rounded-sm px-1 -mx-1',
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

/** The store as this shopper sees it: text, pixels, or both. */
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
  const frame = [
    'stage-box relative overflow-hidden rounded-md border bg-[var(--panel)]',
    failed ? 'border-[var(--fail)] ring-4 ring-[var(--fail-soft)]' : 'border-[var(--line)]',
  ].join(' ');
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

function Stage({
  lane,
  snapshots,
  failurePoint,
  resolveArtifactUrl,
}: {
  lane: LaneState;
  snapshots: Record<string, string>;
  failurePoint?: FailurePoint;
  resolveArtifactUrl: ScanStepProps['resolveArtifactUrl'];
}) {
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
  const reason = stepReason(shownStep);
  const firstFailed = lane.checkpoints.find((c) => c.status === 'failed');
  const byId = new Map(lane.checkpoints.map((c) => [c.id, c.status] as const));
  const expected = expectedCheckpoints(true);

  const action = terminal
    ? lane.status === 'passed'
      ? 'Completed the purchase path'
      : lane.status === 'failed'
        ? 'Did not complete the purchase path'
        : 'Stopped'
    : lane.status === 'verifying'
      ? 'Checking the cart'
      : lastStep
        ? plainAction(lastStep)
        : 'Opening the store';

  return (
    <div className="stage-grid grid h-full min-h-0 grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-h-0 min-w-0 items-start">
        <PerceptionPanel
          kind={lane.agent.kind}
          shotUrl={shotUrl}
          snapshot={snapshot}
          target={target}
          failed={failed}
          running={lane.status === 'running'}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-[17px] font-semibold">{shortName(lane.agent.name)}</h2>
          <SenseIcons kind={lane.agent.kind} size={13} />
          <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
            {lane.agent.kind === BENCHMARK_KIND ? 'benchmark shopper · ' : ''}
            {shortModel(lane.agent.model)}
          </span>
        </div>
        <p className="scan-descriptor mt-0.5 text-[13px] text-[var(--muted)]">
          {DESCRIPTOR[lane.agent.kind]}
        </p>

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

        {failed && firstFailed ? (
          <div className="mt-3 rounded-md border border-[var(--fail)] bg-[var(--fail-soft)] px-3 py-2 text-[13px] leading-snug">
            <span className="mr-1.5 inline-flex align-middle text-[var(--fail)]">
              <CrossIcon size={12} />
            </span>
            <span className="font-medium">{CHECKPOINT_LABELS[firstFailed.id]}.</span>{' '}
            {firstFailed.detail}
          </div>
        ) : null}
        {lane.status === 'passed' ? (
          <div className="mt-3 flex items-center gap-1.5 text-[13px]">
            <CheckIcon size={12} />
            Every checkpoint passed, up to checkout review.
          </div>
        ) : null}

        <div className="mt-auto pt-4">
          <Track stage={lane.stage} />
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[12px] tabular-nums text-[var(--muted)]">
              {lane.steps.length} step{lane.steps.length === 1 ? '' : 's'} ·{' '}
              <span className="text-[var(--foreground)]">{formatUsd(lane.costUsd)}</span> so far
            </span>
            <div className="flex items-center gap-1.5" aria-label="Checkpoints">
              {expected.map((id) => (
                <Tick key={id} id={id} status={byId.get(id)} />
              ))}
            </div>
          </div>
          <div className="mt-3">
            <StatusBadge status={lane.status} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Gamma: not a shopper. It reads the catalog and the cart API and is done in a blink. */
function GammaStrip({ lane }: { lane: LaneState }) {
  const terminal = isTerminal(lane.status);
  const failed = lane.checkpoints.filter((c) => c.status === 'failed');
  const passed = lane.checkpoints.filter((c) => c.status === 'passed').length;
  const first = failed[0];
  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-[13px]">
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-[var(--muted)]">
          <BracesIcon size={13} />
        </span>
        <span className="font-semibold">Catalog check</span>
        <span className="text-[11px] text-[var(--muted)]">no model · $0</span>
      </span>
      <span className="min-w-0 flex-1 truncate" title={first?.detail}>
        {!terminal ? (
          <span className="text-[var(--muted)]">
            {lane.status === 'queued' ? 'Waiting' : 'Reading the catalog feed and the cart API'}
          </span>
        ) : first ? (
          <>
            <span className="mr-1.5 inline-flex align-middle text-[var(--fail)]">
              <CrossIcon size={12} />
            </span>
            <span className="font-medium">{CHECKPOINT_LABELS[first.id]}.</span> {first.detail}
          </>
        ) : (
          <>
            <span className="mr-1.5 inline-flex align-middle">
              <CheckIcon size={12} />
            </span>
            {passed} checks passed
          </>
        )}
      </span>
      {terminal && first ? (
        <span className="shrink-0 text-[11px] text-[var(--muted)]">
          {failed.length > 1 ? `${failed.length - 1} more failed · ` : ''}
          {passed} passed
        </span>
      ) : null}
    </div>
  );
}

function Closing({
  summary,
  thesis,
  matrix,
  agents,
  onContinue,
}: {
  summary: ScanSummary;
  thesis?: string;
  matrix?: MissionReport['matrix'];
  agents: Array<{ kind: AgentKind; name: string }>;
  onContinue: () => void;
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

type FinalCost = { costUsd: number; multiple?: string };

/**
 * Once the report is in, each shopper's exact cost and, for every shopper dearer than the
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

/** Step 2: one shopper on stage at a time, all four on the roster, then one line and one button. */
export function ScanStep(p: ScanStepProps) {
  const shoppers = browsingLanes(p.lanes);
  const gamma = gammaLane(p.lanes);
  const onStage = stageLane(p.lanes) ?? shoppers[0];
  const next = nextLane(p.lanes);
  const finals = finalCosts(p.costComparison, p.lanes);
  const scale = Math.max(costScale(p.lanes), ...Object.values(finals).map((f) => f.costUsd));
  const agents = p.lanes.map((l) => ({ kind: l.agent.kind, name: l.agent.name }));
  const done = p.phase === 'done';

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
              ? `Three shoppers tried to buy ${describeMission(p.mission)}, one at a time, while the catalog was checked.`
              : `Three shoppers try to buy ${describeMission(p.mission)}, one at a time. Each one perceives the store differently.`}
          </p>
        </div>
      </div>

      <ol className="flex gap-3" aria-label="Shoppers">
        {shoppers.map((lane) => (
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
          />
        ))}
        {gamma ? (
          <RosterChip
            lane={gamma}
            role={
              isTerminal(gamma.status) ? 'done' : gamma.status === 'queued' ? 'waiting' : 'active'
            }
            scale={scale}
          />
        ) : null}
      </ol>

      <div className="stage-frame min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {done && p.summary ? (
            <Closing
              key="closing"
              summary={p.summary}
              thesis={p.thesis}
              matrix={p.matrix}
              agents={agents}
              onContinue={p.onContinue}
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
                snapshots={p.snapshots}
                failurePoint={p.failurePoints[onStage.runId]}
                resolveArtifactUrl={p.resolveArtifactUrl}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {gamma ? <GammaStrip lane={gamma} /> : null}
    </div>
  );
}
