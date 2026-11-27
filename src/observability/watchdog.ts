/**
 * v3 F6a.1 (ADR 0076 amendment 1, ADR 0061 amendment 1): the bridge names its next hang.
 *
 * On 24 November 2026 a dashboard request blocked the event loop for twenty minutes while memory grew past the unit's
 * MemoryHigh, and the journal said nothing: requests are logged on completion only, and even the scheduler's lines
 * stopped. Three reports now say what is running, each a warning, each a setting in the registry (`applies: now`):
 *
 * 1. **Slow requests** (SLOW_REQUEST_WARN_MS, 30 s; again every SLOW_REQUEST_REPEAT_MS, 60 s, while it runs): a dashboard
 *    request or an MCP tool call still running, with its method, URL and tool name (never a body or a query string).
 * 2. **Event-loop lag** (EVENT_LOOP_LAG_WARN_MS, 2 s): `perf_hooks.monitorEventLoopDelay` sampled every second; above the
 *    threshold, the lag, what is running (and what finished since the last sample: the block's likely author), heap and
 *    RSS. A blocked loop cannot log until it is free again, so a small **watchdog thread** (a worker, in production)
 *    takes the main thread's heartbeat and, when it stops for longer than the threshold, writes the warning itself,
 *    straight to standard output (the journal), while the block lasts: "event loop blocked" with what is running.
 * 3. **Memory pressure** (MEMORY_WARN_FRACTION, 0.7): RSS above that share of the unit's MemoryHigh (cgroup v2
 *    `memory.high` of the bridge's own cgroup, else `/sys/fs/cgroup/memory.high`), naming the running tasks; again every
 *    five minutes while it stays above. A report only: nothing is stopped or killed.
 *
 * What is running comes from {@link Activities}: the HTTP server registers each request (src/server.ts), the MCP layer
 * each tool call, and `loggedTask` each background task (src/maintenance/task-log.ts).
 */
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

export type ActivityKind = 'request' | 'tool' | 'task';

export interface ActivityView {
  readonly id: number;
  readonly kind: ActivityKind;
  /** `POST /api/admin/reference-types/bulk-accept`, `tool arkona_reference_types`, `maintenance:tree-sweep`. */
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  readonly ms: number;
}

type ActivityEvent =
  | { readonly type: 'begin'; readonly a: Omit<ActivityView, 'ms'> }
  | { readonly type: 'end'; readonly id: number };

/** What is running in this process now (requests, tool calls, background tasks), and what finished lately. */
export class Activities {
  private next = 1;
  private readonly live = new Map<number, Omit<ActivityView, 'ms'>>();
  private ended: (ActivityView & { endedAt: number })[] = [];
  private readonly listeners = new Set<(e: ActivityEvent) => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Registers an activity; the function returned ends it (calling it twice is harmless). */
  begin(kind: ActivityKind, name: string, fields: Readonly<Record<string, unknown>> = {}): () => void {
    const a = { id: this.next++, kind, name, fields, startedAt: this.now() };
    this.live.set(a.id, a);
    this.emit({ type: 'begin', a });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.live.delete(a.id);
      const endedAt = this.now();
      this.ended.push({ ...a, ms: endedAt - a.startedAt, endedAt });
      if (this.ended.length > 50) this.ended = this.ended.slice(-50);
      this.emit({ type: 'end', id: a.id });
    };
  }

  /** The running activities, longest first. */
  running(): ActivityView[] {
    const now = this.now();
    return [...this.live.values()].map((a) => ({ ...a, ms: now - a.startedAt })).sort((x, y) => y.ms - x.ms);
  }

  /** Activities that ended at or after `since`, longest first (at most the last 50). */
  endedSince(since: number): ActivityView[] {
    return this.ended
      .filter((a) => a.endedAt >= since)
      .map(({ endedAt: _e, ...a }) => a)
      .sort((x, y) => y.ms - x.ms);
  }

  /** Follows begins and ends (the watchdog thread). Returns the unsubscribe. */
  subscribe(fn: (e: ActivityEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ActivityEvent): void {
    for (const f of this.listeners) {
      try {
        f(e);
      } catch {
        // a listener never stops an activity
      }
    }
  }
}

/** The process's activities: every request, tool call and background task of this bridge registers here. */
export const processActivities = new Activities();

export interface WatchdogSettings {
  readonly slowRequestWarnMs: number;
  readonly slowRequestRepeatMs: number;
  readonly eventLoopLagWarnMs: number;
  readonly memoryWarnFraction: number;
}

export interface WatchdogLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  info?(obj: Record<string, unknown>, msg: string): void;
}

