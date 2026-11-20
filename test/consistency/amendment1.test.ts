/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining */
/**
 * ADR 0064 amendment 1 (from the first live run, 20 November 2026): every fixture the owner quoted from run
 * `apr_7e189380f2f0ee05`, verbatim, as unit tests of the extractor (src/consistency/extract.ts), the date scan
 * (src/consistency/dates.ts) and the comparison (src/consistency/compare.ts), with the pack's `-f4b1` rules and Arkona's
 * own calendar (the oracle's).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../src/calendar/index.js';
import { compareCharacter, principalKey, type PageInfo } from '../../src/consistency/compare.js';
import { readScan } from '../../src/consistency/dates.js';
import {
  compilePatterns,
  extractPageFacts,
  extractRowFacts,
  isNonCurrent,
  principalValue,
  resolveName,
  type ChronologyRowInput,
  type NameIndex,
  type Unit,
} from '../../src/consistency/extract.js';
import type { StoredFact } from '../../src/consistency/facts-index.js';
import { nameKeyOf } from '../../src/packs/naming/namesakes.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: unknown };
const cal = createCalendar(ORACLE.calendar);
const rules = ARKONA_PACK.rules.consistency!;
const compiled = compilePatterns(rules);
const known = new Map<string, 'name' | 'given'>();
for (const n of [
  'Soren von Woerfels',
  'Tobias von Hohenfalk',
  'Veresa von Mader',
  'Finn von Mader',
  'Daryavan al-Khalid',
  'Murad al-Khalid',
  'Yvonne von Hohenfalk',
  'Leopold I von Hohenfalk',
  'Varadi Bendeguz',
  'Rashad al-Khalid',
  'Saaliha al-Khalid',
  'Adelheid von Falkenrath',
  'Elias Brenner',
  'Vahuka Arshama',
  'Vishtaspa Arshama',
  'Khshayayarsha Arshama',
  'Kamigawa Kaito',
  'Zhuang Tianlong',
  'Yasusuna Tsuru',
  'Shibukawa Akari',
  'Yasmin Arshama',
  'Titania',
  'Purandukht Mithra',
  'Yasmin al-Naim',
  'Karim al-Naim',
])
  known.set(nameKeyOf(n), 'name');
for (const g of ['Soren', 'Finn', 'Veresa', 'Yasmin']) known.set(nameKeyOf(g), 'given');
const names: NameIndex = { lookup: (k) => known.get(k) ?? null };
const ctx = { compiled, names, cal, style: DEFAULT_DATE_STYLE };

const unit = (text: string, section = 'Purpose', blockId = 'b1'): Unit => ({
  unit: 'text',
  text,
  documentId: 'doc1',
  blockId,
  field: null,
  section,
});
/** The facts of one paragraph on a character's page (its subject given by its sidebar). */
const onPage = (subject: string, text: string, section = 'Purpose') =>
  extractPageFacts(
    'page1',
    [
      {
        unit: 'name',
        text: `${subject} - Character Reference`,
        documentId: null,
        blockId: null,
        field: null,
        section: null,
      },
      { unit: 'fact', text: subject, documentId: null, blockId: 'r1', field: 'Subject', section: 'sidebar' },
      unit(text, section),
    ],
    ctx,
  ).facts.filter((f) => f.kind !== 'identity');
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
  ).facts;

