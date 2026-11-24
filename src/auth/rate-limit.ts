/**
 * In-memory sliding-window counter, keyed by string (client IP, or a global key).
 * The bridge is a single process, so process memory is the right scope.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Milliseconds until `key` may try again, or 0 if it is under the limit. */
  retryAfterMs(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, (list[list.length - this.limit] ?? 0) + this.windowMs - this.now());
  }

  /**
   * v3 F7c (ADR 0075): when the `k`-th further hit (0: the next one) may be counted, if every further hit waits its turn:
   * now while there is room; then as the window moves past the hits counted (a later cycle a whole window on). An
   * estimate for display (an expected time), never a promise.
   */
  availableAt(key: string, k = 0): number {
    const list = this.recent(key);
    const idx = list.length - this.limit + k;
    if (idx < 0) return this.now();
    if (list.length === 0) return this.now() + this.windowMs * Math.floor(k / this.limit);
    const cycle = Math.floor(idx / list.length);
    return list[idx % list.length]! + this.windowMs * (cycle + 1);
  }

  /** Counts one hit now and returns its timestamp, so that a reservation can be given back with {@link release}. */
  hit(key: string): number {
    const list = this.recent(key);
    const at = this.now();
    list.push(at);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep();
    return at;
  }

  /** Gives back one hit counted at `at` (a reservation that turned out not to be a failure). */
  release(key: string, at: number): void {
    const list = this.hits.get(key);
    if (!list) return;
    const i = list.lastIndexOf(at);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.hits.delete(key);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}
