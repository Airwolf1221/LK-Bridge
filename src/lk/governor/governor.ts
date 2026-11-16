/**
 * The Rate Governor (PLAN §5). The only code allowed to send requests to LegendKeeper.
 *
 * Each `execute` call is queued by priority class, admitted when every tier it draws on has room above the class's
 * reserve floor (and, for writes, the pacing gap has passed), then run with exactly one LK request through
 * `governor.fetch`. That fetch captures the rate headers on every response, snaps the local model to them and marks
 * tiers exhausted on 429. Failures go through the retry matrix (`retry.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GovernorSettings, PriorityClass } from '../../config/lk.js';
import {
  BridgeLkError,
  BudgetWaitError,
  fromLkResponse,
  toBridgeLkError,
  type LkErrorBody,
  type WireFacts,
} from '../errors.js';
import { getOperation } from '../registry.js';
import { TIER_IDS, type TierId } from '../registry-types.js';
import { sleep, systemClock, type Clock, type TimerHandle } from './clock.js';
import { estimateFrom } from './estimate.js';
import {
  drawsLearnedTier,
  EXPIRY_WINDOWS,
  groupTierId,
  isListedGroupOp,
  rateGroupOf,
  windowFromReset,
  type BudgetTierId,
  type GroupTierId,
} from './groups.js';
import { captureResponse, UNCOUNTED_STATUSES, type CapturedResponse, type RateHeaders } from './headers.js';
import { decideRetry, INITIAL_RETRY_STATE, type RetryState, type WireMethod } from './retry.js';
import {
  PRIORITY_CLASSES,
  TIER_ORDER,
  type BudgetSnapshot,
  type CostSpec,
  type Estimate,
  type EstimateInput,
  type ExecuteRequest,
  type GovernorEvents,
  type MeasuredWriteDuration,
  type OperationTierSnapshot,
  type TierSnapshot,
  type VerifyResult,
} from './types.js';
import { SlidingWindow, type WindowEvent } from './window.js';
import {
  COUNTERS_FORMAT,
  DEFAULT_PERSIST_INTERVAL_MS,
  restoreCounters,
  toBuckets,
  type GovernorPersistence,
  type PersistedCounters,
} from './persist.js';

export type Transport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The network transport under the governor when none is given: the platform `fetch`. */
export const defaultTransport: Transport = (input, init) => fetch(input, init);

export interface GovernorOptions {
  readonly settings: GovernorSettings;
  readonly clock?: Clock;
  /** The real network. Defaults to the platform `fetch`; tests inject a mock. */
  readonly transport?: Transport;
  /** Jitter source for backoff (tests pass a constant). */
  readonly random?: () => number;
  /**
   * v1.0.1 (F-14): keep the tiers' recent counts across restarts. Restored here, saved at most every `intervalMs` while
   * they change and on `close()` (`persist.ts`). Optional: without it the governor starts empty, as before.
   */
  readonly persistence?: GovernorPersistence;
  /**
   * v2 E5 hotfix (ADR 0046): when set, the only registry operations this governor will send. Any other `opId` is
   * refused with `OPERATION_NOT_ALLOWED` before it is queued, counted or sent. Only the read-only runtime of the
   * Markdown round trip sets it (test/sandbox/soak.ts, `createReadOnlyRuntime`); the bridge never does.
   */
  readonly allowedOperations?: ReadonlySet<string>;
  /**
   * v2 E5.5: where the info line goes the first time (per process) LegendKeeper reports a limit for an operation group
   * that the bridge did not know. The project registry binds the project's name.
   */
  readonly log?: { info(obj: Record<string, unknown>, msg: string): void };
  /**
   * v2 E5.5 (backlog 16): the project's measured per-write duration (the median wall time of its recent write steps),
   * which `estimate` uses with a floor of the configured spacing. Null when there is nothing to measure yet.
   */
  readonly writeDuration?: () => MeasuredWriteDuration | null;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{1,255}$/;
const WRITE_TIERS: ReadonlySet<TierId> = new Set(['write-min', 'write-hour']);
const ITEM_TIERS: ReadonlySet<TierId> = new Set(['items-min', 'items-hour']);
const STRETCH_RELEASE = 0.8;
/**
 * v2 E5.5: how close LegendKeeper's count must be to the bridge's own for a new limit to be taken as a documented tier's
 * (at least this many units, or this share of the limit LegendKeeper reported).
 */
const NEAR_UNITS = 2;
const NEAR_SHARE = 0.05;

interface TierState {
  readonly id: TierId;
  readonly configuredLimit: number | null;
  observedLimit: number | null;
  readonly windowMs: number | null;
  readonly window: SlidingWindow | null;
  blockedUntil: number;
  inFlight: number;
  serverResetAt: number | null;
  drift: TierSnapshot['drift'];
}

/** v2 E5.5: a tier learned for an operation group (ADR 0047). Keyed by group and limit. */
interface OpTierState {
  readonly id: GroupTierId;
  readonly group: string;
  readonly limit: number;
  readonly ops: Set<string>;
  windowMs: number;
  window: SlidingWindow;
  reportedRemaining: number;
  serverResetAt: number | null;
  readonly firstSeenAt: number;
  lastSeenAt: number;
  blockedUntil: number;
  inFlight: number;
  drift: TierSnapshot['drift'];
}

/** What `snap` needs of a tier, documented or learned. */
interface Snappable {
  readonly window: SlidingWindow | null;
  readonly windowMs: number | null;
  inFlight: number;
  serverResetAt: number | null;
  drift: TierSnapshot['drift'];
}

interface Consumption {
  readonly tier: TierState | OpTierState;
  readonly n: number;
  readonly event: WindowEvent | null;
  /** The window the event went into (a learned tier's window is replaced when its inferred window grows). */
  readonly window: SlidingWindow | null;
}

/** Where LegendKeeper's headers on a response were attributed (`observe`), kept for a 429's block. */
type Attribution =
  { readonly kind: 'tier'; readonly id: TierId } | { readonly kind: 'group'; readonly tier: OpTierState };

interface Ticket {
  readonly consumed: Consumption[];
  released: boolean;
}

interface Pending {
  readonly req: ExecuteRequest<unknown>;
  readonly lane: string;
  readonly resolve: (t: Ticket) => void;
  readonly reject: (e: unknown) => void;
  cleanup: () => void;
}

interface AttemptContext {
  readonly governor: Governor;
  readonly req: ExecuteRequest<unknown>;
  readonly ticket: Ticket;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  fetchCount: number;
  method: WireMethod | undefined;
  idempotencyKeySent: string | undefined;
  captured: CapturedResponse | undefined;
  errorBody: LkErrorBody | undefined;
  transportError: unknown;
  timedOut: boolean;
  callerAborted: boolean;
  /** v2 E5.5: where this response's rate headers went (set by `observe`). */
  attribution: Attribution | null;
}

type Listener<E extends keyof GovernorEvents> = (event: GovernorEvents[E]) => void;

function reserveUnits(limit: number, floor: number): number {
  // Round away float noise first (0.1 * 120 = 12.000000000000002).
  return Math.ceil(Math.round(limit * floor * 1e6) / 1e6);
}

/** v2 E5.5: what a class may use of a learned tier per window: its share above the floor, and at least one call. */
function learnedCap(limit: number, floor: number): number {
  return Math.max(1, limit - reserveUnits(limit, floor));
}

function opKey(group: string, limit: number): string {
  return `${group}\u0000${limit}`;
}

function windowName(ms: number): string {
  return ms <= 60_000 ? 'minute' : ms <= 3_600_000 ? 'hour' : 'day';
}

function weightFor(tier: TierId, costs: CostSpec): number {
  return ITEM_TIERS.has(tier) ? (costs.items ?? 1) : 1;
}

function draws(costs: CostSpec, tier: TierId): boolean {
  return costs.tiers.includes(tier);
}

function isWrite(costs: CostSpec): boolean {
  return costs.tiers.some((t) => WRITE_TIERS.has(t));
}

async function readErrorBody(response: Response): Promise<LkErrorBody | undefined> {
  try {
    const text = await response.clone().text();
    if (!text) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
      return { message: text.slice(0, 500) };
    }
  } catch {
    return undefined;
  }
}

