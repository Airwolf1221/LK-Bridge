/**
 * The test world for the map tools (v2 D2, ADR 0040): C2b's resources world (the REAL server, policy, engine, tree and
 * MCP transport against the mock LegendKeeper) plus a model of map documents, with nothing live:
 *
 * - `[BSRC] Atlas of Arkona` holds a map whose image is 2048×1024 (the app's frame: bounds [[-128, 0], [0, 256]]), a legacy
 *   tiled map (no frame), a legacy tiled map that still reports a frame, a map with no image, and a `blank` document;
 *   the first map has folders (one nested), pins, labels, regions (one polygon and several), a path, a hidden pin, linked
 *   and unlinked features, and names that occur twice (two `Inn` pins, two `Ruins` folders);
 * - `[BSRC] Canon Atlas` (Authoritative, CANON) holds exactly one map (1500×700, a non-square, non-power-of-two image);
 * - the model answers what LegendKeeper answers, as far as the spec says: `getDocument` carries `mapImage` (the list and
 *   the page do not), setting an image from a library asset sets the app's frame and turns a `blank` document into a
 *   map, a first feature written to a `blank` document does too, `uri` must name a live resource (and a document of it),
 *   the colour fields refuse the wrong types, a duplicate id is `DUPLICATE_ID`, deleting a folder leaves what was in it
 *   (its `parentId` still names the folder that is gone), and `parentId: ""` moves a feature to the top level (it then reads back with `parentId: ""`; one created there has no field) while `parentId: null` is refused with LegendKeeper's own 400 issue (the owner's probe of 12 November 2026);
 * - failures can be injected at a chosen write, and the stored features are open to edits made "in the app".
 */
import { randomUUID } from 'node:crypto';
import { labelSizeListRefusal, labelSizeWriteRefusal } from './label-size-bug.js';
import { keyBetween } from '../../src/maps/rank.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { resourcesWorld, SidebarModel, type ResourcesWorld } from '../resources/world.js';

type Obj = Record<string, unknown>;

export const M = {
  atlas: 'atlas001',
  canon: 'canon001',
  /** Link targets that exist in the discover world. */
  miyabi: 'miyabi01',
  ashgateA: 'ashg0001',
  ashgateB: 'ashg0002',
  plot: 'board001',
  doomed: 'doomed01',
} as const;

/** The app's frame for an image: `[-y / 2^z, x / 2^z]`, `z = ceil(log2(max(w, h) / 256))`. Written out here, apart from the bridge's. */
export function appFrame(width: number, height: number) {
  const z = Math.max(0, Math.ceil(Math.log2(Math.max(width, height) / 256)));
  const k = 2 ** z;
  return {
    width,
    height,
    bounds: [
      [-height / k, 0],
      [0, width / k],
    ] as [[number, number], [number, number]],
  };
}

export interface MapsWorld extends ResourcesWorld {
  /** The ids of the seeded documents. */
  readonly md: {
    readonly map: string;
    readonly legacy: string;
    readonly legacyFrame: string;
    readonly noImage: string;
    readonly blank: string;
    readonly canonMap: string;
    readonly atlasMain: string;
    readonly miyabiGallery: string;
  };
  /** The library's image assets by name. */
  readonly assetIds: Record<string, string>;
  /** The seeded features of the Atlas map, by name (the first of each name), as ids. */
  readonly f: Record<string, string>;
  /** Features of a map document, as copies. */
  features(docId: string): Obj[];
  /** The stored features themselves (an edit made in the LegendKeeper app: no request is made). */
  liveFeatures(docId: string): Obj[];
  /** The stored `mapImage` of a map document. */
  image(docId: string): Obj | null;
  /** As the app's "Replace map": the map's image becomes this library asset (by name); no request is made. */
  setImage(docId: string, assetName: string): void;
  /** The bodies of the writes the map routes received, in order (what LegendKeeper was actually sent). */
  readonly sent: { readonly method: string; readonly path: string; readonly body: Obj }[];
  /**
   * Runs `fn` as the `n`-th (0-based, counted from now) `getDocument` or `listFeatures` request of a map arrives, before it
   * is answered: an edit made in the app between the bridge's plan and its check inside the lock.
   */
  hook(op: 'getDocument' | 'listFeatures', n: number, fn: () => void): void;
  /** The next `n`-th request (0-based) for this operation fails with `response` (once). */
  failAt(op: string, n: number, response?: MockResponse): void;
  /** Requests made since `mark()`, split into reads and writes. */
  mark(): () => { reads: number; writes: number; lines: string[] };
  /** Documents of the tree: the stored type of a document. */
  docType(docId: string): string;
}

