'use client';

import { CrossIcon } from '../design/flow/icons';

/** A slim bar along the bottom for an error that is not about one field: what failed, and Dismiss. */
export function ErrorBar({
  message,
  onDismiss,
}: {
  message: string | undefined;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--fail)] bg-[var(--background)] text-[var(--foreground)]"
    >
      <div className="mx-auto flex max-w-[880px] items-center gap-3 px-6 py-2.5 text-[13px]">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--fail)] text-white">
          <CrossIcon size={10} />
        </span>
        <span className="min-w-0 flex-1 truncate" title={message}>
          {message}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[var(--muted)] underline-offset-4 hover:underline"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
