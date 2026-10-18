'use client';

import { AnimatePresence, motion } from 'motion/react';
import { CHECKPOINT_LABELS, CHECKPOINT_ORDER } from '@agentproof/shared';
import type { AgentKind, CheckpointId, Mission, MissionReport } from '@agentproof/shared';

import { CheckpointMatrix } from '../components/checkpoint-matrix';
import { StatusBadge } from '../components/status-badge';
import {
  describeMission,
  formatUsd,
  plainAction,
  shortModel,
  shortName,
  STAGE_LABELS,
  STAGES,
  type ScanSummary,
  type Stage,
} from '../format';
import { isTerminal, type LaneState } from '../replay/reduce';
import { ArrowRightIcon, CheckIcon, CrossIcon } from './icons';
import { ScanMark } from './illustrations';
import { StepHeader } from './step-header';

export type ScanStepProps = {
  mission: Mission;
  lanes: LaneState[];
  phase: 'running' | 'done';
  summary?: ScanSummary;
  /** The finished matrix, for the collapsed "all checkpoints" table. */
  matrix?: MissionReport['matrix'];
  resolveArtifactUrl: (path: string | undefined) => string | undefined;
  onContinue: () => void;
};

const DESCRIPTOR: Record<AgentKind, string> = {
  alpha_semantic: 'reads the page as text, like a screen reader',
  beta_vision: 'looks at screenshots and clicks what it sees',
  sigma_hybrid: 'reads and looks, on the strongest model',
  gamma_structured: 'checks the catalog feed against the cart API',
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

function Track({ stage, browses }: { stage: Stage; browses: boolean }) {
  const stages: Stage[] = browses ? [...STAGES] : ['find', 'cart'];
  const labels: Record<Stage, string> = browses
    ? STAGE_LABELS
    : { find: 'Catalog', variant: '', cart: 'Cart API', review: '' };
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

function Lane({
  lane,
  resolveArtifactUrl,
}: {
  lane: LaneState;
  resolveArtifactUrl: ScanStepProps['resolveArtifactUrl'];
}) {
  const browses = lane.agent.kind !== 'gamma_structured';
  const terminal = isTerminal(lane.status);
  const lastStep = lane.steps[lane.steps.length - 1];
  const byId = new Map(lane.checkpoints.map((c) => [c.id, c.status] as const));
  const expected = expectedCheckpoints(browses);
  const extra = lane.checkpoints.filter((c) => !expected.includes(c.id)).map((c) => c.id);
  const shot = resolveArtifactUrl(lane.latestScreenshotPath);

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
        : lane.status === 'running'
          ? browses
            ? 'Opening the store'
            : 'Reading the catalog'
          : 'Waiting';

  return (
    <li className="grid grid-cols-[200px_1fr_auto] items-start gap-6 rounded-lg border border-[var(--line)] bg-[var(--background)] p-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold">{shortName(lane.agent.name)}</h3>
          <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
            {shortModel(lane.agent.model)}
          </span>
        </div>
        <p className="mt-1 text-xs leading-snug text-[var(--muted)]">
          {DESCRIPTOR[lane.agent.kind]}
        </p>
        <div className="mt-3">
          <StatusBadge status={lane.status} />
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-4">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={`${lane.status}-${lastStep?.index ?? -1}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="truncate text-[15px]"
            >
              {action}
            </motion.p>
          </AnimatePresence>
          <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">
            {browses ? `${lane.steps.length} steps · ${formatUsd(lane.costUsd)}` : 'no model · $0'}
          </span>
        </div>
        <Track stage={lane.stage} browses={browses} />
        <div className="mt-4 flex items-center gap-1.5" aria-label="Checkpoints">
          {expected.map((id) => (
            <Tick key={id} id={id} status={byId.get(id)} />
          ))}
          {extra.map((id) => (
            <Tick key={id} id={id} status={byId.get(id)} />
          ))}
        </div>
      </div>

      <div className="relative aspect-[16/10] w-40 overflow-hidden rounded border border-[var(--line)] bg-[var(--panel)]">
        {browses ? (
          <AnimatePresence mode="popLayout" initial={false}>
            {shot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <motion.img
                key={shot}
                src={shot}
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
                className={`absolute inset-0 ${lane.status === 'running' ? 'shimmer' : ''}`}
              />
            )}
          </AnimatePresence>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-[var(--muted)]">
            <span className="rounded border border-[var(--line-strong)] px-1.5 py-0.5 font-mono">
              JSON
            </span>
            no viewport
          </div>
        )}
      </div>
    </li>
  );
}

/** Step 2: four lanes, then one line and one button. */
export function ScanStep(p: ScanStepProps) {
  const agents = p.lanes.map((l) => ({ kind: l.agent.kind, name: l.agent.name }));
  return (
    <div>
      <StepHeader
        mark={<ScanMark />}
        title={p.phase === 'done' ? 'Scan complete' : 'Shopping your store'}
        subtitle={
          p.phase === 'done'
            ? `Four shoppers tried to buy ${describeMission(p.mission)}. Each one perceives the store differently.`
            : `Four shoppers are trying to buy ${describeMission(p.mission)}. Each one perceives the store differently.`
        }
      />

      <ol className="mt-8 space-y-3">
        {p.lanes.map((lane) => (
          <Lane key={lane.runId} lane={lane} resolveArtifactUrl={p.resolveArtifactUrl} />
        ))}
      </ol>

      <AnimatePresence>
        {p.phase === 'done' && p.summary ? (
          <motion.section
            key="summary"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="mt-8 flex flex-col items-center text-center"
          >
            <p className="text-[20px] font-medium">{p.summary.short}</p>
            <button
              type="button"
              onClick={p.onContinue}
              className="mt-4 inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90"
            >
              See what we found
              <ArrowRightIcon />
            </button>
            {p.matrix ? (
              <details className="mt-6 w-full text-left">
                <summary className="cursor-pointer text-center text-sm text-[var(--muted)]">
                  All checkpoints
                </summary>
                <div className="mt-3">
                  <CheckpointMatrix matrix={p.matrix} agents={agents} />
                </div>
              </details>
            ) : null}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
