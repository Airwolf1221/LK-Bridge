/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * CR-2026-11-R4 pass 3: `arkona_as_of` never alive past what is recorded (ADR 0064 D7 decision 2: "Never Alive past
 * what is recorded"), except under the owner's "Alive / Living" Life State rule (ADR 0065 "On top of F4b.1" 5, amended
 * by ADR 0064 amendment 2, 2: a principal part STARTING with an alive value; "in / at <date>" ends the attestation
 * there). The look-alike Life State values below are variations on the owner's live values ("Alive", "Living", "Alive
 * in 5A 931", "Living and immortal at 5A 931; …", "Alive (Kitsune rebirth)"). Each test asserts the SAFE answer: a
 * value that does not record the character alive at the date never gives "Alive (recorded)".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { brief, K, liveRunWorld, person, refresh, tools, type LiveWorld } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

/** Each stand-in: born 4A 100 (Temporal Scope), its Life State one look-alike value. */
const ALIVE: readonly (readonly [id: string, attempt: string, lifeState: string])[] = [
  ['r4b19chr', 'AS-19', 'Alive?'],
  ['r4b20chr', 'AS-20', 'Alive (presumed)'],
  ['r4b21chr', 'AS-21', 'Living memory'],
  ['r4b22chr', 'AS-22', 'Alive - unconfirmed'],
  ['r4b23chr', 'AS-23', 'Formerly alive'],
  ['r4b24chr', 'AS-24', 'Not alive'],
  ['r4b25chr', 'AS-25', 'Alive in Kumikas 1st, 5A 931'],
  ['r4b26chr', 'AS-26', 'Alive in 4A 500'],
  ['r4b27chr', 'AS-27', 'Alive as of 4A 500'],
  ['r4b28chr', 'AS-28', 'Alive until 4A 500'],
  ['r4b29chr', 'AS-29', 'Alive (last attested 4A 500)'],
];
const ID = Object.fromEntries(ALIVE.map(([id, attempt]) => [attempt, id])) as Record<string, string>;
const Q = {
  negation: 'r4b30chr',
  through: 'r4b31chr',
  yearBirth: 'r4b36chr',
} as const;

let w: LiveWorld;
let t: ReturnType<typeof tools>;

beforeAll(async () => {
  w = await liveRunWorld();
  const GIVEN = [
    'Ansgar',
    'Bertolt',
    'Clothilde',
    'Detlev',
    'Edeltraud',
    'Folkmar',
    'Gerlinde',
    'Hartmut',
    'Irmgard',
    'Jost',
    'Kunigunde',
  ];
  ALIVE.forEach(([id, , life], i) =>
    person(w, {
      id,
      name: `${GIVEN[i]!} Stand-in`,
      given: GIVEN[i]!,
      family: 'Stand-in',
      v: { 'Temporal Scope': 'Born 4A 100', 'Life State': life },
    }),
  );
  // AS-30: a negation in the Temporal Scope ("no longer alive in 5A 931"), no Life State.
  person(w, {
    id: Q.negation,
    name: 'Ulrike Stand-in',
    given: 'Ulrike',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; no longer alive in 5A 931', 'Life State': '' },
  });
  // AS-31: attested through 4A 500, no Life State.
  person(w, {
    id: Q.through,
    name: 'Volker Stand-in',
    given: 'Volker',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; attested through 4A 500', 'Life State': '' },
  });
  // AS-36: a birth of year precision, with Life State "Alive".
  person(w, {
    id: Q.yearBirth,
    name: 'Walburga Stand-in',
    given: 'Walburga',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Alive' },
  });
  await refresh(w);
  t = tools(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('as of: Life State look-alikes of the alive values', () => {
  it('control: Life State "Alive" with a birth: Alive (recorded) at the present', async () => {
    const a = await t.asOf(Q.yearBirth, 'now');
    expect(a.state.value, brief(a)).toBe('Alive (recorded)');
  });

  it('AS-19: "Alive?" (a question) never records the character alive', async () => {
    const a = await t.asOf(ID['AS-19']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-20: "Alive (presumed)" is a presumption, not a record: never "Alive (recorded)"', async () => {
    const a = await t.asOf(ID['AS-20']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-21: "Living memory" is no Life State of the living: never "Alive (recorded)"', async () => {
    const a = await t.asOf(ID['AS-21']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-22: "Alive - unconfirmed" is unconfirmed: never "Alive (recorded)"', async () => {
    const a = await t.asOf(ID['AS-22']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-23: "Formerly alive": never "Alive (recorded)" at the present', async () => {
    const a = await t.asOf(ID['AS-23']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-24: "Not alive": never "Alive (recorded)"', async () => {
    const a = await t.asOf(ID['AS-24']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-25: "Alive in Kumikas 1st, 5A 931" asked Surion 10th, 5A 931, later than the date it gives (the calendar ends on Surion 17th, 5A 931): never "Alive (recorded)"', async () => {
    const a = await t.asOf(ID['AS-25']!, 'Surion 10th, 5A 931');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
    // Control: at the date it gives, alive.
    expect((await t.asOf(ID['AS-25']!, 'Kumikas 1st, 5A 931')).state.value).toBe('Alive (recorded)');
  });

  it('AS-26: "Alive in 4A 500" asked at the present: never "Alive (recorded)" past 4A 500', async () => {
    const a = await t.asOf(ID['AS-26']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-27: "Alive as of 4A 500" asked at the present: never "Alive (recorded)" past 4A 500', async () => {
    const a = await t.asOf(ID['AS-27']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-28: "Alive until 4A 500" asked at the present: never "Alive (recorded)" past 4A 500', async () => {
    const a = await t.asOf(ID['AS-28']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-29: "Alive (last attested 4A 500)" asked at the present: never "Alive (recorded)" past 4A 500', async () => {
    const a = await t.asOf(ID['AS-29']!, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });
});

describe('as of: never alive past the attested span', () => {
  it('AS-30: a Temporal Scope "no longer alive in 5A 931" never attests the life at 5A 931', async () => {
    const a = await t.asOf(Q.negation, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-31: "attested through 4A 500" (no Life State) asked 4A 600: Unestablished', async () => {
    const a = await t.asOf(Q.through, '4A 600');
    expect(a.state.value, brief(a)).toBe('Unestablished');
    expect((await t.asOf(Q.through, '4A 400')).state.value).toBe('Alive (recorded)');
  });

  it('AS-32: Life State "Alive" never reaches before the recorded birth', async () => {
    const a = await t.asOf(Q.yearBirth, '4A 90');
    expect(a.state.value, brief(a)).toBe('Unestablished');
    expect(a.elapsedYears).toBe('not yet born');
  });
});

describe('as of: a date before the birth', () => {
  it('AS-36: born Camue 1st, 4A 100 (Yasmin al-Naim), asked Kumikas 1st, 4A 100 (earlier that year): not yet born, Unestablished; a year-precision birth asked inside its year: never "Alive (recorded)"', async () => {
    const a = await t.asOf(K.yasmin, 'Kumikas 1st, 4A 100');
    expect(a.elapsedYears, brief(a)).toBe('not yet born');
    expect(a.state.value, brief(a)).toBe('Unestablished');
    const y = await t.asOf(Q.yearBirth, 'Kumikas 1st, 4A 100');
    expect(y.state.value, brief(y)).not.toBe('Alive (recorded)');
  });
});
