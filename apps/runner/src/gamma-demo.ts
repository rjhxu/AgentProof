import fs from 'node:fs';
import path from 'node:path';
import { type Run, type Issue, type Repair, newId, nowIso } from '@agentproof/shared';
import { config } from './config';

export const buggyMapping = "  'HOODIE-001-M': 'HOODIE-001-S', // BUG: should be HOODIE-001-M";
export const fixedMapping =
  "  'HOODIE-001-M': 'HOODIE-001-M', // Repaired: preserve the requested medium variant";
const relativeFile = 'apps/storefront/src/cart.ts';

/** A source-backed diagnosis for this known demo bug, explicitly independent of Claude. */
export function diagnoseGamma(run: Run): Issue {
  const checkpoint = run.verification?.checkpoints.find(
    (c) => c.id === 'catalog_variant_resolves' && c.status === 'failed',
  );
  const catalog = run.evidence.find((e) => e.kind === 'catalog_record')?.data as
    { selectedVariant?: { id?: string } } | undefined;
  const cart = run.verification?.observedCart;
  if (
    run.agent.kind !== 'gamma_structured' ||
    !checkpoint ||
    catalog?.selectedVariant?.id !== 'HOODIE-001-M' ||
    cart?.items[0]?.variantId !== 'HOODIE-001-S'
  )
    throw new Error(
      'This targeted diagnosis requires evidence of the medium-to-small hoodie mismatch.',
    );
  return {
    id: newId('iss'),
    runId: run.id,
    checkpointId: checkpoint.id,
    category: 'product_data_inconsistency',
    title: 'Medium hoodie ID resolves to a small hoodie',
    observed: checkpoint.detail ?? 'Catalog and cart disagree.',
    evidenceIds: checkpoint.evidenceIds,
    inferredCause:
      'Known demo rule: the storefront legacy variant map redirects HOODIE-001-M to HOODIE-001-S. This is a deterministic diagnosis, not an AI inference.',
    confidence: 'high',
    suggestedRepair: 'Map HOODIE-001-M to itself, preserving the requested size.',
    suspectedFiles: [relativeFile],
  };
}

export function proposeGammaRepair(issue: Issue): Repair {
  if (
    issue.checkpointId !== 'catalog_variant_resolves' ||
    issue.suspectedFiles.join() !== relativeFile
  )
    throw new Error('Only the known Gamma hoodie repair is supported.');
  const source = fs.readFileSync(path.join(config.storefrontDir, 'src/cart.ts'), 'utf8');
  const lines = source.split(/\r?\n/);
  const index = lines.indexOf(buggyMapping);
  if (index < 0 || lines.filter((line) => line === buggyMapping).length !== 1)
    throw new Error('Expected buggy mapping is absent or changed. No repair was proposed.');
  return {
    id: newId('rep'),
    issueId: issue.id,
    summary: 'Preserve the medium hoodie variant ID',
    files: [relativeFile],
    diff: `--- a/${relativeFile}\n+++ b/${relativeFile}\n@@ -${index + 1},1 +${index + 1},1 @@\n-${buggyMapping}\n+${fixedMapping}\n`,
    status: 'proposed',
    createdAt: nowIso(),
  };
}

/** Apply exactly the reviewed one-line change; refuse stale proposals and arbitrary paths. */
export function applyGammaRepair(repair: Repair, issue: Issue): Repair {
  if (repair.status === 'applied') return repair;
  if (
    repair.status !== 'proposed' ||
    repair.issueId !== issue.id ||
    repair.files.join() !== relativeFile
  )
    throw new Error('Unsupported repair.');
  const expected = proposeGammaRepair(issue);
  if (expected.diff !== repair.diff)
    throw new Error('Storefront changed since proposal. Generate a fresh repair.');
  const file = path.join(config.storefrontDir, 'src/cart.ts');
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, source.replace(buggyMapping, fixedMapping));
  return { ...repair, status: 'applied', appliedAt: nowIso() };
}
