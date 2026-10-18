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

describe('flow machine', () => {
  it('walks the happy path in order', () => {
    const afterStore = run([
      { type: 'URL_CHANGED', url: 'https://shop.example' },
      { type: 'URL_SUBMITTED' },
      { type: 'MISSION_DERIVED', mission: hoodieMission },
    ]);
    expect(afterStore).toMatchObject({ step: 'store', phase: 'derived' });

    const scanning = reduceFlow(afterStore, { type: 'CONFIRMED' });
    expect(scanning).toEqual({ step: 'scan', phase: 'running' });

    const findings = run([{ type: 'SCAN_FINISHED' }, { type: 'CONTINUE' }], scanning);
    expect(findings).toEqual({ step: 'findings', connect: 'closed' });

    const fixes = run(
      [
        { type: 'CONNECT_OPENED' },
        {
          type: 'CONNECT_SUBMITTED',
          request: { url: 'https://github.com/northwind/storefront', consent: true },
        },
        { type: 'REPOSITORY_READ' },
      ],
      findings,
    );
    expect(fixes).toMatchObject({ step: 'fixes', phase: 'ready' });
  });

  it('ignores events that do not apply to the current phase', () => {
    expect(run([{ type: 'URL_SUBMITTED' }])).toEqual(initialFlow());
    expect(run([{ type: 'CONFIRMED' }])).toEqual(initialFlow());
    expect(reduceFlow({ step: 'scan', phase: 'running' }, { type: 'CONTINUE' })).toEqual({
      step: 'scan',
      phase: 'running',
    });
  });

  it('jumps to any step with earlier work treated as done', () => {
    expect(reduceFlow(initialFlow(), { type: 'JUMP', step: 'fixes' })).toEqual({
      step: 'fixes',
      phase: 'ready',
    });
    expect(isCompleted('findings', 'scan')).toBe(true);
    expect(isCompleted('scan', 'findings')).toBe(false);
  });
});
