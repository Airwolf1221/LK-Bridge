/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * v3 F4b (ADR 0064): `arkona_consistency`, `arkona_as_of` and `arkona_as_of_coverage` against the REAL stack on the mock
 * LegendKeeper (test/consistency/world.ts), with fixtures modelled on the design's phrasings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { f4bWorld, K, type F4bWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: F4bWorld;
beforeAll(async () => {
  w = await f4bWorld();
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
const consistency = (args: Record<string, unknown>) =>
  call('arkona_consistency', { detail: 'full', limit: 200, ...args });
const asOf = async (character: string, date: string, more: Record<string, unknown> = {}) =>
  (await call('arkona_as_of', { characters: [character], date, ...more })).characters[0];
const ofKind = (b: any, check: string, group?: string) =>
  (b.findings as any[]).filter((f) => f.check === check && (group === undefined || f.group === group));

describe('arkona_consistency (D1 to D5)', () => {
  it('Yasmin al-Naim: her Biography’s birth and Race / Species are Contradictory; her Working draft differs from canon', async () => {
    const b = await consistency({ subject: 'Yasmin al-Naim' });
    const birth = ofKind(b, 'consistency_birth', 'contradictory');
    expect(birth).toHaveLength(1);
    expect(birth[0].details.reference).toMatchObject({
      value: 'Camue 1st, 4A 100',
      page: { id: K.yasmin },
      lifecycle: 'Authoritative',
      source: 'temporalScope',
    });
    expect(birth[0].details.restatements).toEqual([
      expect.objectContaining({
        value: 'Camue 1st, 4A 103',
        page: expect.objectContaining({ id: K.yasminBio }),
        lifecycle: 'Authoritative',
        section: 'Purpose',
        precision: 'day',
        excerpt: expect.stringMatching(/^Yasmin was born on Camue 1st, 4A 103/),
      }),
    ]);
    expect(birth[0]).toMatchObject({ evidence: 'Contradictory' });
    // The pronoun sentence ("She was born in 4A 90") is never read: no restatement says 4A 90.
    expect(JSON.stringify(b.findings)).not.toMatch(/4A 90\b/);
    const differs = ofKind(b, 'consistency_birth', 'differs');
    expect(differs[0].details.restatements[0]).toMatchObject({ value: '4A 110', lifecycle: 'Working' });
    expect(differs[0].evidence).toBe('Proposal differs from canon');
    const race = ofKind(b, 'consistency_identity', 'contradictory');
    expect(race[0].details).toMatchObject({
      field: 'Race / Species',
      reference: { value: 'Human' },
      restatements: [expect.objectContaining({ value: 'Elf' })],
    });
    // A chronology row that mentions her Biography, dated Camue 1st, 4A 100, against the Biography's 4A 103.
    const row = ofKind(b, 'consistency_chronology', 'contradictory');
    expect(row[0].details.reference).toMatchObject({ value: 'Camue 1st, 4A 100', source: 'chronology' });
    expect(row[0].details.restatements[0]).toMatchObject({
      value: 'Camue 1st, 4A 103',
      page: expect.objectContaining({ id: K.yasminBio }),
    });
    expect(b.readOnly).toMatch(/no side was picked/);
  });

  it('a birth restated by an alias (a birth name) on a nation page is found: Katsuragi Yamato / Rita von Katzen', async () => {
    const b = await consistency({ subject: 'Katsuragi Yamato' });
    const f = ofKind(b, 'consistency_birth', 'contradictory')[0];
    expect(f.details.restatements[0]).toMatchObject({
      value: '4A 305',
      page: expect.objectContaining({ id: K.nation }),
      excerpt: expect.stringMatching(/^Rita von Katzen was born/),
    });
  });

  it('a day and the same day on a dated nation line agree: Cornelia von Katzen has nothing', async () => {
    expect((await consistency({ subject: 'Cornelia von Katzen' })).findings).toEqual([]);
  });

  it('"birth date unestablished" against a value is a Gap, never a conflict', async () => {
    const b = await consistency({ subject: 'Kamigawa Haru' });
    expect(b.findings).toHaveLength(1);
    expect(b.findings[0]).toMatchObject({ group: 'gaps', evidence: 'Gap' });
    expect(b.findings[0].details.restatements[0]).toMatchObject({
      value: '5A 400',
      page: expect.objectContaining({ id: K.register }),
    });
  });

  it('a date the calendar cannot read is reported as unreadable (Camue has 50 days), never guessed', async () => {
    const b = await consistency({ subject: 'Rashad al-Khalid' });
    const u = (b.findings as any[]).find((f) => f.group === 'unreadable');
    expect(u.details.restatements[0]).toMatchObject({
      value: expect.stringMatching(/^Camue 51st, 4A 360/),
      unreadable: expect.stringMatching(/Camue has 50 days/),
    });
    expect((b.findings as any[]).filter((f) => f.group === 'contradictory')).toEqual([]);
  });

  it('Archived pages are left out unless include asks for them; then Historical material differs', async () => {
    const without = await consistency({ subject: 'Yasmin al-Naim' });
    expect(JSON.stringify(without.findings)).not.toMatch(/4A 120/);
    expect(without.inspected.leftOut).toContain('Archived pages');
    const withIt = await consistency({ subject: 'Yasmin al-Naim', include: ['archived'] });
    const h = (withIt.findings as any[]).find((f) => f.group === 'historical');
    expect(h.details.restatements[0]).toMatchObject({
      value: '4A 120',
      page: expect.objectContaining({ id: K.oldNotes }),
      lifecycle: 'Archived',
    });
  });

  // CR-2026-11-R4 (RC-8, D9): an AU's own pages come first, so Moonfall's own "born in 4A 150 in this telling" is the
  // AU's value, never a Contradictory against Main CANON's inherited Camue 1st, 4A 100 (F4b compared the AU page with
  // the inherited value, so the owner's pick could have rewritten the AU's deliberate difference).
  it('an AU page is compared only within its AU (D9): its own value first, never against the inherited Main CANON value', async () => {
    const main = await consistency({ subject: 'Yasmin al-Naim' });
    expect(JSON.stringify(main.findings)).not.toMatch(/4A 150/);
    const au = await consistency({ subject: 'Yasmin al-Naim', continuity: 'Moonfall' });
    expect(au.findings).toEqual([]);
    expect(au.scope).toMatchObject({ continuity: 'Moonfall' });
    // The Main pages (the Biography, the draft) are not compared in the AU's run.
    expect(JSON.stringify(au.findings)).not.toMatch(/4A 103|4A 110/);
    // As of a date in Moonfall, the AU's own birth is the one used.
    expect((await asOf('Yasmin al-Naim', '4A 200', { continuity: 'Moonfall' })).born).toMatchObject({
      value: '4A 150',
      page: { id: K.auPage },
    });
  });

  it('a whole-repository run is stored as a run, read a page at a time; free (no LegendKeeper read)', async () => {
    const before = w.reads();
    const first = await call('arkona_consistency', { all: true, limit: 2 });
    expect(w.reads()).toBe(before);
    expect(first.counts.contradictory).toBe(4);
    expect(first.findings).toHaveLength(2);
    expect(first.nextOffset).toBe(2);
    const again = await call('arkona_consistency', { runId: first.runId, offset: 2, limit: 50 });
    expect(again.runId).toBe(first.runId);
    expect(again.findings.length).toBe(first.total - 2);
    expect(first.cost).toBe('free');
    const one = await call('arkona_consistency', { runId: first.runId, group: 'contradictory' });
    expect((one.findings as any[]).every((f) => f.group === 'contradictory')).toBe(true);
  });

  it('refuses two scopes at once, and an unknown character', async () => {
    const r = await w.call('arkona_consistency', { project: 'test', all: true, subject: 'Yasmin al-Naim' });
    expect(r.isError).toBe(true);
    expect(r.body.error?.code ?? r.body.code).toBe('INVALID_PARAMS');
    const u = await w.call('arkona_consistency', { project: 'test', subject: 'Nobody Anywhere' });
    expect(u.isError).toBe(true);
  });
});

describe('arkona_as_of (D7, D9, D10)', () => {
  it('an exact birth gives an exact number of calendar years', async () => {
    const a = await asOf('Rashad al-Khalid', 'Camue 44th, 4A 380');
    expect(a.born).toMatchObject({
      value: 'Camue 44th, 4A 360',
      source: 'temporalScope',
      page: { id: K.rashad },
    });
    expect(a.elapsedYears).toEqual({ years: 20, exact: true });
    expect((await asOf('Rashad al-Khalid', 'Camue 43rd, 4A 380')).elapsedYears).toEqual({
      years: 19,
      exact: true,
    });
    // Born, and attested alive at the present: alive between (inside the attested span).
    expect(a.state.value).toBe('Alive (recorded)');
  });

  it('an approximate birth gives a range', async () => {
    const a = await asOf('Leila Darvish', 'Camue 1st, 4A 700');
    expect(a.elapsedYears).toMatchObject({ exact: false });
    expect(a.elapsedYears.min).toBeLessThan(a.elapsedYears.max);
    expect(a.elapsedYears.min).toBeGreaterThanOrEqual(54);
    expect(a.elapsedYears.max).toBeLessThanOrEqual(66);
  });

  it('before the birth: "not yet born"', async () => {
    const a = await asOf('Leila Darvish', '4A 600');
    expect(a.elapsedYears).toBe('not yet born');
    expect(a.state.value).toBe('Unestablished');
  });

  it('an unknown birth gives no age; inside the attested span Alive, past it Unestablished (never alive)', async () => {
    const inside = await asOf('Kamigawa Haru', '5A 500');
    expect(inside.born).toMatchObject({ value: 'birth unestablished' });
    expect(inside.elapsedYears).toBeNull();
    expect(inside.elapsedNote).toMatch(/not recorded/);
    expect(inside.state.value).toBe('Alive (recorded)');
    const before = await asOf('Kamigawa Haru', '5A 300');
    expect(before.state.value).toBe('Unestablished');
    // Titania: born, and "active at…" holds no date (not a fact, ADR 0064 amendment 1). v3 F4c (ADR 0065, amending D7 by
    // the owner's ruling): her Life State "Alive" records her alive at the present, so she is alive from her birth to it.
    const later = await asOf('Titania', '4A 100');
    expect(later.state.value).toBe('Alive (recorded)');
    expect(later.state.why).toMatch(/Life State records/);
    // Before her birth, still Unestablished.
    expect((await asOf('Titania', '1A 51,000')).state.value).toBe('Unestablished');
  });

  it('after a recorded death: Deceased (recorded); between birth and death: Alive (recorded)', async () => {
    expect((await asOf('Harun al-Saffar', '4A 450')).state).toMatchObject({ value: 'Deceased (recorded)' });
    expect((await asOf('Harun al-Saffar', 'Camue 1st, 4A 350')).state.value).toBe('Alive (recorded)');
  });

  it('"now" means the pack’s present (5A 931)', async () => {
    const b = await call('arkona_as_of', { characters: ['Soraya bint al-Noor'], date: 'now' });
    expect(b.date).toMatchObject({ read: '5A 931', present: expect.stringMatching(/5A 931/) });
    expect(b.characters[0].state.value).toBe('Alive (recorded)');
  });

  // CR-2026-11-R4 (RC-8): Yasmin's AU states her birth (above); Rashad al-Khalid's states nothing, so his is inherited.
  it('an AU-inherited value is labelled', async () => {
    const a = await asOf('Rashad al-Khalid', '4A 400', { continuity: 'Moonfall' });
    expect(a.born).toMatchObject({ value: 'Camue 44th, 4A 360', label: 'inherited from Main CANON' });
  });

  it('a character in a Contradictory finding carries it; never apparent age; the race reference is pointed to', async () => {
    const b = await call('arkona_as_of', { characters: ['Yasmin al-Naim'], date: '4A 200' });
    const a = b.characters[0];
    // Two: the Biography against the Core, and the chronology row against the Biography.
    expect(a.contradictions).toHaveLength(2);
    expect((a.contradictions as any[]).every((c) => c.what === 'birth')).toBe(true);
    expect(a.warning).toMatch(/disputed/);
    expect(b.rule).toMatch(/never apparent or biological age/);
    expect(a.raceReference).toMatchObject({ value: 'Human' });
    expect(JSON.stringify(a)).not.toMatch(/apparentAge|biologicalAge/);
  });

  it('the chronology rows around the date', async () => {
    const a = await asOf('Harun al-Saffar', '4A 300', { window: 1 });
    expect(a.around.after).toEqual([
      expect.objectContaining({
        date: 'Camue 3rd, 4A 400',
        event: expect.stringMatching(/dies in the siege/),
      }),
    ]);
    expect(a.around.before).toEqual([]);
  });

  it('free without live; live re-reads each identity page’s sidebar (one read each)', async () => {
    const before = w.reads();
    await call('arkona_as_of', { characters: ['Rashad al-Khalid', 'Harun al-Saffar'], date: '4A 380' });
    await call('arkona_as_of_coverage', {});
    expect(w.reads()).toBe(before);
    const live = await call('arkona_as_of', {
      characters: ['Rashad al-Khalid', 'Harun al-Saffar'],
      date: '4A 380',
      live: true,
    });
    expect(w.reads() - before).toBe(2);
    expect(live.cost).toMatch(/2 read/);
  });
});

describe('arkona_as_of_coverage (D8)', () => {
  it('counts one primary bucket per character (they add up), with a recorded death and an unreadable birth as flags; lists those with nothing readable; never a task list', async () => {
    const b = await call('arkona_as_of_coverage', {});
    // ADR 0064 amendment 1 (G): Haru's birth is deliberately unestablished (he is attested, but the birth bucket wins).
    // v3 F4c (ADR 0065): the bare-range attested phrasing ("5A 900 - 5A 931", F4b decision 6) reads six fixture
    // characters' Temporal Scopes as attested bounds (Tsubame Hoshizora's among them).
    expect(b.counts).toEqual({
      characters: 23,
      readableBirth: 8,
      birthUnestablished: 1,
      attestedBoundsOnly: 6,
      nothingReadable: 8,
    });
    expect(b.flags).toEqual({ recordedDeath: 1, unreadableBirth: 0 });
    const c = b.counts;
    expect(c.readableBirth + c.birthUnestablished + c.attestedBoundsOnly + c.nothingReadable).toBe(
      c.characters,
    );
    expect(b.sums).toMatch(/one bucket/);
    expect(b.counts.nothingReadable).toBe((b.nothingReadable as any[]).length);
    const listed = (b.nothingReadable as any[]).map((x) => x.character);
    expect(listed).toContain('Asagiri Kaede');
    // Her Temporal Scope is a bare range: attested bounds since F4c (ADR 0065).
    expect(listed).not.toContain('Kamigawa Miyuki');
    expect(listed).not.toContain('Kamigawa Haru');
    expect(listed).not.toContain('Rashad al-Khalid');
    expect(b.note).toMatch(/not a task list/);
    expect(b.note).toMatch(/often deliberate/);
    expect(JSON.stringify(b)).not.toMatch(/\b(TODO|should add|please add|must add|fill in)\b/i);
  });
});
