/**
 * v2 E5.5 (ADR 0047, backlog 16): honest plan estimates.
 *
 * - A rehearsal names its asset steps to the governor, so a learned `assets` limit paces those steps only; the rest go
 *   at the documented tiers' effective limits.
 * - Every write takes at least the project's measured per-write duration (the median of its recent write steps),
 *   floored at the spacing, and the plan says which figures it used (`estimate.figures`).
 * - A restore plan carries the same estimate, and restore_snapshot says it in a few words.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import type { Manifest } from '../../src/snapshots/index.js';
import {
  sequentialEstimate,
  type EstimateLike,
  type PlanEstimateInput,
} from '../../src/snapshots/plan-estimate.js';
import { Rehearsals, type RehearsalDeps } from '../../src/snapshots/rehearsal.js';
import { json, rate, setup, track, WRITE } from '../unit/governor-helpers.js';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

const SOURCE = 'proj_arkona';
let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** A governor that has learned LegendKeeper's asset limit (20 a minute, 1 used) and measures 1.5 s a write. */
async function governorWithAssets(measured: { ms: number; samples: number } | null) {
  const env = setup({}, undefined, { writeDuration: () => measured });
  env.setResponder(() => json(201, {}, rate(20, 19, env.clock.now() + 60_000)));
  const p = track(env.call({ opId: 'createAssetFolder', costs: WRITE, idempotencyKey: 'folder-1' }));
  await env.clock.advance(0);
  expect(p.done).toBe(true);
  return env.governor;
}

const rehearsalOps = (images: number) => ({
  createAssetFolder: 1,
  createImageUpload: images,
  createImageAsset: images,
  'upload_image.put': images,
  deleteAsset: 1,
});

describe('the sequential estimate of a plan', () => {
  it('paces the asset steps by the learned assets limit and the other writes at 120 a minute', async () => {
    const g = await governorWithAssets(null);
    const ask = (images: number, writes: number): [PlanEstimateInput, EstimateLike] => {
      const input = { reads: 0, writes, priority: 'P3' as const, ops: rehearsalOps(images) };
      return [input, g.estimate(input)];
    };

    // 3 images: 8 asset steps fit in P3's share of the group (10 a minute, 1 used), so they cost no more than a write.
    let [input, est] = ask(3, 100);
    let s = sequentialEstimate(est, input);
    expect(s.figures!.limits.find((l) => l.tier === 'write-min')).toEqual({
      tier: 'write-min',
      limit: 120,
      windowMs: 60_000,
      share: 60,
    });
    expect(s.figures!.groups).toEqual([
      { group: 'assets', limit: 20, windowMs: 60_000, steps: 8, ms: 8 * s.pacing!.msPerWrite },
    ]);
    expect(s.pacing!.msPerWrite).toBe(1000); // P3's share of write-min: 60 a minute, as the work needs more than that
    expect(s.wallClockMs).toBe(100 * 1000);

    // 30 images: 62 asset steps need (62 − 9) more of the group's 10 a minute: those steps take that long; the
    // other 38 writes still go at P3's share of 120.
    [input, est] = ask(30, 100);
    s = sequentialEstimate(est, input);
    const groupMs = (62 - 9) * 6000;
    expect(s.figures!.groups).toEqual([
      { group: 'assets', limit: 20, windowMs: 60_000, steps: 62, ms: groupMs },
    ]);
    expect(s.wallClockMs).toBe((100 - 62) * 1000 + groupMs);
  });

  it('uses the measured per-write duration and reports it', async () => {
    const g = await governorWithAssets({ ms: 1500, samples: 200 });
    const input = { reads: 10, writes: 40, priority: 'P3' as const, ops: { createResource: 40 } };
    const s = sequentialEstimate(g.estimate(input), input);
    expect(s.figures!.perWrite).toEqual({
      ms: 1500,
      from: 'measured',
      measuredMs: 1500,
      samples: 200,
      spacingMs: 500,
    });
    expect(s.figures!.groups).toEqual([]);
    expect(s.pacing).toEqual({ msPerWrite: 1500, msPerRead: 0 });
    expect(s.wallClockMs).toBe(40 * 1500);
  });
});

async function rehearsalSetup(): Promise<string> {
  w = await snapshotsWorld();
  const snaps = w.stack.runtime.snapshots;
  const r = await snaps.full(PROJECT, 'manual');
  const m = (await snaps.manifest(r.snapshotId!))!;
  w.stack.db
    .prepare(
      `INSERT INTO projects (id, name, display_name, is_default, is_sandbox, read_only, settings, created_at, updated_at, verified_at)
       VALUES (?, 'arkona', 'Arkona', 0, 0, 1, '{}', ?, ?, ?)`,
    )
    .run(SOURCE, Date.now(), Date.now(), Date.now());
  const copy: Manifest = {
    ...m,
    id: m.id.replace(/-full-/, '-full-0'),
    project: { id: SOURCE, name: 'arkona' },
  };
  await snaps.writeSnapshot(copy);
  new ProjectStore(w.stack.db).setSandbox(PROJECT, true);
  (w.stack.runtime.projects as unknown as { reload(): void }).reload();
  return copy.id;
}

