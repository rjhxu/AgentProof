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
  /** Why the last submit did not go through, in one line under the form. */
  error?: string;
  /**
   * The mission text, when the page controls it (the live page sends it with the next submit
   * and as the edited mission). Without `onPromptChange` the "Change" textarea keeps its own.
   */
  prompt?: string;
  onPromptChange?: (prompt: string) => void;
  /** Ask what to buy under the address: the store published no product feed to derive it from. */
  promptVisible?: boolean;
  /** The runs are being created: the confirm button waits. */
  starting?: boolean;
  /** Offered beside "Change" once a mission is derived: back to an empty address field. */
  onReset?: () => void;
};

const FIELD =
  'w-full rounded-md border border-[var(--line-strong)] bg-[var(--background)] text-[15px] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent-soft)] read-only:bg-[var(--panel)] read-only:text-[var(--muted)]';
const PRIMARY =
  'inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-5 text-[15px] font-medium text-[var(--accent-ink)] transition hover:opacity-90';

const PROMPT_PLACEHOLDER =
  'Find a black hoodie in medium for less than $60, add it to the cart, and reach checkout.';

/** Step 1: one field, one button, then the derived mission and one more button. */
export function StoreStep(p: StoreStepProps) {
  const locked = p.phase !== 'idle';
  const controlled = p.onPromptChange !== undefined;
  return (
    <div>
      <StepHeader
        mark={<StoreMark />}
        title="Test your store with AI shoppers"
        subtitle="Paste your store's address. Four AI shoppers will try to buy something and tell you what got in their way."
      />

      {/* noValidate: the page normalises the address itself and says what is missing. */}
      <form
        className="mx-auto mt-8 max-w-[640px]"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <div className="flex gap-2">
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
            className={`${FIELD} h-12 min-w-0 flex-1 px-4`}
          />
          <button
            type="submit"
            disabled={locked || p.url.trim() === ''}
            className={`${PRIMARY} h-12 shrink-0 disabled:opacity-50`}
          >
            {p.phase === 'deriving' ? <SpinnerIcon /> : null}
            {p.phase === 'deriving' ? 'Reading your store' : 'Scan my store'}
          </button>
        </div>
        {p.promptVisible && p.phase !== 'derived' ? (
          <label className="mt-3 block text-sm" htmlFor="store-prompt">
            <span className="text-[var(--muted)]">What should the shoppers buy?</span>
            <textarea
              id="store-prompt"
              rows={2}
              placeholder={PROMPT_PLACEHOLDER}
              value={p.prompt ?? ''}
              readOnly={locked}
              onChange={(e) => p.onPromptChange?.(e.target.value)}
              className={`${FIELD} mt-1 p-3`}
            />
          </label>
        ) : null}
        {p.error ? (
          <p role="alert" className="mt-2 text-[13px] leading-snug text-[var(--fail)]">
            {p.error}
          </p>
        ) : null}
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
                {controlled ? (
                  <textarea
                    value={p.prompt ?? ''}
                    onChange={(e) => p.onPromptChange?.(e.target.value)}
                    rows={2}
                    className={`${FIELD} mt-1 p-3`}
                  />
                ) : (
                  <textarea
                    defaultValue={p.mission.rawPrompt}
                    rows={2}
                    className={`${FIELD} mt-1 p-3`}
                  />
                )}
              </label>
            ) : null}
            <div className="mt-5 flex items-center gap-4">
              <button
                type="button"
                onClick={p.onConfirm}
                disabled={p.starting}
                className={`${PRIMARY} h-11 disabled:opacity-60`}
              >
                {p.starting ? <SpinnerIcon /> : null}
                {p.starting ? 'Starting the scan' : 'Start the scan'}
                {p.starting ? null : <ArrowRightIcon />}
              </button>
              <button
                type="button"
                onClick={p.onToggleEdit}
                className="text-sm text-[var(--muted)] underline-offset-4 hover:underline"
              >
                {p.editing ? 'Keep it' : 'Change'}
              </button>
              {p.onReset ? (
                <button
                  type="button"
                  onClick={p.onReset}
                  className="text-sm text-[var(--muted)] underline-offset-4 hover:underline"
                >
                  Scan a different store
                </button>
              ) : null}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
