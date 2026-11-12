/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * update_map_feature (v2 D2, ADR 0040), against the mock map world: partial updates with the same coordinate and link
 * rules as create (including clearing a link with `link: null`), identification by id or by name plus folder (ambiguity
 * refused), moving a feature into another folder and out to the top level, placement, styles, no-ops, dry runs and the
 * journal's pre-image.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { mapsWorld, M, type MapsWorld } from './world.js';

let w: MapsWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const ARKONA = { page: 'Atlas of Arkona', document: 'Arkona map' };
const update = (args: Record<string, unknown>, doc: Record<string, unknown> = ARKONA) =>
  call('update_map_feature', { ...doc, ...args });
const stored = (id: string, doc = w.md.map) => w.features(doc).find((f) => f.id === id)!;
const order = (parent: string | null, doc = w.md.map) =>
  w
    .features(doc)
    .filter((f) => (f.parentId ?? null) === parent)
    .sort((a, b) => (String(a.rank) < String(b.rank) ? -1 : 1))
    .map((f) => f.name as string);
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const costs: Record<string, { reads: number; writes: number }> = {};

beforeAll(async () => {
  w = await mapsWorld();
  client = await w.stack.connect();
});
afterAll(async () => {
  console.log('MAP UPDATE COSTS', JSON.stringify(costs));
  await w.close();
});

describe('a partial update', () => {
  it('renames and moves a pin by pixel position; only those fields are sent; the rest is untouched', async () => {
    const before = stored(w.f['Hollow Shrine']!);
    const done = w.mark();
    const r = await update({
      feature: 'Hollow Shrine',
      name: 'Hollow Shrine (old)',
      pixel: { x: 100, y: 200 },
    });
    costs.update_pin = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      changes: expect.arrayContaining(['name', 'pos']),
      feature: { name: 'Hollow Shrine', pixel: { x: 640, y: 320 } },
      after: { name: 'Hollow Shrine (old)', pixel: { x: 100, y: 200 } },
    });
    const now = stored(w.f['Hollow Shrine']!);
    expect(now).toMatchObject({ name: 'Hollow Shrine (old)', pos: [-25, 12.5] });
    expect(now.parentId).toBe(before.parentId);
    expect(now.rank).toBe(before.rank);
    // the PATCH carried exactly the changed fields
    const patch = w.sent.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(Object.keys(patch.body).sort()).toEqual(['name', 'pos']);
  });

  it('sends nothing when nothing differs, and refuses a call that asks for nothing', async () => {
    const before = writes().length;
    const same = await update({ feature: 'Isar Harbour', name: 'Isar Harbour', pixel: { x: 1500, y: 800 } });
    expect(same.body.status, same.text).toBe('no_change');
    const none = await update({ feature: 'Isar Harbour' });
    expect(none.body.error?.code).toBe('INVALID_PARAMS');
    expect(writes().length).toBe(before);
  });

  it('refuses when the feature is not there, by id or by name', async () => {
    expect((await update({ feature: 'Nobody', name: 'x' })).body.error?.code).toBe('FEATURE_NOT_FOUND');
    expect((await update({ feature: 'zzzzzzzz', name: 'x' })).body.error?.code).toBe('FEATURE_NOT_FOUND');
  });
});

