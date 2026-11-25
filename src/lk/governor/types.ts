import type { FloorRow } from '../../config/floors.js';
import type { PriorityClass } from '../../config/lk.js';
import type { BridgeLkError } from '../errors.js';
import type { OperationKind, TierId } from '../registry-types.js';
import type { BudgetTierId, GroupTierId } from './groups.js';

export type { PriorityClass } from '../../config/lk.js';
/** Highest first. v3 F9 (ADR 0074): P4, bulk, after P3. */
export const PRIORITY_CLASSES: readonly PriorityClass[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

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
  /** Per-attempt deadline for this call, instead of `requestTimeoutMs` (the signed upload PUT uses its own). */
  readonly timeoutMs?: number;
  /**
   * CR-2026-11-R3 (R3-62): waits in its queue for the budget however long it takes (behind every call of a higher
   * priority, as any queued call), instead of a `BudgetWaitError` once the wait passes `maxQueueWaitMs`. For the reads
   * of a job's check or read-back that holds no lock: parking there runs the whole step again, so a step needing more
   * reads than an hour's budget would never finish. A restart still ends the wait at once (`RestartWaitError`).
   * v3 F9 (ADR 0074): every P4 (bulk) call is patient, whether or not this is set.
   */
  readonly patient?: boolean;
  /**
   * v3 F9 review (ADR 0074 decision 3): first claim within its class. While this call heads its lane and is ready, it
   * goes before the class's other lanes (which take turns among themselves as before); the class's floor and the
   * classes above it are unchanged. The full snapshot's reads (P4) set it, so it goes before the other bulk passes.
   */
  readonly firstClaim?: boolean;
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

/**
 * v2 E5.5 (ADR 0047): a tier LegendKeeper reported that matches no documented one, learned for an operation's rate
 * group. It paces only the calls of that group and expires once its window has passed twice without being seen again.
 */
export interface OperationTierSnapshot {
  readonly id: GroupTierId;
  /** The rate group (`assets`, or an operation id for an operation of no listed group). */
  readonly group: string;
  /** The operations its header was seen on, in the order first seen. */
  readonly ops: readonly string[];
  readonly limit: number;
  /** Inferred from `X-RateLimit-Reset`: up to 60 s a minute, up to an hour an hour, otherwise a day. */
  readonly windowMs: number;
  /** The bridge's count in the window (snapped to LegendKeeper's at every sighting). */
  readonly used: number;
  readonly remaining: number;
  /** What LegendKeeper last said was left, and when it said the window resets. */
  readonly reportedRemaining: number;
  readonly resetAtMs: number;
  readonly firstSeenAtMs: number;
  readonly lastSeenAtMs: number;
  readonly expiresAtMs: number;
  /** Set while LegendKeeper refuses this group (429) until Retry-After. */
  readonly blockedUntilMs: number | null;
  readonly inFlight: number;
}

/**
 * v3 F9 amendment 1 (ADR 0074): what holds a class's queued work. `tier`: a tier is at the class's floor; `refused`:
 * LegendKeeper refused the tier (429) until Retry-After; `pacing`: the gap between writes; `agents`: P3 and P4 give way
 * while agents' work (P1, P2) is queued; `in-flight`: every request slot is taken.
 */
export type WaitCause = 'tier' | 'refused' | 'pacing' | 'agents' | 'in-flight';

export interface ClassWait {
  readonly priority: PriorityClass;
  /** Requests of the class in the queue. */
  readonly queued: number;
  readonly cause: WaitCause;
  /** The tier that decides the wait (`tier`, `refused`), else null. */
  readonly tier: BudgetTierId | null;
  /** The row of floors that tier falls under (`tier`): minute and hour, or day. */
  readonly row: FloorRow | null;
  /** The share of the tier the class must leave untouched (its floor on that row), as a fraction (`tier`). */
  readonly floor: number | null;
  /** The tier's count and limit now (`tier`, `refused`). */
  readonly used: number | null;
  readonly limit: number | null;
  /** When the class's next request may go; null when it waits on other work (agents, a free slot). */
  readonly freesAtMs: number | null;
  /** In words, for the dashboard, `bridge_budget` and a job's status ("bulk waiting: the daily tier is at …"). */
  readonly text: string;
}

export interface BudgetSnapshot {
  readonly atMs: number;
  readonly tiers: Readonly<Record<TierId, TierSnapshot>>;
  /** v2 E5.5: learned operation tiers, live ones only (an empty list when LegendKeeper has reported none). */
  readonly operationTiers: readonly OperationTierSnapshot[];
  readonly queues: Readonly<Record<PriorityClass, number>>;
  /** v3 F9 amendment 1: each class with queued work, and what holds it (highest class first). */
  readonly waits?: readonly ClassWait[];
  readonly inFlight: number;
  readonly writeSpacingMs: number;
  readonly nextWriteAtMs: number | null;
}

export interface SampleEvent {
  readonly atMs: number;
  readonly opId: string;
  readonly status: number;
  /** Documented tier the headers were matched to, or null when they went to a learned operation tier. */
  readonly tier: TierId | null;
  /** v2 E5.5: the rate group whose learned tier the headers went to (a limit no documented tier has). */
  readonly group?: string;
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
  readonly tiers: readonly BudgetTierId[];
  readonly retryAtMs: number;
}

export interface BudgetWaitEvent {
  readonly atMs: number;
  readonly opId: string;
  readonly priority: PriorityClass;
  readonly jobId: string | undefined;
  readonly tier: BudgetTierId;
  readonly retryAtMs: number;
}

/** v3 F9 amendment 1: a class's wait changed cause or tier (`wait` null: nothing of the class waits any more). */
export interface ClassWaitEvent {
  readonly atMs: number;
  readonly priority: PriorityClass;
  readonly wait: ClassWait | null;
}

export interface GovernorEvents {
  sample: SampleEvent;
  throttled: ThrottledEvent;
  'budget-wait': BudgetWaitEvent;
  'class-wait': ClassWaitEvent;
}

export interface EstimateInput {
  readonly reads?: number;
  readonly writes?: number;
  /** Items created through `createManyResources`; adds `ceil(items / 100)` write calls on top of `writes`. */
  readonly createManyItems?: number;
  /** Class the work would run at (default P2, jobs). Its reserve floor shrinks the usable budget. */
  readonly priority?: PriorityClass;
  /**
   * v2 E5.5: the operations among the reads and writes, by operation id, as far as the caller knows them. Learned
   * operation tiers pace the ones in their group (a rehearsal's asset folder and image uploads, say); the rest follow
   * the documented tiers only.
   */
  readonly ops?: Readonly<Record<string, number>>;
}

export interface TierEstimate {
  /** The documented tier, or a learned operation tier's id (`group:<name>`). */
  readonly tier: BudgetTierId;
  /** v2 E5.5: the effective limit used (`limitOf`: the configured one, or a lower one LegendKeeper reported). */
  readonly limit: number;
  readonly windowMs: number;
  readonly demand: number;
  /** Units the class may still use right now. */
  readonly available: number;
  /** Units the class may use per full window. */
  readonly capacityPerWindow: number;
  readonly timeMs: number;
}

/** v2 E5.5: a learned operation tier's share of an estimate. */
export interface OperationTierEstimate extends TierEstimate {
  readonly id: GroupTierId;
  readonly group: string;
}

/**
 * v2 E5.5 (backlog 16): what one write is taken to cost in time. The measured figure is the median wall time of the
 * project's recent write steps (from `steps`), floored at the configured spacing; without one, the spacing.
 */
export interface PerWriteFigure {
  readonly ms: number;
  readonly source: 'measured' | 'spacing';
  readonly spacingMs: number;
  readonly measured: MeasuredWriteDuration | null;
}

export interface MeasuredWriteDuration {
  /** Median wall time of the write steps sampled, in ms. */
  readonly ms: number;
  /** How many write steps it is the median of. */
  readonly samples: number;
}

export interface Estimate {
  /** Projected wall-clock time for the workload at the class's budget and write pacing. */
  readonly wallClockMs: number;
  /** The tier that bounds the time (or, if nothing waits, the one left with least headroom). `pacing` when
   * write spacing dominates. */
  readonly tightestTier: BudgetTierId | 'pacing';
  readonly fitsToday: boolean;
  readonly dayRemaining: number;
  readonly dayNeeded: number;
  readonly pacingMs: number;
  readonly calls: { readonly reads: number; readonly writes: number; readonly createManyCalls: number };
  readonly tiers: readonly TierEstimate[];
  /** v2 E5.5: each live learned operation tier the planned operations draw on (`ops`), at its learned limit. */
  readonly operationTiers: readonly OperationTierEstimate[];
  /** v2 E5.5: the time per write the pacing assumes, and where it came from. */
  readonly perWrite: PerWriteFigure;
}
