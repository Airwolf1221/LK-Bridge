/**
 * The test world for the calendar engine and chronology sync (v2 D1, ADR 0038): C2c's lifecycle world (the real
 * server, policy, engine, tree and lifecycle guard against the mock LegendKeeper) plus a Universal Chronology built by
 * hand from the real structure (PLAN-v2 section 2 and the spike):
 *
 * - `[BSRC] Universal Chronology` (Authoritative, CANON) with a Main document holding the index table
 *   `Age | Event count | Complete dated table | Interactive timeline`, whose last two cells mention each age's documents;
 * - four ages (the Archon Age counting down, the First, Third and Fourth Arkonan Ages), each an "<Age> - Table" page
 *   document (`Historical Event | Date | KCY`, intro and boundary paragraphs; the Fourth Age's intro holds an inline
 *   icon) and an "<Age> - Timeline" timeline with one lane, "Historical Events", whose events link to the age's table;
 * - rows covering every date form (day, year, Unknown + year, date range, day range in one month, month ranges in both
 *   forms, year range), the Archon Age's negative KCY and the Fourth Age's first day;
 * - the oracle's calendar (Kumikan Epochal), and a page with an ordinary timeline for the lane tool.
 *
 * The mock adds what the shared model lacks: nested blocks (insert, get, replace, patch, move and delete a table row
 * or cell), lanes and events (with formatted text from the engine, which matches LegendKeeper on the oracle), the
 * calendar, and failures injected at a chosen write.
 */
