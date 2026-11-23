/**
 * v3 F5a (ADR 0067, H10 and H11): how a failed LegendKeeper call is recorded.
 *
 * - H11: a call the client cancelled is "cancelled by the caller", classification `client` (never `bridge`); a read that
 *   times out is retried once and then reported as retryable; a write is never retried by it.
 * - H10: whether the request left the bridge (`sent`), so the error card says "refused before it was sent" only when it
 *   truly never left; a write whose connection broke after it was sent ("terminated", a socket reset, a timeout once
 *   the reply started) is `ambiguous: true`.
 */
import { describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { sentStateOf, toBridgeLkError, type BridgeLkError } from '../../src/lk/errors.js';
import { decideRetry, INITIAL_RETRY_STATE } from '../../src/lk/governor/retry.js';
import { json, READ, setup, track, WRITE } from './governor-helpers.js';

const settings = defaultGovernorSettings().retry;

/** One call whose reply arrives and whose body then fails to read with `bodyError` (the SDK's `readBody`). */
function callReadingBody(
  env: ReturnType<typeof setup>,
  o: { method: string; bodyError: () => unknown; opId?: string; idempotencyKey?: string },
) {
  const costs = o.method === 'GET' ? READ : WRITE;
  return env.governor.execute<unknown>({
    opId: o.opId ?? 'test.op',
    kind: o.method === 'GET' ? 'read' : 'write',
    costs,
    priority: 'P1',
    ...(o.idempotencyKey ? { idempotencyKey: o.idempotencyKey } : {}),
    run: async (signal) => {
      await env.governor.fetch('http://lk.test/api/v3/x', {
        method: o.method,
        signal,
        headers: o.method === 'PUT' ? { 'if-match': 'v1' } : {},
      });
      throw o.bodyError();
    },
  });
}

const terminated = () => Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
const sdkTimeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

describe('H11: a call the caller cancelled', () => {
  it('is "cancelled by the caller", classification client, not bridge', () => {
    const e = toBridgeLkError(new Error('x'), 'listEvents', { aborted: true, fetched: true });
    expect(e).toMatchObject({ code: 'ABORTED', classification: 'client', retryable: false });
    expect(e.message).toMatch(/cancelled by the caller/i);
  });

  it('through the governor: an abort in flight and an abort while queued are both client', async () => {
    const env = setup({}, () => new Promise<Response>(() => {}));
    const ac = new AbortController();
    const p = track(env.call({ opId: 'listEvents', signal: ac.signal }));
    await env.clock.advance(10);
    ac.abort();
    await env.clock.advance(10);
    expect(p.error).toMatchObject({ code: 'ABORTED', classification: 'client' });

    const env2 = setup();
    await env2.call({ costs: WRITE });
    const ac2 = new AbortController();
    const q = track(env2.call({ costs: WRITE, signal: ac2.signal }));
    ac2.abort();
    await env2.clock.advance(1000);
    expect(q.error).toMatchObject({ code: 'ABORTED', classification: 'client', sent: 'no' });
  });

  it('is never retried', () => {
    const e = toBridgeLkError(new Error('x'), 'op', { aborted: true });
    expect(
      decideRetry({
        error: e,
        method: 'GET',
        hasIdempotencyKey: false,
        state: INITIAL_RETRY_STATE,
        settings,
        nowMs: 0,
        waitHintMs: undefined,
      }).action,
    ).toBe('fail');
  });
});

describe('H11: a read that times out', () => {
  it('the SDK timer firing while the body is read is TIMEOUT, retryable (was UNEXPECTED, not retryable)', () => {
    const e = toBridgeLkError(sdkTimeout(), 'listProperties', {
      fetched: true,
      responded: true,
      status: 200,
    });
    expect(e).toMatchObject({ code: 'TIMEOUT', retryable: true, classification: 'upstream' });
  });

  it('is retried once, then reported as retryable', async () => {
    const env = setup({}, () => json(200, { ok: true }));
    const p = track(callReadingBody(env, { method: 'GET', opId: 'listProperties', bodyError: sdkTimeout }));
    await env.clock.advance(60_000);
    expect(env.seen).toHaveLength(2);
    expect(p.error).toMatchObject({ code: 'TIMEOUT', retryable: true, sent: 'yes' });
  });

  it('a read that times out once and then answers succeeds on the retry', async () => {
    let n = 0;
    const env = setup({}, () => json(200, { ok: true }));
    const p = track(
      env.governor.execute<string>({
        opId: 'listProperties',
        kind: 'read',
        costs: READ,
        priority: 'P1',
        run: async (signal) => {
          await env.governor.fetch('http://lk.test/api/v3/x', { method: 'GET', signal });
          if (n++ === 0) throw sdkTimeout();
          return 'ok';
        },
      }),
    );
    await env.clock.advance(60_000);
    expect(p.value).toBe('ok');
    expect(env.seen).toHaveLength(2);
  });

  it('a write whose reply timed out is not retried by the timeout rule (it may have applied)', async () => {
    const env = setup({}, () => json(200, { ok: true }));
    const p = track(
      callReadingBody(env, { method: 'PUT', opId: 'replaceDocumentBlocks', bodyError: terminated }),
    );
    await env.clock.advance(60_000);
    expect(env.seen).toHaveLength(1);
    expect(p.error).toMatchObject({ code: 'RESPONSE_INTERRUPTED', ambiguous: true, retryable: false });
  });
});

describe('H10: sent, and ambiguous', () => {
  it('"terminated" after the reply began, on a write: sent, ambiguous, never UNEXPECTED or bridge', async () => {
    const env = setup({}, () => json(200, { ok: true }));
    const p = track(
      callReadingBody(env, { method: 'PUT', opId: 'replaceDocumentBlocks', bodyError: terminated }),
    );
    await env.clock.advance(1000);
    const e = p.error as BridgeLkError;
    expect(e.code).toBe('RESPONSE_INTERRUPTED');
    expect(e.classification).toBe('upstream');
    expect(e.sent).toBe('yes');
    expect(e.ambiguous).toBe(true);
    expect(e.toJSON()).toMatchObject({ sent: 'yes', ambiguous: true });
  });

  it('a socket reset in the transport after connecting, on a write: sent, ambiguous', async () => {
    const env = setup({ maxTransientRetries: 0 } as never);
    env.setResponder(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const p = track(env.call({ costs: WRITE, method: 'POST' }));
    await env.clock.advance(1000);
    expect(p.error).toMatchObject({ sent: 'yes', ambiguous: true });
  });

  it('a refused connection never left: sent no, not ambiguous', async () => {
    const env = setup();
    env.setResponder(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const p = track(env.call({ costs: WRITE, method: 'POST' }));
    await env.clock.advance(60_000);
    expect(p.error).toMatchObject({ code: 'CONNECTION_ERROR', sent: 'no', ambiguous: false });
  });

  it('a call refused before the transport (If-Match missing) is sent no', async () => {
    const env = setup();
    const p = track(
      env.governor.execute({
        opId: 'replaceDocumentBlocks',
        kind: 'write',
        costs: WRITE,
        priority: 'P1',
        run: (signal) => env.governor.fetch('http://lk.test/api/v3/x', { method: 'PUT', signal }),
      }),
    );
    await env.clock.advance(10);
    expect(p.error).toMatchObject({ code: 'IF_MATCH_REQUIRED' });
    expect(env.seen).toHaveLength(0);
  });

  it('sentStateOf: no without a fetch; yes with a reply; maybe for an unknown transport failure', () => {
    expect(sentStateOf(new Error('x'), { fetched: false })).toBe('no');
    expect(sentStateOf(new Error('x'), { fetched: true, responded: true })).toBe('yes');
    expect(sentStateOf(new Error('x'), { fetched: true, transportError: new Error('boom') })).toBe('maybe');
    expect(sentStateOf(terminated(), { fetched: true, transportError: terminated() })).toBe('yes');
  });

  it('an HTTP error answer is sent yes and not ambiguous', async () => {
    const env = setup({}, () => json(400, { code: 'VALIDATION_ERROR', message: 'bad' }));
    const p = track(env.call({ costs: WRITE, method: 'PATCH' }));
    await env.clock.advance(10);
    expect(p.error).toMatchObject({ code: 'VALIDATION_ERROR', sent: 'yes', ambiguous: false });
  });
});
