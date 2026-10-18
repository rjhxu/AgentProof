'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { RepositoryConnection } from '@agentproof/shared';
import { api } from '../lib/api';

const button =
  'rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
const input =
  'mt-2 w-full rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30 disabled:opacity-50';

type Activity = '' | 'loading' | 'connecting' | 'disconnecting';

export function RepositoryConnectionPanel({
  runId,
  failedCount,
}: {
  runId: string;
  failedCount: number;
}) {
  const id = useId();
  const [repository, setRepository] = useState<RepositoryConnection | null>(null);
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [activity, setActivity] = useState<Activity>('loading');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const tokenInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const request = ++generation.current;
    const current = () => mounted.current && generation.current === request;
    inFlight.current = true;
    setRepository(null);
    setUrl('');
    setConsent(false);
    setActivity('loading');
    setError('');
    setStatus('');
    setLoadFailed(false);
    if (tokenInput.current) tokenInput.current.value = '';

    void api
      .getRepository(runId)
      .then(({ repository }) => {
        if (current()) setRepository(repository);
      })
      .catch((error: unknown) => {
        if (!current()) return;
        setLoadFailed(true);
        setError(error instanceof Error ? error.message : 'Could not check repository access.');
      })
      .finally(() => {
        if (!current()) return;
        inFlight.current = false;
        setActivity('');
      });

    return () => {
      mounted.current = false;
      generation.current++;
      if (tokenInput.current) tokenInput.current.value = '';
    };
  }, [runId, retry]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !consent) return;
    const request = generation.current;
    const current = () => mounted.current && generation.current === request;
    const token = tokenInput.current?.value.trim();
    // Credentials live only in this request, never in React state or browser storage.
    if (tokenInput.current) tokenInput.current.value = '';
    inFlight.current = true;
    setActivity('connecting');
    setError('');
    setStatus('');

    try {
      const { repository } = await api.connectRepository(runId, {
        url: url.trim(),
        ...(token ? { token } : {}),
        consent: true,
      });
      if (!current()) return;
      setRepository(repository);
      setConsent(false);
      setStatus('Repository source connected. Model-powered repair suggestions are coming later.');
    } catch (error) {
      if (!current()) return;
      setError(error instanceof Error ? error.message : 'Could not connect this repository.');
    } finally {
      if (current()) {
        if (tokenInput.current) tokenInput.current.value = '';
        inFlight.current = false;
        setActivity('');
      }
    }
  }

  async function disconnect() {
    if (inFlight.current) return;
    const request = generation.current;
    const current = () => mounted.current && generation.current === request;
    inFlight.current = true;
    setActivity('disconnecting');
    setError('');
    setStatus('');

    try {
      await api.disconnectRepository(runId);
      if (!current()) return;
      setRepository(null);
      setConsent(false);
      setStatus('Disconnected. The downloaded repository source has been removed.');
    } catch (error) {
      if (!current()) return;
      setError(error instanceof Error ? error.message : 'Could not disconnect this repository.');
    } finally {
      if (current()) {
        inFlight.current = false;
        setActivity('');
      }
    }
  }

  const connected = repository?.runId === runId ? repository : null;
  const files = connected?.files.slice(0, 40) ?? [];

  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={!!activity}
      className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5"
    >
      <p className="text-xs uppercase tracking-widest text-[var(--accent)]">
        Next step · Repository access
      </p>
      <h2 id={`${id}-title`} className="mt-2 text-lg font-semibold">
        {connected ? 'Repository connected' : 'Connect your Git repository'}
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        Gamma found {failedCount} failed {failedCount === 1 ? 'checkpoint' : 'checkpoints'}. Connect
        the store’s source so future repair suggestions can use your code.
      </p>

      <div aria-live="polite" className="text-sm">
        {activity && (
          <p role="status" className="mt-4 text-[var(--accent)]">
            {activity === 'loading'
              ? 'Checking repository access…'
              : activity === 'connecting'
                ? 'Connecting and downloading repository source…'
                : 'Disconnecting repository…'}
          </p>
        )}
        {status && (
          <p role="status" className="mt-4 text-[var(--pass)]">
            {status}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-red-300"
          >
            {error}
          </p>
        )}
      </div>

      {loadFailed && (
        <button
          type="button"
          className={button + ' mt-4'}
          disabled={!!activity}
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry connection status
        </button>
      )}

      {connected ? (
        <div className="mt-5 rounded-lg border border-[var(--line)] p-4">
          <a
            href={connected.url}
            target="_blank"
            rel="noreferrer"
            className="break-all font-medium text-[var(--accent)] underline underline-offset-4"
          >
            {connected.fullName}
          </a>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[var(--muted)]">Default branch</dt>
              <dd className="mt-1 break-all">{connected.defaultBranch}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--muted)]">Source commit</dt>
              <dd className="mt-1 break-all font-mono text-xs">{connected.commitSha}</dd>
            </div>
          </dl>
          <details className="mt-4 border-t border-[var(--line)] pt-4">
            <summary className="cursor-pointer text-sm">
              Preview repository files · {connected.fileCount} tracked
            </summary>
            {files.length > 0 ? (
              <ul className="mt-3 max-h-56 space-y-1 overflow-auto font-mono text-xs text-[var(--muted)]">
                {files.map((file) => (
                  <li key={file} className="break-all">
                    {file}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No files are available in this preview.
              </p>
            )}
            {(connected.truncated || connected.fileCount > files.length) && (
              <p className="mt-3 text-xs text-[var(--muted)]">
                Showing {files.length} of {connected.fileCount} files.
              </p>
            )}
          </details>
          <p className="mt-4 text-sm text-[var(--muted)]">
            Source is available to this local runner. Model-powered suggestions are coming later.
          </p>
          <button
            type="button"
            className={button + ' mt-4'}
            disabled={!!activity}
            onClick={() => void disconnect()}
          >
            Disconnect repository
          </button>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Disconnect removes the local source copy. Revoke any token separately in your GitHub
            settings.
          </p>
        </div>
      ) : activity !== 'loading' && !loadFailed ? (
        <form onSubmit={(event) => void connect(event)} className="mt-5 max-w-2xl">
          <fieldset disabled={!!activity} className="min-w-0 space-y-4">
            <div>
              <label htmlFor={`${id}-url`} className="text-sm font-medium">
                GitHub repository URL
              </label>
              <input
                id={`${id}-url`}
                type="url"
                name="repositoryUrl"
                required
                placeholder="https://github.com/owner/repository"
                autoComplete="url"
                spellCheck={false}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-describedby={`${id}-url-help`}
                className={input}
              />
              <p id={`${id}-url-help`} className="mt-2 text-xs text-[var(--muted)]">
                Connect a GitHub repository using its HTTPS URL. Public repositories need no token.
              </p>
            </div>
            <div>
              <label htmlFor={`${id}-token`} className="text-sm font-medium">
                GitHub access token{' '}
                <span className="font-normal text-[var(--muted)]">(optional)</span>
              </label>
              <input
                ref={tokenInput}
                id={`${id}-token`}
                type="password"
                name="repositoryToken"
                // A token is not a saved password: keep the browser from filling one in.
                autoComplete="new-password"
                spellCheck={false}
                aria-describedby={`${id}-token-help`}
                className={input}
              />
              <p
                id={`${id}-token-help`}
                className="mt-2 text-xs leading-relaxed text-[var(--muted)]"
              >
                For a private repository, use a fine-grained token limited to that repository with{' '}
                Contents: read-only. The token is used for this connection and is not stored.{' '}
                <a
                  href="https://github.com/settings/personal-access-tokens/new?name=AgentProof&contents=read&expires_in=7"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] underline underline-offset-2"
                >
                  Create a token on GitHub
                </a>
                .
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--line)] p-3 text-sm">
              <input
                type="checkbox"
                checked={consent}
                required
                onChange={(event) => setConsent(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span>
                I allow AgentProof to download this repository’s source to the local runner for
                future repair suggestions.
              </span>
            </label>
            <div>
              <button
                type="submit"
                disabled={!!activity || !url.trim() || !consent}
                className={button + ' bg-[var(--accent)] text-white'}
              >
                {activity === 'connecting' ? 'Connecting…' : 'Connect repository'}
              </button>
              <p className="mt-2 text-xs text-[var(--muted)]">
                This step downloads source only. It does not modify or push code.
              </p>
            </div>
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}
