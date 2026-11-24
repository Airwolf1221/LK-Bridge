/**
 * v3 F9 (ADR 0074): the classes the repository tree's and the asset tree's passes ask for, split by request.
 *
 * Bulk (P4): the tree build's and nightly check's reading of every node; every asset pass (build, the regular refresh,
 * the nightly check: each walks the whole library). Routine (P3): every tree listing (finding what changed), the hourly
 * tree sweep (new and stale nodes only). The re-reads after a bridge write are never bulk.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ASSET_PASS_PRIORITY } from '../../src/assets/service.js';
import { passPriority } from '../../src/tree/service.js';
import { assetRig, buildAssets, origin as assetOrigin, type AssetRig } from '../assets/helpers.js';
import { build, origin as treeOrigin, treeRig, type TreeRig } from '../tree/helpers.js';
import { seedWorld } from '../tree/model.js';
import { recordClasses } from './priority-spy.js';

describe('the repository tree (src/tree/service.ts)', () => {
  let rig: TreeRig | undefined;
  afterEach(async () => {
    await rig?.close();
    rig = undefined;
  });

  it('passPriority: the build’s and the check’s reads are P4; every listing and the sweep are P3', () => {
    expect(passPriority('build', 'read')).toBe('P4');
    expect(passPriority('check', 'read')).toBe('P4');
    expect(passPriority('sweep', 'read')).toBe('P3');
    for (const k of ['build', 'sweep', 'check'] as const) expect(passPriority(k, 'list')).toBe('P3');
  });

  it('the build and the nightly check read every node at P4 and list at P3; the sweep is all P3', async () => {
    rig = await treeRig();
    const r = rig;
    const P = r.p.alpha!;
    const { rootId } = seedWorld(P.model, { nodes: 40, depth: 3 });
    r.setRoot('alpha', rootId);
    const spy = recordClasses(r.i.clients.alpha!.governor);
    await build(r, 'alpha');
    expect(spy.classes('getResource')).toEqual(['P4']);
    expect(spy.classes('listResources')).toEqual(['P3']);

    spy.reset();
    await r.settle(r.i.tree.check(P.id));
    expect(spy.classes('getResource')).toEqual(['P4']);
    expect(spy.classes('listResources')).toEqual(['P3']);

    spy.reset();
    P.model.outside.create('[BSRC] Made in the app', rootId);
    await r.settle(r.i.tree.sweep(P.id));
    expect(spy.seen.length).toBeGreaterThan(0);
    expect(spy.classes()).toEqual(['P3']);

    // The re-read after a bridge write is routine (it goes with the write's job, never at P4).
    spy.reset();
    const leaf = [...P.model.res.values()].find((x) => x.parentId === rootId && x.deletedAt === null)!;
    await r.settle(
      r.i.engine.run(
        'updateResource',
        { path: { resourceId: leaf.id }, body: { name: `${leaf.name} (renamed)` } },
        { project: P.id, origin: treeOrigin },
      ),
    );
    expect(spy.seen.some((s) => s.opId === 'getResource')).toBe(true);
    expect(spy.classes()).not.toContain('P4');
    spy.restore();
  });
});

describe('the asset tree (src/assets/service.ts)', () => {
  let rig: AssetRig | undefined;
  afterEach(async () => {
    await rig?.close();
    rig = undefined;
  });

  it('every pass (build, refresh, check) walks the library at P4; a re-read after a bridge write is not P4', async () => {
    expect(ASSET_PASS_PRIORITY).toBe('P4');
    rig = await assetRig();
    const r = rig;
    const P = r.p.alpha!;
    const w = P.model.testWorld();
    const spy = recordClasses(r.i.clients.alpha!.governor);
    await buildAssets(r, 'alpha');
    expect(spy.classes('listAssets')).toEqual(['P4']);

    for (const pass of ['refresh', 'check'] as const) {
      spy.reset();
      await r.settle(r.i.assets[pass](P.id, 'manual'));
      expect(spy.seen.length).toBeGreaterThan(0);
      expect(spy.classes()).toEqual(['P4']);
    }

    spy.reset();
    await r.settle(
      r.i.engine.run(
        'createAssetFolder',
        { body: { name: 'Gnomes', folderId: w.characters } },
        { project: P.id, origin: assetOrigin },
      ),
    );
    expect(spy.seen.some((s) => s.opId === 'getAsset')).toBe(true);
    expect(spy.classes()).not.toContain('P4');
    spy.restore();
  });
});