describe('A: subject attribution (rule A: the name governing the verb, in its own clause)', () => {
  it('Soren’s page: "…passed to Soren after Tobias von Hohenfalk died on Azah 3rd, 3A 98" is Tobias’s death', () => {
    const f = onPage(
      'Soren von Woerfels',
      'The imperial dignity passed to Soren after Tobias von Hohenfalk died on Azah 3rd, 3A 98',
    );
    expect(f).toEqual([
      expect.objectContaining({
        kind: 'death',
        subjectKey: nameKeyOf('Tobias von Hohenfalk'),
        valueText: 'Azah 3rd, 3A 98',
      }),
    ]);
  });

  it('…and when Tobias is no name the bridge knows, it is nobody’s (never Soren’s, named in another clause)', () => {
    const r = resolveName(
      'The imperial dignity passed to Soren after Tobias of the Marches',
      names,
      compiled.words,
    );
    expect(r).toBeNull();
  });

  it('Veresa’s page: "When Finn died on Kusha 9th, 4A 12, the electors chose her as Kaiserin…" is Finn’s death', () => {
    expect(
      onPage('Veresa von Mader', 'When Finn died on Kusha 9th, 4A 12, the electors chose her as Kaiserin…'),
    ).toEqual([
      expect.objectContaining({
        kind: 'death',
        subjectKey: 'finn',
        matchedAs: 'given',
        valueText: 'Kusha 9th, 4A 12',
      }),
    ]);
  });

  it('Daryavan’s page: "Their son Murad al-Khalid was born on Malakh 33rd, 4A 280" is Murad’s birth', () => {
    expect(onPage('Daryavan al-Khalid', 'Their son Murad al-Khalid was born on Malakh 33rd, 4A 280')).toEqual(
      [
        expect.objectContaining({
          kind: 'birth',
          subjectKey: nameKeyOf('Murad al-Khalid'),
          valueText: 'Malakh 33rd, 4A 280',
        }),
      ],
    );
  });

  it('Yvonne’s page: "Their son, Leopold I von Hohenfalk, was born on Camue 47th, 3A 231" is Leopold’s birth', () => {
    expect(
      onPage('Yvonne von Hohenfalk', 'Their son, Leopold I von Hohenfalk, was born on Camue 47th, 3A 231'),
    ).toEqual([
      expect.objectContaining({
        kind: 'birth',
        subjectKey: nameKeyOf('Leopold I von Hohenfalk'),
        valueText: 'Camue 47th, 3A 231',
      }),
    ]);
  });

  it('Falkenreich: "Frostmoot 4th, 3A 167 (1,250,165 KCY) - After Kaiser Soren von Woerfels dies, …" IS Soren’s death', () => {
    expect(
      onPage(
        'Falkenreich',
        'Frostmoot 4th, 3A 167 (1,250,165 KCY) - After Kaiser Soren von Woerfels dies, the electors choose Varadi Bendeguz as Kaiser.',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'death',
        pattern: 'death.prose.dated',
        subjectKey: nameKeyOf('Soren von Woerfels'),
        valueText: 'Frostmoot 4th, 3A 167',
        date: expect.objectContaining({ precision: 'day' }),
      }),
    ]);
  });

  it('D2 kept: a pronoun is never read, and a sentence naming two characters is only the governing one’s', () => {
    expect(onPage('Veresa von Mader', 'She died on Kusha 9th, 4A 12.')).toEqual([]);
    expect(onPage('Veresa von Mader', 'When she died on Kusha 9th, 4A 12, Finn mourned.')).toEqual([]);
    const two = onPage(
      'Daryavan al-Khalid',
      'Murad al-Khalid was born on Malakh 33rd, 4A 280 to Daryavan al-Khalid.',
    );
    expect(two).toEqual([expect.objectContaining({ subjectKey: nameKeyOf('Murad al-Khalid') })]);
  });

  it('an appositive is passed over; a name inside it never governs ("Yasmin al-Naim, daughter of Karim al-Naim, is born")', () => {
    expect(resolveName('Yasmin al-Naim, daughter of Karim al-Naim,', names, compiled.words)?.text).toBe(
      'Yasmin al-Naim',
    );
    expect(resolveName('Soren von Woerfels, Kaiser,', names, compiled.words)?.text).toBe(
      'Soren von Woerfels',
    );
    // An appositive opened by a clause word, not a comma: nothing (never the name inside it).
    expect(resolveName('When the daughter of Karim al-Naim, aged three,', names, compiled.words)).toBeNull();
  });
});

