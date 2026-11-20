/**
 * ADR 0064 amendment 1: the integration world of the first live run's findings (the owner's review of run
 * `apr_7e189380f2f0ee05` on Arkona, 20 November 2026). F4b's world (test/consistency/world.ts) plus pages built from
 * the excerpts the owner quoted from that run, verbatim, never fetched:
 *
 * - **A, subject attribution**: Soren von Woerfels' page ("…passed to Soren after Tobias von Hohenfalk died on Azah 3rd,
 *   3A 98"), Veresa von Mader's ("When Finn died on Kusha 9th, 4A 12, the electors chose her as Kaiserin…"), Daryavan
 *   al-Khalid's ("Their son Murad al-Khalid was born on Malakh 33rd, 4A 280"), Yvonne von Hohenfalk's ("Their son,
 *   Leopold I von Hohenfalk, was born on Camue 47th, 3A 231") and Falkenreich's dated line ("Frostmoot 4th, 3A 167
 *   (1,250,165 KCY) - After Kaiser Soren von Woerfels dies, …"). The four characters' own values are chosen so that
 *   F4b's reading reported two Contradictory pairs and two Gaps, as the run did;
 * - **B, the date inside the clause**: Temporal Scopes and prose with a place, parents or KCY around the date;
 * - **C, chronology rows**: the Universal Chronology rows the run read as joined text ("Varadi Bendeguz is born in
 *   Varadyn Kiralysag | Selaphos 40th, 3A 78 | 1,250,076"), added to the fixture chronology's one table (the consistency
 *   check reads every row by its columns, whatever its age);
 * - **D, Life State and bounds**: a dateless "Deceased" (Cordelia and Mannfred von Katzen, Jamil al-Fajr, Shibata
 *   Miyako), "Deceased by 5A 931; exact death date unestablished" (Jahan-Timur);
 * - **E, identity values**: Katsuragi Koharu's Naming Culture and Murket's Family / Surname, restated with other
 *   qualifiers;
 * - **F, non-current sections**: Purandukht Mithra's birth, unestablished on her identity page, in Yue Bailu's Core's
 *   "Key Life Transitions - Author-Facing Pre-Rewrite History", in Yue Bailu's Biography (a current section, "Birth and
 *   Upbringing", in this fixture; and a pre-rewrite one), and in a chronology row "(author-facing pre-rewrite
 *   provenance)".
 *
 * Where the run quoted only a clause, the rest of the sentence is the fixture's (a stand-in subject, "Nuasulo
 * Stand-in", for the Nuasulo birth; the four characters' own values).
 */
import { SidebarModel } from '../resources/world.js';
import { IDENTITY_KEYS } from '../packs/world.js';
import { C, O, P, f4bWorld, type F4bWorld } from './world.js';

/** The fixture pages' ids. */
export const L = {
  idx: 'liveidx1',
  soren: 'sorenref',
  tobias: 'tobiaref',
  veresa: 'veresref',
  finn: 'finnref1',
  daryavan: 'daryaref',
  murad: 'muradref',
  yvonne: 'yvonnref',
  leopold: 'leoporef',
  falkenreich: 'falkhist',
  lineage: 'khalidln',
  fujimatsu: 'fujichrn',
  arshama: 'arshamad',
  adelheid: 'adelhref',
  elias: 'eliasref',
  nuasulo: 'nuasuref',
  jamil: 'jamilref',
  vahuka: 'vahukref',
  vishtaspa: 'vishtref',
  khshay: 'khsharef',
  mehrana: 'mehr3ref',
  kaito: 'kaitoref',
  varadi: 'varadref',
  zhuang: 'zhuanref',
  tsuru: 'tsururef',
  akari: 'akariref',
  cordelia: 'corderef',
  mannfred: 'mannfref',
  jahan: 'jahanref',
  shibata: 'shibaref',
  koharu: 'koharref',
  koharuBio: 'koharbio',
  murket: 'murkeref',
  murketBio: 'murkebio',
  purandukht: 'purandrf',
  yueIdx: 'yuebaidx',
  yue: 'yuebacor',
  yueBio: 'yuebabio',
} as const;

