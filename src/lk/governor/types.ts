import type { PriorityClass } from '../../config/lk.js';
import type { BridgeLkError } from '../errors.js';
import type { OperationKind, TierId } from '../registry-types.js';

export type { PriorityClass } from '../../config/lk.js';
export const PRIORITY_CLASSES: readonly PriorityClass[] = ['P0', 'P1', 'P2', 'P3'];

/** The order LK consumes tiers in (PLAN §1.2), followed by the bridge-only tiers. */
export const TIER_ORDER: readonly TierId[] = [
  'write-min',
  'write-hour',
  'key-min',
  'key-hour',
  'key-day',
  'project-hour',
  'items-min',
  'items-hour',
  'upload',
];

/** What one call draws. Every listed tier takes 1 unit, except `items-*`, which take `items`. */
export interface CostSpec {
  readonly tiers: readonly TierId[];
  /** `createManyResources` item count (1–100). Required when `items-*` tiers are listed. */
  readonly items?: number;
}

export type VerifyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export interface ExecuteRequest<T> {
  /** Registry `operationId` (or a descriptive id for non-registry calls such as the signed upload PUT). */
  readonly opId: string;
  readonly kind: OperationKind;
  readonly costs: CostSpec;
  readonly priority: PriorityClass;
  /** Fair-share key: calls of the same class round-robin across job ids. */
  readonly jobId?: string;
  /** Sent as `Idempotency-Key` on POST (and reused on every retry). Without it a POST is never retried. */
  readonly idempotencyKey?: string;
  /** Cancels the call while queued or in flight. */
  readonly signal?: AbortSignal;
  /**
   * Makes exactly one LK request through the governed fetch (the SDK client from `createLkClient`, or
   * `governor.fetch`). Must honour `signal`. May return the raw `Response`; non-2xx responses then throw.
   */
  readonly run: (signal: AbortSignal) => Promise<Response | T>;
  /**
   * Re-reads after a retried write met 412 / 409 DUPLICATE_ID / 404 or ALREADY_DELETED (PLAN §5.3) and decides
   * whether the earlier, ambiguous attempt already did the work. Make LK calls via `governor.execute` as usual.
   */
  readonly verify?: (ctx: {
    readonly error: BridgeLkError;
    readonly signal: AbortSignal;
  }) => Promise<VerifyResult<T>>;
}

export interface TierSnapshot {
  readonly tier: TierId;
  /** Effective limit (server-observed if it differs from config); null = reactive only. */
  readonly limit: number | null;
  readonly configuredLimit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly windowMs: number | null;
  /** Server-reported reset if this tier was the last one LK reported and it is still ahead; otherwise the
   * moment the oldest counted unit leaves the window. Null when nothing is counted. */
  readonly resetAtMs: number | null;
  /** Set while LK has refused this tier (429) until Retry-After. */
  readonly blockedUntilMs: number | null;
  readonly inFlight: number;
  readonly reactiveOnly: boolean;
  /** Last server correction: what LK said vs what the model held at that moment. */
  readonly drift: {
    readonly atMs: number;
    readonly observedUsed: number;
    readonly modelledUsed: number;
    readonly delta: number;
  } | null;
}

export interface BudgetSnapshot {
  readonly atMs: number;
  readonly tiers: Readonly<Record<TierId, TierSnapshot>>;
  readonly queues: Readonly<Record<PriorityClass, number>>;
  readonly inFlight: number;
  readonly writeSpacingMs: number;
  readonly nextWriteAtMs: number | null;
}

export interface SampleEvent {
  readonly atMs: number;
  readonly opId: string;
  readonly status: number;
  /** Tier the headers were matched to, or null if no drawn tier fits them. */
  readonly tier: TierId | null;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly modelledUsed: number | null;
  readonly observedUsed: number;
}

export interface ThrottledEvent {
  readonly atMs: number;
  readonly opId: string;
  readonly code: string | undefined;
  readonly tiers: readonly TierId[];
  readonly retryAtMs: number;
}

export interface BudgetWaitEvent {
  readonly atMs: number;
  readonly opId: string;
  readonly priority: PriorityClass;
  readonly jobId: string | undefined;
  readonly tier: TierId;
  readonly retryAtMs: number;
}

export interface GovernorEvents {
  sample: SampleEvent;
  throttled: ThrottledEvent;
  'budget-wait': BudgetWaitEvent;
}

export interface EstimateInput {
  readonly reads?: number;
  readonly writes?: number;
  /** Items created through `createManyResources`; adds `ceil(items / 100)` write calls on top of `writes`. */
  readonly createManyItems?: number;
  /** Class the work would run at (default P2, jobs). Its reserve floor shrinks the usable budget. */
  readonly priority?: PriorityClass;
}

export interface TierEstimate {
  readonly tier: TierId;
  readonly demand: number;
  /** Units the class may still use right now. */
  readonly available: number;
  /** Units the class may use per full window. */
  readonly capacityPerWindow: number;
  readonly timeMs: number;
}

export interface Estimate {
  /** Projected wall-clock time for the workload at the class's budget and write pacing. */
  readonly wallClockMs: number;
  /** The tier that bounds the time (or, if nothing waits, the one left with least headroom). `pacing` when
   * write spacing dominates. */
  readonly tightestTier: TierId | 'pacing';
  readonly fitsToday: boolean;
  readonly dayRemaining: number;
  readonly dayNeeded: number;
  readonly pacingMs: number;
  readonly calls: { readonly reads: number; readonly writes: number; readonly createManyCalls: number };
  readonly tiers: readonly TierEstimate[];
}