describe('B: the date inside the clause (rule B: the first date-shaped text)', () => {
  const cases: [string, string, 'day' | 'year'][] = [
    ['Erzherzogtum Falkenau on Jehet 27th, 4A 84 (1,250,391 KCY)', 'Jehet 27th, 4A 84', 'day'],
    ['Falkenau on Jehet 39th, 4A 100 (1,250,407 KCY)', 'Jehet 39th, 4A 100', 'day'],
    ['the Empire of Nuasulo on Isar 1st, 1A 26,119', 'Isar 1st, 1A 26,119', 'day'],
    ['the Empire of Fujimatsu on Sarias 28th, 1A 51,743', 'Sarias 28th, 1A 51,743', 'day'],
    [
      'Wadi Al-Sihr, southern Al-Muqaddas, on Camue 1st, 2A 749,689 (1,249,688 KCY)',
      'Camue 1st, 2A 749,689',
      'day',
    ],
    [
      'Altan-Saray on Camue 44th, 4A 360 to Murad al-Khalid and Saaliha al-Khalid, born al-Shariff',
      'Camue 44th, 4A 360',
      'day',
    ],
    ['Ashavahta on Pahan 5th, 2A 749,452 and proved his martial talent…', 'Pahan 5th, 2A 749,452', 'day'],
    ['4A 10', '4A 10', 'year'],
    ['3A 6', '3A 6', 'year'],
  ];
  for (const [text, want, precision] of cases)
    it(`"${text}" reads as ${want}`, () => {
      const r = readScan(cal, text);
      expect(r).toMatchObject({ ok: true, reading: { text: want, precision } });
    });

  it('in sentences: births after "born in / on", deaths after "died in" (Vishtaspa Arshama, 4A 10)', () => {
    expect(
      onPage(
        'Adelheid von Falkenrath',
        'Adelheid von Falkenrath was born in Erzherzogtum Falkenau on Jehet 27th, 4A 84 (1,250,391 KCY).',
      ),
    ).toEqual([expect.objectContaining({ kind: 'birth', valueText: 'Jehet 27th, 4A 84', unreadable: null })]);
    expect(onPage('Vishtaspa Arshama', 'Vishtaspa Arshama died in 4A 10.')).toEqual([
      expect.objectContaining({
        kind: 'death',
        valueText: '4A 10',
        date: expect.objectContaining({ precision: 'year' }),
      }),
    ]);
    expect(onPage('Khshayayarsha Arshama', 'Khshayayarsha Arshama died in 3A 6.')[0]).toMatchObject({
      valueText: '3A 6',
    });
  });

  it('"born al-Shariff" is a maiden name, not a second birth: one fact, Rashad’s', () => {
    const f = onPage(
      'Rashad al-Khalid',
      'Rashad al-Khalid was born in Altan-Saray on Camue 44th, 4A 360 to Murad al-Khalid and Saaliha al-Khalid, born al-Shariff.',
    );
    expect(f).toEqual([
      expect.objectContaining({ subjectKey: nameKeyOf('Rashad al-Khalid'), valueText: 'Camue 44th, 4A 360' }),
    ]);
  });

  it('a Temporal Scope with a place and KCY: "Born in Falkenau on Jehet 39th, 4A 100 (1,250,407 KCY)"', () => {
    expect(
      sidebar('Elias Brenner', {
        'Temporal Scope': 'Born in Falkenau on Jehet 39th, 4A 100 (1,250,407 KCY)',
      }).find((f) => f.kind === 'birth'),
    ).toMatchObject({ valueText: 'Jehet 39th, 4A 100', unreadable: null });
  });

  it('nothing date-shaped: no fact at all (not "unreadable"); a clause word ends the clause', () => {
    expect(onPage('Rashad al-Khalid', 'Rashad al-Khalid was born in the citadel of Altan-Saray.')).toEqual(
      [],
    );
    expect(
      onPage('Rashad al-Khalid', 'Rashad al-Khalid was born in the citadel, when the war ended in 4A 360.'),
    ).toEqual([]);
    expect(readScan(cal, 'the citadel of Altan-Saray')).toBeNull();
  });

  it('"unreadable" is a date-shaped text the calendar refuses, with its reason', () => {
    const f = onPage('Rashad al-Khalid', 'Rashad al-Khalid was born in Altan-Saray on Camue 51st, 4A 360.');
    expect(f).toEqual([
      expect.objectContaining({
        date: null,
        valueText: expect.stringMatching(/^Camue 51st, 4A 360/),
        unreadable: expect.stringMatching(/Camue has 50 days/),
      }),
    ]);
  });
});