/** The characters this world adds, by identity page (all Authoritative, Main CANON, under `L.idx`). */
export const LIVE_SUBJECTS: Readonly<Record<string, string>> = {
  [L.soren]: 'Soren von Woerfels',
  [L.tobias]: 'Tobias von Hohenfalk',
  [L.veresa]: 'Veresa von Mader',
  [L.finn]: 'Finn von Mader',
  [L.daryavan]: 'Daryavan al-Khalid',
  [L.murad]: 'Murad al-Khalid',
  [L.yvonne]: 'Yvonne von Hohenfalk',
  [L.leopold]: 'Leopold I von Hohenfalk',
  [L.adelheid]: 'Adelheid von Falkenrath',
  [L.elias]: 'Elias Brenner',
  [L.nuasulo]: 'Nuasulo Stand-in',
  [L.jamil]: 'Jamil al-Fajr',
  [L.vahuka]: 'Vahuka Arshama',
  [L.vishtaspa]: 'Vishtaspa Arshama',
  [L.khshay]: 'Khshayayarsha Arshama',
  [L.mehrana]: 'Mehrana al-Khalid',
  [L.kaito]: 'Kamigawa Kaito',
  [L.varadi]: 'Varadi Bendeguz',
  [L.zhuang]: 'Zhuang Tianlong',
  [L.tsuru]: 'Yasusuna Tsuru',
  [L.akari]: 'Shibukawa Akari',
  [L.cordelia]: 'Cordelia von Katzen',
  [L.mannfred]: 'Mannfred von Katzen',
  [L.jahan]: 'Jahan-Timur',
  [L.shibata]: 'Shibata Miyako',
  [L.koharu]: 'Katsuragi Koharu',
  [L.murket]: 'Murket',
  [L.purandukht]: 'Purandukht Mithra',
  [L.yue]: 'Yue Bailu',
};

const para = (id: string, ...runs: Record<string, unknown>[]) => ({ id, kind: 'paragraph', content: runs });
const t = (text: string) => ({ text });
const heading = (id: string, text: string, level = 2) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});

const canon = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

/** Each character: its identity page's name parts and sidebar values. */
interface Person {
  readonly id: string;
  readonly given: string;
  readonly family: string;
  readonly v: Partial<Record<string, string>>;
  readonly aliases?: readonly string[];
}