import { readFileSync } from 'node:fs';
import { createCalendar, formatKcy, DEFAULT_KCY_STYLE } from '../../src/calendar/index.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';
import { lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';
import { SidebarModel, type ResourcesWorld } from '../resources/world.js';

type Obj = Record<string, unknown>;

export const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as {
  calendar: Obj;
  events: Obj[];
};
export const CAL = createCalendar(ORACLE.calendar);

export const C = {
  resource: 'chrono01',
  plans: 'plans001',
} as const;

export interface AgeFixture {
  readonly name: string;
  readonly rows: readonly { readonly date: string; readonly description: string; readonly name?: string }[];
}

/** The ages and their rows, in calendar order (built by hand; KCY worked out from the engine). */
export const AGES: readonly AgeFixture[] = [
  {
    name: 'Archon Age',
    rows: [
      {
        date: 'Kumikas 1st, AA 1,988,119',
        description: 'The Archons wake on the first day of the reckoning',
      },
      { date: 'AA 1,000,000', description: 'The Archon Concord is sealed' },
      { date: 'Isar 3rd - 9th, AA 5', description: 'The Last Archon Council sits for a week' },
    ],
  },
  {
    name: 'First Arkonan Age',
    rows: [
      { date: 'Kumikas 1st, 1A 159', description: 'The first city charter is written at Ashgate' },
      { date: 'Unknown, 1A 200', description: 'The Isar road is finished' },
      { date: 'Kumikas - Azaakh, 1A 300', description: 'The long drought of the plains' },
      { date: '1A 400,000 - 1A 400,010', description: 'The Decade of Bells' },
    ],
  },
  {
    name: 'Third Arkonan Age',
    rows: [
      { date: 'Zahras 3A 10 - Attina 3A 10', description: 'The storms of the Weeping Sea' },
      { date: '3A 300', description: 'The Hollow Court is founded' },
    ],
  },
  {
    name: 'Fourth Arkonan Age',
    rows: [
      { date: 'Azah 18th, 4A 1', description: 'The Divine System is deployed in the Heart of Arkona' },
      {
        date: 'Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102',
        description: 'The Long Winter',
        name: 'The Long Winter',
      },
      { date: 'Unknown, 4A 101', description: 'A comet is seen over Isar' },
      { date: 'Kumikas - Azaakh, 4A 180', description: 'The famine months of the south' },
      {
        date: 'Zahras 4A 367 - Attina 4A 367',
        description:
          'The remains of Realmship Bishnak crash across the desert for much of the year, raining death and destruction on its people and on everyone who had come to trade',
      },
      { date: 'Jehet 11th - 18th, 4A 424', description: 'The Week of Lanterns' },
      { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
      { date: '4A 881', description: 'The year of the long harvest' },
      { date: '4A 881 - 4A 900', description: 'The Quiet Years' },
    ],
  },
];

/** A long description's timeline name: cut short with an ellipsis, as the real events are. */
export const shortName = (d: string) => (d.length > 60 ? `${d.slice(0, 57)}...` : d);

export interface AgeDocs {
  readonly name: string;
  readonly table: string;
  readonly timeline: string;
  readonly lane: string;
  readonly mainRow: string;
}

export interface ChronologyWorld extends LifecycleWorld {
  readonly ages: Record<string, AgeDocs>;
  readonly mainDoc: string;
  readonly planTimeline: string;
  /** The rows of an age's table as text: `date | description | KCY`. */
  rows(age: string): string[];
  /** The count of an age on the Main table. */
  count(age: string): string;
  /** The events of a timeline document. */
  events(docId: string): Obj[];
  /**
   * The timeline's stored events themselves (not copies): an edit made in the LegendKeeper app, outside the bridge. It
   * costs no request.
   */
  liveEvents(docId: string): Obj[];
  lanes(docId: string): Obj[];
  /** The next `n`-th request (0-based) for this operation fails with `response` (once). */
  failAt(op: string, n: number, response?: MockResponse): void;
  /** Requests made since `mark()`, split into reads and writes. */
  mark(): () => { reads: number; writes: number; lines: string[] };
  confirm(): void;
}

const t = (text: string) => [{ text }];
const cell = (id: string, content: unknown[], header = false) => ({
  id: `${id}c`,
  kind: 'tableCell',
  ...(header ? { header: true } : {}),
  children: [{ id: `${id}p`, kind: 'paragraph', content }],
});

export async function chronologyWorld(
  o: Parameters<typeof lifecycleWorld>[0] & {
    confirm?: boolean;
    /**
     * v3 F3.4: the world the chronology is added to (default the lifecycle world). The write-scope rehearsal's dry run
     * adds it to the pack world (itself the images world), so one mock serves every step of the rehearsal.
     */
    base?: (o: Parameters<typeof lifecycleWorld>[0]) => Promise<ResourcesWorld>;
  } = {},
): Promise<ChronologyWorld> {
  const docs: { main: string; ages: Record<string, { table: string; timeline: string }>; plans: string } = {
    main: '',
    ages: {},
    plans: '',
  };
  const { base, confirm: _confirm, ...rest } = o;
  void _confirm;
  const w = (await (base ?? lifecycleWorld)({
    ...rest,
    seed: (world) => {
      const r = world.repo.seed({
        id: C.resource,
        name: '[BSRC] Universal Chronology',
        parentId: ROOT,
        referenceType: 'General Source',
        tags: ['CANON'],
      });
      docs.main = world.repo.liveDocs(r).find((d) => d.name === 'Main')!.id;
      for (const a of AGES) {
        const table = world.repo.outside.addDocument(C.resource, `${a.name} - Table`, 'page').id;
        const timeline = world.repo.outside.addDocument(C.resource, `${a.name} - Timeline`, 'time').id;
        docs.ages[a.name] = { table, timeline };
      }
      world.repo.seed({
        id: C.plans,
        name: '[BSRC] Battle Plans',
        parentId: ROOT,
        referenceType: 'General Source',
      });
      docs.plans = world.repo.outside.addDocument(C.plans, 'Campaign', 'time').id;
      o.seed?.(world);
    },
  })) as ChronologyWorld;
  // The chronology's facts: an Authoritative page (its edits are ordinary edits: ADR 0036 decision 6).
  w.sidebars.page(C.resource, [
    SidebarModel.kv('kvchron1', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
    ]),
  ]);

  // ------------------------------------------------------------------------------------------ the documents
  const ages: Record<string, AgeDocs> = {};
  const events = new Map<string, Obj[]>();
  const lanes = new Map<string, Obj[]>();
  const view = (e: Obj): Obj => {
    const start = e.start as number;
    const end = typeof e.end === 'number' ? e.end : null;
    const detail = (e.detail as 1 | 2 | 3) ?? 3;
    return {
      ...e,
      formattedStart: CAL.engine.format(start, detail),
      startDate: CAL.engine.eventDate(start),
      ...(end !== null
        ? { formattedEnd: CAL.engine.format(end, detail), endDate: CAL.engine.eventDate(end) }
        : {}),
    };
  };
  let n = 0;
  for (const a of AGES) {
    const d = docs.ages[a.name]!;
    const key = a.name.split(' ')[0]!.toLowerCase().slice(0, 4);
    const laneId = `lane${key}`;
    lanes.set(d.timeline, [{ id: laneId, name: 'Historical Events', rank: 'a0', size: 'sm' }]);
    const rows = a.rows.map((r, i) => {
      const p = CAL.parser.parse(r.date);
      const id = `r${key}${String(i).padStart(3, '0')}`;
      return {
        block: {
          id,
          kind: 'tableRow',
          children: [
            cell(`${id}a`, t(r.description)),
            cell(`${id}b`, t(r.date)),
            cell(`${id}c`, t(formatKcy(p.kcy, DEFAULT_KCY_STYLE))),
          ],
        },
        event: {
          id: `e${key}${String(i).padStart(3, '0')}`,
          laneId,
          type: 'event',
          rank: `a${i}`,
          name: r.name ?? shortName(r.description),
          start: p.start,
          ...(p.end !== null ? { end: p.end } : {}),
          detail: p.detail,
          uri: `lk://resources/${C.resource}/docs/${d.table}`,
        },
      };
    });
    n++;
    w.repo.blocks.set(d.table, {
      version: 3,
      blocks: [
        { id: `h${key}`, kind: 'heading', level: 1, content: t(`${a.name} - Table`) },
        {
          id: `i${key}`,
          kind: 'paragraph',
          content:
            a.name === 'Fourth Arkonan Age'
              ? [
                  { text: 'Every dated event of the age ' },
                  { icon: { glyph: 'hourglass' } },
                  { text: ', in calendar order.' },
                ]
              : t('Every dated event of the age, in calendar order.'),
        },
        {
          id: `t${key}`,
          kind: 'table',
          children: [
            {
              id: `hd${key}`,
              kind: 'tableRow',
              children: [
                cell(`hd${key}a`, t('Historical Event'), true),
                cell(`hd${key}b`, t('Date'), true),
                cell(`hd${key}c`, t('KCY'), true),
              ],
            },
            ...rows.map((r) => r.block),
          ],
        },
        { id: `b${key}`, kind: 'paragraph', content: t(`The ${a.name} ends with the next age.`) },
      ],
    });
    events.set(
      d.timeline,
      rows.map((r) => r.event),
    );
    ages[a.name] = { name: a.name, table: d.table, timeline: d.timeline, lane: laneId, mainRow: `m${key}` };
  }
  void n;
  lanes.set(docs.plans, [{ id: 'laneplan', name: 'Army', rank: 'a0', size: 'sm' }]);
  events.set(docs.plans, []);
  w.repo.blocks.set(docs.main, {
    version: 5,
    blocks: [
      { id: 'mh1', kind: 'heading', level: 1, content: t('Universal Chronology') },
      { id: 'mp1', kind: 'paragraph', content: t('The index of the ages.') },
      {
        id: 'mtab',
        kind: 'table',
        children: [
          {
            id: 'mhdr',
            kind: 'tableRow',
            children: ['Age', 'Event count', 'Complete dated table', 'Interactive timeline'].map((h, i) =>
              cell(`mh${i}`, t(h), true),
            ),
          },
          ...AGES.map((a) => {
            const g = ages[a.name]!;
            return {
              id: g.mainRow,
              kind: 'tableRow',
              children: [
                cell(`${g.mainRow}a`, t(a.name)),
                cell(`${g.mainRow}b`, t(String(a.rows.length))),
                cell(`${g.mainRow}c`, [
                  { mention: { resourceId: C.resource, documentId: g.table, text: `${a.name} - Table` } },
                ]),
                cell(`${g.mainRow}d`, [
                  {
                    mention: { resourceId: C.resource, documentId: g.timeline, text: `${a.name} - Timeline` },
                  },
                ]),
              ],
            };
          }),
        ],
      },
    ],
  });

  // ------------------------------------------------------------------------------------------ the routes
  const faults: { op: string; n: number; seen: number; response: MockResponse }[] = [];
  const fault = (op: string): MockResponse | undefined => {
    for (const f of faults) {
      if (f.op !== op) continue;
      if (f.seen++ === f.n) return f.response;
    }
    return undefined;
  };
  const err = (status: number, code: string) => ({
    status,
    body: { message: `model ${code}`, code, requestId: `model-${code}` },
  });
  const findBlock = (list: Obj[], id: string): { list: Obj[]; at: number; block: Obj } | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b.id === id) return { list, at: i, block: b };
      if (Array.isArray(b.children)) {
        const hit = findBlock(b.children as Obj[], id);
        if (hit) return hit;
      }
    }
    return null;
  };
  const ids = (list: Obj[], out = new Set<string>()): Set<string> => {
    for (const b of list) {
      if (typeof b.id === 'string') out.add(b.id);
      if (Array.isArray(b.children)) ids(b.children as Obj[], out);
    }
    return out;
  };
  const place = (blocks: Obj[], body: Obj, block: Obj): MockResponse | null => {
    if (typeof body.after === 'string' || typeof body.before === 'string') {
      const ref = findBlock(blocks, (body.after ?? body.before) as string);
      if (!ref) return err(404, 'NOT_FOUND');
      ref.list.splice(ref.at + (typeof body.after === 'string' ? 1 : 0), 0, block);
    } else if (typeof body.parent === 'string') {
      const ref = findBlock(blocks, body.parent);
      if (!ref) return err(404, 'NOT_FOUND');
      ((ref.block.children ??= []) as Obj[]).push(block);
    } else blocks.push(block);
    return null;
  };
  const docIds = () =>
    new Set([docs.main, docs.plans, ...Object.values(docs.ages).flatMap((d) => [d.table, d.timeline])]);
  const versionCheck = (req: MockRequest, b: { version: number }) =>
    req.headers['if-match'] !== undefined && req.headers['if-match'] !== `v${b.version}`
      ? err(412, 'VERSION_MISMATCH')
      : null;

  w.overrides.set(/\/calendars$/, (req) =>
    req.method === 'GET'
      ? { status: 200, body: { data: [ORACLE.calendar], hasMore: false, nextCursor: null } }
      : undefined,
  );
  w.overrides.set(/\/resources\/[^/]+\/docs\/[^/]+(\/.*)?$/, (req): MockResponse | undefined => {
    const m = /\/resources\/([^/]+)\/docs\/([^/]+)(?:\/(.*))?$/.exec(req.path.replace(/\/$/, ''));
    if (!m) return undefined;
    const [, , did, rest] = m;
    if (!docIds().has(did!)) return undefined;
    const parts = (rest ?? '').split('/').filter(Boolean);
    const M = req.method;
    const body = (req.body ?? {}) as Obj;
    // The document: its calendar for a timeline.
    if (parts.length === 0) {
      const r = w.repo.respond(req);
      if (M === 'GET' && r?.status === 200 && events.has(did!) && did !== docs.plans)
        return { ...r, body: { ...(r.body as Obj), calendarId: CAL.engine.id } };
      if (M === 'GET' && r?.status === 200 && did === docs.plans)
        return { ...r, body: { ...(r.body as Obj), calendarId: CAL.engine.id } };
      return r;
    }
    if (parts[0] === 'blocks') {
      const b = w.repo.blocks.get(did!) ?? { version: 1, blocks: [] };
      w.repo.blocks.set(did!, b);
      const blocks = b.blocks as Obj[];
      if (parts.length === 1) {
        if (M === 'GET') return undefined; // the shared model answers the whole document
        if (M === 'POST') {
          const f = fault('insertBlock');
          if (f) return f;
          const v = versionCheck(req, b);
          if (v) return v;
          const block = structuredClone(body.block ?? {}) as Obj;
          const have = ids(blocks);
          for (const id of ids([block])) if (have.has(id)) return err(409, 'DUPLICATE_ID');
          const e = place(blocks, body, block);
          if (e) return e;
          b.version++;
          return { status: 201, body: { ...structuredClone(block), version: `v${b.version}` } };
        }
        return undefined;
      }
      const hit = findBlock(blocks, parts[1]!);
      if (parts[2] === 'move' && M === 'POST') {
        const f = fault('moveBlock');
        if (f) return f;
        if (!hit) return err(404, 'NOT_FOUND');
        const v = versionCheck(req, b);
        if (v) return v;
        hit.list.splice(hit.at, 1);
        const e = place(blocks, body, hit.block);
        if (e) return e;
        b.version++;
        return { status: 200, body: { ...structuredClone(hit.block), version: `v${b.version}` } };
      }
      if (!hit) return err(404, 'NOT_FOUND');
      if (M === 'GET')
        return { status: 200, body: { ...structuredClone(hit.block), version: `v${b.version}` } };
      const op =
        M === 'PUT' ? 'replaceBlock' : M === 'PATCH' ? 'updateBlock' : M === 'DELETE' ? 'deleteBlock' : '';
      const f = fault(op);
      if (f) return f;
      const v = versionCheck(req, b);
      if (v) return v;
      if (M === 'DELETE') {
        hit.list.splice(hit.at, 1);
        b.version++;
        return { status: 204 };
      }
      if (M === 'PUT') hit.list[hit.at] = { ...structuredClone(body), id: hit.block.id };
      else Object.assign(hit.block, structuredClone(body));
      b.version++;
      return { status: 200, body: { ...structuredClone(hit.list[hit.at]!), version: `v${b.version}` } };
    }
    if (parts[0] === 'lanes') {
      const ls = lanes.get(did!) ?? [];
      lanes.set(did!, ls);
      if (parts.length === 1) {
        if (M === 'GET') return { status: 200, body: { data: structuredClone(ls) } };
        if (M === 'POST') {
          const f = fault('createLane');
          if (f) return f;
          const lane = {
            id: typeof body.id === 'string' ? body.id : `l${ls.length}x`,
            size: 'sm',
            ...structuredClone(body),
          };
          if (ls.some((l) => l.id === lane.id)) return err(409, 'DUPLICATE_ID');
          ls.push(lane);
          return { status: 201, body: structuredClone(lane) };
        }
      }
      const at = ls.findIndex((l) => l.id === parts[1]);
      if (at < 0) return err(404, 'NOT_FOUND');
      if (M === 'GET') return { status: 200, body: structuredClone(ls[at]) };
      if (M === 'PATCH') {
        Object.assign(ls[at]!, structuredClone(body));
        return { status: 200, body: structuredClone(ls[at]) };
      }
      if (M === 'DELETE') {
        const f = fault('deleteLane');
        if (f) return f;
        const laneId = ls[at]!.id;
        ls.splice(at, 1);
        events.set(
          did!,
          (events.get(did!) ?? []).filter((e) => e.laneId !== laneId),
        );
        return { status: 204 };
      }
    }
    if (parts[0] === 'events') {
      const es = events.get(did!) ?? [];
      events.set(did!, es);
      if (parts.length === 1) {
        if (M === 'GET') {
          const limit = Number(req.query.limit ?? 50);
          const from = Number(req.query.cursor ?? 0);
          const page = es.slice(from, from + limit).map(view);
          const more = from + limit < es.length;
          return {
            status: 200,
            body: { data: page, hasMore: more, nextCursor: more ? String(from + limit) : null },
          };
        }
        if (M === 'POST') {
          const f = fault('createEvent');
          if (f) return f;
          const e = structuredClone(body);
          if (typeof e.id !== 'string') e.id = `ev${es.length}x`;
          if (es.some((x) => x.id === e.id)) return err(409, 'DUPLICATE_ID');
          if (!(lanes.get(did!) ?? []).some((l) => l.id === e.laneId)) return err(400, 'VALIDATION_ERROR');
          e.rank = `z${es.length}`;
          es.push(e);
          return { status: 201, body: view(e) };
        }
      }
      const at = es.findIndex((e) => e.id === parts[1]);
      if (at < 0) return err(404, 'NOT_FOUND');
      if (M === 'GET') return { status: 200, body: view(es[at]!) };
      if (M === 'PATCH') {
        const f = fault('updateEvent');
        if (f) return f;
        Object.assign(es[at]!, structuredClone(body));
        return { status: 200, body: view(es[at]!) };
      }
      if (M === 'DELETE') {
        const f = fault('deleteEvent');
        if (f) return f;
        es.splice(at, 1);
        return { status: 204 };
      }
    }
    return undefined;
  });

  // ------------------------------------------------------------------------------------------ helpers
  const textOf = (c: Obj) =>
    (((c.children as Obj[])[0]?.content ?? []) as Obj[])
      .map((r) =>
        typeof r.text === 'string'
          ? r.text
          : r.mention && typeof (r.mention as Obj).text === 'string'
            ? ((r.mention as Obj).text as string)
            : '',
      )
      .join('');
  (w as { ages: Record<string, AgeDocs> }).ages = ages;
  (w as { mainDoc: string }).mainDoc = docs.main;
  (w as { planTimeline: string }).planTimeline = docs.plans;
  w.rows = (age) => {
    const blocks = w.repo.blocks.get(ages[age]!.table)!.blocks as Obj[];
    const table = blocks.find((b) => b.kind === 'table')!;
    return (table.children as Obj[]).slice(1).map((r) => {
      const cells = r.children as Obj[];
      return `${textOf(cells[1]!)} | ${textOf(cells[0]!)} | ${textOf(cells[2]!)}`;
    });
  };
  w.count = (age) => {
    const blocks = w.repo.blocks.get(docs.main)!.blocks as Obj[];
    const table = blocks.find((b) => b.kind === 'table')!;
    const row = (table.children as Obj[]).find((r) => r.id === ages[age]!.mainRow)!;
    return textOf((row.children as Obj[])[1]!);
  };
  w.events = (doc) => (events.get(doc) ?? []).map((e) => structuredClone(e));
  w.liveEvents = (doc) => {
    if (!events.has(doc)) events.set(doc, []);
    return events.get(doc)!;
  };
  w.lanes = (doc) => (lanes.get(doc) ?? []).map((e) => structuredClone(e));
  w.failAt = (op, at, response = err(400, 'VALIDATION_ERROR')) =>
    faults.push({ op, n: at, seen: 0, response });
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
  w.confirm = () => {
    throw new Error('call confirmChronology(w) (async)');
  };
  if (o.confirm !== false) await confirmChronology(w);
  return w;
}

/** As the owner does on the dashboard: read the chronology, then confirm what was found. */
export async function confirmChronology(w: ChronologyWorld): Promise<void> {
  const ch = w.stack.runtime.chronology;
  const found = await ch.lookup(PROJECT);
  if (!found.proposed) throw new Error(`chronology not found: ${JSON.stringify(found.problems)}`);
  ch.update('owner', PROJECT, found.proposed);
}
