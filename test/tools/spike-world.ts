/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- a JSON fixture */
/**
 * A small stateful LegendKeeper test world behind chunk 1's mock (`MockLk({ respond })`), for the phase 0 spike's dry
 * run. It answers the operations the spike uses, with the shapes the vendored OpenAPI spec describes: a repository tree
 * with indexes, articles, a map, an unclassified page and things outside the root; the Universal Chronology with its
 * Main page, an age table page and a timeline; a calendar; an asset tree; search; templates. Writes are applied to the
 * state so the dry run can see what the spike created and deleted.
 *
 * `nesting: 'refuse'` makes createManyResources refuse a parent minted in the same batch (the way LegendKeeper would if
 * the SDK guide's "an item may name an earlier item" did not hold); `failCreateNamed` makes createResource fail for a
 * name, to force a failure in check 1 after the throwaway root exists.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';

type Obj = Record<string, any>;

export const IDS = {
  root: 'fsbn0b7w',
  chronology: 'h0gczxh7',
  mainDoc: 'k6wkpozi',
  tableDoc: 'bt0bm3pc',
  timelineDoc: 'g2lm1d0v',
  calendar: 'rp86pkdr',
} as const;

export interface WorldOptions {
  readonly projectId: string;
  /** `https://127.0.0.1:PORT`, where the asset files are served. */
  readonly assetBase: string;
  readonly nesting?: 'accept' | 'refuse';
  /** Makes createResource answer 500 for a resource with this name. */
  readonly failCreateNamed?: string;
  /** Search stops at this many results while `hasMore` stays true (a hidden cap). */
  readonly searchCap?: number;
  /** The timeline has no year-only events. */
  readonly noYearOnly?: boolean;
  /** Listing the children of a resource (`parentId` query) answers 500: makes check 1 stop after it has written. */
  readonly failChildListing?: boolean;
}

interface NewResource {
  id?: string;
  name: string;
  parentId?: string;
}

interface Res {
  id: string;
  name: string;
  parentId: string | null;
  rank: string;
  tags: string[];
  aliases: string[];
  documents: Obj[];
  properties: Obj[];
  isHidden: boolean;
}

const err = (
  status: number,
  code: string,
  message = `mock ${code}`,
  errors: unknown[] = [],
): MockResponse => ({
  status,
  body: { message, code, requestId: 'world', ...(errors.length > 0 ? { errors } : {}) },
});
const ok = (body: unknown, status = 200): MockResponse => ({ status, body });
function page(items: readonly unknown[], query: Record<string, string>, cap?: number): MockResponse {
  const limit = Math.min(100, Number(query.limit ?? 50));
  const start = query.cursor ? Number(query.cursor) : 0;
  const end = Math.min(start + limit, cap ?? Number.POSITIVE_INFINITY);
  const more = cap !== undefined ? items.length > end || end >= cap : end < items.length;
  return ok({
    data: items.slice(start, end),
    hasMore: more && (cap !== undefined || end < items.length),
    nextCursor: more && end < items.length ? String(end) : null,
  });
}

// ---- blocks ------------------------------------------------------------------------------------------------------
const run = (text: string, marks: Obj = {}) => ({ text, ...marks });
const para = (...content: Obj[]) => ({ kind: 'paragraph', content });
const cell = (content: Obj[], header = false) => ({
  kind: 'tableCell',
  ...(header ? { header: true } : {}),
  children: [para(...content)],
});
const row = (...cells: Obj[]) => ({ kind: 'tableRow', children: cells });

