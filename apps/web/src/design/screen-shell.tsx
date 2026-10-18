import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Frame every sandbox screen renders inside: the screen name, where it sits in the
 * user flow, which fixture it renders, what it must show, and a dashed area to design in.
 * Sandbox only; see src/design/README.md.
 */
export type ScreenShellProps = {
  name: string;
  /** Where the screen sits in the user flow, e.g. "Step 1: launch". */
  step: string;
  /** Name of the fixture export the screen renders. */
  fixture: string;
  /** From the screen inventory in docs/DESIGN.md. */
  mustShow: readonly string[];
  children?: ReactNode;
};

export function ScreenShell({ name, step, fixture, mustShow, children }: ScreenShellProps) {
  return (
    <main className="mx-auto max-w-[1440px] px-6 py-6">
      <nav className="mb-4 text-sm text-[var(--muted)]">
        <Link href="/design" className="hover:text-[var(--foreground)]">
          Design sandbox
        </Link>
        <span className="mx-2">/</span>
        <span>{name}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <p className="text-sm text-[var(--muted)]">
          {step}
          <span className="mx-2">·</span>
          fixture <code className="rounded bg-[var(--panel)] px-1">{fixture}</code>
        </p>
      </header>

      <section className="mb-6 rounded-md border border-[var(--line)] bg-[var(--panel)] p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          Must show
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {mustShow.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="min-h-[520px] rounded-md border border-dashed border-[var(--line)] p-6">
        {children ?? <p className="text-sm text-[var(--muted)]">Design goes here.</p>}
      </section>
    </main>
  );
}
