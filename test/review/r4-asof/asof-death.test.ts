/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * CR-2026-11-R4 pass 3: `arkona_as_of` across a recorded death (ADR 0064 D7; ADR 0065 "On top of F4b.1" 3, 4 and 6;
 * ADR 0064 amendments 1 D and 2). Each test asserts the SAFE answer: passing means the attempt held, failing means the
 * tool stated something false with confidence. The REAL stack on the mock LegendKeeper, F4b.1's live-run world (the
 * owner's excerpts) and the approved pack `arkona-2026-11-20-f41`; the stand-ins are modelled on the owner's
 * reincarnating characters (Mehrana al-Khalid's incarnations, Nahla's Sidhe rebirth, Yue Bailu's Kitsune rebirth) and
 * on Jahan-Timur's "Deceased by 5A 931".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARKONA_PACK } from '../../../src/packs/arkona.js';
import {
  brief,
  chronologyRows,
  K,
  L,
  O,
  liveRunWorld,
  page,
  para,
  person,
  refresh,
  tools,
  valuesOf,
  type LiveWorld,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

/** This file's pages. */
const Q = {
  aldric: 'r4a01chr',
  berengar: 'r4a02chr',
  berengarAnnals: 'r4a02ann',
  cuthbert: 'r4a04chr',
  cuthAnnals1: 'r4a04an1',
  cuthAnnals2: 'r4a04an2',
  daria: 'r4a05chr',
  eadric: 'r4a06chr',
  fenna: 'r4a07chr',
  gisela: 'r4a08chr',
  hilda: 'r4a09chr',
  ingo: 'r4a10chr',
  jorunnIdx: 'r4a11idx',
  jorunn: 'r4a11chr',
  kasimir: 'r4a12chr',
  kasimirAu: 'r4a12aup',
  liesel: 'r4a14chr',
  magnus: 'r4a15chr',
  notker: 'r4a16chr',
  odo: 'r4a17chr',
  pippin: 'r4a18chr',
  pippinBio: 'r4a18bio',
  lothar: 'r4a87chr',
  lotharRow: 'r4a87row',
  mechthild: 'r4a95chr',
  norbert: 'r4a96chr',
  rashadTwin: 'r4a97chr',
} as const;

let w: LiveWorld;
let t: ReturnType<typeof tools>;

beforeAll(async () => {
  w = await liveRunWorld();
  // AS-01: a death in the Temporal Scope, with a later attestation (the time a source covers).
  person(w, {
    id: Q.aldric,
    name: 'Aldric Stand-in',
    given: 'Aldric',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died 4A 300; attested through 4A 500', 'Life State': 'Deceased' },
  });
  // AS-02, AS-03: the death recorded only on another Authoritative page; the identity page's Life State "Alive".
  person(w, {
    id: Q.berengar,
    name: 'Berengar Stand-in',
    given: 'Berengar',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Alive' },
  });
  page(w, {
    id: Q.berengarAnnals,
    name: '[BSRC] House of Berengar - Annals',
    parentId: O.alTibr,
    body: [para('b2p1', 'Berengar Stand-in died in Falkenau in 4A 300.')],
  });
  // AS-04: two Authoritative pages record two different deaths; the identity page attests the life through 4A 500.
  person(w, {
    id: Q.cuthbert,
    name: 'Cuthbert Stand-in',
    given: 'Cuthbert',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; attested through 4A 500', 'Life State': 'Deceased' },
  });
  page(w, {
    id: Q.cuthAnnals1,
    name: '[BSRC] Falkenau Annals',
    parentId: O.alTibr,
    body: [para('c4p1', 'Cuthbert Stand-in died in Falkenau in 4A 300.')],
  });
  page(w, {
    id: Q.cuthAnnals2,
    name: '[BSRC] Northern Chronicle',
    parentId: O.alTibr,
    body: [para('c4p2', 'Cuthbert Stand-in died in the north in 4A 310.')],
  });
  // AS-05: a reincarnation: the last death in the Life State, an earlier death and the return in the Temporal Scope.
  person(w, {
    id: Q.daria,
    name: 'Daria Stand-in',
    given: 'Daria',
    family: 'Stand-in',
    v: {
      'Temporal Scope': 'Born 4A 100; died 4A 300; reborn 4A 400',
      'Life State': 'Deceased Camue 3rd, 4A 500',
    },
  });
  // AS-06: a return, with a Life State that is not an alive value.
  person(w, {
    id: Q.eadric,
    name: 'Eadric Stand-in',
    given: 'Eadric',
    family: 'Stand-in',
    v: {
      'Temporal Scope': 'Born 4A 100; died 4A 300; reborn 4A 400; attested through 5A 931',
      'Life State': 'Reincarnated',
    },
  });
  // AS-07, AS-08, AS-09: the death guard (Life State "Alive" after a recorded death).
  person(w, {
    id: Q.fenna,
    name: 'Fenna Stand-in',
    given: 'Fenna',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died 4A 300; reborn 4A 400', 'Life State': 'Alive' },
  });
  person(w, {
    id: Q.gisela,
    name: 'Gisela Stand-in',
    given: 'Gisela',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died c. 4A 300; reborn 4A 400', 'Life State': 'Alive' },
  });
  person(w, {
    id: Q.hilda,
    name: 'Hilda Stand-in',
    given: 'Hilda',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died 4A 300', 'Life State': 'Alive' },
  });
  // AS-10: a Main CANON death in the Temporal Scope, inherited into Moonfall.
  person(w, {
    id: Q.ingo,
    name: 'Ingo Stand-in',
    given: 'Ingo',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died 4A 300', 'Life State': 'Deceased' },
  });
  // AS-11: a Main CANON death written in the Core's own prose (modelled on Nahla's Sidhe rebirth), Life State "Alive".
  person(w, {
    id: Q.jorunn,
    core: Q.jorunnIdx,
    name: 'Jorunn Stand-in',
    given: 'Jorunn',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born Camue 5th, 4A 200', 'Life State': 'Alive' },
  });
  w.setBody(Q.jorunn, [para('j11p', 'Jorunn Stand-in died in the Sidhe court on Isar 10th, 4A 260.')]);
  // AS-12: Main CANON records a death in 4A 300; Moonfall's own page a later one.
  person(w, {
    id: Q.kasimir,
    name: 'Kasimir Stand-in',
    given: 'Kasimir',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died 4A 300', 'Life State': 'Deceased' },
  });
  page(w, {
    id: Q.kasimirAu,
    name: '[BSRC] Moonfall War Chronicle',
    parentId: O.alTibr,
    tags: ['AU'],
    sidebar: { 'Continuity Type': 'AU', Continuity: 'Moonfall', Subject: 'Moonfall War Chronicle' },
    body: [para('k12p', 'Kasimir Stand-in died in the Moonfall war in 4A 600.')],
  });
  // AS-14 to AS-18: "Deceased by" and its look-alikes.
  person(w, {
    id: Q.liesel,
    name: 'Liesel Stand-in',
    given: 'Liesel',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Deceased by c. 5A 931' },
  });
  person(w, {
    id: Q.magnus,
    name: 'Magnus Stand-in',
    given: 'Magnus',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Deceased by 5A 931' },
  });
  person(w, {
    id: Q.notker,
    name: 'Notker Stand-in',
    given: 'Notker',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Deceased (by 5A 931)' },
  });
  person(w, {
    id: Q.odo,
    name: 'Odo Stand-in',
    given: 'Odo',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; died by 4A 600', 'Life State': 'Deceased' },
  });
  person(w, {
    id: Q.pippin,
    name: 'Pippin Stand-in',
    given: 'Pippin',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Deceased (by 5A 931)' },
  });
  page(w, {
    id: Q.pippinBio,
    name: '[BSRC] Pippin Stand-in - Biography',
    parentId: L.idx,
    sidebar: { Subject: 'Pippin Stand-in' },
    body: [para('p18p', 'Pippin Stand-in died in Falkenau in 4A 500.')],
  });
  // AS-87: a Main CANON death recorded only in a Universal Chronology row; the identity page's Life State "Alive".
  person(w, {
    id: Q.lothar,
    name: 'Lothar Stand-in',
    given: 'Lothar',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Alive' },
  });
  chronologyRows(w, [
    { id: Q.lotharRow, event: [{ text: 'Lothar Stand-in dies at Falkenau' }], date: 'Selyros 19th, 4A 300' },
  ]);
  // AS-95, AS-96: a return recorded with the death left unestablished (the owner's two phrasings, together).
  person(w, {
    id: Q.mechthild,
    name: 'Mechthild Stand-in',
    given: 'Mechthild',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; death date unestablished; reborn 4A 400', 'Life State': 'Alive' },
  });
  person(w, {
    id: Q.norbert,
    name: 'Norbert Stand-in',
    given: 'Norbert',
    family: 'Stand-in',
    v: {
      'Temporal Scope': 'Born 4A 100; death date unestablished; reborn 4A 400; attested through 5A 931',
      'Life State': '',
    },
  });
  // AS-97: the identity page's own Temporal Scope with the parents (and a parent's birth) before the date.
  person(w, {
    id: Q.rashadTwin,
    name: 'Samira al-Khalid',
    given: 'Samira',
    family: 'al-Khalid',
    v: {
      'Temporal Scope':
        'Born in Altan-Saray to Murad al-Khalid (born Malakh 33rd, 4A 280) on Camue 44th, 4A 360',
      'Life State': 'Alive',
    },
  });
  await refresh(w);
  t = tools(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('the approved pack', () => {
  // The reviewer ran this pass on arkona-2026-11-20-f41; the seed is now arkona-2026-11-21-r4 (this review's own version).
  it('control: the world runs on the seed, approved', async () => {
    // v3 F5a (ADR 0067): the seed is now arkona-2026-11-23-f5a (its consistency rules are r4's, unchanged).
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-24-f6a'); // v3 F6a (ADR 0076): -f6a supersedes -f7b
    const pack = w.stack.runtime.packs.get('arkona')!;
    expect(pack.seed).toBe('arkona-2026-11-24-f6a'); // v3 F6a (ADR 0076): -f6a supersedes -f7b
    expect(pack.approved?.version).toBe(pack.version);
    expect(pack.rules.consistency?.aliveValues).toEqual(['Alive', 'Living']);
    // The consistency tools are listed (the approved version has consistency rules) and answer.
    const a = await t.asOf(K.rashad, '4A 500');
    expect(a.state.value, brief(a)).toBe('Alive (recorded)');
  });
});

describe('as of: never "Alive (recorded)" across a recorded death', () => {
  it('AS-01: a death in the Temporal Scope with a later attestation: not alive after the death', async () => {
    const a = await t.asOf(Q.aldric, '4A 400');
    expect(a.died, brief(a)).toMatchObject({ value: '4A 300' });
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-02: a death recorded only on another Authoritative page (Life State "Alive"): not alive after it', async () => {
    const a = await t.asOf(Q.berengar, '4A 400');
    expect(a.died, brief(a)).toMatchObject({ value: '4A 300', page: { id: Q.berengarAnnals } });
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-03: the same at the present: neither alive nor deceased is established (the guard’s answer), never a bare "Deceased (recorded)" against the identity page’s Life State "Alive"', async () => {
    const a = await t.asOf(Q.berengar, 'now');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
    expect(a.state.value, brief(a)).toMatch(/^Unestablished/);
  });

  it('AS-04: two Authoritative pages record two different deaths (4A 300, 4A 310): never alive at 4A 400', async () => {
    const a = await t.asOf(Q.cuthbert, '4A 400');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-05: a reincarnation (died 4A 300, reborn 4A 400, Life State "Deceased Camue 3rd, 4A 500"): never alive at 4A 350, between the first death and the return', async () => {
    const a = await t.asOf(Q.daria, '4A 350');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-06: a return with a Life State that is not an alive value (Reincarnated; attested through 5A 931): never "Deceased (recorded)" after the return', async () => {
    const a = await t.asOf(Q.eadric, '4A 500');
    expect(a.state.value, brief(a)).not.toBe('Deceased (recorded)');
  });

  it('AS-07: the guard: the first day of the death’s year (died 4A 300, reborn 4A 400) straddles the death: never "Deceased (recorded)"', async () => {
    const a = await t.asOf(Q.fenna, 'Kumikas 1st, 4A 300');
    expect(a.state.value, brief(a)).not.toBe('Deceased (recorded)');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-08: the guard: "died c. 4A 300" (reborn 4A 400) asked 4A 296, inside the death’s margin: never "Deceased (recorded)"', async () => {
    const a = await t.asOf(Q.gisela, '4A 296');
    expect(a.state.value, brief(a)).not.toBe('Deceased (recorded)');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-09: control: the guard with no return, on the first day of the death’s year: Unestablished, never alive', async () => {
    const a = await t.asOf(Q.hilda, 'Kumikas 1st, 4A 300');
    expect(a.state.value, brief(a)).toMatch(/^Unestablished/);
  });
});

describe('as of: a recorded return implies a death before it', () => {
  it('AS-95: "death date unestablished; reborn 4A 400" with Life State "Alive": never "Alive (recorded)" at 4A 350, before the return', async () => {
    const a = await t.asOf(Q.mechthild, '4A 350');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-96: the same with no Life State and an attestation through 5A 931: never "Alive (recorded)" at 4A 350, inside the span but before the return', async () => {
    const a = await t.asOf(Q.norbert, '4A 350');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });
});

describe('as of: the identity page’s own Temporal Scope', () => {
  it('AS-97: "Born in Altan-Saray to Murad al-Khalid (born Malakh 33rd, 4A 280) on Camue 44th, 4A 360": born Camue 44th, 4A 360, never the father’s date', async () => {
    const a = await t.asOf(Q.rashadTwin, '4A 400');
    expect(a.born?.value, brief(a)).not.toBe('Malakh 33rd, 4A 280');
  });
});

describe('as of: AU inheritance of a Main CANON death (D9; ADR 0065 "On top of F4b.1" 4)', () => {
  it('AS-10: a Main CANON death in the Temporal Scope is inherited into Moonfall, labelled', async () => {
    const a = await t.asOf(Q.ingo, '4A 400', { continuity: 'Moonfall' });
    expect(a.state, brief(a)).toMatchObject({
      value: 'Deceased (recorded)',
      label: 'inherited from Main CANON',
    });
  });

  it('AS-11: a Main CANON death written in the Core’s own prose (Life State "Alive") is not dropped in Moonfall: never "Alive (recorded)" after it, labelled as Main CANON’s', async () => {
    const main = await t.asOf(Q.jorunn, '4A 300');
    expect(main.state.value, brief(main)).toBe('Unestablished (recorded death; current Life State Alive)');
    const au = await t.asOf(Q.jorunn, '4A 300', { continuity: 'Moonfall' });
    expect(au.state.value, brief(au)).not.toBe('Alive (recorded)');
  });

  it('AS-12: Moonfall’s own page records a later death (4A 600): its own fact first (D9), never "Deceased (recorded)" at 4A 400 from Main CANON', async () => {
    const au = await t.asOf(Q.kasimir, '4A 400', { continuity: 'Moonfall' });
    expect(au.state.value, brief(au)).not.toBe('Deceased (recorded)');
  });

  it('AS-87: a Main CANON death recorded only in a Universal Chronology row is not dropped in Moonfall: never "Alive (recorded)" after it, labelled as Main CANON’s', async () => {
    const main = await t.asOf(Q.lothar, '4A 400');
    expect(main.state.value, brief(main)).not.toBe('Alive (recorded)');
    const au = await t.asOf(Q.lothar, '4A 400', { continuity: 'Moonfall' });
    expect(au.state.value, brief(au)).not.toBe('Alive (recorded)');
  });

  it('AS-88: in Moonfall, the Main CANON chronology rows shown around the date are labelled as Main CANON’s (Harun al-Saffar’s "dies in the siege")', async () => {
    const au = await t.asOf(K.harun, '4A 300', { continuity: 'Moonfall', window: 3 });
    const rows = [...(au.around.before ?? []), ...(au.around.during ?? []), ...(au.around.after ?? [])];
    expect(rows.length, JSON.stringify(au.around)).toBeGreaterThan(0);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatchObject({ label: 'inherited from Main CANON' });
  });

  it('AS-13: Yasmin al-Naim in Moonfall, whose own chronicle says "born in 4A 150 in this telling": at 4A 120 never "Alive (recorded)" on Main CANON’s birth', async () => {
    const au = await t.asOf(K.yasmin, '4A 120', { continuity: 'Moonfall' });
    expect(au.born?.value, brief(au)).not.toBe('Camue 1st, 4A 100');
    expect(au.state.value, brief(au)).not.toBe('Alive (recorded)');
  });
});

describe('as of: "Deceased by <date>" is an upper bound only', () => {
  it('AS-14: "Deceased by c. 5A 931" asked 5A 927, before the bound: never "Deceased"', async () => {
    const a = await t.asOf(Q.liesel, '5A 927');
    expect(a.state.value, brief(a)).not.toMatch(/^Deceased/);
  });

  it('AS-15: control: "Deceased by 5A 931" asked 5A 920 (born, nothing attested): Unestablished', async () => {
    const a = await t.asOf(Q.magnus, '5A 920');
    expect(a.state.value, brief(a)).toBe('Unestablished');
    expect(a, brief(a)).not.toHaveProperty('died');
  });

  it('AS-16: a Life State "Deceased (by 5A 931)" is no death date: never "Alive (recorded)" at 5A 900 between the birth and the bound', async () => {
    const a = await t.asOf(Q.notker, '5A 900');
    expect(a, brief(a)).not.toHaveProperty('died');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-17: a Temporal Scope "died by 4A 600" is no death date: never "Alive (recorded)" at 4A 500', async () => {
    const a = await t.asOf(Q.odo, '4A 500');
    expect(a.state.value, brief(a)).not.toBe('Alive (recorded)');
  });

  it('AS-18: an upper bound is never compared: "Deceased (by 5A 931)" and a Biography’s "died in Falkenau in 4A 500" make no death finding', async () => {
    const run = await t.consistency({ subject: Q.pippin });
    const deaths = valuesOf(run).filter((v) => v.what === 'death');
    expect(deaths, JSON.stringify(deaths)).toEqual([]);
  });
});