export interface WatchdogOptions {
  readonly log: WatchdogLog;
  readonly settings: () => WatchdogSettings;
  readonly activities?: Activities;
  readonly now?: () => number;
  /** The process's memory (default `process.memoryUsage()`), bytes. */
  readonly memory?: () => { readonly rss: number; readonly heapUsed: number };
  /** The unit's MemoryHigh in bytes, or null (none, or `max`). Default: read from the cgroup (see the module comment). */
  readonly memoryHigh?: () => number | null;
  /** The event loop's delay (default `monitorEventLoopDelay`): the longest since the last reset, in ms. */
  readonly lag?: { max(): number; reset(): void; stop(): void };
  /** How often the checks run (default 1 s). */
  readonly tickMs?: number;
  /** Start the watchdog thread (production). Default false (tests start many runtimes in one process). */
  readonly thread?: boolean;
  /** The watchdog thread's output: a file descriptor (default 1, standard output). */
  readonly threadFd?: number;
}

const MEMORY_REPEAT_MS = 5 * 60_000;
const mb = (n: number) => Math.round(n / 1048576);

/** Summaries of activities for a log line (at most 10; names and short fields only). */
export function activityLines(list: readonly ActivityView[]): Record<string, unknown>[] {
  return list.slice(0, 10).map((a) => ({ kind: a.kind, name: a.name, ms: a.ms, ...a.fields }));
}

/** The unit's MemoryHigh: the bridge's own cgroup (v2) first, then the root of a namespaced cgroup; null when none. */
export function readMemoryHigh(
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): number | null {
  const candidates: string[] = [];
  try {
    const line = read('/proc/self/cgroup')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    const path = line?.slice(3).trim();
    if (path && path !== '/') candidates.push(`/sys/fs/cgroup${path}/memory.high`);
  } catch {
    // not Linux, or no cgroup v2
  }
  candidates.push('/sys/fs/cgroup/memory.high');
  for (const c of candidates) {
    try {
      const v = read(c).trim();
      if (v === 'max') return null;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // try the next
    }
  }
  return null;
}

export class Watchdog {
  private readonly activities: Activities;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly warned = new Map<number, number>();
  private lag: { max(): number; reset(): void; stop(): void } | null = null;
  private lastTick: number;
  /**
   * How late the timer's own last tick ran, beyond its interval (ms). The histogram's sample of a block can still be
   * pending when the first tick after it runs: that tick's `reset()` then discards it (seen about once in 15 blocks), so
   * the tick's own lateness, which the block cannot hide, is the floor of the lag (PR 106's CI run).
   */
  private tickLateMs = 0;
  private timerAt: number | null = null;
  private memoryAbove = false;
  private memoryWarnedAt = 0;
  private high: { value: number | null; at: number } | null = null;
  private worker: Worker | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly o: WatchdogOptions) {
    this.activities = o.activities ?? processActivities;
    this.now = o.now ?? (() => Date.now());
    this.lastTick = this.now();
    this.lag = o.lag ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.lag ??= histogramLag();
    this.lastTick = this.now();
    const every = this.o.tickMs ?? 1000;
    this.timerAt = performance.now();
    this.timer = setInterval(() => {
      const at = performance.now();
      this.tickLateMs = Math.max(0, at - (this.timerAt ?? at) - every);
      this.timerAt = at;
      this.tick();
    }, every);
    this.timer.unref();
    if (this.o.thread === true) this.startThread();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerAt = null;
    this.tickLateMs = 0;
    this.lag?.stop();
    this.lag = this.o.lag ?? null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate().catch(() => undefined);
  }

  /** One round of the checks (the timer's; tests call it with a fake clock). */
  tick(): void {
    const now = this.now();
    const s = this.o.settings();
    const running = this.activities.running();
    this.slowRequests(now, s, running);
    this.lagCheck(s, running);
    this.memoryCheck(now, s, running);
    this.worker?.postMessage({ type: 'beat', at: now, settings: s });
    this.lastTick = now;
  }

  private slowRequests(now: number, s: WatchdogSettings, running: readonly ActivityView[]): void {
    const live = new Set<number>();
    for (const a of running) {
      if (a.kind !== 'request' && a.kind !== 'tool') continue;
      live.add(a.id);
      if (a.ms < s.slowRequestWarnMs) continue;
      const last = this.warned.get(a.id);
      if (last !== undefined && now - last < s.slowRequestRepeatMs) continue;
      this.warned.set(a.id, now);
      this.o.log.warn(
        { kind: a.kind, ...a.fields, runningMs: a.ms, ...(last !== undefined ? { repeat: true } : {}) },
        'request still running',
      );
    }
    for (const id of this.warned.keys()) if (!live.has(id)) this.warned.delete(id);
  }

  private lagCheck(s: WatchdogSettings, running: readonly ActivityView[]): void {
    if (!this.lag) return;
    // The histogram's longest delay, or the timer's own lateness when the histogram's sample of the block was discarded.
    const lagMs = Math.round(Math.max(this.lag.max(), this.tickLateMs));
    this.tickLateMs = 0;
    this.lag.reset();
    if (lagMs <= s.eventLoopLagWarnMs) return;
    const m = (this.o.memory ?? (() => process.memoryUsage()))();
    this.o.log.warn(
      {
        lagMs,
        running: activityLines(running),
        // What finished since the last sample: a block that has just ended was most likely one of these.
        finished: activityLines(this.activities.endedSince(this.lastTick)),
        memory: { heapUsedMb: mb(m.heapUsed), rssMb: mb(m.rss) },
      },
      'event loop blocked',
    );
  }

  private memoryHighNow(now: number): number | null {
    if (this.o.memoryHigh) return this.o.memoryHigh();
    if (!this.high || now - this.high.at > 60_000) this.high = { value: readMemoryHigh(), at: now };
    return this.high.value;
  }

  private memoryCheck(now: number, s: WatchdogSettings, running: readonly ActivityView[]): void {
    const high = this.memoryHighNow(now);
    if (high === null) return;
    const m = (this.o.memory ?? (() => process.memoryUsage()))();
    const limit = high * s.memoryWarnFraction;
    if (m.rss <= limit) {
      if (this.memoryAbove)
        this.o.log.info?.({ rssMb: mb(m.rss), memoryHighMb: mb(high) }, 'memory pressure eased');
      this.memoryAbove = false;
      return;
    }
    if (this.memoryAbove && now - this.memoryWarnedAt < MEMORY_REPEAT_MS) return;
    this.memoryAbove = true;
    this.memoryWarnedAt = now;
    this.o.log.warn(
      {
        rssMb: mb(m.rss),
        heapUsedMb: mb(m.heapUsed),
        memoryHighMb: mb(high),
        fraction: s.memoryWarnFraction,
        running: activityLines(running),
      },
      `memory pressure: RSS above ${Math.round(s.memoryWarnFraction * 100)}% of MemoryHigh`,
    );
  }

  // ------------------------------------------------------------------------------------------ the watchdog thread

  private startThread(): void {
    const w = new Worker(THREAD_SOURCE, {
      eval: true,
      workerData: {
        fd: this.o.threadFd ?? 1,
        settings: this.o.settings(),
        memoryHigh: this.o.memoryHigh ? this.o.memoryHigh() : readMemoryHigh(),
      },
      stdout: false,
      stderr: false,
    });
    w.unref();
    w.on('error', (err) => this.o.log.warn({ err }, 'the watchdog thread stopped'));
    for (const a of this.activities.running()) w.postMessage({ type: 'begin', a });
    this.unsubscribe = this.activities.subscribe((e) => w.postMessage(e));
    w.postMessage({ type: 'beat', at: this.now(), settings: this.o.settings() });
    this.worker = w;
  }
}

