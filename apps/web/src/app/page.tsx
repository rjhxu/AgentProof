'use client';

import { useEffect, useState } from 'react';
import {
  CHECKPOINT_LABELS,
  type Run,
  type Issue,
  type Repair,
  type RunComparison,
} from '@agentproof/shared';
import { api } from '../lib/api';
import { RepositoryConnectionPanel } from '../components/repository-connection';

const color = (status: string) =>
  status === 'passed'
    ? 'var(--pass)'
    : ['failed', 'error'].includes(status)
      ? 'var(--fail)'
      : 'var(--muted)';
const button =
  'rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
const panel = 'mt-6 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5';

export default function Home() {
  const [original, setOriginal] = useState<Run>();
  const [rematch, setRematch] = useState<Run>();
  const [issue, setIssue] = useState<Issue>();
  const [repair, setRepair] = useState<Repair>();
  const [comparison, setComparison] = useState<RunComparison>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get('run');
    if (!runId || !/^run_[a-zA-Z0-9]+$/.test(runId)) return;
    let mounted = true;
    setBusy('Loading saved run...');
    void (async () => {
      try {
        const saved = await api.getRun(runId);
        if (!mounted) return;
        setOriginal(saved.run);
        setIssue(saved.issues[0]);
        setRepair(
          saved.repairs.find((repair) => repair.status === 'applied') ?? saved.repairs.at(-1),
        );
        await follow(saved.run, setOriginal, () => mounted);
      } catch (error) {
        if (mounted) setError(error instanceof Error ? error.message : 'Could not load saved run.');
      } finally {
        if (mounted) setBusy('');
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }

  async function follow(run: Run, update: (run: Run) => void, isCurrent = () => true) {
    if (!isCurrent()) throw new Error('Run view closed.');
    update(run);
    for (let attempt = 0; attempt < 90; attempt++) {
      if (!isCurrent()) throw new Error('Run view closed.');
      const { run: current } = await api.getRun(run.id);
      if (!isCurrent()) throw new Error('Run view closed.');
      update(current);
      if (['passed', 'failed', 'error', 'cancelled'].includes(current.status)) {
        if (current.status === 'error')
          throw new Error(current.errorMessage ?? 'Run execution failed.');
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Run is still active. Check the runner before trying again.');
  }

  async function start() {
    setOriginal(undefined);
    setRematch(undefined);
    setIssue(undefined);
    setRepair(undefined);
    setComparison(undefined);
    const { mission } = await api.demoMission();
    const { runs } = await api.startRuns(mission.id, { agents: ['gamma_structured'] });
    const location = new URL(window.location.href);
    location.searchParams.set('run', runs[0]!.id);
    window.history.replaceState(null, '', location);
    await follow(runs[0]!, setOriginal);
  }

  async function inspect() {
    const { issue } = await api.diagnose(original!.id);
    setIssue(issue);
    const { repair } = await api.proposeRepair(issue.id);
    setRepair(repair);
  }

  async function apply() {
    const result = await api.applyRepair(repair!.id);
    setRepair(result.repair);
    if (!result.storefrontReady)
      throw new Error(
        'Repair applied, but the store has not reloaded. Restart it with pnpm dev:store before running the rematch.',
      );
  }

  async function rerun() {
    setComparison(undefined);
    const { run } = await api.rematch(original!.id);
    const finished = await follow(run, setRematch);
    const { comparison } = await api.compare(original!.id, finished.id);
    setComparison(comparison);
  }

  const active = rematch ?? original;
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <p className="text-xs uppercase tracking-widest text-[var(--accent)]">
        Live structured commerce test
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Can your store sell the right variant?</h1>
      <p className="mt-3 max-w-2xl text-[var(--muted)]">
        Gamma reads the catalog, requests a medium hoodie, and checks what actually lands in the
        cart. Inspect the evidence, connect your GitHub repository, or try the demo repair.
      </p>

      <section className={panel}>
        <h2 className="text-sm text-[var(--muted)]">Preset mission · Northwind Threads</h2>
        <p className="mt-2 text-lg">
          Find a black hoodie in medium under $60, add one to the cart, and reach checkout.
        </p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Real HTTP requests · Separate cart per run · No API key needed · Stops before placing an
          order
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className={button + ' bg-[var(--accent)] text-white'}
            disabled={!!busy}
            onClick={() => perform('Running Gamma...', start)}
          >
            Run Gamma test
          </button>
          <a href="http://localhost:5000" target="_blank" rel="noreferrer" className={button}>
            Open demo store
          </a>
        </div>
      </section>

      <div aria-live="polite" className="mt-4 text-sm">
        {busy && (
          <p role="status" className="text-[var(--accent)]">
            {busy}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-400/30 bg-red-400/10 p-4 text-red-300"
          >
            {error}
          </p>
        )}
      </div>

      {original && (
        <section className="mt-6 grid gap-4 md:grid-cols-2">
          {[
            { title: 'Original run', run: original },
            { title: 'Rematch', run: rematch },
          ].map(({ title, run }) => (
            <div
              key={title}
              className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5"
            >
              <div className="flex justify-between gap-4">
                <h2 className="font-semibold">{title}</h2>
                <span style={{ color: color(run?.status ?? '') }}>
                  {run?.status ?? 'Awaiting repair'}
                </span>
              </div>
              <p className="mt-2 break-all text-xs text-[var(--muted)]">
                {run?.id ?? 'Apply a repair and run the same mission again.'}
              </p>
              {run?.errorMessage && <p className="mt-3 text-red-300">{run.errorMessage}</p>}
              {run?.verification?.observedCart?.items.map((item, index) => (
                <p key={index} className="mt-4 text-sm">
                  Cart: <strong>{item.variantId}</strong> · size {item.attributes.size} · $
                  {item.unitPrice.toFixed(2)}
                </p>
              ))}
            </div>
          ))}
        </section>
      )}

      {active?.verification && (
        <section className={panel + ' overflow-x-auto'}>
          <h2 className="font-semibold">
            {comparison ? 'Before / after comparison' : 'Compatibility report'}
          </h2>
          {comparison && (
            <p className="mt-2 text-sm text-[var(--muted)]">
              {comparison.improved} checkpoints improved · {comparison.regressed} regressed ·{' '}
              {comparison.unchanged} unchanged
            </p>
          )}
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-[var(--muted)]">
                <th className="py-3">Checkpoint</th>
                <th className="px-3">{comparison ? 'Before' : 'Status'}</th>
                {comparison && <th className="px-3">After</th>}
                <th className="px-3">{comparison ? 'Change' : 'Observed detail'}</th>
              </tr>
            </thead>
            <tbody>
              {comparison
                ? comparison.deltas.map((delta) => (
                    <tr key={delta.id} className="border-t border-[var(--line)]">
                      <td className="py-3">{CHECKPOINT_LABELS[delta.id]}</td>
                      <td className="px-3" style={{ color: color(delta.before) }}>
                        {delta.before}
                      </td>
                      <td className="px-3" style={{ color: color(delta.after) }}>
                        {delta.after}
                      </td>
                      <td className="px-3">{delta.change}</td>
                    </tr>
                  ))
                : active.verification.checkpoints.map((checkpoint) => (
                    <tr key={checkpoint.id} className="border-t border-[var(--line)]">
                      <td className="py-3">{CHECKPOINT_LABELS[checkpoint.id]}</td>
                      <td className="px-3" style={{ color: color(checkpoint.status) }}>
                        {checkpoint.status.replaceAll('_', ' ')}
                      </td>
                      <td className="max-w-md px-3 text-[var(--muted)]">
                        {checkpoint.detail ?? 'Verified from the checkout response.'}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </section>
      )}

      {original?.status === 'failed' && (
        <RepositoryConnectionPanel
          key={original.id}
          runId={original.id}
          failedCount={
            original.verification?.checkpoints.filter(
              (checkpoint) => checkpoint.status === 'failed',
            ).length ?? 0
          }
        />
      )}

      {original?.verification && (
        <section className={panel}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-semibold">Evidence & demo repair</h2>
            {original.status === 'failed' && !repair && (
              <button
                className={button}
                disabled={!!busy}
                onClick={() => perform('Inspecting evidence and source...', inspect)}
              >
                Inspect failure & propose repair
              </button>
            )}
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Evidence below comes from the original live run. The targeted hoodie diagnosis and
            repair use a deterministic rule.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {original.evidence.map((evidence) => (
              <details
                key={evidence.id}
                className="min-w-0 rounded-lg border border-[var(--line)] p-3"
              >
                <summary className="cursor-pointer text-sm">{evidence.label}</summary>
                <pre className="mt-3 max-h-80 overflow-auto text-xs text-[var(--muted)]">
                  {JSON.stringify(evidence.data, null, 2)}
                </pre>
              </details>
            ))}
          </div>
          {issue && (
            <div className="mt-5 border-t border-[var(--line)] pt-5">
              <h3 className="font-medium">{issue.title}</h3>
              <p className="mt-2 text-sm">
                <strong>Observed:</strong> {issue.observed}
              </p>
              <p className="mt-2 text-sm text-[var(--muted)]">
                <strong>Cause:</strong> {issue.inferredCause}
              </p>
            </div>
          )}
          {repair && (
            <div className="mt-5">
              <h3 className="font-medium">{repair.summary}</h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                This demo diff edits the bundled Northwind storefront. Its dev server reloads the
                change.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-black/30 p-4 text-xs">
                {repair.diff}
              </pre>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  className={button}
                  disabled={!!busy || repair.status === 'applied'}
                  onClick={() => perform('Applying repair and waiting for store reload...', apply)}
                >
                  {repair.status === 'applied' ? 'Repair applied' : 'Apply reviewed repair'}
                </button>
                <button
                  className={button}
                  disabled={!!busy || repair.status !== 'applied'}
                  onClick={() => perform('Running rematch...', rerun)}
                >
                  Run rematch
                </button>
              </div>
            </div>
          )}
          {original.status === 'passed' && (
            <p className="mt-4 text-sm text-[var(--pass)]">
              The store already satisfies this mission. No repair is needed.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
