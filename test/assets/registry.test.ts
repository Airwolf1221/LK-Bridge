/**
 * v2 A4 + A3: on the real bridge, the planner takes the asset root folder name, the Characters index and the unknown-race
 * folder from the project's `character` type in A3's type registry, and falls back to the old bridge's literals when the
 * project has no such type. The folder labels still come from the character page's real ancestry in the tree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startAdminStack, until, type AdminStack } from '../admin/helpers.js';
import { TreeModel } from '../tree/model.js';
import { AssetModel } from './model.js';

let stack: AdminStack | undefined;
afterEach(async () => stack?.close());

async function start() {
  const assets = new AssetModel(() => Date.now());
  const repo = new TreeModel(() => Date.now());
  const root = repo.seed({ name: 'AI REPOSITORY', parentId: null });
  const chars = repo.seed({ name: '[INDEX] Characters', parentId: root.id });
  const beastkin = repo.seed({ name: '[INDEX] Beastkin', parentId: chars.id });
  const foxians = repo.seed({ name: '[INDEX] Foxians', parentId: beastkin.id });
  repo.seed({
    name: '[BSRC] Kitsu',
    parentId: foxians.id,
    referenceType: 'Compact Character Reference',
  });
  // The library already has the root folder the registry will name, and one with the old name.
  assets.folder('Characters');
  const dramatis = assets.folder('Dramatis Personae');
  assets.folder('Beastkin', dramatis);

  stack = await startAdminStack({ respond: (req) => assets.respond(req) ?? repo.respond(req) });
  await until(() => stack!.runtime.projects.activeIds().length === 1);
  const project = stack.runtime.projects.defaultProject();
  const id = project.id!;
  const put = await stack.put(`/api/admin/projects/${project.name}/settings`, {
    key: 'aiRepositoryRootId',
    value: root.id,
  });
  expect(put.status).toBe(200);
  const { tree, assets: svc } = stack.runtime;
  tree.prepareBuild(id, { trigger: 'test', autoConfirm: true });
  await until(() => tree.store.activePass(id) === undefined, 15_000);
  svc.prepareBuild(id, { trigger: 'test', autoConfirm: true });
  await until(() => svc.store.activePass(id) === undefined, 15_000);
  expect(svc.meta(id).status).toBe('ready');
  return {
    id,
    svc,
    chars: chars.id,
    kitsu: [...repo.res.values()].find((r) => r.name === '[BSRC] Kitsu')!.id,
  };
}

describe('the planner and A3’s type registry', () => {
  it('unset: no character type, so the literal “Characters” (the Characters index found by name)', async () => {
    const { id, svc } = await start();
    expect(stack!.runtime.registry.forProject(id).store.listTypes()).toEqual([]);
    const r = svc.plan(id, { characterName: 'Kitsu' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map((s) => `${s.action} ${s.name}`)).toEqual([
      'reuse Characters',
      'create Beastkin',
      'create Foxians',
      'create Kitsu',
    ]);
  }, 60_000);

  it('set: the character type’s asset root folder, root index and unknown-race index are used', async () => {
    const { id, svc, chars, kitsu } = await start();
    stack!.runtime.registry.forProject(id).commands.createType('owner', {
      singular: 'Character',
      plural: 'Characters',
      rootIndexId: chars,
      assetRootFolder: 'Dramatis Personae',
      placementKind: 'character',
      placement: { unknownIndexName: 'Race Unknown' },
    });
    const r = svc.plan(id, { characterResourceId: kitsu });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The root folder is the registry's, found in the library; the labels are the page's real ancestry.
    expect(r.plan.steps.map((s) => `${s.action} ${s.name}`)).toEqual([
      'reuse Dramatis Personae',
      'reuse Beastkin',
      'create Foxians',
      'create Kitsu',
    ]);
    expect(r.plan.character).toMatchObject({
      group: 'Beastkin',
      race: 'Foxians',
      raceSource: 'page_ancestry',
    });
    const unknown = svc.plan(id, { characterName: 'Nobody Known' });
    expect(unknown.ok && unknown.plan.destination.path).toEqual([
      'Dramatis Personae',
      'Race Unknown',
      'Nobody Known',
    ]);
  }, 60_000);

  it('set to nothing: a type with no asset root folder falls back to “Characters”', async () => {
    const { id, svc, chars } = await start();
    const types = stack!.runtime.registry.forProject(id);
    const t = types.commands.createType('owner', {
      singular: 'Character',
      plural: 'Characters',
      rootIndexId: chars,
      placementKind: 'character',
    });
    types.commands.updateType('owner', t.id, { assetRootFolder: null });
    const r = svc.plan(id, { characterName: 'Kitsu' });
    expect(r.ok && r.plan.steps[0]).toMatchObject({ name: 'Characters', action: 'reuse' });
  }, 60_000);
});