function tableBlocks(): Obj[] {
  const rows: [string, string, string, Obj?][] = [
    ['The Sundering', 'Kumikas 1st, 4A 100', '1250407'],
    ['Founding of Sarias', 'Isar 4th, 4A 101', '1250408'],
    ['The Long Winter', 'Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102', '1250407-1250409'],
    ['Rise of the Hollow King', '4A 138', '1250445'],
    ['Fall of Ashgate', '4A 139', '1250446'],
    ['Treaty of Reeds', '4A 139', '1250446'],
    ['The Quiet Years', 'Kumikas - Azaakh, 4A 180', '1250487'],
    ['Burning of the Library', 'Azaakh 2nd, 4A 181', '1250488'],
    ['Unnamed Wars', '4A 200 - 4A 205', '1250507-1250512'],
    ['Birth of Miyabi', 'Highsun 9th, 4A 240', '1250547'],
  ];
  return [
    { kind: 'heading', level: 1, content: [run('Fourth Arkonan Age - Table')] },
    para(run('Events of the Fourth Age, in calendar order.')),
    {
      kind: 'table',
      children: [
        row(cell([run('Historical Event')], true), cell([run('Date')], true), cell([run('KCY')], true)),
        ...rows.map(([name, date, kcy], i) =>
          row(
            cell(
              i === 4
                ? [{ mention: { resourceId: 'bsrc0001', text: name } }, run(' (disputed)', { italic: true })]
                : [run(name, i === 0 ? { bold: true } : {})],
            ),
            cell([run(date)]),
            cell([run(kcy)]),
          ),
        ),
      ],
    },
  ];
}
function mainBlocks(): Obj[] {
  const ages = [
    ['First Age', '12', 'a'],
    ['Fourth Age', '1,204', 'd'],
  ] as const;
  return [
    { kind: 'heading', level: 1, content: [run('Universal Chronology')] },
    {
      kind: 'table',
      children: [
        row(
          ...['Age', 'Event count', 'Complete dated table', 'Interactive timeline'].map((h) =>
            cell([run(h)], true),
          ),
        ),
        ...ages.map(([age, n]) =>
          row(
            cell([run(age)]),
            cell([run(n)]),
            cell([
              { mention: { resourceId: IDS.chronology, documentId: IDS.tableDoc, text: `${age} - Table` } },
            ]),
            cell([
              {
                mention: {
                  resourceId: IDS.chronology,
                  documentId: IDS.timelineDoc,
                  text: `${age} - Timeline`,
                },
              },
            ]),
          ),
        ),
      ],
    },
  ];
}

