/**
 * v3 F9 (ADR 0074): records the class of every call a governor is asked for (`execute`), so a test can say which class
 * a caller asked for without depending on how the call was routed to the governor (internalRead, a job's step, a
 * download).
 */
import type { Governor } from '../../src/lk/governor/governor.js';
import type { ExecuteRequest, PriorityClass } from '../../src/lk/governor/types.js';

export interface SeenClass {
  readonly opId: string;
  readonly priority: PriorityClass;
  readonly jobId: string | undefined;
  /** v3 F9 review: first claim within its class (the full snapshot's reads). */
  readonly firstClaim: boolean;
  readonly atMs: number;
}

export function recordClasses(governor: Governor, now: () => number = Date.now) {
  const seen: SeenClass[] = [];
  const original = governor.execute.bind(governor);
  (governor as { execute: Governor['execute'] }).execute = <T>(req: ExecuteRequest<T>) => {
    seen.push({
      opId: req.opId,
      priority: req.priority,
      jobId: req.jobId,
      firstClaim: req.firstClaim === true,
      atMs: now(),
    });
    return original(req);
  };
  return {
    seen,
    /** The classes the calls of `opId` were made at (every call when no op is named). */
    classes(opId?: string): PriorityClass[] {
      return [
        ...new Set(seen.filter((s) => opId === undefined || s.opId === opId).map((s) => s.priority)),
      ].sort();
    },
    reset(): void {
      seen.splice(0);
    },
    restore(): void {
      (governor as { execute: Governor['execute'] }).execute = original;
    },
  };
}
