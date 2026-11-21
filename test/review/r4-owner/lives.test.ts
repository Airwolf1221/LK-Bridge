/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * CR-2026-11-R4, the owner's request L: characters with more than one life. Mehrana al-Khalid's Core Temporal Scope, as
 * the owner quoted it (verbatim): "First life Camue 1st, 4A 100–Camue 33rd, 4A 325; second life born Camue 1st, 4A 530;
 * recollection 4A 624–Sarias 9th, 4A 645; second-life actual death at midday Zahras 36th, 4A 950; restored to life as a
 * five-Domain innate goddess Camue 1st, 5A 1; alive through 5A 931." The live run reported her two births (Yasmin
 * Arshama, Camue 1st, 4A 100, and Mehrana II, 4A 530) as Contradictory; both are true.
 *
 * - **The pack's phrasings** read one birth and one death per life and the restoration (`life.scope.*`); the
 *   recollection is an attested span inside the second life, never a life; "alive through 5A 931" attests the restored
 *   life to the present.
 * - **`arkona_as_of`** places a date in a life, between lives, or after the restoration, and names the life; elapsed
 *   years are counted within the life the date falls in.
 * - **`arkona_consistency`** agrees with any life's birth or death: no Contradictory for her two births.
 * - **The coverage report** counts her first life's birth as her readable birth (one character).
 * - **The calendar** (Arkona's Kumikan Epochal): the Fourth Age's last day is Zahras 36th, 4A 950, and the Fifth Age
 *   begins the next day, Camue 1st, 5A 1. So "4A 960" is no date (the tool refuses it with the calendar's reason), and
 *   no whole day lies between her second life's death and the restoration.
 *
 * The fixture is F4b.1's live-run world (test/consistency/live-world.ts), where her birth name "Yasmin Arshama" is
 * already an alias. Stand-ins, named as such: her identity page is made a Character Core under an index of its own (the
 * owner's Core; its place in the tree is the fixture's); her Aliases gain "Mehrana II" (the live run attributed that
 * restatement to her, so her names hold it); the two restatements are dated lines on a stand-in annals page, in the
 * live run's values ("Camue 1st, 4A 100 - Yasmin Arshama is born in Khorshahr.", the Universal Chronology row's words
 * and date; "4A 530 - Mehrana II is born.", the live run gave only "Mehrana II, 4A 530"); "Nasrin Stand-in" carries the
 * same Temporal Scope with no Life State (Mehrana's Life State here, "Alive", is the fixture's default, not the owner's).
 * Nothing here calls a live system.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { L } from '../../consistency/live-world.js';
import {
  brief,
  liveRunWorld,
  O,
  page,
  para,
  person,
  refresh,
  tools,
  valuesOf,
  type LiveWorld,
} from '../r4-asof/helpers.js';

vi.setConfig({ testTimeout: 120_000 });

/** The owner's words, verbatim. */
const TEMPORAL_SCOPE =
  'First life Camue 1st, 4A 100–Camue 33rd, 4A 325; second life born Camue 1st, 4A 530; recollection 4A 624–Sarias 9th, 4A 645; second-life actual death at midday Zahras 36th, 4A 950; restored to life as a five-Domain innate goddess Camue 1st, 5A 1; alive through 5A 931.';

const Q = { mehranaIdx: 'mehrcidx', nasrin: 'nasrinst', annals: 'mehrannl', later: 'mehrlate' } as const;

let w: LiveWorld;
let t: ReturnType<typeof tools>;

beforeAll(async () => {
  w = await liveRunWorld();
  // Her identity page as a Character Core (the owner's Core), her Temporal Scope verbatim.
  person(w, {
    id: L.mehrana,
    core: Q.mehranaIdx,
    name: 'Mehrana al-Khalid',
    given: 'Mehrana',
    family: 'al-Khalid',
    aliases: ['Yasmin Arshama'],
    v: {
      'Temporal Scope': TEMPORAL_SCOPE,
      Aliases: 'Yasmin Arshama; Mehrana II',
      'Life State': 'Alive',
    },
  });
  // The same Temporal Scope with no Life State (a stand-in).
  person(w, {
    id: Q.nasrin,
    name: 'Nasrin Stand-in',
    given: 'Nasrin',
    family: 'Stand-in',
    v: { 'Temporal Scope': TEMPORAL_SCOPE, 'Life State': '' },
  });
  // Her two births restated as the live run had them, on an Authoritative page (a stand-in).
  page(w, {
    id: Q.annals,
    name: '[BSRC] House of al-Khalid - Annals',
    parentId: O.alTibr,
    body: [
      para('mh1', 'Camue 1st, 4A 100 - Yasmin Arshama is born in Khorshahr.'),
      para('mh2', '4A 530 - Mehrana II is born.'),
    ],
  });
  await refresh(w);
  t = tools(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('arkona_as_of places a date in a life, between lives, or after the restoration (the owner’s dates)', () => {
  for (const who of [L.mehrana, Q.nasrin])
    describe(
      who === L.mehrana ? 'Mehrana al-Khalid (Life State “Alive”)' : 'Nasrin Stand-in (no Life State)',
      () => {
        it('4A 200: Alive (recorded), in the first life', async () => {
          const a = await t.asOf(who, '4A 200');
          expect(a.state.value, brief(a)).toBe('Alive (recorded)');
          expect(a.state.why).toBe(
            'in the first life: between its recorded birth (Camue 1st, 4A 100) and its recorded death (Camue 33rd, 4A 325)',
          );
          expect(a.life).toEqual({ position: 'in a life', life: 'the first life' });
          // Her birth is her first life's (the coverage report counts it).
          expect(a.born).toMatchObject({ value: 'Camue 1st, 4A 100', source: 'temporalScope' });
          expect(a.elapsedYears).toMatchObject({
            min: 99,
            max: 100,
            counted: 'within the first life, from the birth (Camue 1st, 4A 100)',
          });
        });

        it('4A 400: between lives (the first life ended Camue 33rd, 4A 325; the second begins Camue 1st, 4A 530): never Alive, never “Deceased” forever', async () => {
          const a = await t.asOf(who, '4A 400');
          expect(a.state.value, brief(a)).toBe('Between lives (recorded)');
          expect(a.state.why).toBe(
            'between lives: after the first life’s death (Camue 33rd, 4A 325), before the second life’s birth (Camue 1st, 4A 530)',
          );
          expect(a.life).toEqual({
            position: 'between lives',
            after: 'the first life',
            before: 'the second life',
          });
          expect(a.elapsedYears).toBeNull();
          expect(a.died).toMatchObject({ value: 'Camue 33rd, 4A 325', life: 'the first life' });
        });

        it('4A 600: Alive (recorded), in the second life; the elapsed years are counted within it', async () => {
          const a = await t.asOf(who, '4A 600');
          expect(a.state.value, brief(a)).toBe('Alive (recorded)');
          expect(a.state.why).toBe(
            'in the second life: between its recorded birth (Camue 1st, 4A 530) and its recorded death (Zahras 36th, 4A 950)',
          );
          expect(a.life).toEqual({ position: 'in a life', life: 'the second life' });
          expect(a.elapsedYears).toMatchObject({
            min: 69,
            max: 70,
            counted: 'within the second life, from its birth (Camue 1st, 4A 530)',
          });
        });

        it('4A 960 is no date of the calendar (the Fourth Age ends on Zahras 36th, 4A 950): refused with its reason, never answered', async () => {
          const r = await w.call('arkona_as_of', { project: 'test', characters: [who], date: '4A 960' });
          expect(r.isError).toBe(true);
          expect(r.text).toMatch(/DATE_UNREADABLE/);
          expect(r.text).toMatch(/the Fifth Arkonan Age \(5A\) begins on Camue 1st, 5A 1/);
        });

        it('between the second life’s death (midday Zahras 36th, 4A 950) and the restoration (Camue 1st, 5A 1, the next day) no whole day lies: both days are Unestablished, never Alive nor Deceased', async () => {
          const death = await t.asOf(who, 'Zahras 36th, 4A 950');
          expect(death.state.value, brief(death)).toBe('Unestablished');
          expect(death.state.why).toBe(
            'in the second life: the date spans the recorded death (Zahras 36th, 4A 950)',
          );
          const back = await t.asOf(who, 'Camue 1st, 5A 1');
          expect(back.state.value, brief(back)).toBe('Unestablished');
          expect(back.state.why).toBe(
            'the date spans the restoration (Camue 1st, 5A 1) that begins the restored life',
          );
        });

        it('5A 900: Alive (recorded), after the restoration (the restored life)', async () => {
          const a = await t.asOf(who, '5A 900');
          expect(a.state.value, brief(a)).toBe('Alive (recorded)');
          expect(a.state.why).toBe(
            'after the restoration (Camue 1st, 5A 1), in the restored life: inside the attested span',
          );
          expect(a.life).toEqual({ position: 'after the restoration', life: 'the restored life' });
          expect(a.elapsedYears).toMatchObject({
            counted: 'within the restored life, from the restoration (Camue 1st, 5A 1)',
          });
        });
      },
    );

  it('the lives as the answer lists them: three; the recollection inside the second; "alive through 5A 931" in the restored one', async () => {
    const a = await t.asOf(L.mehrana, '5A 900');
    expect(a.lives.map((l: any) => [l.life, l.began.how, l.began.value, l.ended.value ?? l.ended])).toEqual([
      ['the first life', 'birth', 'Camue 1st, 4A 100', 'Camue 33rd, 4A 325'],
      ['the second life', 'birth', 'Camue 1st, 4A 530', 'Zahras 36th, 4A 950'],
      ['the restored life', 'restoration', 'Camue 1st, 5A 1', 'no death is recorded'],
    ]);
    expect(a.lives[1].attested.map((x: any) => x.value)).toEqual(['4A 624–Sarias 9th, 4A 645']);
    expect(a.lives[2].attested.map((x: any) => x.value)).toEqual(['5A 931']);
  });

  it('the first life’s death day is never Alive nor Deceased', async () => {
    const a = await t.asOf(L.mehrana, 'Camue 33rd, 4A 325');
    expect(a.state.value, brief(a)).toBe('Unestablished');
  });
});

describe('arkona_consistency agrees with any life’s birth or death', () => {
  it('her two restated births (Yasmin Arshama, Camue 1st, 4A 100; Mehrana II, 4A 530) are no Contradictory, and no life’s own value is compared with another’s', async () => {
    const run = await t.consistency({ subject: L.mehrana });
    const lifeValues = valuesOf(run).filter((v) => v.what === 'birth' || v.what === 'death');
    expect(lifeValues, JSON.stringify(lifeValues)).toEqual([]);
    expect(run.counts.contradictory).toBe(0);
    // Both restatements were read as hers (the agreement is real, not an attribution that missed them).
    const a = await t.asOf(L.mehrana, '4A 200');
    expect(a).not.toHaveProperty('contradictions');
  });

  it('control: a restated birth that matches no life is still reported', async () => {
    page(w, {
      id: Q.later,
      name: '[BSRC] Khorshahr - Court Register',
      parentId: O.alTibr,
      body: [para('mh3', '4A 700 - Mehrana II is born.')],
    });
    await refresh(w);
    const run = await t.consistency({ subject: L.mehrana });
    const births = valuesOf(run).filter((v) => v.what === 'birth');
    expect(births.map((v) => `${v.label}: ${v.value}`)).toEqual([
      'Contradictory: Camue 1st, 4A 100',
      'Contradictory: 4A 700',
    ]);
  });
});

describe('the coverage report agrees with the lives reading (one character)', () => {
  it('her readable birth is her first life’s, and her recorded death is flagged', async () => {
    const cov = await t.call('arkona_as_of_coverage', { detail: 'full' });
    const her = (cov.byCharacter as any[]).filter((x) => x.identityPage === L.mehrana);
    expect(her).toHaveLength(1);
    expect(her[0]).toMatchObject({ bucket: 'readableBirth', birth: { value: 'Camue 1st, 4A 100' } });
    const a = await t.asOf(L.mehrana, 'now');
    expect(a.died).toMatchObject({ value: 'Zahras 36th, 4A 950', life: 'the second life' });
  });
});