// ---- the calendar and events ---------------------------------------------------------------------------------------
const MONTHS = [
  'Kumikas',
  'Isar',
  'Selaphos',
  'Azah',
  'Selyros',
  'Sarias',
  'Highsun',
  'Surion',
  'Azaakh',
  'Malakh',
  'Zahras',
  'Camue',
  'Pahan',
  'Redfall',
  'Meshaph',
  'Kusha',
  'Jehet',
  'Attina',
  'Umbaeos',
  'Zarzakh',
  'Frostmoot',
];
const DAY = 30 * 60;
const YEAR = 716 * DAY;
const ERA4 = 4_000_000 * DAY;
function calendar(): Obj {
  return {
    id: IDS.calendar,
    name: 'Kumikan Epochal',
    hasZeroYear: false,
    maxMinutes: 9e15,
    months: MONTHS.map((name, i) => ({
      id: `m${i + 1}`,
      name,
      isIntercalary: false,
      length: i < 20 ? 34 : 36,
      interval: 1,
      offset: 0,
    })),
    leapDays: [],
    weekdays: [{ id: 'w1', name: 'Day' }],
    epochWeekday: 0,
    hoursInDay: 30,
    minutesInHour: 60,
    negativeEra: { id: 'aa', name: 'Before the Epoch', abbr: 'AA', startsAt: -100 * YEAR, resetMode: 'none' },
    positiveEras: [
      { id: 'a1', name: 'First Age', abbr: '1A', startsAt: 0, resetMode: 'none' },
      { id: 'a4', name: 'Fourth Age', abbr: '4A', startsAt: ERA4, resetMode: 'year' },
    ],
    format: {
      id: 'arkona',
      year: 'E YYYY',
      month: 'MMMM, E YYYY',
      day: 'MMMM D^, E YYYY',
      time: 'MMMM D^, E YYYY, HH:mm',
    },
  };
}
function events(noYearOnly: boolean): Obj[] {
  const out: Obj[] = [];
  const era = { id: 'a4', name: 'Fourth Age', abbr: '4A' };
  for (let i = 0; i < 45; i++) {
    const year = 100 + i * 3;
    const start = ERA4 + (year - 1) * YEAR + i * DAY;
    const base: Obj = {
      id: `ev${String(i).padStart(4, '0')}`,
      laneId: 'lane0001',
      rank: `a${i}`,
      type: 'event',
      name: `Event ${i}`,
      start,
      startDate: {
        year,
        month: 1 + (i % 21),
        monthName: MONTHS[i % 21],
        day: 1 + (i % 30),
        hour: 0,
        minute: 0,
        era,
      },
    };
    const yearOnly = !noYearOnly && i % 9 === 4;
    if (yearOnly) {
      Object.assign(base, { detail: 1, formattedStart: `4A ${year}` });
    } else if (i === 12) {
      Object.assign(base, {
        end: start + 2 * YEAR,
        formattedStart: `${MONTHS[i % 21]} ${1 + (i % 30)}th, 4A ${year}`,
        formattedEnd: `Meshaph 10th, 4A ${year + 2}`,
        endDate: { ...base.startDate, year: year + 2 },
      });
    } else if (i === 38) {
      Object.assign(base, {
        detail: 2,
        end: start + 5 * 34 * DAY,
        formattedStart: `Kumikas, 4A ${year}`,
        formattedEnd: `Azaakh, 4A ${year}`,
      });
    } else {
      Object.assign(base, { formattedStart: `${MONTHS[i % 21]} ${1 + (i % 30)}th, 4A ${year}` });
    }
    out.push(base);
  }
  return out;
}

// ---- the world ---------------------------------------------------------------------------------------------------------
export class World {
  readonly resources = new Map<string, Res>();
  readonly deleted: string[] = [];
  /** Write requests as seen, for assertions. */
  readonly writes: { op: string; body: any; path: string }[] = [];
  private counter = 0;

  constructor(readonly o: WorldOptions) {
    this.seed();
  }

  private add(id: string, name: string, parentId: string | null, extra: Partial<Res> = {}): Res {
    const siblings = [...this.resources.values()].filter((r) => r.parentId === parentId);
    const r: Res = {
      id,
      name,
      parentId,
      rank: `a${String(siblings.length).padStart(3, '0')}`,
      tags: [],
      aliases: [],
      documents: [{ id: `d-${id}`, name, type: 'page' }],
      properties: [],
      isHidden: false,
      ...extra,
    };
    this.resources.set(id, r);
    return r;
  }

