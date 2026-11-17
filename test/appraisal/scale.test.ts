/**
 * v3 F3c, A1 (ADR 0054): how long building and updating the full-text index takes, and how big it is, on a fixture of
 * Arkona's size (about 1,500 pages), measured. The snapshot is synthetic (Arkona-shaped: a 17-row sidebar with
 * Dependencies and Related Sources, a Main document of about 40 blocks and 600 words with headings, mentions and a
 * table, an alias or two), so nothing is fetched; its pieces are canonical and gzipped in a real snapshot store on disk,
 * as a nightly snapshot leaves them, and the index, its SQL and the database are the real ones, on a file.
 *
 * The figures are printed (`APPRAISAL SCALE …`) and the ADR quotes them; the bounds asserted here are generous, so a slow
 * machine does not fail the suite.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { SnapshotSource } from '../../src/audits/reader.js';
import { AppraisalIndex } from '../../src/appraisal/overlay.js';
import { FullText } from '../../src/appraisal/fts.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { canonicalBytes } from '../../src/snapshots/canonical.js';
import type { Manifest, PageEntry } from '../../src/snapshots/manifest.js';
import { SnapshotStore } from '../../src/snapshots/store.js';

vi.setConfig({ testTimeout: 300_000 });

const PAGES = 1500;
const PROJECT = 'prj_scale';
const dir = mkdtempSync(join(tmpdir(), 'lkb-appraisal-scale-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WORDS = (
  'the archive of the tide gate kept charters seals and ledgers of every house that sailed the outer reefs ' +
  'while the council of the hollow court argued over salt rights harbour tolls and the old canon of the sultanate'
).split(' ');

let seed = 7;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const sentence = (n: number) => Array.from({ length: n }, () => WORDS[rand(WORDS.length)]).join(' ');
const id = (i: number) => `pg${i.toString(36).padStart(6, '0')}`;

function page(i: number, version = 0) {
  const pid = id(i);
  const blocks: Record<string, unknown>[] = [];
  const h = (t: string, level = 2) =>
    blocks.push({ id: `${pid}h${blocks.length}`, kind: 'heading', level, content: [{ text: t }] });
  const p = (t: string, mention?: number) =>
    blocks.push({
      id: `${pid}p${blocks.length}`,
      kind: 'paragraph',
      content:
        mention === undefined
          ? [{ text: t }]
          : [{ text: `${t} ` }, { mention: { resourceId: id(mention), text: `Page ${mention}` } }],
    });
  h('Purpose');
  p(`${sentence(20)} version ${version}`);
  for (const s of [
    'Overview',
    'History',
    'Society',
    'Relations',
    'Source Boundaries',
    'Unresolved Material',
  ]) {
    h(s);
    for (let k = 0; k < 5; k++) p(sentence(16), k === 0 ? rand(PAGES) : undefined);
  }
  blocks.push({
    id: `${pid}tab`,
    kind: 'table',
    children: [0, 1, 2].map((r) => ({
      id: `${pid}r${r}`,
      kind: 'tableRow',
      children: [0, 1].map((c) => ({
        id: `${pid}c${r}${c}`,
        kind: 'tableCell',
        children: [{ id: `${pid}cp${r}${c}`, kind: 'paragraph', content: [{ text: sentence(4) }] }],
      })),
    })),
  });
  const keys = [
    'Status',
    'Continuity Type',
    'Continuity',
    'Inheritance',
    'Subject',
    'Canonical Display Name',
    'Personal / Given Name',
    'Family / Surname',
    'Naming Culture',
    'Aliases',
    'Reference Type',
    'Scope',
    'Race / Species',
    'Life State',
    'Temporal Scope',
    'Last Major Revision',
    'Supersedes',
  ];
  const sidebar = {
    properties: [
      {
        id: `${pid}kv`,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: keys.map((k, r) => ({ id: `${pid}k${r}`, key: k, content: [{ text: `${k} of page ${i}` }] })),
      },
      {
        id: `${pid}dp`,
        kind: 'resourceCollection',
        title: 'Dependencies',
        items: [{ id: 'd1', resourceId: id(rand(PAGES)) }],
      },
      {
        id: `${pid}rl`,
        kind: 'resourceCollection',
        title: 'Related Sources',
        items: [{ id: 'r1', resourceId: id(rand(PAGES)) }],
      },
    ],
  };
  const resource = { name: `[BSRC] Page ${i} - Reference`, tags: ['CANON'], aliases: [`Alias ${i}`] };
  return { pid, resource, sidebar, document: { settings: { name: 'Main', type: 'page' }, blocks } };
}

/** A snapshot source: the manifests in memory, the pieces canonical and gzipped in a real store on disk. */
async function source(
  store: SnapshotStore,
): Promise<{ src: SnapshotSource; addChange: (pages: number[], version: number) => Promise<void> }> {
  await store.ensure();
  const put = async (v: unknown) => {
    const r = await store.putBytes(canonicalBytes(v), { compress: 'text' });
    return { sha256: r.sha256, size: r.size };
  };
  const entry = async (i: number, version: number): Promise<PageEntry> => {
    const pg = page(i, version);
    return {
      id: pg.pid,
      parentId: i === 0 ? null : i < 40 ? id(0) : id(1 + (i % 39)),
      rank: String(i).padStart(6, '0'),
      name: pg.resource.name,
      kind: 'bsrc',
      resource: await put(pg.resource),
      sidebar: await put(pg.sidebar),
      documents: [{ id: `${pg.pid}doc`, type: 'page', name: 'Main', ...(await put(pg.document)) }],
    };
  };
  const manifest = (snapId: string, kind: 'full' | 'change', pages: PageEntry[]): Manifest =>
    ({
      format: 'lk-bridge-snapshot',
      version: 1,
      id: snapId,
      project: { id: PROJECT, name: 'scale' },
      kind,
      takenAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      rootId: id(0),
      complete: true,
      trigger: {},
      pages,
      library: null,
      counts: { pages: pages.length, pieces: 0, logicalBytes: 0, missing: 0 },
    }) as unknown as Manifest;
  const manifests = new Map<string, Manifest>();
  const t0 = Date.now() - 3_600_000;
  const full: PageEntry[] = [];
  for (let i = 0; i < PAGES; i++) full.push(await entry(i, 0));
  manifests.set('F1', manifest('F1', 'full', full));
  const changes: { id: string; takenAt: number }[] = [];
  return {
    src: {
      fulls: () => [{ id: 'F1', takenAt: t0 }],
      changesAfter: (_p, after) => changes.filter((c) => c.takenAt > after),
      manifest: (sid) => Promise.resolve(manifests.get(sid) ?? null),
      piece: (sha) => store.getJson<unknown>(sha),
    },
    async addChange(pages, version) {
      const cid = `C${changes.length + 1}`;
      const list: PageEntry[] = [];
      for (const i of pages) list.push(await entry(i, version));
      manifests.set(cid, manifest(cid, 'change', list));
      changes.push({ id: cid, takenAt: t0 + 60_000 * (changes.length + 1) });
    },
  };
}

