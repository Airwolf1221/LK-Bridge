/**
 * The writer pool (PLAN §6.2): `max` slots; only write steps need one. `setMax` takes effect at once: raising it
 * admits waiters immediately, lowering it lets busy slots finish and admits nobody new until the count fits.
 *
 * The pool is shared by every project (WRITERS_MAX is bridge-wide, v2 A1). Fairness across projects: when a slot
 * frees, the projects with waiters take turns (round-robin, in the order their oldest waiter arrived), and within a
 * project waiters are served in arrival order. So a project with a long queue of writes cannot keep another project's
 * write waiting for more than one turn per slot.
 */
import { WRITERS_LIMIT, WRITERS_MIN } from '../config/jobs.js';
import type { WriterSlotView, WritersView } from './types.js';

export interface SlotInfo {
  /** The LegendKeeper project the write goes to (v2 A1). */
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly opId: string;
  readonly principalId?: string;
  readonly profile?: string;
  readonly lockKey: string | null;
  readonly resourceId: string | null;
  readonly documentId: string | null;
}

interface Busy extends SlotInfo {
  readonly slot: number;
  readonly since: number;
}

interface Waiter {
  readonly info: SlotInfo;
  readonly resolve: (release: () => void) => void;
  readonly reject: (e: unknown) => void;
  cleanup: () => void;
}

export class WriterPool {
  private maxSlots: number;
  private readonly busy = new Map<number, Busy>();
  private readonly queue: Waiter[] = [];
  /** The project the last slot went to (round-robin across projects). */
  private lastProject: string | null = null;

  constructor(
    max: number,
    private readonly now: () => number,
    private readonly onChange: (view: WritersView) => void = () => {},
  ) {
    this.maxSlots = clampWriters(max);
  }

  get max(): number {
    return this.maxSlots;
  }

  setMax(n: number): void {
    this.maxSlots = clampWriters(n);
    this.admit();
    this.onChange(this.view());
  }

  acquire(info: SlotInfo, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { info, resolve, reject, cleanup: () => {} };
      this.queue.push(waiter);
      if (signal) {
        const onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(signal.reason as Error);
          this.onChange(this.view());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.admit();
      this.onChange(this.view());
    });
  }

  private freeSlot(): number | null {
    if (this.busy.size >= this.maxSlots) return null;
    for (let i = 1; i <= WRITERS_LIMIT; i++) if (!this.busy.has(i)) return i;
    return null;
  }

  /** The next waiter: the project after the last one served (round-robin), then that project's oldest waiter. */
  private next(): number {
    const projects: string[] = [];
    for (const w of this.queue) if (!projects.includes(w.info.projectId)) projects.push(w.info.projectId);
    if (projects.length === 0) return -1;
    let pick = projects[0]!;
    if (this.lastProject !== null && projects.length > 1) {
      // Projects in a stable order (by name) so "after the last one" is well defined.
      const order = [...projects].sort();
      const after = order.find((p) => p > this.lastProject!);
      pick = after ?? order[0]!;
    }
    return this.queue.findIndex((w) => w.info.projectId === pick);
  }

  private admit(): void {
    for (;;) {
      if (this.queue.length === 0) return;
      const slot = this.freeSlot();
      if (slot === null) return;
      const i = this.next();
      const head = this.queue[i]!;
      this.queue.splice(i, 1);
      this.lastProject = head.info.projectId;
      head.cleanup();
      this.busy.set(slot, { ...head.info, slot, since: this.now() });
      let released = false;
      head.resolve(() => {
        if (released) return;
        released = true;
        this.busy.delete(slot);
        this.admit();
        this.onChange(this.view());
      });
    }
  }

  view(): WritersView {
    const slots: WriterSlotView[] = [];
    const shown = Math.max(this.maxSlots, ...[...this.busy.keys()]);
    for (let i = 1; i <= shown; i++) {
      const b = this.busy.get(i);
      slots.push(
        b
          ? {
              slot: i,
              state: 'busy',
              projectId: b.projectId,
              jobId: b.jobId,
              stepNo: b.stepNo,
              opId: b.opId,
              ...(b.principalId !== undefined ? { principalId: b.principalId } : {}),
              ...(b.profile !== undefined ? { profile: b.profile } : {}),
              lockKey: b.lockKey,
              resourceId: b.resourceId,
              documentId: b.documentId,
              since: b.since,
            }
          : { slot: i, state: 'idle' },
      );
    }
    return {
      max: this.maxSlots,
      busy: this.busy.size,
      slots,
      waiting: this.queue.map((w) => ({
        projectId: w.info.projectId,
        jobId: w.info.jobId,
        stepNo: w.info.stepNo,
        opId: w.info.opId,
      })),
    };
  }
}

export function clampWriters(n: number): number {
  if (!Number.isInteger(n) || n < WRITERS_MIN || n > WRITERS_LIMIT) {
    throw new RangeError(`WRITERS_MAX must be an integer from ${WRITERS_MIN} to ${WRITERS_LIMIT}`);
  }
  return n;
}