  private seed(): void {
    const root = IDS.root;
    this.add(root, 'AI REPOSITORY', null);
    this.add('chars001', '[INDEX] Characters', root);
    this.add('beast001', '[INDEX] Beastkin', 'chars001');
    this.add('fox00001', '[INDEX] Foxians', 'beast001');
    this.add('cat00001', '[INDEX] Catfolk', 'beast001');
    this.add('human001', '[INDEX] Humankind', 'chars001');
    this.add('humans01', '[INDEX] Humans', 'human001');
    this.add('undet001', '[INDEX] Undetermined / Unknown', 'chars001');
    this.add('bsrc0001', '[BSRC] Asagiri Miyabi', 'fox00001', {
      tags: ['fox'],
      properties: [
        {
          id: 'p1',
          kind: 'keyValue',
          title: 'PROPERTIES',
          rows: [
            { key: 'Race / Species', text: 'Foxian' },
            { key: 'Scope', text: 'Core' },
            { key: 'Reference Type', text: 'Character Core' },
          ],
        },
        { id: 'p2', kind: 'resourceCollection', title: 'Dependencies', items: [] },
        { id: 'p3', kind: 'unsupported', title: 'TAGS' },
      ],
    });
    this.add('equip001', '[INDEX] Equipment', root);
    // Out of order on purpose: a [BSRC] before an [INDEX], and not alphabetical.
    this.add('eq000001', '[BSRC] Zulfiqar', 'equip001');
    this.add('eq000002', '[INDEX] Sacred Blades', 'equip001');
    this.add('eq000003', '[BSRC] Aegis', 'equip001');
    this.add('place001', '[INDEX] Places', root);
    this.add('pl000001', '[INDEX] North', 'place001');
    for (const [i, n] of ['Alder Keep', 'Brindle Hall', 'Cinder Gate', 'Dunmere'].entries())
      this.add(`pl00010${i}`, `[BSRC] ${n}`, 'place001');
    this.add('notes001', 'Arkona working notes', root);
    this.add('map00001', '[BSRC] World Map', 'place001', {
      documents: [{ id: 'mapdoc01', name: 'World Map', type: 'map' }],
    });
    this.add(IDS.chronology, 'Universal Chronology', null, {
      documents: [
        { id: IDS.mainDoc, name: 'Main', type: 'page' },
        { id: IDS.tableDoc, name: 'Fourth Arkonan Age - Table', type: 'page' },
        { id: IDS.timelineDoc, name: 'Fourth Arkonan Age - Timeline', type: 'time' },
      ],
    });
    this.add('scratch1', 'Scratch pad', null);
  }

  private listItem(r: Res): Obj {
    return {
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      tags: r.tags,
      aliases: r.aliases,
      rank: r.rank,
      isHidden: r.isHidden,
      documents: r.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    };
  }
  private subtreeIds(id: string): string[] {
    const out = [id];
    for (const r of this.resources.values()) if (r.parentId === id) out.push(...this.subtreeIds(r.id));
    return out;
  }

