import { formatDuration, formatUsd } from '../format';
import { StatusBadge } from './status-badge';

export type MissionBarProps = {
  prompt: string;
  storeUrl: string;
  agentCount: number;
  state: 'running' | 'complete';
  durationMs?: number;
  totalCostUsd?: number;
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="truncate tabular-nums">{value}</dd>
    </div>
  );
}

/** The mission in the user's words, where it ran, and the whole-run totals. */
export function MissionBar(p: MissionBarProps) {
  let host = p.storeUrl;
  try {
    host = new URL(p.storeUrl).host;
  } catch {
    // keep the raw string
  }
  return (
    <section className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Mission</p>
        <p className="truncate text-[15px]" title={p.prompt}>
          “{p.prompt}”
        </p>
      </div>
      <dl className="flex items-center gap-6 text-sm">
        <Stat label="Store" value={host} />
        <Stat label="Agents" value={String(p.agentCount)} />
        <Stat label="Elapsed" value={formatDuration(p.durationMs)} />
        <Stat label="Spent" value={formatUsd(p.totalCostUsd)} />
        <div>
          <StatusBadge status={p.state === 'complete' ? 'complete' : 'running'} />
        </div>
      </dl>
    </section>
  );
}
