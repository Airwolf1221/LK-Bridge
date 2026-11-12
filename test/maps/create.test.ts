/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * create_map_feature (v2 D2, ADR 0040), against the mock map world: every coordinate path (latlng, pixel, out of bounds
 * with and without allowOutside, the legacy refusal), every feature type, links (name, id, document, ambiguity, missing,
 * deleted in the app), folders (by name or id, ambiguity), placement (end, after, before; never alphabetical), styles,
 * dry runs and `operation_id`.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapsWorld, M, type MapsWorld } from './world.js';

let w: MapsWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const ARKONA = { page: 'Atlas of Arkona', document: 'Arkona map' };
const create = (args: Record<string, unknown>, doc: Record<string, unknown> = ARKONA) =>
  call('create_map_feature', { ...doc, ...args });
const named = (name: string, doc = w.md.map) => w.features(doc).filter((f) => f.name === name);
const one = (name: string, doc = w.md.map) => {
  const hits = named(name, doc);
  expect(hits, `${name} stored once`).toHaveLength(1);
  return hits[0]!;
};
/** The names under a parent (null: the top level) in rank order, as the app shows them. */
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
  console.log('MAP CREATE COSTS', JSON.stringify(costs));
  await w.close();
});

describe('a pin by pixel position', () => {
  it('is converted with the live image, written, verified, and shown in both systems', async () => {
    const done = w.mark();
    const r = await create({ type: 'pin', name: 'Pixel Pin', pixel: { x: 1024, y: 512 } });
    costs.create_pin = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      feature: { type: 'pin', name: 'Pixel Pin', latlng: [-64, 128], pixel: { x: 1024, y: 512 } },
    });
    // 2048×1024 → z = 3: pos = [-y / 8, x / 8]
    expect(one('Pixel Pin')).toMatchObject({ type: 'pin', pos: [-64, 128], rank: 'a8' });
    expect(one('Pixel Pin').parentId).toBeUndefined();
  });

  it('converts an edge pixel and a fraction exactly as the schema states', async () => {
    const r = await create({ type: 'pin', name: 'Corner', pixel: { x: 2048, y: 1024 } });
    expect(r.body.status, r.text).toBe('written');
    expect(one('Corner').pos).toEqual([-128, 256]);
    const q = await create({ type: 'pin', name: 'Odd', pixel: { x: 333.333, y: 77.7 } });
    expect(q.body.status, q.text).toBe('written');
    const [lat, lng] = one('Odd').pos as number[];
    expect(lat).toBeCloseTo(-77.7 / 8, 8);
    expect(lng).toBeCloseTo(333.333 / 8, 8);
  });
});

