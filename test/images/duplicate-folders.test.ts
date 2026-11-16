/**
 * v3 F2 (ADR 0049 decision 9): the audit finding for duplicate asset folders (sibling folders with exactly the same
 * name) and its fix: the later duplicates' assets moved into the earliest, matched folder by folder, then the emptied
 * duplicates deleted, deepest first, in ONE proposal. A duplicate that still holds something is left alone; a same-named
 * asset is moved, never deleted; a folder that is not empty when the job runs is not deleted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { duplicateFoldersCheck, planMerge, type AssetLibrary } from '../../src/audits/checks/assets.js';
import { proposeFix } from '../../src/audits/fixes.js';
import type { Finding } from '../../src/audits/types.js';
import { assetLibraryOf } from '../../src/assets/library.js';
import { PROJECT } from '../tools/helpers.js';
import { imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const lib: AssetLibrary = {
  folders: [
    { id: 'fa', name: 'Newcomer', parentId: 'q', path: ['Q', 'Newcomer'], createdAt: 1 },
    { id: 'fb', name: 'Newcomer', parentId: 'q', path: ['Q', 'Newcomer'], createdAt: 2 },
    { id: 'fa1', name: 'Art', parentId: 'fa', path: ['Q', 'Newcomer', 'Art'], createdAt: 1 },
    { id: 'fb1', name: 'Art', parentId: 'fb', path: ['Q', 'Newcomer', 'Art'], createdAt: 2 },
    { id: 'fc', name: 'Newcomer', parentId: 'q', path: ['Q', 'Newcomer'], createdAt: 3 },
    { id: 'fc1', name: 'Only here', parentId: 'fc', path: ['Q', 'Newcomer', 'Only here'], createdAt: 3 },
    { id: 'fx', name: 'newcomer', parentId: 'q', path: ['Q', 'newcomer'], createdAt: 4 },
  ],
  items: [
    { id: 'i1', name: 'Portrait', folderId: 'fa' },
    { id: 'i2', name: 'Portrait', folderId: 'fb' },
    { id: 'i3', name: 'Sketch', folderId: 'fb1' },
    { id: 'i4', name: 'Map', folderId: 'fc' },
  ],
};

describe('the finding', () => {
  it('reports each set of exact-name siblings with paths and asset counts; case differs is not a duplicate', () => {
    const out = duplicateFoldersCheck({ assetLibrary: lib } as never);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: 'duplicate_asset_folders',
      evidence: {
        name: 'Newcomer',
        folders: [
          { id: 'fa', assets: 1, earliest: true },
          { id: 'fb', assets: 2, earliest: false },
          { id: 'fc', assets: 1, earliest: false },
        ],
      },
      fix: { kind: 'merge_asset_folders' },
    });
  });

  it('the plan: moves folder by folder, deletes deepest first, keeps a duplicate that would still hold something', () => {
    const p = planMerge(lib, 'fa', ['fb', 'fc']);
    expect(p.moves.map((m) => [m.assetId, m.toId])).toEqual([
      ['i2', 'fa'],
      ['i3', 'fa1'],
      ['i4', 'fa'],
    ]);
    expect(p.sameNames).toEqual(['Q / Newcomer / Portrait']);
    expect(p.deletes.map((d) => d.folderId)).toEqual(['fb1', 'fb']);
    expect(p.kept).toEqual([expect.objectContaining({ folderId: 'fc' })]);
  });
});

describe('the fix, against the mock', () => {
  it('moves, then deletes deepest first; same-named assets are moved, never deleted; a folder filled since is kept', async () => {
    w = await imagesWorld();
    const parent = w.assets.at('Characters', 'Beastkin', 'Qishen');
    const c = await w.stack.connect();
    const write = async (operationId: string, params: Record<string, unknown>) =>
      (await w!.stack.call(c, 'lk_api_write', { project: 'test', operationId, params })).body as {
        result?: { id?: string };
      };
    // A raw createAssetFolder keeps its plain meaning: two chains of the same names.
    const a = (await write('createAssetFolder', { body: { name: 'Twin', folderId: parent } })).result!.id!;
    const b = (await write('createAssetFolder', { body: { name: 'Twin', folderId: parent } })).result!.id!;
    const b1 = (await write('createAssetFolder', { body: { name: 'Art', folderId: b } })).result!.id!;
    const a1 = (await write('createAssetFolder', { body: { name: 'Art', folderId: a } })).result!.id!;
    let n = 0;
    const put = (name: string, folderId: string) => {
      const id = `imgdup${String(++n).padStart(2, '0')}`;
      w!.assets.assets.set(id, { id, name, type: 'IMAGE', folderId, isHidden: false } as never);
      return id;
    };
    const pa = put('Portrait', a);
    const pb = put('Portrait', b);
    const sk = put('Sketch', b1);
    await w.stack.runtime.assets.refresh(PROJECT, 'test');
    const library = assetLibraryOf(w.stack.runtime.assets, PROJECT)!;
    const draft = duplicateFoldersCheck({ assetLibrary: library } as never).find(
      (f) => (f.evidence as { name: string }).name === 'Twin',
    )!;
    expect(draft).toBeDefined();
    const finding = { ...draft, id: 1, state: 'open', pageName: null } as unknown as Finding;
    const r = await proposeFix(
      { engine: w.stack.runtime.engine as never, now: () => Date.now() },
      PROJECT,
      finding,
      { propertiesName: 'PROPERTIES' },
    );
    expect(r.status).toBe('proposal_captured');
    const id = (r as { proposalId: string }).proposalId;
    const pol = w.stack.runtime.policy;
    expect(pol.proposals.get(id)!.summary).toMatch(/moved anyway, never deleted/);
    // Someone files a new image in the later "Art" after the plan: that folder is then kept.
    put('Late', b1);
    await pol.commands.approve('owner', id);
    for (
      let i = 0;
      i < 300 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
      i++
    )
      await new Promise((res) => setTimeout(res, 20));
    expect(pol.proposals.get(id)!.state).toBe('executed');
    const at = (x: string) => w!.assets.assets.get(x)?.folderId;
    expect([at(pa), at(pb), at(sk)]).toEqual([a, a, a1]);
    expect(w.assets.assets.has(pb)).toBe(true); // same name: moved, never deleted
    expect(w.assets.assets.has(b1)).toBe(true); // not empty when the job ran: kept
    expect(w.assets.assets.has(b)).toBe(true); // its child was kept, so it is not empty: kept too

    // Once the late image is filed elsewhere, the next audit's fix deletes the emptied duplicates, deepest first.
    const late = [...w.assets.assets.values()].find((x) => x.name === 'Late')!;
    late.folderId = a1;
    await w.stack.runtime.assets.refresh(PROJECT, 'test');
    const again = duplicateFoldersCheck({
      assetLibrary: assetLibraryOf(w.stack.runtime.assets, PROJECT)!,
    } as never).find((f) => (f.evidence as { name: string }).name === 'Twin')!;
    expect((again.fix!.args as { deletes: { folderId: string }[] }).deletes.map((d) => d.folderId)).toEqual([
      b1,
      b,
    ]);
    const r2 = await proposeFix(
      { engine: w.stack.runtime.engine as never, now: () => Date.now() },
      PROJECT,
      { ...again, id: 2, state: 'open', pageName: null } as unknown as Finding,
      { propertiesName: 'PROPERTIES' },
    );
    const id2 = (r2 as { proposalId: string }).proposalId;
    await pol.commands.approve('owner', id2);
    for (
      let i = 0;
      i < 300 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id2)!.state);
      i++
    )
      await new Promise((res) => setTimeout(res, 20));
    expect(pol.proposals.get(id2)!.state).toBe('executed');
    expect(w.assets.assets.has(b1)).toBe(false);
    expect(w.assets.assets.has(b)).toBe(false);
    expect(w.assets.assets.has(a)).toBe(true);
  });
});
