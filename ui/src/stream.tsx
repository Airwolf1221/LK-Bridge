import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BACKGROUND_HEADER, apiConfig, inBackground } from './api';

/**
 * The live stream (`/api/admin/stream`, Server-Sent Events). One connection for the whole dashboard; pages subscribe to
 * the events they care about. The browser reconnects by itself and sends `Last-Event-ID`; the bridge then replays what
 * was missed (`hello`, `resumed: true`) or says to start again (`resync`). Either way `epoch` changes on a fresh start,
 * and pages reload what they show. A watchdog reopens a connection that has gone quiet for too long.
 *
 * ADR 0062: a stream the bridge refused (its session ended, a 401) is not opened again blindly every few seconds: the
 * session is checked once (`GET /api/admin/session`) and, signed out, the dashboard goes to the sign-in page (and comes
 * back where it was); so does the stream's own `unauthenticated` event.
 *
 * CR-2026-11-R4 (ADR 0062 decision 1): nothing the stream leads to is a use of the owner's session: the bridge does not
 * count the stream's own requests, the session check is marked as the dashboard's own, and so is every reload a page
 * makes for an event or for the stream starting afresh (`epoch`; see `useApi`).
 */

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface SourceLike {
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((e: Event) => void) | null;
  onopen: ((e: Event) => void) | null;
  readyState: number;
}

export type SourceFactory = (url: string) => SourceLike;

const EVENTS = [
  'hello',
  'resync',
  'heartbeat',
  'budget',
  'job',
  'step',
  'lock',
  'writers',
  'error',
  'controls',
  'policy',
  'proposal',
  'staging',
  'throttled',
  'budget-wait',
  'project',
  'unauthenticated',
] as const;

type Listener = (data: never, at: number) => void;

interface StreamApi {
  status: StreamStatus;
  /** Increases whenever the stream starts afresh (first hello, or a resync): reload what you show. */
  epoch: number;
  subscribe: <T = unknown>(event: string, cb: (data: T, at: number) => void) => () => void;
}

const StreamContext = createContext<StreamApi | null>(null);

const defaultFactory: SourceFactory = (url) => new EventSource(url, { withCredentials: true });

/**
 * ADR 0062: whether the owner is still signed in (false only on a 401; anything else counts as signed in).
 * CR-2026-11-R4: the dashboard's own check (after the stream dropped), so not a use of the session.
 */
export const defaultCheckSession = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${apiConfig.base}/api/admin/session`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', [BACKGROUND_HEADER]: '1' },
    });
    return res.status !== 401;
  } catch {
    return true; // the bridge cannot be reached: try the stream again later
  }
};

export function StreamProvider({
  children,
  url = '/api/admin/stream',
  createSource = defaultFactory,
  onUnauthenticated = () => apiConfig.onUnauthenticated(),
  checkSession = defaultCheckSession,
}: {
  children: ReactNode;
  url?: string;
  createSource?: SourceFactory;
  onUnauthenticated?: () => void;
  checkSession?: () => Promise<boolean>;
}) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [epoch, setEpoch] = useState(0);
  const listeners = useRef(new Map<string, Set<Listener>>());
  const unauth = useRef(onUnauthenticated);
  unauth.current = onUnauthenticated;
  const check = useRef(checkSession);
  check.current = checkSession;

  useEffect(() => {
    let source: SourceLike | null = null;
    let closed = false;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let heartbeatMs = 15_000;

    const arm = () => {
      clearTimeout(watchdog);
      // Three missed heartbeats: the connection is dead even if the browser has not noticed.
      watchdog = setTimeout(
        () => {
          setStatus('reconnecting');
          open();
        },
        heartbeatMs * 3 + 1000,
      );
    };

    const emit = (type: string, raw: string) => {
      let parsed: { at?: number; data?: unknown } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return;
      }
      // CR-2026-11-R4: a live event is not the owner's input: whatever a page asks for in answer is the dashboard's own.
      inBackground(() => {
        for (const cb of listeners.current.get(type) ?? [])
          (cb as (d: unknown, at: number) => void)(parsed.data, parsed.at ?? Date.now());
      });
    };

    const open = () => {
      if (closed) return;
      source?.close();
      clearTimeout(reopen);
      const s = createSource(url);
      source = s;
      s.onopen = () => {
        setStatus('live');
        arm();
      };
      s.onerror = () => {
        setStatus('reconnecting');
        // A closed source will not retry by itself (for example after a 401 or a proxy error). ADR 0062: check the session
        // first; signed out, go to the sign-in page instead of trying again every few seconds.
        if (s.readyState === 2 && !closed)
          void check.current().then((signedIn) => {
            if (closed) return;
            if (!signedIn) {
              closed = true;
              setStatus('ended');
              unauth.current?.();
              return;
            }
            reopen = setTimeout(open, 3000);
          });
      };
      for (const type of EVENTS) {
        s.addEventListener(type, (e) => {
          if (type === 'hello') {
            const d = (JSON.parse(e.data) as { data?: { heartbeatMs?: number; resumed?: boolean } }).data;
            if (d?.heartbeatMs) heartbeatMs = d.heartbeatMs;
            setStatus('live');
            if (!d?.resumed) setEpoch((n) => n + 1);
          } else if (type === 'resync') {
            setStatus('live');
            setEpoch((n) => n + 1);
          } else if (type === 'unauthenticated') {
            setStatus('ended');
            s.close();
            unauth.current?.();
          }
          // After the `hello` above has set the heartbeat interval: any event proves the connection is alive.
          if (type !== 'unauthenticated') arm();
          emit(type, e.data);
        });
      }
    };
    open();
    return () => {
      closed = true;
      clearTimeout(reopen);
      clearTimeout(watchdog);
      source?.close();
    };
  }, [url, createSource]);

  const api = useMemo<StreamApi>(
    () => ({
      status,
      epoch,
      subscribe(event, cb) {
        let set = listeners.current.get(event);
        if (!set) listeners.current.set(event, (set = new Set()));
        const l = cb as unknown as Listener;
        set.add(l);
        return () => set.delete(l);
      },
    }),
    [status, epoch],
  );
  return <StreamContext.Provider value={api}>{children}</StreamContext.Provider>;
}

export function useStream(): StreamApi {
  const s = useContext(StreamContext);
  if (!s) throw new Error('useStream needs a <StreamProvider>');
  return s;
}

/** Calls `cb` for each `event` while the component is mounted. */
export function useStreamEvent<T = unknown>(event: string, cb: (data: T, at: number) => void): void {
  const { subscribe } = useStream();
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => subscribe<T>(event, (d, at) => ref.current(d, at)), [subscribe, event]);
}