describe('a rehearsal plan (E5.5)', () => {
  it('names its asset steps, so the learned assets limit paces them only, and says which figures it used', async () => {
    const id = await rehearsalSetup();
    const real = w!.stack.runtime.rehearsals as unknown as { d: RehearsalDeps };
    const asked: PlanEstimateInput[] = [];
    // A governor that has learned the asset routes' 20 a minute and measured 1.5 s a write.
    const stub: RehearsalDeps = {
      ...real.d,
      projects: {
        ...real.d.projects,
        find: (r) => real.d.projects.find(r),
        list: () => real.d.projects.list(),
        client: () => ({
          governor: {
            estimate: (i) => {
              asked.push(i);
              const assetSteps = (i.ops?.createAssetFolder ?? 0) + (i.ops?.createImageUpload ?? 0) * 2;
              return {
                wallClockMs: 1000,
                fitsToday: true,
                tightestTier: 'pacing',
                pacingMs: i.writes * 1500,
                tiers: [
                  {
                    tier: 'write-min',
                    limit: 120,
                    windowMs: 60_000,
                    demand: i.writes,
                    capacityPerWindow: 60_000,
                  },
                ],
                operationTiers: [
                  {
                    group: 'assets',
                    limit: 20,
                    windowMs: 60_000,
                    demand: assetSteps,
                    capacityPerWindow: 10,
                    timeMs: 600_000,
                  },
                ],
                perWrite: {
                  ms: 1500,
                  source: 'measured',
                  spacingMs: 500,
                  measured: { ms: 1500, samples: 200 },
                },
              };
            },
          },
        }),
      },
    };
    const { plan } = await new Rehearsals(stub).plan({
      targetProject: 'test',
      snapshotId: id,
      mode: 'sampled',
      max: 10,
    });
    const n = plan.images;
    expect(n).toBeGreaterThan(0);
    expect(asked[0]).toMatchObject({ priority: 'P3', ops: rehearsalOps(n) });
    const e = plan.estimate;
    expect(e.pacing).toEqual({ msPerWrite: 1500, msPerRead: 0 });
    expect(e.figures!.perWrite).toMatchObject({ ms: 1500, from: 'measured', samples: 200, spacingMs: 500 });
    expect(e.figures!.limits).toEqual([{ tier: 'write-min', limit: 120, windowMs: 60_000, share: 60_000 }]);
    const steps = 2 + 2 * n; // the folder, the uploads and assets, the folder's delete
    expect(e.figures!.groups).toEqual([{ group: 'assets', limit: 20, windowMs: 60_000, steps, ms: 600_000 }]);
    expect(e.wallClockMs).toBe((e.writes - steps) * 1500 + 600_000);
  });

  it('with the real governor: the plan carries its figures, and a running rehearsal saves its counts', async () => {
    const id = await rehearsalSetup();
    const rh = w!.stack.runtime.rehearsals;
    const { plan } = await rh.plan({ targetProject: 'test', snapshotId: id, mode: 'sampled', max: 10 });
    // The world's own settings (fast ones): the plan reports whatever the governor runs with.
    const settings = w!.stack.runtime.projects.client(PROJECT)!.governor.settings;
    expect(plan.estimate.figures!.perWrite).toMatchObject({ spacingMs: settings.writeSpacingMs });
    const wm = settings.tierLimits['write-min']!;
    expect(plan.estimate.figures!.limits.find((l) => l.tier === 'write-min')).toMatchObject({
      limit: wm,
      share: wm - Math.ceil(wm * settings.reserveFloors.P3),
    });
    const row = await rh.start({
      targetProject: 'test',
      snapshotId: id,
      mode: 'sampled',
      keep: false,
      by: 'owner',
      max: 10,
    });
    expect(row.estimate).toMatchObject({ figures: expect.any(Object) as unknown });
    const done = (await rh.settled(row.id))!;
    expect(done.state).toBe('succeeded');
    // The last progress saved carries the counts the page compares with the plan.
    expect(done.progress).toMatchObject({ stage: 'compare' });
    expect(typeof done.progress.writes).toBe('number');
    expect(typeof done.progress.reads).toBe('number');
    expect(typeof done.progress.uploads).toBe('number');
  });
});

describe('a restore plan (E5.5)', () => {
  let c: Client;
  it('carries its estimate, and restore_snapshot says it with the per-write figure', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
    const f = w.features.get(w.d.map)!;
    f.splice(0, f.length, ...f.slice(1)); // one feature deleted since
    const r: ToolCall = await w.stack.call(c, 'restore_snapshot', {
      project: 'test',
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: 'Map',
      dryRun: true,
    });
    expect(['dry_run', 'proposal_captured']).toContain(r.body.status);
    expect(r.body.estimate, r.text).toMatchObject({
      writes: expect.any(Number) as unknown,
      about: expect.stringMatching(/^\d+(\.\d)? (s|min)$/) as unknown,
      secondsPerWrite: expect.any(Number) as unknown,
    });
    expect([
      'the configured write spacing',
      expect.stringMatching(/^the median of the last \d+ write steps$/),
    ]).toContainEqual((r.body.estimate as { perWriteFrom: string }).perWriteFrom);
    const plan = await w.stack.runtime.restores.plan({
      projectId: PROJECT,
      pageId: S.atlas,
      snapshotId: snap,
      scope: 'document',
      documentId: w.d.map,
    });
    expect(plan.estimate).toMatchObject({
      writes: plan.steps.filter((s) => !s.op.startsWith('bridge.')).length,
      pacing: expect.any(Object) as unknown,
      figures: expect.any(Object) as unknown,
    });
    expect(plan.estimate!.wallClockMs).not.toBeNull();
  });
});
