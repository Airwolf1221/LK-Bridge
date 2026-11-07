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
  type TierSnapshot,
  type VerifyResult,
} from './types.js';
import { SlidingWindow, type WindowEvent } from './window.js';

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
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{1,255}$/;
const WRITE_TIERS: ReadonlySet<TierId> = new Set(['write-min', 'write-hour']);
const ITEM_TIERS: ReadonlySet<TierId> = new Set(['items-min', 'items-hour']);
const STRETCH_RELEASE = 0.8;

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

interface Consumption {
  readonly tier: TierState;
  readonly n: number;
  readonly event: WindowEvent | null;
}

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
}

type Listener<E extends keyof GovernorEvents> = (event: GovernorEvents[E]) => void;

function reserveUnits(limit: number, floor: number): number {
  // Round away float noise first (0.1 * 120 = 12.000000000000002).
  return Math.ceil(Math.round(limit * floor * 1e6) / 1e6);
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
  readonly settings: GovernorSettings;
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

  constructor(options: GovernorOptions) {
    this.settings = options.settings;
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
  }

  // ---------------------------------------------------------------------------------------------- public API

  /**
   * Runs one LK call under the budget. Resolves with `run`'s value; rejects with `BridgeLkError` (or its subclass
   * `BudgetWaitError` when the call must wait longer than `maxQueueWaitMs` / a 429's Retry-After exceeds
   * `maxShortWaitMs`).
   */
  async execute<T>(req: ExecuteRequest<T>): Promise<T> {
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
      queues,
      inFlight: this.inFlight,
      writeSpacingMs: spacing,
      nextWriteAtMs: this.lastWriteAt === null ? null : Math.max(now, this.lastWriteAt + spacing),
    };
  }

  estimate(input: EstimateInput): Estimate {
    return estimateFrom(this.snapshot(), this.settings, input);
  }

  on<E extends keyof GovernorEvents>(event: E, cb: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Rejects everything queued and stops the wake timer. In-flight calls finish. */
  close(): void {
    this.closed = true;
    if (this.wakeTimer) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
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
  private readyAt(req: ExecuteRequest<unknown>, now: number): { at: number; tier: TierId | 'pacing' | null } {
    let at = now;
    let tier: TierId | 'pacing' | null = null;
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
      consumed.push({ tier: t, n, event });
    }
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
    }, this.settings.requestTimeoutMs);
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
    for (const { tier, n, event } of ticket.consumed) {
      tier.inFlight -= n;
      if (uncounted && event && tier.window) tier.window.refund(now, event);
    }
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

  /** Which drawn tier LK's headers describe. Limit first, then window consistency, then consumption order. */
  private matchTier(costs: CostSpec, rate: RateHeaders, now: number): TierId | null {
    const candidates = TIER_ORDER.filter((id) => draws(costs, id) && this.tiers[id].window !== null);
    const resetIn = rate.resetAtMs - now;
    const consistent = (id: TierId) => (this.tiers[id].windowMs ?? 0) + 1000 >= resetIn;
    const byLimit = candidates.filter((id) => {
      const t = this.tiers[id];
      return t.configuredLimit === rate.limit || this.limitOf(t) === rate.limit;
    });
    const pick = byLimit.find(consistent) ?? byLimit[0];
    if (pick) return pick;
    // LK changed a limit: match by window instead, shortest window that can hold the reset.
    const byWindow = candidates
      .filter((id) => !ITEM_TIERS.has(id) && consistent(id))
      .sort((a, b) => (this.tiers[a].windowMs ?? 0) - (this.tiers[b].windowMs ?? 0));
    return byWindow[0] ?? null;
  }

  private observe(ctx: AttemptContext, captured: CapturedResponse): void {
    const now = this.clock.now();
    const rate = captured.rate;
    if (rate) {
      const id = this.matchTier(ctx.req.costs, rate, now);
      let modelledUsed: number | null = null;
      if (id) {
        const t = this.tiers[id];
        if (rate.limit !== t.configuredLimit) t.observedLimit = rate.limit;
        modelledUsed = this.snap(t, rate, ctx, now);
      }
      this.emit('sample', {
        atMs: now,
        opId: ctx.req.opId,
        status: captured.status,
        tier: id,
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

  /** Snaps a tier's local count to the server's. Returns the modelled count it replaced. */
  private snap(t: TierState, rate: RateHeaders, ctx: AttemptContext, now: number): number | null {
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

  /** The tiers a 429 applies to: upload for UPLOAD_RATE_EXCEEDED, else the header-matched tier, else all drawn. */
  private throttledTiers(ctx: AttemptContext, code: string | undefined): TierId[] {
    if (code === 'UPLOAD_RATE_EXCEEDED') return ['upload'];
    const rate = ctx.captured?.rate;
    const matched = rate ? this.matchTier(ctx.req.costs, rate, this.clock.now()) : null;
    if (matched) return [matched];
    return TIER_ORDER.filter((id) => draws(ctx.req.costs, id) && id !== 'upload');
  }

  private throttledTier(ctx: AttemptContext, code: string | undefined): TierId {
    return this.throttledTiers(ctx, code)[0] ?? 'key-min';
  }

  private markThrottled(ctx: AttemptContext, code: string | undefined, until: number): void {
    const tiers = this.throttledTiers(ctx, code);
    let changed = false;
    for (const id of tiers) {
      const t = this.tiers[id];
      if (until > t.blockedUntil) {
        t.blockedUntil = until;
        changed = true;
      }
    }
    if (changed) {
      this.emit('throttled', { atMs: this.clock.now(), opId: ctx.req.opId, code, tiers, retryAtMs: until });
    }
  }

  // ---------------------------------------------------------------------------------------------- helpers

  private budgetWait(req: ExecuteRequest<unknown>, tier: TierId, retryAtMs: number, cause?: BridgeLkError) {
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
