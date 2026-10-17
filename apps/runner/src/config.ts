import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

export const config = {
  port: Number(process.env.RUNNER_PORT ?? 4000),
  dataDir: path.resolve(REPO_ROOT, process.env.AGENTPROOF_DATA_DIR ?? './data'),
  get artifactsDir() {
    return path.join(this.dataDir, 'artifacts');
  },
  get dbPath() {
    return path.join(this.dataDir, 'agentproof.db');
  },
  /** Only this directory may receive applied repairs. */
  storefrontDir: path.join(REPO_ROOT, 'apps', 'storefront'),
  maxConcurrentRuns: 2,
};
