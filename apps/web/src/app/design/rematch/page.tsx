import { missionABugged, missionAFixed } from '@/design/fixtures';
import { ScreenShell } from '@/design/screen-shell';

function passedCount(matrix: Record<string, Record<string, string>>): number {
  return Object.values(matrix)
    .flatMap((row) => Object.values(row))
    .filter((status) => status === 'passed').length;
}

export default function RematchScreen() {
  return (
    <ScreenShell
      name="Rematch"
      step="Step 6: the repair is applied and the same mission runs again"
      fixture="missionABugged vs missionAFixed"
      mustShow={[
        'The same checkpoint matrix before and after, or one matrix with deltas.',
        'Which checkpoints flipped, named.',
        'Cost of the original run and the rematch.',
        'The thesis line: the cheapest agent now passes.',
      ]}
    >
      <p className="text-sm text-[var(--muted)]">
        Fixture loaded: {passedCount(missionABugged.matrix)} passed cells before,{' '}
        {passedCount(missionAFixed.matrix)} after (the fixed run has{' '}
        {missionAFixed.runs.length} agents).
      </p>
    </ScreenShell>
  );
}
