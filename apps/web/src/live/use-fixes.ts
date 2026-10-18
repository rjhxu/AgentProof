import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeFix, CodeFixEvent, RepositoryConnection, Run } from '@agentproof/shared';

import type { ReadingProgress } from '../design/flow/fixes-data';
import { api } from '../lib/api';
import { finalAttempt, isFixDone, latestFix, readingProgress } from './codefix-view';
import { detectStoreRoot } from './store-root';

/*
 * The code-fix records behind the Fixes step. One diff-mode fix per failed run with a connected
 * repository gives the cards; a pull_request-mode fix per card opens the draft pull request. Each
 * running fix is followed over its event stream and re-read from GET /codefix/:id after every
 * event, so the records here are always the runner's own, never assembled client side.
 */

type FixRecords = Record<string, CodeFix>;

export type Opening = 'idle' | 'pending' | 'done';

export type Fixes = {
  /** Run id -> its diff-mode fix (the proposal and its checks). */
  diff: FixRecords;
  /** Run id -> its pull_request-mode fix (the delivery). */
  pr: FixRecords;
  /** How far the reading has got, from the diff fixes; undefined before any exists. */
  reading: ReadingProgress | undefined;
  /** Every requested diff fix has finished (or could not start). */
  allDiffDone: boolean;
  opening: Opening;
  /** The last request that failed, for the page's error bar. */
  error?: string;
  /** Run id -> why its diff fix could not start; the step lists it as no change proposed. */
  startErrors: Record<string, string>;
  /** Run id -> why its pull request could not be requested; the run counts as answered. */
  prErrors: Record<string, string>;
  /** Start a diff fix for every run that has a repository. */
  start: (runs: Run[], repositories: Record<string, RepositoryConnection>) => Promise<void>;
  /** Open a draft pull request for every diff fix that succeeded with a diff. */
  openPullRequests: () => Promise<void>;
  /** Take over a run's existing fixes (a resumed mission): the latest of each mode. */
  adopt: (runId: string, fixes: CodeFix[]) => void;
  /** Forget everything and stop following; for a new scan. */
  reset: () => void;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function union(list: string[], more: string[]): string[] {
  const out = [...list];
  for (const id of more) if (!out.includes(id)) out.push(id);
  return out;
}

export function useFixes(): Fixes {
  const [diff, setDiff] = useState<FixRecords>({});
  const [pr, setPr] = useState<FixRecords>({});
  const [started, setStarted] = useState<string[]>([]);
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});
  const [prRequested, setPrRequested] = useState<string[]>([]);
  const [prErrors, setPrErrors] = useState<Record<string, string>>({});
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string>();
  const storeRoots = useRef<Record<string, string>>({});
  /** Runs whose fixes were taken over from the runner (a resumed mission): start() leaves them be. */
  const adopted = useRef(new Set<string>());
  /** The diff records as of this render, so start() can see them without depending on `diff`. */
  const diffRef = useRef<FixRecords>(diff);
  diffRef.current = diff;
  const sources = useRef(new Map<string, EventSource>());
  const generation = useRef(0);

  const closeAll = useCallback(() => {
    for (const es of sources.current.values()) es.close();
    sources.current.clear();
  }, []);
  useEffect(() => closeAll, [closeAll]);

  const store = useCallback((fix: CodeFix) => {
    const set = fix.mode === 'diff' ? setDiff : setPr;
    set((prev) => ({ ...prev, [fix.runId]: fix }));
  }, []);

  /** Follow a running fix: re-read the record after every event, close after `done`. */
  const follow = useCallback(
    (fix: CodeFix) => {
      if (isFixDone(fix) || sources.current.has(fix.id)) return;
      const gen = generation.current;
      const es = new EventSource(api.codeFixEventsUrl(fix.id));
      sources.current.set(fix.id, es);
      const close = () => {
        es.close();
        sources.current.delete(fix.id);
      };
      // At most one read in flight; one more after the last event so nothing is missed.
      let inFlight = false;
      let again = false;
      const refresh = async () => {
        if (inFlight) {
          again = true;
          return;
        }
        inFlight = true;
        try {
          do {
            again = false;
            const { codefix } = await api.getCodeFix(fix.id);
            if (generation.current === gen) store(codefix);
          } while (again);
        } catch {
          // The next event reads again.
        } finally {
          inFlight = false;
        }
      };
      es.onmessage = (msg) => {
        if (generation.current !== gen) {
          close();
          return;
        }
        let event: CodeFixEvent;
        try {
          event = JSON.parse(msg.data as string) as CodeFixEvent;
        } catch {
          return;
        }
        void refresh();
        if (event.type === 'done') close();
      };
      es.onerror = () => {
        if (generation.current !== gen) {
          close();
          return;
        }
        void api
          .getCodeFix(fix.id)
          .then(({ codefix }) => {
            if (generation.current !== gen) return;
            store(codefix);
            if (isFixDone(codefix)) close();
            // Otherwise the stream reconnects on its own.
          })
          .catch(() => undefined);
      };
    },
    [store],
  );

  const start = useCallback(
    async (runs: Run[], repositories: Record<string, RepositoryConnection>) => {
      const gen = generation.current;
      // A run whose fixes were adopted, or whose diff fix is already in hand (done or running),
      // gets no second one.
      const targets = runs.filter(
        (run) =>
          repositories[run.id] !== undefined &&
          !adopted.current.has(run.id) &&
          diffRef.current[run.id] === undefined,
      );
      if (targets.length === 0) return;
      setError(undefined);
      setStarted((prev) =>
        union(
          prev,
          targets.map((run) => run.id),
        ),
      );
      const rematch = process.env.NEXT_PUBLIC_AGENTPROOF_REMATCH !== '0';
      await Promise.all(
        targets.map(async (run) => {
          const repository = repositories[run.id];
          const storeRoot = repository ? detectStoreRoot(repository.files) : '';
          storeRoots.current[run.id] = storeRoot;
          try {
            const { codefix } = await api.startCodeFix(run.id, {
              mode: 'diff',
              consent: true,
              storeRoot,
              rematch,
            });
            if (generation.current !== gen) return;
            store(codefix);
            follow(codefix);
          } catch (err) {
            const message = errorText(err);
            // A fix already running for this run (a reload mid-fix): take it over instead.
            if (/already running/i.test(message)) {
              try {
                const { codefixes } = await api.listCodeFixes(run.id);
                if (generation.current !== gen) return;
                const existing = latestFix(codefixes, 'diff');
                const opening = latestFix(codefixes, 'pull_request');
                if (opening) {
                  store(opening);
                  follow(opening);
                }
                if (existing) {
                  store(existing);
                  follow(existing);
                  return;
                }
              } catch {
                // Fall through to the error.
              }
            }
            if (generation.current !== gen) return;
            setStartErrors((prev) => ({ ...prev, [run.id]: message }));
            setError(message);
          }
        }),
      );
    },
    [follow, store],
  );

  const openPullRequests = useCallback(async () => {
    const gen = generation.current;
    // Every validated diff that has no pull-request record yet, running or done.
    const targets = started.filter((id) => {
      const fix = diff[id];
      return (
        fix !== undefined &&
        isFixDone(fix) &&
        fix.status === 'succeeded' &&
        finalAttempt(fix)?.diff !== undefined &&
        pr[id] === undefined
      );
    });
    if (targets.length === 0) return;
    setError(undefined);
    setRequesting(true);
    setPrRequested((prev) => union(prev, targets));
    await Promise.all(
      targets.map(async (id) => {
        try {
          const { codefix } = await api.startCodeFix(id, {
            mode: 'pull_request',
            consent: true,
            storeRoot: storeRoots.current[id] ?? '',
            rematch: false,
          });
          if (generation.current !== gen) return;
          store(codefix);
          follow(codefix);
        } catch (err) {
          if (generation.current !== gen) return;
          const message = errorText(err);
          setPrErrors((prev) => ({ ...prev, [id]: message }));
          setError(message);
        }
      }),
    );
    if (generation.current === gen) setRequesting(false);
  }, [started, diff, pr, follow, store]);

  const adopt = useCallback(
    (runId: string, fixes: CodeFix[]) => {
      const existing = latestFix(fixes, 'diff');
      const opening = latestFix(fixes, 'pull_request');
      if (existing) {
        adopted.current.add(runId);
        setStarted((prev) => union(prev, [runId]));
        storeRoots.current[runId] = existing.options.storeRoot;
        store(existing);
        follow(existing);
      }
      if (opening) {
        setPrRequested((prev) => union(prev, [runId]));
        store(opening);
        follow(opening);
      }
    },
    [follow, store],
  );

  const reset = useCallback(() => {
    generation.current++;
    closeAll();
    storeRoots.current = {};
    adopted.current.clear();
    setDiff({});
    setPr({});
    setStarted([]);
    setStartErrors({});
    setPrRequested([]);
    setPrErrors({});
    setRequesting(false);
    setError(undefined);
  }, [closeAll]);

  const diffs = useMemo(() => Object.values(diff), [diff]);
  const reading = diffs.length > 0 ? readingProgress(diffs) : undefined;
  const allDiffDone =
    started.length > 0 &&
    started.every((id) => {
      const fix = diff[id];
      return (fix !== undefined && isFixDone(fix)) || startErrors[id] !== undefined;
    });
  const opening: Opening = (() => {
    const running = prRequested.some((id) => {
      const fix = pr[id];
      return fix !== undefined && !isFixDone(fix);
    });
    if (requesting || running) return 'pending';
    // A run whose request failed is answered too: the error bar and its card say why.
    const answered =
      prRequested.length > 0 &&
      prRequested.every((id) => {
        const fix = pr[id];
        return (fix !== undefined && isFixDone(fix)) || prErrors[id] !== undefined;
      });
    return answered ? 'done' : 'idle';
  })();

  return {
    diff,
    pr,
    reading,
    allDiffDone,
    opening,
    ...(error !== undefined ? { error } : {}),
    startErrors,
    prErrors,
    start,
    openPullRequests,
    adopt,
    reset,
  };
}
