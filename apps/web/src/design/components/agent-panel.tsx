import { CHECKPOINT_LABELS } from '@agentproof/shared';
import type {
  AgentClaim,
  AgentProfileSummary,
  Checkpoint,
  RunStatus,
  RunStep,
} from '@agentproof/shared';

import { describeAction, formatDuration, formatUsd, shortModel, stepNote } from '../format';
import { StatusBadge } from './status-badge';

export type AgentPanelProps = {
  agent: AgentProfileSummary;
  status: RunStatus | 'running';
  steps: RunStep[];
  /** Latest viewport. Absent for agents that never render a page. */
  screenshotUrl?: string;
  costUsd?: number;
  durationMs?: number;
  firstFailure?: Checkpoint;
  claim?: AgentClaim;
};

/**
 * One agent's run: what it can perceive, what it sees now, what it has done, and the
 * verifier's verdict. Same props for a live run and a finished report.
 */
export function AgentPanel(p: AgentPanelProps) {
  const name = p.agent.name.replace(/^Agent /, '');
  const senses = p.agent.perceives.join(' · ');
  const terminal = p.status === 'passed' || p.status === 'failed';
  const browsed = p.steps.length > 0;

  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)]">
      <header className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">{name}</h3>
          <p className="line-clamp-2 h-8 text-xs leading-4 text-[var(--muted)]" title={senses}>
            {senses}
          </p>
        </div>
        <span className="shrink-0 rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
          {shortModel(p.agent.model)}
        </span>
      </header>

      <div className="mx-3 mt-3 aspect-[16/10] overflow-hidden rounded border border-[var(--line)] bg-[var(--background)]">
        {p.screenshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.screenshotUrl}
            alt={`Latest viewport of ${p.agent.name}`}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-[var(--muted)]">
            No viewport. This agent reads the catalog feed and the cart API.
          </div>
        )}
      </div>

      <ol className="thin-scroll mx-3 mt-3 max-h-44 flex-1 space-y-1 overflow-y-auto pr-1 text-xs">
        {!browsed ? <li className="text-[var(--muted)]">No browser steps.</li> : null}
        {p.steps.map((step) => {
          const failed = step.outcome !== 'ok';
          const note = stepNote(step);
          return (
            <li key={step.index} className="flex gap-2">
              <span className="w-4 shrink-0 text-right tabular-nums text-[var(--muted)]">
                {step.index + 1}
              </span>
              <span className="min-w-0">
                <span className={failed ? 'text-[var(--fail)]' : undefined}>
                  {failed ? '✕ ' : null}
                  {describeAction(step.action)}
                </span>
                {note ? (
                  <span className="block truncate text-[var(--muted)]" title={note}>
                    {note}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      <footer className="mt-3 border-t border-[var(--line)] px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <StatusBadge status={p.status} />
          <span className="tabular-nums text-[var(--muted)]">
            {p.steps.length} steps · {formatDuration(p.durationMs)} · {formatUsd(p.costUsd)}
          </span>
        </div>
        {p.firstFailure ? (
          <p className="mt-1.5">
            <span className="text-[var(--fail)]">Failed at</span>{' '}
            {CHECKPOINT_LABELS[p.firstFailure.id]}
            {p.firstFailure.detail ? (
              <span className="text-[var(--muted)]"> · {p.firstFailure.detail}</span>
            ) : null}
          </p>
        ) : null}
        {terminal && browsed && p.claim?.outcome === 'done' ? (
          <p className="mt-1 text-[var(--muted)]">
            Stopped at checkout review. No payment was made.
          </p>
        ) : null}
      </footer>
    </article>
  );
}
