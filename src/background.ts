/**
 * v3 F6a.1 (ADR 0076 amendment 1): background work an action starts, owned by the runtime.
 *
 * The sandbox's `f6a-reftypes` (24 November 2026): the governance check "Publish vocabulary" starts once its job has
 * succeeded ran after the test had stopped the bridge and closed the database: `TypeError: The database connection is
 * not open` from `packs/service.ts` `governance` → `PackStore.newVersion`. It was started with `void …catch(…)`: nobody
 * waited for it, so a stop could not either.
 *
 * Every such piece of work now goes through a {@link BackgroundRunner}:
 *
 * - `trigger(key, …)`: **debounced** (a burst of triggers for one key is one run, after `debounceMs`), **one run at a
 *   time per key** (a trigger while it runs queues ONE more run after it, never a second at once), with an AbortSignal;
 * - `track(label, promise)`: work already started (a job's follow-up), kept until it settles;
 * - `stop()`: no new work; pending debounces dropped; every signal aborted; every run awaited (bounded). A run that
 *   ends because it was aborted is logged at debug, never as an error. The runtime stops it before the engine and the
 *   database.
 */

export interface BackgroundLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

interface Keyed {
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<unknown> | null;
  /** A trigger arrived while it ran: one more run after it. */
  again: { label: string; fn: (signal: AbortSignal) => Promise<unknown> } | null;
}

export class BackgroundRunner {
  private readonly keyed = new Map<string, Keyed>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private stopped = false;

  constructor(
    private readonly o: {
      readonly log?: BackgroundLog;
      /** Default debounce of `trigger` (ms). */
      readonly debounceMs?: number;
    } = {},
  ) {}

  /** The signal every piece of work receives: aborted by `stop()`. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Runs `fn` for `key` after `debounceMs` (default the runner's), coalescing triggers: one run at a time per key, and
   * a trigger during a run makes exactly one more run after it. Ignored once stopped.
   */
  trigger(
    key: string,
    label: string,
    fn: (signal: AbortSignal) => Promise<unknown>,
    o: { readonly debounceMs?: number } = {},
  ): void {
    if (this.stopped) return;
    let k = this.keyed.get(key);
    if (!k) {
      k = { timer: null, running: null, again: null };
      this.keyed.set(key, k);
    }
    if (k.running) {
      k.again = { label, fn };
      return;
    }
    if (k.timer) clearTimeout(k.timer);
    const entry = k;
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        this.runKeyed(key, entry, label, fn);
      },
      o.debounceMs ?? this.o.debounceMs ?? 1000,
    );
    entry.timer.unref?.();
  }

  private runKeyed(
    key: string,
    k: Keyed,
    label: string,
    fn: (signal: AbortSignal) => Promise<unknown>,
  ): void {
    if (this.stopped) return;
    const p = this.guarded(label, () => fn(this.controller.signal)).finally(() => {
      k.running = null;
      const next = k.again;
      k.again = null;
      if (next && !this.stopped) this.runKeyed(key, k, next.label, next.fn);
      else if (!k.timer) this.keyed.delete(key);
    });
    k.running = p;
  }

  /** Keeps work already started until it settles (its failure logged, an abort at debug). Returns it. */
  track<T>(label: string, p: Promise<T>): Promise<T | undefined> {
    return this.guarded(label, () => p);
  }

  private guarded<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
    const p: Promise<T | undefined> = (async () => {
      try {
        return await f();
      } catch (err) {
        // An abort (the stop's signal, or a read it cut short) is not a failure; anything else is, even during a stop.
        if (isAbort(err) || (this.controller.signal.aborted && err === this.controller.signal.reason))
          this.o.log?.debug?.({ task: label }, 'background work stopped with the bridge');
        else this.o.log?.warn({ err, task: label }, `${label} failed`);
        return undefined;
      }
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /** Waits for everything running now (tests). */
  async settled(): Promise<void> {
    while (this.inflight.size > 0 || [...this.keyed.values()].some((k) => k.timer !== null)) {
      if (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
      else await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** How many runs are in flight or waiting for their debounce (tests, diagnostics). */
  pending(): number {
    return this.inflight.size + [...this.keyed.values()].filter((k) => k.timer !== null).length;
  }

  /**
   * Stops: nothing new starts, pending debounces are dropped, every run's signal is aborted and every run awaited (at
   * most `timeoutMs`). True when everything ended in time.
   */
  async stop(timeoutMs = 10_000): Promise<boolean> {
    this.stopped = true;
    for (const k of this.keyed.values()) {
      if (k.timer) clearTimeout(k.timer);
      k.timer = null;
      k.again = null;
    }
    this.controller.abort();
    if (this.inflight.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      Promise.allSettled([...this.inflight]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return done;
  }
}

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // `signal.throwIfAborted()` throws an AbortError; the governor's read cut short by the signal is a BridgeLkError ABORTED.
  return err.name === 'AbortError' || (err as { code?: unknown }).code === 'ABORTED';
}
