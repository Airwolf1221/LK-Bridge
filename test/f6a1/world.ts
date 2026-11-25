/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON replies and log lines */
/**
 * v3 F6a.1 (ADR 0076 amendment 1): the Reference Types page at Arkona's scale, against the mock LegendKeeper (never
 * fetched; nothing live). The owner's live Arkona on 24 November 2026: 1,493 pages, roughly 150+ distinct Reference Type
 * values. This world seeds 1,500 Authoritative pages under 20 primary categories (an index per category, sub-indexes of
 * 25 pages), each with a realistic sidebar (the Reference Type, Scope, Temporal Scope, the canon rows and a few more) and
 * a real-sized Main document (about 40 blocks, 14 KB of text), then takes a full snapshot (the audit and the appraisal
 * index its hook starts), so the audits' snapshot content is the size it is live.
 *
 * The values: per category, its canonical types as they are, and variants the rules suggest confidently (time words,
 * scope adjectives, case, a missing "Reference"), and a few with no confident suggestion (two roles, unknown words).
 *
 * `drive` is the dashboard's Reference Types page exactly as the UI drives it: the page load (`GET
 * /reference-types?status=open&limit=500`), "Accept all confident suggestions" (`POST /reference-types/bulk-accept`),
 * then the reload (`onChanged`), with heap, RSS and the event loop's lag measured after every request.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { ROOT } from '../discover/world.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';
import { PINNED } from '../packs/owners-world.js';

export const CATEGORIES: readonly { readonly category: string; readonly types: readonly string[] }[] = [
  { category: 'Character', types: ['Character Core', 'Compact Character Reference', 'Character Biography'] },
  {
    category: 'Polity',
    types: ['Polity Reference', 'Polity Constitution Reference', 'Polity History Reference'],
  },
  { category: 'Institution', types: ['Institution Reference', 'Religious Institution Reference'] },
  { category: 'Military', types: ['Military Reference'] },
  { category: 'Culture', types: ['Culture Reference', 'Culture Foundations Reference', 'Lexicon Reference'] },
  { category: 'Religion', types: ['Religion Reference', 'Religious Practice Reference'] },
  { category: 'Event', types: ['Event Reference', 'Conflict Reference', 'Period Reference'] },
  { category: 'Place', types: ['Region Reference', 'Settlement Reference', 'Place Reference'] },
  { category: 'Magic', types: ['Magic Foundation Reference', 'Magical Tradition Reference'] },
  { category: 'Technology', types: ['Technology Reference'] },
  { category: 'Programme', types: ['Programme Reference'] },
  { category: 'Equipment', types: ['Equipment Reference', 'Equipment Tradition Reference'] },
  { category: 'Material', types: ['Material Reference'] },
  { category: 'Law', types: ['Legal Reference', 'Agreement Reference'] },
  { category: 'Species', types: ['Species Reference', 'Subrace Reference'] },
  { category: 'Creature', types: ['Creature Reference'] },
  { category: 'Condition', types: ['Condition Reference'] },
  { category: 'Relationship', types: ['Relationship Reference', 'Political Relationship Reference'] },
  { category: 'Education', types: ['Education Reference'] },
  { category: 'Ceremony', types: ['Ceremony Reference'] },
];

/** The values in use for a category: canonical, confidently suggested variants, and a few with no confident one. */
export function valuesOf(c: (typeof CATEGORIES)[number]): string[] {
  const out = new Set<string>();
  const time = ['Historical', 'Contemporary', 'Historic'];
  const scope = ['Regional', 'Shared', 'Cross-National', 'Local', 'National', 'Transnational'];
  c.types.forEach((t, i) => {
    out.add(t);
    out.add(`${time[i % time.length]} ${t}`);
    out.add(`${scope[i % scope.length]} ${t}`);
    out.add(`${scope[(i + 2) % scope.length]} ${time[(i + 1) % time.length]} ${t}`);
    if (i === 0) out.add(t.toLowerCase());
  });
  // Two roles, or words the rules do not know: no confident suggestion (the owner chooses).
  out.add(`Historical ${c.category} and Ceremony Detail Reference`);
  out.add(`${c.category} Miscellany Reference`);
  return [...out];
}

const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
  ['Continuity', 'Main'],
  ['Inheritance', 'None'],
  ['Temporal Scope', 'From the founding of the tide courts to the end of the Fourth Age'],
  ['Canonical Owner', 'The Arkona setting bible, as approved'],
  [
    'Source Notes',
    'Assembled from the owner’s drafts; the long form of this page’s sidebar runs to several lines',
  ],
];

const words =
  'the harbour courts of the eastern reaches kept their ledgers in salt ink and every toll was argued before the tide gate opened at dawn while the river guilds watched the magistrates and the old families'.split(
    ' ',
  );
const sentence = (seed: number, n: number) =>
  Array.from({ length: n }, (_, i) => words[(seed * 7 + i * 13) % words.length]).join(' ');

/** A real-sized Main document: headings and ~350-character paragraphs, about 40 blocks. */
export function bodyOf(id: string, name: string): unknown[] {
  const blocks: unknown[] = [];
  const sections = [
    'Purpose',
    'Overview',
    'History',
    'Structure',
    'Customs',
    'Relations',
    'Source Boundaries',
    'Unresolved Material',
  ];
  let k = 0;
  for (const s of sections) {
    blocks.push({ id: `${id}h${k++}`, kind: 'heading', level: 2, content: [{ text: s }] });
    for (let p = 0; p < 4; p++)
      blocks.push({
        id: `${id}p${k++}`,
        kind: 'paragraph',
        content: [{ text: `${name}: ${sentence(k, 60)}.` }],
      });
  }
  return blocks;
}

