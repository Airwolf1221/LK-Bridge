/**
 * v2 E5.5 (ADR 0047): LegendKeeper's undocumented per-operation tiers. A header whose limit matches no documented tier
 * is learned for the operation's rate group and paces only that group; it never lowers `write-min` (the owner's
 * rehearsal of 15–16 November 2026 ran at 20 writes a minute after one image upload). A documented tier is still
 * matched by its limit, and a genuine change to one is still learned when the header is consistent with it.
 */
import { describe, expect, it } from 'vitest';
import { formatBudgetFooter } from '../../src/lk/governor/footer.js';
import { BudgetWaitError } from '../../src/lk/errors.js';
import { windowFromReset, rateGroupOf, drawsLearnedTier } from '../../src/lk/governor/groups.js';
import type { SampleEvent, ThrottledEvent } from '../../src/lk/governor/types.js';
import { json, lkError, rate, setup, track, WRITE } from './governor-helpers.js';

const UPLOAD = { tiers: [...WRITE.tiers, 'upload' as const] };
let key = 0;
const idem = () => `k-${++key}`;

/** Runs one call to the end, moving fake time in small steps (writes wait for the spacing). */
async function done<T>(env: ReturnType<typeof setup>, p: Promise<T>): Promise<T> {
  const s = track(p);
  for (let i = 0; !s.done && i < 10_000; i++) await env.clock.advance(100);
  if (s.error instanceof Error) throw s.error;
  if (s.error !== undefined) throw new Error('the call failed with a non-Error value');
  return s.value as T;
}

describe('rate groups', () => {
  it('lists the asset operations in one group; any other operation is a group of its own', () => {
    for (const op of [
      'createAssetFolder',
      'createImageUpload',
      'createImageAsset',
      'updateAsset',
      'deleteAsset',
      'upload_image.put',
    ])
      expect(rateGroupOf(op)).toBe('assets');
    expect(rateGroupOf('createResource')).toBe('createResource');
    expect(rateGroupOf('listAssets')).toBe('listAssets');
    // The signed PUT joins only once it has carried the headers itself.
    expect(drawsLearnedTier('upload_image.put', 'assets', ['createImageUpload'])).toBe(false);
    expect(drawsLearnedTier('upload_image.put', 'assets', ['upload_image.put'])).toBe(true);
    expect(drawsLearnedTier('deleteAsset', 'assets', ['createImageUpload'])).toBe(true);
  });

  it('infers the window from the reset: up to 60 s a minute, up to an hour an hour, otherwise a day', () => {
    expect(windowFromReset(-500)).toBe(60_000);
    expect(windowFromReset(60_000)).toBe(60_000);
    expect(windowFromReset(61_000)).toBe(60_000); // the reset is in whole seconds, rounded up
    expect(windowFromReset(61_001)).toBe(3_600_000);
    expect(windowFromReset(3_601_000)).toBe(3_600_000);
    expect(windowFromReset(3_601_001)).toBe(86_400_000);
  });
});

