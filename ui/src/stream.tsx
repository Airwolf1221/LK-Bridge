import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The live stream (`/api/admin/stream`, Server-Sent Events). One connection for the whole dashboard; pages subscribe to
 * the events they care about. The browser reconnects by itself and sends `Last-Event-ID`; the bridge then replays what
 * was missed (`hello`, `resumed: true`) or says to start again (`resync`). Either way `epoch` changes on a fresh start,
 * and pages reload what they show. A watchdog reopens a connection that has gone quiet for too long.
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
  'throttled',
  'budget-wait',
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

export function StreamProvider({
  children,
  url = '/api/admin/stream',
  createSource = defaultFactory,
  onUnauthenticated,
}: {
  children: ReactNode;
  url?: string;
  createSource?: SourceFactory;
  onUnauthenticated?: () => void;
}) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [epoch, setEpoch] = useState(0);
  const listeners = useRef(new Map<string, Set<Listener>>());
  const unauth = useRef(onUnauthenticated);
  unauth.current = onUnauthenticated;

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
      for (const cb of listeners.current.get(type) ?? [])
        (cb as (d: unknown, at: number) => void)(parsed.data, parsed.at ?? Date.now());
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
        // A closed source will not retry by itself (for example after a 401 or a proxy error): try again later.
        if (s.readyState === 2 && !closed) reopen = setTimeout(open, 3000);
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
