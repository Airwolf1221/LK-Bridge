import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, inBackground, inBackgroundNow } from './api';
import { useStream } from './stream';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /**
   * Loads it again. Called from the dashboard's own work (`inBackground`: a timer, a live event), the request is marked
   * as the dashboard's own (CR-2026-11-R4); from the owner's action, it is the owner's.
   */
  reload: () => void;
  /** Replace the data without a request (live updates). */
  set: (update: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Loads `path` (null: nothing yet). Reloads when `path` changes and whenever the live stream starts afresh.
 * CR-2026-11-R4: a reload because the stream started afresh, or one asked for by the dashboard's own work, is sent as
 * the dashboard's own request (not a use of the session); a new path or the owner's reload is the owner's.
 */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const { epoch } = useStream();
  const latest = useRef(0);
  /** The path of the last load (undefined before the first). */
  const loaded = useRef<string | undefined>(undefined);
  /** Who asked for the reload now due: the owner wins over the dashboard's own when both did. */
  const asked = useRef<'owner' | 'own' | null>(null);

  useEffect(() => {
    if (path === null) {
      loaded.current = undefined;
      setLoading(false);
      return;
    }
    const own = loaded.current === path && asked.current !== 'owner';
    loaded.current = path;
    asked.current = null;
    const mine = ++latest.current;
    setLoading(true);
    api.get<T>(path, { own }).then(
      (d) => {
        if (mine !== latest.current) return;
        setData(d);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== latest.current) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', String(e)));
        setLoading(false);
      },
    );
  }, [path, tick, epoch]);

  const reload = useCallback(() => {
    if (asked.current !== 'owner') asked.current = inBackgroundNow() ? 'own' : 'owner';
    setTick((n) => n + 1);
  }, []);
  const set = useCallback((update: (prev: T | undefined) => T | undefined) => setData(update), []);
  return { data, error, loading, reload, set };
}

/** Calls `fn` at most once per `ms` after a burst of calls (trailing). */
export function useDebounced(fn: () => void, ms: number): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(), ms);
  }, [ms]);
}

/**
 * Reloads `reload` (debounced) when any of `events` arrives on the stream. `accept`, when given, sees each event's data
 * and decides whether it concerns this page (for example, only the selected project's events). CR-2026-11-R4: as the
 * dashboard's own work (`inBackground`): the reload is not a use of the owner's session.
 */
export function useReloadOn(
  events: readonly string[],
  reload: () => void,
  ms = 250,
  accept?: (data: unknown) => boolean,
): void {
  const { subscribe } = useStream();
  const debounced = useDebounced(() => inBackground(reload), ms);
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const key = events.join('|');
  useEffect(() => {
    const offs = key.split('|').map((e) =>
      subscribe(e, (data: unknown) => {
        if (!acceptRef.current || acceptRef.current(data)) debounced();
      }),
    );
    return () => offs.forEach((off) => off());
  }, [subscribe, debounced, key]);
}

/** Current time, refreshed every `ms` (countdowns, "ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
