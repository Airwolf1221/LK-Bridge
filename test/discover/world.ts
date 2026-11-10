/**
 * The test world for the Discover and Read tools (v2 B2): a realistic AI REPOSITORY (A2's `TreeModel`: Characters with
 * groups, races and character indexes; a chronology with a page, a timeline, a map and a board; duplicate names; a
 * large index; an unclassified page; templates and a page outside the root) and an asset library (A4's `AssetModel`:
 * the spike's 18 folders and 559 images), behind chunk 1's mock LegendKeeper and the REAL server. The bridge's own
 * repository tree and asset tree are filled from the models exactly as a build would leave them (through the stores),
 * so every tool is tested against the real query layers, registry, converter, job engine and MCP transport.
 */
import { observationFromAsset } from '../../src/assets/index.js';
import { ProjectStore } from '../../src/projects/index.js';
import { observationFromResource } from '../../src/tree/index.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { AssetModel } from '../assets/model.js';
import { TreeModel, type Res } from '../tree/model.js';
import { PROJECT, startStack, type Stack, type StackOptions } from '../tools/helpers.js';

export interface DiscoverWorld {
  readonly stack: Stack;
  readonly repo: TreeModel;
  readonly assets: AssetModel;
  readonly ids: Record<string, string>;
  readonly docs: Record<string, string>;
  /** Live reads the mock answered, by request line. */
  readonly seen: string[];
  /** Replaces what a live read of a path answers (a function of the request), until the world closes. */
  readonly overrides: Map<RegExp, (req: MockRequest) => MockResponse | undefined>;
  close(): Promise<void>;
}

export const ROOT = 'airepo01';

const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});

/** The Fourth Age table page: a heading, a note, then a table of `rows` events (a large page). */
export function ageTable(rows: number) {
  const cell = (id: string, text: string) => ({
    id,
    kind: 'tableCell',
    children: [{ id: `${id}p`, kind: 'paragraph', content: [{ text }] }],
  });
  const row = (i: number, cells: string[]) => ({
    id: `row${i}`,
    kind: 'tableRow',
    children: cells.map((t, c) => cell(`c${i}_${c}`, t)),
  });
  return [
    heading('h1', 1, 'Fourth Age - Table'),
    para('p1', 'Every dated event of the Fourth Age, in calendar order.'),
    {
      id: 'tbl1',
      kind: 'table',
      children: [
        row(0, ['Historical Event', 'Date', 'KCY']),
        ...Array.from({ length: rows }, (_, i) =>
          row(i + 1, [
            `Event ${i + 1}: the council of ${['Ashgate', 'Isar', 'the Hollow Court'][i % 3]} meets and records its decisions at length`,
            `Azah ${(i % 28) + 1}${['st', 'nd', 'rd'][i % 3] ?? 'th'}, 4A ${Math.floor(i / 10) + 1}`,
            String(1250307 + Math.floor(i / 10) + 1),
          ]),
        ),
      ],
    },
  ];
}

