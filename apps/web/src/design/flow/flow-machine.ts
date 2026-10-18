import type { Mission } from '@agentproof/shared';

/**
 * The four-step flow as a pure state machine. Effects (deriving the mission, starting the runs,
 * connecting the repository, reading the code) live in the page; the reducer only moves between
 * states. No request body or token ever lives here: a credential is used once by the caller.
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
  | { step: 'findings' }
  | { step: 'fixes'; phase: 'connect' | 'submitting' | 'reading' | 'ready' };

/**
 * What a JUMP carries. The store step keeps the URL and the mission, and can open with the
 * editor already showing. A finished scan lands in review (`scanDone`) instead of replaying.
 */
export type FlowContext = {
  url?: string;
  mission?: Mission;
  editing?: boolean;
  scanDone?: boolean;
  /** JUMP to Fixes while a connected repository is still being read. */
  fixesReading?: boolean;
};

export type FlowEvent =
  | { type: 'URL_CHANGED'; url: string }
  /** idle -> deriving, when the URL is not empty */
  | { type: 'URL_SUBMITTED' }
  /** deriving -> derived */
  | { type: 'MISSION_DERIVED'; mission: Mission }
  /** deriving -> idle; the caller shows the error */
  | { type: 'DERIVE_FAILED' }
  /** derived: toggles the prompt editor */
  | { type: 'EDIT_TOGGLED' }
  /** derived -> deriving with the mission kept: the prompt changed and a new mission is being made */
  | { type: 'REDERIVE' }
  /** derived -> scan running */
  | { type: 'CONFIRMED' }
  /** scan running -> findings, once the report is in */
  | { type: 'SCAN_FINISHED' }
  /** scan review -> findings; findings -> fixes connect, before a repository exists */
  | { type: 'CONTINUE' }
  /** fixes connect -> submitting; the form is already on screen */
  | { type: 'CONNECT_SUBMITTED' }
  /** fixes submitting -> connect, with the form still showing */
  | { type: 'CONNECT_FAILED' }
  /** fixes submitting -> reading */
  | { type: 'REPOSITORY_CONNECTED' }
  /** fixes reading -> ready */
  | { type: 'REPOSITORY_READ' }
  | { type: 'JUMP'; step: FlowStep; context?: FlowContext };

export function stepIndex(step: FlowStep): number {
  return FLOW_STEPS.indexOf(step);
}

export function isCompleted(current: FlowStep, step: FlowStep): boolean {
  return stepIndex(step) < stepIndex(current);
}

/**
 * A state for any step, with earlier work treated as done. Used by JUMP and ?step=. A context
 * puts the store step back where it was: the URL typed, the mission derived.
 */
export function initialFlow(step: FlowStep = 'store', context?: FlowContext): FlowState {
  switch (step) {
    case 'store': {
      const mission = context?.mission;
      return {
        step: 'store',
        url: context?.url ?? mission?.storeUrl ?? '',
        phase: mission ? 'derived' : 'idle',
        ...(mission ? { mission } : {}),
        editing: context?.editing ?? false,
      };
    }
    case 'scan':
      return { step: 'scan', phase: context?.scanDone ? 'done' : 'running' };
    case 'findings':
      return { step: 'findings' };
    case 'fixes':
      return { step: 'fixes', phase: context?.fixesReading ? 'reading' : 'ready' };
  }
}

export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  if (event.type === 'JUMP') return initialFlow(event.step, event.context);

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
            ? { ...state, phase: 'derived', mission: event.mission, editing: false }
            : state;
        case 'DERIVE_FAILED':
          return state.phase === 'deriving'
            ? { step: 'store', url: state.url, phase: 'idle', editing: false }
            : state;
        case 'EDIT_TOGGLED':
          return state.phase === 'derived' ? { ...state, editing: !state.editing } : state;
        case 'REDERIVE':
          return state.phase === 'derived'
            ? { ...state, phase: 'deriving', editing: false }
            : state;
        case 'CONFIRMED':
          return state.phase === 'derived' || state.phase === 'deriving'
            ? { step: 'scan', phase: 'running' }
            : state;
        default:
          return state;
      }
    case 'scan':
      switch (event.type) {
        case 'SCAN_FINISHED':
          return state.phase === 'running' ? { step: 'findings' } : state;
        case 'CONTINUE':
          return state.phase === 'done' ? { step: 'findings' } : state;
        default:
          return state;
      }
    case 'findings':
      switch (event.type) {
        case 'CONTINUE':
          return { step: 'fixes', phase: 'connect' };
        default:
          return state;
      }
    case 'fixes':
      switch (event.type) {
        case 'CONNECT_SUBMITTED':
          return state.phase === 'connect' ? { step: 'fixes', phase: 'submitting' } : state;
        case 'CONNECT_FAILED':
          return state.phase === 'submitting' ? { step: 'fixes', phase: 'connect' } : state;
        case 'REPOSITORY_CONNECTED':
          return state.phase === 'submitting' ? { step: 'fixes', phase: 'reading' } : state;
        case 'REPOSITORY_READ':
          return state.phase === 'reading' ? { step: 'fixes', phase: 'ready' } : state;
        default:
          return state;
      }
  }
}
