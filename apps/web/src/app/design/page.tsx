import Link from 'next/link';

/**
 * Index of the design sandbox. One row per screen in docs/DESIGN.md.
 * Sandbox only; delete or gate to development once the screens are wired.
 */
const screens = [
  {
    href: '/design/launch',
    name: 'Launch',
    step: 'Step 1',
    summary: 'URL, mission, agents, optional repository, Start.',
    status: 'todo',
  },
  {
    href: '/design/arena',
    name: 'Arena',
    step: 'Steps 2 and 3',
    summary: 'One panel per agent, live-page inspection, the checkpoint matrix filling in.',
    status: 'todo',
  },
  {
    href: '/design/report',
    name: 'Report',
    step: 'Step 4',
    summary: 'Verdicts, attribution, cost per agent, issue cards, report links.',
    status: 'todo',
  },
  {
    href: '/design/issue',
    name: 'Issue',
    step: 'Step 5',
    summary: 'Evidence, hypothesis, connect the repository, the diff, Apply.',
    status: 'todo',
  },
  {
    href: '/design/rematch',
    name: 'Rematch',
    step: 'Step 6',
    summary: 'Before and after the repair: which checkpoints flipped, what both runs cost.',
    status: 'todo',
  },
] as const;

export default function DesignIndex() {
  return (
    <main className="mx-auto max-w-[1440px] px-6 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Design sandbox</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Screens render recorded reports only. Brief, inventory and decisions in{' '}
          <code className="rounded bg-[var(--panel)] px-1">docs/DESIGN.md</code>.
        </p>
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
            <th className="py-2 pr-4">Screen</th>
            <th className="py-2 pr-4">Flow</th>
            <th className="py-2 pr-4">What it must show</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {screens.map((screen) => (
            <tr key={screen.href} className="border-b border-[var(--line)]">
              <td className="py-3 pr-4 font-medium">
                <Link href={screen.href} className="text-[var(--accent)] hover:underline">
                  {screen.name}
                </Link>
              </td>
              <td className="py-3 pr-4 text-[var(--muted)]">{screen.step}</td>
              <td className="py-3 pr-4">{screen.summary}</td>
              <td className="py-3 text-[var(--muted)]">{screen.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
