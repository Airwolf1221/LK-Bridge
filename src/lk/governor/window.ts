/**
 * Exact sliding-window counter. Each consumption is an event `{ t, n }` that counts while `now < t + windowMs`.
 * A sliding window that never exceeds its limit also never exceeds it in any fixed window of the same length,
 * so this is safe whichever window style LK uses server-side.
 */
export interface WindowEvent {
  t: number;
  n: number;
}

export class SlidingWindow {
  private events: WindowEvent[] = [];
  private head = 0;
  private total = 0;

  constructor(readonly windowMs: number) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.head < this.events.length) {
      const e = this.events[this.head]!;
      if (e.t > cutoff) break;
      this.total -= e.n;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  used(now: number): number {
    this.prune(now);
    return this.total;
  }

  /** Records `n` units at time `t` (defaults to now). Events must be added in non-decreasing time order,
   * except backdated phantom events from server correction, which are inserted in place. */
  add(now: number, n: number, t = now): WindowEvent {
    this.prune(now);
    const e = { t, n };
    if (n <= 0) return e;
    const last = this.events[this.events.length - 1];
    if (!last || last.t <= t) this.events.push(e);
    else {
      let i = this.events.length - 1;
      while (i > this.head && this.events[i - 1]!.t > t) i--;
      this.events.splice(i, 0, e);
    }
    this.total += n;
    return e;
  }

  /** Gives back an event's units (request never reached LK, or LK refused it before counting). */
  refund(now: number, e: WindowEvent): void {
    this.prune(now);
    if (e.n <= 0 || e.t + this.windowMs <= now) {
      e.n = 0;
      return;
    }
    this.total -= e.n;
    e.n = 0;
  }

  /** Drops `n` units from the oldest live events (server reported fewer than we modelled). */
  removeOldest(now: number, n: number): void {
    this.prune(now);
    let left = n;
    for (let i = this.head; i < this.events.length && left > 0; i++) {
      const e = this.events[i]!;
      const take = Math.min(e.n, left);
      e.n -= take;
      this.total -= take;
      left -= take;
    }
  }

  /**
   * Earliest time at which `used + need <= cap`. Returns `now` if that already holds, `Infinity` if it never can
   * (need > cap).
   */
  readyAt(now: number, need: number, cap: number): number {
    const used = this.used(now);
    if (used + need <= cap) return now;
    if (need > cap) return Number.POSITIVE_INFINITY;
    let excess = used + need - cap;
    for (let i = this.head; i < this.events.length; i++) {
      const e = this.events[i]!;
      excess -= e.n;
      if (excess <= 0) return e.t + this.windowMs;
    }
    return Number.POSITIVE_INFINITY;
  }

  /** When the oldest counted unit expires (the next time capacity frees), or null if empty. */
  nextExpiry(now: number): number | null {
    this.prune(now);
    for (let i = this.head; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (e.n > 0) return e.t + this.windowMs;
    }
    return null;
  }

  /** The live events (units still counting at `now`), oldest first, as copies. For persisting the counters. */
  liveEvents(now: number): WindowEvent[] {
    this.prune(now);
    const out: WindowEvent[] = [];
    for (let i = this.head; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (e.n > 0) out.push({ t: e.t, n: e.n });
    }
    return out;
  }

  /** When the window will be completely empty, or null if it already is. */
  clearsAt(now: number): number | null {
    this.prune(now);
    for (let i = this.events.length - 1; i >= this.head; i--) {
      const e = this.events[i]!;
      if (e.n > 0) return e.t + this.windowMs;
    }
    return null;
  }
}
