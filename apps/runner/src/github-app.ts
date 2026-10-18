import path from 'node:path';
import {
  DELIVER_SCOPE,
  READ_SCOPE,
  describeGitHubApp,
  findInstallation,
  installUrl,
  loadGitHubAppConfig,
  mintInstallationToken,
  parseRepoFullName,
  saveGitHubAppConfig,
  type GitHubAppConfig,
  type LoadedGitHubAppConfig,
} from '@agentproof/codefix';
import type { GitHubAppStatus } from '@agentproof/shared';
import { config } from './config';

/**
 * The runner's GitHub App identity (docs/CODEFIX.md section 2). Credentials come from the
 * environment (AGENTPROOF_GITHUB_APP_ID, AGENTPROOF_GITHUB_APP_PRIVATE_KEY[_FILE]) or from the
 * file the manifest flow writes (data/github-app.json, mode 0600). The private key never leaves
 * this process: status reports describe the app without it, and every token minted from it is
 * short-lived, scoped to one repository and the one operation, and never persisted.
 */

export function githubAppFile(): string {
  return path.join(config.dataDir, 'github-app.json');
}

let cached: LoadedGitHubAppConfig | undefined;

export function githubAppState(reload = false): LoadedGitHubAppConfig {
  if (!cached || reload) cached = loadGitHubAppConfig(process.env, githubAppFile());
  return cached;
}

export function storeGitHubApp(app: GitHubAppConfig): void {
  saveGitHubAppConfig(githubAppFile(), app);
  cached = undefined;
}

/** For tests: forget the cached configuration. */
export function resetGitHubAppCache(): void {
  cached = undefined;
}

export function githubAppStatus(): GitHubAppStatus {
  const state = githubAppState();
  if (!state.config) {
    return { configured: false, ...(state.error ? { error: state.error } : {}) };
  }
  const described = describeGitHubApp(state.config);
  return {
    configured: true,
    appId: described.appId,
    ...(described.slug ? { slug: described.slug, installUrl: installUrl(described.slug) } : {}),
    ...(state.source ? { source: state.source } : {}),
  };
}

export type CredentialKind = 'github_app' | 'token' | 'none';
export type CredentialScope = 'read' | 'deliver';

export interface ResolvedCredential {
  kind: CredentialKind;
  /** Memory-only; never persisted or logged */
  token?: string;
  installationId?: number;
  expiresAt?: string;
  /** Human-readable, safe to show: what was used and why */
  note: string;
}

/**
 * Prefer the GitHub App: when it is configured and installed on the repository, mint a token
 * scoped to that repository and to the operation (read for a clone, write for a push and a
 * draft pull request). Otherwise use the request token, if any; otherwise anonymous.
 */
export async function resolveGitHubCredential(
  repoUrl: string,
  scope: CredentialScope,
  requestToken?: string,
): Promise<ResolvedCredential> {
  const state = githubAppState();
  let appNote = 'no GitHub App configured';
  if (state.config) {
    const ref = parseRepoFullName(repoUrl);
    try {
      const installation = await findInstallation(ref, state.config);
      if (installation) {
        const minted = await mintInstallationToken(installation.installationId, state.config, {
          repository: ref.repo,
          permissions: scope === 'read' ? READ_SCOPE : DELIVER_SCOPE,
        });
        return {
          kind: 'github_app',
          token: minted.token,
          installationId: installation.installationId,
          expiresAt: minted.expiresAt,
          note: `GitHub App installation ${installation.installationId} on ${installation.account} (${scope} scope, expires ${minted.expiresAt})`,
        };
      }
      appNote = `the GitHub App is not installed on ${ref.fullName}${
        state.config.slug ? ` (install it at ${installUrl(state.config.slug)})` : ''
      }`;
    } catch (err) {
      appNote = `the GitHub App could not be used: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (state.error) {
    appNote = `the GitHub App configuration is invalid: ${state.error}`;
  }
  if (requestToken)
    return { kind: 'token', token: requestToken, note: `request token (${appNote})` };
  return { kind: 'none', note: `anonymous (${appNote}; no token given)` };
}
