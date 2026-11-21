/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * ADR 0064 amendment 1: the integration test of the first live run's findings (run `apr_7e189380f2f0ee05`, 20 November
 * 2026), against the REAL stack on the mock LegendKeeper, on a world built from the excerpts the owner quoted
 * (test/consistency/live-world.ts). The run's expected result: no Contradictory finding for the four false pairs; Soren's
 * death read from the Falkenreich line; Finn's, Tobias's, Murad's and Leopold's facts attributed to them; Unreadable only
 * for a date-shaped text the calendar refuses; coverage in buckets that add up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nameKeyOf } from '../../src/packs/naming/namesakes.js';
import { P, PROJECT } from './world.js';
import { L, LIVE_SUBJECTS, liveRunWorld, type LiveWorld } from './live-world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: LiveWorld;
let run: any;
beforeAll(async () => {
  w = await liveRunWorld();
  await w.snapshot();
  // The whole run, read a page at a time from its stored run (a long answer would come back as a handle).
  const first = await call('arkona_consistency', { all: true, limit: 1 });
  const findings: any[] = [];
  for (let offset = 0; offset < first.total; offset += 5)
    findings.push(
      ...(await call('arkona_consistency', { runId: first.runId, offset, limit: 5, detail: 'full' }))
        .findings,
    );
  run = { ...first, findings };
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await w.call(tool, { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};

/** The subjects the run's excerpts are about: this world's characters, and F4b's Rashad and Titania. */
const SUBJECTS = new Set([...Object.values(LIVE_SUBJECTS), 'Rashad al-Khalid', 'Titania']);
const ours = (b: any) => (b.findings as any[]).filter((f) => SUBJECTS.has(f.details.subject));

/** The numbers the report quotes (printed with LIVE_RUN_REPORT=1). */
function summary(b: any, coverage: any) {
  const list = ours(b);
  const by = (g: string) => list.filter((f) => f.group === g).length;
  return {
    contradictory: by('contradictory'),
    gaps: by('gaps'),
    unreadable: by('unreadable'),
    unreadableValues: list
      .filter((f) => f.group === 'unreadable')
      .flatMap((f) => (f.details.restatements as any[]).map((r) => `${f.details.subject}: ${r.value}`)),
    contradictoryPairs: list
      .filter((f) => f.group === 'contradictory')
      .map((f) => `${f.details.subject} (${f.details.what})`),
    gapSubjects: list
      .filter((f) => f.group === 'gaps')
      .map((f) => `${f.details.subject} (${f.details.what})`),
    coverage: coverage.counts,
    flags: coverage.flags ?? null,
  };
}

const factsOf = (pageId: string) =>
  w.stack.db
    .prepare(
      'SELECT kind, subject_key, subject_text, matched_as, value_text, unreadable FROM consistency_facts WHERE project_id = ? AND page_id = ? ORDER BY seq',
    )
    .all(PROJECT, pageId) as {
    kind: string;
    subject_key: string;
    subject_text: string;
    matched_as: string;
    value_text: string;
    unreadable: string | null;
  }[];

describe('the first live run, rebuilt from its excerpts (ADR 0064 amendment 1)', () => {
  it('reports its numbers (LIVE_RUN_REPORT=1)', async () => {
    const coverage = await call('arkona_as_of_coverage', { detail: 'full' });
    if (process.env.LIVE_RUN_REPORT === '1') console.log(JSON.stringify(summary(run, coverage), null, 2));
    expect(run.counts.total).toBeGreaterThan(0);
  });

  it('A: no Contradictory finding for the four false pairs, and none at all among the run’s subjects', () => {
    const list = ours(run);
    for (const s of ['Soren von Woerfels', 'Veresa von Mader', 'Daryavan al-Khalid', 'Yvonne von Hohenfalk'])
      expect(
        list.filter((f) => f.details.subject === s && f.group !== 'gaps'),
        s,
      ).toEqual([]);
    expect(list.filter((f) => f.group === 'contradictory')).toEqual([]);
    // Veresa's and Yvonne's own pages leave a date unestablished, and no sentence about them gives one: no Gap either.
    expect(
      list.filter((f) => ['Veresa von Mader', 'Yvonne von Hohenfalk'].includes(f.details.subject)),
    ).toEqual([]);
  });

  it('A: Finn’s, Tobias’s, Murad’s and Leopold’s facts are attributed to them, never to the page’s character', () => {
    const one = (pageId: string) => {
      const f = factsOf(pageId).filter((x) => x.kind !== 'identity' && x.matched_as !== 'page');
      expect(f, pageId).toHaveLength(1);
      return f[0]!;
    };
    expect(one(L.soren)).toMatchObject({
      kind: 'death',
      subject_key: nameKeyOf('Tobias von Hohenfalk'),
      value_text: 'Azah 3rd, 3A 98',
    });
    // "Finn" alone is Finn von Mader's given name: his, counted only on his own pages (F4b's narrowing).
    expect(one(L.veresa)).toMatchObject({
      kind: 'death',
      subject_key: 'finn',
      matched_as: 'given',
      value_text: 'Kusha 9th, 4A 12',
    });
    expect(one(L.daryavan)).toMatchObject({
      kind: 'birth',
      subject_key: nameKeyOf('Murad al-Khalid'),
      value_text: 'Malakh 33rd, 4A 280',
    });
    expect(one(L.yvonne)).toMatchObject({
      kind: 'birth',
      subject_key: nameKeyOf('Leopold I von Hohenfalk'),
      value_text: 'Camue 47th, 3A 231',
    });
  });

  it('A: Soren’s death is read from the Falkenreich line, and "as of a date" uses it', async () => {
    expect(factsOf(L.falkenreich)).toEqual([
      expect.objectContaining({
        kind: 'death',
        subject_key: nameKeyOf('Soren von Woerfels'),
        value_text: 'Frostmoot 4th, 3A 167',
      }),
    ]);
    const a = (await call('arkona_as_of', { characters: [L.soren], date: '3A 200' })).characters[0];
    // CR-2026-11-R4 (RC-7): a death restated on another Authoritative page feeds the death guard, and his identity page's
    // Life State is "Alive" (this fixture's default): never a bare "Deceased (recorded)" against it (F4b.1 answered
    // "Deceased (recorded)"); the death is still the one used.
    expect(a.state).toMatchObject({ value: 'Unestablished (recorded death; current Life State Alive)' });
    expect(a.state.why).toMatch(/Frostmoot 4th, 3A 167/);
    expect(a.died).toMatchObject({ value: 'Frostmoot 4th, 3A 167', page: { id: L.falkenreich } });
  });

  it('B, C: dates found inside their clause, and the chronology rows read by their columns', () => {
    const lineage = factsOf(L.lineage);
    expect(lineage).toEqual([
      expect.objectContaining({
        kind: 'birth',
        subject_key: nameKeyOf('Rashad al-Khalid'),
        value_text: 'Camue 44th, 4A 360',
      }),
    ]);
    const rows = factsOf(P.fourthAge);
    const want: [string, string, string][] = [
      ['Adelheid von Falkenrath', 'birth', 'Jehet 27th, 4A 84'],
      ['Elias Brenner', 'birth', 'Jehet 39th, 4A 100'],
      ['Kamigawa Kaito', 'birth', 'Kusha 17th, 2A 67,189'],
      ['Varadi Bendeguz', 'birth', 'Selaphos 40th, 3A 78'],
      ['Zhuang Tianlong', 'birth', 'Isar 35th, 2A 698,131'],
      ['Yasusuna Tsuru', 'birth', 'Malakh 39th, 2A 66,799'],
      ['Shibukawa Akari', 'birth', 'Camue 50th, 1A 34'],
      ['Vahuka Arshama', 'birth', 'Pahan 5th, 2A 749,452'],
      ['Khshayayarsha Arshama', 'death', 'Azah 19th, 3A 6'],
      ['Yasmin Arshama', 'birth', 'Camue 1st, 4A 100'],
    ];
    for (const [who, kind, date] of want)
      expect(rows, who).toContainEqual(
        expect.objectContaining({ kind, subject_key: nameKeyOf(who), value_text: date, unreadable: null }),
      );
    // No row of the chronology is read as its joined text: every fact on its page is a row's (by its columns).
    expect(rows.every((f) => !/\|/.test(f.value_text))).toBe(true);
  });

  it('C: Yasmin Arshama’s birth is Mehrana al-Khalid’s (her birth-name alias), and agrees with her identity page', async () => {
    const b = await call('arkona_consistency', { subject: L.mehrana, detail: 'full' });
    expect(b.findings).toEqual([]);
    const a = (await call('arkona_as_of', { characters: [L.mehrana], date: 'Camue 1st, 4A 120' }))
      .characters[0];
    expect(a.born).toMatchObject({ value: 'Camue 1st, 4A 100' });
    expect(a.around.before.map((r: any) => r.event)).toContain('Yasmin Arshama is born in Khorshahr');
  });

  it('D: a dateless "Deceased" is a state, "Deceased by" a bound, "death date unestablished" a gap: nothing unreadable', () => {
    const list = ours(run);
    for (const s of [
      'Cordelia von Katzen',
      'Mannfred von Katzen',
      'Jahan-Timur',
      'Jamil al-Fajr',
      'Shibata Miyako',
    ])
      expect(
        list.filter((f) => f.details.subject === s),
        s,
      ).toEqual([]);
    const dated = factsOf(L.cordelia).filter((f) => f.kind === 'death');
    expect(dated).toEqual([
      expect.objectContaining({ value_text: 'Selyros 19th, 4A 114', unreadable: null }),
    ]);
    expect(factsOf(L.jahan).filter((f) => f.kind === 'death')).toEqual([
      expect.objectContaining({ value_text: expect.stringMatching(/death date unestablished/) }),
      expect.objectContaining({ value_text: expect.stringMatching(/death date unestablished/) }),
    ]);
  });

  it('E: identity values with differing qualifiers are not a conflict (Katsuragi Koharu, Murket)', () => {
    expect(ours(run).filter((f) => ['Katsuragi Koharu', 'Murket'].includes(f.details.subject))).toEqual([]);
  });

  it('F: with the switch on, only the Biography’s current sentence is compared with Purandukht Mithra’s gap', async () => {
    const gap = ours(run).filter((f) => f.details.subject === 'Purandukht Mithra');
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ group: 'gaps' });
    expect(gap[0].details.restatements).toEqual([
      expect.objectContaining({
        value: 'Zarzakh 17th, 2A 748,455',
        page: expect.objectContaining({ id: L.yueBio }),
        section: 'Birth and Upbringing',
      }),
    ]);
    expect(run.inspected.leftOut.join(' ')).toMatch(/Pre-Rewrite.*Author-Facing/);
    // Brought in: the Core's pre-rewrite history, the Biography's pre-rewrite section and the row, labelled historical.
    const all = await call('arkona_consistency', {
      subject: L.purandukht,
      include: ['pre-rewrite'],
      detail: 'full',
    });
    const historical = (all.findings as any[]).filter((f) => f.group === 'historical');
    expect(historical).toHaveLength(1);
    expect(historical[0].evidence).toBe('Review signal');
    expect((historical[0].details.restatements as any[]).map((r) => r.value).sort()).toEqual([
      '2A 748,300',
      '2A 748,455',
    ]);
    expect((all.findings as any[]).filter((f) => f.group === 'gaps')).toHaveLength(1);
  });

  it('Unreadable is only a date-shaped text the calendar refuses (F4b’s "Camue 51st, 4A 360")', () => {
    const u = ours(run).filter((f) => f.group === 'unreadable');
    expect(u).toHaveLength(1);
    expect(u[0].details.subject).toBe('Rashad al-Khalid');
    expect(u[0].details.restatements).toEqual([
      expect.objectContaining({
        value: expect.stringMatching(/^Camue 51st, 4A 360/),
        unreadable: expect.stringMatching(/Camue has 50 days/),
      }),
    ]);
  });

  it('G: coverage in one bucket per character, adding up, with the flags apart', async () => {
    const c = await call('arkona_as_of_coverage', { detail: 'full' });
    const n = c.counts;
    expect(n.readableBirth + n.birthUnestablished + n.attestedBoundsOnly + n.nothingReadable).toBe(
      n.characters,
    );
    expect(c.sums).toMatch(/one bucket/);
    expect(c.flags.unreadableBirth).toBe(0);
    const listed = new Set((c.nothingReadable as any[]).map((x) => x.character));
    // Every birth this world's Temporal Scopes give is readable now (a place, parents or KCY around it).
    for (const s of ['Adelheid von Falkenrath', 'Elias Brenner', 'Nuasulo Stand-in', 'Jamil al-Fajr'])
      expect(listed.has(s), s).toBe(false);
  });
});