describe('learned operation tiers', () => {
  it('a 20/min header on createImageUpload leaves write-min at 120 and paces only the assets group', async () => {
    const env = setup();
    const samples: SampleEvent[] = [];
    env.governor.on('sample', (s) => samples.push(s));
    const t0 = env.clock.now();
    env.setResponder(() => json(201, {}, rate(20, 2, env.clock.now() + 20_000)));
    await env.call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem() });

    const snap = env.governor.snapshot();
    expect(snap.tiers['write-min']).toMatchObject({ limit: 120, configuredLimit: 120, used: 1 });
    expect(snap.operationTiers).toEqual([
      expect.objectContaining({
        id: 'group:assets',
        group: 'assets',
        ops: ['createImageUpload'],
        limit: 20,
        windowMs: 60_000,
        used: 18,
        remaining: 2,
        reportedRemaining: 2,
        lastSeenAtMs: t0,
        expiresAtMs: t0 + 120_000,
        blockedUntilMs: null,
      }),
    ]);
    expect(samples[0]).toMatchObject({ tier: null, group: 'assets', limit: 20, remaining: 2 });

    // The next asset call waits for the group's window (P1 may use 18 of 20); an ordinary write goes at the spacing.
    env.setResponder(() => json(201, {}));
    const asset = track(
      env.call({ opId: 'createImageAsset', costs: UPLOAD, idempotencyKey: idem(), jobId: 'images' }),
    );
    const page = track(
      env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem(), jobId: 'pages' }),
    );
    await env.clock.advance(1000);
    expect(page.done && !page.error).toBe(true);
    expect(asset.done).toBe(false);
    await env.clock.advance(19_000); // the 18 units LegendKeeper counted leave at its reset
    expect(asset.done && !asset.error).toBe(true);
    expect(env.governor.snapshot().tiers['write-min'].limit).toBe(120);
  });

  it('a 60 header on deleteAsset likewise: write-min stays at 120, assets learns 60', async () => {
    const env = setup();
    env.setResponder(() => json(204, null, rate(60, 58, env.clock.now() + 30_000)));
    await env.call({ opId: 'deleteAsset', costs: WRITE, method: 'DELETE' });
    const snap = env.governor.snapshot();
    expect(snap.tiers['write-min'].limit).toBe(120);
    expect(snap.operationTiers).toEqual([
      expect.objectContaining({ group: 'assets', ops: ['deleteAsset'], limit: 60, windowMs: 60_000 }),
    ]);
    // Ordinary writes are not paced by it.
    env.setResponder(() => json(201, {}));
    const t = env.clock.now();
    for (let i = 0; i < 10; i++)
      await done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }));
    expect(env.seen.slice(1).map((s) => s.atMs - t)).toEqual([
      500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000,
    ]);
  });

  it('a 120 or 3,000 header on an ordinary write is matched as now', async () => {
    const env = setup();
    env.setResponder(() => json(201, {}, rate(120, 100, env.clock.now() + 60_000)));
    await env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() });
    env.setResponder(() => json(201, {}, rate(3000, 2000, env.clock.now() + 1_800_000)));
    await done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }));
    const snap = env.governor.snapshot();
    expect(snap.tiers['write-min']).toMatchObject({ limit: 120, used: 21 });
    expect(snap.tiers['write-hour']).toMatchObject({ limit: 3000, used: 1000 });
    expect(snap.operationTiers).toEqual([]);
  });

  it('a header consistent with write-min but with a new limit (100) still lowers it, and 120 restores it', async () => {
    const env = setup();
    for (let i = 0; i < 5; i++)
      await done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }));
    // Its window by the reset (≤ 60 s) and LegendKeeper's count (6) the bridge's own (6).
    env.setResponder(() => json(201, {}, rate(100, 94, env.clock.now() + 50_000)));
    await done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }));
    let snap = env.governor.snapshot();
    expect(snap.tiers['write-min']).toMatchObject({ limit: 100, configuredLimit: 120 });
    expect(snap.operationTiers).toEqual([]);
    env.setResponder(() => json(201, {}, rate(120, 113, env.clock.now() + 50_000)));
    await done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }));
    snap = env.governor.snapshot();
    expect(snap.tiers['write-min'].limit).toBe(120);
  });

  it('a new limit far from the bridge’s own count is the operation’s own tier, not write-min', async () => {
    const env = setup();
    for (let i = 0; i < 30; i++)
      await done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }));
    // LegendKeeper says 1 of 60 used where the bridge counted 31 writes in the minute.
    env.setResponder(() => json(204, null, rate(60, 59, env.clock.now() + 30_000)));
    await done(env, env.call({ opId: 'deleteResource', costs: WRITE, method: 'DELETE' }));
    const snap = env.governor.snapshot();
    expect(snap.tiers['write-min'].limit).toBe(120);
    expect(snap.operationTiers).toEqual([
      expect.objectContaining({ group: 'deleteResource', ops: ['deleteResource'], limit: 60 }),
    ]);
  });

  it('an asset operation never lowers write-min, even when the counts agree (the start of a rehearsal)', async () => {
    const env = setup();
    await env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem() }); // the rehearsal's root
    // The asset folder: 2 writes in the minute by both counts, but the limit (20) is the asset routes' own.
    env.setResponder(() => json(201, {}, rate(20, 18, env.clock.now() + 55_000)));
    await done(env, env.call({ opId: 'createAssetFolder', costs: WRITE, idempotencyKey: idem() }));
    const snap = env.governor.snapshot();
    expect(snap.tiers['write-min'].limit).toBe(120);
    expect(snap.operationTiers.map((t) => [t.group, t.limit])).toEqual([['assets', 20]]);
  });

  it('a later header with the same limit updates the learned tier; a reset beyond a minute widens its window', async () => {
    const env = setup();
    env.setResponder(() => json(201, {}, rate(20, 19, env.clock.now() + 10_000)));
    await env.call({ opId: 'createAssetFolder', costs: WRITE, idempotencyKey: idem() });
    env.setResponder(() => json(201, {}, rate(20, 17, env.clock.now() + 1_200_000)));
    await env.clock.advance(5_000);
    await done(env, env.call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem() }));
    const [t] = env.governor.snapshot().operationTiers;
    expect(t).toMatchObject({
      ops: ['createAssetFolder', 'createImageUpload'],
      limit: 20,
      windowMs: 3_600_000,
      reportedRemaining: 17,
      used: 3,
    });
  });

  it('a learned tier expires when its window has passed twice without the header being seen again', async () => {
    const env = setup();
    const t0 = env.clock.now();
    env.setResponder(() => json(201, {}, rate(20, 19, env.clock.now() + 30_000)));
    await env.call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem() });
    env.setResponder(() => json(201, {}));
    await env.clock.advanceTo(t0 + 100_000);
    expect(env.governor.snapshot().operationTiers).toHaveLength(1);
    // Seen again at 100 s: it lives until 100 s + two minutes.
    env.setResponder(() => json(201, {}, rate(20, 19, env.clock.now() + 30_000)));
    await env.call({ opId: 'createImageAsset', costs: UPLOAD, idempotencyKey: idem() });
    expect(env.seen.at(-1)!.atMs).toBe(t0 + 100_000);
    env.setResponder(() => json(201, {}));
    await env.clock.advanceTo(t0 + 219_999);
    expect(env.governor.snapshot().operationTiers).toHaveLength(1);
    await env.clock.advanceTo(t0 + 220_000);
    expect(env.governor.snapshot().operationTiers).toEqual([]);
    // Gone: asset calls are paced by the documented tiers only again.
    const before = env.seen.length;
    for (let i = 0; i < 25; i++)
      await done(env, env.call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem() }));
    expect(env.seen.length - before).toBe(25);
    expect(env.seen.at(-1)!.atMs - env.seen[before]!.atMs).toBe(24 * 500);
  });

  it('a 429 in a group blocks only that group, honouring Retry-After, and the footer names it', async () => {
    const env = setup();
    const throttled: ThrottledEvent[] = [];
    env.governor.on('throttled', (e) => throttled.push(e));
    const t0 = env.clock.now();
    env.setResponder((_r, i) =>
      i === 0
        ? lkError(429, 'RATE_LIMITED', { ...rate(20, 0, env.clock.now() + 15_000), 'retry-after': '15' })
        : json(201, {}),
    );
    const upload = track(
      env.call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem(), jobId: 'img' }),
    );
    await env.clock.advance(0);
    const snap = env.governor.snapshot();
    expect(snap.operationTiers[0]).toMatchObject({ group: 'assets', blockedUntilMs: t0 + 15_000 });
    expect(snap.tiers['write-min'].blockedUntilMs).toBeNull();
    expect(snap.tiers['key-min'].blockedUntilMs).toBeNull();
    expect(snap.tiers.upload.blockedUntilMs).toBeNull();
    expect(throttled[0]).toMatchObject({ tiers: ['group:assets'], retryAtMs: t0 + 15_000 });
    expect(formatBudgetFooter(snap)).toMatch(/ \| blocked assets 15s$/);

    // Another asset call waits; an ordinary write goes now.
    const folder = track(
      env.call({ opId: 'createAssetFolder', costs: WRITE, idempotencyKey: idem(), jobId: 'f' }),
    );
    const page = track(
      env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem(), jobId: 'p' }),
    );
    await env.clock.advance(1000);
    expect(page.done && !page.error).toBe(true);
    expect(folder.done || upload.done).toBe(false);
    await env.clock.advance(13_999);
    expect(folder.done || upload.done).toBe(false);
    await env.clock.advance(1001); // Retry-After passed: the waiting folder, then the retried upload at the spacing
    await env.clock.advance(500);
    expect(folder.done && !folder.error).toBe(true);
    expect(upload.done && !upload.error).toBe(true);
    expect(env.seen.filter((s) => s.atMs < t0 + 15_000)).toHaveLength(2); // the refused upload and the page
  });

  it('a long Retry-After in a group parks the call with the group named as its tier', async () => {
    const env = setup();
    env.setResponder(() =>
      lkError(429, 'RATE_LIMITED', { ...rate(20, 0, env.clock.now() + 120_000), 'retry-after': '120' }),
    );
    const t0 = env.clock.now();
    const err = await env
      .call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem(), priority: 'P2', jobId: 'j' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetWaitError);
    expect(err).toMatchObject({ tier: 'group:assets', retryAtMs: t0 + 120_000 });
    // Writes outside the group are not parked.
    env.setResponder(() => json(201, {}));
    await expect(
      done(env, env.call({ opId: 'createResource', costs: WRITE, idempotencyKey: idem(), priority: 'P2' })),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      done(env, env.call({ opId: 'deleteAsset', costs: WRITE, method: 'DELETE', priority: 'P2' })),
    ).rejects.toMatchObject({ tier: 'group:assets' });
  });

  it('UPLOAD_RATE_EXCEEDED still blocks the upload tier, as before', async () => {
    const env = setup();
    env.setResponder((_r, i) => (i === 0 ? lkError(429, 'UPLOAD_RATE_EXCEEDED') : json(200, {})));
    const p = track(env.call({ opId: 'createImageUpload', costs: UPLOAD, idempotencyKey: idem() }));
    await env.clock.advance(0);
    const snap = env.governor.snapshot();
    expect(snap.tiers.upload.blockedUntilMs).toBe(env.clock.now() + 1000);
    expect(snap.operationTiers).toEqual([]);
    await env.clock.advance(1000);
    expect(p.done && !p.error).toBe(true);
  });

  it('logs the first sighting of a group and limit once per process, naming the op and the figures', async () => {
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const { Governor } = await import('../../src/lk/governor/governor.js');
    const { FakeClock } = await import('../../src/lk/governor/clock.js');
    const { defaultGovernorSettings } = await import('../../src/config/lk.js');
    const clock = new FakeClock();
    let headers: Record<string, string> = {};
    const g = new Governor({
      settings: defaultGovernorSettings(),
      clock,
      random: () => 0.5,
      log: { info: (obj, msg) => lines.push({ obj, msg }) },
      transport: () => Promise.resolve(json(201, {}, headers)),
    });
    const up = (opId: string) =>
      g.execute<Response>({
        opId,
        kind: 'write',
        costs: UPLOAD,
        priority: 'P1',
        idempotencyKey: idem(),
        run: (signal) => g.fetch('http://lk.test/api/v3/x', { method: 'POST', signal }),
      });
    headers = rate(20, 19, clock.now() + 40_000);
    await up('createImageUpload');
    await clock.advance(500);
    headers = rate(20, 18, clock.now() + 39_000);
    await up('createImageAsset');
    // Expired and learned again: still not logged a second time.
    await clock.advance(200_000);
    headers = rate(20, 19, clock.now() + 40_000);
    await up('createImageUpload');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({
      op: 'createImageUpload',
      group: 'assets',
      limit: 20,
      remaining: 19,
      resetInSeconds: 40,
      windowSeconds: 60,
    });
    expect(lines[0]!.msg).toMatch(/limit of 20 per minute on createImageUpload/);
    // A new limit for the group is a new sighting.
    headers = rate(60, 59, clock.now() + 30_000);
    await clock.advance(500);
    await up('deleteAsset');
    expect(lines.map((l) => l.obj.limit)).toEqual([20, 60]);
  });
});