function histogramLag(): { max(): number; reset(): void; stop(): void } {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return {
    max: () => h.max / 1e6,
    reset: () => h.reset(),
    stop: () => h.disable(),
  };
}

/**
 * The watchdog thread: the main thread's heartbeat and activities arrive as messages (delivered even while the main
 * thread is blocked); when the heartbeat stops for longer than the lag threshold, it writes a warning line in the
 * bridge's log format straight to the file descriptor (fd 1: the journal), and again every SLOW_REQUEST_REPEAT_MS while
 * the block lasts. Standard output from a worker would go through the blocked main thread, so it writes with writeSync.
 */
const THREAD_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const live = new Map();
let beat = Date.now();
let settings = workerData.settings;
let reportedAt = 0;
const mb = (n) => Math.round(n / 1048576);
parentPort.on('message', (m) => {
  if (m.type === 'beat') { beat = Date.now(); settings = m.settings || settings; reportedAt = 0; }
  else if (m.type === 'begin') live.set(m.a.id, m.a);
  else if (m.type === 'end') live.delete(m.id);
});
setInterval(() => {
  const now = Date.now();
  const blocked = now - beat;
  if (blocked <= settings.eventLoopLagWarnMs) return;
  if (reportedAt !== 0 && now - reportedAt < settings.slowRequestRepeatMs) return;
  reportedAt = now;
  const rss = process.memoryUsage.rss();
  const running = [...live.values()].map((a) => Object.assign({ kind: a.kind, name: a.name, ms: now - a.startedAt }, a.fields))
    .sort((x, y) => y.ms - x.ms).slice(0, 10);
  const line = {
    level: 40, time: now, component: 'engine', source: 'watchdog-thread',
    blockedMs: blocked, running, memory: { rssMb: mb(rss) },
    ...(workerData.memoryHigh ? { memoryHighMb: mb(workerData.memoryHigh) } : {}),
    msg: 'event loop blocked: the main thread has not answered',
  };
  try { writeSync(workerData.fd, JSON.stringify(line) + '\\n'); } catch {}
}, 250);
`;