export async function discoverWorld(
  o: StackOptions & { bulk?: number; ageRows?: number; build?: boolean } = {},
): Promise<DiscoverWorld> {
  const seen: string[] = [];
  const overrides = new Map<RegExp, (req: MockRequest) => MockResponse | undefined>();
  let now = () => Date.now();
  const repo = new TreeModel(() => now());
  const assets = new AssetModel(() => now());
  const ids: Record<string, string> = {};
  const docs: Record<string, string> = {};

  // ------------------------------------------------------------------------------------------ the repository
  const root = repo.seed({ id: ROOT, name: 'AI REPOSITORY' });
  const page = (
    key: string,
    id: string,
    name: string,
    parent: string,
    more: Parameters<TreeModel['seed']>[0] extends infer T ? Partial<T> : never = {},
  ): Res => {
    ids[key] = id;
    return repo.seed({ id, name, parentId: parent, ...more });
  };
  const chars = page('characters', 'chars001', '[INDEX] Characters', root.id, { scope: 'Arkona' });
  const beast = page('beastkin', 'beast001', '[INDEX] Beastkin', chars.id, { scope: 'Arkona; Beastkin' });
  const foxians = page('foxians', 'foxian01', '[INDEX] Foxians', beast.id, {
    scope: 'Arkona; Beastkin; Foxians',
  });
  const qishen = page('qishen', 'qishen01', '[INDEX] Qishen', beast.id, { scope: 'Arkona; Qishen' });
  const miyabiIdx = page('miyabiIndex', 'miyaidx1', '[INDEX] Asagiri Miyabi', foxians.id);
  const miyabi = page('miyabi', 'miyabi01', '[BSRC] Asagiri Miyabi', miyabiIdx.id, {
    referenceType: 'Character Core',
    scope: 'Foxian shrine maiden of the Hollow Court',
    tags: ['canon', 'elder'],
    aliases: ['Miyabi-sama', 'The Quiet Maiden'],
    canonical: 'Asagiri Miyabi (Foxian)',
  });
  page('kaede', 'kaede001', '[BSRC] Asagiri Kaede', foxians.id, {
    referenceType: 'Compact Character Reference',
    scope: 'Foxian, sister of Miyabi',
    tags: ['canon'],
  });
  page('mehrana', 'mehran01', '[BSRC] Mehrana al-Khalid', qishen.id, {
    referenceType: 'Character Core',
    scope: 'Qishen scholar',
    tags: ['draft'],
  });
  const elves = page('elves', 'elves001', '[INDEX] Elves', chars.id);
  const moon = page('moonElves', 'moonelf1', '[INDEX] Moon Elves', elves.id);
  page('inae', 'inae0001', '[BSRC] Inae Mikumo', moon.id, {
    referenceType: 'Character Core',
    scope: 'Moon elf archer',
  });
  page('unknown', 'unknown1', '[INDEX] Undetermined / Unknown', chars.id);
  const humans = page('humans', 'humans01', '[INDEX] Humans', chars.id);
  page('kumi', 'kumi0001', '[BSRC] Kumi the Elder', humans.id, {
    referenceType: 'Compact Character Reference',
    tags: ['elder', 'canon'],
  });
  const locations = page('locations', 'locs0001', '[INDEX] Locations', root.id);
  const a1 = page(
    'ashgateKumikas',
    'ashg0001',
    '[BSRC] Ashgate',
    page('kumikasIdx', 'kumi_idx', '[INDEX] Kumikas', locations.id).id,
    {
      referenceType: 'General Source',
      scope: 'A walled town',
    },
  );
  page(
    'ashgateIsar',
    'ashg0002',
    '[BSRC] Ashgate',
    page('isarIdx', 'isar_idx', '[INDEX] Isar', locations.id).id,
    {
      referenceType: 'General Source',
      scope: 'A harbour',
    },
  );
  void a1;
  const chron = page('chronology', 'chron001', '[INDEX] Universal Chronology', root.id);
  const age = page('fourthAge', 'age40001', '[BSRC] Fourth Age - Table', chron.id, {
    referenceType: 'Chronology Table',
  });
  const timeline = page('fourthTimeline', 'age4tl01', '[BSRC] Fourth Age - Timeline', chron.id, {
    referenceType: 'Timeline',
  });
  const maps = page('maps', 'maps0001', '[BSRC] World Maps', root.id, { referenceType: 'General Source' });
  const board = page('board', 'board001', '[BSRC] Plot Board', root.id, { referenceType: 'General Source' });
  page('loose', 'loose001', 'Loose notes about nothing', root.id, { props: false });

  // Bulk: a realistic number of sources under several indexes, one of them very large.
  const bulk = o.bulk ?? 1200;
  const sources = page('sources', 'srcs0001', '[INDEX] Sources', root.id);
  const big = page('bigIndex', 'bigidx01', '[INDEX] Great Chronicles', sources.id);
  const groups: Res[] = [];
  for (let g = 0; g < 20; g++)
    groups.push(page(`group${g}`, `grp${g.toString(36).padStart(5, '0')}`, `[INDEX] Group ${g}`, sources.id));
  for (let i = 0; i < bulk; i++) {
    const parent = i % 4 === 0 ? big : groups[i % groups.length]!;
    repo.seed({
      id: `bk${i.toString(36).padStart(6, '0')}`,
      name: `[BSRC] Source ${i} of the ${['Ashgate', 'Isar', 'Hollow', 'Winter'][i % 4]} cycle`,
      parentId: parent.id,
      referenceType: 'General Source',
      scope: 'A long descriptive scope line for source number ' + i + ' that runs for a while',
      tags: i % 9 === 0 ? ['canon'] : i % 13 === 0 ? ['draft'] : [],
    });
  }
  // Outside the root: the templates, and a page.
  for (let t = 0; t < 14; t++)
    repo.seed({
      id: `tpl${t.toString(36).padStart(5, '0')}`,
      name: `[BSRC] AI Template ${t}`,
      parentId: null,
    });
  ids.outside = 'outside1';
  repo.seed({ id: 'outside1', name: 'Outside page', parentId: null });

  // Documents: a biography page, the age table, a timeline, a map and a board.
  const mainOf = (r: Res) => repo.liveDocs(r).find((d) => d.name === 'Main')!;
  docs.miyabiMain = mainOf(miyabi).id;
  repo.blocks.set(docs.miyabiMain, {
    version: 3,
    blocks: [
      heading('mh1', 1, 'Asagiri Miyabi'),
      para('mp1', 'A Foxian shrine maiden.'),
      heading('mh2', 2, 'Biography'),
      heading('mh3', 3, 'Early Life'),
      para('mp2', 'Born on Kumikas 1st, 4A 881.'),
      heading('mh4', 3, 'Notes'),
      para('mp3', 'First notes.'),
      heading('mh5', 2, 'Relations'),
      heading('mh6', 3, 'Notes'),
      para('mp4', 'Second notes.'),
      { id: 'unsup1', kind: 'unsupported' },
    ],
  });
  docs.ageMain = mainOf(age).id;
  repo.blocks.set(docs.ageMain, { version: 7, blocks: ageTable(o.ageRows ?? 600) });
  const tl = repo.outside.addDocument(timeline.id, 'Fourth Age - Timeline', 'time');
  const mp = repo.outside.addDocument(maps.id, 'Arkona map', 'map');
  repo.outside.deleteDocument(mainOf(maps).id); // World Maps has the map and no Main
  const bd = repo.outside.addDocument(board.id, 'Plot board', 'board');
  docs.timeline = tl.id;
  docs.map = mp.id;
  docs.board = bd.id;

  // ------------------------------------------------------------------------------------------ the asset library
  const aw = assets.testWorld();
  void aw;

  // ------------------------------------------------------------------------------------------ the live answers
  const extras = (req: MockRequest): MockResponse | undefined => {
    const qs = new URLSearchParams(req.query).toString();
    seen.push(
      `${req.method} ${req.path.replace(/^\/api\/v3\/projects\/[^/]+/, '').replace(/\/$/, '')}${qs ? '?' + qs : ''}`,
    );
    for (const [re, fn] of overrides) {
      if (re.test(req.path.replace(/\/$/, ''))) {
        const r = fn(req);
        if (r) return r;
      }
    }
    const p = req.path.replace(/^\/api\/v3\/projects\/[^/]+/, '').replace(/\/$/, '');
    if (req.method !== 'GET') return undefined;
    if (p === '/templates')
      return {
        status: 200,
        body: {
          data: Array.from({ length: 14 }, (_, t) => ({
            id: `tpl${t.toString(36).padStart(5, '0')}`,
            name: `[BSRC] AI Template ${t}`,
            parentId: null,
          })),
          hasMore: false,
          nextCursor: null,
        },
      };
    if (p === '/calendars')
      return {
        status: 200,
        body: {
          data: [
            {
              id: 'rp86pkdr',
              name: 'Kumikan Epochal',
              hasZeroYear: false,
              months: ['Kumikas', 'Isar', 'Selaphos', 'Azah', 'Selyros'].map((n, i) => ({
                id: `m${i}`,
                name: n,
                isIntercalary: false,
                length: 30,
                interval: 1,
                offset: 0,
              })),
              leapDays: [],
              weekdays: [{ id: 'w1', name: 'Day' }],
              hoursInDay: 30,
              minutesInHour: 60,
              negativeEra: {
                id: 'e0',
                name: 'Before Epoch',
                abbr: 'AA',
                startsAt: -100000,
                resetMode: 'none',
              },
              positiveEras: [{ id: 'e1', name: 'First Age', abbr: '1A', startsAt: 0, resetMode: 'year' }],
              format: { id: 'f', year: 'E YYYY', month: 'MMMM, E YYYY', day: 'MMMM D^, E YYYY', time: 'x' },
              version: 'cv1',
            },
          ],
          hasMore: false,
          nextCursor: null,
        },
      };
    const m = /^\/resources\/([^/]+)(?:\/docs\/([^/]+)\/(features|lanes|events|board))?$/.exec(p);
    if (m) {
      const [, rid, did, what] = m;
      if (what === 'features' && did === docs.map)
        return {
          status: 200,
          body: {
            data: [
              {
                id: 'f1',
                name: 'Ashgate',
                type: 'pin',
                pos: [12.5, 40.25],
                uri: 'lk://resources/ashg0001',
                rank: 'a',
              },
              { id: 'f2', name: 'The Weeping Sea', type: 'region', rank: 'b' },
            ],
          },
        };
      if (what === 'lanes' && did === docs.timeline)
        return { status: 200, body: { data: [{ id: 'l1', name: 'Historical Events', rank: 'a' }] } };
      if (what === 'events' && did === docs.timeline)
        return {
          status: 200,
          body: {
            data: [
              {
                id: 'ev2',
                laneId: 'l1',
                name: 'Fall of Ashgate',
                start: 200,
                end: 200,
                formattedStart: 'Azah 18th, 4A 139',
                rank: 'b',
                uri: 'lk://resources/age40001',
              },
              {
                id: 'ev1',
                laneId: 'l1',
                name: 'The Long Winter',
                start: 100,
                end: 160,
                formattedStart: 'Azah 18th, 4A 1',
                formattedEnd: 'Kumikas 3rd, 4A 3',
                rank: 'a',
              },
            ],
            hasMore: false,
            nextCursor: null,
          },
        };
      if (what === 'board' && did === docs.board)
        return {
          status: 200,
          body: {
            version: 'b1',
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
              { id: 'b1', fromId: 'shape:3', toId: 'shape:1', props: { terminal: 'start' } },
              { id: 'b2', fromId: 'shape:3', toId: 'shape:2', props: { terminal: 'end' } },
            ],
          },
        };
      if (rid === miyabi.id && !did) {
        const view = repo.resourceView(repo.live(rid)!);
        return {
          status: 200,
          body: {
            ...view,
            updatedAt: '2026-11-09T10:00:00Z',
            properties: [
              {
                id: 'kv1',
                kind: 'keyValue',
                title: 'PROPERTIES',
                version: 'pv3',
                rows: [
                  {
                    id: 'r1',
                    rank: 'a',
                    key: 'Reference Type',
                    text: 'Character Core',
                    content: [{ text: 'Character Core' }],
                  },
                  {
                    id: 'r2',
                    rank: 'b',
                    key: 'Scope',
                    text: 'Foxian shrine maiden of the Hollow Court',
                    content: [{ text: 'Foxian shrine maiden of the Hollow Court' }],
                  },
                  {
                    id: 'r3',
                    rank: 'c',
                    key: 'Sister',
                    text: 'Asagiri Kaede',
                    content: [{ mention: { resourceId: 'kaede001', text: 'Asagiri Kaede' } }],
                  },
                ],
              },
              {
                id: 'dep1',
                kind: 'resourceCollection',
                title: 'Dependencies',
                items: [
                  { id: 'i1', rank: 'a', resourceId: 'age40001', documentId: docs.ageMain },
                  { id: 'i2', rank: 'b', resourceId: 'kaede001' },
                  { id: 'i3', rank: 'c', resourceId: 'outside1' },
                ],
              },
              {
                id: 'rel1',
                kind: 'resourceLink',
                title: 'Related Sources',
                items: [{ id: 'j1', resourceId: 'mehran01' }],
              },
              { id: 'tags1', kind: 'unsupported', title: 'TAGS' },
            ],
          },
        };
      }
    }
    if (p === '/search') {
      const q = req.query.q ?? '';
      const hit = (r: Res) => ({
        resource: { id: r.id, name: r.name, tags: r.tags, parentId: r.parentId, path: pathOf(r) },
        document: { id: 'd', name: 'Main' },
      });
      const pathOf = (r: Res): { id: string; name: string }[] => {
        const out: { id: string; name: string }[] = [];
        for (
          let c = r.parentId ? repo.res.get(r.parentId) : undefined;
          c;
          c = c.parentId ? repo.res.get(c.parentId) : undefined
        )
          out.unshift({ id: c.id, name: c.name });
        return out;
      };
      const found = q.toLowerCase().includes('quietly')
        ? [repo.res.get('kaede001')!, repo.res.get('outside1')!, repo.res.get('mehran01')!]
        : [];
      // A resource appears once per matching document: repeat the first.
      return {
        status: 200,
        body: { data: [...found, ...found.slice(0, 1)].map(hit), hasMore: false, nextCursor: null },
      };
    }
    return undefined;
  };

  const stack = await startStack({
    ...o,
    respond: (req) => extras(req) ?? repo.respond(req) ?? assets.respond(req) ?? o.respond?.(req),
  });
  now = () => Date.now();

  // ------------------------------------------------------------------------------------------ the bridge's own models
  if (o.build !== false) {
    buildModels(stack, repo, assets);
  }
  return {
    stack,
    repo,
    assets,
    ids,
    docs,
    seen,
    overrides,
    close: () => stack.close(),
  };
}

