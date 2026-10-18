import type { AgentKind } from '@agentproof/shared';

import { AgentPanel } from '@/design/components/agent-panel';
import { AttributionList } from '@/design/components/attribution-list';
import { CheckpointMatrix } from '@/design/components/checkpoint-matrix';
import { CostStrip } from '@/design/components/cost-strip';
import { InspectionStrip, type InspectionFinding } from '@/design/components/inspection-strip';
import { MissionBar } from '@/design/components/mission-bar';
import { arenaScreenshots, missionABugged, runsABugged } from '@/design/fixtures';
import { ScreenShell } from '@/design/screen-shell';

/**
 * SAMPLE DATA. The live-page inspector is not built and has no recorded output, so these
 * two findings are written for the design from what Alpha and Gamma actually hit on Bug A
 * (docs/DESIGN.md, decisions). Everything else on this screen is a recorded report.
 */
const sampleFindings: InspectionFinding[] = [
  {
    id: 'size-control',
    severity: 'fail',
    text: 'Size selector has no role or accessible name: "Size S M L" is plain text',
  },
  {
    id: 'variant-map',
    severity: 'fail',
    text: 'Catalog variant HOODIE-001-M lands in the cart as size S',
  },
];

export default function ArenaScreen() {
  const report = missionABugged;
  const agents = report.runs.map((r) => ({ kind: r.agentKind, name: r.agentName }));
  const names = Object.fromEntries(agents.map((a) => [a.kind, a.name])) as Record<
    AgentKind,
    string
  >;
  const costByKind = new Map(report.costComparison.map((c) => [c.agentKind, c.estimatedCostUsd]));
  const totalCost = report.costComparison.reduce((sum, c) => sum + (c.estimatedCostUsd ?? 0), 0);
  const elapsed = Math.max(0, ...report.runs.map((r) => r.durationMs ?? 0));

  return (
    <ScreenShell
      name="Arena"
      step="Steps 2 and 3: the agents run, the live page is inspected, the verifier scores"
      fixture="missionABugged + runsABugged"
      mode="design"
      mustShow={[
        'One panel per agent: name, senses, model, latest screenshot, steps so far, verdict.',
        'Live-page inspection results while the agents run (variant ids vs the DOM, unlabelled controls).',
        'The checkpoint matrix: checkpoints down, agents across, pass / fail / not run.',
        'Cost per agent, with the cheapest-agent thesis in one computed line.',
        'The "stopped before payment" state made explicit on every browsing agent.',
      ]}
    >
      <div className="space-y-3">
        <MissionBar
          prompt={report.mission.rawPrompt}
          storeUrl={report.storeUrl}
          agentCount={report.runs.length}
          state="complete"
          durationMs={elapsed}
          totalCostUsd={totalCost}
        />

        <InspectionStrip state="done" findings={sampleFindings} />

        <section className="grid grid-cols-4 gap-3">
          {runsABugged.map((run) => (
            <AgentPanel
              key={run.runId}
              agent={run.agent}
              status={run.status}
              steps={run.steps}
              screenshotUrl={arenaScreenshots[run.agent.kind]}
              costUsd={costByKind.get(run.agent.kind)}
              durationMs={run.durationMs}
              firstFailure={run.firstFailure}
              claim={run.claim}
            />
          ))}
        </section>

        <section className="grid grid-cols-[3fr_2fr] items-start gap-3">
          <CheckpointMatrix matrix={report.matrix} agents={agents} />
          <div className="space-y-3">
            <CostStrip rows={report.costComparison} names={names} headline={report.headline} />
            <AttributionList attributions={report.attributions} />
          </div>
        </section>
      </div>
    </ScreenShell>
  );
}
