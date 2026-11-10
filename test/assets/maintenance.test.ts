/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any) in object literals */
/**
 * v2 A4: the `asset-refresh` (every 6 hours) and `asset-check` (nightly, next to the repository tree's check)
 * maintenance jobs run the asset tree's passes once per served project, at P3, and record what they did truthfully: a
 * run per project, skipped (with the reason) where the asset tree is not built, a failed pass is a failed run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMaintenanceSettings } from '../../src/config/index.js';
import { MaintenanceScheduler, builtinJobs } from '../../src/maintenance/index.js';
import { assetRig, buildAssets, type AssetRig } from './helpers.js';

let rig: AssetRig;
let scheduler: MaintenanceScheduler | undefined;
afterEach(async () => {
  await scheduler?.stop();
  await rig?.close();
});

function mount(): MaintenanceScheduler {
  const s = new MaintenanceScheduler({
    db: rig.i.db,
    engine: rig.i.engine,
    projects: rig.i.projects,
    clock: rig.clock,
    settings: defaultMaintenanceSettings({ enabled: false }),
    jobs: builtinJobs({
      engine: rig.i.engine,
      projects: rig.i.projects,
      db: rig.i.db,
      proposals: { expireDue: () => 0, pruneFinished: () => ({ removed: 0, cutoff: 0 }) },
      proposalRetentionMs: 1,
      expirySweepMs: 300_000,
      assets: rig.i.assets,
    }),
  });
  s.start();
  return s;
}

describe('asset maintenance jobs', () => {
  it('are registered: the refresh every 6 hours, the check nightly after the tree’s (02:30), per project, in the background', async () => {
    rig = await assetRig();
    scheduler = mount();
    expect(scheduler.get('asset-refresh')).toMatchObject({
      implemented: true,
      enabled: true,
      scope: 'project',
      scheduleText: 'Every 6 hours',
      writes: false,
    });
    expect(scheduler.get('asset-check')).toMatchObject({
      implemented: true,
      enabled: true,
      scope: 'project',
      scheduleText: 'Daily at 02:50 (London time)',
    });
  });

  it('run once per project, and say why they skipped one', async () => {
    rig = await assetRig({ projects: ['alpha', 'beta'] });
    const a = rig.p.alpha!;
    const b = rig.p.beta!;
    const w = a.model.testWorld();
    b.model.testWorld();
    await buildAssets(rig, 'alpha');
    scheduler = mount();

    a.model.outsideRename(w.maps, 'Starter maps');
    await rig.settle(scheduler.runNow('asset-refresh').done);
    const byProject = Object.fromEntries(scheduler.history('asset-refresh', 10).map((r) => [r.projectId, r]));
    expect(byProject[a.id]).toMatchObject({
      outcome: 'succeeded',
      detail: expect.stringMatching(/1 corrected/),
    });
    expect(byProject[b.id]).toMatchObject({
      outcome: 'skipped',
      detail: 'Skipped: the asset tree is not built yet.',
    });
    // A run that corrected something is a job of its project (the Jobs page); the skip is only in the history.
    expect(byProject[a.id]!.engineJobId).toEqual(expect.any(String));
    expect(byProject[b.id]!.engineJobId).toBeNull();
    expect(rig.i.assets.store.lastPass(a.id, 'refresh')).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
    });
    expect(b.model.listCalls).toHaveLength(0); // the unbuilt project cost nothing

    // A run that changed nothing leaves no job record (it runs every 6 hours).
    await rig.settle(scheduler.runNow('asset-refresh').done);
    expect(scheduler.history('asset-refresh', 1, a.id)[0]).toMatchObject({
      outcome: 'succeeded',
      engineJobId: null,
    });

    await rig.settle(scheduler.runNow('asset-check').done);
    expect(scheduler.history('asset-check', 10, a.id)[0]).toMatchObject({
      outcome: 'succeeded',
      engineJobId: expect.any(String), // the check is always recorded
    });
    expect(rig.i.assets.store.lastPass(a.id, 'check')).toMatchObject({ status: 'succeeded' });
  }, 60_000);

  it('a failed pass is a failed run', async () => {
    rig = await assetRig();
    const a = rig.p.alpha!;
    a.model.testWorld();
    await buildAssets(rig, 'alpha');
    scheduler = mount();
    a.model.listFailures.set(null, { status: 403, code: 'FORBIDDEN', times: 1 });
    await rig.settle(scheduler.runNow('asset-check').done);
    expect(scheduler.history('asset-check', 1, a.id)[0]).toMatchObject({
      outcome: 'failed',
      detail: expect.stringMatching(/root could not be listed/),
    });
    // The asset tree was kept as it was.
    expect(rig.i.assets.queries.counts(a.id).data).toMatchObject({ folders: 18, assets: 559 });
  }, 60_000);

  it('without the asset tree the jobs skip, saying so', async () => {
    rig = await assetRig();
    scheduler = new MaintenanceScheduler({
      db: rig.i.db,
      engine: rig.i.engine,
      projects: rig.i.projects,
      clock: rig.clock,
      settings: defaultMaintenanceSettings({ enabled: false }),
      jobs: builtinJobs({
        engine: rig.i.engine,
        projects: rig.i.projects,
        db: rig.i.db,
        proposals: { expireDue: () => 0, pruneFinished: () => ({ removed: 0, cutoff: 0 }) },
        proposalRetentionMs: 1,
        expirySweepMs: 300_000,
      }),
    });
    scheduler.start();
    await rig.settle(scheduler.runNow('asset-refresh').done);
    expect(scheduler.history('asset-refresh', 1)[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'Skipped: the asset tree is not running.',
    });
  }, 60_000);
});