const err = (
  status: number,
  code: string,
  message = `model ${code}`,
  errors?: { path: string; message: string }[],
): MockResponse => ({
  status,
  body: { message, code, requestId: `model-${code}`, ...(errors ? { errors } : {}) },
});

/** A feature's parent as the app reads it: no field or `""` is the top level (so is null, which is never stored). */
const parentKey = (x: Obj): string | null =>
  typeof x.parentId === 'string' && x.parentId !== '' ? x.parentId : null;

const HEX = /^#[0-9A-Fa-f]{6}$/;
const ID = /^[a-z](?:[0-9a-z]{7}|[0-9a-z]{23})$/;
const TYPES = ['pin', 'label', 'region', 'path', 'folder'];
const ENUMS: Record<string, string[]> = {
  iconShape: ['pin', 'diamond', 'flag', 'marker', 'shield', 'circle', 'banner', 'arch', 'none'],
  iconSize: ['medium', 'small'],
  fillStyle: ['solid', 'striped', 'dotted', 'none'],
  borderStyle: ['solid', 'dashed', 'dotted', 'none'],
  strokeStyle: ['solid', 'dashed', 'dotted', 'none'],
  labelVisibility: ['always', 'hover', 'never'],
  textEffect: ['outline', 'background'],
};
const COLOUR_TYPES: Record<string, string[]> = {
  iconColor: ['pin'],
  color: ['region', 'path'],
  textColor: ['label', 'region', 'path'],
  textEffect: ['label', 'region', 'path'],
  textEffectColor: ['label', 'region', 'path'],
};