  /** The `respond` function for MockLk. */
  readonly respond = (req: MockRequest): MockResponse | undefined => {
    const p = req.path.replace(/\/$/, '');
    const base = '/api/v3/projects/[^/]+';
    /** The path's captured groups when the method and path pattern match. */
    const route = (method: string, pattern: string): string[] | null => {
      if (req.method !== method) return null;
      const hit = new RegExp(`^${base}${pattern}$`).exec(p);
      return hit ? hit.slice(1) : null;
    };

    if (req.method === 'GET' && p === '/api/v3/projects')
      return ok({ data: [{ id: this.o.projectId, name: 'Test world' }], hasMore: false, nextCursor: null });

    // ---- resources
    if (route('GET', '/resources')) {
      const parent = req.query.parentId;
      // The spike's own listings fail; the bridge's internal reads (`lkb.t…`, such as the canonical guard listing a
      // cascade's pages before the clean-up delete, v2 C2b) do not, so the clean-up is still judged and made.
      const internal = (req.headers['x-request-id'] ?? '').startsWith('lkb.t');
      if (parent !== undefined && this.o.failChildListing && !internal)
        return err(500, 'INTERNAL', 'mock failure');
      const all = [...this.resources.values()].filter((r) =>
        parent === undefined ? true : r.parentId === parent,
      );
      return page(
        all.map((r) => this.listItem(r)),
        req.query,
      );
    }
    if (route('POST', '/resources')) {
      const b = req.body as NewResource;
      this.writes.push({ op: 'createResource', body: b, path: p });
      if (this.o.failCreateNamed && b.name === this.o.failCreateNamed)
        return err(500, 'INTERNAL', 'mock failure');
      if (b.parentId && !this.resources.has(b.parentId)) return err(404, 'NOT_FOUND');
      const id = b.id ?? `gen${++this.counter}`;
      const r = this.add(id, b.name, b.parentId ?? null);
      return ok({ ...this.listItem(r), permissions: {}, properties: [] }, 201);
    }
    if (route('POST', '/resources/batch')) {
      const items = (req.body as { resources: NewResource[] }).resources;
      this.writes.push({ op: 'createManyResources', body: req.body, path: p });
      const inBatch = new Set(items.map((i) => i.id));
      if (this.o.nesting === 'refuse' && items.some((i) => inBatch.has(i.parentId))) {
        return err(404, 'NOT_FOUND', 'parent not found', [
          { path: 'resources[1].parentId', message: 'No such resource' },
        ]);
      }
      const made: Obj[] = [];
      for (const it of items) {
        if (it.parentId && !this.resources.has(it.parentId)) return err(404, 'NOT_FOUND');
        made.push({
          ...this.listItem(this.add(it.id ?? `gen${++this.counter}`, it.name, it.parentId ?? null)),
          permissions: {},
          properties: [],
        });
      }
      return ok({ resources: made }, 201);
    }
    const one =
      req.method === 'GET' || req.method === 'DELETE' ? route(req.method, '/resources/([^/]+)') : null;
    if (one && one[0] !== 'batch') {
      const r = this.resources.get(one[0]!);
      if (req.method === 'GET') {
        if (!r) return err(404, 'NOT_FOUND');
        return ok({
          ...this.listItem(r),
          isLocked: false,
          permissions: {},
          documents: r.documents,
          properties: r.properties,
        });
      }
      if (req.method === 'DELETE') {
        this.writes.push({ op: 'deleteResource', body: req.query, path: p });
        if (!r) return err(404, 'NOT_FOUND');
        for (const id of this.subtreeIds(r.id)) {
          this.resources.delete(id);
          this.deleted.push(id);
        }
        return { status: 204 };
      }
    }

    // ---- documents
    const blocks = route('GET', '/resources/([^/]+)/docs/([^/]+)/blocks');
    if (blocks) {
      const [resourceId, docId] = blocks;
      if (resourceId !== IDS.chronology) return err(404, 'NOT_FOUND');
      if (docId === IDS.tableDoc)
        return ok({ id: docId, version: 'v1', schema: 1, text: '', blocks: tableBlocks() });
      if (docId === IDS.mainDoc)
        return ok({ id: docId, version: 'v1', schema: 1, text: '', blocks: mainBlocks() });
      return err(404, 'NOT_FOUND');
    }
    const doc = route('GET', '/resources/([^/]+)/docs/([^/]+)');
    if (doc) {
      if (doc[1] !== 'mapdoc01') return err(404, 'NOT_FOUND');
      return ok({
        id: 'mapdoc01',
        name: 'World Map',
        type: 'map',
        rank: 'a',
        isHidden: false,
        mapImage: {
          assetId: 'a_world',
          url: `${this.o.assetBase}/assets/world.png?sig=SECRET-SIGNATURE`,
          width: 2048,
          height: 1024,
          bounds: [
            [-128, 0],
            [0, 256],
          ],
        },
      });
    }
    if (route('GET', '/resources/([^/]+)/docs/([^/]+)/features')) {
      return ok({
        data: [
          { id: 'f1', name: 'Ashgate', type: 'pin', pos: [-10, 20], uri: 'lk://resources/pl000101' },
          {
            id: 'f2',
            name: 'The Hollow',
            type: 'region',
            pos: [-60, 100],
            polygon: [
              [-50, 90],
              [-70, 90],
              [-70, 120],
              [-50, 120],
            ],
            polygons: [
              [
                [-50, 90],
                [-70, 90],
                [-70, 120],
              ],
            ],
          },
          {
            id: 'f3',
            name: 'Old Road',
            type: 'path',
            polyline: [
              [-10, 20],
              [-30, 40],
              [-60, 100],
            ],
          },
          { id: 'f4', name: 'Sea of Reeds', type: 'label', pos: [-120, 250] },
          { id: 'f5', name: 'Cities', type: 'folder' },
          { id: 'f6', name: 'Brindle', type: 'pin', pos: [-20, 30], uri: 'lk://resources/pl000102' },
        ],
      });
    }
    // ---- timelines
    if (route('GET', '/resources/([^/]+)/docs/([^/]+)/lanes')) {
      return ok({ data: [{ id: 'lane0001', name: 'Main', rank: 'a0', size: 'lg' }] });
    }
    if (route('GET', '/resources/([^/]+)/docs/([^/]+)/events')) {
      return page(events(this.o.noYearOnly === true), req.query);
    }
    // ---- calendar, templates, search, assets
    if (route('GET', '/calendars')) return ok({ data: [calendar()] });
    if (route('GET', '/templates')) {
      return page(
        [
          {
            id: 'tpl00001',
            name: 'Index template',
            parentId: 'templates',
            tags: [],
            aliases: [],
            documents: [],
          },
          {
            id: 'tpl00002',
            name: 'Character Core',
            parentId: 'templates',
            tags: [],
            aliases: [],
            documents: [],
          },
          {
            id: 'tpl00003',
            name: 'Compact Character Reference',
            parentId: 'tpl00002',
            tags: [],
            aliases: [],
            documents: [],
          },
        ],
        req.query,
      );
    }
    if (route('GET', '/search')) return this.search(req.query);
    if (route('GET', '/assets')) return page(this.assets(req.query.folderId), req.query);
    return undefined;
  };

