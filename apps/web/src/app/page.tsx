import { LiveFlow } from '@/live/live-flow';

type Search = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The dashboard: the four-step flow (docs/DESIGN.md) fed by the runner. `?mission=<id>` resumes
 * a mission: its runs replay from what the runner saved, then live-tail. The Gamma-only page
 * that lived here moved to /gamma; the fixture-driven sandbox stays at /design/flow.
 */
export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const raw = first(sp.mission);
  const missionId = raw && /^mis_[a-zA-Z0-9]+$/.test(raw) ? raw : undefined;
  return (
    <div data-theme="light" className="flow-root">
      <LiveFlow missionId={missionId} />
    </div>
  );
}
