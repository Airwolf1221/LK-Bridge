/**
 * PLAN §11.1, chunk 1: a simulated 1,000-call workload against the mock LK never exceeds any tier, and an
 * injected 429 is honoured. Real SDK, real HTTP, fake clock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import type { PriorityClass } from '../../src/lk/governor/types.js';
import { idempotencyKeyFor } from '../../src/lk/idempotency.js';
import type { TierId } from '../../src/lk/registry-types.js';
import { drive, runSteps, type RunLog } from './drive.js';
import { MockLk, PUBLISHED_LIMITS } from './mock-lk.js';

const API_KEY = 'mock-key-not-real';
const PROJECT = 'proj_mock';

let mock: MockLk | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function harness(limits: Partial<Record<Exclude<TierId, 'upload'>, number>> = {}) {
  const clock = new FakeClock();
  mock = new MockLk({ clock, apiKey: API_KEY, limits });
  const baseUrl = await mock.start();
  const defaults = defaultGovernorSettings();
  const client = createLkClient({
    apiKey: API_KEY,
    projectId: PROJECT,
    baseUrl,
    clock,
    random: () => 0.5,
    governor: defaultGovernorSettings({ tierLimits: { ...defaults.tierLimits, ...limits } }),
  });
  return { clock, mock, client };
}

/** 1,000 calls: four P2 jobs, ten P1 agents, P3 maintenance. */
function workload(c: LkClient) {
  const p = c.projectId;
  const get = (priority: PriorityClass, jobId?: string) => () =>
    c.call({
      operationId: 'getResource',
      priority,
      ...(jobId ? { jobId } : {}),
      run: (sdk, signal) => sdk.resources.get({ projectId: p, resourceId: 'r1' }, { signal }),
    });
  const list = (priority: PriorityClass, jobId?: string) => () =>
    c.call({
      operationId: 'listResources',
      priority,
      ...(jobId ? { jobId } : {}),
      run: (sdk, signal) => sdk.resources.list({ projectId: p }, { signal }),
    });
  const create = (priority: PriorityClass, jobId: string, step: number) => () =>
    c.call({
      operationId: 'createResource',
      priority,
      jobId,
      idempotencyKey: idempotencyKeyFor(jobId, step),
      run: (sdk, signal) => sdk.resources.create({ projectId: p }, { name: `n${step}`, signal } as never),
    });
  const update = (jobId: string) => () =>
    c.call({
      operationId: 'updateResource',
      priority: 'P2',
      jobId,
      run: (sdk, signal) =>
        sdk.resources.update({ projectId: p, resourceId: 'r1' }, { name: 'renamed', signal }),
    });
  const del = (jobId: string) => () =>
    c.call({
      operationId: 'deleteResource',
      priority: 'P2',
      jobId,
      run: (sdk, signal) => sdk.resources.delete({ projectId: p, resourceId: 'r1' }, { signal }),
    });
  const createMany = (jobId: string, step: number) => () => {
    const resources = Array.from({ length: 100 }, (_, i) => ({ name: `bulk${step}-${i}` }));
    return c.call({
      operationId: 'createManyResources',
      priority: 'P2',
      jobId,
      idempotencyKey: idempotencyKeyFor(jobId, step),
      input: { body: { resources } },
      run: (sdk, signal) => sdk.resources.createMany({ projectId: p }, { resources, signal } as never),
    });
  };

  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const lanes: Array<Array<() => Promise<unknown>>> = [
    range(150).map((i) => create('P2', 'j1', i)),
    range(200).map((i) => (i % 2 ? update('j2') : get('P2', 'j2'))),
    range(200).map((i) => (i % 4 ? get('P2', 'j3') : list('P2', 'j3'))),
    [...range(10).map((i) => createMany('j4', i)), ...range(40).map(() => del('j4'))],
    ...range(10).map((a) => range(35).map((i) => (i % 7 === 6 ? create('P1', `agent${a}`, i) : get('P1')))),
    range(50).map(() => get('P3', 'maint')),
  ];
  expect(lanes.flat()).toHaveLength(1000);
  return lanes;
}

async function run(c: LkClient, clock: FakeClock, maxVirtualMs: number) {
  const log: RunLog = { ok: 0, parked: 0, failed: [] };
  let finished = 0;
  const lanes = workload(c);
  for (const steps of lanes) void runSteps(clock, steps, log).then(() => finished++);
  await drive(clock, c.governor, () => finished === lanes.length, { maxVirtualMs });
  return log;
}

