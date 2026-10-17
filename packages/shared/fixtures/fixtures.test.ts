import { describe, expect, it } from 'vitest';
import { Issue, Mission, Repair, Run } from '../src';
import { alphaFailedRun, alphaIssue, alphaRepair, hoodieMission } from './index';

describe('fixtures validate against shared schemas', () => {
  it('hoodieMission', () => {
    expect(Mission.safeParse(hoodieMission).success).toBe(true);
  });
  it('alphaFailedRun', () => {
    const result = Run.safeParse(alphaFailedRun);
    expect(result.success, JSON.stringify(result.error, null, 2)).toBe(true);
  });
  it('alphaIssue', () => {
    expect(Issue.safeParse(alphaIssue).success).toBe(true);
  });
  it('alphaRepair', () => {
    expect(Repair.safeParse(alphaRepair).success).toBe(true);
  });
});