/** Fills the bridge's repository tree and asset tree from the models, as a finished build leaves them. */
export function buildModels(
  stack: Pick<Stack, 'runtime' | 'db'>,
  repo: TreeModel,
  assets: AssetModel,
  projectId = PROJECT,
  rootId = ROOT,
): void {
  const { runtime, db } = stack;
  new ProjectStore(db).setSetting(projectId, 'aiRepositoryRootId', rootId);
  const tree = runtime.tree;
  tree.store.ensureRoot(projectId, rootId);
  const ctx = { projectId, rootId, settings: tree.settings(projectId), by: 'build' as const };
  let t = Date.now() * 1000;
  for (const r of repo.subtree(rootId)) {
    const obs = observationFromResource(repo.resourceView(r));
    if (obs) tree.store.applyObservation(ctx, obs, ++t);
  }
  tree.store.recomputePaths(projectId, rootId);
  tree.store.setConfirmed(projectId, Date.now(), 'build');
  const actx = { projectId, by: 'build' as const };
  const folders = [...assets.assets.values()].filter((a) => a.type === 'FOLDER');
  const items = [...assets.assets.values()].filter((a) => a.type !== 'FOLDER');
  // Folders parents-first (a folder before what is in it).
  const placed = new Set<string | null>([null]);
  let pending = folders;
  while (pending.length > 0) {
    const next = pending.filter((f) => !placed.has(f.folderId));
    const ready = pending.filter((f) => placed.has(f.folderId));
    if (ready.length === 0) break;
    for (const f of ready) {
      const obs = observationFromAsset(f);
      if (obs) runtime.assets.store.applyObservation(actx, obs, ++t);
      placed.add(f.id);
    }
    pending = next;
  }
  for (const a of items) {
    const obs = observationFromAsset({
      ...a,
      url: a.url ?? `https://assets.legendkeeper.com/test/${a.id}.webp`,
    });
    if (obs) runtime.assets.store.applyObservation(actx, obs, ++t);
  }
  runtime.assets.store.setConfirmed(projectId, Date.now(), 'build');
}

export const text = (c: { text?: string }[]): string => c.map((x) => x.text ?? '').join('\n');
