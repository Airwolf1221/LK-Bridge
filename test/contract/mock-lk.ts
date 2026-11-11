/**
 * A small mock of LegendKeeper v3 (Fastify) for contract tests. It is deliberately independent of the governor's
 * own window code, and strict: every tier is an exact sliding window on the shared fake clock, so "LK never had to
 * refuse a request" really means no tier was ever exceeded.
 *
 * Behaviour, per PLAN §1.2:
 * - rate headers on every counted response, for the tier with the fewest requests remaining;
 * - 429 RATE_LIMITED with Retry-After when a tier is full;
 * - 401 without rate headers when the key is wrong (refused before counting);
 * - Idempotency-Key store with `Idempotent-Replay: true` replays;
 * - scripted faults: any status/code, 409 IN_PROGRESS, dropped connections (before or after the write commits),
 *   hung requests, and injected 429s that keep refusing their tier until Retry-After.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Clock } from '../../src/lk/governor/clock.js';
import type { TierId } from '../../src/lk/registry-types.js';

export type CountedTier = Exclude<TierId, 'upload'>;
const ORDER: readonly CountedTier[] = [
  'write-min',
  'write-hour',
  'key-min',
  'key-hour',
  'key-day',
  'project-hour',
  'items-min',
  'items-hour',
];
const WINDOWS: Record<CountedTier, number> = {
  'write-min': 60_000,
  'write-hour': 3_600_000,
  'key-min': 60_000,
  'key-hour': 3_600_000,
  'key-day': 86_400_000,
  'project-hour': 3_600_000,
  'items-min': 60_000,
  'items-hour': 3_600_000,
};
export const PUBLISHED_LIMITS: Record<CountedTier, number> = {
  'write-min': 120,
  'write-hour': 3000,
  'key-min': 300,
  'key-hour': 6000,
  'key-day': 60000,
  'project-hour': 12000,
  'items-min': 600,
  'items-hour': 6000,
};

class Window {
  private readonly events: { t: number; n: number }[] = [];
  constructor(readonly ms: number) {}
  count(now: number): number {
    let c = 0;
    for (const e of this.events) if (e.t > now - this.ms) c += e.n;
    return c;
  }
  add(t: number, n: number) {
    this.events.push({ t, n });
  }
  /** When enough units leave for `need` more to fit under `limit`. */
  freesAt(now: number, need: number, limit: number): number {
    let excess = this.count(now) + need - limit;
    for (const e of this.events) {
      if (e.t <= now - this.ms) continue;
      excess -= e.n;
      if (excess <= 0) return e.t + this.ms;
    }
    return now + this.ms;
  }
  oldestExpiry(now: number): number {
    const e = this.events.find((x) => x.t > now - this.ms && x.n > 0);
    return e ? e.t + this.ms : now + this.ms;
  }
}

export type FaultAction =
  | { kind: 'status'; status: number; code?: string; counted?: boolean; retryAfterS?: number }
  | { kind: 'rate-limit'; tier: CountedTier; retryAfterS: number }
  | { kind: 'in-progress' }
  | { kind: 'drop' }
  | { kind: 'drop-after-commit' }
  | { kind: 'hang' };

export interface SeenCall {
  readonly n: number;
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | undefined;
  readonly ifMatch: string | undefined;
  outcome: string;
}

interface Fault {
  readonly match: (c: SeenCall) => boolean;
  remaining: number;
  readonly action: FaultAction;
}

/** A counted request, as handed to an optional state model (`MockLkOptions.respond`). */
export interface MockRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
  readonly headers: Record<string, string | undefined>;
}

export interface MockResponse {
  readonly status: number;
  readonly body?: unknown;
  /** Extra response headers (v2 D1.1: an `ETag`). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MockLkOptions {
  readonly clock: Clock;
  readonly apiKey: string;
  /**
   * v2 A1: the project the key belongs to. `GET /api/v3/projects` (listProjects, the bridge's start-up key check)
   * answers with exactly this project unless the state model answers it. Default `proj_mock`.
   */
  readonly projectId?: string;
  readonly projectName?: string;
  readonly limits?: Partial<Record<CountedTier, number>>;
  /**
   * Optional state model (chunk 2's job tests): answers each request that passed rate limiting, faults and
   * idempotency replay, instead of the generic body. Return undefined to fall back to the generic body.
   */
  readonly respond?: (req: MockRequest) => MockResponse | undefined;
}

