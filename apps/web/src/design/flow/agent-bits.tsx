'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { motion } from 'motion/react';
import type { AgentKind, ObservedCart } from '@agentproof/shared';

import { senses, targetLine, type Sense } from '../format';
import { BracesIcon, CheckIcon, CrossIcon, EyeIcon, SparkIcon, TextLinesIcon } from './icons';

/* The marks that identify a shopper and its verdict, shared by Findings and the Scan stage. */

/** One plain-language line per shopper, for labels and tooltips. */
export const DESCRIPTOR: Record<AgentKind, string> = {
  alpha_semantic: 'reads the page as text, like a screen reader',
  beta_vision: 'looks at screenshots and clicks what it sees',
  sigma_hybrid: 'reads and looks, on the strongest model',
  gamma_structured: 'checks the catalog feed against the cart API',
};

/** What a shopper perceives, as glyphs: text lines, an eye, a spark; braces for the API. */
export function SenseIcons({ kind, size = 12 }: { kind: AgentKind; size?: number }) {
  const has = senses(kind);
  if (has.includes('api')) {
    return (
      <span title={DESCRIPTOR[kind]} className="text-[var(--muted)]">
        <BracesIcon size={size} />
      </span>
    );
  }
  const all: Array<{ sense: Sense; icon: ReactNode; label: string }> = [
    { sense: 'reads', icon: <TextLinesIcon size={size} />, label: 'reads the page as text' },
    { sense: 'looks', icon: <EyeIcon size={size} />, label: 'looks at screenshots' },
    { sense: 'strongest', icon: <SparkIcon size={size} />, label: 'strongest model' },
  ];
  return (
    <span className="inline-flex items-center gap-1" aria-label={DESCRIPTOR[kind]}>
      {all.map(({ sense, icon, label }) => (
        <span
          key={sense}
          title={label}
          className={has.includes(sense) ? 'text-[var(--foreground)]' : 'text-[var(--line)]'}
        >
          {icon}
        </span>
      ))}
    </span>
  );
}

/** A 16 px verdict: ink check, red cross, a pulsing accent dot while active, hollow otherwise. */
export function VerdictMark({ status, active = false }: { status: string; active?: boolean }) {
  const base = 'flex h-4 w-4 shrink-0 items-center justify-center rounded-full';
  if (status === 'passed') {
    return (
      <span className={`${base} bg-[var(--foreground)] text-[var(--background)]`}>
        <CheckIcon size={10} />
      </span>
    );
  }
  if (status === 'failed' || status === 'error' || status === 'cancelled') {
    return (
      <span className={`${base} bg-[var(--fail)] text-white`}>
        <CrossIcon size={10} />
      </span>
    );
  }
  if (active || status === 'running' || status === 'verifying') {
    return (
      <span className={`${base} border border-[var(--accent)]`}>
        <motion.span
          className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      </span>
    );
  }
  return <span className={`${base} border border-[var(--line-strong)]`} />;
}

/**
 * An accessibility-tree snapshot with the line naming the agent's target highlighted. With
 * `follow` the hit line is scrolled into the viewport (the Scan stage, which fits the screen);
 * without it only the panel scrolls, so a page the reader is already on does not move.
 */
export function TreePanel({
  text,
  target,
  failed,
  follow = true,
  wrap = false,
}: {
  text: string | undefined;
  target: string | undefined;
  failed: boolean;
  follow?: boolean;
  /** Wrap long lines instead of scrolling sideways. Findings uses this; the Scan stage does not. */
  wrap?: boolean;
}) {
  const lines = text ? text.split('\n') : [];
  const hit = targetLine(lines, target);
  const panel = useRef<HTMLPreElement>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const line = ref.current;
    if (!line) return;
    if (follow) {
      line.scrollIntoView({ block: 'center' });
      return;
    }
    const box = panel.current;
    if (box) box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 2);
  }, [hit, text, follow]);
  if (!text) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-[var(--muted)]">
        reading the page
      </div>
    );
  }
  return (
    <pre
      ref={panel}
      className={[
        'thin-scroll relative overflow-auto p-3 font-mono text-[11px] leading-[1.5] text-[var(--foreground)]',
        wrap ? 'max-h-[320px] whitespace-pre-wrap break-words' : 'h-full',
      ].join(' ')}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          ref={i === hit ? ref : undefined}
          className={[
            '-mx-1 block rounded-sm px-1',
            wrap ? 'whitespace-pre-wrap break-words' : '',
            i === hit
              ? failed
                ? 'bg-[var(--fail-soft)] outline outline-1 outline-[var(--fail)]'
                : 'bg-[var(--accent-soft)]'
              : '',
          ].join(' ')}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

/** The cart the verifier read back through the API, line by line. */
export function CartLines({ cart, failed }: { cart: ObservedCart; failed: boolean }) {
  return (
    <ul className="mt-2 space-y-1 font-mono text-[11px] leading-snug">
      {cart.items.map((item) => (
        <li key={item.variantId} className="flex flex-wrap gap-x-2">
          <span className={failed ? 'font-semibold text-[var(--fail)]' : 'font-semibold'}>
            {item.variantId}
          </span>
          <span className="text-[var(--muted)]">
            {item.quantity} × {item.name},{' '}
            {Object.entries(item.attributes)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}
            , ${item.unitPrice.toFixed(2)}
          </span>
        </li>
      ))}
      {cart.items.length === 0 ? <li className="text-[var(--muted)]">empty cart</li> : null}
    </ul>
  );
}
