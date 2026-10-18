'use client';

import { FLOW_STEPS, type FlowStep } from './flow-machine';

export type DevControlsProps = {
  step: FlowStep;
  onJump: (step: FlowStep) => void;
  replay: {
    playing: boolean;
    done: boolean;
    speed: number;
    play: () => void;
    pause: () => void;
    restart: () => void;
    seekToEnd: () => void;
    setSpeed: (speed: number) => void;
  };
};

const SPEEDS = [0.5, 1, 2, 4];

/**
 * Sandbox only: jump between steps, replay the scan, change its speed. Rendered in
 * development builds only. Delete this file and its one import at wiring time.
 */
export function DevControls({ step, onJump, replay }: DevControlsProps) {
  if (process.env.NODE_ENV !== 'development') return null;
  const chip =
    'rounded-full px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--panel-2)] disabled:opacity-40';
  const active = 'bg-[var(--foreground)] text-[var(--background)] hover:bg-[var(--foreground)]';
  return (
    <div className="fixed bottom-4 right-4 z-20 flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--background)]/95 px-2 py-1 shadow-sm backdrop-blur">
      <span className="px-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">dev</span>
      {FLOW_STEPS.map((s, i) => (
        <button
          key={s}
          type="button"
          onClick={() => onJump(s)}
          className={`${chip} ${s === step ? active : ''}`}
          title={s}
        >
          {i + 1}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-[var(--line)]" />
      <button type="button" className={chip} onClick={replay.restart} title="Replay the scan">
        replay
      </button>
      <button
        type="button"
        className={chip}
        onClick={replay.playing ? replay.pause : replay.play}
        disabled={replay.done}
      >
        {replay.playing ? 'pause' : 'play'}
      </button>
      <button type="button" className={chip} onClick={replay.seekToEnd} disabled={replay.done}>
        end
      </button>
      <span className="mx-1 h-4 w-px bg-[var(--line)]" />
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => replay.setSpeed(s)}
          className={`${chip} ${replay.speed === s ? active : ''}`}
        >
          {s}×
        </button>
      ))}
    </div>
  );
}
