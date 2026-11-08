import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useStream } from './stream';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data without a request (live updates). */
  set: (update: (prev: T | undefined) => T | undefined) => void;
}

/** Loads `path` (null: nothing yet). Reloads when `path` changes and whenever the live stream starts afresh. */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const { epoch } = useStream();
  const latest = useRef(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const mine = ++latest.current;
    setLoading(true);
    api.get<T>(path).then(
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

  const reload = useCallback(() => setTick((n) => n + 1), []);
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

/** Reloads `reload` (debounced) when any of `events` arrives on the stream. */
export function useReloadOn(events: readonly string[], reload: () => void, ms = 250): void {
  const { subscribe } = useStream();
  const debounced = useDebounced(reload, ms);
  const key = events.join('|');
  useEffect(() => {
    const offs = key.split('|').map((e) => subscribe(e, debounced));
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
