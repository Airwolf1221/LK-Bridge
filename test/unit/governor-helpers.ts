import { defaultGovernorSettings, type GovernorSettings } from '../../src/config/lk.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import { Governor } from '../../src/lk/governor/governor.js';
import type { CostSpec, ExecuteRequest, PriorityClass } from '../../src/lk/governor/types.js';
import type { TierId } from '../../src/lk/registry-types.js';

export const READ: CostSpec = { tiers: ['key-min', 'key-hour', 'key-day', 'project-hour'] };
export const WRITE: CostSpec = {
  tiers: ['write-min', 'write-hour', 'key-min', 'key-hour', 'key-day', 'project-hour'],
};

export interface SeenRequest {
  readonly atMs: number;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly signal: AbortSignal | undefined;
}

export type Responder = (req: SeenRequest, index: number) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test', ...headers },
  });
}

export function lkError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
  extra = {},
): Response {
  return json(status, { message: `mock ${code}`, code, requestId: 'req-test', ...extra }, headers);
}

export function rate(limit: number, remaining: number, resetAtMs: number): Record<string, string> {
  return {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.ceil(resetAtMs / 1000)),
  };
}

/** A governor on a fake clock with a scripted transport. Default reply: 200 `{ ok: true }`, no rate headers. */
export function setup(overrides: Partial<GovernorSettings> = {}, responder?: Responder) {
  const clock = new FakeClock();
  const seen: SeenRequest[] = [];
  let reply: Responder = responder ?? (() => json(200, { ok: true }));
  const governor = new Governor({
    settings: defaultGovernorSettings(overrides),
    clock,
    random: () => 0.5,
    transport: (input, init) => {
      const req: SeenRequest = {
        atMs: clock.now(),
        method: init?.method ?? 'GET',
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
        signal: init?.signal ?? undefined,
      };
      seen.push(req);
      return Promise.resolve(reply(req, seen.length - 1));
    },
  });

  function call(
    o: {
      priority?: PriorityClass;
      jobId?: string;
      costs?: CostSpec;
      method?: string;
      idempotencyKey?: string;
      opId?: string;
      signal?: AbortSignal;
      headers?: Record<string, string>;
      verify?: ExecuteRequest<Response>['verify'];
    } = {},
  ): Promise<Response> {
    const method = o.method ?? (o.costs && o.costs.tiers.includes('write-min') ? 'POST' : 'GET');
    const costs = o.costs ?? (method === 'GET' ? READ : WRITE);
    return governor.execute<Response>({
      opId: o.opId ?? 'test.op',
      kind: costs.tiers.includes('write-min') ? 'write' : 'read',
      costs,
      priority: o.priority ?? 'P1',
      ...(o.jobId !== undefined ? { jobId: o.jobId } : {}),
      ...(o.idempotencyKey !== undefined ? { idempotencyKey: o.idempotencyKey } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.verify ? { verify: o.verify } : {}),
      run: (signal) =>
        governor.fetch('http://lk.test/api/v3/x', { method, signal, headers: o.headers ?? {} }),
    });
  }

  return {
    clock,
    governor,
    seen,
    call,
    setResponder(r: Responder) {
      reply = r;
    },
    used: (tier: TierId) => governor.snapshot().tiers[tier].used,
  };
}

/** Collects settle order without unhandled rejections. */
export function track<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (v) => Object.assign(state, { done: true, value: v }),
    (e: unknown) => Object.assign(state, { done: true, error: e }),
  );
  return state;
}