describe('identifying the feature', () => {
  it('by id, by name, and by name plus folder; an ambiguous name is refused with each candidate', async () => {
    const byId = await update({ feature: w.f['Isar Harbour'], hidden: true });
    expect(byId.body.status, byId.text).toBe('written');
    expect(stored(w.f['Isar Harbour']!).isHidden).toBe(true);
    const amb = await update({ feature: 'Inn', name: 'Tavern' });
    expect(amb.body.error?.code).toBe('FEATURE_AMBIGUOUS');
    expect(amb.body.error.candidates.map((c: { folder: string }) => c.folder).sort()).toEqual([
      'Cities',
      'Shrines',
    ]);
    const inCities = await update({ feature: 'Inn', featureFolder: 'Cities', name: 'Tavern' });
    expect(inCities.body.status, inCities.text).toBe('written');
    expect(stored(w.f['Inn (cities)']!).name).toBe('Tavern');
    expect(stored(w.f['Inn (shrines)']!).name).toBe('Inn');
    // the top level only
    const top = await update({ feature: 'Ruins', featureFolder: null, hidden: true });
    expect(top.body.status, top.text).toBe('written');
    expect(stored(w.f['Ruins (top)']!).isHidden).toBe(true);
    expect(stored(w.f['Ruins (cities)']!).isHidden).toBeUndefined();
    const stillAmb = await update({ feature: 'Ruins', name: 'x' });
    expect(stillAmb.body.error?.code).toBe('FEATURE_AMBIGUOUS');
    const noFolder = await update({ feature: 'Inn', featureFolder: 'Nowhere', name: 'x' });
    expect(noFolder.body.error?.code).toBe('FOLDER_NOT_FOUND');
  });
});

describe('moving between folders', () => {
  it('moves into another folder at its end, and out to the top level at its end', async () => {
    const into = await update({ feature: 'Frost Altar', folder: 'Cities' });
    expect(into.body, into.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(w.f['Frost Altar']!).parentId).toBe(w.f.Cities);
    expect(order(w.f.Cities!).at(-1)).toBe('Frost Altar');
    const out = await update({ feature: 'Frost Altar', folder: null });
    expect(out.body, out.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(w.f['Frost Altar']!).parentId).toBeUndefined();
    expect(order(null).at(-1)).toBe('Frost Altar');
    // the PATCH sent a null parent
    const patch = w.sent.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(patch.body).toMatchObject({ parentId: null });
    // putting it back into a folder by id, after a named sibling
    const back = await update({ feature: w.f['Frost Altar'], folder: w.f.Shrines, after: 'Torii Gate' });
    expect(back.body.status, back.text).toBe('written');
    expect(order(w.f.Shrines!).slice(0, 3)).toEqual(['Torii Gate', 'Frost Altar', 'Hollow Shrine (old)']);
  });

  it('moves a folder with its features, and refuses a folder moved into itself or beneath itself', async () => {
    const r = await update({ feature: 'North', folder: 'Cities' });
    expect(r.body.status, r.text).toBe('written');
    expect(
      stored(w.f.Shrines! && (w.features(w.md.map).find((f) => f.name === 'North')!.id as string)).parentId,
    ).toBe(w.f.Cities);
    const self = await update({ feature: 'Cities', folder: 'Cities' });
    expect(self.body.error?.code).toBe('FOLDER_CYCLE');
    const beneath = await update({ feature: 'Cities', folder: 'North' });
    expect(beneath.body.error?.code).toBe('FOLDER_CYCLE');
    const notFolder = await update({ feature: 'Torii Gate', folder: 'Arkona' });
    expect(notFolder.body.error?.code).toBe('FOLDER_NOT_FOUND');
  });

  it('places within the same parent after or before a sibling, and does nothing when it already stands there', async () => {
    const r = await update({ feature: 'Weeping Sea', before: 'Qishen lands' });
    expect(r.body.status, r.text).toBe('written');
    const names = order(null);
    expect(names.indexOf('Weeping Sea')).toBe(names.indexOf('Qishen lands') - 1);
    const before = writes().length;
    const same = await update({ feature: 'Weeping Sea', before: 'Qishen lands' });
    expect(same.body.status, same.text).toBe('no_change');
    expect(writes().length).toBe(before);
    const wrongParent = await update({ feature: 'Old Road', after: 'Torii Gate' });
    expect(wrongParent.body.error?.code).toBe('SIBLING_NOT_FOUND');
    const itself = await update({ feature: 'Old Road', after: 'Old Road' });
    expect(itself.body.error?.code).toBe('SIBLING_NOT_FOUND');
  });
});

