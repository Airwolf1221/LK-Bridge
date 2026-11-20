/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.stringMatching */
/**
 * v3 F4b (ADR 0064; design D1, D2): the fact extractor, pure, with the pack's seeded phrasings and Arkona's own calendar
 * (the oracle's): each seeded phrasing; a birth stated by an alias (a birth name); a pronoun-only sentence never read; an
 * unreadable date reported as unreadable; precision kept (a day, a year, "c.", a range).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../src/calendar/index.js';
import {
  compilePatterns,
  extractPageFacts,
  extractRowFacts,
  resolveName,
  type NameIndex,
  type Unit,
} from '../../src/consistency/extract.js';
import { nameKeyOf } from '../../src/packs/naming/namesakes.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as {
  calendar: unknown;
};
const cal = createCalendar(ORACLE.calendar);
const rules = ARKONA_PACK.rules.consistency!;
const compiled = compilePatterns(rules);
const known = new Map<string, 'name' | 'given'>([
  [nameKeyOf('Rashad al-Khalid'), 'name'],
  [nameKeyOf('Yasmin al-Naim'), 'name'],
  [nameKeyOf('Yasmin'), 'given'],
  [nameKeyOf('Katsuragi Yamato'), 'name'],
  [nameKeyOf('Rita von Katzen'), 'name'],
  [nameKeyOf('Cornelia von Katzen'), 'name'],
  [nameKeyOf('Karim al-Naim'), 'name'],
]);
const names: NameIndex = { lookup: (k) => known.get(k) ?? null };
const ctx = { compiled, names, cal, style: DEFAULT_DATE_STYLE };

const scope = (subject: string, temporal: string, extra: Unit[] = []): Unit[] => [
  {
    unit: 'name',
    text: `${subject} - Character Core`,
    documentId: null,
    blockId: null,
    field: null,
    section: null,
  },
  {
    unit: 'fact',
    text: subject,
    documentId: null,
    blockId: 'r1',
    field: 'Subject',
    section: 'sidebar: PROPERTIES',
  },
  {
    unit: 'fact',
    text: temporal,
    documentId: null,
    blockId: 'r2',
    field: 'Temporal Scope',
    section: 'sidebar: PROPERTIES',
  },
  ...extra,
];
const text = (t: string, blockId = 'b1'): Unit => ({
  unit: 'text',
  text: t,
  documentId: 'doc1',
  blockId,
  field: null,
  section: 'Purpose',
});
const prose = (...t: string[]) =>
  extractPageFacts(
    'p1',
    [
      {
        unit: 'name',
        text: 'Velara - Polity Reference',
        documentId: null,
        blockId: null,
        field: null,
        section: null,
      },
      ...t.map((x, i) => text(x, `b${i}`)),
    ],
    ctx,
  ).facts;

describe('the seeded phrasings (pack data, D2)', () => {
  it('are pack data: each has its source, and every one compiles', () => {
    expect(compiled.problems).toEqual([]);
    const sources = new Set(rules.patterns.map((p) => p.source));
    expect([...sources].sort()).toEqual(['chronology', 'lifeState', 'prose', 'temporalScope']);
    expect(rules.present).toBe('5A 931');
    expect(rules.approxMargin).toBe(5);
  });

  it('Temporal Scope: "Born Camue 44th, 4A 360; alive and immortal in Fifth-Age present 5A 931"', () => {
    const { facts, meta } = extractPageFacts(
      'rashad',
      scope('Rashad al-Khalid', 'Born Camue 44th, 4A 360; alive and immortal in Fifth-Age present 5A 931'),
      ctx,
    );
    expect(meta.subject).toBe('Rashad al-Khalid');
    const birth = facts.find((f) => f.pattern === 'birth.scope')!;
    expect(birth).toMatchObject({
      kind: 'birth',
      source: 'temporalScope',
      valueText: 'Camue 44th, 4A 360',
      matchedAs: 'page',
    });
    expect(birth.date).toMatchObject({ precision: 'day', shape: 'day', approximate: false });
    const alive = facts.find((f) => f.pattern === 'attested.scope.alive')!;
    expect(alive).toMatchObject({ kind: 'attested', valueText: '5A 931', bound: 'both' });
    expect(alive.date).toMatchObject({ precision: 'year' });
  });

  it('Temporal Scope: "Born 2A 73,511; attested through 5A 931" (a year with a thousands comma; a bound)', () => {
    const { facts } = extractPageFacts(
      'soraya',
      scope('Soraya bint al-Noor', 'Born 2A 73,511; attested through 5A 931'),
      ctx,
    );
    expect(facts.find((f) => f.pattern === 'birth.scope')).toMatchObject({
      valueText: '2A 73,511',
      date: { precision: 'year' },
    });
    expect(facts.find((f) => f.pattern === 'attested.scope.through')).toMatchObject({
      valueText: '5A 931',
      bound: 'to',
    });
    expect(facts.find((f) => f.pattern === 'attested.scope.span')).toBeUndefined();
  });

  it('Temporal Scope: "Born Sarias 28th, 1A 51,743; succession …; active at…" ("active at…" holds nothing date-shaped: no fact)', () => {
    const { facts } = extractPageFacts(
      'titania',
      scope('Titania', 'Born Sarias 28th, 1A 51,743; succession Redfall 1st, 1A 62,313; active at…'),
      ctx,
    );
    expect(facts.find((f) => f.pattern === 'birth.scope')).toMatchObject({
      valueText: 'Sarias 28th, 1A 51,743',
      date: { precision: 'day' },
    });
    // "succession …" matches no phrasing: never read.
    expect(facts.filter((f) => f.valueText.includes('Redfall'))).toEqual([]);
    // ADR 0064 amendment 1 (rule B): "unreadable" is kept for a date-shaped text the calendar refuses; "active at…"
    // holds none, so it is no fact at all.
    expect(facts.find((f) => f.pattern === 'attested.scope.alive')).toBeUndefined();
  });

  it('Temporal Scope: "Attested 5A 411–5A 931; birth date unestablished" (a range, and a deliberate gap)', () => {
    const { facts } = extractPageFacts(
      'haru',
      scope('Kamigawa Haru', 'Attested 5A 411–5A 931; birth date unestablished'),
      ctx,
    );
    expect(facts.find((f) => f.pattern === 'attested.scope.span')).toMatchObject({
      valueText: '5A 411–5A 931',
      date: { shape: 'range', precision: 'year' },
      bound: 'both',
    });
    expect(facts.find((f) => f.pattern === 'birth.scope.gap')).toMatchObject({
      kind: 'birth',
      gap: true,
      date: null,
      unreadable: null,
    });
  });

  it('Temporal Scope: "Died …", and a Life State of "Deceased" with a date', () => {
    const { facts } = extractPageFacts(
      'harun',
      scope('Harun al-Saffar', 'Born 4A 300; died Camue 3rd, 4A 400', [
        {
          unit: 'fact',
          text: 'Deceased Camue 3rd, 4A 400',
          documentId: null,
          blockId: 'r3',
          field: 'Life State',
          section: 'sidebar: PROPERTIES',
        },
      ]),
      ctx,
    );
    expect(facts.find((f) => f.pattern === 'death.scope')).toMatchObject({
      kind: 'death',
      valueText: 'Camue 3rd, 4A 400',
    });
    expect(facts.find((f) => f.pattern === 'death.lifestate')).toMatchObject({
      kind: 'death',
      source: 'lifeState',
      valueText: 'Camue 3rd, 4A 400',
    });
  });

  it('prose: "<name> was born on <date>" and "<name> died in <date>"', () => {
    const f = prose(
      'Rashad al-Khalid was born on Camue 44th, 4A 360 in the citadel.',
      'Karim al-Naim died in 4A 470.',
    );
    expect(f.find((x) => x.pattern === 'birth.prose')).toMatchObject({
      subjectText: 'Rashad al-Khalid',
      matchedAs: 'name',
      valueText: 'Camue 44th, 4A 360',
    });
    expect(f.find((x) => x.pattern === 'death.prose')).toMatchObject({
      subjectText: 'Karim al-Naim',
      valueText: '4A 470',
      kind: 'death',
    });
  });

  it('prose: a dated line, "Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von Katzen is born in…"', () => {
    const f = prose('Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von Katzen is born in the palace.');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      pattern: 'birth.prose.dated',
      subjectText: 'Cornelia von Katzen',
      valueText: 'Azah 19th, 4A 51',
      date: { precision: 'day' },
    });
  });

  it('a chronology row: the kind and subject from the event, the date from the Date cell (…al-Naim, is born in 4A 401)', () => {
    const rows = extractRowFacts(
      [
        {
          pageId: 'chron',
          documentId: 't4',
          rowId: 'r1',
          event: 'Yasmin al-Naim, daughter of Karim al-Naim, is born in the old quarter',
          date: '4A 401',
          mentions: [],
        },
        {
          pageId: 'chron',
          documentId: 't4',
          rowId: 'r2',
          event: 'The harbour wall is finished',
          date: '4A 402',
          mentions: [],
        },
        {
          pageId: 'chron',
          documentId: 't4',
          rowId: 'r3',
          event: 'A daughter is born',
          date: 'c. 4A 563; exact date unresolved',
          mentions: ['corebody'],
        },
        {
          pageId: 'chron',
          documentId: 't4',
          rowId: 'r4',
          event: 'Amira of the Reeds is born',
          date: 'c. 4A 563; exact date unresolved',
          mentions: ['corebody'],
          subjects: [{ resourceId: 'corebody', text: 'Amira of the Reeds' }],
        },
      ],
      ctx,
    );
    // The appositive's name is never taken for the subject: it is Yasmin, not Karim.
    expect(rows[0]).toMatchObject({
      source: 'chronology',
      kind: 'birth',
      subjectText: 'Yasmin al-Naim',
      valueText: '4A 401',
      blockId: 'r1',
    });
    // ADR 0064 amendment 1 (rule A): "A daughter is born" names nobody, so the row is not attributed, even with one
    // mention. A mention whose text IS the name governing the verb is its page's (resolved to its character where facts
    // are compared); the cell read by its anchor.
    expect(rows.find((r) => r.blockId === 'r3')).toBeUndefined();
    expect(rows[1]).toMatchObject({
      blockId: 'r4',
      subjectKey: 'page:corebody',
      matchedAs: 'mention',
      date: { approximate: true, precision: 'year' },
    });
    expect(rows).toHaveLength(2);
  });
});

describe('who it is about, and dates (D2)', () => {
  it('a birth stated by an alias (a birth name): "Rita von Katzen was born in 4A 305" names Katsuragi Yamato’s alias', () => {
    const f = prose('Rita von Katzen was born in 4A 305, in the river quarter.');
    expect(f[0]).toMatchObject({
      subjectKey: nameKeyOf('Rita von Katzen'),
      matchedAs: 'name',
      valueText: '4A 305',
    });
  });

  it('a pronoun-only sentence is never read', () => {
    expect(prose('She was born in 4A 90.', 'He died in 4A 400.', 'They were born in 4A 100.')).toEqual([]);
    expect(resolveName('She', names)).toBeNull();
  });

  it('a given name alone is read as such (counted only on the character’s own pages, where facts are compared)', () => {
    expect(prose('Yasmin was born on Camue 1st, 4A 103.')[0]).toMatchObject({
      matchedAs: 'given',
      subjectText: 'Yasmin',
    });
    expect(prose('In 4A 100, Yasmin al-Naim was born in 4A 100.')[0]).toMatchObject({
      subjectText: 'Yasmin al-Naim',
    });
  });

  it('an unreadable date is reported as unreadable, with the calendar’s reason, never guessed', () => {
    const f = prose('Rashad al-Khalid was born on Camue 51st, 4A 360, the tale says.');
    expect(f[0]!.date).toBeNull();
    expect(f[0]!.unreadable).toMatch(/Camue 51st/);
    expect(f[0]!.valueText).toMatch(/^Camue 51st/);
  });

  it('precision is kept: a day, a month, a year, "c." and a range', () => {
    const at = (t: string) => prose(`Yasmin al-Naim was born in ${t}.`)[0]!.date!;
    expect(at('Camue 1st, 4A 100')).toMatchObject({ precision: 'day', shape: 'day', approximate: false });
    expect(at('Isar 4A 566')).toMatchObject({ precision: 'month', shape: 'month' });
    expect(at('4A 100')).toMatchObject({ precision: 'year', shape: 'year' });
    expect(at('c. 4A 640')).toMatchObject({ precision: 'year', approximate: true });
    expect(at('c. 4A 640–645')).toMatchObject({ shape: 'range', approximate: true, text: 'c. 4A 640–645' });
  });

  it('without a calendar, a date is unreadable (said), never guessed', () => {
    const f = extractPageFacts('p', [text('Yasmin al-Naim was born in 4A 100.')], {
      ...ctx,
      cal: null,
    }).facts;
    expect(f[0]).toMatchObject({
      date: null,
      unreadable: expect.stringMatching(/calendar is not available/),
    });
  });
});
