'use client';

import { motion } from 'motion/react';

import { FLOW_LABELS, FLOW_STEPS, stepIndex, type FlowStep } from './flow-machine';
import { CheckIcon } from './icons';

export type StepperProps = {
  current: FlowStep;
  /** Work is in progress on the current step: the active node breathes. */
  busy: boolean;
  /** Completed steps are clickable to look back. */
  onJump: (step: FlowStep) => void;
};

/** The minimal header: the wordmark and the four-step pipeline. */
export function Stepper({ current, busy, onJump }: StepperProps) {
  const currentIndex = stepIndex(current);
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--background)]/90 backdrop-blur">
      <div className="mx-auto flex max-w-[880px] items-center justify-between px-6 py-3">
        <span className="text-sm font-semibold tracking-tight">AgentProof</span>
        <ol className="flex items-center" aria-label="Progress">
          {FLOW_STEPS.map((step, i) => {
            const done = i < currentIndex;
            const active = i === currentIndex;
            return (
              <li key={step} className="flex items-center">
                {i > 0 ? (
                  <span className="relative mx-1 h-px w-8 overflow-hidden bg-[var(--line)]">
                    <motion.span
                      className="absolute inset-y-0 left-0 bg-[var(--accent)]"
                      initial={false}
                      animate={{ width: done || active ? '100%' : '0%' }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                    />
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={!done}
                  onClick={() => onJump(step)}
                  aria-current={active ? 'step' : undefined}
                  className="relative flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium disabled:cursor-default"
                >
                  {active ? (
                    <motion.span
                      layoutId="stepper-active"
                      className="absolute inset-0 rounded-full bg-[var(--accent-soft)]"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  ) : null}
                  <span
                    className={[
                      'relative flex h-5 w-5 items-center justify-center rounded-full border text-[10px] tabular-nums',
                      done
                        ? 'border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]'
                        : active
                          ? 'border-[var(--accent)] text-[var(--accent)]'
                          : 'border-[var(--line-strong)] text-[var(--muted)]',
                    ].join(' ')}
                  >
                    {done ? <CheckIcon size={11} /> : i + 1}
                    {active && busy ? (
                      <motion.span
                        className="absolute inset-0 rounded-full border border-[var(--accent)]"
                        animate={{ scale: [1, 1.7], opacity: [0.6, 0] }}
                        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
                      />
                    ) : null}
                  </span>
                  <span
                    className={[
                      'relative',
                      active
                        ? 'text-[var(--accent)]'
                        : done
                          ? 'text-[var(--foreground)]'
                          : 'text-[var(--muted)]',
                    ].join(' ')}
                  >
                    {FLOW_LABELS[step]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </header>
  );
}