export class MockLk {
  readonly app = Fastify({ logger: false });
  readonly limits: Record<CountedTier, number>;
  readonly windows: Record<CountedTier, Window>;
  readonly calls: SeenCall[] = [];
  /** Every request LK counted, with the tiers it drew (for an offline re-check). */
  readonly counted: { at: number; tiers: CountedTier[]; items: number }[] = [];
  readonly stats = {
    /** 429s the mock had to send because a tier was really full. Must stay 0 under the governor. */
    genuine429: 0,
    injected429: 0,
    /** Requests that arrived on a tier LK was refusing after an injected 429 (i.e. Retry-After ignored). */
    ignoredRetryAfter: 0,
    replays: 0,
  };
  private readonly faults: Fault[] = [];
  private readonly blockedUntil = new Map<CountedTier, number>();
  private readonly idem = new Map<string, { status: number; body: unknown } | 'running'>();
  private seq = 0;
  url = '';

  constructor(private readonly opts: MockLkOptions) {
    this.limits = { ...PUBLISHED_LIMITS, ...opts.limits };
    this.windows = Object.fromEntries(ORDER.map((t) => [t, new Window(WINDOWS[t])])) as Record<
      CountedTier,
      Window
    >;
    this.app.all('/api/v3/*', (req, reply) => this.handle(req, reply));
  }

