import type { ConnectRepositoryRequest, Mission } from '@agentproof/shared';

/**
 * The four-step flow as a pure state machine. Timed simulations (the derive beat, the code
 * read) are effects in flow.tsx; the reducer only moves between states.
 */
export type FlowStep = 'store' | 'scan' | 'findings' | 'fixes';

export const FLOW_STEPS: readonly FlowStep[] = ['store', 'scan', 'findings', 'fixes'];

export const FLOW_LABELS: Record<FlowStep, string> = {
  store: 'Store',
  scan: 'Scan',
  findings: 'Findings',
  fixes: 'Fixes',
};

export type FlowState =
  | {
      step: 'store';
      url: string;
      phase: 'idle' | 'deriving' | 'derived';
      mission?: Mission;
      editing: boolean;
    }
  | { step: 'scan'; phase: 'running' | 'done' }
  | { step: 'findings'; connect: 'closed' | 'open' | 'submitting' }
  | { step: 'fixes'; phase: 'reading' | 'ready'; request?: ConnectRepositoryRequest };

export type FlowEvent =
  | { type: 'URL_CHANGED'; url: string }
  | { type: 'URL_SUBMITTED' }
  | { type: 'MISSION_DERIVED'; mission: Mission }
  | { type: 'EDIT_TOGGLED' }
  | { type: 'CONFIRMED' }
  | { type: 'SCAN_FINISHED' }
  | { type: 'CONTINUE' }
  | { type: 'CONNECT_OPENED' }
  | { type: 'CONNECT_SUBMITTED'; request: ConnectRepositoryRequest }
  | { type: 'REPOSITORY_READ' }
  | { type: 'JUMP'; step: FlowStep };

export function stepIndex(step: FlowStep): number {
  return FLOW_STEPS.indexOf(step);
}

export function isCompleted(current: FlowStep, step: FlowStep): boolean {
  return stepIndex(step) < stepIndex(current);
}

/** A state for any step, with earlier work treated as done. Used by JUMP and ?step=. */
export function initialFlow(step: FlowStep = 'store'): FlowState {
  switch (step) {
    case 'store':
      return { step: 'store', url: '', phase: 'idle', editing: false };
    case 'scan':
      return { step: 'scan', phase: 'running' };
    case 'findings':
      return { step: 'findings', connect: 'closed' };
    case 'fixes':
      return { step: 'fixes', phase: 'ready' };
  }
}

export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  if (event.type === 'JUMP') return initialFlow(event.step);

  switch (state.step) {
    case 'store':
      switch (event.type) {
        case 'URL_CHANGED':
          return state.phase === 'idle' ? { ...state, url: event.url } : state;
        case 'URL_SUBMITTED':
          return state.phase === 'idle' && state.url.trim() !== ''
            ? { ...state, phase: 'deriving' }
            : state;
        case 'MISSION_DERIVED':
          return state.phase === 'deriving'
            ? { ...state, phase: 'derived', mission: event.mission }
            : state;
        case 'EDIT_TOGGLED':
          return state.phase === 'derived' ? { ...state, editing: !state.editing } : state;
        case 'CONFIRMED':
          return state.phase === 'derived' ? { step: 'scan', phase: 'running' } : state;
        default:
          return state;
      }
    case 'scan':
      switch (event.type) {
        case 'SCAN_FINISHED':
          return { step: 'scan', phase: 'done' };
        case 'CONTINUE':
          return state.phase === 'done' ? { step: 'findings', connect: 'closed' } : state;
        default:
          return state;
      }
    case 'findings':
      switch (event.type) {
        case 'CONNECT_OPENED':
          return { step: 'findings', connect: 'open' };
        case 'CONNECT_SUBMITTED':
          return { step: 'fixes', phase: 'reading', request: event.request };
        default:
          return state;
      }
    case 'fixes':
      switch (event.type) {
        case 'REPOSITORY_READ':
          return { ...state, phase: 'ready' };
        default:
          return state;
      }
  }
}