describe('every feature type', () => {
  it('adds a label by lat/lng, a region (one polygon, then several), a path and a folder', async () => {
    const label = await create({ type: 'label', name: 'Sea Label', latlng: [-20, 30] });
    expect(label.body.status, label.text).toBe('written');
    expect(one('Sea Label')).toMatchObject({ type: 'label', pos: [-20, 30] });

    const region = await create({
      type: 'region',
      name: 'Pixel Region',
      points: [
        { x: 0, y: 0 },
        { x: 800, y: 0 },
        { x: 800, y: 400 },
        { x: 0, y: 400 },
      ],
      style: { color: '#336699', fillOpacity: 0.4, fillStyle: 'striped' },
    });
    expect(region.body, region.text).toMatchObject({ status: 'written', verified: true });
    expect(one('Pixel Region')).toMatchObject({
      type: 'region',
      polygon: [
        [0, 0],
        [0, 100],
        [-50, 100],
        [-50, 0],
      ],
      color: '#336699',
      fillOpacity: 0.4,
      fillStyle: 'striped',
    });

    const several = await create({
      type: 'region',
      name: 'Two Islands',
      polygons: [
        [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
          { x: 80, y: 80 },
        ],
        [
          { x: 800, y: 800 },
          { x: 880, y: 800 },
          { x: 880, y: 880 },
        ],
      ],
    });
    expect(several.body.status, several.text).toBe('written');
    expect((one('Two Islands').polygons as unknown[]).length).toBe(2);

    const path = await create({
      type: 'path',
      name: 'Coast Road',
      points: [
        [-10, 10],
        [-20, 40],
        [-30, 90],
      ],
      style: { strokeWidth: 3, strokeStyle: 'dashed', color: '#aa5500' },
    });
    expect(path.body.status, path.text).toBe('written');
    expect(one('Coast Road')).toMatchObject({
      type: 'path',
      polyline: [
        [-10, 10],
        [-20, 40],
        [-30, 90],
      ],
      strokeStyle: 'dashed',
    });

    const folder = await create({ type: 'folder', name: 'Roads' });
    expect(folder.body, folder.text).toMatchObject({ status: 'written', verified: true });
    expect(one('Roads')).toMatchObject({ type: 'folder' });
    expect(one('Roads').pos).toBeUndefined();
  });

  it('refuses the wrong geometry for a type, both systems at once, and mixed points', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, latlng: [0, 0] }, 'COORDINATES_BOTH'],
      [{ type: 'region', name: 'x', points: [{ x: 1, y: 1 }, [0, 0], { x: 5, y: 5 }] }, 'COORDINATES_BOTH'],
      [
        { type: 'region', name: 'x', polygons: [[{ x: 1, y: 1 }, { x: 2, y: 2 }, [0, 0]]] },
        'COORDINATES_BOTH',
      ],
      [{ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, points: [[0, 0]] }, 'COORDINATES_CONFLICT'],
      [
        {
          type: 'region',
          name: 'x',
          points: [
            [0, 0],
            [1, 1],
          ],
        },
        'GEOMETRY_SHAPE',
      ], // two points
      [{ type: 'path', name: 'x', points: [[0, 0]] }, 'GEOMETRY_SHAPE'],
      [
        {
          type: 'pin',
          name: 'x',
          points: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        },
        'GEOMETRY_SHAPE',
      ],
      [{ type: 'folder', name: 'x', pixel: { x: 1, y: 1 } }, 'GEOMETRY_SHAPE'],
      [{ type: 'pin', name: 'x' }, 'GEOMETRY_REQUIRED'],
      [{ type: 'region', name: 'x' }, 'GEOMETRY_REQUIRED'],
    ];
    const before = writes().length;
    for (const [args, code] of cases) {
      const r = await create(args);
      expect(r.body.error?.code, `${JSON.stringify(args)} → ${r.text}`).toBe(code);
    }
    expect(writes().length).toBe(before);
  });
});

describe('legacy tiled maps and maps with no image', () => {
  it('refuse pixels, naming lat/lng, and take lat/lng with no bounds to check', async () => {
    for (const doc of ['Old tiled map', 'Tiled with a frame', 'Unpainted map']) {
      const before = writes().length;
      const r = await create(
        { type: 'pin', name: 'P', pixel: { x: 10, y: 10 } },
        { page: 'Atlas of Arkona', document: doc },
      );
      expect(r.body.error?.code, `${doc}: ${r.text}`).toBe('PIXEL_NEEDS_IMAGE');
      expect(r.body.error.message).toMatch(/latlng/);
      expect(writes().length).toBe(before);
    }
    const legacy = await create(
      { type: 'pin', name: 'Far away', latlng: [5000, -5000] },
      { page: 'Atlas of Arkona', document: 'Old tiled map' },
    );
    expect(legacy.body, legacy.text).toMatchObject({ status: 'written', verified: true });
    expect(one('Far away', w.md.legacy).pos).toEqual([5000, -5000]);
    const noImage = await create(
      { type: 'pin', name: 'Unplaced', latlng: [1, 1] },
      { page: 'Atlas of Arkona', document: 'Unpainted map' },
    );
    expect(noImage.body.status, noImage.text).toBe('written');
  });
});

