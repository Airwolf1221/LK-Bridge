/* eslint-disable @typescript-eslint/no-unsafe-assignment -- asymmetric matchers (expect.any) in object literals */
/**
 * v2 A2: the `tree-sweep` and `tree-check` maintenance jobs (replacing chunk 6's `tree-snapshot` placeholder) run the
 * tree's passes once per served project, at P3, and record what they did truthfully: a run per project, skipped
 * (with the reason) where the tree is not configured or the sweep is switched off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMaintenanceSettings } from '../../src/config/index.js';
import { MaintenanceScheduler, builtinJobs } from '../../src/maintenance/index.js';
import { build, treeRig, type TreeRig } from './helpers.js';
import { seedWorld } from './model.js';

let rig: TreeRig;
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
      tree: rig.i.tree,
    }),
  });
  s.start();
  return s;
}

describe('tree maintenance jobs', () => {
  it('run once per project, and say why they skipped one', async () => {
    rig = await treeRig({ projects: ['alpha', 'beta'] });
    const a = rig.p.alpha!;
    const b = rig.p.beta!;
    const { rootId } = seedWorld(a.model, { nodes: 30, depth: 3 });
    rig.setRoot('alpha', rootId);
    await build(rig, 'alpha');
    scheduler = mount();

    a.model.outside.rename(a.model.children(rootId)[0]!.id, '[INDEX] Renamed outside');
    const sweep = await rig.settle(scheduler.runNow('tree-sweep').done);
    expect(sweep).not.toBeNull();
    const runs = scheduler.history('tree-sweep', 10);
    const byProject = Object.fromEntries(runs.map((r) => [r.projectId, r]));
    expect(byProject[a.id]).toMatchObject({
      outcome: 'succeeded',
      detail: expect.stringMatching(/1 corrected/),
    });
    expect(byProject[b.id]).toMatchObject({
      outcome: 'skipped',
      detail: 'Skipped: no AI REPOSITORY root is set for this project.',
    });
    // A run that corrected something is a job of its project (the Jobs page); the skip is only in the history.
    expect(byProject[a.id]!.engineJobId).toEqual(expect.any(String));
    expect(byProject[b.id]!.engineJobId).toBeNull();
    expect(rig.i.tree.store.lastPass(a.id, 'sweep')).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
    });

    rig.setSetting('alpha', 'treeSweepEnabled', false);
    await rig.settle(scheduler.runNow('tree-sweep').done);
    expect(scheduler.history('tree-sweep', 10, a.id)[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'Skipped: the hourly sweep is switched off for this project.',
    });

    await rig.settle(scheduler.runNow('tree-check').done);
    expect(scheduler.history('tree-check', 10, a.id)[0]).toMatchObject({ outcome: 'succeeded' });
    expect(rig.i.tree.store.lastPass(a.id, 'check')).toMatchObject({ status: 'succeeded', readOk: 31 });
    expect(scheduler.get('tree-check')).toMatchObject({ implemented: true, scope: 'project' });
  }, 60_000);

  it('a failed pass is a failed run', async () => {
    rig = await treeRig();
    const a = rig.p.alpha!;
    const { rootId } = seedWorld(a.model, { nodes: 10, depth: 3 });
    rig.setRoot('alpha', rootId);
    await build(rig, 'alpha');
    scheduler = mount();
    a.model.outside.delete(rootId);
    await rig.settle(scheduler.runNow('tree-sweep').done);
    expect(scheduler.history('tree-sweep', 1, a.id)[0]).toMatchObject({
      outcome: 'failed',
      detail: expect.stringMatching(/root .* is gone/),
    });
    // The tree was kept as it was.
    expect(rig.i.tree.queries.counts(a.id).data.total).toBe(11);
  }, 60_000);
});
