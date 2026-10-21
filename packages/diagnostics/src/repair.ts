import type { Issue, Repair } from '@agentproof/shared';

/**
 * Reviewable repair suggestions: given an Issue and the storefront source, produce a minimal
 * unified diff. Applying the diff is a separate, explicit step (POST /repairs/:id/apply) that
 * only targets apps/storefront in this repository, never third-party sites.
 *
 * Both functions are stubs that throw. The generic repair path is the code-fix agent in
 * packages/codefix.
 */
export interface RepairInput {
  issue: Issue;
  /** path -> full file contents for the suspected files */
  sources: Record<string, string>;
}

export async function proposeRepair(_input: RepairInput): Promise<Repair> {
  throw new Error('proposeRepair not implemented');
}

export async function applyRepair(_repair: Repair, _repoRoot: string): Promise<void> {
  throw new Error('applyRepair not implemented');
}
