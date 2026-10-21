import { CHECKPOINT_LABELS, CHECKPOINT_ORDER } from '@agentproof/shared';
import type { AgentKind, MissionReport, PatternStatus } from '@agentproof/shared';

import { humanize } from '../format';

export type CheckpointMatrixProps = {
  matrix: MissionReport['matrix'];
  /** Column order. */
  agents: Array<{ kind: AgentKind; name: string }>;
};

type Look = { mark: string; label: string; color: string; soft: string };

const LOOK: Record<string, Look> = {
  passed: { mark: '✓', label: 'Pass', color: 'var(--pass)', soft: 'var(--pass-soft)' },
  failed: { mark: '✕', label: 'Fail', color: 'var(--fail)', soft: 'var(--fail-soft)' },
  not_run: { mark: '–', label: 'Not run', color: 'var(--muted)', soft: 'transparent' },
  pending: { mark: '○', label: 'Pending', color: 'var(--muted)', soft: 'transparent' },
};

function look(status: PatternStatus | 'pending'): Look {
  return (
    LOOK[status] ?? {
      mark: '!',
      label: humanize(status),
      color: 'var(--warn)',
      soft: 'var(--warn-soft)',
    }
  );
}

function Cell({ status, title }: { status: PatternStatus | 'pending'; title: string }) {
  const l = look(status);
  return (
    <span
      title={title}
      className="inline-flex min-w-[76px] items-center justify-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
      style={{ color: l.color, background: l.soft }}
    >
      <span aria-hidden>{l.mark}</span>
      {l.label}
    </span>
  );
}

/**
 * Checkpoints down, agents across: the shape of the table in docs/RESULTS.md. Rows no agent
 * ran are hidden. Every cell carries a mark and a word, not colour alone.
 */
export function CheckpointMatrix({ matrix, agents }: CheckpointMatrixProps) {
  const rows = CHECKPOINT_ORDER.filter((id) => {
    const row = matrix[id];
    return row !== undefined && agents.some((a) => (row[a.kind] ?? 'not_run') !== 'not_run');
  });

  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--panel)]">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
        <h2 className="text-sm font-semibold">Checkpoints</h2>
        <p className="text-xs text-[var(--muted)]">
          Verified by code against the cart, not from what the agents claimed.
        </p>
      </header>
      <table className="mt-2 w-full border-collapse text-sm">
        <thead>
          <tr className="text-xs text-[var(--muted)]">
            <th className="px-4 py-2 text-left font-normal">Checkpoint</th>
            {agents.map((a) => (
              <th key={a.kind} className="px-2 py-2 text-center font-normal">
                {a.name.replace(/^Agent /, '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((id) => (
            <tr key={id} className="border-t border-[var(--line)]">
              <th scope="row" className="px-4 py-1.5 text-left font-normal">
                {CHECKPOINT_LABELS[id]}
              </th>
              {agents.map((a) => {
                const status = matrix[id]?.[a.kind] ?? 'not_run';
                return (
                  <td key={a.kind} className="px-2 py-1.5 text-center">
                    <Cell
                      status={status}
                      title={`${a.name} · ${CHECKPOINT_LABELS[id]} · ${look(status).label}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-xs text-[var(--muted)]">
        {(['passed', 'failed', 'not_run', 'pending'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span aria-hidden style={{ color: look(s).color }}>
              {look(s).mark}
            </span>
            {look(s).label}
          </span>
        ))}
        <span>Other statuses (not verified, unsupported, blocked) show as !</span>
      </footer>
    </section>
  );
}
