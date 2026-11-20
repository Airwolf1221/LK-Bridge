/**
 * v3 F4b (ADR 0064): the facts index over the appraisal's overlay, on a hand-made snapshot source (no stack):
 *
 * - **incremental** from change snapshots, like the other F3c indexes: a change snapshot re-reads only the page it took;
 * - **rebuilt** when what the facts are read with changes (the key);
 * - **bounded and streaming** (CR-2026-11-R3 found per-event retention): the extraction runs repeatedly over 1,500 pages
 *   and the heap, after a full collection, returns to its baseline.
 */
import { readFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SnapshotSource } from '../../src/audits/reader.js';
import { AppraisalIndex } from '../../src/appraisal/overlay.js';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../src/calendar/index.js';
import { compilePatterns, type NameIndex } from '../../src/consistency/extract.js';
import { FactIndex, type ExtractEnv } from '../../src/consistency/facts-index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { nameKeyOf } from '../../src/packs/naming/namesakes.js';
import type { Manifest, PageEntry } from '../../src/snapshots/manifest.js';

vi.setConfig({ testTimeout: 300_000 });
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as {
  calendar: unknown;
};
const cal = createCalendar(ORACLE.calendar);
const PROJECT = 'prj_facts';
const PAGES = 1500;
const db = openDatabase(':memory:');
runMigrations(db);
afterAll(() => db.close());

const pieces = new Map<string, unknown>();
const ref = (sha: string) => ({ sha256: sha, size: 1 });
const id = (i: number) => `pg${String(i).padStart(6, '0')}`;
function page(i: number, birthYear: number): PageEntry {
  const pid = id(i);
  pieces.set(`res-${pid}-${birthYear}`, { name: `[BSRC] Person ${i} - Character Core`, tags: ['CANON'] });
  pieces.set(`sb-${pid}-${birthYear}`, {
    properties: [
      {
        id: `kv${pid}`,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { id: `s${pid}`, key: 'Subject', content: [{ text: `Person ${i}` }] },
          {
            id: `t${pid}`,
            key: 'Temporal Scope',
            content: [{ text: `Born Camue 1st, 4A ${birthYear}; attested through 5A 931` }],
          },
          { id: `r${pid}`, key: 'Race / Species', content: [{ text: 'Human' }] },
        ],
      },
    ],
  });
  pieces.set(`doc-${pid}-${birthYear}`, {
    settings: { name: 'Main', type: 'page' },
    blocks: Array.from({ length: 30 }, (_, k) => ({
      id: `${pid}b${k}`,
      kind: 'paragraph',
      content: [
        {
          text:
            k === 3
              ? `Person ${(i + 1) % PAGES} was born on Camue 2nd, 4A ${birthYear}, in the harbour quarter. `.repeat(
                  2,
                )
              : `Line ${k} of the harbour rolls: the stores were counted and sealed again at dusk. `.repeat(
                  4,
                ),
        },
      ],
    })),
  });
  return {
    id: pid,
    parentId: 'root0001',
    rank: pid,
    name: `[BSRC] Person ${i} - Character Core`,
    kind: 'bsrc',
    resource: ref(`res-${pid}-${birthYear}`),
    sidebar: ref(`sb-${pid}-${birthYear}`),
    documents: [{ id: `d${pid}`, type: 'page', name: 'Main', ...ref(`doc-${pid}-${birthYear}`) }],
  };
}
pieces.set('res-root', { name: '[INDEX] AI REPOSITORY', tags: [] });
const manifest = (mid: string, kind: 'full' | 'change', pages: PageEntry[]): Manifest =>
  ({
    format: 'lk-bridge-snapshot',
    version: 1,
    id: mid,
    project: { id: PROJECT, name: 'facts' },
    kind,
    takenAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    rootId: 'root0001',
    complete: true,
    trigger: {},
    pages,
    library: null,
    counts: { pages: pages.length, pieces: pages.length * 3, logicalBytes: 0, missing: 0 },
  }) as unknown as Manifest;
