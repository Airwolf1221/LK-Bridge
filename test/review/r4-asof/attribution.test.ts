/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * CR-2026-11-R4 pass 3: `arkona_consistency` and `arkona_as_of` attribute a sentence only to the name governing its
 * verb (ADR 0064 amendment 1, rule A: "never a pronoun, never another name in the sentence"), read the date of that
 * clause (rule B), and compare identity values by their principal part (rule E) without hiding a real difference.
 * Every sentence is a variation on the owner's live excerpts (the Lineage line "Rashad al-Khalid was born in Altan-Saray
 * on Camue 44th, 4A 360 to Murad al-Khalid and Saaliha al-Khalid, born al-Shariff.", Daryavan's "Their son Murad
 * al-Khalid was born on Malakh 33rd, 4A 280.", Soren's "…passed to Soren after Tobias von Hohenfalk died on Azah 3rd,
 * 3A 98", the Varadyn line "Zahras 1st, 4A 99 (1,250,406 KCY) - Rita von Katzen, later Katsuragi Yamato, is born in
 * Varadyn Kiralysag.", Katsuragi Yamato's Aliases). Each test asserts the SAFE answer; failing means a confident
 * falsehood (a false Contradictory, the nightly audit's warning, or a wrong date in as-of).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  brief,
  chronologyRows,
  K,
  L,
  liveRunWorld,
  O,
  page,
  para,
  person,
  refresh,
  setRows,
  tools,
  valuesOf,
  type LiveWorld,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const Q = {
  annals: 'r4d39ann',
  hohenfalk: 'r4d41ann',
  heirRow: 'r4d51row',
  courtRow: 'r4d52row',
  twoRow: 'r4d91row',
  yasminFamily: 'r4d84fam',
  falkenau: 'r4d53ann',
  varadyn: 'r4d55ann',
  soren: L.soren,
  ottokarIdx: 'r4d49idx',
  ottokar: 'r4d49chr',
  ottokarBio: 'r4d49bio',
  ottokarB: 'r4d49chb',
  hoshinoIdx: 'r4d50idx',
  hoshino: 'r4d50chr',
  hoshinoBio: 'r4d50bio',
  ruprecht: 'r4d74chr',
  leopoldBio: 'r4d74bio',
  xaver: 'r4d58chr',
  konradIdx: 'r4h65idx',
  konrad: 'r4h65chr',
  konradBio: 'r4h65bio',
  annaIdx: 'r4h66idx',
  anna: 'r4h66chr',
  annaBio: 'r4h66bio',
  raceIdx: 'r4h67idx',
  race: 'r4h67chr',
  raceBio: 'r4h67bio',
  dashIdx: 'r4h68idx',
  dash: 'r4h68chr',
  dashBio: 'r4h68bio',
  onoIdx: 'r4h69idx',
  ono: 'r4h69chr',
  onoBio: 'r4h69bio',
} as const;

/** The sentences, each on an Authoritative page, each its own paragraph (so each finding's excerpt names it). */
const S = {
  daughterOf: 'The daughter of Rashad al-Khalid was born on Camue 1st, 4A 401.',
  patronymic: 'Layla bint Rashad al-Khalid was born on Kusha 9th, 4A 402.',
  possessive: 'Rashad al-Khalid’s son was born in 4A 401.',
  possessiveNamed: 'Rashad al-Khalid’s son Murad al-Khalid was born on Malakh 33rd, 4A 280.',
  passive: 'Murad was born to Rashad al-Khalid in 4A 401.',
  twoNames: 'Murad al-Khalid and Yasmin al-Naim’s daughter was born in 4A 401.',
  appositive: 'Murad al-Khalid, son of Rashad al-Khalid, was born on Malakh 33rd, 4A 280.',
  parentBorn:
    'Rashad al-Khalid was born in Altan-Saray to Murad al-Khalid (born Malakh 33rd, 4A 280) on Camue 44th, 4A 360.',
  wifeOf: 'The wife of Tobias von Hohenfalk died in 3A 120.',
  middleName: 'Karl Tobias von Hohenfalk was born in 3A 150.',
  ruledSince: 'Tobias von Hohenfalk died in Falkenau, the city he had ruled since 3A 60.',
  kaiser: 'When the Kaiser died on Azah 3rd, 3A 98, the electors met at Falkenau.',
  whichFell: 'Murad al-Khalid was born in Falkenau, which fell in 4A 250.',
  varadynMother:
    'Zahras 1st, 4A 99 (1,250,406 KCY) - Rita von Katzen is born in Varadyn Kiralysag to Cornelia von Katzen (born Azah 19th, 4A 51).',
  ottokar: 'Ottokar was born on Selyros 3rd, 3A 250.',
  yamato: 'Yamato was born on Isar 3rd, 4A 600 in the Empire of Fujimatsu.',
  leopold: 'Leopold was born on Camue 47th, 3A 231.',
  motherOfGiven: 'The mother of Yasmin was born in 4A 60.',
  relative: 'Murad al-Khalid, whose wife died in 4A 300, ruled Altan-Saray.',
} as const;

/** Katsuragi Yamato's Aliases, as the owner's live page has them (ADR 0064 amendment 2, 3). */
const YAMATO_ALIASES = 'Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)';

let w: LiveWorld;
let t: ReturnType<typeof tools>;

/** A character with an index of its own and a Biography under it whose sidebar restates one identity field. */
function withBiography(
  idx: string,
  id: string,
  bio: string,
  name: string,
  given: string,
  family: string,
  own: Record<string, string>,
  restated: Record<string, string>,
): void {
  person(w, { id, core: idx, name, given, family, v: own });
  page(w, {
    id: bio,
    name: `[BSRC] ${name} - Biography`,
    parentId: idx,
    sidebar: { Subject: name, ...restated },
    body: [para(`${bio}p`, `${name} served the court.`)],
  });
}

beforeAll(async () => {
  w = await liveRunWorld();
  page(w, {
    id: Q.annals,
    name: '[BSRC] Al-Khalid Court Annals',
    parentId: O.alTibr,
    body: [
      para('d39a', S.daughterOf),
      para('d40a', S.patronymic),
      para('d43a', S.possessive),
      para('d44a', S.possessiveNamed),
      para('d45a', S.passive),
      para('d46a', S.twoNames),
      para('d47a', S.appositive),
      para('d54a', S.parentBorn),
      para('d85a', S.relative),
    ],
  });
  // AS-84: Yasmin al-Naim's own page, about her mother, by her given name.
  page(w, {
    id: Q.yasminFamily,
    name: '[BSRC] Yasmin al-Naim - Family History',
    parentId: K.yasminIdx,
    sidebar: { Subject: 'Yasmin al-Naim' },
    body: [para('d84a', S.motherOfGiven)],
  });
  page(w, {
    id: Q.hohenfalk,
    name: '[BSRC] House of Hohenfalk - Chronicle',
    parentId: O.alTibr,
    body: [
      para('d41a', S.wifeOf),
      para('d42a', S.middleName),
      para('d56a', S.ruledSince),
      para('d48a', S.kaiser),
    ],
  });
  page(w, {
    id: Q.falkenau,
    name: '[BSRC] Falkenau - City Reference',
    parentId: O.alTibr,
    body: [para('d53a', S.whichFell)],
  });
  page(w, {
    id: Q.varadyn,
    name: '[BSRC] Varadyn - Court Register',
    parentId: O.alTibr,
    body: [para('d55a', S.varadynMother)],
  });
  // AS-48: Soren von Woerfels goes by "the Kaiser" (an alias that is a title).
  setRows(w, L.soren, { Aliases: 'the Kaiser' });
  // AS-49: two characters share the given name Ottokar; one's own Biography gives his birth by the given name.
  person(w, {
    id: Q.ottokar,
    core: Q.ottokarIdx,
    name: 'Ottokar von Falkenrath',
    given: 'Ottokar',
    family: 'von Falkenrath',
    v: { 'Temporal Scope': 'Born 3A 260' },
  });
  page(w, {
    id: Q.ottokarBio,
    name: '[BSRC] Ottokar von Falkenrath - Biography',
    parentId: Q.ottokarIdx,
    sidebar: { Subject: 'Ottokar von Falkenrath' },
    body: [para('d49a', S.ottokar)],
  });
  person(w, {
    id: Q.ottokarB,
    name: 'Ottokar Brenner',
    given: 'Ottokar',
    family: 'Brenner',
    v: { 'Temporal Scope': 'Born 4A 10' },
  });
  // AS-50: Katsuragi Yamato's live Aliases ("Yamato (from 4A 192)"), and another character whose given name is Yamato.
  setRows(w, K.katsu, { Aliases: YAMATO_ALIASES });
  person(w, {
    id: Q.hoshino,
    core: Q.hoshinoIdx,
    name: 'Hoshino Yamato',
    given: 'Yamato',
    family: 'Hoshino',
    v: { 'Naming Culture': 'Fujimatsuan', 'Temporal Scope': 'Born Isar 3rd, 4A 600' },
  });
  page(w, {
    id: Q.hoshinoBio,
    name: '[BSRC] Hoshino Yamato - Biography',
    parentId: Q.hoshinoIdx,
    sidebar: { Subject: 'Hoshino Yamato' },
    body: [para('d50a', S.yamato)],
  });
  // AS-74: a regnal name in brackets ("Leopold (Second of the Name)"), and Leopold I's own Biography by his given name.
  person(w, {
    id: Q.ruprecht,
    name: 'Ruprecht von Hohenfalk',
    given: 'Ruprecht',
    family: 'von Hohenfalk',
    v: { Aliases: 'Leopold (Second of the Name)', 'Temporal Scope': 'Born 3A 280' },
  });
  page(w, {
    id: Q.leopoldBio,
    name: '[BSRC] Leopold I von Hohenfalk - Biography',
    parentId: L.idx,
    sidebar: { Subject: 'Leopold I von Hohenfalk' },
    body: [para('d74a', S.leopold)],
  });
  // AS-58: a rebirth worded "born again" in the Temporal Scope.
  person(w, {
    id: Q.xaver,
    name: 'Xaver Stand-in',
    given: 'Xaver',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; born again 4A 300', 'Life State': 'Alive' },
  });
  // AS-51, AS-52: chronology rows naming one person and mentioning another.
  chronologyRows(w, [
    {
      id: Q.heirRow,
      event: [
        { text: 'The heir of ' },
        { mention: { resourceId: K.rashad, text: 'Rashad al-Khalid' } },
        { text: ' is born' },
      ],
      date: 'Camue 1st, 4A 401',
    },
    {
      id: Q.twoRow,
      event: [{ text: 'Rashad al-Khalid dies as Murad al-Khalid is born' }],
      date: 'Malakh 33rd, 4A 280',
    },
    {
      id: Q.courtRow,
      event: [
        { text: 'Murad al-Khalid is born at the court of ' },
        { mention: { resourceId: K.rashad, text: 'Rashad al-Khalid' } },
      ],
      date: 'Malakh 33rd, 4A 280',
    },
  ]);
  // AS-65 to AS-69: identity values restated on the character's own Biography.
  withBiography(
    Q.konradIdx,
    Q.konrad,
    Q.konradBio,
    'Konrad von Woerfels-Hohenfalk',
    'Konrad',
    'von Woerfels-Hohenfalk',
    {},
    { 'Family / Surname': 'von Hohenfalk-Woerfels' },
  );
  withBiography(
    Q.annaIdx,
    Q.anna,
    Q.annaBio,
    'Anna Maria Stand-in',
    'Anna Maria',
    'Stand-in',
    {},
    {
      'Personal / Given Name': 'Maria Anna',
    },
  );
  withBiography(
    Q.raceIdx,
    Q.race,
    Q.raceBio,
    'Rudolf Stand-in',
    'Rudolf',
    'Stand-in',
    { 'Race / Species': '(Human)' },
    {
      'Race / Species': '(Elf)',
    },
  );
  withBiography(
    Q.dashIdx,
    Q.dash,
    Q.dashBio,
    'Siegmund Stand-in',
    'Siegmund',
    'Stand-in',
    { 'Race / Species': '— (Human)' },
    {
      'Race / Species': '— (Elf)',
    },
  );
  withBiography(
    Q.onoIdx,
    Q.ono,
    Q.onoBio,
    'Ōno Haruka',
    'Haruka',
    'Ōno',
    { 'Naming Culture': 'Fujimatsuan' },
    {
      'Family / Surname': 'Ono',
    },
  );
  await refresh(w);
  t = tools(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

/** The values of a subject's findings whose excerpt holds this text. */
async function restating(subject: string, text: string) {
  const run = await t.consistency({ subject });
  return valuesOf(run).filter((v) => v.excerpt.includes(text));
}

describe('rule A: only the name governing the verb', () => {
  it('AS-39: "The daughter of Rashad al-Khalid was born on Camue 1st, 4A 401." is never Rashad’s birth', async () => {
    const hits = await restating(K.rashad, 'The daughter of Rashad');
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-40: a patronymic, "Layla bint Rashad al-Khalid was born on Kusha 9th, 4A 402.", is never Rashad’s birth', async () => {
    const hits = await restating(K.rashad, 'Layla bint Rashad');
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-41: "The wife of Tobias von Hohenfalk died in 3A 120." is never Tobias’s death', async () => {
    const hits = await restating(L.tobias, 'The wife of Tobias');
    expect(hits, JSON.stringify(hits)).toEqual([]);
    const a = await t.asOf(L.tobias, '3A 110');
    expect(a.died?.value, brief(a)).toBe('Azah 3rd, 3A 98');
  });

  it('AS-42: a name inside a longer name, "Karl Tobias von Hohenfalk was born in 3A 150.", is never Tobias’s birth', async () => {
    const a = await t.asOf(L.tobias, '3A 98');
    expect(a.born, brief(a)).toBe('birth unestablished');
  });

  it('AS-84: on her own page, "The mother of Yasmin was born in 4A 60." (her given name) is never Yasmin al-Naim’s birth', async () => {
    const hits = await restating(K.yasmin, S.motherOfGiven);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-85: control: a relative clause ("Murad al-Khalid, whose wife died in 4A 300, ruled Altan-Saray.") is never Murad’s death', async () => {
    expect(await restating(L.murad, 'whose wife died')).toEqual([]);
  });

  it('AS-43: control: a possessive with no name governing the verb ("Rashad al-Khalid’s son was born in 4A 401.") is nobody’s', async () => {
    const hits = await restating(K.rashad, 'Rashad al-Khalid’s son was born in 4A 401');
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-44: control: "X’s son Y was born" is Y’s (Murad’s, agreeing with his own page), never X’s', async () => {
    expect(await restating(K.rashad, 'son Murad al-Khalid was born')).toEqual([]);
    expect(await restating(L.murad, 'son Murad al-Khalid was born')).toEqual([]);
  });

  it('AS-45: control: the passive "Murad was born to Rashad al-Khalid in 4A 401." is never Rashad’s', async () => {
    expect(await restating(K.rashad, 'Murad was born to Rashad')).toEqual([]);
  });

  it('AS-46: control: two names and a possessive ("Murad al-Khalid and Yasmin al-Naim’s daughter was born in 4A 401.") is nobody’s', async () => {
    expect(await restating(L.murad, 'Yasmin al-Naim’s daughter')).toEqual([]);
    expect(await restating(K.yasmin, 'Yasmin al-Naim’s daughter')).toEqual([]);
  });

  it('AS-47: control: an appositive holding a name ("Murad al-Khalid, son of Rashad al-Khalid, was born…") is never Rashad’s', async () => {
    expect(await restating(K.rashad, 'son of Rashad al-Khalid, was born')).toEqual([]);
  });

  it('AS-48: an alias that is a title ("the Kaiser", Soren’s) never takes another Kaiser’s death ("When the Kaiser died on Azah 3rd, 3A 98" on the House of Hohenfalk’s chronicle)', async () => {
    const hits = await restating(Q.soren, 'When the Kaiser died');
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-49: control: a given name two characters share (Ottokar) counts only on its own character’s pages', async () => {
    expect(await restating(Q.ottokarB, S.ottokar)).toEqual([]);
    // It is Ottokar von Falkenrath’s (his own Biography), against his own page’s 3A 260.
    const own = await restating(Q.ottokar, S.ottokar);
    expect(own.map((v) => v.label)).toContain('Contradictory');
  });

  it('AS-50: an alias that is another character’s given name (Katsuragi Yamato’s live alias "Yamato (from 4A 192)") never takes Hoshino Yamato’s own Biography ("Yamato was born on Isar 3rd, 4A 600…")', async () => {
    const hits = await restating(K.katsu, S.yamato);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-51: a chronology row "The heir of @Rashad al-Khalid is born | Camue 1st, 4A 401" (the mention’s text is his name) is never Rashad’s birth', async () => {
    const hits = await restating(K.rashad, 'The heir of');
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-52: control: a row naming Murad and mentioning Rashad ("Murad al-Khalid is born at the court of @Rashad al-Khalid") is never Rashad’s', async () => {
    expect(await restating(K.rashad, 'Murad al-Khalid is born at the court')).toEqual([]);
  });

  it('AS-91: control: a row naming two people ("Rashad al-Khalid dies as Murad al-Khalid is born") is Murad’s birth only, never Rashad’s birth or death', async () => {
    expect(await restating(K.rashad, 'Rashad al-Khalid dies as Murad')).toEqual([]);
    expect(await restating(L.murad, 'Rashad al-Khalid dies as Murad')).toEqual([]);
  });

  it('AS-74: a regnal name in brackets ("Leopold (Second of the Name)", Ruprecht’s alias) never makes him "Leopold" and takes Leopold I’s own Biography ("Leopold was born on Camue 47th, 3A 231.")', async () => {
    const hits = await restating(Q.ruprecht, S.leopold);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });
});

describe('rule B: the date of the clause, never another date in the sentence', () => {
  it('AS-53: "Murad al-Khalid was born in Falkenau, which fell in 4A 250." gives no birth date (4A 250 is the city’s fall)', async () => {
    const hits = await restating(L.murad, S.whichFell);
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-54: the Lineage line with the parents first, "…born in Altan-Saray to Murad al-Khalid (born Malakh 33rd, 4A 280) on Camue 44th, 4A 360.", is Rashad’s birth on Camue 44th, 4A 360, never his father’s date', async () => {
    const hits = await restating(K.rashad, 'to Murad al-Khalid (born Malakh');
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  it('AS-55: the Varadyn line with the mother’s birth in brackets reads Rita von Katzen’s (Katsuragi Yamato’s) birth as Zahras 1st, 4A 99, never her mother’s Azah 19th, 4A 51', async () => {
    const hits = await restating(K.katsu, 'to Cornelia von Katzen (born Azah');
    expect(
      hits.map((v) => v.value),
      JSON.stringify(hits),
    ).not.toContain('Azah 19th, 4A 51');
  });

  it('AS-56: "Tobias von Hohenfalk died in Falkenau, the city he had ruled since 3A 60." is never a death in 3A 60', async () => {
    const hits = await restating(L.tobias, 'ruled since 3A 60');
    expect(
      hits.map((v) => v.value),
      JSON.stringify(hits),
    ).not.toContain('3A 60');
  });

  it('AS-57: control: the owner’s Lineage line as written (the date before the parents) agrees with Rashad’s own page: no finding', async () => {
    expect(await restating(K.rashad, 'born in Altan-Saray on Camue 44th, 4A 360 to Murad')).toEqual([]);
  });

  it('AS-58: a rebirth worded "born again 4A 300" is no second, contradictory birth on the identity page', async () => {
    const run = await t.consistency({ subject: Q.xaver });
    const births = valuesOf(run).filter((v) => v.what === 'birth');
    expect(births, JSON.stringify(births)).toEqual([]);
  });
});

describe('rule E: principal values never hide a real difference', () => {
  const identity = async (subject: string, field: string) =>
    ((await t.consistency({ subject })).findings as any[]).filter(
      (f) => f.check === 'consistency_identity' && f.details.field === field,
    );

  it('AS-65: Family / Surname "von Woerfels-Hohenfalk" against "von Hohenfalk-Woerfels" (the houses in the other order) is reported', async () => {
    const f = await identity(Q.konrad, 'Family / Surname');
    expect(f, JSON.stringify(f)).toHaveLength(1);
  });

  it('AS-66: Personal / Given Name "Anna Maria" against "Maria Anna" is reported', async () => {
    const f = await identity(Q.anna, 'Personal / Given Name');
    expect(f, JSON.stringify(f)).toHaveLength(1);
  });

  it('AS-67: control: an empty principal part ("(Human)" against "(Elf)") falls back to the whole value: reported', async () => {
    const f = await identity(Q.race, 'Race / Species');
    expect(f, JSON.stringify(f)).toHaveLength(1);
  });

  it('AS-68: a principal part that is only a dash ("— (Human)" against "— (Elf)") is reported, as the empty one is', async () => {
    const f = await identity(Q.dash, 'Race / Species');
    expect(f, JSON.stringify(f)).toHaveLength(1);
  });

  it('AS-69: a Family / Surname that differs by a macron ("Ōno" against "Ono", two Japanese surnames) is reported', async () => {
    const f = await identity(Q.ono, 'Family / Surname');
    expect(f, JSON.stringify(f)).toHaveLength(1);
  });
});
