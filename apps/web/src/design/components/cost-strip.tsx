import type { AgentKind, MissionReport } from '@agentproof/shared';

import { formatUsd, shortModel } from '../format';
import { StatusBadge } from './status-badge';

type CostRow = MissionReport['costComparison'][number];

export type CostStripProps = {
  rows: CostRow[];
  names: Record<AgentKind, string>;
  /** The report's deterministic headline, shown verbatim. */
  headline: string;
};

/**
 * Cost per agent as thin bars against the most expensive, with the verdict beside each so
 * the thesis reads in one glance: did the cheapest agent get through?
 */
export function CostStrip({ rows, names, headline }: CostStripProps) {
  const max = Math.max(0, ...rows.map((r) => r.estimatedCostUsd ?? 0));

  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Cost per agent</h2>
        <p className="text-xs text-[var(--muted)]">
          Estimated from tokens. Multiples of the cheapest.
        </p>
      </header>
      <ul className="mt-3 space-y-2">
        {rows.map((row) => {
          const cost = row.estimatedCostUsd ?? 0;
          const width = max > 0 && cost > 0 ? Math.max((cost / max) * 100, 2) : 0;
          const multiple =
            row.relativeCost && row.relativeCost > 0
              ? `${row.relativeCost.toFixed(row.relativeCost >= 10 ? 0 : 1)}×`
              : '';
          return (
            <li
              key={row.agentKind}
              className="grid grid-cols-[96px_1fr_auto] items-center gap-3 text-xs"
            >
              <span className="truncate">
                {names[row.agentKind].replace(/^Agent /, '')}{' '}
                <span className="text-[var(--muted)]">{shortModel(row.model)}</span>
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-[var(--panel-2)]">
                <span
                  className="block h-2 rounded-full bg-[var(--accent)]"
                  style={{ width: `${width}%` }}
                />
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                <span className="w-14 text-right">{formatUsd(cost)}</span>
                <span className="w-9 text-right text-[var(--muted)]">{multiple}</span>
                <StatusBadge status={row.status} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 border-t border-[var(--line)] pt-2 text-xs leading-relaxed">
        <span className="text-[var(--muted)]">Verdict, computed · </span>
        {headline}
      </p>
    </section>
  );
}