describe('C: chronology rows (rule C: by their columns; attributed by rule A)', () => {
  const row = (rowId: string, event: string, date: string, more: Partial<ChronologyRowInput> = {}) => ({
    pageId: 'chron',
    documentId: 'age',
    rowId,
    event,
    date,
    mentions: [],
    ...more,
  });
  const rows: [string, string, string, 'birth' | 'death', string][] = [
    [
      'Adelheid von Falkenrath is born in Erzherzogtum Falkenau',
      'Jehet 27th, 4A 84',
      'Adelheid von Falkenrath',
      'birth',
      'Jehet 27th, 4A 84',
    ],
    [
      'Elias Brenner is born in Falkenau',
      'Jehet 39th, 4A 100',
      'Elias Brenner',
      'birth',
      'Jehet 39th, 4A 100',
    ],
    ['Kamigawa Kaito is born', 'Kusha 17th, 2A 67,189', 'Kamigawa Kaito', 'birth', 'Kusha 17th, 2A 67,189'],
    [
      'Varadi Bendeguz is born in Varadyn Kiralysag',
      'Selaphos 40th, 3A 78',
      'Varadi Bendeguz',
      'birth',
      'Selaphos 40th, 3A 78',
    ],
    ['Zhuang Tianlong is born', 'Isar 35th, 2A 698,131', 'Zhuang Tianlong', 'birth', 'Isar 35th, 2A 698,131'],
    ['Yasusuna Tsuru is born', 'Malakh 39th, 2A 66,799', 'Yasusuna Tsuru', 'birth', 'Malakh 39th, 2A 66,799'],
    ['Shibukawa Akari is born', 'Camue 50th, 1A 34', 'Shibukawa Akari', 'birth', 'Camue 50th, 1A 34'],
    [
      'Vahuka Arshama is born in Ashavahta',
      'Pahan 5th, 2A 749,452',
      'Vahuka Arshama',
      'birth',
      'Pahan 5th, 2A 749,452',
    ],
    [
      'Khshayayarsha Arshama dies, plunging Khorshahr-Arshama into chaos',
      'Azah 19th, 3A 6',
      'Khshayayarsha Arshama',
      'death',
      'Azah 19th, 3A 6',
    ],
    ['Yasmin Arshama is born', 'Camue 1st, 4A 100', 'Yasmin Arshama', 'birth', 'Camue 1st, 4A 100'],
  ];
  it('each row reads its date from its Date column and its subject from its event', () => {
    const facts = extractRowFacts(
      rows.map(([event, date], i) => row(`r${i}`, event, date)),
      ctx,
    );
    expect(facts).toHaveLength(rows.length);
    rows.forEach(([, , who, kind, date], i) =>
      expect(facts[i], who).toMatchObject({
        source: 'chronology',
        kind,
        subjectKey: nameKeyOf(who),
        valueText: date,
        unreadable: null,
        date: expect.objectContaining({ precision: 'day' }),
      }),
    );
  });

  it('a table row on a page is never read as its joined text ("Varadyn Kiralysag | Selaphos 40th, 3A 78 | 1,250,076")', () => {
    const f = extractPageFacts(
      'chron',
      [
        {
          unit: 'row',
          text: 'Varadi Bendeguz is born in Varadyn Kiralysag | Selaphos 40th, 3A 78 | 1,250,076',
          documentId: 'age',
          blockId: 'r1',
          field: null,
          section: 'Purpose',
        },
      ],
      ctx,
    ).facts;
    expect(f).toEqual([]);
  });

  it('a row whose event governs its verb with another name is not the mentioned page’s', () => {
    const f = extractRowFacts(
      [
        row('m1', 'The heir of the house is born', '4A 300', { mentions: ['corebody'] }),
        row('m2', 'Amira of the Reeds is born', '4A 300', {
          mentions: ['corebody'],
          subjects: [{ resourceId: 'corebody', text: 'Amira of the Reeds' }],
        }),
      ],
      ctx,
    );
    expect(f).toEqual([
      expect.objectContaining({ blockId: 'm2', subjectKey: 'page:corebody', matchedAs: 'mention' }),
    ]);
  });
});

