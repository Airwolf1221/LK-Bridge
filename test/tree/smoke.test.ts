import { afterEach, describe, expect, it } from 'vitest';
import { build, expectTreeMatchesModel, treeRig, type TreeRig } from './helpers.js';
import { seedWorld } from './model.js';

let rig: TreeRig;
afterEach(async () => rig?.close());

describe('smoke', () => {
  it('builds a small tree', async () => {
    rig = await treeRig();
    const { rootId } = seedWorld(rig.p.alpha!.model, { nodes: 40, depth: 4, outside: 3, unclassified: 2 });
    rig.setRoot('alpha', rootId);
    await build(rig, 'alpha');
    expectTreeMatchesModel(rig, 'alpha', { withProps: true });
    expect(rig.i.tree.meta(rig.p.alpha!.id).status).toBe('ready');
  });
});
