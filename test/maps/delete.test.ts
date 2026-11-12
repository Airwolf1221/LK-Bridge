/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * delete_map_feature (v2 D2, ADR 0040), against the mock map world: `confirm: true`; a folder with features refused unless
 * `cascade: true`; a cascade deletes the features first (deepest first: LegendKeeper leaves a folder's features in place),
 * lists everything it removed and keeps every removed feature in full in the journal; a cascade that stops part-way is
 * resumed by asking again, never replayed.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { mapsWorld, type MapsWorld } from './world.js';

let w: MapsWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const ARKONA = { page: 'Atlas of Arkona', document: 'Arkona map' };
const del = (args: Record<string, unknown>, doc: Record<string, unknown> = ARKONA) =>
  call('delete_map_feature', { ...doc, confirm: true, ...args });
const exists = (id: string, doc = w.md.map) => w.features(doc).some((f) => f.id === id);
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const costs: Record<string, { reads: number; writes: number }> = {};
const journal = (jobId: string) =>
  w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId, includePreImage: true, limit: 50 });

beforeAll(async () => {
  w = await mapsWorld();
  client = await w.stack.connect();
});
afterAll(async () => {
  console.log('MAP DELETE COSTS', JSON.stringify(costs));
  await w.close();
});

describe('a single feature', () => {
  it('needs confirm: true', async () => {
    const before = writes().length;
    const r = await call('delete_map_feature', { ...ARKONA, feature: 'Secret' });
    expect(r.isError).toBe(true);
    const no = await call('delete_map_feature', { ...ARKONA, feature: 'Secret', confirm: false });
    expect(no.isError).toBe(true);
    expect(writes().length).toBe(before);
    expect(exists(w.f.Secret!)).toBe(true);
  });

  it('deletes a pin, verified, and keeps it in full as the journal’s pre-image', async () => {
    const was = w.features(w.md.map).find((f) => f.id === w.f.Secret)!;
    const done = w.mark();
    const r = await del({ feature: 'Secret' });
    costs.delete_pin = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      removedCount: 1,
      removed: [{ id: w.f.Secret, type: 'pin', name: 'Secret' }],
    });
    expect(exists(w.f.Secret!)).toBe(false);
    const e = journal(String(r.body.jobId)).find((x) => x.opId === 'deleteFeature')!;
    expect(e.preImage).toMatchObject({
      id: was.id,
      name: 'Secret',
      pos: was.pos,
      isHidden: true,
      rank: was.rank,
    });
    expect(JSON.stringify(e)).toContain('delete_map_feature');
  });

  it('is identified like update does: by id, or by name plus folder; an ambiguous name is refused', async () => {
    const amb = await del({ feature: 'Inn' });
    expect(amb.body.error?.code).toBe('FEATURE_AMBIGUOUS');
    expect(exists(w.f['Inn (cities)']!)).toBe(true);
    const r = await del({ feature: 'Inn', featureFolder: 'Cities' });
    expect(r.body.status, r.text).toBe('written');
    expect(exists(w.f['Inn (cities)']!)).toBe(false);
    expect(exists(w.f['Inn (shrines)']!)).toBe(true);
    const byId = await del({ feature: w.f['Isar Harbour'] });
    expect(byId.body.status, byId.text).toBe('written');
    expect((await del({ feature: 'Nobody' })).body.error?.code).toBe('FEATURE_NOT_FOUND');
  });

  it('cascade on a feature with nothing under it deletes just that feature', async () => {
    const r = await del({ feature: 'Arkona', cascade: true });
    expect(r.body, r.text).toMatchObject({ status: 'written', removedCount: 1 });
  });

  it('refuses a document that is no map', async () => {
    expect(
      (await del({ feature: 'x' }, { page: 'Atlas of Arkona', document: 'Main' })).body.error?.code,
    ).toBe('NOT_A_MAP');
    expect(
      (await del({ feature: 'x' }, { page: 'Atlas of Arkona', document: 'Sketch' })).body.error?.code,
    ).toBe('BLANK_DOCUMENT');
  });
});

