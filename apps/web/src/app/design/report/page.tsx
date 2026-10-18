import { missionABugged } from '@/design/fixtures';
import { ScreenShell } from '@/design/screen-shell';

export default function ReportScreen() {
  return (
    <ScreenShell
      name="Report"
      step="Step 4: issues with evidence, before any repository is connected"
      fixture="missionABugged"
      mustShow={[
        'Verdict per agent and the deterministic headline.',
        'The attribution sentence for each failed checkpoint.',
        'Cost per agent, with the cheapest-agent thesis visible in one line.',
        'Issue cards: observed facts first, hypothesis labelled as such.',
        'Links to the agent reports and the mission report.',
      ]}
    >
      <p className="text-sm">{missionABugged.headline}</p>
      <ul className="mt-2 space-y-1 text-sm text-[var(--muted)]">
        {missionABugged.attributions.map((attribution) => (
          <li key={attribution.checkpointId}>
            {attribution.checkpointId}: {attribution.reason}
          </li>
        ))}
      </ul>
    </ScreenShell>
  );
}
