import { describe, expect, it } from 'vitest';

import { hoodieMission } from '@agentproof/shared/fixtures';

import {
  initialFlow,
  isCompleted,
  reduceFlow,
  type FlowEvent,
  type FlowState,
} from './flow-machine';

function run(events: FlowEvent[], from: FlowState = initialFlow()): FlowState {
  return events.reduce(reduceFlow, from);
}

const derived = run([
  { type: 'URL_CHANGED', url: 'https://shop.example' },
  { type: 'URL_SUBMITTED' },
  { type: 'MISSION_DERIVED', mission: hoodieMission },
]);

describe('flow machine', () => {
  it('walks the happy path in order', () => {
    expect(derived).toEqual({
      step: 'store',
      url: 'https://shop.example',
      phase: 'derived',
      mission: hoodieMission,
      editing: false,
    });

    const scanning = reduceFlow(derived, { type: 'CONFIRMED' });
    expect(scanning).toEqual({ step: 'scan', phase: 'running' });

    const findings = reduceFlow(scanning, { type: 'SCAN_FINISHED' });
    expect(findings).toEqual({ step: 'findings' });
    expect(reduceFlow({ step: 'scan', phase: 'done' }, { type: 'CONTINUE' })).toEqual(findings);
    expect(reduceFlow(scanning, { type: 'CONTINUE' })).toEqual(scanning);
    expect(reduceFlow(findings, { type: 'CONNECT_SUBMITTED' })).toBe(findings);

    const connect = reduceFlow(findings, { type: 'CONTINUE' });
    expect(connect).toEqual({ step: 'fixes', phase: 'connect' });
    const submitting = reduceFlow(connect, { type: 'CONNECT_SUBMITTED' });
    expect(submitting).toEqual({ step: 'fixes', phase: 'submitting' });

    const reading = reduceFlow(submitting, { type: 'REPOSITORY_CONNECTED' });
    expect(reading).toEqual({ step: 'fixes', phase: 'reading' });
    expect(reduceFlow(reading, { type: 'REPOSITORY_READ' })).toEqual({
      step: 'fixes',
      phase: 'ready',
    });
  });

  it('returns a failed connection to the connect form, and only from submitting', () => {
    const submitting: FlowState = { step: 'fixes', phase: 'submitting' };
    expect(reduceFlow(submitting, { type: 'CONNECT_FAILED' })).toEqual({
      step: 'fixes',
      phase: 'connect',
    });
    const connect: FlowState = { step: 'fixes', phase: 'connect' };
    expect(reduceFlow(connect, { type: 'CONNECT_FAILED' })).toBe(connect);
    expect(reduceFlow(connect, { type: 'REPOSITORY_CONNECTED' })).toBe(connect);
    const ready: FlowState = { step: 'fixes', phase: 'ready' };
    expect(reduceFlow(ready, { type: 'CONNECT_SUBMITTED' })).toBe(ready);
    expect(reduceFlow(submitting, { type: 'CONNECT_SUBMITTED' })).toBe(submitting);
  });

  it('goes back to idle with the URL kept when deriving fails', () => {
    const deriving = run([
      { type: 'URL_CHANGED', url: 'https://shop.example' },
      { type: 'URL_SUBMITTED' },
    ]);
    expect(deriving).toMatchObject({ step: 'store', phase: 'deriving' });
    expect(reduceFlow(deriving, { type: 'DERIVE_FAILED' })).toEqual({
      step: 'store',
      url: 'https://shop.example',
      phase: 'idle',
      editing: false,
    });
    expect(reduceFlow(derived, { type: 'DERIVE_FAILED' })).toBe(derived);
  });

  it('rederives with the mission kept and the editor closed', () => {
    const editing = reduceFlow(derived, { type: 'EDIT_TOGGLED' });
    expect(editing).toMatchObject({ phase: 'derived', editing: true });
    const rederiving = reduceFlow(editing, { type: 'REDERIVE' });
    expect(rederiving).toEqual({
      step: 'store',
      url: 'https://shop.example',
      phase: 'deriving',
      mission: hoodieMission,
      editing: false,
    });
    const changed = { ...hoodieMission, rawPrompt: 'a grey hoodie in large' };
    expect(reduceFlow(rederiving, { type: 'MISSION_DERIVED', mission: changed })).toEqual({
      step: 'store',
      url: 'https://shop.example',
      phase: 'derived',
      mission: changed,
      editing: false,
    });
    expect(reduceFlow(initialFlow(), { type: 'REDERIVE' })).toEqual(initialFlow());
  });

  it('ignores events that do not apply to the current phase', () => {
    expect(run([{ type: 'URL_SUBMITTED' }])).toEqual(initialFlow());
    expect(run([{ type: 'CONFIRMED' }])).toEqual(initialFlow());
    expect(reduceFlow({ step: 'scan', phase: 'running' }, { type: 'CONTINUE' })).toEqual({
      step: 'scan',
      phase: 'running',
    });
    const ready: FlowState = { step: 'fixes', phase: 'ready' };
    expect(reduceFlow(ready, { type: 'REPOSITORY_READ' })).toBe(ready);
    expect(reduceFlow(derived, { type: 'URL_CHANGED', url: 'x' })).toBe(derived);
  });

  it('jumps to any step with earlier work treated as done', () => {
    expect(reduceFlow(initialFlow(), { type: 'JUMP', step: 'fixes' })).toEqual({
      step: 'fixes',
      phase: 'ready',
    });
    expect(
      reduceFlow(initialFlow(), {
        type: 'JUMP',
        step: 'fixes',
        context: { fixesReading: true },
      }),
    ).toEqual({ step: 'fixes', phase: 'reading' });
    expect(reduceFlow(initialFlow(), { type: 'JUMP', step: 'scan' })).toEqual({
      step: 'scan',
      phase: 'running',
    });
    expect(
      reduceFlow(initialFlow(), { type: 'JUMP', step: 'scan', context: { scanDone: true } }),
    ).toEqual({ step: 'scan', phase: 'done' });
    expect(isCompleted('findings', 'scan')).toBe(true);
    expect(isCompleted('scan', 'findings')).toBe(false);
  });

  it('jumps back to the store step with its context', () => {
    expect(
      reduceFlow(
        { step: 'scan', phase: 'done' },
        { type: 'JUMP', step: 'store', context: { mission: hoodieMission } },
      ),
    ).toEqual({
      step: 'store',
      url: hoodieMission.storeUrl,
      phase: 'derived',
      mission: hoodieMission,
      editing: false,
    });
    expect(initialFlow('store', { url: 'https://shop.example' })).toEqual({
      step: 'store',
      url: 'https://shop.example',
      phase: 'idle',
      editing: false,
    });
    expect(initialFlow('store', { url: 'https://typed.example', mission: hoodieMission })).toEqual({
      step: 'store',
      url: 'https://typed.example',
      phase: 'derived',
      mission: hoodieMission,
      editing: false,
    });
    expect(initialFlow('store')).toEqual({ step: 'store', url: '', phase: 'idle', editing: false });
    expect(initialFlow('store', { mission: hoodieMission, editing: true })).toEqual({
      step: 'store',
      url: hoodieMission.storeUrl,
      phase: 'derived',
      mission: hoodieMission,
      editing: true,
    });
  });

  it('confirms a scan straight from deriving', () => {
    const deriving = run([
      { type: 'URL_CHANGED', url: 'https://shop.example' },
      { type: 'URL_SUBMITTED' },
    ]);
    expect(reduceFlow(deriving, { type: 'CONFIRMED' })).toEqual({
      step: 'scan',
      phase: 'running',
    });
  });
});
