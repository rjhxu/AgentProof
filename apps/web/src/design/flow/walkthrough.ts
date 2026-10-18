import type { AgentKind } from '@agentproof/shared';

import { shortName } from '../format';
import type { ProblemData } from './findings-data';

/*
 * The Findings walkthrough as a pure position machine: which problem is on stage and how many
 * of its beats have been revealed. Owned by the step rather than the flow reducer because the
 * beat count depends on the problems. Nothing here advances on a timer.
 */

export type Beat =
  | { kind: 'intro' }
  | { kind: 'evidence' }
  | { kind: 'agent'; agent: AgentKind; name: string; index: number; count: number }
  | { kind: 'meaning' }
  | { kind: 'change' };

/** `problem === plan.length` is the recap. */
export type Position = { problem: number; beat: number };

export type Walkthrough = {
  /** The beats of each problem, in problem order. */
  plan: Beat[][];
  pos: Position;
  /** The furthest position seen; the dots let the reader return to anything up to it. */
  reached: Position;
};

export type WalkEvent =
  { type: 'NEXT' } | { type: 'BACK' } | { type: 'GO_TO_PROBLEM'; problem: number };

/** Intro, evidence, one beat per shopper, what it means, what to change. */
export function beatsFor(card: ProblemData): Beat[] {
  const beats: Beat[] = [{ kind: 'intro' }, { kind: 'evidence' }];
  card.shoppers.forEach((s, index) =>
    beats.push({ kind: 'agent', agent: s.kind, name: s.name, index, count: card.shoppers.length }),
  );
  if (card.attribution || card.cost) beats.push({ kind: 'meaning' });
  if (card.recommendation) beats.push({ kind: 'change' });
  return beats;
}

export function initialWalkthrough(plan: Beat[][], at: 'start' | 'recap' = 'start'): Walkthrough {
  const recap = { problem: plan.length, beat: 0 };
  if (at === 'recap' || plan.length === 0) return { plan, pos: recap, reached: recap };
  const start = { problem: 0, beat: 0 };
  return { plan, pos: start, reached: start };
}

export function isRecap(w: Walkthrough): boolean {
  return w.pos.problem >= w.plan.length;
}

/** The beats revealed so far on the problem on stage; none at the recap. */
export function currentBeats(w: Walkthrough): Beat[] {
  if (isRecap(w)) return [];
  return (w.plan[w.pos.problem] ?? []).slice(0, w.pos.beat + 1);
}

export function revealedAgents(w: Walkthrough): number {
  return currentBeats(w).filter((b) => b.kind === 'agent').length;
}

function lastBeat(plan: Beat[][], problem: number): number {
  return Math.max(0, (plan[problem]?.length ?? 1) - 1);
}

function later(a: Position, b: Position): boolean {
  return a.problem > b.problem || (a.problem === b.problem && a.beat > b.beat);
}

/** The next beat, else the next problem's intro, else the recap. A no-op at the recap. */
export function advance(w: Walkthrough): Walkthrough {
  if (isRecap(w)) return w;
  const pos =
    w.pos.beat < lastBeat(w.plan, w.pos.problem)
      ? { problem: w.pos.problem, beat: w.pos.beat + 1 }
      : { problem: w.pos.problem + 1, beat: 0 };
  return { ...w, pos, reached: later(pos, w.reached) ? pos : w.reached };
}

/** The previous beat, else the previous problem's last beat. A no-op at the very start. */
export function retreat(w: Walkthrough): Walkthrough {
  if (w.pos.beat > 0) return { ...w, pos: { problem: w.pos.problem, beat: w.pos.beat - 1 } };
  if (w.pos.problem === 0) return w;
  const problem = w.pos.problem - 1;
  return { ...w, pos: { problem, beat: lastBeat(w.plan, problem) } };
}

/** What the Next button promises: the beat a press reveals. Nothing at the recap. */
export function nextLabel(w: Walkthrough): string | undefined {
  if (isRecap(w)) return undefined;
  const next = (w.plan[w.pos.problem] ?? [])[w.pos.beat + 1];
  if (!next) return w.pos.problem + 1 < w.plan.length ? 'Next problem' : 'Wrap up';
  switch (next.kind) {
    case 'intro':
      return 'Next problem';
    case 'evidence':
      return 'What did we see?';
    case 'agent':
      return next.index === 0 ? 'How did each shopper do?' : `Then ${shortName(next.name)}`;
    case 'meaning':
      return 'What it means';
    case 'change':
      return 'What to change';
  }
}

export function reduceWalkthrough(w: Walkthrough, e: WalkEvent): Walkthrough {
  switch (e.type) {
    case 'NEXT':
      return advance(w);
    case 'BACK':
      return retreat(w);
    case 'GO_TO_PROBLEM': {
      const { problem } = e;
      if (problem < 0 || problem > w.plan.length || problem > w.reached.problem) return w;
      // A problem already walked opens fully revealed; the one in progress reopens where it got to.
      const beat = problem === w.reached.problem ? w.reached.beat : lastBeat(w.plan, problem);
      if (problem === w.pos.problem && beat === w.pos.beat) return w;
      return { ...w, pos: { problem, beat } };
    }
  }
}
