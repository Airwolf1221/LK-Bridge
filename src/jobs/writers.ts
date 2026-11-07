/**
 * The writer pool (PLAN §6.2): `max` slots; only write steps need one. `setMax` takes effect at once: raising it
 * admits waiters immediately, lowering it lets busy slots finish and admits nobody new until the count fits.
 * Waiters are served in arrival order.
 */
import { WRITERS_LIMIT, WRITERS_MIN } from '../config/jobs.js';
import type { WriterSlotView, WritersView } from './types.js';

export interface SlotInfo {
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

  private admit(): void {
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      const slot = this.freeSlot();
      if (slot === null) return;
      this.queue.shift();
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
      waiting: this.queue.map((w) => ({ jobId: w.info.jobId, stepNo: w.info.stepNo, opId: w.info.opId })),
    };
  }
}

export function clampWriters(n: number): number {
  if (!Number.isInteger(n) || n < WRITERS_MIN || n > WRITERS_LIMIT) {
    throw new RangeError(`WRITERS_MAX must be an integer from ${WRITERS_MIN} to ${WRITERS_LIMIT}`);
  }
  return n;
}
