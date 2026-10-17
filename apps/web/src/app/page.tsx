import { AGENT_LABELS, AgentKind, CHECKPOINT_LABELS } from '@agentproof/shared';
import { alphaFailedRun, hoodieMission } from '@agentproof/shared/fixtures';

/**
 * Placeholder home page. Renders fixture data so the schemas are visibly wired end to end.
 * OWNER: Zach. Replace with the mission form + arena.
 */
export default function Home() {
  const checkpoints = alphaFailedRun.verification?.checkpoints ?? [];
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-3xl font-semibold">Mission control</h1>
      <p className="mt-2 text-[var(--muted)]">
        Dashboard scaffold. Fixture mission and run below prove the shared schemas resolve through
        Next.
      </p>

      <section className="mt-8 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-5">
        <h2 className="text-sm uppercase tracking-wide text-[var(--muted)]">Mission</h2>
        <p className="mt-2">{hoodieMission.rawPrompt}</p>
        <pre className="mt-3 overflow-x-auto text-xs text-[var(--muted)]">
          {JSON.stringify(hoodieMission.requirements, null, 2)}
        </pre>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-3">
        {AgentKind.options.map((kind) => (
          <div key={kind} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="font-medium">{AGENT_LABELS[kind].name}</div>
            <div className="mt-1 text-sm text-[var(--muted)]">{AGENT_LABELS[kind].strategy}</div>
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-5">
        <h2 className="text-sm uppercase tracking-wide text-[var(--muted)]">
          Compatibility report (fixture: {AGENT_LABELS[alphaFailedRun.agent.kind].name})
        </h2>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {checkpoints.map((c) => (
              <tr key={c.id} className="border-t border-[var(--line)]">
                <td className="py-2">{CHECKPOINT_LABELS[c.id]}</td>
                <td
                  className="py-2 text-right font-medium"
                  style={{
                    color:
                      c.status === 'passed'
                        ? 'var(--pass)'
                        : c.status === 'failed'
                          ? 'var(--fail)'
                          : 'var(--warn)',
                  }}
                >
                  {c.status.replace('_', ' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
