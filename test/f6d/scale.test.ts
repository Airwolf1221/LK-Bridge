/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- parsed JSON replies */
/**
 * v3 F6d (ADR 0082) at Arkona's scale (1,500 sources), against the mock LegendKeeper:
 *
 * - **the 10% rule**: an audit run with templated names (the report built once and stored, and `name_nontemplated`) takes
 *   at most 10% more than the same run without them (the median of seven interleaved runs each, as F6c's);
 * - **the report** at 1,500 pages: the Templated Names page driven as the dashboard drives it (load, a status filter, a
 *   category filter, ten reloads), each GET under 500 ms, the event loop never held for 100 ms, memory flat;
 * - **the status mix** of a world shaped like Arkona (its names mostly `<Subject> - <Reference Type>`; some Subjects
 *   empty; some types not yet canonical), printed for the owner's expectations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../discover/world.js';
import { PINNED } from '../packs/owners-world.js';
import { PROJECT, retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { ownerHttp, type OwnerHttp } from '../automation/helpers.js';
import { measure, type Sample } from '../f6a1/world.js';
import { STATUSES } from '../../src/packs/names/template.js';

const PAGES = 1500;
/** The Arkona pack's draft vocabulary types used (Polity, Culture, Institution), with their role words. */
const TYPES = [
  { tag: 'Polity', type: 'Polity Reference', role: 'Polity' },
  { tag: 'Polity', type: 'Polity History Reference', role: 'History' },
  { tag: 'Culture', type: 'Culture Reference', role: 'Culture' },
  { tag: 'Culture', type: 'Language & Naming Reference', role: 'Language & Naming' },
  { tag: 'Institution', type: 'Institution Reference', role: 'Institution' },
];

let w: RetagWorld;
let http: OwnerHttp;
const rt = () => w.stack.runtime;

/** One source in 100 by shape (an Arkona-like mix: see the module comment). */
function shape(p: number): 'rename' | 'templated' | 'noSubject' | 'variant' | 'twin' | 'character' {
  const k = p % 100;
  if (k < 58) return 'rename';
  if (k < 68) return 'templated';
  if (k < 80) return 'noSubject';
  if (k < 94) return 'variant';
  if (k < 97) return 'twin';
  return 'character';
}

