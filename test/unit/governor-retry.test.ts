/** Every row of the retry matrix (PLAN §5.3): first as the pure decision, then end to end through the governor. */
import { describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { BridgeLkError, BudgetWaitError, fromLkResponse } from '../../src/lk/errors.js';
import { backoffMs, decideRetry, INITIAL_RETRY_STATE, type RetryInput } from '../../src/lk/governor/retry.js';
import type { BudgetWaitEvent } from '../../src/lk/governor/types.js';
import { json, lkError, rate, READ, setup, track, WRITE } from './governor-helpers.js';

const settings = defaultGovernorSettings().retry;
const NOW = 1_000_000;

function lk(status: number, code?: string) {
  return fromLkResponse({ status, body: code ? { code, message: 'x' } : {} });
}
const connection = new BridgeLkError({
  message: 'down',
  code: 'CONNECTION_ERROR',
  retryable: true,
  classification: 'upstream',
});
const timeout = new BridgeLkError({
  message: 'slow',
  code: 'TIMEOUT',
  retryable: true,
  classification: 'upstream',
});

function decide(partial: Partial<RetryInput> & Pick<RetryInput, 'error'>) {
  return decideRetry({
    method: 'GET',
    hasIdempotencyKey: false,
    state: INITIAL_RETRY_STATE,
    settings,
    nowMs: NOW,
    waitHintMs: undefined,
    random: () => 0.5,
    ...partial,
  });
}

describe('retry matrix: decisions', () => {
  it('429 with Retry-After <= 30 s: wait and retry (same key)', () => {
    const d = decide({
      error: lk(429, 'RATE_LIMITED'),
      method: 'POST',
      hasIdempotencyKey: true,
      waitHintMs: 5000,
    });
    expect(d).toMatchObject({ action: 'retry', delayMs: 5000, reason: 'rate-limited' });
    expect(decide({ error: lk(429, 'RATE_LIMITED'), waitHintMs: 30_000 }).action).toBe('retry');
  });

  it('429 is retried even for a POST without a key (LK refused it, nothing ran)', () => {
    expect(decide({ error: lk(429, 'RATE_LIMITED'), method: 'POST', waitHintMs: 1000 }).action).toBe('retry');
  });

  it('429 with a longer Retry-After: budget-wait until then', () => {
    expect(decide({ error: lk(429, 'RATE_LIMITED'), waitHintMs: 30_001 })).toEqual({
      action: 'budget-wait',
      retryAtMs: NOW + 30_001,
    });
  });

  it('429 after too many short waits: budget-wait', () => {
    const state = { ...INITIAL_RETRY_STATE, rateLimitRetries: settings.maxRateLimitRetries };
    expect(decide({ error: lk(429, 'RATE_LIMITED'), waitHintMs: 1000, state }).action).toBe('budget-wait');
  });

  it('UPLOAD_RATE_EXCEEDED without Retry-After: reactive doubling backoff, then budget-wait', () => {
    let state = INITIAL_RETRY_STATE;
    const delays: number[] = [];
    for (;;) {
      const d = decide({ error: lk(429, 'UPLOAD_RATE_EXCEEDED'), method: 'POST', state });
      if (d.action !== 'retry') {
        expect(d.action).toBe('budget-wait');
        break;
      }
      expect(d.reason).toBe('upload-backoff');
      delays.push(d.delayMs);
      state = d.state;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it.each(['GET', 'PUT', 'PATCH', 'DELETE'] as const)(
    '502/503/504, timeout and connection errors on %s: exponential backoff, 3 tries',
    (method) => {
      for (const error of [lk(502), lk(503), lk(504), connection, timeout]) {
        let state = INITIAL_RETRY_STATE;
        const delays: number[] = [];
        for (;;) {
          const d = decide({ error, method, state });
          if (d.action !== 'retry') {
            expect(d.action).toBe('fail');
            if (d.action === 'fail') expect(d.error.ambiguous).toBe(method !== 'GET');
            break;
          }
          expect(d.reason).toBe('transient');
          delays.push(d.delayMs);
          state = d.state;
        }
        expect(delays).toEqual([187, 375, 750]); // 250 -> 500 -> 1000 with equal jitter at 0.5
        expect(state.ambiguousPrior).toBe(method !== 'GET');
      }
    },
  );

  it('backoff grows from 250 ms and is capped at 8 s', () => {
    expect(backoffMs(0, 250, 8000, () => 1)).toBe(250);
    expect(backoffMs(5, 250, 8000, () => 1)).toBe(8000);
    expect(backoffMs(12, 250, 8000, () => 1)).toBe(8000);
    expect(backoffMs(3, 250, 8000, () => 0)).toBe(1000);
  });

  it('transient failure on POST: retry only with an Idempotency-Key', () => {
    const without = decide({ error: lk(503), method: 'POST' });
    expect(without.action).toBe('fail');
    if (without.action === 'fail') expect(without.error).toMatchObject({ ambiguous: true, retryable: false });
    expect(decide({ error: connection, method: 'POST', hasIdempotencyKey: true }).action).toBe('retry');
  });

  it('409 IN_PROGRESS: short backoff, same key', () => {
    let state = INITIAL_RETRY_STATE;
    let retries = 0;
    for (;;) {
      const d = decide({ error: lk(409, 'IN_PROGRESS'), method: 'POST', hasIdempotencyKey: true, state });
      if (d.action !== 'retry') break;
      expect(d.reason).toBe('in-progress');
      state = d.state;
      retries++;
    }
    expect(retries).toBe(settings.maxInProgressRetries);
  });

  it('412 after an ambiguous earlier attempt: verify; a plain 412 is a conflict', () => {
    const ambiguous = { ...INITIAL_RETRY_STATE, ambiguousPrior: true };
    expect(decide({ error: lk(412, 'VERSION_MISMATCH'), method: 'PUT', state: ambiguous }).action).toBe(
      'verify',
    );
    const plain = decide({ error: lk(412, 'VERSION_MISMATCH'), method: 'PUT' });
    expect(plain.action).toBe('fail');
    if (plain.action === 'fail') expect(plain.error.classification).toBe('conflict');
  });

  it('404 / 409 ALREADY_DELETED after an ambiguous DELETE: verify', () => {
    const ambiguous = { ...INITIAL_RETRY_STATE, ambiguousPrior: true };
    expect(decide({ error: lk(404, 'NOT_FOUND'), method: 'DELETE', state: ambiguous }).action).toBe('verify');
    expect(decide({ error: lk(409, 'ALREADY_DELETED'), method: 'DELETE', state: ambiguous }).action).toBe(
      'verify',
    );
    expect(decide({ error: lk(404, 'NOT_FOUND'), method: 'DELETE' }).action).toBe('fail');
    expect(decide({ error: lk(409, 'DUPLICATE_ID'), method: 'POST', state: ambiguous }).action).toBe(
      'verify',
    );
  });

  it('500 INTERNAL and other 4xx: never retried', () => {
    for (const error of [
      lk(500, 'INTERNAL'),
      lk(400, 'VALIDATION_ERROR'),
      lk(401, 'UNAUTHENTICATED'),
      lk(402, 'PAID_PLAN_REQUIRED'),
      lk(403, 'INSUFFICIENT_SCOPE'),
      lk(404, 'NOT_FOUND'),
      lk(409, 'HAS_CHILDREN'),
      lk(409, 'IDEMPOTENCY_KEY_REUSED'),
      lk(413, 'PAYLOAD_TOO_LARGE'),
      lk(422, 'DOCUMENT_TOO_LARGE'),
    ]) {
      const d = decide({ error, method: 'GET' });
      expect(d.action).toBe('fail');
      if (d.action === 'fail') expect(d.error.retryable).toBe(false);
    }
  });
});

describe('retry matrix: through the governor', () => {
  it('429 Retry-After 5 s: waits on the clock and retries with the same Idempotency-Key', async () => {
    const env = setup();
    env.setResponder((_r, i) =>
      i === 0
        ? lkError(429, 'RATE_LIMITED', { ...rate(120, 0, env.clock.now() + 5000), 'retry-after': '5' })
        : json(201, { id: 'x' }),
    );
    const t0 = env.clock.now();
    const p = track(env.call({ costs: WRITE, idempotencyKey: 'lkb.job1.3.0' }));
    await env.clock.advance(4999);
    expect(p.done).toBe(false);
    await env.clock.advance(1);
    expect(p.done && !p.error).toBe(true);
    expect(env.seen.map((s) => s.headers.get('idempotency-key'))).toEqual(['lkb.job1.3.0', 'lkb.job1.3.0']);
    expect(env.seen[1]!.atMs - t0).toBe(5000);
  });

  it('429 Retry-After 120 s: BudgetWaitError { tier, retryAtMs } and a budget-wait event', async () => {
    const env = setup();
    const events: BudgetWaitEvent[] = [];
    env.governor.on('budget-wait', (e) => events.push(e));
    env.setResponder(() =>
      lkError(429, 'RATE_LIMITED', { ...rate(6000, 0, env.clock.now() + 120_000), 'retry-after': '120' }),
    );
    const t0 = env.clock.now();
    const err = await env.call({ priority: 'P2', jobId: 'j1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetWaitError);
    expect(err).toMatchObject({
      tier: 'key-hour',
      retryAtMs: t0 + 120_000,
      code: 'RATE_LIMITED',
      status: 429,
    });
    expect(events[0]).toMatchObject({
      tier: 'key-hour',
      jobId: 'j1',
      priority: 'P2',
      retryAtMs: t0 + 120_000,
    });
    expect(env.seen).toHaveLength(1);
    // Anything else needing that tier now parks immediately instead of queueing.
    await expect(env.call()).rejects.toBeInstanceOf(BudgetWaitError);
    expect(env.seen).toHaveLength(1);
  });

  it('UPLOAD_RATE_EXCEEDED blocks only the upload tier', async () => {
    const env = setup();
    env.setResponder((_r, i) => (i === 0 ? lkError(429, 'UPLOAD_RATE_EXCEEDED') : json(200, {})));
    const upload = { tiers: [...WRITE.tiers, 'upload' as const] };
    const p = track(env.call({ costs: upload, idempotencyKey: 'up-1' }));
    await env.clock.advance(0);
    const snap = env.governor.snapshot();
    expect(snap.tiers.upload.blockedUntilMs).toBe(env.clock.now() + 1000);
    expect(snap.tiers['key-min'].blockedUntilMs).toBeNull();
    await env.call(); // reads are unaffected
    await env.clock.advance(1000);
    expect(p.done && !p.error).toBe(true);
  });

  it('503 twice on GET, then success', async () => {
    const env = setup();
    env.setResponder((_r, i) => (i < 2 ? lkError(503, 'UNAVAILABLE') : json(200, { ok: 1 })));
    const p = track(env.call());
    await env.clock.advance(1000);
    expect(p.done && !p.error).toBe(true);
    expect(env.seen.map((s) => s.atMs - env.seen[0]!.atMs)).toEqual([0, 187, 187 + 375]);
  });

  it('gives up after 3 transient retries with a retryable upstream error', async () => {
    const env = setup({}, () => lkError(504, 'GATEWAY'));
    const p = track(env.call());
    await env.clock.advance(10_000);
    expect(p.error).toMatchObject({ classification: 'upstream', status: 504, attempts: 4 });
    expect(env.seen).toHaveLength(4);
  });

  it('500 INTERNAL is never retried and keeps the requestId', async () => {
    const env = setup({}, () => lkError(500, 'INTERNAL', { 'x-request-id': 'req-500' }));
    await expect(env.call()).rejects.toMatchObject({
      code: 'INTERNAL',
      requestId: 'req-500',
      retryable: false,
    });
    expect(env.seen).toHaveLength(1);
  });

  it('connection drop on POST without a key: no retry, ambiguous', async () => {
    const env = setup({}, () => Promise.reject(new TypeError('fetch failed')));
    await expect(env.call({ costs: WRITE })).rejects.toMatchObject({
      code: 'CONNECTION_ERROR',
      ambiguous: true,
      retryable: false,
    });
    expect(env.seen).toHaveLength(1);
  });

  it('connection drop on POST with a key: retried with the same key', async () => {
    const env = setup();
    env.setResponder((_r, i) => (i === 0 ? Promise.reject(new TypeError('socket hang up')) : json(201, {})));
    const p = track(env.call({ costs: WRITE, idempotencyKey: 'k-1' }));
    await env.clock.advance(1000);
    expect(p.done && !p.error).toBe(true);
    expect(env.seen.map((s) => s.headers.get('idempotency-key'))).toEqual(['k-1', 'k-1']);
  });

  it('timeout: the governor aborts the attempt on its clock and retries a GET', async () => {
    const env = setup({ requestTimeoutMs: 10_000 });
    env.setResponder((req, i) =>
      i === 0
        ? new Promise<Response>((_, reject) =>
            req.signal?.addEventListener('abort', () => reject(req.signal?.reason as Error)),
          )
        : json(200, {}),
    );
    const p = track(env.call());
    await env.clock.advance(9_999);
    expect(p.done).toBe(false);
    expect(env.seen[0]!.signal?.aborted).toBe(false);
    await env.clock.advance(1);
    expect(env.seen[0]!.signal?.aborted).toBe(true);
    await env.clock.advance(1000);
    expect(p.done && !p.error).toBe(true);
  });

  it('409 IN_PROGRESS then success, same key', async () => {
    const env = setup();
    env.setResponder((_r, i) =>
      i === 0 ? lkError(409, 'IN_PROGRESS') : json(201, {}, { 'idempotent-replay': 'true' }),
    );
    const p = track(env.call({ costs: WRITE, idempotencyKey: 'k-2' }));
    await env.clock.advance(2000);
    expect(p.done && !p.error).toBe(true);
    expect(env.seen.map((s) => s.headers.get('idempotency-key'))).toEqual(['k-2', 'k-2']);
  });

  it('DELETE: 503, then 404 on the retry -> success (it is gone)', async () => {
    const env = setup();
    env.setResponder((_r, i) => (i === 0 ? lkError(503, 'UNAVAILABLE') : lkError(404, 'NOT_FOUND')));
    const p = track(env.call({ costs: WRITE, method: 'DELETE' }));
    await env.clock.advance(1000);
    expect(p.done).toBe(true);
    expect(p.error).toBeUndefined();
  });

  it('versioned PUT: 504, then 412 -> verify decides', async () => {
    for (const applied of [true, false]) {
      const env = setup();
      env.setResponder((_r, i) => (i === 0 ? lkError(504, 'GATEWAY') : lkError(412, 'VERSION_MISMATCH')));
      const done = new Response('verified');
      const p = track(
        env.call({
          costs: WRITE,
          method: 'PUT',
          headers: { 'if-match': 'v1' },
          verify: ({ error }) => {
            expect(error.code).toBe('VERSION_MISMATCH');
            return Promise.resolve(applied ? { ok: true, value: done } : { ok: false });
          },
        }),
      );
      await env.clock.advance(1000);
      if (applied) expect(p.value).toBe(done);
      else expect(p.error).toMatchObject({ code: 'VERSION_MISMATCH', classification: 'conflict' });
    }
  });

  it('a plain 412 (no ambiguous attempt) is returned as a conflict without verify', async () => {
    const env = setup({}, () => lkError(412, 'VERSION_MISMATCH'));
    let verified = false;
    const p = env.call({
      costs: WRITE,
      method: 'PATCH',
      verify: () => {
        verified = true;
        return Promise.resolve({ ok: false });
      },
    });
    await expect(p).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(verified).toBe(false);
  });

  it('a caller abort while queued rejects with ABORTED and sends nothing', async () => {
    const env = setup();
    await env.call({ costs: WRITE });
    const ac = new AbortController();
    const p = track(env.call({ costs: WRITE, signal: ac.signal }));
    ac.abort();
    await env.clock.advance(1000);
    expect(p.error).toMatchObject({ code: 'ABORTED' });
    expect(env.seen).toHaveLength(1);
  });
});

describe('governor guards', () => {
  it('refuses a fetch outside execute, and a straggler fetch after its call finished', async () => {
    const env = setup();
    await expect(env.governor.fetch('http://lk.test/x')).rejects.toMatchObject({ code: 'GOVERNOR_BYPASS' });
    let later: (() => Promise<Response>) | undefined;
    await env.governor.execute({
      opId: 'test.op',
      kind: 'read',
      costs: READ,
      priority: 'P1',
      run: () => {
        later = () => env.governor.fetch('http://lk.test/x');
        return Promise.resolve('done');
      },
    });
    await expect(later!()).rejects.toMatchObject({ code: 'GOVERNOR_BYPASS' });
    expect(env.seen).toHaveLength(0);
    expect(env.used('key-min')).toBe(0); // a call that never sent anything is refunded
  });

  it('wraps a throwing verify hook into a BridgeLkError', async () => {
    const env = setup();
    env.setResponder((_r, i) => (i === 0 ? lkError(503, 'X') : lkError(404, 'NOT_FOUND')));
    const p = track(
      env.call({
        costs: WRITE,
        method: 'DELETE',
        verify: () => Promise.reject(new Error('re-read blew up')),
      }),
    );
    await env.clock.advance(1000);
    expect(p.error).toBeInstanceOf(BridgeLkError);
    expect(p.error).toMatchObject({ code: 'UNEXPECTED', classification: 'bridge' });
  });

  it('rejects invalid requests up front', async () => {
    const env = setup();
    await expect(env.call({ idempotencyKey: 'has space' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(
      env.governor.execute({
        opId: 'x',
        kind: 'read',
        costs: WRITE,
        priority: 'P1',
        run: () => Promise.resolve(1),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      env.governor.execute({
        opId: 'x',
        kind: 'write',
        costs: { tiers: [...WRITE.tiers, 'items-min'], items: 600 },
        priority: 'P2',
        run: () => Promise.resolve(1),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(env.seen).toHaveLength(0);
  });
});