describe('a folder', () => {
  it('with features is refused without cascade, listing what it holds; an empty one is not', async () => {
    const before = writes().length;
    const r = await del({ feature: 'Shrines' });
    expect(r.body.error?.code).toBe('HAS_FEATURES');
    expect(r.body.error.count).toBe(5);
    expect(r.body.error.message).toMatch(/cascade: true/);
    expect(r.body.error.holds.map((h: { name: string }) => h.name).sort()).toEqual([
      'Frost Altar',
      'Hollow Shrine',
      'Inn',
      'North',
      'Torii Gate',
    ]);
    expect(writes().length).toBe(before);
    expect(exists(w.f.Shrines!)).toBe(true);
    // the empty "Ruins" folder in Cities (found by name and folder)
    const empty = await del({ feature: 'Ruins', featureFolder: 'Cities' });
    expect(empty.body, empty.text).toMatchObject({ status: 'written', verified: true, removedCount: 1 });
    expect(exists(w.f['Ruins (cities)']!)).toBe(false);
  });

  it('a dry run lists everything a cascade would remove and deletes nothing', async () => {
    const before = writes().length;
    const r = await del({ feature: 'Shrines', cascade: true, dryRun: true });
    expect(r.body, r.text).toMatchObject({ status: 'dry_run', removedCount: 6 });
    expect(r.body.removed.map((x: { name: string }) => x.name)).toEqual([
      'Frost Altar',
      'Inn',
      'North',
      'Hollow Shrine',
      'Torii Gate',
      'Shrines',
    ]);
    expect(writes().length).toBe(before);
    expect(exists(w.f.Shrines!)).toBe(true);
  });

  it('with cascade deletes the features first, deepest first, then the folder; lists all; journals every one in full', async () => {
    const all = w.features(w.md.map);
    const under = ['Frost Altar', 'Inn', 'North', 'Hollow Shrine', 'Torii Gate'].map((n) =>
      all.find(
        (f) =>
          f.name === n && (f.parentId === w.f.Shrines || f.parentId === w.f.North || n === 'Frost Altar'),
      )!,
    );
    const folder = all.find((f) => f.id === w.f.Shrines)!;
    const sentBefore = w.sent.length;
    const done = w.mark();
    const r = await del({ feature: 'Shrines', cascade: true });
    costs.delete_cascade_6 = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true, removedCount: 6 });
    expect(r.body.removed.map((x: { name: string }) => x.name)).toEqual([
      'Frost Altar',
      'Inn',
      'North',
      'Hollow Shrine',
      'Torii Gate',
      'Shrines',
    ]);
    // children before the folder that holds them: a stop part-way never leaves a feature pointing at a deleted folder
    const order = w.sent
      .slice(sentBefore)
      .filter((s) => s.method === 'DELETE')
      .map((s) => s.path.split('/').at(-1));
    expect(order).toEqual([...under.map((f) => f.id), folder.id]);
    for (const f of [...under, folder]) expect(exists(f.id as string)).toBe(false);
    // the rest of the map is untouched
    expect(exists(w.f.Cities!)).toBe(true);
    expect(exists(w.f['Qishen lands']!)).toBe(true);
    // the journal: every removed feature, in full, in its own entry...
    const entries = journal(String(r.body.jobId)).filter((e) => e.opId === 'deleteFeature');
    expect(entries).toHaveLength(6);
    for (const f of [...under, folder]) {
      const e = entries.find((x) => (x.preImage as { id?: string })?.id === f.id);
      expect(e, String(f.name)).toBeDefined();
      expect(e!.preImage).toMatchObject({ id: f.id, name: f.name, type: f.type, rank: f.rank });
    }
    // ...and the folder's own entry holds everything that went with it, so each can be added again
    const folderEntry = entries.find((x) => (x.preImage as { id?: string })?.id === folder.id)!;
    const removed = (folderEntry.preImage as { with: { removedWithIt: Record<string, unknown>[] } }).with
      .removedWithIt;
    expect(removed.map((f) => f.name)).toEqual(under.map((f) => f.name));
    expect(removed.find((f) => f.name === 'Torii Gate')).toMatchObject({
      pos: under[4]!.pos,
      uri: under[4]!.uri,
      iconShape: 'shield',
      parentId: w.f.Shrines,
    });
  });
});