describe('estimates with learned tiers and a measured write time', () => {
  async function learned(remaining = 19) {
    const env = setup();
    env.setResponder(() => json(201, {}, rate(20, remaining, env.clock.now() + 60_000)));
    await env.call({ opId: 'createAssetFolder', costs: WRITE, idempotencyKey: idem() });
    env.setResponder(() => json(201, {}));
    return env;
  }

  it('the asset steps are paced by the assets group, the other writes by 120 a minute', async () => {
    const env = await learned();
    const images = 30;
    const e = env.governor.estimate({
      writes: 200,
      priority: 'P3',
      ops: {
        createAssetFolder: 1,
        createImageUpload: images,
        createImageAsset: images,
        'upload_image.put': images,
        deleteAsset: 1,
      },
    });
    // The documented write tier at its configured 120 (P3's share 60), demand every write.
    expect(e.tiers.find((t) => t.tier === 'write-min')).toMatchObject({
      limit: 120,
      capacityPerWindow: 60,
      demand: 200,
    });
    // The assets group at its learned 20 (P3's share 10, 1 used), demand only its steps (the PUT has not been seen).
    expect(e.operationTiers).toEqual([
      expect.objectContaining({
        id: 'group:assets',
        tier: 'group:assets',
        group: 'assets',
        limit: 20,
        windowMs: 60_000,
        demand: 62,
        capacityPerWindow: 10,
        available: 9,
        timeMs: (62 - 9) * 6_000,
      }),
    ]);
    expect(e.tightestTier).toBe('group:assets');
    expect(e.wallClockMs).toBe((62 - 9) * 6_000);
    // Without ops (or without asset ops), the learned tier plays no part.
    const plain = env.governor.estimate({ writes: 200, priority: 'P3', ops: { createResource: 200 } });
    expect(plain.operationTiers).toEqual([]);
    expect(plain.tightestTier).toBe('pacing');
  });

  it('uses the measured per-write duration, floored at the spacing, and reports which it used', async () => {
    const { Governor } = await import('../../src/lk/governor/governor.js');
    const { FakeClock } = await import('../../src/lk/governor/clock.js');
    const { defaultGovernorSettings } = await import('../../src/config/lk.js');
    let measured: { ms: number; samples: number } | null = { ms: 1800, samples: 200 };
    const g = new Governor({
      settings: defaultGovernorSettings(),
      clock: new FakeClock(),
      writeDuration: () => measured,
    });
    let e = g.estimate({ writes: 40 });
    expect(e.perWrite).toEqual({
      ms: 1800,
      source: 'measured',
      spacingMs: 500,
      measured: { ms: 1800, samples: 200 },
    });
    expect(e.pacingMs).toBe(40 * 1800);
    expect(e.wallClockMs).toBe(40 * 1800);
    measured = { ms: 320, samples: 12 };
    e = g.estimate({ writes: 40 });
    expect(e.perWrite).toEqual({
      ms: 500,
      source: 'spacing',
      spacingMs: 500,
      measured: { ms: 320, samples: 12 },
    });
    expect(e.pacingMs).toBe(40 * 500);
    measured = null;
    expect(g.estimate({ writes: 1 }).perWrite).toEqual({
      ms: 500,
      source: 'spacing',
      spacingMs: 500,
      measured: null,
    });
    // A source that throws never breaks an estimate.
    const broken = new Governor({
      settings: defaultGovernorSettings(),
      clock: new FakeClock(),
      writeDuration: () => {
        throw new Error('database is locked');
      },
    });
    expect(broken.estimate({ writes: 2 }).perWrite.source).toBe('spacing');
  });
});
