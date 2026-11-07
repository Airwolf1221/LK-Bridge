/** Retry matrix against the mock LK over real HTTP and the real SDK: 412, 409 IN_PROGRESS, 5xx, drops, hangs. */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import { drive } from './drive.js';
import { MockLk } from './mock-lk.js';

const API_KEY = 'mock-key-not-real';
const P = 'proj_mock';
let mock: MockLk | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function harness(apiKey = API_KEY) {
  const clock = new FakeClock();
  mock = new MockLk({ clock, apiKey: API_KEY });
  const baseUrl = await mock.start();
  const client = createLkClient({
    apiKey,
    projectId: P,
    baseUrl,
    clock,
    random: () => 0.5,
    governor: defaultGovernorSettings({ requestTimeoutMs: 10_000 }),
  });
  const settle = async <T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> => {
    const state: { done: boolean; value?: T; error?: unknown } = { done: false };
    p.then(
      (value) => Object.assign(state, { done: true, value }),
      (error: unknown) => Object.assign(state, { done: true, error }),
    );
    await drive(clock, client.governor, () => state.done, { settleRealMs: 300 });
    return state;
  };
  return { clock, m: mock, client, settle };
}

const get = (c: LkClient) =>
  c.call({
    operationId: 'getResource',
    priority: 'P1',
    run: (sdk, signal) => sdk.resources.get({ projectId: P, resourceId: 'r1' }, { signal }),
  });
const create = (c: LkClient, idempotencyKey?: string) =>
  c.call({
    operationId: 'createResource',
    priority: 'P1',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    run: (sdk, signal) => sdk.resources.create({ projectId: P }, { name: 'n', signal } as never),
  });

describe('contract: faults through the real SDK', () => {
  it('connection dropped on a GET: backed off and retried', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'drop' });
    const r = await settle(get(client));
    expect(r.error).toBeUndefined();
    expect(m.calls.map((c) => c.outcome)).toEqual(['dropped', 'ok']);
    expect(m.calls[1]!.at - m.calls[0]!.at).toBe(187);
  });

  it('connection dropped after a POST committed: retried with the same key, LK replays', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'drop-after-commit' });
    const r = await settle(create(client, 'lkb.job9.1.0'));
    expect(r.error).toBeUndefined();
    expect(m.calls.map((c) => [c.outcome, c.idempotencyKey])).toEqual([
      ['dropped-after-commit', 'lkb.job9.1.0'],
      ['replay', 'lkb.job9.1.0'],
    ]);
    expect(m.stats.replays).toBe(1);
  });

  it('connection dropped on a POST without a key: not retried, reported as ambiguous', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'drop' });
    const r = await settle(create(client));
    expect(r.error).toMatchObject({ code: 'CONNECTION_ERROR', ambiguous: true, retryable: false });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.idempotencyKey).toBeUndefined(); // the SDK did not invent one
  });

  it('503 on a PATCH: backed off and retried (status decides; gateways send no code)', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'status', status: 503, code: 'INTERNAL' }, 2);
    const r = await settle(
      client.call({
        operationId: 'updateResource',
        priority: 'P2',
        run: (sdk, signal) => sdk.resources.update({ projectId: P, resourceId: 'r1' }, { name: 'x', signal }),
      }),
    );
    expect(r.error).toBeUndefined();
    expect(m.calls.map((c) => c.outcome)).toEqual(['status-503', 'status-503', 'ok']);
    // Backoff is 187 then 375 ms, but a retried write still respects the 500 ms write pacing.
    expect(m.calls.map((c) => c.at - m.calls[0]!.at)).toEqual([0, 500, 1000]);
  });

  it('500 INTERNAL: never retried; the error carries LK requestId', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'status', status: 500, code: 'INTERNAL' });
    const r = await settle(get(client));
    expect(r.error).toMatchObject({ code: 'INTERNAL', classification: 'upstream', retryable: false });
    expect((r.error as { requestId?: string }).requestId).toMatch(/^mock-/);
    expect(m.calls).toHaveLength(1);
  });

  it('409 IN_PROGRESS: retried after a short backoff with the same key', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'in-progress' });
    const r = await settle(create(client, 'k-inprog'));
    expect(r.error).toBeUndefined();
    expect(m.calls.map((c) => [c.outcome, c.idempotencyKey])).toEqual([
      ['in-progress', 'k-inprog'],
      ['ok', 'k-inprog'],
    ]);
  });

  it('412 VERSION_MISMATCH on a versioned write: a conflict, not retried, If-Match was sent', async () => {
    const { m, client, settle } = await harness();
    m.inject(() => true, { kind: 'status', status: 412, code: 'VERSION_MISMATCH' });
    const r = await settle(
      client.call({
        operationId: 'replaceDocumentBlocks',
        priority: 'P1',
        run: (sdk, signal) =>
          sdk.documents.replaceBlocks(
            { projectId: P, resourceId: 'r1', documentId: 'd1' },
            {
              blocks: [],
              ifMatch: 'v1',
              signal,
            },
          ),
      }),
    );
    expect(r.error).toMatchObject({ code: 'VERSION_MISMATCH', classification: 'conflict', retryable: false });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.ifMatch).toBe('v1');
  });

  it('a hung request is aborted by the governor timeout (on the fake clock) and retried', async () => {
    const { clock, m, client, settle } = await harness();
    m.inject(() => true, { kind: 'hang' });
    const t0 = clock.now();
    const r = await settle(get(client));
    expect(r.error).toBeUndefined();
    expect(m.calls.map((c) => c.outcome)).toEqual(['hung', 'ok']);
    expect(m.calls[1]!.at - t0).toBe(10_000 + 187);
  });

  it('401 (bad key): auth error, no rate headers, the call is refunded', async () => {
    const { client, settle } = await harness('wrong-key-not-real');
    const r = await settle(get(client));
    expect(r.error).toMatchObject({ code: 'UNAUTHENTICATED', classification: 'auth', retryable: false });
    expect(client.governor.snapshot().tiers['key-min'].used).toBe(0);
  });

  it('429 with a long Retry-After: BudgetWaitError, and nothing more is sent until it passes', async () => {
    const { clock, m, client, settle } = await harness();
    m.inject(() => true, { kind: 'rate-limit', tier: 'key-min', retryAfterS: 45 });
    const t0 = clock.now();
    const r = await settle(get(client));
    expect(r.error).toBeInstanceOf(BudgetWaitError);
    expect(r.error).toMatchObject({ tier: 'key-min', retryAtMs: t0 + 45_000 });
    const again = await settle(get(client));
    expect(again.error).toBeInstanceOf(BudgetWaitError);
    expect(m.calls).toHaveLength(1);
    await clock.advance(45_000);
    const later = await settle(get(client));
    expect(later.error).toBeUndefined();
    expect(m.stats.ignoredRetryAfter).toBe(0);
  });
});
