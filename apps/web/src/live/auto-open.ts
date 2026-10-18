/**
 * Whether the Fixes step should press "Open draft pull requests" on its own. The app-install path
 * asks for this; the URL and token path does not, because that consent says nothing is written.
 */
export function shouldAutoOpenPullRequests(input: {
  /** The Fixes step is on screen and its reading beat has finished. */
  ready: boolean;
  /** This connection asked for draft pull requests. */
  requested: boolean;
  /** Already fired for this connection. */
  fired: boolean;
  /** The repository was read through the GitHub App, so a pull request can be opened. */
  canOpen: boolean;
  opening: 'idle' | 'pending' | 'done';
  /** Validated fixes that have a diff to deliver. */
  fixCount: number;
}): boolean {
  return (
    input.ready &&
    input.requested &&
    !input.fired &&
    input.canOpen &&
    input.opening === 'idle' &&
    input.fixCount > 0
  );
}