const PEOPLE: readonly Person[] = [
  // A: the four characters' own values (so F4b's reading reported two Contradictory pairs and two Gaps).
  { id: L.soren, given: 'Soren', family: 'von Woerfels', v: { 'Temporal Scope': 'Succession 3A 98' } },
  { id: L.tobias, given: 'Tobias', family: 'von Hohenfalk', v: { 'Temporal Scope': 'Died Azah 3rd, 3A 98' } },
  {
    id: L.veresa,
    given: 'Veresa',
    family: 'von Mader',
    v: { 'Temporal Scope': 'Attested 4A 12–4A 40; death date unestablished' },
  },
  { id: L.finn, given: 'Finn', family: 'von Mader', v: { 'Temporal Scope': 'Died Kusha 9th, 4A 12' } },
  {
    id: L.daryavan,
    given: 'Daryavan',
    family: 'al-Khalid',
    v: { 'Temporal Scope': 'Born Malakh 2nd, 4A 251' },
  },
  { id: L.murad, given: 'Murad', family: 'al-Khalid', v: { 'Temporal Scope': 'Born Malakh 33rd, 4A 280' } },
  {
    id: L.yvonne,
    given: 'Yvonne',
    family: 'von Hohenfalk',
    v: { 'Temporal Scope': 'Birth date unestablished' },
  },
  {
    id: L.leopold,
    given: 'Leopold',
    family: 'von Hohenfalk',
    v: { 'Temporal Scope': 'Born Camue 47th, 3A 231' },
  },
  // B: a place, parents or KCY around the date.
  {
    id: L.adelheid,
    given: 'Adelheid',
    family: 'von Falkenrath',
    v: { 'Temporal Scope': 'Born in Erzherzogtum Falkenau on Jehet 27th, 4A 84 (1,250,391 KCY)' },
  },
  {
    id: L.elias,
    given: 'Elias',
    family: 'Brenner',
    v: { 'Temporal Scope': 'Born in Falkenau on Jehet 39th, 4A 100 (1,250,407 KCY)' },
  },
  {
    id: L.nuasulo,
    given: 'Unestablished',
    family: 'Unestablished',
    v: { 'Temporal Scope': 'Born in the Empire of Nuasulo on Isar 1st, 1A 26,119' },
  },
  {
    id: L.jamil,
    given: 'Jamil',
    family: 'al-Fajr',
    v: {
      'Temporal Scope':
        'Born in Wadi Al-Sihr, southern Al-Muqaddas, on Camue 1st, 2A 749,689 (1,249,688 KCY); death date unestablished',
      'Life State': 'Deceased',
    },
  },
  { id: L.vahuka, given: 'Vahuka', family: 'Arshama', v: { 'Temporal Scope': 'Born Pahan 5th, 2A 749,452' } },
  { id: L.vishtaspa, given: 'Vishtaspa', family: 'Arshama', v: { 'Temporal Scope': 'Died 4A 10' } },
  { id: L.khshay, given: 'Khshayayarsha', family: 'Arshama', v: { 'Temporal Scope': 'Died 3A 6' } },
  // C: the chronology rows' subjects; Mehrana al-Khalid by her birth name.
  {
    id: L.mehrana,
    given: 'Mehrana',
    family: 'al-Khalid',
    v: { 'Temporal Scope': 'Born Camue 1st, 4A 100', Aliases: 'Yasmin Arshama' },
    aliases: ['Yasmin Arshama'],
  },
  { id: L.kaito, given: 'Kaito', family: 'Kamigawa', v: { 'Temporal Scope': 'Born Kusha 17th, 2A 67,189' } },
  {
    id: L.varadi,
    given: 'Bendeguz',
    family: 'Varadi',
    v: { 'Temporal Scope': 'Born Selaphos 40th, 3A 78' },
  },
  {
    id: L.zhuang,
    given: 'Tianlong',
    family: 'Zhuang',
    v: { 'Temporal Scope': 'Born Isar 35th, 2A 698,131' },
  },
  { id: L.tsuru, given: 'Tsuru', family: 'Yasusuna', v: { 'Temporal Scope': 'Born Malakh 39th, 2A 66,799' } },
  { id: L.akari, given: 'Akari', family: 'Shibukawa', v: { 'Temporal Scope': 'Born Camue 50th, 1A 34' } },
  // D: Life State and bounds.
  {
    id: L.cordelia,
    given: 'Cordelia',
    family: 'von Katzen',
    v: { 'Life State': 'Deceased', 'Temporal Scope': 'Died Selyros 19th, 4A 114' },
  },
  {
    id: L.mannfred,
    given: 'Mannfred',
    family: 'von Katzen',
    v: { 'Life State': 'Deceased', 'Temporal Scope': 'Died Selyros 19th, 4A 114' },
  },
  {
    id: L.jahan,
    given: 'Jahan-Timur',
    family: 'None',
    v: {
      'Life State': 'Deceased by 5A 931; exact death date unestablished',
      'Temporal Scope': 'Attested through 5A 900; exact death date unestablished',
    },
  },
  {
    id: L.shibata,
    given: 'Miyako',
    family: 'Shibata',
    v: { 'Life State': 'Deceased', 'Temporal Scope': 'Born 5A 790; exact death date unestablished' },
  },
  // E: identity values with qualifiers.
  {
    id: L.koharu,
    given: 'Koharu',
    family: 'Katsuragi',
    v: { 'Naming Culture': 'Rangawan (current); Falkenreicher (historical name and identity)' },
  },
  {
    id: L.murket,
    given: 'Murket',
    family: 'None - adopted Old Shenxian mononym; former Mekhbet component unresolved',
    v: {},
  },
  // F: a birth left unestablished on the identity page.
  {
    id: L.purandukht,
    given: 'Purandukht',
    family: 'Mithra',
    v: { 'Temporal Scope': 'Birth date unestablished' },
  },
];

export interface LiveWorld extends F4bWorld {
  /** The Universal Chronology rows this world adds (their ids). */
  readonly rows: readonly string[];
}