  async start(): Promise<string> {
    this.url = await this.app.listen({ port: 0, host: '127.0.0.1' });
    return this.url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  /** Scripts the next `times` calls matching `match`. */
  inject(match: (c: SeenCall) => boolean, action: FaultAction, times = 1): void {
    this.faults.push({ match, remaining: times, action });
  }

  /** Another API key on the same project draws on the shared project tier. */
  consumeExternal(n: number): void {
    this.windows['project-hour'].add(this.opts.clock.now(), n);
  }

  private now() {
    return this.opts.clock.now();
  }

  private tiersFor(method: string, path: string, body: unknown): { tiers: CountedTier[]; items: number } {
    const write = method !== 'GET';
    const tiers: CountedTier[] = write
      ? ['write-min', 'write-hour', 'key-min', 'key-hour', 'key-day', 'project-hour']
      : ['key-min', 'key-hour', 'key-day', 'project-hour'];
    let items = 0;
    if (method === 'POST' && /\/resources\/batch\/?$/.test(path)) {
      const list = (body as { resources?: unknown[] } | undefined)?.resources;
      items = Array.isArray(list) ? list.length : 0;
      tiers.push('items-min', 'items-hour');
    }
    return { tiers, items };
  }

  private rateHeaders(tier: CountedTier, now: number, remaining?: number) {
    const left = remaining ?? Math.max(0, this.limits[tier] - this.windows[tier].count(now));
    return {
      'x-ratelimit-limit': String(this.limits[tier]),
      'x-ratelimit-remaining': String(left),
      'x-ratelimit-reset': String(Math.ceil(this.windows[tier].oldestExpiry(now) / 1000)),
    };
  }

  private tightest(tiers: CountedTier[], now: number): CountedTier {
    let best = tiers[0]!;
    let bestLeft = Number.POSITIVE_INFINITY;
    for (const t of ORDER) {
      if (!tiers.includes(t)) continue;
      const left = this.limits[t] - this.windows[t].count(now);
      if (left < bestLeft) {
        best = t;
        bestLeft = left;
      }
    }
    return best;
  }

  private send(reply: FastifyReply, status: number, body: unknown, headers: Record<string, string>) {
    const requestId = `mock-${++this.seq}`;
    void reply
      .code(status)
      .headers({ 'x-request-id': requestId, ...headers })
      .type('application/json')
      .send(status === 204 ? undefined : JSON.stringify(body));
  }

  private error(reply: FastifyReply, status: number, code: string, headers: Record<string, string> = {}) {
    this.send(reply, status, { message: `mock ${code}`, code, requestId: `mock-${this.seq + 1}` }, headers);
  }

  private handle(req: FastifyRequest, reply: FastifyReply): void {
    const now = this.now();
    const method = req.method.toUpperCase();
    const path = req.url.split('?')[0]!;
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const call: SeenCall = {
      n: this.calls.length,
      at: now,
      method,
      path,
      idempotencyKey: header('idempotency-key'),
      ifMatch: header('if-match'),
      outcome: 'ok',
    };
    this.calls.push(call);

    if (header('authorization') !== `Bearer ${this.opts.apiKey}`) {
      call.outcome = '401';
      this.error(reply, 401, 'UNAUTHENTICATED');
      return;
    }

    const { tiers, items } = this.tiersFor(method, path, req.body);

    for (const t of tiers) {
      const until = this.blockedUntil.get(t);
      if (until !== undefined && now < until) {
        this.stats.ignoredRetryAfter++;
        call.outcome = 'ignored-retry-after';
        this.error(reply, 429, 'RATE_LIMITED', {
          ...this.rateHeaders(t, now, 0),
          'retry-after': String(Math.ceil((until - now) / 1000)),
        });
        return;
      }
    }

    const fault = this.faults.find((f) => f.remaining > 0 && f.match(call));
    if (fault) fault.remaining--;
    const action = fault?.action;

    if (action?.kind === 'drop') {
      call.outcome = 'dropped';
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    if (action?.kind === 'hang') {
      call.outcome = 'hung';
      reply.hijack();
      return;
    }
    if (action?.kind === 'rate-limit') {
      this.stats.injected429++;
      call.outcome = 'injected-429';
      this.blockedUntil.set(action.tier, now + action.retryAfterS * 1000);
      this.error(reply, 429, 'RATE_LIMITED', {
        ...this.rateHeaders(action.tier, now, 0),
        'retry-after': String(action.retryAfterS),
      });
      return;
    }

    // Idempotency (POST only).
    const key = method === 'POST' ? call.idempotencyKey : undefined;
    if (key !== undefined) {
      const stored = this.idem.get(key);
      if (stored === 'running' || action?.kind === 'in-progress') {
        this.count(tiers, items, now);
        call.outcome = 'in-progress';
        this.error(reply, 409, 'IN_PROGRESS', this.rateHeaders(this.tightest(tiers, now), now));
        return;
      }
      if (stored) {
        this.count(tiers, items, now);
        this.stats.replays++;
        call.outcome = 'replay';
        this.send(reply, stored.status, stored.body, {
          ...this.rateHeaders(this.tightest(tiers, now), now),
          'idempotent-replay': 'true',
        });
        return;
      }
    }

    // Real rate limiting: refuse if any tier would be exceeded.
    for (const t of ORDER) {
      if (!tiers.includes(t)) continue;
      const need = t.startsWith('items') ? items : 1;
      if (this.windows[t].count(now) + need > this.limits[t]) {
        this.stats.genuine429++;
        call.outcome = `genuine-429:${t}`;
        const frees = this.windows[t].freesAt(now, need, this.limits[t]);
        this.error(reply, 429, 'RATE_LIMITED', {
          ...this.rateHeaders(t, now, 0),
          'retry-after': String(Math.max(1, Math.ceil((frees - now) / 1000))),
        });
        return;
      }
    }

    this.count(tiers, items, now);
    const headers = this.rateHeaders(this.tightest(tiers, now), now);

    if (action?.kind === 'status') {
      call.outcome = `status-${action.status}`;
      this.error(reply, action.status, action.code ?? 'INTERNAL', {
        ...headers,
        ...(action.retryAfterS !== undefined ? { 'retry-after': String(action.retryAfterS) } : {}),
      });
      return;
    }

    const modelled = this.opts.respond?.({
      method,
      path,
      query: Object.fromEntries(new URLSearchParams(req.url.split('?')[1] ?? '')),
      body: req.body,
      headers: Object.fromEntries(Object.keys(req.headers).map((h) => [h, header(h)])),
    });
    const status = modelled?.status ?? (method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200);
    const body =
      modelled !== undefined
        ? modelled.status >= 400 && modelled.body === undefined
          ? { message: 'mock error', code: 'INTERNAL' }
          : modelled.body
        : method === 'GET' && /^\/api\/v3\/projects\/?$/.test(path)
          ? {
              data: [
                { id: this.opts.projectId ?? 'proj_mock', name: this.opts.projectName ?? 'Mock project' },
              ],
              hasMore: false,
              nextCursor: null,
            }
          : method === 'GET' && /\/resources\/?$/.test(path)
            ? { data: [{ id: 'r1' }], hasMore: false, nextCursor: null }
            : { id: `id${call.n}`, name: 'mock', ok: true };
    if (modelled && modelled.status >= 400) call.outcome = `status-${modelled.status}`;
    // LK does not store 400/401/403/404 or 5xx responses for idempotency replay.
    const storable = status < 500 && ![400, 401, 403, 404].includes(status);
    if (key !== undefined && storable) this.idem.set(key, { status, body });
    if (action?.kind === 'drop-after-commit') {
      call.outcome = 'dropped-after-commit';
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    this.send(reply, status, body, { ...headers, ...(modelled?.headers ?? {}) });
  }

  private count(tiers: CountedTier[], items: number, now: number) {
    for (const t of tiers) this.windows[t].add(now, t.startsWith('items') ? items : 1);
    this.counted.push({ at: now, tiers, items });
  }

  /** Highest count each tier ever reached in any window, recomputed from the log. */
  maxInAnyWindow(): Record<CountedTier, number> {
    const out = Object.fromEntries(ORDER.map((t) => [t, 0])) as Record<CountedTier, number>;
    for (const t of ORDER) {
      const ev = this.counted.filter((c) => c.tiers.includes(t));
      let lo = 0;
      let sum = 0;
      for (let hi = 0; hi < ev.length; hi++) {
        sum += t.startsWith('items') ? ev[hi]!.items : 1;
        while (ev[lo]!.at <= ev[hi]!.at - WINDOWS[t]) {
          sum -= t.startsWith('items') ? ev[lo]!.items : 1;
          lo++;
        }
        out[t] = Math.max(out[t], sum);
      }
    }
    return out;
  }
}