describe('bounds', () => {
  it('refuses pixels outside the image and lat/lng outside its bounds, unless allowOutside', async () => {
    const before = writes().length;
    for (const args of [
      { pixel: { x: 3000, y: 10 } },
      { pixel: { x: -1, y: 10 } },
      { pixel: { x: 10, y: 1025 } },
      { latlng: [5, 5] },
      { latlng: [-10, 300] },
    ]) {
      const r = await create({ type: 'pin', name: 'Outside', ...args });
      expect(r.body.error?.code, `${JSON.stringify(args)}: ${r.text}`).toBe('OUT_OF_BOUNDS');
      expect(r.body.error.message).toMatch(/allowOutside/);
    }
    expect(writes().length).toBe(before);
    const px = await create({
      type: 'pin',
      name: 'Outside Pixel',
      pixel: { x: 3000, y: 10 },
      allowOutside: true,
    });
    expect(px.body.status, px.text).toBe('written');
    expect(one('Outside Pixel').pos).toEqual([-1.25, 375]);
    const ll = await create({ type: 'pin', name: 'Outside LL', latlng: [5, 5], allowOutside: true });
    expect(ll.body.status, ll.text).toBe('written');
  });

  it('lists the points that are outside, in a region', async () => {
    const r = await create({
      type: 'region',
      name: 'Spill',
      points: [
        { x: 10, y: 10 },
        { x: 5000, y: 10 },
        { x: 10, y: 5000 },
      ],
    });
    expect(r.body.error?.code).toBe('OUT_OF_BOUNDS');
    expect(r.body.error.count).toBe(2);
    expect(r.body.error.outside.map((o: { index: string }) => o.index)).toEqual(['point 2', 'point 3']);
  });
});

describe('the map', () => {
  it('refuses a blank document, a page, a missing or several maps, and takes the one map of a page', async () => {
    const blank = await create(
      { type: 'pin', name: 'x', latlng: [0, 0] },
      { page: 'Atlas of Arkona', document: 'Sketch' },
    );
    expect(blank.body.error?.code).toBe('BLANK_DOCUMENT');
    expect(blank.body.error.message).toMatch(/mapImage/);
    const page = await create(
      { type: 'pin', name: 'x', latlng: [0, 0] },
      { page: 'Atlas of Arkona', document: 'Main' },
    );
    expect(page.body.error?.code).toBe('NOT_A_MAP');
    expect(page.body.error.message).toMatch(/write_page/);
    const missing = await create(
      { type: 'pin', name: 'x', latlng: [0, 0] },
      { page: 'Atlas of Arkona', document: 'Nope' },
    );
    expect(missing.body.error?.code).toBe('DOCUMENT_NOT_FOUND');
    const several = await create({ type: 'pin', name: 'x', latlng: [0, 0] }, { page: 'Atlas of Arkona' });
    expect(several.body.error?.code).toBe('DOCUMENT_REQUIRED');
    expect(several.body.error.documents.length).toBeGreaterThan(3);
    const ambiguousPage = await create(
      { type: 'pin', name: 'x', latlng: [0, 0] },
      { page: 'Ashgate', document: 'Main' },
    );
    expect(ambiguousPage.body.error?.code).toBe('AMBIGUOUS');
    // The page with exactly one map: no `document` needed. By id also works.
    const canon = await create(
      { type: 'pin', name: 'Only Map', pixel: { x: 750, y: 350 } },
      { page: M.canon },
    );
    expect(canon.body, canon.text).toMatchObject({ status: 'written', verified: true });
    // 1500×700: z = 3, so 750 px → 750 / 8
    expect(one('Only Map', w.md.canonMap).pos).toEqual([-43.75, 93.75]);
  });
});