export interface ScaleWorld {
  readonly w: RetagWorld;
  readonly http: OwnerHttp;
  readonly pages: number;
  readonly values: number;
  close(): Promise<void>;
}

/** The Arkona-scale world: `pages` pages (default 1,500) across the 20 categories, snapshot taken, pack approved. */
export async function scaleWorld(
  o: {
    readonly pages?: number;
    readonly snapshot?: boolean;
    readonly logStream?: Writable;
    readonly lkTransport?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<ScaleWorld> {
  const total = o.pages ?? 1500;
  let values = 0;
  const big = {
    'key-min': 100_000,
    'key-hour': 1_000_000,
    'key-day': 10_000_000,
    'project-hour': 1_000_000,
    'write-min': 2000,
  };
  const w = await retagWorld({
    bulk: 0,
    env: { LK_TIER_LIMITS: JSON.stringify(big) },
    limits: big,
    ...(o.logStream ? { logStream: o.logStream } : {}),
    ...(o.lkTransport ? { lkTransport: o.lkTransport } : {}),
    seed: (world) => {
      const r = world.repo;
      const top = r.seed({ id: 'sclroot1', name: '[INDEX] Arkona Scale', parentId: ROOT });
      const per = Math.ceil(total / CATEGORIES.length);
      let n = 0;
      CATEGORIES.forEach((c, ci) => {
        const idx = r.seed({
          id: `scx${ci.toString(36).padStart(5, '0')}`,
          name: `[INDEX] ${c.category}`,
          parentId: top.id,
        });
        const vs = valuesOf(c);
        values += vs.length;
        let sub = idx;
        for (let i = 0; i < per && n < total; i++, n++) {
          if (i % 25 === 0)
            sub = r.seed({
              id: `scs${ci.toString(36)}${(i / 25).toString(36).padStart(4, '0')}`,
              name: `[INDEX] ${c.category} ${i / 25 + 1}`,
              parentId: idx.id,
            });
          const id = `scp${n.toString(36).padStart(5, '0')}`;
          const name = `[BSRC] ${c.category} Source ${i} of the ${['Ashgate', 'Isar', 'Hollow', 'Winter'][i % 4]} cycle`;
          r.seed({
            id,
            name,
            parentId: sub.id,
            tags: ['CANON', c.category],
            referenceType: vs[i % vs.length]!,
            scope: `A long descriptive scope line for ${c.category.toLowerCase()} source ${i} that runs for a while`,
          });
          for (const [k, v] of CANON_ROWS) r.outside.setRow(id, k, v);
          const main = r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!.id;
          r.blocks.set(main, { version: 1, blocks: bodyOf(id, name) });
        }
      });
    },
  });
  const packs = w.stack.runtime.packs;
  const pack = packs.get('arkona')!;
  const src = pack.governance.find((g) => g.key === 'source-formatting')!;
  const doc = w.repo.blocks.get(src.documentId)!;
  doc.blocks.push(
    { id: 'sclsbm01', kind: 'heading', level: 2, content: [{ text: 'Sidebar Metadata' }] },
    { id: 'sclsbm02', kind: 'paragraph', content: [{ text: 'Every page carries PROPERTIES.' }] },
  );
  doc.version++;
  packs.store.setGovernance(
    'arkona',
    pack.governance.map((g) =>
      g.key === 'source-formatting'
        ? { ...g, sections: [...PINNED.formatting, 'Reference Type Vocabulary'] }
        : g,
    ),
  );
  await packs.commands.approve('owner', 'arkona');
  if (o.snapshot !== false) await w.snapshot();
  const http = ownerHttp(w);
  http.stepUp();
  return { w, http, pages: total, values, close: () => w.close() };
}

export interface Sample {
  readonly step: string;
  readonly status: number;
  readonly ms: number;
  readonly heapMb: number;
  readonly rssMb: number;
  /** The event loop's longest delay during the request (ms). */
  readonly lagMaxMs: number;
}

setFlagsFromString('--expose-gc');
/** A full GC (exposed for the measurements), so the heap measured is what is retained. */
export const gc: () => void = runInNewContext('gc') as () => void;

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

/** Runs one request, measuring its time, the heap and RSS after it (after a GC when exposed) and the event loop's lag. */
export async function measure(
  step: string,
  f: () => Promise<{ status: number; json: any }>,
): Promise<Sample & { json: any }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t0 = performance.now();
  const r = await f();
  const ms = Math.round(performance.now() - t0);
  h.disable();
  gc();
  const m = process.memoryUsage();
  return {
    step,
    status: r.status,
    ms,
    heapMb: mb(m.heapUsed),
    rssMb: mb(m.rss),
    lagMaxMs: Math.round(h.max / 1e6),
    json: r.json,
  };
}

/** The page's query, as the UI builds it (status "open" by default; v3 F6a.1: 100 rows a page). */
export const PAGE_QUERY = '/reference-types?status=open&limit=100';

/**
 * "Accept all confident suggestions" exactly as the page sends it: v3 F6a.1's page sends the ids the server listed (at
 * most `bulkMax`); a server that lists none (before F6a.1) gets the request the page sent then (the filter, no ids).
 */
export function acceptAllBody(page: any): Record<string, unknown> {
  if (page?.confident)
    return { ids: (page.confident.ids as string[]).slice(0, page.bulkMax ?? 500), confirm: true };
  return { confirm: true };
}
