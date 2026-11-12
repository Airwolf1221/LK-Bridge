/**
 * The map core (v2 D2, ADR 0040): the coordinate conversion against the schema's own formula (and the SDK's, and the app's
 * frame) as a property test at 10,000 runs over random sizes, the bounds rules, order keys, styles, geometry shapes, and
 * the planning functions the tools and the in-lock checks share.
 */
import { pixelToPos as sdkPixelToPos, posToPixel as sdkPosToPixel } from '@legendkeeper/sdk';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { operationInputSchema } from '../../src/lk/registry.js';
import {
  appBounds,
  buildCreate,
  buildUpdate,
  checkDelete,
  descendantsOf,
  featureHash,
  featureView,
  findFeature,
  findFolder,
  frameFrom,
  frameState,
  holds,
  isOrderKey,
  keyBetween,
  mapState,
  misplacedStyles,
  parentOf,
  parentOfValue,
  pixelInside,
  pixelToPos,
  planDelete,
  posInside,
  posToPixel,
  rankAmong,
  resolveGeometry,
  roundCoord,
  sameFrame,
  shapeProblem,
  siblingsOf,
  styleSchema,
  verifyFeatures,
  wireParent,
  zoomOf,
  type CreateRequest,
  type MapFrame,
  type Obj,
} from '../../src/maps/index.js';

const frameOf = (w: number, h: number): MapFrame => ({ width: w, height: h, bounds: appBounds(w, h) });

// ------------------------------------------------------------------------------------------------ conversion

