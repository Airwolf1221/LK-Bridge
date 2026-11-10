/**
 * v2 A4: the asset tree's query layer: a folder by id or path, children, the subtree, assets in a folder, and exact-name
 * lookups that return ALL matches. Answers come from the stored model (no request) and state its status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetRig, buildAssets, seenAt, type AssetRig } from './helpers.js';
import type { World } from './model.js';

let rig: AssetRig;
let w: World;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const q = () => rig.i.assets.queries;

beforeEach(async () => {
  rig = await assetRig();
  w = P().model.testWorld();
  await buildAssets(rig, 'alpha');
});

describe('folders by id and by path', () => {
  it('answers a folder by id, with its place', () => {
    const a = q().folder(P().id, w.mehrana);
    expect(a.tree).toMatchObject({ status: 'ready', projectId: P().id });
    expect(a.data).toMatchObject({ id: w.mehrana, name: 'Mehrana al-Khalid', parentId: w.qishen, depth: 4 });
    expect(a.data!.path.names).toEqual(['Characters', 'Beastkin', 'Qishen', 'Mehrana al-Khalid']);
    expect(a.data!.path.ids).toEqual([w.characters, w.beastkin, w.qishen, w.mehrana]);
    expect(q().folder(P().id, 'nope').data).toBeNull();
    expect(q().folder(P().id, P().model.byName('Mehrana 001')[0]!.id).data).toBeNull(); // an asset is not a folder
  });

  it('follows a path of names from the root, exactly, ignoring case unless asked', () => {
    expect(
      q()
        .foldersByPath(P().id, ['Characters', 'Beastkin', 'Qishen', 'Mehrana al-Khalid'])
        .data.map((f) => f.id),
    ).toEqual([w.mehrana]);
    expect(
      q()
        .foldersByPath(P().id, ['characters', 'BEASTKIN'])
        .data.map((f) => f.id),
    ).toEqual([w.beastkin]);
    expect(q().foldersByPath(P().id, ['characters', 'BEASTKIN'], { caseSensitive: true }).data).toEqual([]);
    expect(q().foldersByPath(P().id, ['Characters', 'Nobody']).data).toEqual([]);
    expect(q().foldersByPath(P().id, ['Beastkin']).data).toEqual([]); // paths start at the root
    expect(q().foldersByPath(P().id, []).data).toEqual([]);
    // The same name inside Recovery originals is another folder.
    expect(
      q()
        .foldersByPath(P().id, ['Recovery originals 2026-11', 'Characters'])
        .data.map((f) => f.id),
    ).toEqual([w.recoveryCharacters]);
  });

  it('returns every chain when a path is ambiguous', () => {
    const twin = P().model.folder('Beastkin', w.characters);
    return rig.settle(rig.i.assets.refresh(P().id, 'manual')).then(() => {
      expect(
        q()
          .foldersByPath(P().id, ['Characters', 'Beastkin'])
          .data.map((f) => f.id)
          .sort(),
      ).toEqual([w.beastkin, twin].sort());
    });
  });

  it('gives the ancestors of a folder, top first', () => {
    expect(
      q()
        .path(P().id, w.inae)
        .data.map((f) => f.name),
    ).toEqual(['Characters', 'Elves', 'Moon Elves', 'Inae Mikumo']);
    expect(q().path(P().id, 'nope').data).toEqual([]);
  });
});

describe('children, assets and the subtree', () => {
  it('lists a folder’s subfolders by name, and the root’s', () => {
    expect(
      q()
        .children(P().id, null)
        .data.map((f) => f.name),
    ).toEqual(['Characters', 'Maps to get started', 'Recovery originals 2026-11']);
    expect(
      q()
        .children(P().id, w.characters)
        .data.map((f) => f.name),
    ).toEqual(['Beastkin', 'Dwarves', 'Elves', 'Humans', 'Outsiders', 'Undetermined / Unknown']);
    expect(q().children(P().id, w.mehrana).data).toEqual([]);
  });

  it('lists the assets in a folder, paged, by type', () => {
    const all = q().assetsIn(P().id, w.recovery).data;
    expect(all.total).toBe(260);
    expect(all.assets).toHaveLength(260);
    expect(all.assets[0]).toMatchObject({
      name: 'Original 001',
      folderId: w.recovery,
      type: 'IMAGE',
      sha256: null,
      size: null,
    });
    const page = q().assetsIn(P().id, w.recovery, { limit: 50, offset: 250 }).data;
    expect(page.assets.map((a) => a.name)).toEqual(all.assets.slice(250).map((a) => a.name));
    expect(page.total).toBe(260);
    expect(q().assetsIn(P().id, w.recovery, { types: ['MAP'] }).data).toEqual({ assets: [], total: 0 });
    expect(q().assetsIn(P().id, null).data.total).toBe(6); // the root's own assets
  });

  it('gives the subtree, depth first with siblings by name, to a depth', () => {
    const all = q().subtree(P().id, null).data;
    expect(all.folders).toHaveLength(18);
    expect(all.truncated).toBe(false);
    expect(all.folders[0]).toMatchObject({ relativeDepth: 1 });
    expect(all.folders[0]!.folder.name).toBe('Characters');
    // A folder comes before everything inside it.
    const names = all.folders.map((e) => e.folder.name);
    expect(names.indexOf('Characters')).toBeLessThan(names.indexOf('Beastkin'));
    expect(names.indexOf('Beastkin')).toBeLessThan(names.indexOf('Qishen'));
    expect(names.indexOf('Qishen')).toBeLessThan(names.indexOf('Mehrana al-Khalid'));
    expect(names.indexOf('Foxians')).toBeLessThan(names.indexOf('Qishen')); // siblings by name
    const sub = q().subtree(P().id, w.characters).data;
    expect(sub.folders.map((e) => e.folder.name)).not.toContain('Characters'); // the top itself is not listed
    expect(sub.folders).toHaveLength(13);
    expect(sub.folders.every((e) => e.relativeDepth >= 1)).toBe(true);
    expect(q().subtree(P().id, w.characters, { maxDepth: 1 }).data.folders).toHaveLength(6);
    expect(
      q()
        .subtree(P().id, w.characters, { maxDepth: 2 })
        .data.folders.map((e) => e.relativeDepth),
    ).toContain(2);
    const cut = q().subtree(P().id, null, { limit: 5 }).data;
    expect(cut.folders).toHaveLength(5);
    expect(cut.truncated).toBe(true);
    expect(q().subtree(P().id, 'nope').data).toEqual({ folders: [], truncated: false });
  });
});

describe('exact names return ALL matches', () => {
  it('finds a folder name wherever it is, every match, with paths', () => {
    const r = q().findFoldersByName(P().id, 'Characters').data;
    expect(r.map((f) => f.path.names.join(' / '))).toEqual([
      'Characters',
      'Recovery originals 2026-11 / Characters',
    ]);
    expect(q().findFoldersByName(P().id, 'characters').data).toHaveLength(2); // case ignored
    expect(q().findFoldersByName(P().id, 'characters', { caseSensitive: true }).data).toHaveLength(0);
    expect(q().findFoldersByName(P().id, 'Chars').data).toEqual([]); // no partial or fuzzy matching
    expect(
      q()
        .findFoldersByName(P().id, 'Characters', { withinFolderId: w.recovery })
        .data.map((f) => f.id),
    ).toEqual([w.recoveryCharacters]);
    expect(
      q()
        .findFoldersByName(P().id, 'Undetermined / Unknown')
        .data.map((f) => f.id),
    ).toEqual([w.unknown]);
  });

  it('finds assets by name, in one folder or anywhere, and never returns folders', () => {
    expect(
      q()
        .findAssetsByName(P().id, 'Mehrana 001')
        .data.map((a) => a.folderId),
    ).toEqual([w.mehrana]);
    expect(q().findAssetsByName(P().id, 'Mehrana 001', { folderId: w.qishen }).data).toEqual([]);
    expect(q().findAssetsByName(P().id, 'Loose image 001', { folderId: null }).data).toHaveLength(1);
    expect(q().findAssetsByName(P().id, 'Characters').data).toEqual([]); // folders are not assets
  });

  it('every answer names the status, and a tree not built says so', async () => {
    expect(q().counts(P().id)).toMatchObject({
      tree: { status: 'ready' },
      data: { folders: 18, assets: 559, maxDepth: 4 },
    });
    const other = await assetRig({ projects: ['beta'] });
    try {
      const a = other.i.assets.queries.children(other.p.beta!.id, null);
      expect(a.tree).toMatchObject({ status: 'not_built' });
      expect(a.data).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('costs no LegendKeeper request', () => {
    const before = P().mock.calls.length;
    q().folder(P().id, w.mehrana);
    q().foldersByPath(P().id, ['Characters']);
    q().subtree(P().id, null);
    q().findFoldersByName(P().id, 'Characters');
    q().assetsIn(P().id, w.recovery);
    expect(P().mock.calls.length).toBe(before);
    expect(seenAt(rig, 'alpha', 'GET', /.*/)).toBe(before);
  });
});