beforeAll(async () => {
  const big = { 'key-min': 100_000, 'key-hour': 1_000_000, 'key-day': 10_000_000, 'project-hour': 1_000_000 };
  w = await retagWorld({
    bulk: 0,
    env: { LK_TIER_LIMITS: JSON.stringify(big) },
    limits: big,
    seed: (world) => {
      const r = world.repo;
      const homes: string[] = [];
      for (let i = 0; i < 30; i++)
        homes.push(
          r.seed({ id: `f6dh${String(i).padStart(4, '0')}`, name: `[INDEX] Home ${i}`, parentId: ROOT }).id,
        );
      for (let p = 0; p < PAGES; p++) {
        const s = shape(p);
        // Twins share one type, so their templates are one name.
        const t = s === 'twin' ? TYPES[0]! : TYPES[p % TYPES.length]!;
        const subject = `Subject ${p}`;
        const id = `f6dp${p.toString(36).padStart(4, '0')}`;
        const parentId = homes[p % homes.length]!;
        const name =
          s === 'templated'
            ? `[BSRC] ${subject} - ${t.role}`
            : s === 'twin'
              ? `[BSRC] Twin ${Math.floor(p / 2)} ${p % 2 === 0 ? 'Notes' : 'Overview'}`
              : s === 'character'
                ? `[BSRC] ${subject} - Character Biography`
                : `[BSRC] ${subject} - ${t.type}`;
        r.seed({
          id,
          name,
          parentId: s === 'twin' ? homes[0]! : parentId,
          tags: ['CANON', s === 'character' ? 'Character' : t.tag],
          referenceType:
            s === 'variant' ? `${t.tag} Overview` : s === 'character' ? 'Character Biography' : t.type,
        });
        if (s !== 'noSubject')
          r.outside.setRow(id, 'Subject', s === 'twin' ? `Twin ${Math.floor(p / 2)}` : subject);
      }
    },
  });
  // The vocabulary published (as the owner would: Sidebar Metadata, publish, approve again).
  const packs = rt().packs;
  const pack = packs.get('arkona')!;
  const src = pack.governance.find((g) => g.key === 'source-formatting')!;
  const doc = w.repo.blocks.get(src.documentId)!;
  doc.blocks.push(
    { id: 'f6dsbm01', kind: 'heading', level: 2, content: [{ text: 'Sidebar Metadata' }] },
    { id: 'f6dsbm02', kind: 'paragraph', content: [{ text: 'Every page carries PROPERTIES.' }] },
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
  await w.snapshot();
  const pub = await rt().referenceTypes.publish('owner', PROJECT);
  await rt().engine.wait(PROJECT, pub.jobId!, 60_000);
  await packs.governance('arkona');
  await packs.commands
    .approve('owner', 'arkona')
    .catch(async () => packs.commands.approve('owner', 'arkona'));
  expect(packs.approvedRules('arkona')!.referenceTypes!.status).toBe('published');
  await w.snapshot();
  await rt().audits.run(PROJECT, 'manual');
  http = ownerHttp(w);
}, 900_000);
afterAll(async () => w?.close());

const auditMs = async (): Promise<number> => {
  const t0 = performance.now();
  const r = await rt().audits.run(PROJECT, 'manual');
  expect(r.state).toBe('succeeded');
  return performance.now() - t0;
};

describe('templated names at Arkona’s scale', () => {
  it('the status mix of an Arkona-shaped world (for the owner’s expectations)', () => {
    const r = rt().templatedNames.report(PROJECT, { limit: 1 });
    expect(r.state).toBe('ready');
    // This fixture's pages only (the world has a few of its own).
    const mine = Object.fromEntries(STATUSES.map((x) => [x, 0])) as Record<(typeof STATUSES)[number], number>;
    for (let offset = 0; ; offset += 500) {
      const page = rt().templatedNames.store.rows(PROJECT, { offset, limit: 500 }).rows;
      for (const row of page) if (row.pageId.startsWith('f6dp')) mine[row.status]++;
      if (page.length < 500) break;
    }
    console.log(
      `templated names at ${PAGES} sources: ${JSON.stringify(mine)}; left out: ${JSON.stringify(r.meta!.excluded)}`,
    );
    expect(mine.rename).toBeGreaterThan(PAGES * 0.5);
    expect(mine.templated).toBe(Math.round(PAGES * 0.1));
    expect(mine.held_no_subject).toBe(Math.round(PAGES * 0.12));
    expect(mine.held_type).toBe(Math.round(PAGES * 0.14));
    expect(mine.held_collision).toBeGreaterThan(0);
    expect(r.meta!.excluded['registered character']).toBeGreaterThanOrEqual(PAGES * 0.03);
    const f = rt().audits.store.list(PROJECT, { code: ['name_nontemplated'], state: 'open', limit: 5000 });
    expect(f.findings.length).toBe(rt().templatedNames.report(PROJECT).counts.rename);
  });

  it('templated names add at most 10% to an audit run', async () => {
    const audits = rt().audits as unknown as { d: Record<string, unknown> };
    const withNames = audits.d;
    const without = { ...withNames, templatedNames: undefined, templatedNamesSink: undefined };
    const off: number[] = [];
    const on: number[] = [];
    // Diagnostics (printed): the check alone, without storing the report.
    audits.d = { ...withNames, templatedNamesSink: undefined };
    const checkOnly = await auditMs();
    audits.d = withNames;
    await auditMs(); // warm
    try {
      for (let i = 0; i < 7; i++) {
        audits.d = without;
        off.push(await auditMs());
        audits.d = withNames;
        on.push(await auditMs());
      }
    } finally {
      audits.d = withNames;
    }
    const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(
      `audit run: with ${Math.round(mid(on))} ms, without ${Math.round(mid(off))} ms (check only, once: ${Math.round(checkOnly)} ms)`,
    );
    expect(
      mid(on),
      `on ${on.map(Math.round).join(', ')} ms; off ${off.map(Math.round).join(', ')} ms`,
    ).toBeLessThanOrEqual(mid(off) * 1.1);
  }, 600_000);

  it('the Templated Names page: each GET under 500 ms, the loop never held for 100 ms, memory flat', async () => {
    const samples: (Sample & { json: any })[] = [];
    samples.push(await measure('load', () => http.get('/templated-names?limit=100')));
    samples.push(await measure('rename', () => http.get('/templated-names?status=rename&limit=100')));
    samples.push(
      await measure('category', () => http.get('/templated-names?category=Culture&offset=200&limit=100')),
    );
    for (let i = 0; i < 10; i++)
      samples.push(await measure(`reload ${i}`, () => http.get('/templated-names?limit=100')));
    for (const x of samples) {
      expect(x.status, JSON.stringify(x.json).slice(0, 300)).toBe(200);
      expect(x.ms, `${x.step} took ${x.ms} ms`).toBeLessThan(500);
      expect(x.lagMaxMs, `${x.step} held the loop ${x.lagMaxMs} ms`).toBeLessThan(100);
    }
    expect(samples[0]!.json.report.total).toBeGreaterThanOrEqual(PAGES * 0.97);
    expect(samples[0]!.json.report.rows).toHaveLength(100);
    const last = samples.at(-1)!;
    expect(last.heapMb - samples[0]!.heapMb).toBeLessThan(64);
    expect(last.rssMb - samples[0]!.rssMb).toBeLessThan(128);
  }, 300_000);
});