describe('folders', () => {
  it('puts a feature in a folder by name or id, and in a nested one', async () => {
    const a = await create({ type: 'pin', name: 'In Shrines', pixel: { x: 100, y: 100 }, folder: 'Shrines' });
    expect(a.body.status, a.text).toBe('written');
    expect(one('In Shrines').parentId).toBe(w.f.Shrines);
    const b = await create({ type: 'pin', name: 'In North', pixel: { x: 100, y: 100 }, folder: 'north' });
    expect(b.body.status, b.text).toBe('written');
    expect(one('In North').parentId).toBe(one('North').id);
    const c = await create({ type: 'pin', name: 'By Id', pixel: { x: 100, y: 100 }, folder: w.f.Cities });
    expect(c.body.status, c.text).toBe('written');
    expect(one('By Id').parentId).toBe(w.f.Cities);
    expect(a.body.placement.folder).toBe('Shrines');
  });

  it('refuses a folder name that matches more than one, with each path, and a feature that is no folder', async () => {
    const r = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, folder: 'Ruins' });
    expect(r.body.error?.code).toBe('FOLDER_AMBIGUOUS');
    expect(r.body.error.candidates.map((c: { folder: string | null }) => c.folder ?? '(top)').sort()).toEqual(
      ['(top)', 'Cities'],
    );
    const pin = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, folder: 'Torii Gate' });
    expect(pin.body.error?.code).toBe('FOLDER_NOT_FOUND');
    const none = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, folder: 'Nowhere' });
    expect(none.body.error?.code).toBe('FOLDER_NOT_FOUND');
    // by id, the ambiguity is gone
    const byId = await create({
      type: 'pin',
      name: 'In Top Ruins',
      pixel: { x: 1, y: 1 },
      folder: w.f['Ruins (top)'],
    });
    expect(byId.body.status, byId.text).toBe('written');
  });
});

describe('placement', () => {
  it('appends at the end by default and never sorts alphabetically', async () => {
    const before = order(w.f.Shrines!);
    await create({ type: 'pin', name: 'Aardvark Hill', pixel: { x: 5, y: 5 }, folder: 'Shrines' });
    await create({ type: 'pin', name: 'Zebra Falls', pixel: { x: 5, y: 5 }, folder: 'Shrines' });
    await create({ type: 'pin', name: 'Aaron’s Rest', pixel: { x: 5, y: 5 }, folder: 'Shrines' });
    const after = order(w.f.Shrines!);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(['Aardvark Hill', 'Zebra Falls', 'Aaron’s Rest']);
  });

  it('places after and before a named sibling, between the real neighbours', async () => {
    const a = await create({
      type: 'pin',
      name: 'After Torii',
      pixel: { x: 5, y: 5 },
      folder: 'Shrines',
      after: 'Torii Gate',
    });
    expect(a.body.status, a.text).toBe('written');
    expect(a.body.placement).toMatchObject({
      after: 'Torii Gate',
      before: 'Hollow Shrine',
      folder: 'Shrines',
    });
    const b = await create({
      type: 'pin',
      name: 'Before Torii',
      pixel: { x: 5, y: 5 },
      folder: 'Shrines',
      before: 'Torii Gate',
    });
    expect(b.body.status, b.text).toBe('written');
    const names = order(w.f.Shrines!);
    expect(names.slice(0, 4)).toEqual(['Before Torii', 'Torii Gate', 'After Torii', 'Hollow Shrine']);
    // by id too; at the top level, after the first top-level feature
    const c = await create({ type: 'label', name: 'After Shrines', latlng: [-1, 1], after: w.f.Shrines });
    expect(c.body.status, c.text).toBe('written');
    expect(order(null).slice(0, 3)).toEqual(['Shrines', 'After Shrines', 'Cities']);
  });

  it('refuses a sibling that is not under the same parent, one that is ambiguous, and after with before', async () => {
    const elsewhere = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, after: 'Torii Gate' });
    expect(elsewhere.body.error?.code).toBe('SIBLING_NOT_FOUND');
    const both = await create({
      type: 'pin',
      name: 'x',
      pixel: { x: 1, y: 1 },
      after: 'Shrines',
      before: 'Cities',
    });
    expect(both.body.error?.code).toBe('INVALID_PARAMS');
    // two siblings of one name under the same parent: never guessed
    for (const n of [1, 2]) {
      const r = await create({ type: 'label', name: 'Twin', latlng: [-n, n] });
      expect(r.body.status, r.text).toBe('written');
    }
    const amb = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, after: 'Twin' });
    expect(amb.body.error?.code).toBe('SIBLING_AMBIGUOUS');
    expect(amb.body.error.candidates).toHaveLength(2);
    // by id it works
    const byId = await create({
      type: 'pin',
      name: 'After Twin',
      pixel: { x: 1, y: 1 },
      after: named('Twin')[0]!.id,
    });
    expect(byId.body.status, byId.text).toBe('written');
  });

  it('keeps the rank between the neighbours however many are inserted in the same gap', async () => {
    for (let i = 0; i < 12; i++) {
      const r = await create({
        type: 'pin',
        name: `Gap ${i}`,
        pixel: { x: 5, y: 5 },
        folder: 'Cities',
        after: 'Ashgate',
      });
      expect(r.body.status, r.text).toBe('written');
    }
    const names = order(w.f.Cities!);
    expect(names[0]).toBe('Ashgate');
    expect(names.slice(1, 13)).toEqual(Array.from({ length: 12 }, (_, i) => `Gap ${11 - i}`)); // each lands right after Ashgate
    const ranks = w
      .features(w.md.map)
      .filter((f) => f.parentId === w.f.Cities)
      .map((f) => String(f.rank));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('styles', () => {
  it('pass through, checked against the schema', async () => {
    const ok = await create({
      type: 'pin',
      name: 'Styled',
      pixel: { x: 300, y: 300 },
      hidden: true,
      style: {
        iconGlyph: 'torii-gate',
        iconColor: '#AA00ff',
        iconShape: 'shield',
        iconSize: 'small',
        labelVisibility: 'hover',
        visibilityRange: [0.1, 0.9],
      },
    });
    expect(ok.body.status, ok.text).toBe('written');
    expect(one('Styled')).toMatchObject({
      iconGlyph: 'torii-gate',
      iconColor: '#AA00ff',
      iconShape: 'shield',
      iconSize: 'small',
      labelVisibility: 'hover',
      visibilityRange: [0.1, 0.9],
      isHidden: true,
    });
    // a field that does not apply to the type is refused here, naming where it applies
    const wrong = await create({
      type: 'pin',
      name: 'x',
      pixel: { x: 1, y: 1 },
      style: { color: '#123456', fillStyle: 'solid' },
    });
    expect(wrong.body.error?.code).toBe('STYLE_NOT_FOR_TYPE');
    expect(wrong.body.error.misplaced.map((m: { field: string }) => m.field).sort()).toEqual([
      'color',
      'fillStyle',
    ]);
    // enums and formats are refused before anything is planned
    for (const style of [
      { iconShape: 'star' },
      { iconColor: 'red' },
      { fillStyle: 'wavy' },
      { labelSize: 'huge' },
      { bogus: 1 },
    ]) {
      const before = w.seen.length;
      const r = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, style });
      expect(r.isError, JSON.stringify(style)).toBe(true);
      expect(w.seen.length).toBe(before); // nothing was even read
    }
  });
});