describe('links', () => {
  it('sets a link by page name, id or document; link: null clears it; clearing nothing is a no-op', async () => {
    const set = await update({ feature: 'Arkona', link: '[BSRC] Asagiri Miyabi' });
    expect(set.body, set.text).toMatchObject({
      status: 'written',
      link: { uri: `lk://resources/${M.miyabi}` },
    });
    expect(stored(w.f.Arkona!).uri).toBe(`lk://resources/${M.miyabi}`);
    const doc = await update({ feature: 'Arkona', link: { page: M.miyabi, document: 'Gallery' } });
    expect(doc.body.status, doc.text).toBe('written');
    expect(stored(w.f.Arkona!).uri).toBe(`lk://resources/${M.miyabi}/docs/${w.md.miyabiGallery}`);
    const clear = await update({ feature: 'Arkona', link: null });
    expect(clear.body, clear.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(w.f.Arkona!).uri).toBeUndefined();
    const patch = w.sent.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(patch.body).toEqual({ uri: '' });
    const again = await update({ feature: 'Arkona', link: null });
    expect(again.body.status, again.text).toBe('no_change');
  });

  it('refuses an ambiguous or missing link target, and leaves the feature alone', async () => {
    const hash = JSON.stringify(stored(w.f.Arkona!));
    for (const [link, code] of [
      ['Ashgate', 'AMBIGUOUS'],
      ['No Such Page', 'NOT_FOUND'],
      [{ page: M.miyabi, document: 'Appendix' }, 'LINK_DOCUMENT_NOT_FOUND'],
    ] as const) {
      const r = await update({ feature: 'Arkona', link });
      expect(r.body.error?.code, JSON.stringify(link)).toBe(code);
    }
    expect(JSON.stringify(stored(w.f.Arkona!))).toBe(hash);
  });
});

describe('coordinates', () => {
  it('replaces a region’s polygon by pixel points, keeping the field it already uses', async () => {
    const r = await update({
      feature: 'Qishen lands',
      points: [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 80 },
      ],
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(w.f['Qishen lands']!).polygon).toEqual([
      [0, 0],
      [0, 10],
      [-10, 10],
    ]);
    // Weeping Sea stores `polygons`: one polygon given as `points` goes into `polygons`, so the old shape cannot linger
    const sea = await update({
      feature: 'Weeping Sea',
      points: [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 80 },
      ],
    });
    expect(sea.body, sea.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(w.f['Weeping Sea']!).polygons).toHaveLength(1);
    expect(stored(w.f['Weeping Sea']!).polygon).toBeUndefined();
    const road = await update({
      feature: 'Old Road',
      points: [
        { x: 0, y: 0 },
        { x: 800, y: 800 },
      ],
    });
    expect(road.body.status, road.text).toBe('written');
    expect(stored(w.f['Old Road']!).polyline).toEqual([
      [0, 0],
      [-100, 100],
    ]);
  });

  it('applies the same rules as create: shapes, both systems, bounds, legacy', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [
        {
          feature: 'Torii Gate',
          points: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        },
        ARKONA,
        'GEOMETRY_SHAPE',
      ],
      [{ feature: 'Shrines', pixel: { x: 1, y: 1 } }, ARKONA, 'GEOMETRY_SHAPE'],
      [{ feature: 'Torii Gate', pixel: { x: 1, y: 1 }, latlng: [0, 0] }, ARKONA, 'COORDINATES_BOTH'],
      [{ feature: 'Torii Gate', pixel: { x: 5000, y: 1 } }, ARKONA, 'OUT_OF_BOUNDS'],
      [{ feature: 'Torii Gate', latlng: [9, 9] }, ARKONA, 'OUT_OF_BOUNDS'],
      [{ feature: 'Old Road', points: [{ x: 1, y: 1 }] }, ARKONA, 'GEOMETRY_SHAPE'],
    ];
    for (const [args, doc, code] of cases) {
      const r = await update(args, doc);
      expect(r.body.error?.code, `${JSON.stringify(args)} → ${r.text}`).toBe(code);
    }
    const ok = await update({ feature: 'Torii Gate', pixel: { x: 5000, y: 1 }, allowOutside: true });
    expect(ok.body.status, ok.text).toBe('written');
    // a legacy tiled map: pixels refused, lat/lng accepted
    const created = await call('create_map_feature', {
      page: 'Atlas of Arkona',
      document: 'Old tiled map',
      type: 'pin',
      name: 'Tiled Pin',
      latlng: [100, 100],
    });
    expect(created.body.status, created.text).toBe('written');
    const legacy = { page: 'Atlas of Arkona', document: 'Old tiled map' };
    const px = await update({ feature: 'Tiled Pin', pixel: { x: 1, y: 1 } }, legacy);
    expect(px.body.error?.code).toBe('PIXEL_NEEDS_IMAGE');
    expect(px.body.error.message).toMatch(/latlng/);
    const ll = await update({ feature: 'Tiled Pin', latlng: [200, -50] }, legacy);
    expect(ll.body.status, ll.text).toBe('written');
  });
});

