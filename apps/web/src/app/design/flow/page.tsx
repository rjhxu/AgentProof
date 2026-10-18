import { Flow } from '@/design/flow/flow';
import { FLOW_STEPS, type FlowStep } from '@/design/flow/flow-machine';
import {
  missionABugged,
  problemsABugged,
  repositoryA,
  resolveDesignArtifact,
  runsABugged,
} from '@/design/fixtures';
import { buildReplayScript } from '@/design/replay/script';

type Search = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseStep(value: string | undefined): FlowStep {
  if (!value) return 'store';
  const byNumber = FLOW_STEPS[Number(value) - 1];
  if (byNumber) return byNumber;
  return FLOW_STEPS.find((s) => s === value) ?? 'store';
}

/**
 * The four-step flow, sandbox edition: the only module that touches the fixtures. Everything
 * the client needs crosses as plain JSON, so the server render and the first client render
 * agree, and ?step=3 paints step three with no flash.
 *
 * Query: ?step=1..4 (or a step name), ?speed=0.5|1|2|4, ?t=<ms>|end for the scan replay.
 */
export default async function FlowPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const step = parseStep(first(sp.step));
  const speed = Number(first(sp.speed)) || 1;
  const tRaw = first(sp.t);
  const t: number | 'end' | null = tRaw === 'end' ? 'end' : tRaw ? Number(tRaw) || null : null;

  const script = buildReplayScript(runsABugged);
  const frames: Record<string, string> = {};
  for (const run of runsABugged) {
    for (const s of run.steps) {
      const url = resolveDesignArtifact(s.screenshotPath);
      if (s.screenshotPath && url) frames[s.screenshotPath] = url;
    }
    const failing = run.failurePoint?.screenshotPath;
    const failingUrl = resolveDesignArtifact(failing);
    if (failing && failingUrl) frames[failing] = failingUrl;
  }

  return (
    <div data-theme="light" className="flow-root">
      <Flow
        report={missionABugged}
        runs={runsABugged}
        problems={problemsABugged}
        repository={repositoryA}
        script={script}
        mission={missionABugged.mission}
        frames={frames}
        initial={{ step, speed, t }}
      />
    </div>
  );
}