describe('dry runs and operation_id', () => {
  it('a dry run writes nothing and shows what would be sent', async () => {
    const before = writes().length;
    const r = await create({ type: 'pin', name: 'Dry', pixel: { x: 64, y: 64 }, dryRun: true });
    expect(r.body, r.text).toMatchObject({
      status: 'dry_run',
      feature: { name: 'Dry', latlng: [-8, 8], pixel: { x: 64, y: 64 } },
      wouldSend: { type: 'pin', name: 'Dry', pos: [-8, 8] },
    });
    expect(writes().length).toBe(before);
    expect(named('Dry')).toHaveLength(0);
  });

  it('a repeated operation_id returns the earlier result and creates nothing twice', async () => {
    const args = { type: 'pin', name: 'Once', pixel: { x: 64, y: 64 }, operation_id: 'maps-once-1' };
    const a = await create(args);
    expect(a.body.status, a.text).toBe('written');
    const before = writes().length;
    const b = await create(args);
    expect(b.body.repeated, b.text).toBe(true);
    expect(writes().length).toBe(before);
    expect(named('Once')).toHaveLength(1);
    const other = await create({ ...args, name: 'Different' });
    expect(other.body.error?.code).toBe('OPERATION_ID_REUSED');
  });
});

describe('links', () => {
  const miyabiMain = () => w.repo.liveDocs(w.repo.live(M.miyabi)!)[0]!.id;
  const gallery = () => w.md.miyabiGallery;

  it('links a page by its name or its id, and a document of it by name or id', async () => {
    const byName = await create({
      type: 'pin',
      name: 'Linked A',
      pixel: { x: 9, y: 9 },
      link: '[BSRC] Asagiri Miyabi',
    });
    expect(byName.body, byName.text).toMatchObject({
      status: 'written',
      link: { uri: `lk://resources/${M.miyabi}` },
    });
    expect(one('Linked A').uri).toBe(`lk://resources/${M.miyabi}`);
    const byId = await create({ type: 'pin', name: 'Linked B', pixel: { x: 9, y: 9 }, link: M.miyabi });
    expect(byId.body.status, byId.text).toBe('written');
    expect(one('Linked B').uri).toBe(`lk://resources/${M.miyabi}`);
    const doc = await create({
      type: 'pin',
      name: 'Linked C',
      pixel: { x: 9, y: 9 },
      link: { page: M.miyabi, document: 'Gallery' },
    });
    expect(doc.body.status, doc.text).toBe('written');
    expect(one('Linked C').uri).toBe(`lk://resources/${M.miyabi}/docs/${gallery()}`);
    const docId = await create({
      type: 'pin',
      name: 'Linked D',
      pixel: { x: 9, y: 9 },
      link: { page: M.miyabi, document: miyabiMain() },
    });
    expect(docId.body.status, docId.text).toBe('written');
    expect(one('Linked D').uri).toBe(`lk://resources/${M.miyabi}/docs/${miyabiMain()}`);
    // an unlinked feature has no uri at all
    const plain = await create({ type: 'pin', name: 'Unlinked', pixel: { x: 9, y: 9 } });
    expect(plain.body.status).toBe('written');
    expect(one('Unlinked').uri).toBeUndefined();
  });

  it('refuses an ambiguous name with each candidate, a missing page, one outside the repository, a missing document', async () => {
    const before = writes().length;
    const amb = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, link: 'Ashgate' });
    expect(amb.body.error?.code).toBe('AMBIGUOUS');
    expect(amb.body.error.candidates).toHaveLength(2);
    expect(amb.body.error.candidates[0]).toHaveProperty('path');
    // a character with an index and a Core of one name: each candidate says its role, nothing is guessed
    const roles = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, link: 'Asagiri Miyabi' });
    expect(roles.body.error?.code).toBe('AMBIGUOUS');
    expect(roles.body.error.candidates.some((c: { role?: string }) => c.role)).toBe(true);
    const missing = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, link: 'No Such Page' });
    expect(missing.body.error?.code).toBe('NOT_FOUND');
    const outside = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, link: 'outside1' });
    expect(outside.body.error?.code).toBe('NOT_IN_REPOSITORY');
    const nodoc = await create({
      type: 'pin',
      name: 'x',
      pixel: { x: 1, y: 1 },
      link: { page: M.miyabi, document: 'Appendix' },
    });
    expect(nodoc.body.error?.code).toBe('LINK_DOCUMENT_NOT_FOUND');
    expect(nodoc.body.error.documents.map((d: { name: string }) => d.name)).toContain('Gallery');
    expect(writes().length).toBe(before);
  });

  it('refuses a page the app deleted (the tree has not seen it yet)', async () => {
    w.repo.outside.delete(M.doomed);
    const byName = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, link: 'Doomed Temple' });
    expect(byName.body.error?.code, byName.text).toBe('LINK_TARGET_DELETED');
    const byId = await create({ type: 'pin', name: 'x', pixel: { x: 1, y: 1 }, link: M.doomed });
    expect(byId.body.error?.code).toBe('LINK_TARGET_DELETED');
  });
});

describe('measured costs', () => {
  it('a pin by pixel costs the plan’s reads, the check’s, one write and the verify', () => {
    // plan: getDocument + listFeatures; check: the same two; write: 1; verify: listFeatures
    expect(costs.create_pin).toEqual({ reads: 5, writes: 1 });
  });
});
