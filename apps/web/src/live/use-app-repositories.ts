'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubAppRepository } from '@agentproof/shared';

import { api } from '../lib/api';

const POLL_MS = 5000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The repositories the AgentProof GitHub App is installed on. Fetched while `enabled` (the connect
 * panel is open and the app is configured), again when the window regains focus (the user coming
 * back from GitHub's install page), and every few seconds until the first repository appears.
 */
export function useAppRepositories(enabled: boolean): {
  repositories: GitHubAppRepository[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
} {
  const [repositories, setRepositories] = useState<GitHubAppRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const repositoriesRef = useRef(repositories);
  repositoriesRef.current = repositories;

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (repositoriesRef.current.length === 0) setLoading(true);
    try {
      const { repositories: found } = await api.listGitHubAppRepositories();
      if (generation.current !== request) return;
      setRepositories(found);
      setError(undefined);
    } catch (err) {
      if (generation.current !== request) return;
      setError(errorText(err));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current++;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || repositories.length > 0) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, repositories.length, refresh]);

  return { repositories, loading, ...(error !== undefined ? { error } : {}), refresh };
}