export class Governor {
  private current: GovernorSettings;
  private readonly clock: Clock;
  private readonly transport: Transport;
  private readonly random: () => number;
  private readonly als = new AsyncLocalStorage<AttemptContext>();
  private readonly tiers: Record<TierId, TierState>;
  private readonly lanes: Record<PriorityClass, Map<string, Pending[]>> = {
    P0: new Map(),
    P1: new Map(),
    P2: new Map(),
    P3: new Map(),
  };
  private readonly listeners = new Map<keyof GovernorEvents, Set<(e: never) => void>>();
  private inFlight = 0;
  private lastWriteAt: number | null = null;
  private stretched = false;
  private wakeTimer: TimerHandle | null = null;
  private wakeAt = Number.POSITIVE_INFINITY;
  private pumping = false;
  private repump = false;
  private closed = false;
  private readonly persistence: GovernorPersistence | undefined;
  private saveTimer: TimerHandle | null = null;
  private readonly allowedOperations: ReadonlySet<string> | undefined;
  /** v2 E5.5: learned operation tiers, by `group \0 limit`. In memory only: a restart learns them again. */
  private readonly opTiers = new Map<string, OpTierState>();
  /** v2 E5.5: `group \0 limit` pairs already logged by this process (a sighting is logged once). */
  private readonly logged = new Set<string>();
  private readonly log: GovernorOptions['log'];
  private readonly writeDuration: GovernorOptions['writeDuration'];

  constructor(options: GovernorOptions) {
    this.current = options.settings;
    this.log = options.log;
    this.writeDuration = options.writeDuration;
    this.allowedOperations = options.allowedOperations ? new Set(options.allowedOperations) : undefined;
    this.clock = options.clock ?? systemClock;
    this.transport = options.transport ?? defaultTransport;
    this.random = options.random ?? Math.random;
    const s = this.settings;
    this.tiers = Object.fromEntries(
      TIER_IDS.map((id) => {
        const windowMs = s.tierWindowsMs[id];
        const limit = s.tierLimits[id];
        const state: TierState = {
          id,
          configuredLimit: limit,
          observedLimit: null,
          windowMs,
          window: windowMs !== null && limit !== null ? new SlidingWindow(windowMs) : null,
          blockedUntil: 0,
          inFlight: 0,
          serverResetAt: null,
          drift: null,
        };
        return [id, state];
      }),
    ) as Record<TierId, TierState>;
    this.persistence = options.persistence;
    this.restorePersisted();
  }

  /** The effective settings. Only the reserve floors can change while running (`setReserveFloors`). */
  get settings(): GovernorSettings {
    return this.current;
  }