describe('D: Life State and bounds', () => {
  it('Cordelia and Mannfred von Katzen: "Deceased" is a state; the death date is the Temporal Scope’s', () => {
    const f = sidebar('Cordelia von Katzen', {
      'Life State': 'Deceased',
      'Temporal Scope': 'Died Selyros 19th, 4A 114',
    });
    expect(f.filter((x) => x.kind === 'death')).toEqual([
      expect.objectContaining({
        source: 'temporalScope',
        valueText: 'Selyros 19th, 4A 114',
        unreadable: null,
      }),
    ]);
    // The Life State is still recorded, as the identity fact it is.
    expect(f.find((x) => x.kind === 'identity' && x.field === 'Life State')).toMatchObject({
      valueText: 'Deceased',
    });
  });

  it('"Deceased" with no date anywhere: nothing is reported', () => {
    expect(
      sidebar('Mannfred von Katzen', { 'Life State': 'Deceased' }).filter((x) => x.kind !== 'identity'),
    ).toEqual([]);
  });

  it('Jahan-Timur: "Deceased by 5A 931; exact death date unestablished" is a bound and a gap, never a death date', () => {
    const f = sidebar('Jahan-Timur', { 'Life State': 'Deceased by 5A 931; exact death date unestablished' });
    const deaths = f.filter((x) => x.kind === 'death');
    expect(deaths).toEqual([expect.objectContaining({ gap: true, date: null, unreadable: null })]);
  });

  it('"alive at", "active at" and "attested through" are bounds on life, never a death', () => {
    const f = sidebar('Kamigawa Kaito', {
      'Temporal Scope': 'Born Kusha 17th, 2A 67,189; attested through 5A 900; active at 5A 931',
    });
    expect(f.filter((x) => x.kind === 'death')).toEqual([]);
    expect(f.filter((x) => x.kind === 'attested').map((x) => x.bound)).toEqual(['to', 'both']);
  });

  it('Jamil al-Fajr and Shibata Miyako: "death date unestablished" is an explicit gap, not unreadable', () => {
    for (const [who, fields] of [
      ['Jamil al-Fajr', { 'Life State': 'Deceased; death date unestablished' }],
      [
        'Shibata Miyako',
        { 'Life State': 'Deceased', 'Temporal Scope': 'Born 5A 790; exact death date unestablished' },
      ],
    ] as const) {
      const deaths = sidebar(who, fields).filter((x) => x.kind === 'death');
      expect(deaths, who).toEqual([expect.objectContaining({ gap: true, unreadable: null })]);
    }
  });
});

describe('E: identity values (rule E: the principal value)', () => {
  it('the principal value is what comes before the first qualifier', () => {
    expect(principalValue('Rangawan (current); Falkenreicher (historical name and identity)')).toBe(
      'Rangawan',
    );
    expect(principalValue('None - adopted Old Shenxian mononym; former Mekhbet component unresolved')).toBe(
      'None',
    );
    expect(principalValue('al-Khalid')).toBe('al-Khalid');
  });

  const page = (id: string): PageInfo => ({ id, name: id, path: id, lifecycle: 'Authoritative', area: null });
  const fact = (pageId: string, field: string, valueText: string): StoredFact => ({
    pageId,
    seq: 0,
    kind: 'identity',
    field,
    source: 'sidebar',
    pattern: 'identity',
    subjectKey: 'x',
    subjectText: 'X',
    matchedAs: 'page',
    valueText,
    gap: false,
    date: null,
    unreadable: null,
    bound: null,
    documentId: null,
    blockId: null,
    section: null,
    excerpt: valueText,
    mentions: [],
  });
  const compare = (field: string, a: string, b: string) =>
    compareCharacter({
      cal,
      margin: 5,
      page,
      identityPageId: 'core',
      facts: [fact('core', field, a), fact('bio', field, b)],
      rowRelates: () => false,
    });

  it('must not conflict: Katsuragi Koharu’s Naming Culture and Murket’s Family / Surname', () => {
    expect(
      compare(
        'Naming Culture',
        'Rangawan (current); Falkenreicher (historical name and identity)',
        'Rangawan (current); Falkenreicher (historical identity)',
      ),
    ).toEqual([]);
    expect(
      compare(
        'Family / Surname',
        'None - adopted Old Shenxian mononym; former Mekhbet component unresolved',
        'None - Old Shenxian adopted mononym',
      ),
    ).toEqual([]);
    expect(principalKey('Rangawan (current)')).toBe(principalKey('rangawan'));
  });

  it('must conflict: "Rangawan" against "Falkenreicher" as principal values', () => {
    const d = compare('Naming Culture', 'Rangawan', 'Falkenreicher');
    expect(d).toEqual([expect.objectContaining({ kind: 'identity', label: 'contradictory' })]);
    expect(compare('Naming Culture', 'Rangawan (current)', 'Falkenreicher (current)')[0]?.label).toBe(
      'contradictory',
    );
  });
});

