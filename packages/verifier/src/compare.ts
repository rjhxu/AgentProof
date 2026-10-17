import type { Run, RunComparison, CheckpointId } from '@agentproof/shared';

const RANK: Record<string, number> = {
  passed: 3,
  not_verified: 1,
  not_tested: 1,
  unsupported: 1,
  blocked: 1,
  failed: 0,
};

/** Before/after table for the Rematch view. */
export function compareRuns(original: Run, rematch: Run): RunComparison {
  const before = new Map(original.verification?.checkpoints.map((c) => [c.id, c.status]) ?? []);
  const after = new Map(rematch.verification?.checkpoints.map((c) => [c.id, c.status]) ?? []);
  const ids = [...new Set<CheckpointId>([...before.keys(), ...after.keys()])];

  const deltas = ids.map((id) => {
    const b = before.get(id) ?? 'not_tested';
    const a = after.get(id) ?? 'not_tested';
    const rb = RANK[b] ?? 1;
    const ra = RANK[a] ?? 1;
    return {
      id,
      before: b,
      after: a,
      change:
        ra > rb ? ('improved' as const) : ra < rb ? ('regressed' as const) : ('unchanged' as const),
    };
  });

  return {
    originalRunId: original.id,
    rematchRunId: rematch.id,
    deltas,
    improved: deltas.filter((d) => d.change === 'improved').length,
    regressed: deltas.filter((d) => d.change === 'regressed').length,
    unchanged: deltas.filter((d) => d.change === 'unchanged').length,
  };
}
