/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- tool results are JSON */
/**
 * CR-2026-11-R4, scope item 8 (memory under the new indexes): each path F4b, F4c and F4.1 added, run many times in one
 * process through the real tools on the mock LegendKeeper, with the heap read after a full collection at checkpoints.
 * What a path keeps shows as growth that does not come back; the assertion is on the growth after warm-up and on its
 * slope per round, not a loose ceiling (`test/narrative/read.test.ts` allows 40 MB after twelve rounds, which a leak of
 * 3 MB a round would pass).
 *
 * - MM-01: the consistency tools (`arkona_consistency { all }`, `arkona_as_of`, `arkona_as_of_coverage`).
 * - MM-02: the facts index rebuilt from a new full snapshot every round, then read.
 * - MM-03: the narrative reading tools (`arkona_chapter_context`, `arkona_chapter_check`, live).
 * - MM-04: the calendar loaded on demand (the kept calendar dropped every round, so each load reads and keeps it again).
 *
 * The figures are written to `R4_MEMORY_REPORT` when set (the review's table).
 */
import { appendFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT, narrativeWorld, type NarrativeWorld } from '../../narrative/world.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = 1024 * 1024;

async function settledMb(): Promise<number> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 25));
    gc();
  }
  return process.memoryUsage().heapUsed / MB;
}

/** Least-squares slope of the checkpoints (MB per round). */
function slope(points: readonly { round: number; mb: number }[]): number {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.round, 0) / n;
  const my = points.reduce((s, p) => s + p.mb, 0) / n;
  const num = points.reduce((s, p) => s + (p.round - mx) * (p.mb - my), 0);
  const den = points.reduce((s, p) => s + (p.round - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

async function measure(name: string, rounds: number, every: number, run: (i: number) => Promise<void>) {
  for (let i = 0; i < 3; i++) await run(-1 - i);
  const base = await settledMb();
  const points: { round: number; mb: number }[] = [{ round: 0, mb: 0 }];
  for (let i = 0; i < rounds; i++) {
    await run(i);
    if ((i + 1) % every === 0) points.push({ round: i + 1, mb: (await settledMb()) - base });
  }
  const s = slope(points);
  const line = `${name}: baseline ${base.toFixed(1)} MB; after ${points
    .slice(1)
    .map((p) => `${p.round}: ${p.mb >= 0 ? '+' : ''}${p.mb.toFixed(1)}`)
    .join(', ')} MB; slope ${s.toFixed(3)} MB a round`;
  if (process.env.R4_MEMORY_REPORT) appendFileSync(process.env.R4_MEMORY_REPORT, `${line}\n`);
  return { base, points, slope: s, last: points.at(-1)!.mb, line };
}

let w: NarrativeWorld;
const story = 'Moon Harbour';
const PEOPLE = ['Harun al-Saffar', 'Rashad al-Khalid', 'Yasmin al-Naim', 'Kamigawa Haru'];

beforeAll(async () => {
  w = await narrativeWorld();
  expect((await w.tool('arkona_story_create', { continuity: 'Main CANON', title: story })).status).toBe(
    'written',
  );
  for (const n of [1, 2]) await w.tool('arkona_chapter_plan', { story, number: n, questionGate: 'closed' });
  for (const [n, title, date, present, md] of [
    [1, 'Arrival', 'Camue 3rd, 4A 340', ['Harun al-Saffar'], 'Harun al-Saffar came ashore at dusk.'],
    [
      2,
      'The Tower',
      '4A 350',
      ['Rashad al-Khalid', 'Harun al-Saffar'],
      'Rashad al-Khalid watched the sea. Harun al-Saffar was born in 4A 320, the old men said.',
    ],
  ] as const) {
    const b = await w.tool('arkona_chapter_save', {
      story,
      number: n,
      title,
      inWorldDate: date,
      pov: present[0],
      charactersPresent: [...present],
      locations: [],
      draftStatus: 'Draft',
      markdown: md,
    });
    expect(b.status, JSON.stringify(b)).toBe('written');
  }
  await w.snapshot();
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('memory under the new indexes (scope item 8)', () => {
  it('MM-01: the consistency tools, 40 rounds: the heap comes back to its baseline', async () => {
    const r = await measure('MM-01 consistency tools', 40, 10, async () => {
      await w.tool('arkona_consistency', { all: true });
      await w.tool('arkona_as_of', { characters: PEOPLE, date: 'now' });
      await w.tool('arkona_as_of_coverage', {});
    });
    expect(r.last, r.line).toBeLessThan(6);
    expect(r.slope, r.line).toBeLessThan(0.15);
  });

  it('MM-02: the facts index rebuilt every round (its key changed: a new approved version), 15 rounds', async () => {
    // A full snapshot through the governor's pacing takes about 40 s here; the index's key (the approved phrasings among
    // it) changes with every approved version, so the next read rebuilds the index over the whole overlay.
    const packs = w.stack.runtime.packs;
    const r = await measure('MM-02 facts index rebuilt', 15, 5, async (i) => {
      const rules = packs.get('arkona')!.rules;
      packs.commands.replaceRules(
        'owner',
        'arkona',
        { ...rules, consistency: { ...rules.consistency!, approxMargin: i % 2 === 0 ? 6 : 5 } },
        'R4 MM-02: a new key',
      );
      await packs.commands.approve('owner', 'arkona');
      await w.tool('arkona_as_of', { characters: PEOPLE, date: '4A 350' });
    });
    expect(r.last, r.line).toBeLessThan(8);
    expect(r.slope, r.line).toBeLessThan(0.5);
  });

  it('MM-03: the narrative reading tools, 30 rounds', async () => {
    const r = await measure('MM-03 narrative reading tools', 30, 10, async () => {
      await w.tool('arkona_chapter_context', { story, number: 2 });
      await w.tool('arkona_chapter_check', { story, number: 2 });
    });
    expect(r.last, r.line).toBeLessThan(6);
    expect(r.slope, r.line).toBeLessThan(0.15);
  });

  it('MM-04: the calendar loaded on demand (dropped every round), 40 rounds', async () => {
    const r = await measure('MM-04 calendar on demand', 40, 10, async () => {
      w.stack.db.prepare('DELETE FROM chronology_calendars WHERE project_id = ?').run(PROJECT);
      await w.tool('arkona_as_of', { characters: PEOPLE.slice(0, 2), date: '4A 350' });
    });
    expect(r.last, r.line).toBeLessThan(6);
    expect(r.slope, r.line).toBeLessThan(0.15);
  });
});
