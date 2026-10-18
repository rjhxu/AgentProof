import { CHECKPOINT_LABELS } from '@agentproof/shared';
import type { Attribution } from '@agentproof/shared';

import { humanize } from '../format';

export type AttributionListProps = {
  attributions: Attribution[];
};

/**
 * Why each failed checkpoint failed, from the pass/fail pattern across agents. The text is
 * the report's own sentence, written by code; the UI does not rephrase it.
 */
export function AttributionList({ attributions }: AttributionListProps) {
  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Why it failed</h2>
        <p className="text-xs text-[var(--muted)]">
          From the pass/fail pattern across agents. Deterministic, no model.
        </p>
      </header>
      {attributions.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--muted)]">Nothing failed.</p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--line)]">
          {attributions.map((a, i) => (
            <li key={`${a.checkpointId}-${a.category}-${i}`} className="py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-medium">
                  {humanize(a.category)}
                </span>
                <span className="text-[var(--muted)]">{CHECKPOINT_LABELS[a.checkpointId]}</span>
              </div>
              <p className="mt-1 leading-relaxed">{a.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