describe('styles', () => {
  it('changes styles and the hidden flag, and refuses ones that do not apply', async () => {
    const r = await update({
      feature: 'Secret',
      hidden: false,
      style: { iconColor: '#00ff00', iconShape: 'flag' },
    });
    expect(r.body.status, r.text).toBe('written');
    expect(stored(w.f.Secret!)).toMatchObject({ isHidden: false, iconColor: '#00ff00', iconShape: 'flag' });
    const wrong = await update({ feature: 'Secret', style: { strokeWidth: 3 } });
    expect(wrong.body.error?.code).toBe('STYLE_NOT_FOR_TYPE');
    const bad = await update({ feature: 'Secret', style: { iconShape: 'star' } });
    expect(bad.isError).toBe(true);
  });
});

describe('dry runs, operation_id and the journal', () => {
  it('a dry run writes nothing and shows the feature before and after', async () => {
    const before = writes().length;
    const r = await update({ feature: 'Torii Gate', name: 'Torii Dry', dryRun: true });
    expect(r.body, r.text).toMatchObject({
      status: 'dry_run',
      changes: ['name'],
      feature: { name: 'Torii Gate' },
      after: { name: 'Torii Dry' },
      wouldSend: { name: 'Torii Dry' },
    });
    expect(writes().length).toBe(before);
  });

  it('keeps the feature as it was as the journal’s pre-image, with the operation', async () => {
    const was = { ...stored(w.f['Hollow Shrine']!) };
    const r = await update({ feature: 'Hollow Shrine (old)', name: 'Hollow Shrine' });
    expect(r.body.status, r.text).toBe('written');
    const entries = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
      jobId: String(r.body.jobId),
      includePreImage: true,
      limit: 10,
    });
    const write = entries.find((e) => e.opId === 'updateFeature')!;
    expect(write.preImage).toMatchObject({ id: was.id, name: 'Hollow Shrine (old)', pos: was.pos });
    expect(JSON.stringify(write)).toContain('update_map_feature');
  });

  it('a repeated operation_id returns the earlier result and changes nothing twice', async () => {
    const args = { feature: 'Torii Gate', name: 'Torii Once', operation_id: 'maps-upd-1' };
    const a = await update(args);
    expect(a.body.status, a.text).toBe('written');
    const before = writes().length;
    const b = await update(args);
    expect(b.body.repeated, b.text).toBe(true);
    expect(writes().length).toBe(before);
  });
});

describe('measured costs', () => {
  it('an update costs the plan’s two reads, the check’s two, one write and the verify’s read', () => {
    expect(costs.update_pin).toEqual({ reads: 5, writes: 1 });
  });
});