function expectNoTierExceeded(m: MockLk) {
  expect(m.stats.genuine429).toBe(0);
  const max = m.maxInAnyWindow();
  for (const [tier, n] of Object.entries(max)) {
    expect(n, tier).toBeLessThanOrEqual(m.limits[tier as keyof typeof max]);
  }
}

describe('contract: 1,000-call workload against the mock LK', () => {
  it('never exceeds any tier at the published limits, and honours an injected 429', async () => {
    const { clock, mock: m, client } = await harness();
    const throttled: number[] = [];
    client.governor.on('throttled', (e) => throttled.push(e.retryAtMs));
    m.inject((call) => call.n === 400, { kind: 'rate-limit', tier: 'key-min', retryAfterS: 7 });
    const t0 = clock.now();

    const log = await run(client, clock, 6 * 3600_000);

    expect(log.failed).toEqual([]);
    expect(log.ok).toBe(1000);
    expectNoTierExceeded(m);
    // The injected 429: nothing reached LK on that tier until Retry-After had passed, then the call was retried.
    expect(m.stats.injected429).toBe(1);
    expect(m.stats.ignoredRetryAfter).toBe(0);
    const refused = m.calls.find((c) => c.outcome === 'injected-429')!;
    const next = m.calls[refused.n + 1]!;
    expect(next.at - refused.at).toBeGreaterThanOrEqual(7000);
    expect(throttled).toContain(refused.at + 7000);
    // 1,000 calls + the retried one; writes (350 + 10 batches) were paced, so this took minutes of fake time.
    expect(m.calls).toHaveLength(1001);
    const writes = m.calls.filter((c) => c.method !== 'GET');
    for (let i = 1; i < writes.length; i++)
      expect(writes[i]!.at - writes[i - 1]!.at).toBeGreaterThanOrEqual(500);
    expect(clock.now() - t0).toBeGreaterThan(5 * 60_000);
    expect(m.stats.replays).toBe(0);
  }, 60_000);

  it('never exceeds any tier with tight limits and another key draining the project tier', async () => {
    const limits = {
      'write-min': 30,
      'write-hour': 200,
      'key-min': 60,
      'key-hour': 1000,
      'project-hour': 800,
      'items-min': 300,
      'items-hour': 2000,
    };
    const { clock, mock: m, client } = await harness(limits);
    m.consumeExternal(300); // an old bridge's key on the same project
    expect(PUBLISHED_LIMITS['project-hour']).toBe(12000);

    const log = await run(client, clock, 48 * 3600_000);

    expect(log.failed).toEqual([]);
    expect(log.ok).toBe(1000);
    expect(log.parked).toBeGreaterThan(0); // long waits surfaced as BudgetWaitError and the jobs parked
    expectNoTierExceeded(m);
    // The governor learned about the other key from the headers (observed vs modelled drift).
    const drift = client.governor.snapshot().tiers['project-hour'].drift;
    expect(drift).not.toBeNull();
    expect(m.windows['project-hour'].count(clock.now())).toBeLessThanOrEqual(800);
  }, 120_000);

  it('harness self-check: a governor with wrong limits and no rate headers does trip the mock', async () => {
    const clock = new FakeClock();
    mock = new MockLk({ clock, apiKey: API_KEY, limits: { 'key-min': 60 } });
    const baseUrl = await mock.start();
    const client = createLkClient({
      apiKey: API_KEY,
      projectId: PROJECT,
      baseUrl,
      clock,
      random: () => 0.5,
      governor: defaultGovernorSettings(), // believes key-min is 300
      transport: async (input, init) => {
        const r = await fetch(input, init);
        const headers = new Headers(r.headers);
        for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'])
          headers.delete(h);
        return new Response(r.body, { status: r.status, headers });
      },
    });
    const log: RunLog = { ok: 0, parked: 0, failed: [] };
    let finished = false;
    const steps = Array.from(
      { length: 120 },
      () => () =>
        client.call({
          operationId: 'getResource',
          priority: 'P1',
          run: (sdk, signal) => sdk.resources.get({ projectId: PROJECT, resourceId: 'r1' }, { signal }),
        }),
    );
    void runSteps(clock, steps, log).then(() => (finished = true));
    await drive(clock, client.governor, () => finished);
    expect(mock.stats.genuine429).toBeGreaterThan(0); // so a 0 above is meaningful
    expect(log.ok).toBe(120); // and the governor still recovered via Retry-After
  }, 60_000);
});
