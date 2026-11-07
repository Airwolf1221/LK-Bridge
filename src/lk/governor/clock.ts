/**
 * Injectable time source. Everything time-dependent in the governor goes through a `Clock`, so tests drive a
 * `FakeClock` and never really sleep.
 */
export type TimerHandle = { readonly id: number };

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Resolves after `ms` on the given clock; rejects with the signal's reason if aborted first. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clock.clearTimeout(handle);
      reject(signal?.reason as Error);
    };
    const handle = clock.setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let nextSystemId = 1;

export const systemClock: Clock = (() => {
  const timers = new Map<number, NodeJS.Timeout>();
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextSystemId++;
      // Node clamps delays above 2^31-1 ms to 1 ms; chain instead.
      const MAX = 2 ** 31 - 1;
      const arm = (remaining: number) => {
        const step = Math.min(remaining, MAX);
        timers.set(
          id,
          setTimeout(() => {
            if (remaining > MAX) arm(remaining - MAX);
            else {
              timers.delete(id);
              fn();
            }
          }, step),
        );
      };
      arm(Math.max(0, ms));
      return { id };
    },
    clearTimeout(handle) {
      const t = timers.get(handle.id);
      if (t) clearTimeout(t);
      timers.delete(handle.id);
    },
  };
})();

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
}

/** Lets pending promise callbacks run. Uses real macrotask turns so real I/O callbacks can land too. */
export async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

/**
 * Deterministic clock for tests. Time only moves when `advance`/`advanceTo`/`runNext` are called; timers fire in
 * time order (FIFO for equal times) with microtasks flushed between them.
 */
export class FakeClock implements Clock {
  private current: number;
  private seq = 0;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(startMs = Date.UTC(2026, 10, 7, 12, 0, 0)) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.current + Math.max(0, ms), seq: this.seq++, fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Time of the earliest pending timer, if any. */
  nextTimerAt(): number | undefined {
    return this.earliest()?.at;
  }

  private earliest(): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of this.timers.values()) {
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }

  /** Fires the earliest timer (moving time forward to it). Returns false when no timer is pending. */
  async runNext(): Promise<boolean> {
    await flushMicrotasks();
    const t = this.earliest();
    if (!t) return false;
    this.timers.delete(t.id);
    if (t.at > this.current) this.current = t.at;
    t.fn();
    await flushMicrotasks();
    return true;
  }

  /** Advances time by `ms`, firing every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.current + ms);
  }

  async advanceTo(target: number): Promise<void> {
    for (;;) {
      await flushMicrotasks();
      const t = this.earliest();
      if (!t || t.at > target) break;
      this.timers.delete(t.id);
      if (t.at > this.current) this.current = t.at;
      t.fn();
    }
    if (target > this.current) this.current = target;
    await flushMicrotasks();
  }

  /** Runs timers until `done()` holds or `maxMs` of fake time passes. Throws if it gives up. */
  async runUntil(done: () => boolean, maxMs = 24 * 3600_000): Promise<void> {
    const limit = this.current + maxMs;
    await flushMicrotasks();
    while (!done()) {
      const t = this.earliest();
      if (!t || t.at > limit) throw new Error('FakeClock.runUntil: condition not met before timers ran out');
      await this.runNext();
    }
  }
}