describe('F: non-current sections and rows inside current pages', () => {
  it('the pack’s markers, switched on (the owner’s ruling)', () => {
    expect(rules.nonCurrent).toEqual({ markers: ['Pre-Rewrite', 'Author-Facing'], exclude: true });
    for (const h of [
      'Key Life Transitions - Author-Facing Pre-Rewrite History',
      'Birth, Upbringing and Magical Reputation - Pre-Rewrite',
      'Purpose > Key Life Transitions - Author-Facing Pre-Rewrite History',
      'Purandukht Mithra is born (author-facing pre-rewrite provenance)',
    ])
      expect(isNonCurrent(h, compiled.nonCurrent), h).toBe(true);
    expect(isNonCurrent('Birth and Upbringing', compiled.nonCurrent)).toBe(false);
    expect(isNonCurrent('Rewrites of the Charter', compiled.nonCurrent)).toBe(false);
  });

  it('Purandukht Mithra: the Core’s "Author-Facing Pre-Rewrite History" is marked; the Biography’s current section is not', () => {
    const core = onPage(
      'Yue Bailu',
      'Purandukht Mithra was born in 2A 748,455.',
      'Key Life Transitions - Author-Facing Pre-Rewrite History',
    );
    expect(core).toEqual([expect.objectContaining({ valueText: '2A 748,455', nonCurrent: true })]);
    const bio = onPage(
      'Yue Bailu',
      'Purandukht Mithra was born on Zarzakh 17th, 2A 748,455, in the winter palace…',
      'Birth and Upbringing',
    );
    expect(bio).toEqual([expect.objectContaining({ valueText: 'Zarzakh 17th, 2A 748,455' })]);
    expect(bio[0]!.nonCurrent).toBeUndefined();
    // Had the Biography's sentence stood under "Birth, Upbringing and Magical Reputation - Pre-Rewrite", it would be
    // marked too: which section it is in on Arkona is for the owner to check.
    expect(
      onPage(
        'Yue Bailu',
        'Purandukht Mithra was born on Zarzakh 17th, 2A 748,455.',
        'Birth, Upbringing and Magical Reputation - Pre-Rewrite',
      )[0]!.nonCurrent,
    ).toBe(true);
  });

  it('a chronology row "(author-facing pre-rewrite provenance)" is marked', () => {
    const f = extractRowFacts(
      [
        {
          pageId: 'chron',
          documentId: 'age',
          rowId: 'p1',
          event: 'Purandukht Mithra is born (author-facing pre-rewrite provenance)',
          date: '2A 748,300',
          mentions: [],
        },
      ],
      ctx,
    );
    expect(f).toEqual([expect.objectContaining({ nonCurrent: true, valueText: '2A 748,300' })]);
  });

  it('switched off, nothing is marked (nothing changes)', () => {
    const off = compilePatterns({
      ...rules,
      nonCurrent: { markers: rules.nonCurrent!.markers, exclude: false },
    });
    // Marking follows the markers; leaving out and labelling follow the switch (src/consistency/service.ts, compare.ts).
    expect(off.nonCurrent).toEqual(['pre rewrite', 'author facing']);
    const none = compilePatterns({ ...rules, nonCurrent: undefined });
    expect(none.nonCurrent).toBeNull();
    expect(isNonCurrent('Author-Facing Pre-Rewrite History', none.nonCurrent)).toBe(false);
  });
});
