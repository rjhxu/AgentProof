'use client';

import { motion, useReducedMotion } from 'motion/react';

/**
 * One small line illustration per step, drawn in code: 64 x 64, paths only, stroked in
 * currentColor so the parent sets the colour. Each path draws itself in on mount.
 */
export type MarkProps = { size?: number; className?: string; draw?: boolean };

function Mark({ size = 80, className, draw = true, paths }: MarkProps & { paths: string[] }) {
  const reduce = useReducedMotion();
  const animate = draw && !reduce;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths.map((d, i) =>
        animate ? (
          <motion.path
            key={i}
            d={d}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.7, delay: i * 0.07, ease: 'easeOut' }}
          />
        ) : (
          <path key={i} d={d} />
        ),
      )}
    </svg>
  );
}

/** An address bar over a shop with an awning. */
export function StoreMark(props: MarkProps) {
  return (
    <Mark
      {...props}
      paths={[
        'M8 8h48a2 2 0 0 1 2 2v8H6v-8a2 2 0 0 1 2-2z',
        'M12 13h.01M18 13h20',
        'M10 30h44l4 8H6z',
        'M6 38q3.25 4 6.5 0q3.25 4 6.5 0q3.25 4 6.5 0q3.25 4 6.5 0q3.25 4 6.5 0q3.25 4 6.5 0q3.25 4 6.5 0q3.25 4 6.5 0',
        'M10 40v16h44V40',
        'M28 56v-9h8v9',
        'M16 46h6M42 46h6',
      ]}
    />
  );
}

/** Three lanes converging on a cart, with a magnifier above. */
export function ScanMark(props: MarkProps) {
  return (
    <Mark
      {...props}
      paths={[
        'M6 20h18l10 12',
        'M6 32h28',
        'M6 44h18l10-12',
        'M38 28h4l3 12h12l3-8H46',
        'M47 46a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
        'M55 46a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
        'M42 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0',
        'M52.5 16.5l5 5',
      ]}
    />
  );
}

/** A card with lines, a row of chips with one flagged, and a flag. */
export function FindingsMark(props: MarkProps) {
  return (
    <Mark
      {...props}
      paths={[
        'M12 8h40a2 2 0 0 1 2 2v44a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
        'M18 20h18M18 28h28',
        'M18 38h8v7h-8zM30 38h8v7h-8zM42 38h8v7h-8z',
        'M32 40l4 3M36 40l-4 3',
        'M30 49h8',
        'M44 14v10M44 14h8l-2 3 2 3h-8',
      ]}
    />
  );
}

/** A document with a removed and an added line, and a branch node. */
export function FixesMark(props: MarkProps) {
  return (
    <Mark
      {...props}
      paths={[
        'M14 8h26l10 10v38H14z',
        'M40 8v10h10',
        'M20 28h4M28 28h16',
        'M20 38h4M22 36v4M28 38h16',
        'M28 46h12',
        'M50 52a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
        'M54 48v-6',
      ]}
    />
  );
}
