/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- mock LK JSON */
/**
 * The E1a test world (ADR 0042): C2b's resources world (the REAL server, runtime, policy, engine, tree, MCP transport,
 * C2a's faithful sidebars, the lifecycle indexes confirmed) against the mock LegendKeeper, plus:
 *
 * - a small asset library (two folders, three images) served by a local https asset host (`assets.test`), so image
 *   bytes download exactly as in production (anonymous GET through the guarded transport), and nothing goes out;
 * - `[BSRC] Atlas of Snapshots` under `[INDEX] Locations`, with a document of every type: `Main` (a page: headings,
 *   a mention, an image block, an `unsupported` block, a table a Markdown keep region holds), `Map` (an image, a folder,
 *   pins and a region), `Chronicle` (a timeline: two lanes, three events), `Plot` (a board: a page, shapes, a binding)
 *   and `Notes` (blank); its sidebar has PROPERTIES and two link collections;
 * - stateful models of map features, timeline lanes and events and board content (with versions), with every write the
 *   restores use (create with a client id, update, delete; replaceBoardContent with If-Match), and getDocument giving a
 *   map's `mapImage` and a timeline's `calendarId`;
 * - the snapshot store in the stack's own temporary directory (nothing is written elsewhere).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { join } from 'node:path';
import { parseOutboundPortAllowlist } from '../../src/auth/ports.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_SNAPSHOT_SETTINGS,
  DEFAULT_TOOLS_SETTINGS,
  type SnapshotStoreSettings,
} from '../../src/config/index.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { buildModels } from '../discover/world.js';
import { labelSizeListRefusal, labelSizeWriteRefusal } from '../maps/label-size-bug.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { resourcesWorld, SidebarModel, type ResourcesWorld } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { newId } from '../tree/model.js';

type Obj = Record<string, any>;

export const S = {
  locations: 'locs0001',
  atlas: 'atlas5np',
  /** An Authoritative page (Status Authoritative, CANON), for the lifecycle tools and the canon guard. */
  harbour: 'harbour1',
  folderA: 'fldra001',
  folderB: 'fldrb001',
  imgSea: 'imgsea01',
  imgCrest: 'imgcrst1',
  imgMap: 'imgmap01',
} as const;

export interface SnapshotsWorld extends ResourcesWorld {
  readonly port: number;
  readonly dir: string;
  readonly snapshotDir: string;
  /** The Atlas page's documents by name. */
  readonly d: { main: string; map: string; chronicle: string; plot: string; notes: string };
  /** Bytes the asset host serves, by asset id. */
  readonly served: Map<string, Buffer>;
  /** GETs the asset host answered. */
  readonly gets: string[];
  /**
   * v2 E5.2: asset ids whose file `assets.test` serves as a 302 to the same path on `assets2.test` (as LegendKeeper
   * serves some files from `assets2`).
   */
  readonly movedToAssets2: Set<string>;
  /** Every GET of an asset file: the host asked and the request's headers. */
  readonly assetRequests: { host: string; path: string; headers: Record<string, unknown> }[];
  /**
   * v2 E5.4: every body a feature write (POST or PATCH) brought, in order, whether the model took it or not: what
   * LegendKeeper was actually sent.
   */
  readonly featureWrites: { readonly method: string; readonly body: Obj }[];
  /**
   * v2 E5.4: LegendKeeper's label-size bug (on by default): `listFeatures` refuses a map holding any label size but
   * small/medium/large, and a write refuses any but xs–3xl. A test turns it off to stage a map LegendKeeper could not list.
   */
  readonly bugs: { labelSize: boolean };
  /** v2 E5.4: answers a map's `listFeatures` instead of the model when it returns a response (test seam). */
  listHook: ((documentId: string) => MockResponse | undefined) | null;
  /** The stored model of a map's features, a timeline's lanes and events, a board's content. */
  readonly features: Map<string, Obj[]>;
  readonly lanes: Map<string, Obj[]>;
  readonly events: Map<string, Obj[]>;
  readonly boards: Map<string, { version: number; content: Obj }>;
  readonly docExtra: Map<string, Obj>;
  url(assetId: string): string;
  sha(assetId: string): string;
  /** A new image in the library (served by the asset host). */
  addImage(name: string, folderId: string | null, bytes: Buffer, id?: string): string;
  close(): Promise<void>;
}

