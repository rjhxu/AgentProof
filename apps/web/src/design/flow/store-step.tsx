'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { Mission } from '@agentproof/shared';

import { describeMission } from '../format';
import { ArrowRightIcon, SpinnerIcon } from './icons';
import { StoreMark } from './illustrations';
import { StepHeader } from './step-header';

export type StoreStepProps = {
  url: string;
  phase: 'idle' | 'deriving' | 'derived';
  mission?: Mission;
  editing: boolean;
  onUrlChange: (url: string) => void;
  onSubmit: () => void;
  onToggleEdit: () => void;
  onConfirm: () => void;
};

/** Step 1: one field, one button, then the derived mission and one more button. */
export function StoreStep(p: StoreStepProps) {
  const locked = p.phase !== 'idle';
  return (
    <div>
      <StepHeader
        mark={<StoreMark />}
        title="Test your store with AI shoppers"
        subtitle="Paste your store's address. Four AI shoppers will try to buy something and tell you what got in their way."
      />

      <form
        className="mx-auto mt-8 flex max-w-[640px] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <label className="sr-only" htmlFor="store-url">
          Store URL
        </label>
        <input
          id="store-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://your-store.com"
          value={p.url}
          readOnly={locked}
          onChange={(e) => p.onUrlChange(e.target.value)}
          className="h-12 min-w-0 flex-1 rounded-md border border-[var(--line-strong)] bg-[var(--background)] px-4 text-[15px] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)] read-only:bg-[var(--panel)] read-only:text-[var(--muted)]"
        />
        <button
          type="submit"
          disabled={locked || p.url.trim() === ''}
          className="inline-flex h-12 shrink-0 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90 disabled:opacity-50"
        >
          {p.phase === 'deriving' ? <SpinnerIcon /> : null}
          {p.phase === 'deriving' ? 'Reading your store' : 'Scan my store'}
        </button>
      </form>

      <AnimatePresence>
        {p.phase === 'derived' && p.mission ? (
          <motion.section
            key="mission"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="mx-auto mt-6 max-w-[640px] rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
              Derived from your store
            </p>
            <p className="mt-2 text-[17px] leading-relaxed">
              We will try to buy <strong>{describeMission(p.mission)}</strong>, and stop at checkout
              without paying.
            </p>
            {p.editing ? (
              <label className="mt-4 block text-sm">
                <span className="text-[var(--muted)]">Tell the shoppers what to buy instead</span>
                <textarea
                  defaultValue={p.mission.rawPrompt}
                  rows={2}
                  className="mt-1 w-full rounded-md border border-[var(--line-strong)] bg-[var(--background)] p-3 text-[15px] outline-none focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)]"
                />
              </label>
            ) : null}
            <div className="mt-5 flex items-center gap-4">
              <button
                type="button"
                onClick={p.onConfirm}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90"
              >
                Start the scan
                <ArrowRightIcon />
              </button>
              <button
                type="button"
                onClick={p.onToggleEdit}
                className="text-sm text-[var(--muted)] underline-offset-4 hover:underline"
              >
                {p.editing ? 'Keep it' : 'Change'}
              </button>
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