describe('a cascade that stops part-way', () => {
  it('reports what was written, never retries, and asking again deletes only what is left', async () => {
    // Cities holds Ashgate (a0) and Tavern/Inn was deleted above; give it three more to delete.
    for (const n of ['One', 'Two', 'Three']) {
      const r = await call('create_map_feature', {
        ...ARKONA,
        type: 'pin',
        name: n,
        pixel: { x: 10, y: 10 },
        folder: 'Cities',
      });
      expect(r.body.status, r.text).toBe('written');
    }
    expect(w.features(w.md.map).filter((f) => f.parentId === w.f.Cities)).toHaveLength(4);
    w.failAt('deleteFeature', 2); // the third delete fails (a plain 400: nothing retries it)
    const first = await del({ feature: 'Cities', cascade: true });
    expect(first.body.error?.code, first.text).toBe('WRITTEN_IN_PART');
    expect(first.body.error.written).toHaveLength(2);
    expect(first.body.error.notWritten).toHaveLength(3); // the delete that failed, the next feature and the folder
    expect(first.body.error.hint).toMatch(/Do not repeat this request/);
    // two features are gone, the folder and the rest remain
    const left = w.features(w.md.map).filter((f) => f.parentId === w.f.Cities).length;
    expect(left).toBe(2);
    expect(exists(w.f.Cities!)).toBe(true);
    // nothing was retried: the delete that failed was sent once
    // asking again plans from the map as it is now: only what is left
    const again = await del({ feature: 'Cities', cascade: true });
    expect(again.body, again.text).toMatchObject({ status: 'written', verified: true, removedCount: 3 });
    expect(exists(w.f.Cities!)).toBe(false);
    expect(w.features(w.md.map).filter((f) => f.parentId === w.f.Cities)).toHaveLength(0);
  });

  it('a stop at the folder itself leaves an empty folder that a plain delete then removes', async () => {
    const f = await call('create_map_feature', { ...ARKONA, type: 'folder', name: 'Temp' });
    expect(f.body.status, f.text).toBe('written');
    await call('create_map_feature', {
      ...ARKONA,
      type: 'pin',
      name: 'Temp Pin',
      pixel: { x: 10, y: 10 },
      folder: 'Temp',
    });
    w.failAt('deleteFeature', 1); // the folder, after its one feature
    const first = await del({ feature: 'Temp', cascade: true });
    expect(first.body.error?.code, first.text).toBe('WRITTEN_IN_PART');
    expect(w.features(w.md.map).some((x) => x.name === 'Temp Pin')).toBe(false);
    const again = await del({ feature: 'Temp' }); // no cascade needed: it is empty now
    expect(again.body, again.text).toMatchObject({ status: 'written', removedCount: 1 });
    expect(w.features(w.md.map).some((x) => x.name === 'Temp')).toBe(false);
  });
});

describe('measured costs', () => {
  it('a delete costs the plan’s two reads, the check’s two, a pre-image read and a write per feature, and the verify', () => {
    expect(costs.delete_pin).toEqual({ reads: 6, writes: 1 });
    // 6 features: plan 2 + check 2 + 6 pre-image reads + verify 1
    expect(costs.delete_cascade_6).toEqual({ reads: 11, writes: 6 });
  });
});

describe('features at the top level, whichever way they say so', () => {
  it('a cascade takes what is in the folder, never a top-level feature that reads back with parentId "" (or none)', async () => {
    const live = w.liveFeatures(w.md.map);
    const at = '2026-11-12T09:00:00Z';
    live.push(
      { id: 'zone0001', type: 'folder', name: 'Zone', rank: 'b0', parentId: '', updatedAt: at },
      {
        id: 'zpin0001',
        type: 'pin',
        name: 'Zone pin',
        rank: 'a0',
        parentId: 'zone0001',
        pos: [-1, 1],
        updatedAt: at,
      },
      { id: 'loose001', type: 'pin', name: 'Loose', rank: 'b1', parentId: '', pos: [-2, 2], updatedAt: at },
      { id: 'loose002', type: 'pin', name: 'Looser', rank: 'b2', pos: [-3, 3], updatedAt: at },
    );
    const plain = await del({ feature: 'Zone' });
    expect(plain.body.error?.code).toBe('HAS_FEATURES');
    expect(plain.body.error.count).toBe(1);
    const dry = await del({ feature: 'Zone', cascade: true, dryRun: true });
    expect(dry.body.removed.map((x: { name: string }) => x.name)).toEqual(['Zone pin', 'Zone']);
    const r = await del({ feature: 'Zone', cascade: true });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true, removedCount: 2 });
    expect(exists('zone0001')).toBe(false);
    expect(exists('zpin0001')).toBe(false);
    expect(exists('loose001')).toBe(true);
    expect(exists('loose002')).toBe(true);
    // a loose one is found by name at the top level, and deleted alone (it holds nothing)
    const one = await del({ feature: 'Loose', featureFolder: null });
    expect(one.body, one.text).toMatchObject({ status: 'written', verified: true, removedCount: 1 });
    expect(exists('loose001')).toBe(false);
  });
});
