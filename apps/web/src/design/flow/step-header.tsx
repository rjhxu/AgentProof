import type { ReactNode } from 'react';

/** The opening of every step: the illustration, one line of title, one line of context. */
export function StepHeader({
  mark,
  title,
  subtitle,
}: {
  mark: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="text-[var(--accent)]">{mark}</div>
      <h1 className="mt-4 text-[28px] font-semibold leading-tight tracking-tight">{title}</h1>
      {subtitle ? (
        <p className="mt-2 max-w-[560px] text-[15px] leading-relaxed text-[var(--muted)]">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