describe('pixel and lat/lng conversion', () => {
  // The schema's text, written out here independently of the code under test.
  const schemaPos = (f: MapFrame, x: number, y: number): [number, number] => {
    const [[south, west], [north, east]] = f.bounds;
    return [north - (y * (north - south)) / f.height, west + (x * (east - west)) / f.width];
  };
  const schemaPixel = (f: MapFrame, lat: number, lng: number) => {
    const [[south, west], [north, east]] = f.bounds;
    return { x: ((lng - west) * f.width) / (east - west), y: ((north - lat) * f.height) / (north - south) };
  };

  it('matches the schema’s formula, the SDK’s functions and the app’s frame over random sizes (10,000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30_000 }),
        fc.integer({ min: 1, max: 30_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (width, height, u, v) => {
          const f = frameOf(width, height);
          const x = u * width;
          const y = v * height;
          // 1. exactly the schema's text
          const pos = pixelToPos(f, x, y);
          expect(pos).toEqual(schemaPos(f, x, y));
          const px = posToPixel(f, pos);
          expect(px).toEqual(schemaPixel(f, pos[0], pos[1]));
          // 2. the SDK's own functions (it says it exports this conversion)
          const sdkFrame = f as never; // the SDK's frame type is a mutable tuple
          expect(pos).toEqual(sdkPixelToPos(sdkFrame, x, y));
          expect(px).toEqual({
            x: sdkPosToPixel(sdkFrame, pos as never)[0],
            y: sdkPosToPixel(sdkFrame, pos as never)[1],
          });
          // 3. the app's frame: [-y / 2^z, x / 2^z] with z = ceil(log2(max(w, h) / 256))
          const k = 2 ** zoomOf(width, height);
          expect(pos[0]).toBeCloseTo(-y / k, 9);
          expect(pos[1]).toBeCloseTo(x / k, 9);
          // 4. and back
          expect(px.x).toBeCloseTo(x, 6);
          expect(px.y).toBeCloseTo(y, 6);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('matches the formula for any bounds, not only the app’s (10,000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.double({ min: -500, max: 499, noNaN: true }),
        fc.double({ min: -500, max: 499, noNaN: true }),
        fc.double({ min: 0.001, max: 500, noNaN: true }),
        fc.double({ min: 0.001, max: 500, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (width, height, south, west, dh, dw, u, v) => {
          const f: MapFrame = {
            width,
            height,
            bounds: [
              [south, west],
              [south + dh, west + dw],
            ],
          };
          const x = u * width;
          const y = v * height;
          expect(pixelToPos(f, x, y)).toEqual(schemaPos(f, x, y));
          const back = posToPixel(f, pixelToPos(f, x, y));
          expect(back.x).toBeCloseTo(x, 5);
          expect(back.y).toBeCloseTo(y, 5);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('puts the corners where the schema says (north and west are 0 at the top-left)', () => {
    const f = frameOf(2048, 1024); // z = 3: bounds [[-128, 0], [0, 256]]
    expect(f.bounds).toEqual([
      [-128, 0],
      [0, 256],
    ]);
    expect(pixelToPos(f, 0, 0)).toEqual([0, 0]);
    expect(pixelToPos(f, 2048, 1024)).toEqual([-128, 256]);
    expect(pixelToPos(f, 1024, 512)).toEqual([-64, 128]);
    expect(posToPixel(f, [-64, 128])).toEqual({ x: 1024, y: 512 });
  });

  it('knows the app’s zoom: ceil(log2(max(w, h) / 256)), at least 0', () => {
    expect(zoomOf(2048, 1024)).toBe(3);
    expect(zoomOf(1500, 700)).toBe(3);
    expect(zoomOf(256, 256)).toBe(0);
    expect(zoomOf(257, 10)).toBe(1);
    expect(zoomOf(100, 100)).toBe(0);
    expect(appBounds(1500, 700)).toEqual([
      [-87.5, 0],
      [0, 187.5],
    ]);
  });

  it('rounds stored coordinates to nine decimals', () => {
    expect(roundCoord(-0.1 - 0.2)).toBe(-0.3);
    expect(roundCoord(12.1234567891234)).toBe(12.123456789);
  });
});

describe('the image frame', () => {
  const good = {
    assetId: 'a1',
    url: 'https://x/y.webp',
    width: 2048,
    height: 1024,
    bounds: appBounds(2048, 1024),
  };
  it('reads an image, a legacy tiled map and a map with no image', () => {
    expect(frameState(good)).toMatchObject({ kind: 'image', url: 'https://x/y.webp', assetId: 'a1' });
    expect(frameState(null).kind).toBe('none');
    expect(frameState(undefined).kind).toBe('none');
    expect(frameState({ assetId: null, url: null })).toEqual({ kind: 'legacy', frame: null });
    // a legacy map that still reports a frame has no single image: pixels mean nothing
    expect(frameState({ ...good, assetId: null, url: null })).toMatchObject({ kind: 'legacy' });
    // an image whose frame is malformed is not usable for pixels
    expect(frameState({ ...good, width: 0 }).kind).toBe('legacy');
    expect(
      frameState({
        ...good,
        bounds: [
          [0, 0],
          [0, 0],
        ],
      }).kind,
    ).toBe('legacy');
    expect(
      frameFrom({
        width: 10,
        height: 10,
        bounds: [
          [1, 1],
          [0, 2],
        ],
      }),
    ).toBeNull();
    expect(sameFrame(frameOf(10, 10), frameOf(10, 10))).toBe(true);
    expect(sameFrame(frameOf(10, 10), frameOf(10, 11))).toBe(false);
    expect(sameFrame(null, frameOf(10, 10))).toBe(false);
  });
});

describe('bounds', () => {
  const f = frameOf(2048, 1024);
  it('pixels on the edge are inside, one past it are outside', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 2048, y: 1024 },
      { x: 0, y: 1024 },
      { x: 2048, y: 0 },
      { x: 1000.5, y: 3 },
    ])
      expect(pixelInside(f, p), JSON.stringify(p)).toBe(true);
    for (const p of [
      { x: -1, y: 0 },
      { x: 2049, y: 10 },
      { x: 10, y: 1025 },
      { x: 10, y: -0.5 },
    ])
      expect(pixelInside(f, p), JSON.stringify(p)).toBe(false);
  });
  it('lat/lng on the edge are inside, outside the bounds are not', () => {
    expect(posInside(f, [0, 0])).toBe(true);
    expect(posInside(f, [-128, 256])).toBe(true);
    expect(posInside(f, [1, 10])).toBe(false);
    expect(posInside(f, [-10, 257])).toBe(false);
    expect(posInside(f, [-129, 10])).toBe(false);
    expect(posInside(f, [-10, -1])).toBe(false);
  });
  it('lists every point outside, by name', () => {
    const r = resolveGeometry(
      {
        system: 'pixel',
        shape: 'points',
        points: [
          { x: 1, y: 1 },
          { x: 3000, y: 5 },
          { x: 5, y: -4 },
        ],
      },
      f,
    );
    expect(r.outside.map((o) => o.index)).toEqual(['point 2', 'point 3']);
    const g = resolveGeometry({ system: 'latlng', shape: 'point', point: [5, 5] }, f);
    expect(g.outside).toHaveLength(1);
    // no frame (a legacy tiled map): lat/lng has no bounds to be outside of
    expect(resolveGeometry({ system: 'latlng', shape: 'point', point: [500, 500] }, null).outside).toEqual(
      [],
    );
  });
});

// ------------------------------------------------------------------------------------------------ order keys

describe('order keys', () => {
  it('agree with the fractional-indexing reference vectors', () => {
    expect(keyBetween(null, null)).toBe('a0');
    expect(keyBetween('a0', null)).toBe('a1');
    expect(keyBetween('a1', null)).toBe('a2');
    expect(keyBetween('a0', 'a1')).toBe('a0V');
    expect(keyBetween('a1', 'a2')).toBe('a1V');
    expect(keyBetween('a0V', 'a1')).toBe('a0l');
    expect(keyBetween(null, 'a0')).toBe('Zz');
    expect(keyBetween(null, 'Zz')).toBe('Zy');
    expect(keyBetween('Zz', 'a0')).toBe('ZzV');
    expect(keyBetween('az', null)).toBe('b00');
  });
  it('refuses reversed, equal and invalid keys', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a1', 'a1')).toThrow();
    expect(() => keyBetween('a10', null)).toThrow(); // trailing zero
    expect(() => keyBetween('!', null)).toThrow();
    expect(isOrderKey('a0')).toBe(true);
    expect(isOrderKey('a')).toBe(false);
    expect(isOrderKey('')).toBe(false);
    expect(isOrderKey(null)).toBe(false);
  });
  it('always give a valid key strictly between its neighbours, however many are inserted (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 120 }),
        (cuts) => {
          let keys: string[] = [];
          for (const c of cuts) {
            const i = Math.min(keys.length, Math.floor(c * (keys.length + 1))); // insert at position i
            const a = i > 0 ? keys[i - 1]! : null;
            const b = i < keys.length ? keys[i]! : null;
            const k = keyBetween(a, b);
            expect(isOrderKey(k), k).toBe(true);
            if (a !== null) expect(k > a, `${a} < ${k}`).toBe(true);
            if (b !== null) expect(k < b, `${k} < ${b}`).toBe(true);
            keys = [...keys.slice(0, i), k, ...keys.slice(i)];
          }
          expect([...keys].sort()).toEqual(keys);
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('rankAmong', () => {
  const sibs = (...ranks: (string | null)[]) => ranks.map((rank, i) => ({ id: `s${i}`, rank }));
  it('appends after the last sibling by default, wherever the list is in', () => {
    const r = rankAmong(sibs('a2', 'a0', 'a1'), { at: 'end' });
    expect(r).toMatchObject({ ok: true, rank: 'a3', after: 's0', before: null });
    expect(rankAmong([], { at: 'end' })).toMatchObject({ ok: true, rank: 'a0', after: null, before: null });
  });
  it('places after and before a named sibling, between the real neighbours', () => {
    const list = sibs('a0', 'a1', 'a2');
    expect(rankAmong(list, { at: 'after', siblingId: 's0' })).toMatchObject({
      ok: true,
      rank: 'a0V',
      after: 's0',
      before: 's1',
    });
    expect(rankAmong(list, { at: 'before', siblingId: 's2' })).toMatchObject({
      ok: true,
      rank: 'a1V',
      after: 's1',
      before: 's2',
    });
    expect(rankAmong(list, { at: 'before', siblingId: 's0' })).toMatchObject({
      ok: true,
      rank: 'Zz',
      after: null,
      before: 's0',
    });
    expect(rankAmong(list, { at: 'after', siblingId: 's2' })).toMatchObject({
      ok: true,
      rank: 'a3',
      after: 's2',
      before: null,
    });
  });
  it('passes the rank-mates of an anchor (as LegendKeeper places resources)', () => {
    const list = sibs('a0', 'a1', 'a1', 'a2');
    expect(rankAmong(list, { at: 'after', siblingId: 's1' })).toMatchObject({
      ok: true,
      after: 's2',
      before: 's3',
    });
    expect(rankAmong(list, { at: 'before', siblingId: 's2' })).toMatchObject({
      ok: true,
      after: 's0',
      before: 's1',
    });
  });
  it('refuses a sibling that is not there and a rank it cannot read', () => {
    expect(rankAmong(sibs('a0'), { at: 'after', siblingId: 'nope' })).toMatchObject({
      ok: false,
      code: 'SIBLING_NOT_FOUND',
    });
    expect(rankAmong(sibs('a0', 'b!'), { at: 'end' })).toMatchObject({ ok: false, code: 'RANK_UNUSABLE' });
  });
  it('passes over a sibling that has no rank', () => {
    expect(rankAmong(sibs(null, 'a0'), { at: 'end' })).toMatchObject({ ok: true, rank: 'a1' });
    expect(rankAmong(sibs(null), { at: 'end' })).toMatchObject({ ok: true, rank: 'a0' });
  });
});

// ------------------------------------------------------------------------------------------------ styles and shapes

describe('styles and geometry shapes', () => {
  it('checks style fields against LegendKeeper’s enums and formats', () => {
    expect(
      styleSchema.safeParse({
        iconShape: 'shield',
        iconSize: 'small',
        iconColor: '#a7a7A7',
        labelSize: '2xl',
      }).success,
    ).toBe(true);
    expect(styleSchema.safeParse({ iconShape: 'star' }).success).toBe(false);
    expect(styleSchema.safeParse({ iconColor: 'red' }).success).toBe(false);
    expect(styleSchema.safeParse({ color: '#abc' }).success).toBe(false);
    expect(styleSchema.safeParse({ fillStyle: 'wavy' }).success).toBe(false);
    expect(styleSchema.safeParse({ textEffect: 'glow' }).success).toBe(false);
    expect(styleSchema.safeParse({ visibilityRange: [0, 1] }).success).toBe(true);
    expect(styleSchema.safeParse({ visibilityRange: [0] }).success).toBe(false);
    expect(styleSchema.safeParse({ nonsense: 1 }).success).toBe(false);
    expect(styleSchema.safeParse({ fillOpacity: Number.NaN }).success).toBe(false);
  });
  it('lists the style fields that do not apply to a type', () => {
    expect(misplacedStyles('pin', { iconColor: '#ffffff', color: '#000000' }).map((m) => m.field)).toEqual([
      'color',
    ]);
    expect(
      misplacedStyles('region', { color: '#000000', fillStyle: 'solid', strokeWidth: 3 }).map((m) => m.field),
    ).toEqual(['strokeWidth']);
    expect(misplacedStyles('folder', { labelSize: 'md' }).map((m) => m.field)).toEqual(['labelSize']);
    expect(misplacedStyles('path', { strokeStyle: 'dashed', textColor: '#000000' })).toEqual([]);
  });
  it('knows the geometry each type takes and how many points', () => {
    const pt = { system: 'latlng', shape: 'point', point: [0, 0] } as const;
    const pts = (n: number) =>
      ({
        system: 'latlng',
        shape: 'points',
        points: Array.from({ length: n }, () => [0, 0] as [number, number]),
      }) as const;
    expect(shapeProblem('pin', pt)).toBeNull();
    expect(shapeProblem('label', pt)).toBeNull();
    expect(shapeProblem('region', pt)).toMatch(/region takes/);
    expect(shapeProblem('region', pts(3))).toBeNull();
    expect(shapeProblem('region', pts(2))).toMatch(/at least 3/);
    expect(shapeProblem('path', pts(2))).toBeNull();
    expect(shapeProblem('path', pts(1))).toMatch(/at least 2/);
    expect(shapeProblem('folder', pt)).toMatch(/no coordinates/);
    expect(shapeProblem('folder', null)).toBeNull();
    expect(shapeProblem('pin', pts(3))).toMatch(/one position/);
    expect(
      shapeProblem('region', {
        system: 'latlng',
        shape: 'polygons',
        polygons: [pts(3).points, pts(2).points],
      }),
    ).toMatch(/Polygon 2 needs at least 3/);
  });
});

// ------------------------------------------------------------------------------------------------ stored features

describe('stored features', () => {
  it('compare numbers with a tolerance, and a region’s polygon and polygons as one list', () => {
    const stored: Obj = {
      id: 'a',
      type: 'region',
      polygon: [
        [0, 0],
        [0, 1],
        [1, 1],
      ],
    };
    expect(
      holds(stored, {
        polygon: [
          [0, 0],
          [0, 1.00000000001],
          [1, 1],
        ],
      }),
    ).toEqual([]);
    expect(
      holds(stored, {
        polygons: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
          ],
        ],
      }),
    ).toEqual([]);
    expect(
      holds(
        {
          ...stored,
          polygon: undefined,
          polygons: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
            ],
          ],
        },
        {
          polygon: [
            [0, 0],
            [0, 1],
            [1, 1],
          ],
        },
      ),
    ).toEqual([]);
    expect(
      holds(stored, {
        polygon: [
          [0, 0],
          [0, 2],
          [1, 1],
        ],
      }),
    ).toHaveLength(1);
  });
  it('treat parentId null and uri "" as "none"', () => {
    expect(holds({ id: 'a' }, { parentId: null, uri: '' })).toEqual([]);
    expect(holds({ id: 'a', parentId: 'f' }, { parentId: null })).toHaveLength(1);
    expect(holds({ id: 'a', uri: 'lk://resources/x' }, { uri: '' })).toHaveLength(1);
  });
  it('hash everything but updatedAt, in any key order', () => {
    expect(featureHash({ id: 'a', name: 'x', updatedAt: '1' })).toBe(
      featureHash({ updatedAt: '2', name: 'x', id: 'a' }),
    );
    expect(featureHash({ id: 'a', name: 'x' })).not.toBe(featureHash({ id: 'a', name: 'y' }));
  });
});

// ------------------------------------------------------------------------------------------------ planning

const IMG = { assetId: 'as1', url: 'https://x/a.webp', ...frameOf(2048, 1024) };
const feat = (id: string, type: string, name: string, rest: Obj = {}): Obj => ({
  id,
  type,
  name,
  rank: 'a0',
  ...rest,
});
const state = (features: Obj[], mapImage: unknown = IMG, type = 'map') =>
  mapState({ type, mapImage }, features);
const LIST = [
  feat('fold0001', 'folder', 'Shrines', { rank: 'a0' }),
  feat('fold0002', 'folder', 'North', { parentId: 'fold0001', rank: 'a0' }),
  feat('pin00001', 'pin', 'Torii', { parentId: 'fold0001', rank: 'a1', pos: [-32, 64] }),
  feat('pin00002', 'pin', 'Frost', { parentId: 'fold0002', rank: 'a0', pos: [-12, 112] }),
  feat('pin00003', 'pin', 'Top', { rank: 'a1', pos: [-10, 10] }),
];
const req = (o: Partial<CreateRequest>): CreateRequest => ({
  id: 'new00001',
  type: 'pin',
  name: 'New',
  geometry: { system: 'pixel', shape: 'point', point: { x: 512, y: 256 } },
  allowOutside: false,
  frame: frameOf(2048, 1024),
  parentId: null,
  placement: { at: 'end' },
  style: {},
  ...o,
});

describe('lookups', () => {
  const s = state(LIST);
  it('finds folders by id and name; refuses a name that is no folder', () => {
    expect(findFolder(s.features, 'North')).toMatchObject({ ok: true });
    expect(findFolder(s.features, 'fold0001')).toMatchObject({ ok: true });
    expect(findFolder(s.features, 'Torii')).toMatchObject({ ok: false, code: 'FOLDER_NOT_FOUND' });
    expect(findFolder(s.features, 'Nowhere')).toMatchObject({ ok: false, code: 'FOLDER_NOT_FOUND' });
  });
  it('refuses a folder name that matches more than one, with the paths', () => {
    const f = findFolder([...LIST, feat('fold0003', 'folder', 'north', { rank: 'a9' })], 'North');
    expect(f).toMatchObject({ ok: false, code: 'FOLDER_AMBIGUOUS' });
    if (!f.ok) expect((f.details!.candidates as Obj[]).map((c) => c.folder)).toEqual(['Shrines', null]);
  });
  it('finds a feature by id, by name, narrowed by folder, and refuses an ambiguous name', () => {
    const list = [...LIST, feat('pin00009', 'pin', 'Torii', { rank: 'a5', pos: [0, 0] })];
    expect(findFeature(list, 'pin00001')).toMatchObject({ ok: true });
    expect(findFeature(list, 'Torii')).toMatchObject({ ok: false, code: 'FEATURE_AMBIGUOUS' });
    expect(findFeature(list, 'Torii', 'Shrines')).toMatchObject({ ok: true, feature: { id: 'pin00001' } });
    expect(findFeature(list, 'Torii', null)).toMatchObject({ ok: true, feature: { id: 'pin00009' } });
    expect(findFeature(list, 'Nobody')).toMatchObject({ ok: false, code: 'FEATURE_NOT_FOUND' });
    expect(findFeature(list, 'Torii', 'Nowhere')).toMatchObject({ ok: false, code: 'FOLDER_NOT_FOUND' });
  });
  it('lists the siblings under a parent, and the descendants deepest first', () => {
    expect(siblingsOf(LIST, 'fold0001').map((f) => f.id)).toEqual(['fold0002', 'pin00001']);
    expect(siblingsOf(LIST, null).map((f) => f.id)).toEqual(['fold0001', 'pin00003']);
    expect(siblingsOf(LIST, 'fold0001', 'pin00001').map((f) => f.id)).toEqual(['fold0002']);
    // a feature whose folder has gone is shown at the top level, so it is a top-level sibling
    expect(
      siblingsOf(
        [...LIST, feat('orph0001', 'pin', 'Orphan', { parentId: 'gone0000', pos: [0, 0] })],
        null,
      ).map((f) => f.id),
    ).toContain('orph0001');
    expect(descendantsOf(LIST, 'fold0001').map((f) => f.id)).toEqual(['pin00002', 'pin00001', 'fold0002']);
    expect(descendantsOf(LIST, 'pin00003')).toEqual([]);
  });
});

describe('buildCreate', () => {
  const s = state(LIST);
  it('converts pixels with the live image and places the feature at the end', () => {
    const r = buildCreate(s, req({}));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.body).toMatchObject({ id: 'new00001', name: 'New', type: 'pin', pos: [-32, 64], rank: 'a2' });
    expect(r.verify.present[0]!.place).toEqual({ parentId: null, after: 'pin00003', before: null });
  });
  it('puts a feature in a folder, after or before a sibling, between the real neighbours', () => {
    const a = buildCreate(
      s,
      req({ parentId: 'fold0001', placement: { at: 'after', siblingId: 'fold0002' } }),
    );
    expect(a).toMatchObject({ ok: true });
    if (a.ok) expect(a.body).toMatchObject({ parentId: 'fold0001', rank: 'a0V' });
    const b = buildCreate(
      s,
      req({ parentId: 'fold0001', placement: { at: 'before', siblingId: 'fold0002' } }),
    );
    if (b.ok) expect(b.body.rank! as string).toBe('Zz');
  });
  it('refuses pixels on a legacy tiled map and on a map with no image, naming latlng', () => {
    for (const img of [
      { assetId: null, url: null },
      null,
      { assetId: null, url: null, ...frameOf(100, 100) },
    ]) {
      const r = buildCreate(state(LIST, img), req({}));
      expect(r).toMatchObject({ ok: false, code: 'PIXEL_NEEDS_IMAGE' });
    }
    const legacy = buildCreate(state(LIST, { assetId: null, url: null }), req({}));
    if (!legacy.ok) expect(legacy.message).toMatch(/legacy tiled map.*latlng/);
    // lat/lng is fine on a legacy map, with no bounds to check
    const ok = buildCreate(
      state(LIST, { assetId: null, url: null }),
      req({ geometry: { system: 'latlng', shape: 'point', point: [900, 900] }, frame: null }),
    );
    expect(ok).toMatchObject({ ok: true });
  });
  it('refuses points outside the image unless allowOutside', () => {
    const out = req({ geometry: { system: 'pixel', shape: 'point', point: { x: 3000, y: 10 } } });
    expect(buildCreate(s, out)).toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' });
    const allowed = buildCreate(s, { ...out, allowOutside: true });
    expect(allowed).toMatchObject({ ok: true });
    const latlng = req({ geometry: { system: 'latlng', shape: 'point', point: [5, 5] }, frame: null });
    expect(buildCreate(s, latlng)).toMatchObject({ ok: false, code: 'OUT_OF_BOUNDS' });
    expect(buildCreate(s, { ...latlng, allowOutside: true })).toMatchObject({ ok: true });
  });
  it('refuses when the image changed since the pixels were chosen', () => {
    expect(buildCreate(state(LIST, { ...IMG, ...frameOf(1024, 1024) }), req({}))).toMatchObject({
      ok: false,
      code: 'FRAME_CHANGED',
    });
  });
  it('builds a region (one polygon, or several), a path, a label and a folder', () => {
    const px = (x: number, y: number) => ({ x, y });
    const region = buildCreate(
      s,
      req({
        type: 'region',
        geometry: { system: 'pixel', shape: 'points', points: [px(0, 0), px(80, 0), px(80, 80)] },
      }),
    );
    expect(region).toMatchObject({
      ok: true,
      body: {
        polygon: [
          [0, 0],
          [0, 10],
          [-10, 10],
        ],
      },
    });
    const several = buildCreate(
      s,
      req({
        type: 'region',
        geometry: {
          system: 'pixel',
          shape: 'polygons',
          polygons: [
            [px(0, 0), px(8, 0), px(8, 8)],
            [px(80, 80), px(88, 80), px(88, 88)],
          ],
        },
      }),
    );
    if (several.ok) expect(several.body.polygons).toHaveLength(2);
    const path = buildCreate(
      s,
      req({ type: 'path', geometry: { system: 'pixel', shape: 'points', points: [px(0, 0), px(80, 80)] } }),
    );
    expect(path).toMatchObject({
      ok: true,
      body: {
        polyline: [
          [0, 0],
          [-10, 10],
        ],
      },
    });
    expect(
      buildCreate(
        s,
        req({ type: 'path', geometry: { system: 'pixel', shape: 'points', points: [px(0, 0)] } }),
      ),
    ).toMatchObject({ ok: false, code: 'GEOMETRY_SHAPE' });
    expect(buildCreate(s, req({ type: 'label', name: 'Sea' }))).toMatchObject({
      ok: true,
      body: { type: 'label', pos: [-32, 64] },
    });
    expect(buildCreate(s, req({ type: 'folder', geometry: null }))).toMatchObject({ ok: true });
    expect(buildCreate(s, req({ type: 'folder' }))).toMatchObject({ ok: false, code: 'GEOMETRY_SHAPE' });
    expect(buildCreate(s, req({ geometry: null }))).toMatchObject({ ok: false, code: 'GEOMETRY_REQUIRED' });
  });
  it('refuses a folder that is gone, a taken id, a document that is no map and a style for the wrong type', () => {
    expect(buildCreate(s, req({ parentId: 'gone0000' }))).toMatchObject({
      ok: false,
      code: 'FOLDER_NOT_FOUND',
    });
    expect(buildCreate(s, req({ parentId: 'pin00001' }))).toMatchObject({
      ok: false,
      code: 'FOLDER_NOT_FOUND',
    });
    expect(buildCreate(s, req({ id: 'pin00001' }))).toMatchObject({ ok: false, code: 'ID_TAKEN' });
    expect(buildCreate(state(LIST, IMG, 'page'), req({}))).toMatchObject({ ok: false, code: 'NOT_A_MAP' });
    expect(buildCreate(s, req({ style: { color: '#ffffff' } }))).toMatchObject({
      ok: false,
      code: 'STYLE_NOT_FOR_TYPE',
    });
    expect(buildCreate(s, req({ placement: { at: 'after', siblingId: 'nope' } }))).toMatchObject({
      ok: false,
      code: 'SIBLING_NOT_FOUND',
    });
  });
  it('carries link, hidden and style into the body', () => {
    const r = buildCreate(
      s,
      req({
        uri: 'lk://resources/abcdefgh',
        hidden: true,
        style: { iconShape: 'circle', iconColor: '#112233' },
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      body: { uri: 'lk://resources/abcdefgh', isHidden: true, iconShape: 'circle', iconColor: '#112233' },
    });
  });
});

describe('buildUpdate', () => {
  const s = state(LIST);
  const pin = LIST[2]!;
  const base = {
    featureId: 'pin00001',
    expectedHash: featureHash(pin),
    allowOutside: false,
    frame: frameOf(2048, 1024),
    style: {},
  };
  it('sends only what differs, and nothing when nothing does', () => {
    const r = buildUpdate(s, { ...base, name: 'Torii Gate', hidden: false });
    expect(r).toMatchObject({
      ok: true,
      body: { name: 'Torii Gate', isHidden: false },
      changes: ['name', 'isHidden'],
    });
    const same = buildUpdate(s, {
      ...base,
      name: 'Torii',
      geometry: { system: 'pixel', shape: 'point', point: { x: 512, y: 256 } },
    });
    expect(same).toMatchObject({ ok: true, noChange: true, body: {} });
  });
  it('is refused when the feature changed since it was planned', () => {
    expect(buildUpdate(s, { ...base, expectedHash: 'stale', name: 'x' })).toMatchObject({
      ok: false,
      code: 'FEATURE_CHANGED',
    });
    expect(buildUpdate(s, { ...base, featureId: 'gone0000', name: 'x' })).toMatchObject({
      ok: false,
      code: 'FEATURE_GONE',
    });
  });
  it('moves into a folder (end of it), out to the top level, and places after a sibling', () => {
    const into = buildUpdate(s, {
      ...base,
      featureId: 'pin00003',
      expectedHash: featureHash(LIST[4]!),
      parentId: 'fold0001',
    });
    expect(into).toMatchObject({ ok: true, body: { parentId: 'fold0001', rank: 'a2' } });
    const out = buildUpdate(s, { ...base, parentId: null });
    // The owner's probe of 12 November 2026: LegendKeeper refuses null; "" is the top level.
    expect(out).toMatchObject({ ok: true, body: { parentId: '', rank: 'a2' } });
    expect((out as { body: Obj }).body.parentId).not.toBeNull();
    const after = buildUpdate(s, { ...base, placement: { at: 'before', siblingId: 'fold0002' } });
    expect(after).toMatchObject({ ok: true, body: { rank: 'Zz' } });
    // already at the end of its parent: no write
    expect(buildUpdate(s, { ...base, placement: { at: 'end' } })).toMatchObject({ ok: true, noChange: true });
  });
  it('refuses a folder moved into itself or beneath itself', () => {
    const fold = LIST[0]!;
    const b = { ...base, featureId: 'fold0001', expectedHash: featureHash(fold) };
    expect(buildUpdate(s, { ...b, parentId: 'fold0001' })).toMatchObject({ ok: false, code: 'FOLDER_CYCLE' });
    expect(buildUpdate(s, { ...b, parentId: 'fold0002' })).toMatchObject({ ok: false, code: 'FOLDER_CYCLE' });
  });
  it('clears a link with "" and sets one; a region keeps the polygon field it uses', () => {
    const linked = LIST.map((f) => (f.id === 'pin00001' ? { ...f, uri: 'lk://resources/abcdefgh' } : f));
    const s2 = state(linked);
    const r = buildUpdate(s2, { ...base, expectedHash: featureHash(linked[2]!), uri: '' });
    expect(r).toMatchObject({ ok: true, body: { uri: '' } });
    const region = feat('reg00001', 'region', 'Sea', {
      polygons: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
        ],
      ],
      rank: 'a9',
    });
    const s3 = state([...LIST, region]);
    const r2 = buildUpdate(s3, {
      ...base,
      featureId: 'reg00001',
      expectedHash: featureHash(region),
      geometry: {
        system: 'pixel',
        shape: 'points',
        points: [
          { x: 0, y: 0 },
          { x: 80, y: 0 },
          { x: 80, y: 80 },
        ],
      },
    });
    expect(r2).toMatchObject({ ok: true });
    if (r2.ok) {
      expect(r2.body.polygons).toBeDefined();
      expect(r2.body.polygon).toBeUndefined();
    }
  });
});

describe('planDelete and checkDelete', () => {
  const s = state(LIST);
  it('deletes a plain feature, refuses a folder with features unless cascade, deepest first', () => {
    expect(planDelete(s, 'pin00003', false)).toMatchObject({ ok: true, order: [{ id: 'pin00003' }] });
    const refused = planDelete(s, 'fold0001', false);
    expect(refused).toMatchObject({ ok: false, code: 'HAS_FEATURES' });
    const cascade = planDelete(s, 'fold0001', true);
    expect(cascade).toMatchObject({ ok: true });
    if (cascade.ok)
      expect(cascade.order.map((f) => f.id)).toEqual(['pin00002', 'pin00001', 'fold0002', 'fold0001']);
    expect(planDelete(s, 'gone0000', true)).toMatchObject({ ok: false, code: 'FEATURE_GONE' });
    // an empty folder needs no cascade
    expect(planDelete(state([feat('fold0009', 'folder', 'Empty')]), 'fold0009', false)).toMatchObject({
      ok: true,
    });
  });
  it('checks inside the lock: each still as planned, and nothing new under a folder', () => {
    const plan = planDelete(s, 'fold0001', true);
    if (!plan.ok) throw new Error('plan');
    const req = {
      ids: plan.order.map((f) => f.id as string),
      hashes: Object.fromEntries(plan.order.map((f) => [f.id as string, featureHash(f)])),
      cascade: true,
    };
    expect(checkDelete(s, req)).toMatchObject({ ok: true });
    expect(checkDelete(state(LIST.filter((f) => f.id !== 'pin00002')), req)).toMatchObject({
      ok: false,
      code: 'FEATURE_GONE',
    });
    expect(
      checkDelete(state(LIST.map((f) => (f.id === 'pin00001' ? { ...f, name: 'Renamed' } : f))), req),
    ).toMatchObject({ ok: false, code: 'FEATURE_CHANGED' });
    const added = state([
      ...LIST,
      feat('pin00007', 'pin', 'Late', { parentId: 'fold0002', rank: 'a5', pos: [0, 0] }),
    ]);
    expect(checkDelete(added, req)).toMatchObject({ ok: false, code: 'FOLDER_CHANGED' });
    expect(checkDelete(state(LIST, IMG, 'page'), req)).toMatchObject({ ok: false, code: 'NOT_A_MAP' });
  });
});

describe('verifyFeatures', () => {
  it('reports a feature missing, a field that differs, a place out of order and a deleted one still there', () => {
    const list = [
      feat('a0000001', 'pin', 'A', { rank: 'a0', pos: [0, 0] }),
      feat('b0000001', 'pin', 'B', { rank: 'a1', pos: [1, 1] }),
    ];
    const input = {
      present: [
        {
          id: 'b0000001',
          label: 'pin “B”',
          fields: { pos: [1, 1], rank: 'a1' },
          place: { parentId: null, after: 'a0000001', before: null },
        },
      ],
      gone: [{ id: 'zzz00001', label: 'pin “Z”' }],
    };
    expect(verifyFeatures(list, input)).toEqual([]);
    expect(verifyFeatures([], input).map((d) => d.path)).toEqual(['pin “B”']);
    expect(
      verifyFeatures(
        list.map((f) => (f.id === 'b0000001' ? { ...f, pos: [2, 2] } : f)),
        input,
      ).map((d) => d.path),
    ).toEqual(['pin “B” pos']);
    expect(
      verifyFeatures(
        list.map((f) => (f.id === 'b0000001' ? { ...f, rank: 'a0' } : f)),
        input,
      ).some((d) => d.path.endsWith('rank')),
    ).toBe(true);
    const badPlace = {
      ...input,
      present: [
        { ...input.present[0]!, fields: {}, place: { parentId: null, after: null, before: 'a0000001' } },
      ],
    };
    expect(verifyFeatures(list, badPlace).map((d) => d.path)).toEqual(['pin “B” place']);
    expect(verifyFeatures([...list, feat('zzz00001', 'pin', 'Z')], input).map((d) => d.path)).toEqual([
      'pin “Z”',
    ]);
  });
});

describe('featureView', () => {
  it('shows a position in pixels too when the map has an image, and a link, a folder path and counts', () => {
    const s = state(LIST);
    expect(featureView(s, LIST[2]!)).toMatchObject({
      id: 'pin00001',
      type: 'pin',
      name: 'Torii',
      folder: 'Shrines',
      latlng: [-32, 64],
      pixel: { x: 512, y: 256 },
    });
    expect(featureView(state(LIST, null), LIST[2]!)).not.toHaveProperty('pixel');
    expect(
      featureView(
        s,
        feat('r', 'region', 'R', {
          polygon: [
            [0, 0],
            [0, 1],
            [1, 1],
          ],
        }),
      ),
    ).toMatchObject({ polygons: 1, points: 3 });
  });
});

describe('the top level, however a feature says it (the owner’s probe of 12 November 2026)', () => {
  // created at the top level: no field; moved there: ""; the bridge's own plans: null
  const topNone = feat('top00001', 'pin', 'None', { rank: 'a0', pos: [-1, 1] });
  const topEmpty = feat('top00002', 'pin', 'Empty', { parentId: '', rank: 'a1', pos: [-2, 2] });
  const topNull = feat('top00003', 'pin', 'Null', { parentId: null, rank: 'a2', pos: [-3, 3] });
  const inFolder = feat('in000001', 'pin', 'Inside', { parentId: 'fold0001', rank: 'a0', pos: [-4, 4] });
  const folder = feat('fold0001', 'folder', 'Shrines', { rank: 'a3' });
  const ALL = [topNone, topEmpty, topNull, inFolder, folder];

  it('reads absent, "" and null as the top level, and a folder id as itself, through one function', () => {
    expect([topNone, topEmpty, topNull].map(parentOf)).toEqual([null, null, null]);
    expect(parentOf(inFolder)).toBe('fold0001');
    expect(parentOfValue(undefined)).toBeNull();
    expect(parentOfValue('')).toBeNull();
    expect(parentOfValue(null)).toBeNull();
    expect(parentOfValue('fold0001')).toBe('fold0001');
    expect(wireParent(null)).toBe('');
    expect(wireParent('fold0001')).toBe('fold0001');
  });

  it('lists top-level features among the siblings whichever way they say it, and keeps folders’ members apart', () => {
    const names = (parent: string | null) => siblingsOf(ALL, parent).map((f) => f.name);
    expect(names(null)).toEqual(['None', 'Empty', 'Null', 'Shrines']);
    expect(names('fold0001')).toEqual(['Inside']);
    expect(siblingsOf(ALL, null, 'top00002').map((f) => f.name)).toEqual(['None', 'Null', 'Shrines']);
    // a parent that no longer exists is the top level too
    const orphan = feat('orph0001', 'pin', 'Orphan', { parentId: 'gone0000', rank: 'a9', pos: [0, 0] });
    expect(siblingsOf([...ALL, orphan], null).map((f) => f.name)).toContain('Orphan');
  });

  it('finds a feature by name at the top level whichever way it says so, and a folder holds none of them', () => {
    for (const name of ['None', 'Empty', 'Null']) {
      expect(findFeature(ALL, name, null)).toMatchObject({ ok: true });
      expect(findFeature(ALL, name, 'Shrines')).toMatchObject({ ok: false, code: 'FEATURE_NOT_FOUND' });
    }
    expect(descendantsOf(ALL, 'fold0001').map((f) => f.name)).toEqual(['Inside']);
  });

  it('compares a wanted parent with what is stored: "", null and no field agree; a folder differs', () => {
    for (const stored of [topNone, topEmpty, topNull]) {
      expect(holds(stored, { parentId: '' })).toEqual([]);
      expect(holds(stored, { parentId: null })).toEqual([]);
      expect(holds(stored, { parentId: 'fold0001' })).toHaveLength(1);
    }
    expect(holds(inFolder, { parentId: '' })).toEqual([
      { field: 'parentId', expected: null, actual: 'fold0001' },
    ]);
    expect(holds(inFolder, { parentId: 'fold0001' })).toEqual([]);
  });

  it('verifies a feature read back with "" as at the top level, and one still in a folder as a difference', () => {
    const want = {
      present: [{ id: 'top00002', label: 'pin “Empty”', fields: { parentId: '' } }],
      gone: [],
    };
    expect(verifyFeatures(ALL, want)).toEqual([]);
    expect(verifyFeatures([topEmpty], want)).toEqual([]);
    expect(
      verifyFeatures([topNone], { ...want, present: [{ ...want.present[0]!, id: 'top00001' }] }),
    ).toEqual([]);
    const stuck = verifyFeatures([inFolder], { ...want, present: [{ ...want.present[0]!, id: 'in000001' }] });
    expect(stuck).toMatchObject([{ path: 'pin “Empty” parentId', expected: null, actual: 'fold0001' }]);
  });

  it('plans a move to the top level as "", plain and beside a named sibling, never null', () => {
    const s = state(ALL);
    const mv = (o: Obj = {}) => ({
      featureId: 'in000001',
      expectedHash: featureHash(inFolder),
      allowOutside: false,
      frame: frameOf(2048, 1024),
      style: {},
      parentId: null as string | null,
      ...o,
    });
    const end = buildUpdate(s, mv());
    expect(end).toMatchObject({ ok: true, changes: ['parentId', 'rank'] });
    expect((end as { body: Obj }).body.parentId).toBe('');
    // after "Empty" (a feature that says "" itself): between it and "Null"
    const after = buildUpdate(s, mv({ placement: { at: 'after', siblingId: 'top00002' } })) as {
      body: Obj;
    };
    expect(after.body.parentId).toBe('');
    expect(String(after.body.rank) > 'a1' && String(after.body.rank) < 'a2').toBe(true);
    // before the first top-level feature, which has no field at all
    const before = buildUpdate(s, mv({ placement: { at: 'before', siblingId: 'top00001' } })) as {
      body: Obj;
    };
    expect(before.body.parentId).toBe('');
    expect(String(before.body.rank) < 'a0').toBe(true);
    // a feature already at the top level, whichever way, is not moved by asking for the top level
    for (const [id, f] of [
      ['top00001', topNone],
      ['top00002', topEmpty],
      ['top00003', topNull],
    ] as const) {
      expect(buildUpdate(s, mv({ featureId: id, expectedHash: featureHash(f) }))).toMatchObject({
        ok: true,
        noChange: true,
      });
    }
  });

  it('plans a move into a folder as the folder’s id, and a create at the top level with no parentId at all', () => {
    const s = state(ALL);
    const into = buildUpdate(s, {
      featureId: 'top00002',
      expectedHash: featureHash(topEmpty),
      allowOutside: false,
      frame: frameOf(2048, 1024),
      style: {},
      parentId: 'fold0001',
    });
    expect((into as { body: Obj }).body.parentId).toBe('fold0001');
    const created = buildCreate(s, req({ parentId: null })) as { body: Obj };
    expect('parentId' in created.body).toBe(false);
  });

  it('is what LegendKeeper’s own validation says: the bridge refuses null for updateFeature, and takes ""', () => {
    const schema = operationInputSchema('updateFeature');
    const path = { resourceId: 'abcdefgh', documentId: 'abcdefgh', featureId: 'abcdefgh' };
    expect(schema.safeParse({ path, body: { parentId: '', rank: 'a1' } }).success).toBe(true);
    const bad = schema.safeParse({ path, body: { parentId: null } });
    expect(bad.success).toBe(false);
  });
});
