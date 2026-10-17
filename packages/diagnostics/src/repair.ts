import type { Issue, Repair } from '@agentproof/shared';

/**
 * Feature 5: Reviewable Repair Suggestions.
 *
 * Given an Issue and the storefront source, ask Claude for a minimal unified diff.
 * Applying the diff is a separate, explicit step (POST /repairs/:id/apply) that only
 * targets apps/storefront in this repository. Never third-party sites.
 *
 * OWNER: Developer 4.
 */
export interface RepairInput {
  issue: Issue;
  /** path -> full file contents for the suspected files */
  sources: Record<string, string>;
}

export async function proposeRepair(_input: RepairInput): Promise<Repair> {
  // TODO(dev4):
  // 1. Prompt Claude with the issue (observed + inferredCause + suggestedRepair) and the sources.
  // 2. Ask for a unified diff limited to the provided files (structured output: { summary, diff, files }).
  // 3. Validate the diff applies cleanly (dry-run with `git apply --check`) before returning it.
  throw new Error('proposeRepair not implemented');
}

export async function applyRepair(_repair: Repair, _repoRoot: string): Promise<void> {
  // TODO(dev4): write diff to a temp file, run `git apply`, restart the storefront dev server
  // (tsx watch picks up changes automatically), then mark status "applied".
  throw new Error('applyRepair not implemented');
}