  /**
   * Chunk 5 (dashboard, "Request Budgets" page): changes the reserve floors live. Floors are read at every admission
   * and by `estimate`, so the next call sees the new values. P0 is always 0; the rest are fractions 0-1 and must keep
   * the order P1 <= P2 <= P3 (as the configuration requires at start-up). Throws `RangeError` otherwise.
   */
  setReserveFloors(floors: Readonly<Record<'P1' | 'P2' | 'P3', number>>): void {
    const { P1, P2, P3 } = floors;
    for (const v of [P1, P2, P3]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new RangeError('Reserve floors must be fractions between 0 and 1');
      }
    }
    if (!(P1 <= P2 && P2 <= P3))
      throw new RangeError('Reserve floors must satisfy interactive <= job <= maintenance');
    this.current = { ...this.current, reserveFloors: { P0: 0, P1, P2, P3 } };
    this.pump(); // queued calls are re-evaluated against the new floors
  }

  // ---------------------------------------------------------------------------------------------- public API

  /**
   * Runs one LK call under the budget. Resolves with `run`'s value; rejects with `BridgeLkError` (or its subclass
   * `BudgetWaitError` when the call must wait longer than `maxQueueWaitMs` / a 429's Retry-After exceeds
   * `maxShortWaitMs`).
   */
  async execute<T>(req: ExecuteRequest<T>): Promise<T> {
    this.refuseOutsideAllowList(req);
    this.validate(req);
    let state: RetryState = INITIAL_RETRY_STATE;
    let attempts = 0;
    for (;;) {
      const ticket = await this.admit(req, attempts > 0);
      attempts++;
      const controller = new AbortController();
      const ctx: AttemptContext = {
        governor: this,
        req: req,
        ticket,
        controller,
        signal: controller.signal,
        fetchCount: 0,
        method: undefined,
        idempotencyKeySent: undefined,
        captured: undefined,
        errorBody: undefined,
        transportError: undefined,
        timedOut: false,
        callerAborted: false,
        attribution: null,
      };
      let error: BridgeLkError;
      try {
        const value = await this.runAttempt(req, ctx);
        this.release(ctx);
        return value;
      } catch (e) {
        this.release(ctx);
        error = toBridgeLkError(e, req.opId, this.wireFacts(ctx)).with({ attempts });
      }

      const now = this.clock.now();
      const waitHintMs =
        ctx.captured?.retryAfterMs ??
        (ctx.captured?.status === 429 && ctx.captured.rate
          ? Math.max(0, ctx.captured.rate.resetAtMs - now)
          : undefined);
      const decision = decideRetry({
        error,
        method: ctx.method,
        hasIdempotencyKey: (ctx.idempotencyKeySent ?? req.idempotencyKey) !== undefined,
        state,
        settings: this.settings.retry,
        nowMs: now,
        waitHintMs,
        random: this.random,
      });

      if (error.status === 429 && (decision.action === 'retry' || decision.action === 'budget-wait')) {
        const until = decision.action === 'retry' ? now + decision.delayMs : decision.retryAtMs;
        this.markThrottled(ctx, error.code, until);
      }

      switch (decision.action) {
        case 'retry':
          state = decision.state;
          try {
            await sleep(this.clock, decision.delayMs, req.signal);
          } catch (cause) {
            throw this.abortedError(req.opId, cause);
          }
          continue;
        case 'budget-wait': {
          const tier = this.throttledTier(ctx, error.code);
          throw this.budgetWait(req, tier, decision.retryAtMs, error);
        }
        case 'verify':
          return this.verify(req, ctx, error);
        case 'fail':
          throw decision.error;
      }
    }
  }

  /**
   * The custom `fetch` for the LK SDK (and for raw calls such as the signed upload PUT). It only works inside
   * `execute`'s `run`; any other use throws `GOVERNOR_BYPASS`.
   */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const ctx = this.als.getStore();
    // A released ticket means this is a straggler (e.g. a background task spawned by an earlier `run`).
    if (!ctx || ctx.governor !== this || ctx.ticket.released) {
      throw new BridgeLkError({
        message: 'LegendKeeper may only be called inside governor.execute()',
        code: 'GOVERNOR_BYPASS',
        retryable: false,
        classification: 'bridge',
      });
    }
    if (ctx.fetchCount > 0) {
      throw new BridgeLkError({
        message: `governor.execute() allows one LK request per call (${ctx.req.opId} tried a second)`,
        code: 'ONE_REQUEST_PER_CALL',
        retryable: false,
        classification: 'bridge',
        opId: ctx.req.opId,
      });
    }
    const method = (
      init.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase() as WireMethod;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (method === 'POST' && ctx.req.idempotencyKey && !headers.has('idempotency-key')) {
      headers.set('idempotency-key', ctx.req.idempotencyKey);
    }
    const op = getOperation(ctx.req.opId);
    if (op?.versioned && method !== 'GET' && !headers.has('if-match')) {
      throw new BridgeLkError({
        message: `${ctx.req.opId} writes a versioned entity and must send If-Match`,
        code: 'IF_MATCH_REQUIRED',
        retryable: false,
        classification: 'bridge',
        opId: ctx.req.opId,
      });
    }
    ctx.fetchCount++;
    ctx.method = method;
    ctx.idempotencyKeySent = headers.get('idempotency-key') ?? undefined;
    const signal = init.signal ? AbortSignal.any([init.signal, ctx.signal]) : ctx.signal;

    let response: Response;
    try {
      response = await this.transport(input, { ...init, method, headers, signal });
    } catch (e) {
      ctx.transportError = e;
      throw e;
    }
    const captured = captureResponse(response, this.clock.now());
    if (!response.ok) ctx.errorBody = await readErrorBody(response);
    ctx.captured = captured;
    this.observe(ctx, captured);
    return response;
  };

  /**
   * What the governor captured from the response of the request in flight in this call (`execute`'s `run`), or
   * undefined outside one or before the response: the `ETag` of a write (v2 D1.1, ADR 0039).
   */
  currentResponse(): CapturedResponse | undefined {
    const ctx = this.als.getStore();
    return ctx && ctx.governor === this ? ctx.captured : undefined;
  }

  snapshot(): BudgetSnapshot {
    const now = this.clock.now();
    const tiers = Object.fromEntries(
      TIER_IDS.map((id) => {
        const t = this.tiers[id];
        const limit = this.limitOf(t);
        const used = t.window?.used(now) ?? 0;
        const serverReset = t.serverResetAt !== null && t.serverResetAt > now ? t.serverResetAt : null;
        const snap: TierSnapshot = {
          tier: id,
          limit,
          configuredLimit: t.configuredLimit,
          used,
          remaining: limit === null ? null : Math.max(0, limit - used),
          windowMs: t.windowMs,
          resetAtMs: serverReset ?? t.window?.nextExpiry(now) ?? null,
          blockedUntilMs: t.blockedUntil > now ? t.blockedUntil : null,
          inFlight: t.inFlight,
          reactiveOnly: t.window === null,
          drift: t.drift,
        };
        return [id, snap];
      }),
    ) as Record<TierId, TierSnapshot>;
    const queues = Object.fromEntries(PRIORITY_CLASSES.map((c) => [c, this.queueDepth(c)])) as Record<
      PriorityClass,
      number
    >;
    const spacing = this.spacing(now);
    return {
      atMs: now,
      tiers,
      operationTiers: this.operationTierSnapshots(now),
      queues,
      inFlight: this.inFlight,
      writeSpacingMs: spacing,
      nextWriteAtMs: this.lastWriteAt === null ? null : Math.max(now, this.lastWriteAt + spacing),
    };
  }

  /**
   * PLAN §5.4 `bridge_estimate`. v2 E5.5: every tier at its effective limit (`limitOf`), the learned operation tiers for
   * the operations named in `input.ops`, and the measured per-write duration (floored at the spacing) when the bridge
   * has one for this project.
   */
  estimate(input: EstimateInput): Estimate {
    return estimateFrom(this.snapshot(), this.settings, input, this.measuredWriteDuration());
  }

  /** The measured per-write duration, or null: a measurement that cannot be read never breaks an estimate. */
  private measuredWriteDuration(): MeasuredWriteDuration | null {
    try {
      return this.writeDuration?.() ?? null;
    } catch {
      return null;
    }
  }

  on<E extends keyof GovernorEvents>(event: E, cb: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Rejects everything queued and stops the wake timer. In-flight calls finish. Saves the counters (if persisted). */
  close(): void {
    this.closed = true;
    if (this.wakeTimer) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.saveTimer) this.clock.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.savePersisted();
    for (const cls of PRIORITY_CLASSES) {
      for (const lane of this.lanes[cls].values()) {
        for (const p of lane) {
          p.cleanup();
          p.reject(this.abortedError(p.req.opId, new Error('governor closed')));
        }
      }
      this.lanes[cls].clear();
    }
  }

  // ---------------------------------------------------------------------------------------------- admission

  /** The allow-list (`GovernorOptions.allowedOperations`), checked before anything else: nothing is queued or sent. */
  private refuseOutsideAllowList(req: ExecuteRequest<unknown>): void {
    const allowed = this.allowedOperations;
    if (allowed === undefined || allowed.has(req.opId)) return;
    throw new BridgeLkError({
      message:
        `${req.opId} is not on this governor's allow-list (${[...allowed].join(', ')}); refused before any request. ` +
        'This runtime is read-only by construction.',
      code: 'OPERATION_NOT_ALLOWED',
      retryable: false,
      classification: 'bridge',
      opId: req.opId,
    });
  }

  private validate(req: ExecuteRequest<unknown>): void {
    const invalid = (message: string) =>
      new BridgeLkError({
        message,
        code: 'INVALID_REQUEST',
        retryable: false,
        classification: 'bridge',
        opId: req.opId,
      });
    if (!PRIORITY_CLASSES.includes(req.priority)) throw invalid(`Unknown priority ${String(req.priority)}`);
    for (const t of req.costs.tiers) if (!TIER_IDS.includes(t)) throw invalid(`Unknown tier ${t}`);
    if (req.kind === 'read' && isWrite(req.costs)) throw invalid('A read must not draw write tiers');
    if (req.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(req.idempotencyKey)) {
      throw invalid('Idempotency-Key must be 1-255 characters from A-Z a-z 0-9 . _ -');
    }
    const drawsItems = req.costs.tiers.some((t) => ITEM_TIERS.has(t));
    if (drawsItems && (!Number.isInteger(req.costs.items) || (req.costs.items ?? 0) < 1)) {
      throw invalid('costs.items must be a positive integer when items tiers are drawn');
    }
    const floor = this.settings.reserveFloors[req.priority];
    for (const id of req.costs.tiers) {
      const limit = this.limitOf(this.tiers[id]);
      if (limit === null || this.tiers[id].window === null) continue;
      if (weightFor(id, req.costs) > limit - reserveUnits(limit, floor)) {
        throw invalid(`Cost on ${id} exceeds what class ${req.priority} may ever use in one window`);
      }
    }
  }

  private admit(req: ExecuteRequest<unknown>, front: boolean): Promise<Ticket> {
    if (this.closed) return Promise.reject(this.abortedError(req.opId, new Error('governor closed')));
    if (req.signal?.aborted) return Promise.reject(this.abortedError(req.opId, req.signal.reason));
    return new Promise<Ticket>((resolve, reject) => {
      const laneKey = req.jobId ?? '';
      const pending: Pending = { req, lane: laneKey, resolve, reject, cleanup: () => {} };
      const lanes = this.lanes[req.priority];
      let lane = lanes.get(laneKey);
      if (!lane) lanes.set(laneKey, (lane = []));
      if (front) lane.unshift(pending);
      else lane.push(pending);
      if (req.signal) {
        const onAbort = () => {
          this.removePending(pending);
          reject(this.abortedError(req.opId, req.signal?.reason));
          this.pump();
        };
        req.signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => req.signal?.removeEventListener('abort', onAbort);
      }
      this.pump();
    });
  }

  private removePending(p: Pending): void {
    const lanes = this.lanes[p.req.priority];
    const lane = lanes.get(p.lane);
    if (!lane) return;
    const i = lane.indexOf(p);
    if (i >= 0) lane.splice(i, 1);
    if (lane.length === 0) lanes.delete(p.lane);
  }

  private queueDepth(cls: PriorityClass): number {
    let n = 0;
    for (const lane of this.lanes[cls].values()) n += lane.length;
    return n;
  }

  private limitOf(t: TierState): number | null {
    if (t.configuredLimit === null) return t.observedLimit;
    return t.observedLimit === null ? t.configuredLimit : Math.min(t.configuredLimit, t.observedLimit);
  }

  /** Current write spacing, with hysteresis on the stretch (PLAN §5.2). */
  private spacing(now: number): number {
    const wm = this.tiers['write-min'];
    if (wm.window && wm.windowMs) {
      const projectedHourly = (wm.window.used(now) * 3_600_000) / wm.windowMs;
      const threshold = this.settings.stretchHourlyWrites;
      if (projectedHourly > threshold) this.stretched = true;
      else if (projectedHourly <= threshold * STRETCH_RELEASE) this.stretched = false;
    }
    return this.stretched ? this.settings.writeSpacingStretchedMs : this.settings.writeSpacingMs;
  }

  /** Earliest time this call may be dispatched, and which constraint decides it. */
  private readyAt(
    req: ExecuteRequest<unknown>,
    now: number,
  ): { at: number; tier: BudgetTierId | 'pacing' | null } {
    let at = now;
    let tier: BudgetTierId | 'pacing' | null = null;
    const floor = this.settings.reserveFloors[req.priority];
    for (const id of TIER_ORDER) {
      if (!draws(req.costs, id)) continue;
      const t = this.tiers[id];
      if (t.blockedUntil > at) {
        at = t.blockedUntil;
        tier = id;
      }
      const limit = this.limitOf(t);
      if (!t.window || limit === null) continue;
      const cap = limit - reserveUnits(limit, floor);
      const r = t.window.readyAt(now, weightFor(id, req.costs), cap);
      if (r > at) {
        at = r;
        tier = id;
      }
    }
    // v2 E5.5: the learned tiers of the call's operation group pace it, and a 429 on one blocks it.
    for (const g of this.learnedTiersFor(req.opId, now)) {
      if (g.blockedUntil > at) {
        at = g.blockedUntil;
        tier = g.id;
      }
      const r = g.window.readyAt(now, 1, learnedCap(g.limit, floor));
      if (r > at) {
        at = r;
        tier = g.id;
      }
    }
    if (isWrite(req.costs) && this.lastWriteAt !== null) {
      const p = this.lastWriteAt + this.spacing(now);
      if (p > at) {
        at = p;
        tier = 'pacing';
      }
    }
    return { at, tier };
  }

  private pump(): void {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        this.pumpOnce();
      } while (this.repump);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    const now = this.clock.now();
    let earliest: number;
    for (;;) {
      let progressed = false;
      earliest = Number.POSITIVE_INFINITY;
      scan: for (const cls of PRIORITY_CLASSES) {
        if (cls === 'P3' && this.queueDepth('P1') + this.queueDepth('P2') > 0) continue;
        for (const [key, lane] of this.lanes[cls]) {
          if (this.inFlight >= this.settings.maxInFlight) break scan;
          const head = lane[0];
          if (!head) continue;
          const { at, tier } = this.readyAt(head.req, now);
          if (at <= now) {
            this.dispatch(cls, key, lane, head, now);
            progressed = true;
            break scan;
          }
          if (at - now > this.settings.maxQueueWaitMs && tier !== null && tier !== 'pacing') {
            lane.shift();
            if (lane.length === 0) this.lanes[cls].delete(key);
            head.cleanup();
            head.reject(this.budgetWait(head.req, tier, at));
            progressed = true;
            break scan;
          }
          earliest = Math.min(earliest, at);
        }
      }
      if (!progressed) break;
    }
    this.armWake(earliest, now);
  }

  private armWake(at: number, now: number): void {
    if (at === this.wakeAt && this.wakeTimer) return;
    if (this.wakeTimer) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = at;
    if (!Number.isFinite(at)) return;
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = Number.POSITIVE_INFINITY;
      this.pump();
    }, at - now);
  }

  private dispatch(cls: PriorityClass, key: string, lane: Pending[], p: Pending, now: number): void {
    lane.shift();
    // Round-robin: the lane just served goes to the back of its class.
    this.lanes[cls].delete(key);
    if (lane.length > 0) this.lanes[cls].set(key, lane);
    p.cleanup();
    const consumed: Consumption[] = [];
    for (const id of TIER_ORDER) {
      if (!draws(p.req.costs, id)) continue;
      const t = this.tiers[id];
      const n = weightFor(id, p.req.costs);
      const event = t.window ? t.window.add(now, n) : null;
      t.inFlight += n;
      consumed.push({ tier: t, n, event, window: t.window });
    }
    for (const g of this.learnedTiersFor(p.req.opId, now)) {
      const event = g.window.add(now, 1);
      g.inFlight += 1;
      consumed.push({ tier: g, n: 1, event, window: g.window });
    }
    this.countersChanged();
    if (isWrite(p.req.costs)) {
      this.lastWriteAt = now;
      this.spacing(now);
    }
    this.inFlight++;
    p.resolve({ consumed, released: false });
  }

  // ---------------------------------------------------------------------------------------------- running

  private async runAttempt<T>(req: ExecuteRequest<T>, ctx: AttemptContext): Promise<T> {
    const { controller } = ctx;
    let rejectAbort: (e: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => (rejectAbort = reject));
    aborted.catch(() => {});
    const onCallerAbort = () => {
      ctx.callerAborted = true;
      controller.abort(req.signal?.reason);
      rejectAbort(req.signal?.reason);
    };
    req.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = this.clock.setTimeout(() => {
      ctx.timedOut = true;
      const reason = new DOMException('LegendKeeper request timed out', 'TimeoutError');
      controller.abort(reason);
      rejectAbort(reason);
    }, req.timeoutMs ?? this.settings.requestTimeoutMs);
    try {
      const result = await Promise.race([this.als.run(ctx, () => req.run(controller.signal)), aborted]);
      if (result instanceof Response) {
        if (!result.ok) {
          throw fromLkResponse({
            status: result.status,
            body: ctx.errorBody,
            requestId: ctx.captured?.requestId,
            retryAfterMs: ctx.captured?.retryAfterMs,
            opId: req.opId,
          });
        }
        return result as T;
      }
      return result;
    } finally {
      this.clock.clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private release(ctx: AttemptContext): void {
    const ticket = ctx.ticket;
    if (ticket.released) return;
    ticket.released = true;
    this.inFlight--;
    const now = this.clock.now();
    const c = ctx.captured;
    const uncounted =
      ctx.fetchCount === 0 || (c !== undefined && c.rate === null && UNCOUNTED_STATUSES.has(c.status));
    for (const { tier, n, event, window } of ticket.consumed) {
      tier.inFlight -= n;
      if (uncounted && event && window) window.refund(now, event);
    }
    if (uncounted) this.countersChanged();
    this.pump();
  }

  private wireFacts(ctx: AttemptContext): WireFacts {
    return {
      status: ctx.captured?.status,
      body: ctx.errorBody,
      requestId: ctx.captured?.requestId,
      retryAfterMs: ctx.captured?.retryAfterMs,
      timedOut: ctx.timedOut,
      aborted: ctx.callerAborted,
      transportError: ctx.transportError,
    };
  }

  private async verify<T>(req: ExecuteRequest<T>, ctx: AttemptContext, error: BridgeLkError): Promise<T> {
    if (req.verify) {
      let result: VerifyResult<T>;
      try {
        result = await req.verify({ error, signal: req.signal ?? new AbortController().signal });
      } catch (e) {
        throw toBridgeLkError(e, req.opId);
      }
      if (result.ok) return result.value;
      throw error;
    }
    if (ctx.method === 'DELETE' && (error.code === 'NOT_FOUND' || error.code === 'ALREADY_DELETED')) {
      // PLAN §5.3: a retried DELETE that finds the entity gone has done its job.
      return undefined as T;
    }
    throw error;
  }

  // ---------------------------------------------------------------------------------------------- server correction

  /**
   * Which tier LK's headers describe (v2 E5.5, ADR 0047). A documented tier the call draws is matched by its limit, as
   * before. Otherwise the limit is new: it goes to a learned tier of the operation's rate group, unless the operation
   * is of no listed group and the header is consistent with a documented tier (its window by the reset, and its count
   * near the bridge's own), which is then a genuine change of LegendKeeper's documented limit. Never mutates.
   */
  private attribute(ctx: AttemptContext, rate: RateHeaders, now: number): Attribution | { kind: 'learn' } {
    const costs = ctx.req.costs;
    const candidates = TIER_ORDER.filter((id) => draws(costs, id) && this.tiers[id].window !== null);
    const resetIn = rate.resetAtMs - now;
    const consistent = (id: TierId) => (this.tiers[id].windowMs ?? 0) + 1000 >= resetIn;
    const byLimit = candidates.filter((id) => {
      const t = this.tiers[id];
      return t.configuredLimit === rate.limit || this.limitOf(t) === rate.limit;
    });
    const pick = byLimit.find(consistent) ?? byLimit[0];
    if (pick) return { kind: 'tier', id: pick };
    const known = this.opTiers.get(opKey(rateGroupOf(ctx.req.opId), rate.limit));
    if (known && !this.expired(known, now)) return { kind: 'group', tier: known };
    // An operation of a listed group (the asset routes) never teaches a documented tier: its own tiers explain it.
    // Otherwise a documented tier LK changed: its window is the one the reset implies (as for a learned tier), and
    // LK's count is near the bridge's own on it. A wrong guess heals itself: the next header at the configured limit
    // clears it (`observe`).
    if (!isListedGroupOp(ctx.req.opId)) {
      const windowMs = windowFromReset(resetIn);
      const changed = candidates.find(
        (id) =>
          !ITEM_TIERS.has(id) &&
          this.tiers[id].windowMs === windowMs &&
          this.nearOwnCount(this.tiers[id], rate, ctx, now),
      );
      if (changed) return { kind: 'tier', id: changed };
    }
    return { kind: 'learn' };
  }

  /** Whether LK's count (limit − remaining) is near what the bridge counted on the tier, its other calls in flight aside. */
  private nearOwnCount(t: TierState, rate: RateHeaders, ctx: AttemptContext, now: number): boolean {
    if (!t.window) return false;
    const own = ctx.ticket.consumed.find((c) => c.tier === t)?.n ?? 0;
    const modelled = t.window.used(now) - Math.max(0, t.inFlight - own);
    const observed = rate.limit - rate.remaining;
    return Math.abs(observed - modelled) <= Math.max(NEAR_UNITS, Math.ceil(rate.limit * NEAR_SHARE));
  }

  private observe(ctx: AttemptContext, captured: CapturedResponse): void {
    const now = this.clock.now();
    const rate = captured.rate;
    if (rate) {
      const found = this.attribute(ctx, rate, now);
      let modelledUsed: number | null;
      let attribution: Attribution;
      if (found.kind === 'tier') {
        const t = this.tiers[found.id];
        // A limit back at its configured value clears an earlier observed one.
        t.observedLimit = rate.limit === t.configuredLimit ? null : rate.limit;
        modelledUsed = this.snap(t, rate, ctx, now);
        attribution = found;
      } else {
        const g = found.kind === 'group' ? found.tier : this.learn(ctx.req.opId, rate, now);
        this.sighted(g, ctx.req.opId, rate, now);
        modelledUsed = this.snap(g, rate, ctx, now);
        attribution = { kind: 'group', tier: g };
      }
      ctx.attribution = attribution;
      this.emit('sample', {
        atMs: now,
        opId: ctx.req.opId,
        status: captured.status,
        tier: attribution.kind === 'tier' ? attribution.id : null,
        ...(attribution.kind === 'group' ? { group: attribution.tier.group } : {}),
        limit: rate.limit,
        remaining: rate.remaining,
        resetAtMs: rate.resetAtMs,
        modelledUsed,
        observedUsed: rate.limit - rate.remaining,
      });
    }
    if (captured.status === 429 && captured.retryAfterMs !== undefined) {
      const code = typeof ctx.errorBody?.code === 'string' ? ctx.errorBody.code : undefined;
      this.markThrottled(ctx, code, now + captured.retryAfterMs);
    }
  }

  /** A new learned tier for the operation's group at this limit (logged once per process). */
  private learn(opId: string, rate: RateHeaders, now: number): OpTierState {
    const group = rateGroupOf(opId);
    const key = opKey(group, rate.limit);
    const windowMs = windowFromReset(rate.resetAtMs - now);
    const g: OpTierState = {
      id: groupTierId(group),
      group,
      limit: rate.limit,
      ops: new Set(),
      windowMs,
      window: new SlidingWindow(windowMs),
      reportedRemaining: rate.remaining,
      serverResetAt: rate.resetAtMs,
      firstSeenAt: now,
      lastSeenAt: now,
      blockedUntil: 0,
      inFlight: 0,
      drift: null,
    };
    this.opTiers.set(key, g);
    if (!this.logged.has(key)) {
      this.logged.add(key);
      try {
        this.log?.info(
          {
            op: opId,
            group,
            limit: rate.limit,
            remaining: rate.remaining,
            resetInSeconds: Math.max(0, Math.round((rate.resetAtMs - now) / 1000)),
            windowSeconds: windowMs / 1000,
          },
          `LegendKeeper reported a limit of ${rate.limit} per ${windowName(windowMs)} on ${opId}, which matches no documented tier; the bridge now paces the "${group}" group by it (and no other call)`,
        );
      } catch {
        // Logging never breaks the governor.
      }
    }
    return g;
  }

  /** Records a sighting of a learned tier: the op, the latest figures, and a longer window if the reset implies one. */
  private sighted(g: OpTierState, opId: string, rate: RateHeaders, now: number): void {
    g.ops.add(opId);
    g.lastSeenAt = now;
    g.reportedRemaining = rate.remaining;
    const windowMs = windowFromReset(rate.resetAtMs - now);
    if (windowMs > g.windowMs) {
      const grown = new SlidingWindow(windowMs);
      for (const e of g.window.liveEvents(now)) grown.add(now, e.n, e.t);
      g.window = grown;
      g.windowMs = windowMs;
    }
  }

  /** The live learned tiers a call of `opId` draws on (expired ones are dropped first). */
  private learnedTiersFor(opId: string, now: number): OpTierState[] {
    if (this.opTiers.size === 0) return [];
    this.expireLearned(now);
    const out: OpTierState[] = [];
    for (const g of this.opTiers.values()) if (drawsLearnedTier(opId, g.group, g.ops)) out.push(g);
    return out;
  }

  private expiresAt(g: OpTierState): number {
    return Math.max(g.lastSeenAt + EXPIRY_WINDOWS * g.windowMs, g.blockedUntil);
  }

  private expired(g: OpTierState, now: number): boolean {
    return g.inFlight === 0 && now >= this.expiresAt(g);
  }

  private expireLearned(now: number): void {
    for (const [key, g] of this.opTiers) if (this.expired(g, now)) this.opTiers.delete(key);
  }

  private operationTierSnapshots(now: number): OperationTierSnapshot[] {
    this.expireLearned(now);
    return [...this.opTiers.values()]
      .sort((a, b) => a.group.localeCompare(b.group) || a.limit - b.limit)
      .map((g) => {
        const used = g.window.used(now);
        return {
          id: g.id,
          group: g.group,
          ops: [...g.ops],
          limit: g.limit,
          windowMs: g.windowMs,
          used,
          remaining: Math.max(0, g.limit - used),
          reportedRemaining: g.reportedRemaining,
          resetAtMs:
            g.serverResetAt !== null && g.serverResetAt > now
              ? g.serverResetAt
              : (g.window.nextExpiry(now) ?? g.serverResetAt ?? now),
          firstSeenAtMs: g.firstSeenAt,
          lastSeenAtMs: g.lastSeenAt,
          expiresAtMs: this.expiresAt(g),
          blockedUntilMs: g.blockedUntil > now ? g.blockedUntil : null,
          inFlight: g.inFlight,
        };
      });
  }

  /** Snaps a tier's local count to the server's. Returns the modelled count it replaced. */
  private snap(t: Snappable, rate: RateHeaders, ctx: AttemptContext, now: number): number | null {
    if (!t.window || t.windowMs === null) return null;
    const own = ctx.ticket.consumed.find((c) => c.tier === t)?.n ?? 0;
    const othersInFlight = Math.max(0, t.inFlight - own);
    const modelled = t.window.used(now);
    const observed = rate.limit - rate.remaining;
    const target = observed + othersInFlight;
    if (target > modelled) {
      const at = Math.min(now, Math.max(rate.resetAtMs - t.windowMs, now - t.windowMs + 1));
      t.window.add(now, target - modelled, at);
    } else if (target < modelled) {
      t.window.removeOldest(now, modelled - target);
    }
    if (target !== modelled) this.countersChanged();
    t.serverResetAt = rate.resetAtMs;
    const modelledComparable = modelled - othersInFlight;
    t.drift = {
      atMs: now,
      observedUsed: observed,
      modelledUsed: modelledComparable,
      delta: observed - modelledComparable,
    };
    return modelledComparable;
  }

  /**
   * The tiers a 429 applies to: upload for UPLOAD_RATE_EXCEEDED; else where the headers were attributed (a documented
   * tier, or a learned operation tier, which blocks only its group); else every documented tier drawn.
   */
  private throttledTiers(ctx: AttemptContext, code: string | undefined): (TierState | OpTierState)[] {
    if (code === 'UPLOAD_RATE_EXCEEDED') return [this.tiers.upload];
    const a = ctx.attribution;
    if (a?.kind === 'tier') return [this.tiers[a.id]];
    if (a?.kind === 'group') return [a.tier];
    return TIER_ORDER.filter((id) => draws(ctx.req.costs, id) && id !== 'upload').map((id) => this.tiers[id]);
  }

  private throttledTier(ctx: AttemptContext, code: string | undefined): BudgetTierId {
    return this.throttledTiers(ctx, code)[0]?.id ?? 'key-min';
  }

  private markThrottled(ctx: AttemptContext, code: string | undefined, until: number): void {
    const tiers = this.throttledTiers(ctx, code);
    let changed = false;
    for (const t of tiers) {
      if (until > t.blockedUntil) {
        t.blockedUntil = until;
        changed = true;
      }
    }
    if (changed) {
      this.countersChanged();
      this.emit('throttled', {
        atMs: this.clock.now(),
        opId: ctx.req.opId,
        code,
        tiers: tiers.map((t) => t.id),
        retryAtMs: until,
      });
    }
  }

  // ---------------------------------------------------------------------------------------------- helpers

  private budgetWait(
    req: ExecuteRequest<unknown>,
    tier: BudgetTierId,
    retryAtMs: number,
    cause?: BridgeLkError,
  ) {
    const err = new BudgetWaitError({ tier, retryAtMs, opId: req.opId, ...(cause ? { cause } : {}) });
    this.emit('budget-wait', {
      atMs: this.clock.now(),
      opId: req.opId,
      priority: req.priority,
      jobId: req.jobId,
      tier,
      retryAtMs,
    });
    return err;
  }

  private abortedError(opId: string, cause: unknown): BridgeLkError {
    return new BridgeLkError({
      message: 'LegendKeeper call aborted',
      code: 'ABORTED',
      retryable: false,
      classification: 'bridge',
      opId,
      cause,
    });
  }

  // ---------------------------------------------------------------------------------------------- persistence (F-14)

  /** Seeds the windows and 429 blocks from the saved record. Anything wrong restores nothing; never throws. */
  private restorePersisted(): void {
    if (!this.persistence) return;
    let raw: unknown;
    try {
      raw = this.persistence.store.load();
    } catch (e) {
      this.persistence.warn?.('Could not read the saved governor counters; starting from empty counters', e);
      return;
    }
    if (raw === undefined || raw === null) return; // first start, or nothing saved yet
    const now = this.clock.now();
    let restored: ReturnType<typeof restoreCounters>;
    try {
      const shape = Object.fromEntries(
        TIER_IDS.map((id) => [
          id,
          { windowMs: this.tiers[id].windowMs, limit: this.tiers[id].configuredLimit },
        ]),
      ) as Parameters<typeof restoreCounters>[2];
      restored = restoreCounters(raw, now, shape);
    } catch (e) {
      this.persistence.warn?.('The saved governor counters are malformed; starting from empty counters', e);
      return;
    }
    for (const id of TIER_IDS) {
      const r = restored[id];
      if (!r) continue;
      const t = this.tiers[id];
      if (t.window) for (const e of r.events) t.window.add(now, e.n, e.t);
      if (r.blockedUntil > t.blockedUntil) t.blockedUntil = r.blockedUntil;
    }
  }

  /** Arms one save at most `intervalMs` from now, unless one is already armed. No timer while nothing changes. */
  private countersChanged(): void {
    if (!this.persistence || this.closed || this.saveTimer) return;
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null;
      this.savePersisted();
    }, this.persistence.intervalMs ?? DEFAULT_PERSIST_INTERVAL_MS);
  }

  private savePersisted(): void {
    if (!this.persistence) return;
    const now = this.clock.now();
    const tiers: PersistedCounters['tiers'] = {};
    for (const id of TIER_IDS) {
      const t = this.tiers[id];
      const buckets = t.window && t.windowMs !== null ? toBuckets(t.window.liveEvents(now), t.windowMs) : [];
      const blocked = t.blockedUntil > now ? t.blockedUntil : undefined;
      if (buckets.length > 0 || blocked !== undefined)
        (tiers as Record<string, unknown>)[id] = {
          buckets,
          ...(blocked !== undefined ? { blockedUntil: blocked } : {}),
        };
    }
    try {
      this.persistence.store.save({ v: COUNTERS_FORMAT, savedAt: now, tiers });
    } catch (e) {
      this.persistence.warn?.('Could not save the governor counters; the next change tries again', e);
    }
  }

  private emit<E extends keyof GovernorEvents>(event: E, payload: GovernorEvents[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as Listener<E>)(payload);
      } catch {
        // A listener must never break the governor.
      }
    }
  }
}

export function createGovernor(options: GovernorOptions): Governor {
  return new Governor(options);
}
