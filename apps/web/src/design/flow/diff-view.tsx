'use client';

import { useState } from 'react';

import { classifyDiffLine, type DiffLineKind } from './diff-lines';
import { CheckIcon, CopyIcon } from './icons';

const ROW: Record<DiffLineKind, string> = {
  meta: 'text-[var(--muted)]',
  hunk: 'text-[var(--muted)] bg-[var(--panel)]',
  add: 'bg-[var(--accent-soft)]',
  del: 'bg-[var(--fail-soft)]',
  ctx: '',
};

const GUTTER: Record<DiffLineKind, string> = {
  meta: '',
  hunk: '',
  add: '+',
  del: '−',
  ctx: '',
};

/** Long patches open folded; the first lines say what changes, the rest is a click away. */
const FOLDED_LINES = 14;

/** A unified diff, one row per line, with a gutter and a copy button. */
export function DiffView({ diff }: { diff: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lines = diff.replace(/\n$/, '').split('\n');
  const folded = !expanded && lines.length > FOLDED_LINES + 4;
  const visible = folded ? lines.slice(0, FOLDED_LINES) : lines;

  async function copy() {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable; nothing to do in the sandbox
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--line)]">
      <div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--panel)] px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Patch</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium hover:bg-[var(--panel-2)]"
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? 'Copied' : 'Copy patch'}
        </button>
      </div>
      <pre className="thin-scroll overflow-x-auto bg-[var(--background)] py-2 text-[12.5px] leading-[1.6]">
        {visible.map((line, i) => {
          const kind = classifyDiffLine(line);
          const text = kind === 'add' || kind === 'del' ? line.slice(1) : line;
          return (
            <div key={i} className={`grid grid-cols-[28px_1fr] ${ROW[kind]}`}>
              <span className="select-none text-center text-[var(--muted)]">{GUTTER[kind]}</span>
              <code className="whitespace-pre pr-4">{text}</code>
            </div>
          );
        })}
      </pre>
      {folded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-[var(--line)] bg-[var(--panel)] py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Show all {lines.length} lines
        </button>
      ) : null}
    </div>
  );
}
