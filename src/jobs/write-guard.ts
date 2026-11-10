/**
 * The write guard hook (v2 C2a, ADR 0032): a check the engine makes on EVERY write path, besides the policy gate. The
 * protected canonical facts rule (src/facts/canonical.ts) is the one guard today: a write that would make a
 * protected change becomes a proposal that needs the owner's canonical approval, whatever the caller's scope.
 *
 * The engine calls it twice:
 * - `entry`, once per `run` / `submit`, with every operation of the request, after the policy gate allowed or proposed
 *   each one (a denied request never reaches it). It may allow, deny (nothing is queued) or force a proposal flagged
 *   for canonical approval. It sees the whole request at once, so a batch is judged as the sequence it is.
 * - `inLock`, before each write step is sent, inside the step's lock, with the read the engine made there (if any).
 *   It throws a `JobsError` (normally `CanonicalApprovalRequiredError`) to refuse; nothing is sent then.
 *
 * A guard that throws at entry counts as a deny (fail closed).
 */
import type {
  JobKind,
  JobOrigin,
  JobView,
  LifecycleMarker,
  OpParams,
  Principal,
  StepOptions,
  StepView,
} from './types.js';
import type { ProposalExtras } from './policy.js';

export interface WriteGuardEntry {
  readonly project: string;
  readonly principal: Principal;
  readonly origin: JobOrigin;
  readonly jobKind: JobKind;
  readonly items: readonly {
    readonly op: string;
    readonly params: OpParams;
    readonly options: StepOptions;
  }[];
  /** Reads the calling tool already made in this call (the guard may use them instead of reading again). */
  readonly prefetched?: ProposalExtras['prefetched'];
  /** The policy gate's verdict for the request: `allow` (scope write, or approved work) or `propose`. */
  readonly gate: 'allow' | 'propose';
  /** v2 C2c: the lifecycle change the request declares (bridge code only: `BatchSubmit.lifecycle`). */
  readonly lifecycle?: LifecycleMarker;
}

export type WriteGuardVerdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string; readonly opId: string; readonly stepIndex?: number }
  /** Turn the request into a proposal that only the owner's canonical approval can run. */
  | { readonly decision: 'propose_canonical'; readonly reason: string; readonly changes: readonly unknown[] };

export interface WriteGuardInLock {
  readonly job: JobView;
  readonly step: StepView;
  readonly opId: string;
  readonly params: OpParams;
  /** v2 C2c: the job's stored options (its lifecycle marker, when it is a lifecycle job). */
  readonly jobOptions?: Readonly<Record<string, unknown>>;
  /** The read the engine made inside the lock for this step (its reader), when it made one. */
  readonly current: { readonly body: unknown; readonly entity: unknown } | undefined;
  /** One more governed read, inside the lock, for the job (counted against its budget). */
  read(opId: string, params: OpParams): Promise<unknown>;
}

export interface WriteGuard {
  entry(input: WriteGuardEntry): Promise<WriteGuardVerdict> | WriteGuardVerdict;
  inLock?(input: WriteGuardInLock): Promise<void> | void;
}

/**
 * v2 C2c (ADR 0035): several guards as one. At entry, the first deny wins; otherwise any `propose_canonical` makes the
 * request a canonical proposal (the reasons and changes of all of them together); otherwise allow. Inside the lock each
 * guard is asked in turn (the first to throw refuses).
 */
export function combineGuards(...guards: readonly WriteGuard[]): WriteGuard {
  return {
    async entry(input) {
      const proposals: { reason: string; changes: readonly unknown[] }[] = [];
      for (const g of guards) {
        const v = await g.entry(input);
        if (v.decision === 'deny') return v;
        if (v.decision === 'propose_canonical') proposals.push({ reason: v.reason, changes: v.changes });
      }
      if (proposals.length === 0) return { decision: 'allow' };
      return {
        decision: 'propose_canonical',
        reason: proposals.map((p) => p.reason).join('; and '),
        changes: proposals.flatMap((p) => p.changes),
      };
    },
    async inLock(input) {
      for (const g of guards) await g.inLock?.(input);
    },
  };
}
