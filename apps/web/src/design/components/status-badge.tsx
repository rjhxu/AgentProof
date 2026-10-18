import type { RunStatus } from '@agentproof/shared';

import { humanize } from '../format';

export type BadgeStatus = RunStatus | 'running' | 'pending' | 'complete';

type Look = { label: string; mark: string; color: string; soft: string };

/**
 * Verdict chips. Every status carries a mark and a word as well as a colour: on the dark
 * surface the pass and fail hues sit 4.7 Delta E apart under deuteranopia, so colour alone
 * would not be legible to everyone.
 */
const LOOK: Record<string, Look> = {
  passed: { label: 'Passed', mark: '✓', color: 'var(--pass)', soft: 'var(--pass-soft)' },
  failed: { label: 'Failed', mark: '✕', color: 'var(--fail)', soft: 'var(--fail-soft)' },
  running: { label: 'Running', mark: '●', color: 'var(--accent)', soft: 'var(--accent-soft)' },
  pending: { label: 'Pending', mark: '○', color: 'var(--muted)', soft: 'transparent' },
  complete: { label: 'Complete', mark: '✓', color: 'var(--foreground)', soft: 'var(--panel-2)' },
};

const FALLBACK = (status: string): Look => ({
  label: humanize(status),
  mark: '!',
  color: 'var(--warn)',
  soft: 'var(--warn-soft)',
});

export function StatusBadge({ status, detail }: { status: BadgeStatus; detail?: string }) {
  const look = LOOK[status] ?? FALLBACK(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color: look.color, background: look.soft }}
    >
      <span aria-hidden className={status === 'running' ? 'animate-pulse' : undefined}>
        {look.mark}
      </span>
      {look.label}
      {detail ? <span className="font-normal text-[var(--muted)]">· {detail}</span> : null}
    </span>
  );
}