const full = manifest('F1', 'full', [
  {
    id: 'root0001',
    parentId: null,
    rank: 'a',
    name: '[INDEX] AI REPOSITORY',
    kind: 'index',
    resource: ref('res-root'),
  },
  ...Array.from({ length: PAGES }, (_, i) => page(i, 100 + (i % 500))),
]);
const changes: { id: string; takenAt: number; m: Manifest }[] = [];
const source: SnapshotSource = {
  fulls: () => [{ id: 'F1', takenAt: Date.now() - 3_600_000 }],
  changesAfter: () => changes.map((c) => ({ id: c.id, takenAt: c.takenAt })),
  manifest: (mid) => Promise.resolve(mid === 'F1' ? full : (changes.find((c) => c.id === mid)?.m ?? null)),
  piece: (sha) => Promise.resolve(pieces.get(sha) ?? null),
};
const overlay = new AppraisalIndex({
  db,
  source: () => source,
  propertiesName: () => 'PROPERTIES',
  now: Date.now,
});
const facts = new FactIndex(db, Date.now);
const known = new Set(Array.from({ length: PAGES }, (_, i) => nameKeyOf(`Person ${i}`)));
const names: NameIndex = { lookup: (k) => (known.has(k) ? 'name' : null) };
const env = (key: string): ExtractEnv => ({
  key,
  ctx: { compiled: compilePatterns(ARKONA_PACK.rules.consistency!), names, cal, style: DEFAULT_DATE_STYLE },
  rows: () => Promise.resolve([]),
  chronologyPageId: null,
});
const ensure = async (key: string) => {
  const st = (await overlay.ensure(PROJECT)).state!;
  return facts.ensure(
    PROJECT,
    { pages: overlay.pages(PROJECT), baseSnapshotId: st.baseSnapshotId },
    env(key),
  );
};

describe('the facts index (ADR 0064)', () => {
  it('builds from the overlay: each page’s Temporal Scope, identity fields and prose births', async () => {
    const r = await ensure('k1');
    expect(r.built).toBe(true);
    const st = facts.state(PROJECT)!;
    expect(st.pages).toBe(PAGES + 1);
    const on = facts.factsOn(PROJECT, [id(7)]);
    expect(on.find((f) => f.pattern === 'birth.scope')).toMatchObject({ valueText: 'Camue 1st, 4A 107' });
    expect(on.find((f) => f.kind === 'identity')).toMatchObject({
      field: 'Race / Species',
      valueText: 'Human',
    });
    // Page 6's text names Person 7: found by the name, never by a pronoun.
    expect(
      facts
        .factsAbout(PROJECT, [nameKeyOf('Person 7')])
        .some((f) => f.pageId === id(6) && f.pattern === 'birth.prose'),
    ).toBe(true);
  });

  it('is incremental: a change snapshot re-reads only the page it took', async () => {
    expect((await ensure('k1')).reread).toBe(0);
    changes.push({ id: 'C1', takenAt: Date.now(), m: manifest('C1', 'change', [page(7, 333)]) });
    const r = await ensure('k1');
    expect(r).toEqual({ built: false, reread: 1 });
    expect(facts.factsOn(PROJECT, [id(7)]).find((f) => f.pattern === 'birth.scope')).toMatchObject({
      valueText: 'Camue 1st, 4A 333',
    });
  });

  it('is rebuilt when what the facts are read with changes (the pack’s phrasings, the names, the calendar)', async () => {
    expect((await ensure('k2')).built).toBe(true);
  });

  it('repeated full extractions return the heap to its baseline (bounded, streaming)', async () => {
    const settled = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 20));
        gc();
      }
      return process.memoryUsage().heapUsed / MB;
    };
    await ensure('warm');
    const baseline = await settled();
    const after: number[] = [];
    for (let i = 0; i < 6; i++) {
      await ensure(`run-${i}`);
      after.push(await settled());
    }
    console.log(
      `facts index heap: baseline ${baseline.toFixed(1)} MB; after each run ${after.map((x) => x.toFixed(1)).join(', ')} MB`,
    );
    // Nothing is kept between runs: the last run's heap is within a few MB of the first's (rounding and V8's own).
    expect(
      Math.max(...after) - baseline,
      `baseline ${baseline.toFixed(1)} MB, after ${after.map((x) => x.toFixed(1)).join(', ')}`,
    ).toBeLessThan(8);
    expect(after[after.length - 1]! - after[0]!).toBeLessThan(4);
  });
});
