import { missionABugged } from '@/design/fixtures';
import { ScreenShell } from '@/design/screen-shell';

export default function ArenaScreen() {
  return (
    <ScreenShell
      name="Arena"
      step="Steps 2 and 3: the agents run, the live page is inspected, the verifier scores"
      fixture="missionABugged"
      mustShow={[
        'One panel per agent: name, strategy, model, latest screenshot, steps so far, status.',
        'Live-page inspection results while the agents run (variant ids vs the DOM, unlabelled controls).',
        'The checkpoint matrix filling in: checkpoints down, agents across, pass / fail / not run.',
        'Cost per agent accruing as the run goes.',
        'The "stopped before payment" state made explicit at the end.',
      ]}
    >
      <p className="text-sm text-[var(--muted)]">
        Fixture loaded: {missionABugged.runs.length} runs on {missionABugged.storeUrl}.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {missionABugged.runs.map((run) => (
          <li key={run.runId}>
            {run.agentName} ({run.model}): {run.status}, {run.stepsUsed} steps
          </li>
        ))}
      </ul>
    </ScreenShell>
  );
}
