import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Issue } from '@agentproof/shared';
import { config } from './config';
import { buggyMapping, fixedMapping, proposeGammaRepair, applyGammaRepair } from './gamma-demo';

const originalDirectory = config.storefrontDir;
let directory: string;
const issue: Issue = {
  id: 'iss_test',
  runId: 'run_test',
  checkpointId: 'catalog_variant_resolves',
  category: 'product_data_inconsistency',
  title: 'Mismatch',
  observed: 'M became S',
  evidenceIds: [],
  suspectedFiles: ['apps/storefront/src/cart.ts'],
};
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentproof-repair-'));
  config.storefrontDir = directory;
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src/cart.ts'), `const map = {\n${buggyMapping}\n};\n`);
});
afterEach(() => {
  config.storefrontDir = originalDirectory;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewed Gamma repair', () => {
  it('applies only the previewed mapping change and is idempotent', () => {
    const repair = proposeGammaRepair(issue);
    expect(repair.diff).toContain('-' + buggyMapping);
    const applied = applyGammaRepair(repair, issue);
    expect(applied.status).toBe('applied');
    expect(fs.readFileSync(path.join(directory, 'src/cart.ts'), 'utf8')).toBe(
      `const map = {\n${fixedMapping}\n};\n`,
    );
    expect(applyGammaRepair(applied, issue)).toEqual(applied);
  });
  it('rejects a stale diff without touching the source', () => {
    const repair = proposeGammaRepair(issue);
    const file = path.join(directory, 'src/cart.ts');
    fs.writeFileSync(file, '// another edit\n' + fs.readFileSync(file, 'utf8'));
    const before = fs.readFileSync(file, 'utf8');
    expect(() => applyGammaRepair(repair, issue)).toThrow('changed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
  it('refuses an arbitrary target path or edited diff', () => {
    const repair = proposeGammaRepair(issue);
    expect(() => applyGammaRepair({ ...repair, files: ['../../outside.ts'] }, issue)).toThrow(
      'Unsupported',
    );
    expect(() => applyGammaRepair({ ...repair, diff: repair.diff + 'extra' }, issue)).toThrow(
      'changed',
    );
  });
});
