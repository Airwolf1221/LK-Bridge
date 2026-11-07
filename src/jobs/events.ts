/** Typed events for the dashboard (chunk 5's SSE stream). Listeners can never break the engine. */
import type { LockEvent } from './locks.js';
import type { ErrorRecordView } from './repo.js';
import type { ControlsView, JobView, StepView, WritersView } from './types.js';

export interface JobEngineEvents {
  /** A job was created, or anything about it changed (status, progress, wait reason, flags). */
  job: { readonly type: 'created' | 'updated'; readonly job: JobView };
  /** A step reached a final state (succeeded, failed, uncertain, cancelled). */
  step: {
    readonly jobId: string;
    readonly principalId: string;
    readonly profile: string;
    readonly step: StepView;
  };
  /** A lock was acquired, waited for, or released. */
  lock: LockEvent;
  /** A writer slot changed (busy/idle, WRITERS_MAX, wait queue). */
  writers: WritersView;
  /** A failed call (or refused step) was recorded. */
  error: ErrorRecordView;
  /** Pause all writes, drain, read-only override or WRITERS_MAX changed. */
  controls: ControlsView;
  /** An owner command or policy change (src/policy): the same facts as its audit_log row. */
  policy: {
    readonly action: string;
    readonly actor: string;
    readonly target: string | null;
    readonly before?: unknown;
    readonly after?: unknown;
  };
  /** A proposal was captured or changed state (src/policy). */
  proposal: {
    readonly type: 'captured' | 'updated';
    readonly proposalId: string;
    readonly state: string;
    readonly principalId: string;
    readonly profile: string;
    readonly jobId: string | null;
  };
}

type Listener<E extends keyof JobEngineEvents> = (event: JobEngineEvents[E]) => void;

export class JobEventEmitter {
  private readonly listeners = new Map<keyof JobEngineEvents, Set<(e: never) => void>>();

  /** Subscribes; returns the unsubscribe function. */
  on<E extends keyof JobEngineEvents>(event: E, cb: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  emit<E extends keyof JobEngineEvents>(event: E, payload: JobEngineEvents[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as Listener<E>)(payload);
      } catch {
        // A listener must never break the engine.
      }
    }
  }
}