  private search(query: Record<string, string>): MockResponse {
    const q = (query.q ?? '').toLowerCase();
    const limit = Math.min(100, Number(query.limit ?? 32));
    const hit = (r: Res, doc?: Obj) => ({
      resource: { id: r.id, name: r.name, tags: r.tags, parentId: r.parentId },
      ...(doc ? { document: { id: doc.id, name: doc.name, highlights: [] } } : {}),
    });
    let results: Obj[];
    if (q === 'the') {
      // A crowded query: every resource matches in its name and in each of three documents; plenty of them.
      const rs = [...this.resources.values()];
      results = Array.from({ length: 150 }, (_, i) => hit(rs[i % rs.length]!, { id: `d${i}`, name: 'Page' }));
    } else {
      results = [...this.resources.values()]
        .filter((r) => r.name.toLowerCase().includes(q))
        .map((r) => hit(r));
    }
    const cap = this.o.searchCap;
    const shown = results.slice(0, cap ?? limit).slice(0, limit);
    return ok({ data: shown, hasMore: cap !== undefined ? true : results.length > limit, nextCursor: null });
  }

  private assets(folderId: string | undefined): Obj[] {
    const img = (id: string, name: string, folder: string | null, file: string) => ({
      id,
      name,
      type: 'IMAGE',
      folderId: folder,
      url: `${this.o.assetBase}/assets/${file}`,
      width: 64,
      height: 64,
    });
    const folder = (id: string, name: string, parent: string | null) => ({
      id,
      name,
      type: 'FOLDER',
      folderId: parent,
    });
    const tree: Record<string, Obj[]> = {
      root: [
        folder('f_chars', 'Characters', null),
        folder('f_maps', 'Maps', null),
        img('a_banner', 'banner', null, 'banner.png'),
      ],
      f_chars: [folder('f_beast', 'Beastkin', 'f_chars'), img('a_crest', 'crest', 'f_chars', 'crest.png')],
      f_beast: [folder('f_fox', 'Foxians', 'f_beast')],
      f_fox: [folder('f_mi', 'Asagiri Miyabi', 'f_fox'), img('a_fox', 'fox', 'f_fox', 'fox.png')],
      f_mi: [folder('f_gal', 'Gallery', 'f_mi'), img('a_mi1', 'portrait', 'f_mi', 'portrait.png')],
      f_maps: [img('a_world', 'world', 'f_maps', 'world.png')],
    };
    return tree[folderId ?? 'root'] ?? [];
  }
}
