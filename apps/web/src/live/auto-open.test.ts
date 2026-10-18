import { describe, expect, it } from 'vitest';

import { shouldAutoOpenPullRequests } from './auto-open';

const ready = {
  ready: true,
  requested: true,
  fired: false,
  canOpen: true,
  opening: 'idle' as const,
  fixCount: 2,
};

describe('shouldAutoOpenPullRequests', () => {
  it('opens once the fixes are ready and the connection asked for pull requests', () => {
    expect(shouldAutoOpenPullRequests(ready)).toBe(true);
  });

  it('stays quiet for every other state', () => {
    expect(shouldAutoOpenPullRequests({ ...ready, ready: false })).toBe(false);
    expect(shouldAutoOpenPullRequests({ ...ready, requested: false })).toBe(false);
    expect(shouldAutoOpenPullRequests({ ...ready, fired: true })).toBe(false);
    expect(shouldAutoOpenPullRequests({ ...ready, canOpen: false })).toBe(false);
    expect(shouldAutoOpenPullRequests({ ...ready, opening: 'pending' })).toBe(false);
    expect(shouldAutoOpenPullRequests({ ...ready, opening: 'done' })).toBe(false);
    expect(shouldAutoOpenPullRequests({ ...ready, fixCount: 0 })).toBe(false);
  });
});
