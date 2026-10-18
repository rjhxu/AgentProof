import { describe, expect, it } from 'vitest';

import { missionABugged, problemsABugged, runsABugged } from '../fixtures';
import { buildProblems } from './findings-data';
import {
  advance,
  beatsFor,
  currentBeats,
  initialWalkthrough,
  isRecap,
  nextLabel,
  reduceWalkthrough,
  retreat,
  revealedAgents,
  type Walkthrough,
} from './walkthrough';

const cards = buildProblems(missionABugged, runsABugged, problemsABugged, {}, {});
const plan = cards.map(beatsFor);

function after(w: Walkthrough, presses: number): Walkthrough {
  let out = w;
  for (let i = 0; i < presses; i++) out = advance(out);
  return out;
}

describe('beatsFor', () => {
  it('is intro, evidence, one beat per shopper in stage order, meaning, change', () => {
    expect(plan[0]!.map((b) => b.kind)).toEqual([
      'intro',
      'evidence',
      'agent',
      'agent',
      'agent',
      'agent',
      'meaning',
      'change',
    ]);
    expect(plan[0]!.flatMap((b) => (b.kind === 'agent' ? [b.agent] : []))).toEqual([
      'alpha_semantic',
      'beta_vision',
      'gamma_structured',
      'sigma_hybrid',
    ]);
  });

  it('drops the change beat when the report has no recommendation for the problem', () => {
    const { recommendation: _dropped, ...rest } = cards[0]!;
    expect(beatsFor(rest).map((b) => b.kind)).not.toContain('change');
  });
});

describe('advance and retreat', () => {
  const start = initialWalkthrough(plan);

  it('walks every beat of every problem, then the recap, then stops', () => {
    expect(start.pos).toEqual({ problem: 0, beat: 0 });
    expect(after(start, 7).pos).toEqual({ problem: 0, beat: 7 });
    expect(after(start, 8).pos).toEqual({ problem: 1, beat: 0 });
    const recap = after(start, 16);
    expect(isRecap(recap)).toBe(true);
    expect(recap.reached).toEqual({ problem: 2, beat: 0 });
    expect(after(start, 17)).toEqual(recap);
    expect(currentBeats(recap)).toEqual([]);
  });

  it('reveals the shoppers one per press', () => {
    expect(revealedAgents(after(start, 1))).toBe(0);
    expect(revealedAgents(after(start, 2))).toBe(1);
    expect(revealedAgents(after(start, 5))).toBe(4);
    expect(revealedAgents(after(start, 6))).toBe(4);
  });

  it('goes back across the problem boundary and stops at the first beat', () => {
    expect(retreat(after(start, 16)).pos).toEqual({ problem: 1, beat: 7 });
    expect(retreat(after(start, 8)).pos).toEqual({ problem: 0, beat: 7 });
    expect(retreat(start)).toEqual(start);
  });

  it('keeps the furthest position when going back', () => {
    const w = retreat(retreat(after(start, 9)));
    expect(w.pos).toEqual({ problem: 0, beat: 7 });
    expect(w.reached).toEqual({ problem: 1, beat: 1 });
  });
});

describe('nextLabel', () => {
  it('names each beat a press reveals, on the Bug A fixture', () => {
    const labels: Array<string | undefined> = [];
    let w = initialWalkthrough(plan);
    for (let i = 0; i < 17; i++) {
      labels.push(nextLabel(w));
      w = advance(w);
    }
    const problem = [
      'What did we see?',
      'How did each shopper do?',
      'Then Beta',
      'Then Gamma',
      'Then Sigma',
      'What it means',
      'What to change',
    ];
    expect(labels).toEqual([...problem, 'Next problem', ...problem, 'Wrap up', undefined]);
  });
});

describe('reduceWalkthrough', () => {
  const start = initialWalkthrough(plan);

  it('ignores a jump to a problem not reached yet', () => {
    const w = after(start, 3);
    expect(reduceWalkthrough(w, { type: 'GO_TO_PROBLEM', problem: 1 })).toEqual(w);
    expect(reduceWalkthrough(w, { type: 'GO_TO_PROBLEM', problem: 2 })).toEqual(w);
  });

  it('reopens a walked problem fully revealed and the recap from any dot', () => {
    const recap = after(start, 16);
    expect(reduceWalkthrough(recap, { type: 'GO_TO_PROBLEM', problem: 1 }).pos).toEqual({
      problem: 1,
      beat: 7,
    });
    expect(reduceWalkthrough(after(start, 10), { type: 'GO_TO_PROBLEM', problem: 0 }).pos).toEqual({
      problem: 0,
      beat: 7,
    });
    const back = reduceWalkthrough(recap, { type: 'GO_TO_PROBLEM', problem: 0 });
    expect(reduceWalkthrough(back, { type: 'GO_TO_PROBLEM', problem: 2 }).pos).toEqual({
      problem: 2,
      beat: 0,
    });
  });

  it('reopens the problem in progress where it got to', () => {
    const w = retreat(retreat(after(start, 10)));
    expect(w.pos).toEqual({ problem: 1, beat: 0 });
    expect(reduceWalkthrough(w, { type: 'GO_TO_PROBLEM', problem: 1 }).pos).toEqual({
      problem: 1,
      beat: 2,
    });
  });

  it('maps NEXT and BACK onto advance and retreat', () => {
    expect(reduceWalkthrough(start, { type: 'NEXT' })).toEqual(advance(start));
    const back = reduceWalkthrough(advance(start), { type: 'BACK' });
    expect(back.pos).toEqual(start.pos);
    // Stepping back never forgets how far the reader got.
    expect(back.reached).toEqual({ problem: 0, beat: 1 });
  });
});

describe('initialWalkthrough', () => {
  it('starts at the recap when asked, or when there is nothing to walk', () => {
    const recap = initialWalkthrough(plan, 'recap');
    expect(isRecap(recap)).toBe(true);
    expect(recap.reached).toEqual({ problem: 2, beat: 0 });
    expect(isRecap(initialWalkthrough([]))).toBe(true);
    expect(nextLabel(initialWalkthrough([]))).toBeUndefined();
  });

  it('ends a single problem with Wrap up', () => {
    const one = initialWalkthrough([plan[0]!]);
    expect(nextLabel(after(one, 7))).toBe('Wrap up');
  });
});