it(`builds and updates the index of ${PAGES} pages, and measures it`, async () => {
  const file = join(dir, 'bridge.db');
  const db = openDatabase(file);
  runMigrations(db);
  const { src, addChange } = await source(new SnapshotStore(join(dir, 'snapshots')));
  const index = new AppraisalIndex({
    db,
    source: () => src,
    propertiesName: () => 'PROPERTIES',
    now: () => Date.now(),
  });
  const sizeBefore = statSync(file).size;
  const t0 = performance.now();
  const built = await index.ensure(PROJECT);
  const buildMs = performance.now() - t0;
  expect(built.built).toBe(true);
  const st = index.state(PROJECT)!;
  expect(st.pages).toBe(PAGES);
  // One change snapshot of five pages (a typical bridge write touches one or two).
  await addChange([3, 50, 700, 1200, 1499], 1);
  const t1 = performance.now();
  const upd = await index.ensure(PROJECT);
  const updateMs = performance.now() - t1;
  expect(upd.applied).toBe(1);
  const ft = new FullText(db);
  const t2 = performance.now();
  const hits = ft.pagesFor(PROJECT, { value: 'version 1', phrase: true });
  const queryMs = performance.now() - t2;
  // A word is a prefix (no prefix index is kept): the widest, a two-letter one.
  const t3 = performance.now();
  const wide = ft.pagesFor(PROJECT, { value: 'ha', phrase: false });
  const prefixQueryMs = performance.now() - t3;
  expect(wide.size).toBe(PAGES);
  expect([...hits.keys()].sort()).toEqual([3, 50, 700, 1200, 1499].map(id).sort());
  expect(ft.pagesFor(PROJECT, { value: 'version 0', phrase: true }).size).toBe(PAGES - 5);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const after = index.state(PROJECT)!;
  const fileGrowth = statSync(file).size - sizeBefore;
  const figures = {
    pages: PAGES,
    units: after.units,
    refs: after.refs,
    buildMs: Math.round(buildMs),
    buildMsRecorded: st.buildMs,
    updateMs: Math.round(updateMs),
    updateMsRecorded: after.lastUpdateMs,
    phraseQueryMs: Math.round(queryMs * 10) / 10,
    prefixQueryMs: Math.round(prefixQueryMs * 10) / 10,
    indexBytes: after.sizeBytes,
    indexMB: Math.round(((after.sizeBytes ?? 0) / 1_048_576) * 10) / 10,
    dbFileGrowthMB: Math.round((fileGrowth / 1_048_576) * 10) / 10,
  };
  console.log(`APPRAISAL SCALE ${JSON.stringify(figures)}`);
  expect(buildMs).toBeLessThan(120_000);
  expect(updateMs).toBeLessThan(10_000);
  expect(after.sizeBytes).toBeGreaterThan(0);
  db.close();
});
