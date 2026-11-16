/**
 * v2 E5.5 (ADR 0047), the regression for the owner's rehearsal of 15–16 November 2026: the asset routes have tiers of
 * their own (about 20 a minute for uploads and asset creation, 60 for asset deletes) that LegendKeeper reports when they
 * have the fewest requests left. The bridge took the 20 for `write-min` and paced every write at 20 a minute until a
 * restart; the sampled rehearsal estimated about 10 minutes and ran for over 40.
 *
 * Replayed here against the mock LegendKeeper (real SDK, real HTTP, fake clock) with those tiers switched on: a root,
 * an asset folder, 3 image uploads, then 200 writes, then the deletes. The writes must not be paced at 20 a minute.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import type { PriorityClass } from '../../src/lk/governor/types.js';
import { drive, runSteps, type RunLog } from './drive.js';
import { ASSET_ROUTE_TIERS, MockLk } from './mock-lk.js';

const API_KEY = 'mock-key-not-real';
const PROJECT = 'proj_mock';

let mock: MockLk | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function harness() {
  const clock = new FakeClock();
  mock = new MockLk({ clock, apiKey: API_KEY, opTiers: ASSET_ROUTE_TIERS });
  const baseUrl = await mock.start();
  const client = createLkClient({
    apiKey: API_KEY,
    projectId: PROJECT,
    baseUrl,
    clock,
    random: () => 0.5,
    governor: defaultGovernorSettings(),
  });
  return { clock, mock, client };
}

/** One registry operation, sent raw through the SDK on the governed fetch (as the job engine sends them). */
function op(
  c: LkClient,
  operationId: string,
  method: 'POST' | 'DELETE',
  path: string,
  priority: PriorityClass,
  n: number,
) {
  return () =>
    c.call({
      operationId,
      priority,
      jobId: 'rehearsal',
      ...(method === 'POST' ? { idempotencyKey: `lkb.rh.${n}.0` } : {}),
      run: (sdk, signal) =>
        sdk.request({
          method,
          path: `/api/v3/projects/${PROJECT}${path}`,
          ...(method === 'POST' ? { body: { name: `n${n}` } } : {}),
          signal,
        }),
    });
}

async function run(c: LkClient, clock: FakeClock, steps: Array<() => Promise<unknown>>) {
  const log: RunLog = { ok: 0, parked: 0, failed: [] };
  let finished = false;
  void runSteps(clock, steps, log).then(() => (finished = true));
  await drive(clock, c.governor, () => finished, { maxVirtualMs: 2 * 3_600_000 });
  return log;
}

describe('the owner’s rehearsal, replayed: undocumented asset tiers never pace every write', () => {
  it('a root, an asset folder, 3 uploads, then 200 writes: the writes go at 120 a minute, not 20', async () => {
    const { clock, mock, client } = await harness();
    const P: PriorityClass = 'P3'; // a rehearsal's jobs run at maintenance priority
    let n = 0;
    const start = [
      op(client, 'createResource', 'POST', '/resources', P, n++),
      op(client, 'createAssetFolder', 'POST', '/assets', P, n++),
      ...Array.from({ length: 3 }, () => [
        op(client, 'createImageUpload', 'POST', '/assets/uploads', P, n++),
        op(client, 'createImageAsset', 'POST', '/assets/images', P, n++),
      ]).flat(),
    ];
    let log = await run(client, clock, start);
    expect(log).toMatchObject({ ok: 8, parked: 0, failed: [] });

    // LegendKeeper reported its asset tier (20 a minute); the bridge learned it for the asset group only.
    let snap = client.governor.snapshot();
    expect(snap.tiers['write-min'].limit).toBe(120);
    expect(snap.operationTiers.map((t) => [t.group, t.limit, t.windowMs])).toEqual([['assets', 20, 60_000]]);
    expect(snap.operationTiers[0]!.ops).toEqual([
      'createAssetFolder',
      'createImageUpload',
      'createImageAsset',
    ]);

    // 200 ordinary writes: P3 may use 60 of write-min's 120 a minute. At 20 a minute (P3's share 10) they would take
    // about 19 minutes; at 120 a little under 3.
    const t0 = clock.now();
    log = await run(
      client,
      clock,
      Array.from({ length: 200 }, () => op(client, 'createResource', 'POST', '/resources', P, n++)),
    );
    const took = clock.now() - t0;
    expect(log).toMatchObject({ ok: 200, failed: [] });
    expect(took).toBeLessThan(4 * 60_000);
    expect(took).toBeGreaterThanOrEqual(((200 - 60) / 60) * 60_000); // and within P3's share of 120
    expect(client.governor.snapshot().tiers['write-min'].limit).toBe(120);

    // The 20 a minute was last reported during the uploads, over two minutes ago: it has expired.
    expect(client.governor.snapshot().operationTiers).toEqual([]);

    // The clean-up a minute later: the asset delete reports its own tier (60), learned for the group.
    await clock.advance(60_000);
    log = await run(client, clock, [
      op(client, 'deleteAsset', 'DELETE', '/assets/folder1', P, n++),
      op(client, 'deleteResource', 'DELETE', '/resources/root1', P, n++),
    ]);
    expect(log).toMatchObject({ ok: 2, failed: [] });
    snap = client.governor.snapshot();
    expect(snap.tiers['write-min'].limit).toBe(120);
    expect(snap.operationTiers.map((t) => [t.group, t.limit, t.ops])).toEqual([
      ['assets', 60, ['deleteAsset']],
    ]);

    // LegendKeeper never had to refuse anything, on any tier, documented or not.
    expect(mock.stats.genuine429).toBe(0);
    for (const [tier, max] of Object.entries(mock.maxInAnyWindow()))
      expect(max, tier).toBeLessThanOrEqual(mock.limits[tier as keyof typeof mock.limits]);
    expect(mock.maxInAnyOpWindow()['assets-create']).toBeLessThanOrEqual(20);
  });

  it('many uploads are paced by the asset group’s learned limit, and LegendKeeper never refuses one', async () => {
    const { clock, mock, client } = await harness();
    let n = 0;
    const steps = Array.from({ length: 30 }, () => [
      op(client, 'createImageUpload', 'POST', '/assets/uploads', 'P2', n++),
      op(client, 'createImageAsset', 'POST', '/assets/images', 'P2', n++),
    ]).flat();
    const t0 = clock.now();
    const log = await run(client, clock, steps);
    expect(log.failed).toEqual([]);
    expect(log.ok).toBe(60);
    // P2 may use 15 of the asset group's 20 a minute: 60 calls take at least three more windows after the first.
    expect(clock.now() - t0).toBeGreaterThanOrEqual(3 * 60_000);
    expect(mock.stats.genuine429).toBe(0);
    expect(mock.maxInAnyOpWindow()['assets-create']).toBeLessThanOrEqual(20);
    expect(client.governor.snapshot().tiers['write-min'].limit).toBe(120);
  });
});
