/**
 * v3 F4b (ADR 0064; design D3, D4): the comparison, pure, on hand-made facts dated with Arkona's own calendar: a day and
 * its year agree; spans that do not overlap conflict; "c." at the margin's edge, both sides of it; "Unestablished" is a
 * gap; Working against Authoritative is "Proposal differs from canon" (info); Archived (when asked for) is historical;
 * identity facts compared normalised (East Asian order included); the attested bounds never compared.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCalendar } from '../../src/calendar/index.js';
import { compareCharacter, LABEL_SEVERITY, type PageInfo } from '../../src/consistency/compare.js';
import { readLeading } from '../../src/consistency/dates.js';
import type { StoredFact } from '../../src/consistency/facts-index.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as {
  calendar: unknown;
};
const cal = createCalendar(ORACLE.calendar);

const PAGES: Record<string, PageInfo> = {
  core: {
    id: 'core',
    name: '[BSRC] Yasmin al-Naim - Character Core',
    path: 'C / Yasmin',
    lifecycle: 'Authoritative',
    area: null,
  },
  bio: {
    id: 'bio',
    name: '[BSRC] Yasmin al-Naim - Biography',
    path: 'C / Yasmin / Bio',
    lifecycle: 'Authoritative',
    area: null,
  },
  draft: { id: 'draft', name: '[BWRK] Draft', path: 'Working / Draft', lifecycle: 'Working', area: null },
  old: { id: 'old', name: '[BARC] Old', path: 'Archived / Old', lifecycle: 'Archived', area: null },
};
let seq = 0;
function fact(pageId: string, value: string, o: Partial<StoredFact> = {}): StoredFact {
  const r = readLeading(cal, value);
  return {
    pageId,
    seq: seq++,
    kind: 'birth',
    field: null,
    source: pageId === 'core' ? 'temporalScope' : 'prose',
    pattern: pageId === 'core' ? 'birth.scope' : 'birth.prose',
    subjectKey: 'yasmin al naim',
    subjectText: 'Yasmin al-Naim',
    matchedAs: pageId === 'core' ? 'page' : 'name',
    valueText: value,
    gap: false,
    date: r.ok ? r.reading : null,
    unreadable: r.ok ? null : r.reason,
    bound: null,
    documentId: pageId === 'core' ? null : `${pageId}doc`,
    blockId: `${pageId}blk`,
    section: null,
    excerpt: value,
    mentions: [],
    ...o,
  };
}
const compare = (facts: StoredFact[]) =>
  compareCharacter({
    cal,
    margin: 5,
    page: (id) => PAGES[id]!,
    identityPageId: 'core',
    facts,
    rowRelates: () => false,
  });

describe('dates conflict only when their spans do not overlap (D3)', () => {
  it('a day and its year agree', () => {
    expect(compare([fact('core', 'Camue 1st, 4A 100'), fact('bio', '4A 100')])).toEqual([]);
    expect(compare([fact('core', '4A 100'), fact('bio', 'Camue 1st, 4A 100')])).toEqual([]);
  });

  it('spans that do not overlap conflict: Camue 1st, 4A 100 against 4A 103', () => {
    const d = compare([fact('core', 'Camue 1st, 4A 100'), fact('bio', '4A 103')]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      kind: 'birth',
      label: 'contradictory',
      reference: { value: 'Camue 1st, 4A 100', page: { id: 'core' } },
    });
    expect(d[0]!.restatements.map((r) => r.value)).toEqual(['4A 103']);
    expect(LABEL_SEVERITY.contradictory).toBe('warning');
  });

  it('"c." at the margin’s edge, both sides of it (±5 years by default)', () => {
    expect(compare([fact('core', 'c. 4A 640'), fact('bio', '4A 645')])).toEqual([]);
    expect(compare([fact('core', 'c. 4A 640'), fact('bio', '4A 635')])).toEqual([]);
    expect(compare([fact('core', 'c. 4A 640'), fact('bio', '4A 646')])).toHaveLength(1);
    expect(compare([fact('core', 'c. 4A 640'), fact('bio', '4A 634')])).toHaveLength(1);
    // The margin is the pack's setting: with none, the year alone.
    const strict = compareCharacter({
      cal,
      margin: 0,
      page: (id) => PAGES[id]!,
      identityPageId: 'core',
      facts: [fact('core', 'c. 4A 640'), fact('bio', '4A 641')],
      rowRelates: () => false,
    });
    expect(strict).toHaveLength(1);
  });

  it('a range agrees with a date inside it', () => {
    expect(compare([fact('core', 'c. 4A 640–645'), fact('bio', '4A 643')])).toEqual([]);
  });
});

describe('labels (D4)', () => {
  it('"Unestablished" never conflicts: it is a gap (info)', () => {
    const d = compare([
      fact('core', 'birth date unestablished', { gap: true, date: null, unreadable: null }),
      fact('bio', '4A 103'),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ label: 'gap' });
    expect(LABEL_SEVERITY.gap).toBe('info');
  });

  it('Working against Authoritative is "Proposal differs from canon" (info)', () => {
    const d = compare([fact('core', 'Camue 1st, 4A 100'), fact('draft', '4A 110')]);
    expect(d[0]).toMatchObject({ label: 'differs' });
    expect(LABEL_SEVERITY.differs).toBe('info');
  });

  it('Archived material (when it was asked for) is "Historical material differs", never Contradictory', () => {
    expect(compare([fact('core', 'Camue 1st, 4A 100'), fact('old', '4A 120')])[0]).toMatchObject({
      label: 'historical',
    });
  });

  it('each label is its own finding; an unreadable date is listed apart', () => {
    const d = compare([
      fact('core', 'Camue 1st, 4A 100'),
      fact('bio', '4A 103'),
      fact('draft', '4A 110'),
      fact('bio', 'Camue 51st, 4A 360'),
    ]);
    expect(d.map((x) => x.label).sort()).toEqual(['contradictory', 'differs', 'unreadable']);
  });

  it('no value on the identity page: the first Authoritative restatement is shown first, and said', () => {
    const d = compare([fact('bio', '4A 103'), fact('draft', '4A 110')]);
    expect(d[0]).toMatchObject({
      referenceFromRestatement: true,
      reference: { page: { id: 'bio' } },
      label: 'differs',
    });
  });
});

describe('identity facts and attested bounds', () => {
  const identity = (pageId: string, field: string, value: string) =>
    fact(pageId, value, {
      kind: 'identity',
      field,
      source: 'sidebar',
      pattern: 'identity',
      matchedAs: 'page',
      date: null,
      unreadable: null,
      gap: value === 'Unestablished',
    });

  it('compared normalised: case, diacritics and the order of a name’s words', () => {
    expect(
      compare([identity('core', 'Race / Species', 'Human'), identity('bio', 'Race / Species', 'human')]),
    ).toEqual([]);
    expect(
      compare([identity('core', 'Naming Culture', 'Velaran'), identity('bio', 'Naming Culture', 'Vélaran')]),
    ).toEqual([]);
    expect(
      compare([
        identity('core', 'Family / Surname', 'Asagiri Miyabi'),
        identity('bio', 'Family / Surname', 'Miyabi Asagiri'),
      ]),
    ).toEqual([]);
    const d = compare([
      identity('core', 'Race / Species', 'Human'),
      identity('bio', 'Race / Species', 'Elf'),
    ]);
    expect(d[0]).toMatchObject({ kind: 'identity', field: 'Race / Species', label: 'contradictory' });
    expect(
      compare([
        identity('core', 'Family / Surname', 'Unestablished'),
        identity('bio', 'Family / Surname', 'al-Naim'),
      ])[0],
    ).toMatchObject({ label: 'gap' });
  });

  it('attested bounds are never compared (a page’s Temporal Scope may be its source’s time, not a lifespan)', () => {
    const a = (p: string, v: string) => fact(p, v, { kind: 'attested', bound: 'both' });
    expect(compare([a('core', '5A 411'), a('bio', '4A 100')])).toEqual([]);
  });
});
