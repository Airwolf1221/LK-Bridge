/**
 * In-process mutexes with fair (FIFO) wait queues (PLAN §6.2).
 *
 * Lock keys:
 * - `doc:{documentId}` for document-level writes (registry `concurrency: document`: blocks, rows, infoboxes, boards,
 *   lanes, events, features, document content);
 * - `res:{resourceId}` for resource-level writes (registry `concurrency: resource`: update, move, delete, restore,
 *   save-as-template, properties and their rows, tags, new documents);
 * - `res:{parentId}` (or `res:@root`) for resource creates, which lock the parent;
 * - `cal:{calendarId}` and `asset:{assetId}` for calendar and asset updates and deletes.
 *
 * Ordering rules, which make deadlock impossible:
 * 1. A step holds at most one lock, and only for its own duration (read-for-version, write, verify).
 * 2. A step takes its lock BEFORE its writer slot, and a slot holder never waits for a lock. So no cycle can form
 *    between locks and slots either.
 * 3. Waiters are served strictly in arrival order, so nobody starves.
 */

export interface LockOwner {
  readonly jobId: string;
  readonly stepNo: number;
  readonly principalId?: string;
}

export interface LockEvent {
  readonly type: 'acquired' | 'waiting' | 'released';
  readonly key: string;
  readonly owner: LockOwner;
  readonly atMs: number;
}

interface Waiter {
  readonly owner: LockOwner;
  readonly since: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (e: unknown) => void;
  cleanup: () => void;
}

interface LockState {
  holder: { owner: LockOwner; since: number } | null;
  readonly queue: Waiter[];
}

export class LockManager {
  private readonly locks = new Map<string, LockState>();

  constructor(
    private readonly now: () => number,
    private readonly onEvent: (e: LockEvent) => void = () => {},
  ) {}

  /** True when `acquire` would succeed at once. */
  isFree(key: string): boolean {
    const s = this.locks.get(key);
    return !s || (!s.holder && s.queue.length === 0);
  }

  /** Resolves with a release function once `owner` holds `key`. Rejects with the signal's reason if aborted first. */
  acquire(key: string, owner: LockOwner, signal?: AbortSignal): Promise<() => void> {
    let s = this.locks.get(key);
    if (!s) this.locks.set(key, (s = { holder: null, queue: [] }));
    const state = s;
    if (!state.holder && state.queue.length === 0) {
      return Promise.resolve(this.grant(key, state, owner));
    }
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, since: this.now(), resolve, reject, cleanup: () => {} };
      state.queue.push(waiter);
      if (signal) {
        const onAbort = () => {
          const i = state.queue.indexOf(waiter);
          if (i >= 0) state.queue.splice(i, 1);
          this.gc(key, state);
          reject(signal.reason as Error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.onEvent({ type: 'waiting', key, owner, atMs: this.now() });
    });
  }

  private grant(key: string, state: LockState, owner: LockOwner): () => void {
    state.holder = { owner, since: this.now() };
    this.onEvent({ type: 'acquired', key, owner, atMs: this.now() });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.holder = null;
      this.onEvent({ type: 'released', key, owner, atMs: this.now() });
      const next = state.queue.shift();
      if (next) {
        next.cleanup();
        next.resolve(this.grant(key, state, next.owner));
      } else {
        this.gc(key, state);
      }
    };
  }

  private gc(key: string, state: LockState): void {
    if (!state.holder && state.queue.length === 0 && this.locks.get(key) === state) this.locks.delete(key);
  }

  /** Held locks and their wait queues (for the Concurrent Writers page). */
  state(): {
    key: string;
    holder: { jobId: string; stepNo: number; since: number };
    waiting: { jobId: string; stepNo: number; since: number }[];
  }[] {
    const out = [];
    for (const [key, s] of this.locks) {
      if (!s.holder) continue;
      out.push({
        key,
        holder: { jobId: s.holder.owner.jobId, stepNo: s.holder.owner.stepNo, since: s.holder.since },
        waiting: s.queue.map((w) => ({ jobId: w.owner.jobId, stepNo: w.owner.stepNo, since: w.since })),
      });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}