/** F4b's world plus the first live run's excerpts. */
export async function liveRunWorld(): Promise<LiveWorld> {
  const w = await f4bWorld({
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: L.idx, name: '[INDEX] Live Run Fixtures', parentId: C.humans });
      for (const p of PEOPLE) {
        const name = LIVE_SUBJECTS[p.id]!;
        r.seed({
          id: p.id,
          name: `[BSRC] ${name} - Character Reference`,
          parentId: L.idx,
          referenceType: 'Compact Character Reference',
          canonical: name,
          aliases: [...(p.aliases ?? [])],
          tags: ['CANON', 'Character', 'Human'],
        });
      }
      r.seed({ id: L.yueIdx, name: '[INDEX] Yue Bailu', parentId: L.idx });
      r.seed({
        id: L.yue,
        name: '[BSRC] Yue Bailu - Character Core',
        parentId: L.yueIdx,
        referenceType: 'Character Core',
        canonical: 'Yue Bailu',
        tags: ['CANON', 'Character', 'Human'],
      });
      const source = (id: string, name: string, parentId: string, referenceType = 'General Source') =>
        r.seed({ id, name, parentId, referenceType, tags: ['CANON'] });
      source(L.yueBio, '[BSRC] Yue Bailu - Biography', L.yueIdx);
      source(L.koharuBio, '[BSRC] Katsuragi Koharu - Biography', L.idx);
      source(L.murketBio, '[BSRC] Murket - Biography', L.idx);
      source(
        L.falkenreich,
        '[BSRC] Falkenreich - Historical State & Imperial Development',
        O.alTibr,
        'Polity Reference',
      );
      source(L.lineage, '[BSRC] Al-Khalid Family - Lineage', L.idx);
      source(L.fujimatsu, '[BSRC] Fujimatsu - Imperial Chronicle', O.alTibr, 'Polity Reference');
      source(L.arshama, '[BSRC] Khorshahr-Arshama - Dynasty Reference', O.alTibr, 'Polity Reference');
    },
  });
  const r = w.repo;
  const sb = w.sidebars;
  const setBody = (id: string, blocks: unknown[]) => w.setBody(id, blocks);
  const identity = (id: string, v: Partial<Record<string, string>>) =>
    sb.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const person = (id: string, name: string, given: string, family: string, ref: string, v: object) =>
    identity(id, {
      ...canon,
      Subject: name,
      'Canonical Display Name': name,
      'Personal / Given Name': given,
      'Family / Surname': family,
      'Naming Culture': 'Velaran',
      'Reference Type': ref,
      Scope: `${name}, a person of Arkona`,
      'Race / Species': 'Human',
      'Life State': 'Alive',
      'Last Major Revision': '2026-11-01',
      Supersedes: 'None',
      ...v,
    });
  for (const p of PEOPLE)
    person(p.id, LIVE_SUBJECTS[p.id]!, p.given, p.family, 'Compact Character Reference', p.v);
  person(L.yue, 'Yue Bailu', 'Bailu', 'Yue', 'Character Core', {
    'Temporal Scope': 'Attested 2A 748,480–5A 931',
  });
  // E: the restatements, on Biographies whose Subject is the character.
  identity(L.koharuBio, {
    ...canon,
    Subject: 'Katsuragi Koharu',
    'Reference Type': 'General Source',
    'Naming Culture': 'Rangawan (current); Falkenreicher (historical identity)',
  });
  identity(L.murketBio, {
    ...canon,
    Subject: 'Murket',
    'Reference Type': 'General Source',
    'Family / Surname': 'None - Old Shenxian adopted mononym',
  });
  identity(L.yueBio, { ...canon, Subject: 'Yue Bailu', 'Reference Type': 'General Source' });

  // A: subject attribution.
  setBody(L.soren, [
    heading('so1', 'Purpose'),
    para(
      'so2',
      t('The imperial dignity passed to Soren after Tobias von Hohenfalk died on Azah 3rd, 3A 98.'),
    ),
  ]);
  setBody(L.veresa, [
    heading('ve1', 'Purpose'),
    para('ve2', t('When Finn died on Kusha 9th, 4A 12, the electors chose her as Kaiserin…')),
  ]);
  setBody(L.daryavan, [
    heading('da1', 'Purpose'),
    para('da2', t('Their son Murad al-Khalid was born on Malakh 33rd, 4A 280.')),
  ]);
  setBody(L.yvonne, [
    heading('yv1', 'Purpose'),
    para('yv2', t('Their son, Leopold I von Hohenfalk, was born on Camue 47th, 3A 231.')),
  ]);
  setBody(L.falkenreich, [
    heading('fk1', 'Purpose'),
    para(
      'fk2',
      t(
        'Frostmoot 4th, 3A 167 (1,250,165 KCY) - After Kaiser Soren von Woerfels dies, the electors choose Varadi Bendeguz as Kaiser.',
      ),
    ),
  ]);
  // B: the date inside the clause.
  setBody(L.lineage, [
    heading('kl1', 'Purpose'),
    para(
      'kl2',
      t(
        'Rashad al-Khalid was born in Altan-Saray on Camue 44th, 4A 360 to Murad al-Khalid and Saaliha al-Khalid, born al-Shariff.',
      ),
    ),
  ]);
  setBody(L.fujimatsu, [
    heading('fu1', 'Purpose'),
    para('fu2', t('Titania was born in the Empire of Fujimatsu on Sarias 28th, 1A 51,743.')),
  ]);
  setBody(L.vahuka, [
    heading('vh1', 'Purpose'),
    para(
      'vh2',
      t('Vahuka Arshama was born in Ashavahta on Pahan 5th, 2A 749,452 and proved his martial talent…'),
    ),
  ]);
  setBody(L.arshama, [
    heading('ar1', 'Purpose'),
    para('ar2', t('Vishtaspa Arshama died in exile in 4A 10.')),
    para('ar3', t('Khshayayarsha Arshama died in Khorshahr in 3A 6.')),
  ]);
  // F: non-current sections inside current pages.
  setBody(L.yue, [
    heading('yc1', 'Purpose'),
    para('yc2', t('The Core of Yue Bailu.')),
    heading('yc3', 'Key Life Transitions - Author-Facing Pre-Rewrite History'),
    para('yc4', t('Purandukht Mithra was born in 2A 748,455 in the old capital.')),
  ]);
  setBody(L.yueBio, [
    heading('yb1', 'Purpose'),
    heading('yb2', 'Birth and Upbringing'),
    para('yb3', t('Purandukht Mithra was born on Zarzakh 17th, 2A 748,455, in the winter palace…')),
    heading('yb4', 'Birth, Upbringing and Magical Reputation - Pre-Rewrite'),
    para('yb5', t('Purandukht Mithra was born in 2A 748,300 in the first telling.')),
  ]);

  // C: the Universal Chronology rows (read by their columns; F4b read them as their joined text).
  const fourth = r.blocks.get(w.mainOf(P.fourthAge))!;
  const table = (fourth.blocks as Record<string, unknown>[]).find((b) => b.kind === 'table')!;
  const row = (id: string, event: string, date: string, kcy: string) => ({
    id,
    kind: 'tableRow',
    children: [
      { id: `${id}a`, kind: 'tableCell', children: [para(`${id}ap`, t(event))] },
      { id: `${id}b`, kind: 'tableCell', children: [para(`${id}bp`, t(date))] },
      { id: `${id}c`, kind: 'tableCell', children: [para(`${id}cp`, t(kcy))] },
    ],
  });
  const rows = [
    row(
      'lrow01',
      'Adelheid von Falkenrath is born in Erzherzogtum Falkenau',
      'Jehet 27th, 4A 84',
      '1,250,391',
    ),
    row('lrow02', 'Elias Brenner is born in Falkenau', 'Jehet 39th, 4A 100', '1,250,407'),
    row('lrow03', 'Kamigawa Kaito is born in the Empire of Fujimatsu', 'Kusha 17th, 2A 67,189', ''),
    row('lrow04', 'Varadi Bendeguz is born in Varadyn Kiralysag', 'Selaphos 40th, 3A 78', '1,250,076'),
    row('lrow05', 'Zhuang Tianlong is born in Old Shenxia', 'Isar 35th, 2A 698,131', ''),
    row('lrow06', 'Yasusuna Tsuru is born in the Empire of Fujimatsu', 'Malakh 39th, 2A 66,799', ''),
    row('lrow07', 'Shibukawa Akari is born in the Empire of Fujimatsu', 'Camue 50th, 1A 34', ''),
    row('lrow08', 'Vahuka Arshama is born in Ashavahta', 'Pahan 5th, 2A 749,452', ''),
    row(
      'lrow09',
      'Khshayayarsha Arshama dies in Khorshahr, plunging Khorshahr-Arshama into chaos',
      'Azah 19th, 3A 6',
      '',
    ),
    row('lrow10', 'Yasmin Arshama is born in Khorshahr', 'Camue 1st, 4A 100', '1,250,407'),
    row(
      'lrow11',
      'Purandukht Mithra is born in the old capital (author-facing pre-rewrite provenance)',
      '2A 748,300',
      '',
    ),
  ];
  (table.children as unknown[]).push(...rows);
  w.rebuildTree();
  return Object.assign(w, { rows: rows.map((x) => x.id) });
}