let certCache: { key: Buffer; cert: string } | null = null;
function certificate(): { key: Buffer; cert: string } {
  if (certCache) return certCache;
  const dir = mkdtempSync(join(tmpdir(), 'lkb-snap-cert-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=assets.test',
      '-addext',
      'subjectAltName=DNS:assets.test,DNS:assets2.test,DNS:storage.test',
    ],
    { stdio: 'ignore' },
  );
  certCache = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return certCache;
}

/** An icon LegendKeeper was sent as a bare name (`book`) reads back as a class string (`fas fa-book`). */
function readIcon<T extends Obj>(o: T): T {
  if (typeof o.iconGlyph === 'string' && !/^fa/.test(o.iconGlyph))
    (o as Obj).iconGlyph = `fas fa-${o.iconGlyph}`;
  return o;
}

const err = (status: number, code: string): MockResponse => ({
  status,
  body: { message: `model ${code}`, code, requestId: `snap-${code}` },
});

export async function snapshotsWorld(
  o: Parameters<typeof resourcesWorld>[0] & { readonly snapshots?: Partial<SnapshotStoreSettings> } = {},
): Promise<SnapshotsWorld> {
  const { key, cert } = certificate();
  const served = new Map<string, Buffer>();
  const gets: string[] = [];
  const movedToAssets2 = new Set<string>();
  const featureWrites: SnapshotsWorld['featureWrites'] = [];
  const bugs = { labelSize: true };
  // The returned world, once made: the routes read its `listHook` when a request comes.
  let world: { listHook: SnapshotsWorld['listHook'] } = { listHook: null };
  const assetRequests: SnapshotsWorld['assetRequests'] = [];
  const puts = new Map<string, Buffer>();
  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!;
      if (req.method === 'PUT' && url.startsWith('/put/')) {
        puts.set(url.slice(5), Buffer.concat(chunks));
        return void res.writeHead(200).end();
      }
      if (req.method === 'GET' && url.startsWith('/a/')) {
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        assetRequests.push({ host, path: url, headers: { ...req.headers } });
        const id = url.slice(3).replace(/\.webp$/, '');
        if (host === 'assets.test' && movedToAssets2.has(id)) {
          res.writeHead(302, { location: `https://assets2.test:${port}${url}`, 'content-length': 0 });
          return void res.end();
        }
        gets.push(url);
        const b = served.get(id);
        if (!b) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'image/webp', 'content-length': b.length });
        return void res.end(b);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const guard: GuardOptions = {
    resolve: (host) =>
      Promise.resolve(host.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 as const }] : []),
    ca: cert,
    allowAddress: (a) => a === '127.0.0.1',
    allowedPorts: parseOutboundPortAllowlist(`assets.test:${port},assets2.test:${port},storage.test:${port}`),
  };
  const dir = mkdtempSync(join(tmpdir(), 'lkb-snapshots-world-'));
  const snapshotDir = join(dir, 'snapshots');
  const url = (id: string) => `https://assets.test:${port}/a/${id}.webp`;
  const features = new Map<string, Obj[]>();
  const lanes = new Map<string, Obj[]>();
  const events = new Map<string, Obj[]>();
  const boards = new Map<string, { version: number; content: Obj }>();
  const docExtra = new Map<string, Obj>();
  const d = { main: '', map: '', chronicle: '', plot: '', notes: '' };

  const w = (await resourcesWorld({
    bulk: 6,
    ...o,
    // Full snapshots read at P3, which stops at half of each tier; a test takes several in a minute.
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }), ...o.env },
    limits: { 'key-min': 5000, 'write-min': 2000, ...o.limits },
    uploadGuard: guard,
    tools: {
      ...DEFAULT_TOOLS_SETTINGS,
      ...o.tools,
      images: {
        ...DEFAULT_IMAGE_SETTINGS,
        assetHosts: ['assets.test', 'assets2.test'],
        dataDir: join(dir, 'images'),
      },
      snapshots: { ...DEFAULT_SNAPSHOT_SETTINGS, dataDir: snapshotDir, minFreeBytes: 0, ...o.snapshots },
    },
    seed: (world) => {
      const atlas = world.repo.seed({
        id: S.atlas,
        name: '[BSRC] Atlas of Snapshots',
        parentId: S.locations,
        referenceType: 'General Source',
        scope: 'Every document type',
        tags: ['atlas'],
      });
      const main = world.repo.liveDocs(atlas).find((x) => x.name === 'Main')!;
      d.main = main.id;
      d.map = world.repo.outside.addDocument(atlas.id, 'Map', 'map').id;
      d.chronicle = world.repo.outside.addDocument(atlas.id, 'Chronicle', 'time').id;
      d.plot = world.repo.outside.addDocument(atlas.id, 'Plot', 'board').id;
      d.notes = world.repo.outside.addDocument(atlas.id, 'Notes', 'blank').id;
      world.repo.seed({
        id: S.harbour,
        name: '[BSRC] Old Harbour',
        parentId: S.locations,
        referenceType: 'General Source',
        scope: 'A harbour town on the Weeping Sea',
        tags: ['CANON', 'port'],
      });
      o.seed?.(world);
    },
  })) as SnapshotsWorld;

  // ------------------------------------------------------------------------------------------ the asset library
  // The discover world's 559-image library is replaced with a small one on the local asset host.
  w.assets.assets.clear();
  const fA = w.assets.folder('Characters', null, S.folderA);
  const fB = w.assets.folder('Maps', null, S.folderB);
  const addImage = (name: string, folderId: string | null, bytes: Buffer, id?: string): string => {
    const aid = w.assets.image(name, folderId, { ...(id ? { id } : {}), width: 64, height: 32 });
    const a = w.assets.assets.get(aid)!;
    (a as Obj).url = url(aid);
    served.set(aid, bytes);
    return aid;
  };
  // Real (tiny) WebP files, each its own colour: a restored image goes through D3's converter, which decodes them.
  const webp = (r: number, g: number, b: number) =>
    sharp({ create: { width: 8, height: 4, channels: 3, background: { r, g, b } } })
      .webp()
      .toBuffer();
  addImage('Weeping Sea', fA, await webp(20, 60, 140), S.imgSea);
  addImage('Crest', fA, await webp(180, 30, 30), S.imgCrest);
  addImage('Arkona map', fB, await webp(40, 140, 60), S.imgMap);
  w.stack.db.prepare('DELETE FROM asset_items WHERE project_id = ?').run(PROJECT);
  w.stack.db.prepare('DELETE FROM asset_folders WHERE project_id = ?').run(PROJECT);
  // The bridge's models again (the asset tree from the small library; the repository tree already has the Atlas).
  buildModels(w.stack, w.repo, w.assets);

  // ------------------------------------------------------------------------------------------ the Atlas
  w.repo.blocks.set(d.main, {
    version: 4,
    blocks: [
      { id: 'ah1', kind: 'heading', level: 1, content: [{ text: 'Atlas of Snapshots' }] },
      {
        id: 'ap1',
        kind: 'paragraph',
        content: [
          { text: 'Drawn by ' },
          { mention: { resourceId: 'miyabi01', name: '[BSRC] Asagiri Miyabi' } },
          { text: '.' },
        ],
      },
      { id: 'aimg', kind: 'image', url: url(S.imgSea), alt: 'The Weeping Sea' },
      { id: 'aun1', kind: 'unsupported' },
      {
        id: 'atb1',
        kind: 'table',
        children: [
          {
            id: 'atr1',
            kind: 'tableRow',
            children: [
              {
                id: 'atc1',
                kind: 'tableCell',
                colspan: 2,
                children: [{ id: 'atp1', kind: 'paragraph', content: [{ text: 'Merged' }] }],
              },
            ],
          },
        ],
      },
      { id: 'ah2', kind: 'heading', level: 2, content: [{ text: 'Notes' }] },
      { id: 'ap2', kind: 'paragraph', content: [{ text: 'First notes.' }] },
    ],
  });
  docExtra.set(d.map, {
    mapImage: {
      assetId: S.imgMap,
      url: url(S.imgMap),
      width: 2048,
      height: 1024,
      bounds: [
        [-128, 0],
        [0, 256],
      ],
    },
  });
  features.set(d.map, [
    { id: 'fold0001', type: 'folder', name: 'Towns', rank: 'a0' },
    {
      id: 'pin00001',
      type: 'pin',
      name: 'Ashgate',
      pos: [-10, 20],
      parentId: 'fold0001',
      uri: 'lk://resources/ashg0001',
      rank: 'a1',
    },
    { id: 'pin00002', type: 'pin', name: 'Isar', pos: [-40, 60], parentId: 'fold0001', rank: 'a2' },
    {
      id: 'reg00001',
      type: 'region',
      name: 'The Weeping Sea',
      polygon: [
        [-1, 1],
        [-2, 2],
        [-3, 1],
      ],
      color: '#336699',
      rank: 'a3',
    },
  ]);
  docExtra.set(d.chronicle, { calendarId: 'rp86pkdr' });
  lanes.set(d.chronicle, [
    { id: 'lane0001', name: 'Historical Events', rank: 'a', size: 'sm' },
    { id: 'lane0002', name: 'Rumours', rank: 'b', size: 'lg' },
  ]);
  events.set(d.chronicle, [
    {
      id: 'evt00001',
      laneId: 'lane0001',
      type: 'event',
      name: 'Founding of Ashgate',
      start: 100,
      end: 100,
      detail: 1,
      rank: 'a',
      uri: 'lk://resources/ashg0001',
    },
    {
      id: 'evt00002',
      laneId: 'lane0001',
      type: 'event',
      name: 'The Long Winter',
      start: 200,
      end: 260,
      detail: 2,
      rank: 'b',
    },
    {
      id: 'evt00003',
      laneId: 'lane0002',
      type: 'note',
      name: 'A ghost on the road',
      start: 300,
      end: 300,
      detail: 3,
      rank: 'a',
    },
  ]);
  boards.set(d.plot, {
    version: 3,
    content: {
      schema: { schemaVersion: 2 },
      pages: [{ id: 'page:1', name: 'Plot', index: 'a1' }],
      shapes: [
        {
          id: 'shape:1',
          type: 'geo',
          parentId: 'page:1',
          index: 'a1',
          props: { geo: 'rectangle', text: 'Miyabi' },
        },
        {
          id: 'shape:2',
          type: 'geo',
          parentId: 'page:1',
          index: 'a2',
          props: { geo: 'ellipse', text: 'Kaede' },
        },
        { id: 'shape:3', type: 'arrow', parentId: 'page:1', index: 'a3', props: { text: 'sisters' } },
      ],
      bindings: [
        { id: 'binding:1', type: 'arrow', fromId: 'shape:3', toId: 'shape:1', props: { terminal: 'start' } },
      ],
      assets: [],
    },
  });
  w.sidebars.page(S.harbour, [
    SidebarModel.kv('kvharb01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Scope', 'A harbour town on the Weeping Sea'],
      ['Temporal Scope', 'Fourth Age'],
    ]),
    SidebarModel.links('depharb1', 'Dependencies', []),
  ]);
  w.repo.blocks.set(w.repo.liveDocs(w.repo.res.get(S.harbour)!).find((x) => x.name === 'Main')!.id, {
    version: 2,
    blocks: [
      { id: 'hb1', kind: 'heading', level: 1, content: [{ text: 'Old Harbour' }] },
      { id: 'hp1', kind: 'paragraph', content: [{ text: 'A harbour town.' }] },
    ],
  });
  w.sidebars.page(S.atlas, [
    SidebarModel.kv('kvatlas1', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Scope', 'Every document type'],
      ['Status', 'Outline'],
      ['Region', [{ text: 'See ' }, { mention: { resourceId: 'ashg0001', text: 'Ashgate' } }]],
    ]),
    SidebarModel.links('depatlas', 'Dependencies', [{ resourceId: 'miyabi01' }]),
    SidebarModel.links('relatlas', 'Related Sources', []),
    { id: 'tagatlas', kind: 'unsupported', title: 'TAGS' },
  ]);

  // ------------------------------------------------------------------------------------------ the document routes
  const docPath =
    /^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)\/docs\/([^/]+)(?:\/(features|lanes|events|board)(?:\/([^/]+))?)?$/;
  const docLive = (rid: string, did: string) => {
    const r = w.repo.live(rid);
    const doc = w.repo.docs.get(did);
    return r && doc && doc.resourceId === rid && doc.deletedAt === null ? doc : null;
  };
  const sortRank = (a: Obj, b: Obj) =>
    String(a.rank ?? '') < String(b.rank ?? '') ? -1 : String(a.rank ?? '') > String(b.rank ?? '') ? 1 : 0;
  const docRoute = (req: MockRequest): MockResponse | undefined => {
    const m = docPath.exec(req.path.replace(/\/$/, ''));
    if (!m) return undefined;
    const [, rid, did, what, sub] = m as unknown as [
      string,
      string,
      string,
      string | undefined,
      string | undefined,
    ];
    const doc = docLive(rid, did);
    const body = (req.body ?? {}) as Obj;
    if (!what) {
      if (req.method !== 'GET' && req.method !== 'PATCH') return undefined;
      if (!doc) return undefined; // the tree model answers (404)
      if (req.method === 'PATCH') {
        if (body.mapImage && typeof body.mapImage === 'object') {
          const aid = (body.mapImage as Obj).assetId;
          const a = typeof aid === 'string' ? w.assets.assets.get(aid) : undefined;
          if (!a) return err(400, 'VALIDATION_ERROR');
          docExtra.set(did, {
            ...docExtra.get(did),
            mapImage: {
              assetId: aid,
              url: (a as Obj).url,
              width: 2048,
              height: 1024,
              bounds: [
                [-128, 0],
                [0, 256],
              ],
            },
          });
          if (doc.type === 'blank') doc.type = 'map';
        }
        if (typeof body.calendarId === 'string')
          docExtra.set(did, { ...docExtra.get(did), calendarId: body.calendarId });
        const r = w.repo.respond({ ...req, body: { ...body, mapImage: undefined, calendarId: undefined } });
        if (!r || r.status !== 200) return r;
        return { status: 200, body: { ...(r.body as Obj), ...docExtra.get(did) } };
      }
      return {
        status: 200,
        body: {
          id: doc.id,
          name: doc.name,
          type: doc.type,
          rank: doc.rank,
          isHidden: doc.isHidden,
          ...docExtra.get(did),
        },
      };
    }
    if (!doc) return err(404, 'NOT_FOUND');
    if (what === 'features') {
      if (req.method === 'POST' || req.method === 'PATCH')
        featureWrites.push({ method: req.method, body: structuredClone(body) });
      const list = features.get(did) ?? [];
      features.set(did, list);
      if (!sub && req.method === 'GET')
        return (
          world.listHook?.(did) ??
          (bugs.labelSize ? labelSizeListRefusal(list) : undefined) ?? {
            status: 200,
            body: { data: structuredClone([...list].sort(sortRank)) },
          }
        );
      if (!sub && req.method === 'POST') {
        const sized = bugs.labelSize ? labelSizeWriteRefusal(body) : undefined;
        if (sized) return sized;
        const id = typeof body.id === 'string' ? body.id : newId('f');
        if (list.some((f) => f.id === id)) return err(409, 'DUPLICATE_ID');
        const iconRefused = w.repo.iconError(body);
        if (iconRefused) return iconRefused;
        const f = readIcon({ ...structuredClone(body), id, rank: body.rank ?? `z${list.length}` });
        list.push(f);
        if (doc.type === 'blank') doc.type = 'map';
        return { status: 201, body: structuredClone(f) };
      }
      const f = list.find((x) => x.id === sub);
      if (!f) return err(404, 'NOT_FOUND');
      if (req.method === 'GET') return { status: 200, body: structuredClone(f) };
      if (req.method === 'PATCH') {
        const sized = bugs.labelSize ? labelSizeWriteRefusal(body) : undefined;
        if (sized) return sized;
        const iconRefused = w.repo.iconError(body);
        if (iconRefused) return iconRefused;
        for (const [k, v] of Object.entries(body))
          if (v === null) delete f[k];
          else f[k] = structuredClone(v);
        readIcon(f);
        return { status: 200, body: structuredClone(f) };
      }
      if (req.method === 'DELETE') {
        features.set(
          did,
          list.filter((x) => x !== f),
        );
        return { status: 204 };
      }
    }
    if (what === 'lanes') {
      const list = lanes.get(did) ?? [];
      lanes.set(did, list);
      if (!sub && req.method === 'GET')
        return { status: 200, body: { data: structuredClone([...list].sort(sortRank)) } };
      if (!sub && req.method === 'POST') {
        const id = typeof body.id === 'string' ? body.id : newId('l');
        if (list.some((f) => f.id === id)) return err(409, 'DUPLICATE_ID');
        const l = { ...structuredClone(body), id, rank: body.rank ?? `z${list.length}` };
        list.push(l);
        if (doc.type === 'blank') doc.type = 'time';
        return { status: 201, body: structuredClone(l) };
      }
      const l = list.find((x) => x.id === sub);
      if (!l) return err(404, 'NOT_FOUND');
      if (req.method === 'GET') return { status: 200, body: structuredClone(l) };
      if (req.method === 'PATCH') {
        Object.assign(l, structuredClone(body));
        return { status: 200, body: structuredClone(l) };
      }
      if (req.method === 'DELETE') {
        lanes.set(
          did,
          list.filter((x) => x !== l),
        );
        events.set(
          did,
          (events.get(did) ?? []).filter((e) => e.laneId !== l.id),
        );
        return { status: 204 };
      }
    }
    if (what === 'events') {
      const list = events.get(did) ?? [];
      events.set(did, list);
      if (!sub && req.method === 'GET') {
        const all = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
        const limit = Number(req.query.limit ?? 50);
        const at = Number(req.query.cursor ?? 0);
        const page = all.slice(at, at + limit);
        const more = at + limit < all.length;
        return {
          status: 200,
          body: { data: structuredClone(page), hasMore: more, nextCursor: more ? String(at + limit) : null },
        };
      }
      if (!sub && req.method === 'POST') {
        const id = typeof body.id === 'string' ? body.id : newId('e');
        if (list.some((f) => f.id === id)) return err(409, 'DUPLICATE_ID');
        if (!(lanes.get(did) ?? []).some((l) => l.id === body.laneId)) return err(400, 'VALIDATION_ERROR');
        const iconRefused = w.repo.iconError(body);
        if (iconRefused) return iconRefused;
        const e = readIcon({ ...structuredClone(body), id, rank: body.rank ?? `z${list.length}` });
        list.push(e);
        return { status: 201, body: structuredClone(e) };
      }
      const e = list.find((x) => x.id === sub);
      if (!e) return err(404, 'NOT_FOUND');
      if (req.method === 'GET') return { status: 200, body: structuredClone(e) };
      if (req.method === 'PATCH') {
        const iconRefused = w.repo.iconError(body);
        if (iconRefused) return iconRefused;
        Object.assign(e, structuredClone(body));
        readIcon(e);
        return { status: 200, body: structuredClone(e) };
      }
      if (req.method === 'DELETE') {
        events.set(
          did,
          list.filter((x) => x !== e),
        );
        return { status: 204 };
      }
    }
    if (what === 'board') {
      const b = boards.get(did) ?? {
        version: 1,
        content: {
          schema: { schemaVersion: 2 },
          pages: [{ id: 'page:page', name: 'Page 1', index: 'a1' }],
          shapes: [],
          bindings: [],
          assets: [],
        },
      };
      boards.set(did, b);
      const view = () => ({ ...structuredClone(b.content), version: `b${b.version}` });
      // createBoardShapes (v2 E1a's sandbox dry run): shapes added, each with a minted id when it has none.
      if (req.method === 'POST' && sub === 'shapes') {
        const added = ((body.shapes as Obj[] | undefined) ?? []).map((sh, i) => ({
          id: typeof sh.id === 'string' ? sh.id : `shape:n${b.version}x${i}`,
          parentId: 'page:page',
          index: `a${(b.content.shapes as Obj[]).length + i + 2}`,
          ...sh,
        }));
        b.content = { ...b.content, shapes: [...(b.content.shapes as Obj[]), ...added] };
        b.version++;
        if (doc.type === 'blank') doc.type = 'board';
        return { status: 201, body: view() };
      }
      if (sub) return undefined;
      if (req.method === 'GET') return { status: 200, body: view(), headers: { etag: `"b${b.version}"` } };
      if (req.method === 'PUT') {
        if (req.headers['if-match'] !== `b${b.version}`) return err(412, 'VERSION_MISMATCH');
        b.content = {
          ...b.content,
          shapes: structuredClone(body.shapes ?? []),
          bindings: structuredClone(body.bindings ?? []),
          assets: structuredClone(body.assets ?? []),
        };
        b.version++;
        if (doc.type === 'blank') doc.type = 'board';
        return { status: 200, body: view() };
      }
    }
    return undefined;
  };
  w.overrides.set(docPath, docRoute);

  // createResource with `documents` (the spec: 1–5 documents created in order, a page's blocks inline): the tree model
  // makes the resource with its blank Main, which becomes the first document; the rest are added.
  w.overrides.set(/\/resources$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const body = (req.body ?? {}) as Obj;
    const docs = Array.isArray(body.documents) ? (body.documents as Obj[]) : null;
    if (!docs) return undefined;
    const r = w.repo.respond({ ...req, body: { ...body, documents: undefined } });
    if (!r || r.status !== 201) return r;
    const res = w.repo.live((r.body as Obj).id as string)!;
    const main = w.repo.liveDocs(res)[0]!;
    docs.forEach((spec, i) => {
      const doc = i === 0 ? main : w.repo.outside.addDocument(res.id, 'Main', 'blank');
      doc.name = typeof spec.name === 'string' ? spec.name : 'Main';
      doc.type = typeof spec.type === 'string' ? spec.type : Array.isArray(spec.blocks) ? 'page' : 'blank';
      if (Array.isArray(spec.blocks))
        w.repo.blocks.set(doc.id, { version: 1, blocks: structuredClone(spec.blocks) });
      if (typeof spec.calendarId === 'string') docExtra.set(doc.id, { calendarId: spec.calendarId });
    });
    return { status: 201, body: w.repo.resourceView(res) };
  });

  // A property created on a page the sidebar model does not hold yet (a recreated or rehearsed page): the page joins the
  // model, so rows keep their runs and collections their items, as the spec says LegendKeeper stores them.
  w.overrides.set(/\/resources\/[^/]+\/properties$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const rid = req.path.replace(/\/$/, '').split('/').at(-2)!;
    if (!w.repo.live(rid)) return undefined;
    if (!w.sidebars.pages.has(rid)) w.sidebars.page(rid, []);
    return w.sidebars.respond(req, (x) => {
      const r = w.repo.live(x);
      return r ? w.repo.resourceView(r) : undefined;
    });
  });

  // Image uploads (a restored image becomes a new asset): the signed PUT goes to the local storage host.
  let uploads = 0;
  w.overrides.set(/\/assets\/uploads$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const k = `k${++uploads}`;
    return {
      status: 201,
      body: {
        uploadKey: k,
        uploadUrl: `https://storage.test:${port}/put/${k}`,
        method: 'PUT',
        headers: { 'content-type': (req.body as Obj).contentType },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };
  });
  w.overrides.set(/\/assets\/images$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const r = w.assets.respond(req);
    if (!r || r.status !== 201) return r;
    const id = (r.body as { id: string }).id;
    const a = w.assets.assets.get(id)! as Obj;
    a.url = url(id);
    const bytes = puts.get(String((req.body as Obj).uploadKey));
    if (bytes) served.set(id, bytes);
    return { status: 201, body: { ...(r.body as object), url: a.url } };
  });

  const closeWorld = (w as unknown as { close: () => Promise<void> }).close.bind(w);
  const made = Object.assign(w, {
    bugs,
    listHook: null as SnapshotsWorld['listHook'],
    port,
    dir,
    snapshotDir,
    d,
    served,
    gets,
    movedToAssets2,
    assetRequests,
    featureWrites,
    features,
    lanes,
    events,
    boards,
    docExtra,
    url,
    sha: (id: string) => createHash('sha256').update(served.get(id)!).digest('hex'),
    addImage,
    async close() {
      await closeWorld();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  });
  world = made;
  return made;
}
