import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  MANIFEST_CODE,
  MANIFEST_STATE,
  buildAppManifest,
  convertManifestCode,
  installUrl,
  renderManifestForm,
} from '@agentproof/codefix';
import { config } from './config';
import { githubAppStatus, listAppRepositories, storeGitHubApp } from './github-app';
import { localAccess } from './repository-routes';

const STATE_TTL_MS = 10 * 60_000;
const HTML = 'text/html; charset=utf-8';

/** Pending manifest registrations: state nonce -> expiry. One browser round trip each. */
const pendingStates = new Map<string, number>();

function newState(): string {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) if (expiresAt < now) pendingStates.delete(state);
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#222}code{background:#f3f3f3;padding:2px 4px}</style></head><body>${body}</body></html>`;
}

/**
 * GitHub App registration and status (docs/CODEFIX.md section 2). Localhost only, like the
 * repository connection. The private key returned by GitHub's manifest conversion is written
 * into `.env` (AGENTPROOF_GITHUB_APP_*; the file is made mode 0600) and never rendered or
 * returned.
 *
 *   GET /github/app              status: configured, app id, slug, install URL (never the key)
 *   GET /github/app/repositories the repositories the app is installed on (empty when unconfigured)
 *   GET /github/app/setup        a page with one button that registers the app from a manifest
 *   GET /github/app/callback     where GitHub returns with ?code=...&state=... after registration
 */
export async function registerGitHubAppRoutes(app: FastifyInstance): Promise<void> {
  const options = { onRequest: localAccess };

  app.get('/github/app', options, async () => ({ app: githubAppStatus() }));

  app.get('/github/app/repositories', options, async (_req, reply) => {
    const status = githubAppStatus();
    if (!status.configured) return { app: status, repositories: [] };
    try {
      return { app: status, repositories: await listAppRepositories() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  app.get<{ Querystring: { name?: string; org?: string } }>(
    '/github/app/setup',
    options,
    async (req, reply) => {
      const runnerUrl = `http://localhost:${config.port}`;
      const requested = (req.query.name ?? '').trim();
      const name =
        requested && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$/.test(requested)
          ? requested
          : `agentproof-${randomBytes(2).toString('hex')}`;
      const org = (req.query.org ?? '').trim();
      const manifest = buildAppManifest({
        name,
        runnerUrl,
        description:
          'AgentProof opens draft pull requests that make a store work for AI shopping agents. It never merges.',
      });
      const html = renderManifestForm({
        manifest,
        state: newState(),
        ...(org && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org) ? { organization: org } : {}),
      });
      return reply.type(HTML).send(html);
    },
  );

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/github/app/callback',
    options,
    async (req, reply) => {
      const { code, state } = req.query;
      if (!state || !MANIFEST_STATE.test(state) || !pendingStates.has(state)) {
        return reply
          .code(400)
          .type(HTML)
          .send(
            page(
              'Registration refused',
              '<h1>Registration refused</h1><p>Unknown or expired state. Start again from <code>/github/app/setup</code>.</p>',
            ),
          );
      }
      pendingStates.delete(state);
      if (!code || !MANIFEST_CODE.test(code)) {
        return reply
          .code(400)
          .type(HTML)
          .send(
            page(
              'Registration refused',
              '<h1>Registration refused</h1><p>GitHub did not return a valid code.</p>',
            ),
          );
      }
      try {
        const { config: registered, htmlUrl } = await convertManifestCode(code);
        storeGitHubApp(registered);
        const slug = registered.slug ?? '';
        const install = slug ? installUrl(slug) : htmlUrl;
        return reply
          .type(HTML)
          .send(
            page(
              'GitHub App registered',
              `<h1>GitHub App registered</h1><p>App <strong>${escapeHtml(slug || String(registered.appId))}</strong> (id ${registered.appId}) is now the runner's identity. Its id and private key were written to <code>.env</code> as <code>AGENTPROOF_GITHUB_APP_*</code> (owner-only permissions) and will not be shown. Share <code>.env</code> with teammates the way you share the model key, never through git.</p><p>Next: <a href="${escapeHtml(install)}">install the app on the repositories AgentProof may work on</a>. Grant only the repositories you choose; the app asks for Contents and Pull requests (read and write) and Metadata (read).</p><p>App settings: <a href="${escapeHtml(htmlUrl)}">${escapeHtml(htmlUrl)}</a></p>`,
            ),
          );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply
          .code(502)
          .type(HTML)
          .send(
            page(
              'Registration failed',
              `<h1>Registration failed</h1><p>${escapeHtml(message)}</p>`,
            ),
          );
      }
    },
  );
}
