/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
/**
 * v3 F4c (ADR 0065, "On top of F4b.1"): what F4c adds to F4b.1's consistency data and to `arkona_as_of`, against the
 * REAL stack on the mock LegendKeeper (F4b.1's live-run world) and Arkona's own calendar:
 *
 * - the bare-range attested phrasing (the owner's F4b decision 6): Tsubame Hoshizora's "5A 900 - 5A 931" reads as
 *   attested bounds, never compared;
 * - "Deceased by <date>" (the owner's ruling from F4b.1's review): Jahan-Timur's Life State is an upper bound on death
 *   read by `arkona_as_of` only: at or after it "Deceased (recorded by 5A 931)", before it the other rules; never a
 *   finding;
 * - D9 in `arkona_as_of`: in an AU with no identity page of its own, the character's state is Main CANON's (the attested
 *   life and the Life State inherited with the birth and death), labelled "inherited from Main CANON";
 * - D7 as amended (the owner's ruling, 20 November 2026): a Life State of "Alive" records the character alive at the
 *   present, so with a recorded birth they are "Alive (recorded)" from it to the present (Yasmin al-Naim at 4A 120);
 * - the age phrasings are in the approved pack's data (arkona_chapter_check reads them: test/narrative/read.test.ts).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../src/calendar/index.js';
import {
  compilePatterns,
  extractPageFacts,
  type NameIndex,
  type Unit,
} from '../../src/consistency/extract.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { packRulesSchema } from '../../src/packs/types.js';
import { SidebarModel } from '../resources/world.js';
import { F } from '../packs/f4a-world.js';
import { IDENTITY_KEYS } from '../packs/world.js';
import { L, liveRunWorld, type LiveWorld } from './live-world.js';
import { K } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: unknown };
const cal = createCalendar(ORACLE.calendar);
const rules = ARKONA_PACK.rules.consistency!;
const names: NameIndex = { lookup: () => null };
const ctx = { compiled: compilePatterns(rules), names, cal, style: DEFAULT_DATE_STYLE };
const sidebar = (subject: string, fields: Record<string, string>) =>
  extractPageFacts(
    'page1',
    [
      { unit: 'fact', text: subject, documentId: null, blockId: 'r1', field: 'Subject', section: 'sidebar' },
      ...Object.entries(fields).map(([field, text], i): Unit => ({
        unit: 'fact',
        text,
        documentId: null,
        blockId: `r${i + 2}`,
        field,
        section: 'sidebar',
      })),
    ],
    ctx,
  ).facts.filter((f) => f.kind !== 'identity');

describe('the seed (on top of F4b.1’s)', () => {
  // CR-2026-11-R4: the seed is now arkona-2026-11-21-r4, which supersedes -f41 and, through it, -f4c and -f4b1.
  it('arkona-2026-11-21-r4 (superseding -f41 and -f4c) supersedes arkona-2026-11-20-f4b1 and keeps its consistency rules', () => {
    // v3 F5a (ADR 0067): now arkona-2026-11-23-f5a, which supersedes -r4 (and, through it, -f41).
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-29-f6d'); // v3 F6d (ADR 0082): -f6d supersedes -f12
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-21-r4');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-20-f41');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-20-f4b1');
    expect(rules.nonCurrent).toEqual({ markers: ['Pre-Rewrite', 'Author-Facing'], exclude: true });
    expect(rules.titles).toContain('Kaiser');
    expect(rules.ages?.map((a) => a.id)).toEqual(['age.is', 'age.aged']);
    expect(rules.deceasedBy?.map((a) => a.id)).toEqual(['deceased.by']);
    expect(() => packRulesSchema.parse(ARKONA_PACK.rules)).not.toThrow();
  });
});

describe('the bare-range attested phrasing (F4b decision 6)', () => {
  it('Tsubame Hoshizora: "5A 900 - 5A 931" is an attested span, both bounds', () => {
    const f = sidebar('Tsubame Hoshizora', { 'Temporal Scope': '5A 900 - 5A 931' });
    expect(f).toEqual([
      expect.objectContaining({ kind: 'attested', pattern: 'attested.scope.range', bound: 'both' }),
    ]);
    expect(f[0]!.date).not.toBeNull();
    expect(f[0]!.unreadable).toBeNull();
  });

  it('an en dash, a day form and a second era are read too; a single date is not a range', () => {
    for (const t of ['5A 900–5A 931', 'Camue 1st, 4A 100 - 4A 150', '4A 990 - 5A 12'])
      expect(
        sidebar('Tsubame Hoshizora', { 'Temporal Scope': t }).map((x) => x.pattern),
        t,
      ).toEqual(['attested.scope.range']);
    expect(sidebar('Tsubame Hoshizora', { 'Temporal Scope': '5A 900' })).toEqual([]);
  });

  it('"Deceased by" is still never a death date (F4b.1’s reading is kept)', () => {
    const f = sidebar('Jahan-Timur', { 'Life State': 'Deceased by 5A 931; exact death date unestablished' });
    expect(f.filter((x) => x.kind === 'death')).toEqual([
      expect.objectContaining({ gap: true, date: null, unreadable: null }),
    ]);
  });
});

let w: LiveWorld;
beforeAll(async () => {
  w = await liveRunWorld();
  // Tsubame Hoshizora's Temporal Scope, a bare range.
  w.sidebars.outside(F.tsubame, (sb) => {
    const props = sb.props.find((p) => p.title === 'PROPERTIES')!;
    const rows = props.rows!;
    const at = rows.find((r) => r.key === 'Temporal Scope');
    if (at) at.content = [{ text: '5A 900 - 5A 931' }];
    else
      rows.push({
        id: 'tsubts01',
        rank: 'zz',
        key: 'Temporal Scope',
        content: [{ text: '5A 900 - 5A 931' }],
      });
  });
  // The guard on the Life State ruling: a recorded death and a current Life State of "Alive" (modelled on Nahla's Sidhe
  // rebirth and Yue Bailu's Kitsune rebirth, stand-in names and the fixture's own dates).
  for (const [id, given, scope, life] of [
    ['nahlast1', 'Nahla', 'Born Camue 5th, 4A 200; died Isar 10th, 4A 260', 'Alive'],
    ['yuestnd1', 'Yue', 'Born 4A 100; died 4A 150; reborn 4A 300', 'Alive (Kitsune rebirth)'],
  ] as const) {
    const name = `${given} Stand-in`;
    w.repo.seed({
      id,
      name: `[BSRC] ${name} - Character Reference`,
      parentId: L.idx,
      referenceType: 'Compact Character Reference',
      canonical: name,
      tags: ['CANON', 'Character', 'Human'],
    });
    const v: Record<string, string> = {
      Status: 'Authoritative',
      'Continuity Type': 'CANON',
      Continuity: 'Main',
      Inheritance: 'None',
      Subject: name,
      'Canonical Display Name': name,
      'Personal / Given Name': given,
      'Family / Surname': 'Stand-in',
      'Naming Culture': 'Velaran',
      'Reference Type': 'Compact Character Reference',
      Scope: `${name}, a person of Arkona`,
      'Race / Species': 'Human',
      'Life State': life,
      'Temporal Scope': scope,
      'Last Major Revision': '2026-11-01',
      Supersedes: 'None',
    };
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  }
  w.rebuildTree();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await w.call(tool, { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const asOf = async (character: string, date: string, more: Record<string, unknown> = {}) =>
  (await call('arkona_as_of', { characters: [character], date, ...more })).characters[0];

describe('arkona_as_of with the bare range', () => {
  it('Tsubame Hoshizora is Alive (recorded) inside 5A 900 - 5A 931 and Unestablished outside it', async () => {
    expect((await asOf('Tsubame Hoshizora', '5A 910')).state).toMatchObject({
      value: 'Alive (recorded)',
      why: 'inside the attested span',
    });
    expect((await asOf('Tsubame Hoshizora', '5A 850')).state.value).toBe('Unestablished');
  });

  it('the coverage report counts her among the attested bounds, and the consistency check reports nothing for her', async () => {
    // Without a Temporal Scope she would be listed under "nothing readable"; the bare range counts as attested bounds.
    const cov = await call('arkona_as_of_coverage', { detail: 'full' });
    expect((cov.nothingReadable as any[]).map((x) => x.character)).not.toContain('Tsubame Hoshizora');
    const b = await call('arkona_consistency', { subject: 'Tsubame Hoshizora', detail: 'full' });
    expect(b.findings).toEqual([]);
  });
});

describe('"Deceased by <date>": an upper bound read by arkona_as_of only (Jahan-Timur)', () => {
  it('at the bound: Deceased (recorded by 5A 931), with the Life State it comes from', async () => {
    const a = await asOf('Jahan-Timur', '5A 931');
    expect(a.state).toMatchObject({ value: 'Deceased (recorded by 5A 931)' });
    expect(a.state.why).toMatch(/upper bound/);
    expect(a.deceasedBy).toMatchObject({
      value: '5A 931',
      recorded: 'Deceased by 5A 931; exact death date unestablished',
    });
    expect(a).not.toHaveProperty('died');
  });

  it('before the bound, the other rules apply (attested through 5A 900, no birth: Unestablished)', async () => {
    const before = await asOf('Jahan-Timur', '5A 920');
    expect(before.state.value).toBe('Unestablished');
    expect(before.deceasedBy).toMatchObject({ value: '5A 931' });
  });

  it('never compared: the consistency check reports nothing for Jahan-Timur, and no death date is stored', async () => {
    const b = await call('arkona_consistency', { subject: 'Jahan-Timur', detail: 'full' });
    expect(b.findings).toEqual([]);
    // The death F4b.1 stores for Jahan-Timur is a gap with no date (its reading is unchanged).
    const a = await asOf('Jahan-Timur', '5A 931');
    expect(a).not.toHaveProperty('died');
  });
});

describe('D9 in arkona_as_of: an AU with no identity page of its own inherits Main CANON’s state', () => {
  it('Rashad al-Khalid’s attested life (to the present) is inherited in Moonfall: Alive (recorded), labelled', async () => {
    const main = await asOf('Rashad al-Khalid', '4A 500');
    expect(main.state).toEqual({ value: 'Alive (recorded)', why: 'inside the attested span' });
    const au = await asOf('Rashad al-Khalid', '4A 500', { continuity: 'Moonfall' });
    expect(au.state).toEqual({
      value: 'Alive (recorded)',
      why: 'inside the attested span',
      label: 'inherited from Main CANON',
    });
    expect(au.born).toMatchObject({ value: 'Camue 44th, 4A 360', label: 'inherited from Main CANON' });
  });

  it('a recorded death is inherited too (Harun al-Saffar): Deceased (recorded) in Moonfall, labelled', async () => {
    const au = await asOf('Harun al-Saffar', '4A 450', { continuity: 'Moonfall' });
    expect(au.state).toMatchObject({ value: 'Deceased (recorded)', label: 'inherited from Main CANON' });
  });

  // CR-2026-11-R4 (RC-8, D9: "a fact stated on that AU's own pages is used first"): Moonfall's own chronicle states her
  // birth ("Yasmin al-Naim was born in 4A 150 in this telling"), so in Moonfall she is born in 4A 150, not Main CANON's
  // Camue 1st, 4A 100 (F4c answered on the inherited birth: Alive at 4A 120). Her Life State is still Main CANON's.
  it('Yasmin al-Naim in Moonfall: her AU’s own birth (4A 150) first; at 4A 120 not yet born, at 4A 200 Alive (recorded) by the inherited Life State', async () => {
    const au = await asOf('Yasmin al-Naim', '4A 120', { continuity: 'Moonfall' });
    expect(au.born).toMatchObject({ value: '4A 150', page: { id: K.auPage } });
    expect(au.born).not.toHaveProperty('label');
    expect(au.elapsedYears).toBe('not yet born');
    expect(au.state.value).toBe('Unestablished');
    const later = await asOf('Yasmin al-Naim', '4A 200', { continuity: 'Moonfall' });
    expect(later.state).toMatchObject({ value: 'Alive (recorded)', label: 'inherited from Main CANON' });
    expect(later.state.why).toMatch(
      /between the recorded birth and the present \(5A 931\): the Life State records/,
    );
    // Main CANON: her own birth, unlabelled.
    const main = await asOf('Yasmin al-Naim', '4A 120');
    expect(main.state.value).toBe('Alive (recorded)');
    expect(main.state).not.toHaveProperty('label');
  });

  it('a Life State of "Alive" never reaches before the birth or past the present (D7 as amended)', async () => {
    expect((await asOf('Yasmin al-Naim', '4A 90', { continuity: 'Moonfall' })).state.value).toBe(
      'Unestablished',
    );
    expect((await asOf('Yasmin al-Naim', '5A 931')).state.value).toBe('Alive (recorded)');
  });
});

describe('the guard on the Life State ruling: a recorded death wins inside its own span', () => {
  const gap = 'Unestablished (recorded death; current Life State Alive)';

  it('Nahla Stand-in (died Isar 10th, 4A 260; Life State "Alive"): alive before the death, never after it', async () => {
    expect((await asOf('Nahla Stand-in', '4A 230')).state).toMatchObject({
      value: 'Alive (recorded)',
      why: 'between the recorded birth and the recorded death',
    });
    const after = await asOf('Nahla Stand-in', '4A 300');
    expect(after.state.value).toBe(gap);
    expect(after.state.why).toMatch(/never alive across the gap/);
    // Up to the present, never Alive (recorded) across the gap.
    expect((await asOf('Nahla Stand-in', 'now')).state.value).toBe(gap);
    expect((await asOf('Nahla Stand-in', 'Isar 10th, 4A 260')).state.value).toBe(gap);
  });

  // CR-2026-11-R4 (the owner's request L): a death and a return are two lives, so between them the character is
  // "Between lives (recorded)" (F4c said "Deceased (recorded)"), never Alive, and the reason names the lives.
  it('Yue Stand-in (died 4A 150, reborn 4A 300): between lives from the death to the return, alive after it', async () => {
    expect((await asOf('Yue Stand-in', '4A 120')).state.value).toBe('Alive (recorded)');
    const dead = await asOf('Yue Stand-in', '4A 200');
    expect(dead.state).toMatchObject({ value: 'Between lives (recorded)' });
    expect(dead.state.why).toMatch(/before the recorded return \(4A 300\)/);
    const back = await asOf('Yue Stand-in', '4A 400');
    expect(back.state).toMatchObject({ value: 'Alive (recorded)' });
    expect(back.state.why).toMatch(/recorded return \(4A 300\) and the present/);
  });

  it('inherited into an AU (Moonfall), the same states, labelled "inherited from Main CANON"', async () => {
    const moon = { continuity: 'Moonfall' };
    expect((await asOf('Nahla Stand-in', '4A 300', moon)).state).toMatchObject({
      value: gap,
      label: 'inherited from Main CANON',
    });
    expect((await asOf('Yue Stand-in', '4A 200', moon)).state).toMatchObject({
      value: 'Between lives (recorded)',
      label: 'inherited from Main CANON',
    });
    expect((await asOf('Yue Stand-in', '4A 400', moon)).state).toMatchObject({
      value: 'Alive (recorded)',
      label: 'inherited from Main CANON',
    });
  });

  it('a return is never a second birth: the consistency check reports nothing for either', async () => {
    for (const subject of ['Nahla Stand-in', 'Yue Stand-in'])
      expect((await call('arkona_consistency', { subject, detail: 'full' })).findings, subject).toEqual([]);
  });
});
