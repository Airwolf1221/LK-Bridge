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
    .filter((f) => (typeof f.parentId === 'string' && f.parentId !== '' ? f.parentId : null) === parent)
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
    // As the real API does (the owner's probe of 12 November 2026): it reads back with `parentId: ""`.
    expect(stored(w.f['Frost Altar']!).parentId).toBe('');
    expect(order(null).at(-1)).toBe('Frost Altar');
    // the PATCH sent an empty parent, never null
    const patch = w.sent.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(patch.body).toMatchObject({ parentId: '' });
    expect(patch.body.parentId).not.toBeNull();
    // putting it back into a folder by id, after a named sibling
    const back = await update({ feature: w.f['Frost Altar'], folder: w.f.Shrines, after: 'Torii Gate' });
    expect(back.body.status, back.text).toBe('written');
    expect(order(w.f.Shrines!).slice(0, 3)).toEqual(['Torii Gate', 'Frost Altar', 'Hollow Shrine (old)']);
  });

  it('moves to the top level beside a named sibling, after or before, with a rank between the real neighbours', async () => {
    // top level before: ..., Ruins(a2), Qishen lands(a3), Weeping Sea(a4), Old Road(a5), Arkona(a6), Secret(a7)
    const a = await update({ feature: 'Frost Altar', folder: null, after: 'Qishen lands' });
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(w.f['Frost Altar']!)).toMatchObject({ parentId: '' });
    let names = order(null);
    expect(names.indexOf('Frost Altar')).toBe(names.indexOf('Qishen lands') + 1);
    expect(
      String(stored(w.f['Frost Altar']!).rank) > 'a3' && String(stored(w.f['Frost Altar']!).rank) < 'a4',
    ).toBe(true);
    const sent = w.sent.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(sent.body).toMatchObject({ parentId: '' });
    // out of a folder again, this time before a top-level feature (one that was created at the top level: no field)
    const into = await update({ feature: 'Frost Altar', folder: 'Cities' });
    expect(into.body.status, into.text).toBe('written');
    expect(stored(w.f['Frost Altar']!).parentId).toBe(w.f.Cities);
    const b = await update({ feature: 'Frost Altar', folder: null, before: 'Weeping Sea' });
    expect(b.body, b.text).toMatchObject({ status: 'written', verified: true });
    names = order(null);
    expect(names.indexOf('Frost Altar')).toBe(names.indexOf('Weeping Sea') - 1);
    expect(stored(w.f['Weeping Sea']!).parentId).toBeUndefined();
    expect(stored(w.f['Frost Altar']!).parentId).toBe('');
    // a sibling that lives in the folder is not a sibling at the top level
    const wrong = await update({ feature: w.f['Hollow Shrine'], folder: null, after: 'Isar Harbour' });
    expect(wrong.body.error?.code).toBe('SIBLING_NOT_FOUND');
  });

  it('a feature moved to the top level (parentId "") is top level everywhere: siblings, names, a dry run, a second move', async () => {
    const out = await update({ feature: 'Torii Gate', folder: null });
    expect(out.body.status, out.text).toBe('written');
    expect(stored(w.f['Torii Gate']!).parentId).toBe('');
    // asking for the top level again changes nothing and sends nothing
    const before = writes().length;
    const again = await update({ feature: 'Torii Gate', folder: null });
    expect(again.body.status, again.text).toBe('no_change');
    expect(writes().length).toBe(before);
    // found by name at the top level only; not in its old folder
    const top = await update({ feature: 'Torii Gate', featureFolder: null, hidden: true });
    expect(top.body.status, top.text).toBe('written');
    const old = await update({ feature: 'Torii Gate', featureFolder: 'Shrines', hidden: false });
    expect(old.body.error?.code).toBe('FEATURE_NOT_FOUND');
    // a sibling named for placement is found among the top-level features, "" or no field alike
    const place = await update({ feature: 'Old Road', after: 'Torii Gate' });
    expect(place.body.status, place.text).toBe('written');
    // a dry run into a folder shows the id it would send; back out it would send ""
    const dryIn = await update({ feature: 'Torii Gate', folder: 'Cities', dryRun: true });
    expect(dryIn.body.wouldSend).toMatchObject({ parentId: w.f.Cities });
    const into = await update({ feature: 'Torii Gate', folder: 'Cities' });
    expect(into.body.status, into.text).toBe('written');
    const dryOut = await update({ feature: 'Torii Gate', folder: null, dryRun: true });
    expect(dryOut.body, dryOut.text).toMatchObject({ status: 'dry_run', wouldSend: { parentId: '' } });
  });

  it('no request of the whole run ever sent a null parent, and the model refuses one with LegendKeeper’s 400', () => {
    const nulls = w.sent.filter((c) => 'parentId' in c.body && c.body.parentId === null);
    expect(nulls).toEqual([]);
    // the model, as the real API answered the probe: 400, the issue named, nothing written
    const path = `/api/v3/projects/x/resources/${M.atlas}/docs/${w.md.map}/features/${w.f.Arkona}`;
    const handler = [...w.overrides].find(([re]) => re.test(path))![1];
    const before = JSON.stringify(stored(w.f.Arkona!));
    const r = handler({
      method: 'PATCH',
      path,
      query: {},
      body: { parentId: null, rank: 'a1' },
      headers: {},
    })!;
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      errors: [{ path: 'parentId', message: 'Expected string, received null' }],
    });
    expect(JSON.stringify(stored(w.f.Arkona!))).toBe(before);
    // and "" is accepted
    const ok = handler({
      method: 'PATCH',
      path,
      query: {},
      body: { parentId: '', rank: 'a9' },
      headers: {},
    })!;
    expect(ok.status).toBe(200);
    expect(stored(w.f.Arkona!).parentId).toBe('');
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

  it('E5.4: a caller’s labelSize is refused (LABEL_SIZE_UNSUPPORTED), whatever its value; nothing is read or sent', async () => {
    const before = writes().length;
    const seen = w.seen.length;
    for (const labelSize of ['small', 'sm', 'md', '3xl', 'huge', 12]) {
      const bad = await update({ feature: 'Qishen lands', style: { labelSize } });
      expect(bad.isError, bad.text).toBe(true);
      expect(bad.body.error.code).toBe('LABEL_SIZE_UNSUPPORTED');
      expect(bad.body.error.message).toMatch(/listFeatures/);
      expect(bad.body.error.message).toMatch(/in the LegendKeeper app/);
    }
    const made = await call('create_map_feature', {
      ...ARKONA,
      type: 'label',
      name: 'Sized',
      pixel: { x: 10, y: 10 },
      style: { labelSize: 'md' },
    });
    expect(made.body.error?.code, made.text).toBe('LABEL_SIZE_UNSUPPORTED');
    expect(writes().length).toBe(before);
    expect(w.seen.length).toBe(seen);
  });

  it('E5.4: a map LegendKeeper refuses to list (a feature holds a new-style size) is a clear error with the advice', async () => {
    const live = () => w.liveFeatures(w.md.map).find((f) => f.id === w.f['Qishen lands'])!;
    live().labelSize = 'md';
    try {
      const r = await update({ feature: 'Qishen lands', name: 'Renamed' });
      expect(r.isError, r.text).toBe(true);
      expect(r.body.error.code).toBe('MAP_FEATURES_UNREADABLE');
      expect(r.body.error.message).toMatch(/set its label size in the app/);
      const read = await call('read_document', { resource: ARKONA.page, document: ARKONA.document });
      expect(read.body.error?.code, read.text).toBe('MAP_FEATURES_UNREADABLE');
    } finally {
      live().labelSize = 'small';
    }
    // An old value lists as before; and the map tools leave it alone (it is not compared).
    try {
      const r = await update({ feature: 'Qishen lands', name: 'Qishen lands' });
      expect(r.isError, r.text).toBeFalsy();
    } finally {
      delete live().labelSize;
    }
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
    // v2 E1a: plus the change snapshot's 2 reads (the page and the map's settings; the verify's listFeatures is reused)
    expect(costs.update_pin).toEqual({ reads: 7, writes: 1 });
  });
});