export async function mapsWorld(o: Parameters<typeof resourcesWorld>[0] = {}): Promise<MapsWorld> {
  const assetIds: Record<string, string> = {};
  const docs = {} as { -readonly [K in keyof MapsWorld['md']]: string };
  // Many plans and checks in one file: the bridge's own model of the key's minute (300 requests) and the mock's would stop
  // a file part-way, so both get more than LegendKeeper publishes (the budget is not what is tested here).
  const w = (await resourcesWorld({
    ...o,
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }), ...o.env },
    limits: { 'key-min': 5000, 'write-min': 2000, ...o.limits },
    seed: (world) => {
      world.repo.seed({
        id: M.atlas,
        name: '[BSRC] Atlas of Arkona',
        parentId: ROOT,
        referenceType: 'General Source',
      });
      world.repo.seed({
        id: M.canon,
        name: '[BSRC] Canon Atlas',
        parentId: ROOT,
        referenceType: 'General Source',
        tags: ['CANON'],
      });
      // A page the app deletes later (the tree still lists it): a link to it must be refused.
      world.repo.seed({
        id: M.doomed,
        name: '[BSRC] Doomed Temple',
        parentId: ROOT,
        referenceType: 'General Source',
      });
      const add = (rid: string, name: string, type: string) =>
        world.repo.outside.addDocument(rid, name, type).id;
      docs.map = add(M.atlas, 'Arkona map', 'map');
      docs.legacy = add(M.atlas, 'Old tiled map', 'map');
      docs.legacyFrame = add(M.atlas, 'Tiled with a frame', 'map');
      docs.noImage = add(M.atlas, 'Unpainted map', 'map');
      docs.blank = add(M.atlas, 'Sketch', 'blank');
      docs.canonMap = add(M.canon, 'Canon map', 'map');
      docs.miyabiGallery = add(M.miyabi, 'Gallery', 'page');
      // The library's images (a map takes one by id or by name).
      const img = (name: string, width: number, height: number) => {
        assetIds[name] = world.assets.image(name, null, { width, height });
      };
      img('Arkona 2048x1024', 2048, 1024);
      img('Arkona alt 2048x1024', 2048, 1024);
      img('Canon 1500x700', 1500, 700);
      img('Square 1024', 1024, 1024);
      img('Wide 4096x1024', 4096, 1024);
      img('Twin', 800, 600);
      assetIds['Twin (2)'] = world.assets.image('Twin', world.assets.folder('Duplicates'), {
        width: 900,
        height: 500,
      });
      o.seed?.(world);
    },
  })) as MapsWorld;
  (w as { md: MapsWorld['md'] }).md = docs;
  (w as { assetIds: Record<string, string> }).assetIds = assetIds;
  // The canon page's facts: Authoritative (feature edits are ordinary edits: ADR 0036 decision 6).
  w.sidebars.page(M.canon, [
    SidebarModel.kv('kvcanon1', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
    ]),
  ]);

  // ------------------------------------------------------------------------------------------ the map model
  interface MapDoc {
    resourceId: string;
    features: Obj[];
    mapImage: Obj | null;
  }
  const maps = new Map<string, MapDoc>();
  const sent: { method: string; path: string; body: Obj }[] = [];
  (w as { sent: typeof sent }).sent = sent;
  let seq = 0;
  const fid = (n: string) =>
    `${n.slice(0, 1).toLowerCase()}${(++seq).toString(36).padStart(7, '0')}`.slice(0, 8);
  const at = (rid: string, did: string, image: Obj | null, features: Obj[] = []) =>
    maps.set(did, { resourceId: rid, features, mapImage: image });
  at(M.atlas, docs.map, {
    assetId: assetIds['Arkona 2048x1024']!,
    url: 'https://assets.legendkeeper.com/arkona.webp',
    ...appFrame(2048, 1024),
  });
  at(M.atlas, docs.legacy, { assetId: null, url: null });
  at(M.atlas, docs.legacyFrame, { assetId: null, url: null, ...appFrame(4096, 2048) });
  at(M.atlas, docs.noImage, null);
  at(M.atlas, docs.blank, null);
  at(M.canon, docs.canonMap, {
    assetId: assetIds['Canon 1500x700']!,
    url: 'https://assets.legendkeeper.com/canon.webp',
    ...appFrame(1500, 700),
  });

  const f: Record<string, string> = {};
  const feat = (name: string, type: string, rest: Obj = {}, key = name): string => {
    const id = fid(name);
    if (!(key in f)) f[key] = id;
    maps.get(docs.map)!.features.push({ id, name, type, updatedAt: '2026-11-11T09:00:00Z', ...rest });
    return id;
  };
  // pixel (x, y) of the 2048×1024 image is [-y / 8, x / 8].
  const pos = (x: number, y: number) => [-y / 8, x / 8];
  const shrines = feat('Shrines', 'folder', { rank: 'a0' });
  const cities = feat('Cities', 'folder', { rank: 'a1' });
  feat('Torii Gate', 'pin', {
    pos: pos(512, 256),
    parentId: shrines,
    rank: 'a0',
    uri: `lk://resources/${M.miyabi}`,
    iconShape: 'shield',
  });
  feat('Hollow Shrine', 'pin', { pos: pos(640, 320), parentId: shrines, rank: 'a1' });
  const north = feat('North', 'folder', { parentId: shrines, rank: 'a2' });
  feat('Frost Altar', 'pin', { pos: pos(900, 100), parentId: north, rank: 'a0' });
  feat('Inn', 'pin', { pos: pos(700, 400), parentId: shrines, rank: 'a3' }, 'Inn (shrines)');
  feat('Ashgate', 'pin', { pos: pos(1024, 512), parentId: cities, rank: 'a0' }, 'Ashgate');
  feat('Isar Harbour', 'pin', { pos: pos(1500, 800), parentId: cities, rank: 'a1' });
  feat('Inn', 'pin', { pos: pos(1100, 600), parentId: cities, rank: 'a2' }, 'Inn (cities)');
  feat('Ruins', 'folder', { parentId: cities, rank: 'a3' }, 'Ruins (cities)');
  feat('Ruins', 'folder', { rank: 'a2' }, 'Ruins (top)');
  feat('Qishen lands', 'region', {
    polygon: [pos(200, 200), pos(600, 200), pos(600, 500), pos(200, 500)],
    color: '#a8d8ff',
    fillOpacity: 0.3,
    rank: 'a3',
  });
  feat('Weeping Sea', 'region', {
    polygons: [
      [pos(1200, 100), pos(1800, 100), pos(1800, 300)],
      [pos(1200, 700), pos(1800, 700), pos(1500, 900), pos(1300, 900)],
    ],
    rank: 'a4',
  });
  feat('Old Road', 'path', {
    polyline: [
      pos(100, 900),
      pos(400, 700),
      pos(800, 650),
      pos(1200, 600),
      pos(1600, 300),
      pos(1900, 200),
      pos(2000, 100),
    ],
    rank: 'a5',
  });
  feat('Arkona', 'label', { pos: pos(1024, 50), rank: 'a6' });
  feat('Secret', 'pin', { pos: pos(10, 10), rank: 'a7', isHidden: true });
  // Ashgate links to a document of the first Ashgate page (its Main).
  const ashMain = w.repo.liveDocs(w.repo.live(M.ashgateA)!)[0]!.id;
  maps.get(docs.map)!.features.find((x) => x.name === 'Ashgate')!.uri =
    `lk://resources/${M.ashgateA}/docs/${ashMain}`;
  (w as { f: Record<string, string> }).f = f;

  // ------------------------------------------------------------------------------------------ the routes
  const hooks: { op: string; n: number; seen: number; fn: () => void }[] = [];
  const runHooks = (op: string) => {
    for (const h of hooks) if (h.op === op && h.seen++ === h.n) h.fn();
  };
  w.hook = (op, n, fn) => {
    hooks.push({ op, n, seen: 0, fn });
  };
  const faults: { op: string; n: number; seen: number; response: MockResponse }[] = [];
  const fault = (op: string): MockResponse | undefined => {
    for (const x of faults) {
      if (x.op !== op) continue;
      if (x.seen++ === x.n) return x.response;
    }
    return undefined;
  };
  const docRec = (did: string) => w.repo.docs.get(did);
  const uriOk = (uri: string): boolean => {
    const m = /^lk:\/\/(resources|documents)\/([A-Za-z0-9_]+)(?:\/docs\/([A-Za-z0-9_]+))?$/.exec(uri);
    if (!m) return false;
    if (m[1] === 'documents') return w.repo.docs.has(m[2]!) && docRec(m[2]!)!.deletedAt === null;
    const r = w.repo.live(m[2]!);
    if (!r) return false;
    if (m[3]) return w.repo.liveDocs(r).some((d) => d.id === m[3]);
    return true;
  };
  const validate = (b: Obj, type: string, creating: boolean): MockResponse | null => {
    if (creating && !TYPES.includes(String(b.type))) return err(400, 'VALIDATION_ERROR', 'type');
    if (typeof b.id === 'string' && !ID.test(b.id)) return err(400, 'VALIDATION_ERROR', 'id');
    for (const [k, v] of Object.entries(b)) {
      if (ENUMS[k] && !ENUMS[k].includes(String(v))) return err(400, 'VALIDATION_ERROR', k);
      if (COLOUR_TYPES[k]) {
        if (typeof v === 'string' && !HEX.test(v)) return err(400, 'VALIDATION_ERROR', k);
        if (!COLOUR_TYPES[k].includes(type))
          return err(400, 'VALIDATION_ERROR', `${k} does not apply to a ${type}`);
      }
    }
    if (typeof b.uri === 'string' && b.uri !== '' && !uriOk(b.uri))
      return err(400, 'VALIDATION_ERROR', 'uri');
    return null;
  };
  const view = (x: Obj): Obj => structuredClone(x);
  const docView = (did: string, req: MockRequest): MockResponse | undefined => {
    const r = w.repo.respond(req);
    const m = maps.get(did);
    if (r?.status === 200 && m && docRec(did)?.type === 'map')
      return { ...r, body: { ...(r.body as Obj), mapImage: structuredClone(m.mapImage) } };
    return r;
  };

  // The spec: "A new resource's first document is `blank`" (the shared model makes it a page).
  w.overrides.set(/\/resources$/, (req): MockResponse | undefined => {
    if (req.method !== 'POST') return undefined;
    const r = w.repo.respond(req);
    if (r?.status !== 201) return r;
    const body = r.body as { id: string; documents?: { id: string; type: string }[] };
    const res = w.repo.live(body.id);
    if (res) for (const d of w.repo.liveDocs(res)) d.type = 'blank';
    return {
      ...r,
      body: { ...body, documents: (body.documents ?? []).map((d) => ({ ...d, type: 'blank' })) },
    };
  });

  w.overrides.set(
    /\/resources\/[^/]+\/docs\/[^/]+(\/features(\/[^/]+)?)?$/,
    (req): MockResponse | undefined => {
      const m = /\/resources\/([^/]+)\/docs\/([^/]+)(?:\/features(?:\/([^/]+))?)?$/.exec(
        req.path.replace(/\/$/, ''),
      );
      if (!m) return undefined;
      const [, rid, did, featureId] = m;
      // A blank or map document the model made itself (a new page's first document) is a map in waiting too.
      const D0 = docRec(did!);
      if (!maps.has(did!) && D0 && D0.resourceId === rid && (D0.type === 'blank' || D0.type === 'map'))
        maps.set(did!, { resourceId: rid, features: [], mapImage: null });
      const doc = maps.get(did!);
      if (!doc || doc.resourceId !== rid) return undefined;
      const isFeatures = /\/features/.test(req.path);
      const D = docRec(did!);
      if (!D || D.deletedAt !== null) return err(404, 'NOT_FOUND');
      const body = (req.body ?? {}) as Obj;
      const method = req.method;
      if (method !== 'GET')
        sent.push({
          method,
          path: req.path.replace(/\/$/, '').replace(/^.*\/resources\//, ''),
          body: structuredClone(body),
        });
      // ---- the document itself
      if (!isFeatures) {
        if (method === 'GET') {
          runHooks('getDocument');
          return docView(did!, req);
        }
        if (method === 'PATCH') {
          const f0 = fault('updateDocument');
          if (f0) return f0;
          const { mapImage, ...rest } = body;
          if (mapImage !== undefined) {
            if (D.type !== 'map' && D.type !== 'blank') return err(400, 'KIND_MISMATCH');
            const assetId = (mapImage as Obj)?.assetId;
            const a = typeof assetId === 'string' ? w.assets.assets.get(assetId) : undefined;
            if (!a || (a.type !== 'IMAGE' && a.type !== 'MAP'))
              return err(400, 'VALIDATION_ERROR', 'mapImage.assetId');
            doc.mapImage = {
              assetId: a.id,
              url: a.url ?? `https://assets.legendkeeper.com/${randomUUID()}.webp`,
              ...appFrame(a.width ?? 512, a.height ?? 768),
            };
            D.type = 'map';
          }
          const r = w.repo.respond({ ...req, body: rest });
          return r?.status === 200 ? docView(did!, { ...req, method: 'GET' }) : r;
        }
        return undefined;
      }
      // ---- features
      if (D.type !== 'map' && D.type !== 'blank') return err(400, 'KIND_MISMATCH');
      const list = doc.features;
      if (!featureId) {
        if (method === 'GET') {
          runHooks('listFeatures');
          if (D.type === 'blank') return { status: 200, body: { data: [] } };
          const unlistable = labelSizeListRefusal(list);
          if (unlistable) return unlistable;
          const t = req.query.type;
          return { status: 200, body: { data: list.filter((x) => !t || x.type === t).map(view) } };
        }
        if (method === 'POST') {
          const f1 = fault('createFeature');
          if (f1) return f1;
          const type = String(body.type);
          const sized = labelSizeWriteRefusal(body);
          if (sized) return sized;
          const bad = validate(body, type, true);
          if (bad) return bad;
          const id = typeof body.id === 'string' ? body.id : fid('x');
          if (list.some((x) => x.id === id)) return err(409, 'DUPLICATE_ID');
          if (parentKey(body) !== null && !list.some((x) => x.id === body.parentId))
            return err(404, 'NOT_FOUND');
          const created: Obj = { ...structuredClone(body), id, updatedAt: new Date().toISOString() };
          if (created.uri === '') delete created.uri;
          if (created.rank === undefined) {
            const sibs = list
              .filter((x) => parentKey(x) === parentKey(created))
              .map((x) => (typeof x.rank === 'string' ? x.rank : ''))
              .sort();
            created.rank = keyBetween(sibs.at(-1) || null, null);
          }
          list.push(created);
          if (D.type === 'blank') D.type = 'map';
          return { status: 201, body: view(created) };
        }
        return undefined;
      }
      const at0 = list.findIndex((x) => x.id === featureId);
      if (at0 < 0) return err(404, 'NOT_FOUND');
      const cur = list[at0]!;
      if (method === 'GET') return { status: 200, body: view(cur) };
      if (method === 'PATCH') {
        const f2 = fault('updateFeature');
        if (f2) return f2;
        // The owner's probe of 12 November 2026: `updateFeature` enforces the schema's `type: string` for `parentId`, so
        // `null` is a 400 ("the schema's “(null = root)” text is wrong") and `""` is how a feature goes to the top level.
        if ('parentId' in body && typeof body.parentId !== 'string')
          return err(400, 'VALIDATION_ERROR', 'Validation failed', [
            { path: 'parentId', message: 'Expected string, received null' },
          ]);
        const sized = labelSizeWriteRefusal(body);
        if (sized) return sized;
        const bad = validate(body, String(body.type ?? cur.type), false);
        if (bad) return bad;
        if (parentKey(body) !== null && !list.some((x) => x.id === body.parentId))
          return err(404, 'NOT_FOUND');
        for (const [k, v] of Object.entries(structuredClone(body))) {
          // A moved-to-top-level feature reads back with `parentId: ""` (kept as sent); a uri of '' clears the link.
          if (k === 'uri' && v === '') delete cur[k];
          else cur[k] = v;
        }
        // one shape or the other: a region given `polygons` has no `polygon` left, and the other way round
        if (body.polygons !== undefined && body.polygon === undefined) delete cur.polygon;
        if (body.polygon !== undefined && body.polygons === undefined) delete cur.polygons;
        cur.updatedAt = new Date().toISOString();
        return { status: 200, body: view(cur) };
      }
      if (method === 'DELETE') {
        const f3 = fault('deleteFeature');
        if (f3) return f3;
        list.splice(at0, 1); // what was in a folder stays, still naming it
        return { status: 204 };
      }
      return undefined;
    },
  );

  // ------------------------------------------------------------------------------------------ helpers
  w.features = (d) => (maps.get(d)?.features ?? []).map(view);
  w.liveFeatures = (d) => maps.get(d)!.features;
  w.image = (d) => (maps.get(d)?.mapImage ? structuredClone(maps.get(d)!.mapImage) : null);
  w.setImage = (d, name) => {
    const a = w.assets.assets.get(assetIds[name]!)!;
    maps.get(d)!.mapImage = {
      assetId: a.id,
      url: a.url ?? `https://assets.legendkeeper.com/${randomUUID()}.webp`,
      ...appFrame(a.width ?? 512, a.height ?? 768),
    };
  };
  w.failAt = (op, n, response = err(400, 'VALIDATION_ERROR')) => faults.push({ op, n, seen: 0, response });
  w.mark = () => {
    const from = w.seen.length;
    return () => {
      const lines = w.seen.slice(from);
      return {
        reads: lines.filter((l) => l.startsWith('GET ')).length,
        writes: lines.filter((l) => !l.startsWith('GET ')).length,
        lines,
      };
    };
  };
  w.docType = (d) => docRec(d)!.type;
  return w;
}
