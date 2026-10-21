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
  /**
   * Cross-agent mission reports: <artifactsDir>/missions/<missionId>/report.{json,md}. They live
   * inside the artifacts dir so GET /artifacts/* serves them like every run report.
   */
  get missionReportsDir() {
    return path.join(this.artifactsDir, 'missions');
  },
  get dbPath() {
    return path.join(this.dataDir, 'agentproof.db');
  },
  /** Only this directory may receive applied repairs. */
  storefrontDir: path.join(REPO_ROOT, 'apps', 'storefront'),
  /**
   * Storefront base URL for fixture missions and the hoodie demo. STOREFRONT_URL wins (macOS
   * usually holds :5000); otherwise localhost on STOREFRONT_PORT.
   */
  storeUrl:
    process.env.STOREFRONT_URL?.trim() ||
    `http://localhost:${process.env.STOREFRONT_PORT?.trim() || '5000'}`,
  maxConcurrentRuns: 2,
};
