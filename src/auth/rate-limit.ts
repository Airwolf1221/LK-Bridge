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

  hit(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep();
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}
