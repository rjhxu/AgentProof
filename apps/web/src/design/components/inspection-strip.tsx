export type InspectionFinding = {
  id: string;
  severity: 'fail' | 'warn';
  text: string;
};

export type InspectionStripProps = {
  state: 'running' | 'done';
  findings: InspectionFinding[];
};

/**
 * Live-page inspection: what a fetch of the product page shows before any agent finishes
 * (structured variant ids vs the DOM, controls with no accessible name). Needs only the URL.
 * The inspector is not built yet, so the sandbox renders sample findings; see docs/DESIGN.md.
 */
export function InspectionStrip({ state, findings }: InspectionStripProps) {
  const summary =
    state === 'running'
      ? 'Inspecting the product page…'
      : `${findings.length} finding${findings.length === 1 ? '' : 's'} from the live page, before any agent finished`;
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--line)] px-4 py-2 text-sm">
      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Live page</span>
      <span className="text-[var(--muted)]">{summary}</span>
      {findings.map((finding) => {
        const color = finding.severity === 'fail' ? 'var(--fail)' : 'var(--warn)';
        return (
          <span
            key={finding.id}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs"
            style={{ borderColor: color }}
          >
            <span aria-hidden style={{ color }}>
              {finding.severity === 'fail' ? '✕' : '!'}
            </span>
            {finding.text}
          </span>
        );
      })}
    </section>
  );
}
