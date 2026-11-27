/**
 * v3 F6d (ADR 0082, N2): the templated-name statuses, pure.
 */
import { describe, expect, it } from 'vitest';
import {
  countsOf,
  judgeTemplatedNames,
  looseKey,
  rulingHash,
  type NamePage,
  type TemplateVocabulary,
} from '../../src/packs/names/template.js';

const VOCAB: TemplateVocabulary = {
  status: 'published',
  lists: {
    rule: 'A Reference Type names the page’s role.',
    categories: [
      {
        category: 'Polity',
        types: [
          { name: 'Polity Reference', role: 'Polity' },
          { name: 'Polity Constitution Reference', role: 'Constitution' },
        ],
      },
      {
        category: 'Culture',
        types: [
          { name: 'Culture Reference', role: 'Culture' },
          { name: 'Language & Naming Reference', role: 'Language & Naming' },
        ],
      },
      { category: 'Place', types: [{ name: 'Settlement Reference', role: 'Settlement' }] },
      { category: 'Material', types: [{ name: 'Material Reference', role: 'Material' }] },
      { category: 'Species', types: [{ name: 'Race Core Reference', role: 'Race' }] },
    ],
    specialist: [
      { type: 'Arkonan Calendar Reference', category: 'Chronology', pages: null },
      { type: 'Imperial Charter Reference', category: 'Polity', pages: [{ id: 'charter', name: 'Charter' }] },
    ],
  },
};

const page = (o: Partial<NamePage> & { id: string; display: string }): NamePage => ({
  id: o.id,
  rawName: `${o.rawName ?? '[BSRC] '}${o.display}`,
  displayName: o.display,
  parentId: o.parentId ?? 'p1',
  category: o.category === undefined ? 'Polity' : o.category,
  subject: o.subject === undefined ? 'Falkenreich' : o.subject,
  referenceType: o.referenceType === undefined ? 'Polity Reference' : o.referenceType,
  ...(o.subjectAmbiguous ? { subjectAmbiguous: true } : {}),
});

const judge = (
  pages: NamePage[],
  o: {
    siblings?: { id: string; rawName: string }[];
    rulings?: Map<string, string>;
    vocabulary?: TemplateVocabulary | null;
  } = {},
) =>
  judgeTemplatedNames({
    pages,
    vocabulary: o.vocabulary === undefined ? VOCAB : o.vocabulary,
    siblings: () => [...(o.siblings ?? []), ...pages.map((p) => ({ id: p.id, rawName: p.rawName }))],
    ...(o.rulings ? { rulings: o.rulings } : {}),
  });

describe('F6d: the template and its normalisation', () => {
  it('ignores case, accents and an ASCII hyphen versus any dash', () => {
    expect(looseKey('Kharûm Dwarovhum – Settlement')).toBe(looseKey('kharum dwarovhum - settlement'));
    expect(looseKey('A—B')).toBe(looseKey('A-B'));
    expect(looseKey('Mithril  -  Material')).toBe('mithril - material');
  });

  it('gives each example of the brief its role word from the published vocabulary', () => {
    const rows = judge([
      page({ id: 'a', display: 'Falkenreich Polity Reference' }),
      page({ id: 'b', display: 'Falkenreich Constitution', referenceType: 'Polity Constitution Reference' }),
      page({
        id: 'c',
        display: 'Shahravi',
        subject: 'Shahravi',
        category: 'Culture',
        referenceType: 'Culture Reference',
      }),
      page({
        id: 'd',
        display: 'Shahravi Names',
        subject: 'Shahravi',
        category: 'Culture',
        referenceType: 'Language & Naming Reference',
      }),
      page({
        id: 'e',
        display: 'Kharum Dwarovhum',
        subject: 'Kharum Dwarovhum',
        category: 'Place',
        referenceType: 'Settlement Reference',
      }),
      page({
        id: 'f',
        display: 'Mithril',
        subject: 'Mithril',
        category: 'Material',
        referenceType: 'Material Reference',
      }),
      page({
        id: 'g',
        display: 'Foxians Core',
        subject: 'Foxians',
        category: 'Species',
        referenceType: 'Race Core Reference',
      }),
    ]);
    const by = new Map(rows.map((r) => [r.pageId, r]));
    expect(by.get('a')!.proposed).toBe('[BSRC] Falkenreich - Polity');
    expect(by.get('b')!.proposed).toBe('[BSRC] Falkenreich - Constitution');
    expect(by.get('c')!.proposed).toBe('[BSRC] Shahravi - Culture');
    expect(by.get('d')!.proposed).toBe('[BSRC] Shahravi - Language & Naming');
    expect(by.get('e')!.proposed).toBe('[BSRC] Kharum Dwarovhum - Settlement');
    expect(by.get('f')!.proposed).toBe('[BSRC] Mithril - Material');
    expect(by.get('g')!.proposed).toBe('[BSRC] Foxians - Race');
    expect(rows.every((r) => r.status === 'rename')).toBe(true);
  });

  it('keeps the lifecycle prefix as it is', () => {
    const rows = judge([
      page({ id: 'w', rawName: '[BWRK] ', display: 'Falkenreich draft' }),
      page({ id: 'x', rawName: '[BARC] ', display: 'Old Falkenreich', parentId: 'p2' }),
    ]);
    expect(rows.map((r) => r.proposed).sort()).toEqual([
      '[BARC] Falkenreich - Polity',
      '[BWRK] Falkenreich - Polity',
    ]);
  });
});

describe('F6d: every status', () => {
  it('templated: the name already equals the template (case, accents, dash aside)', () => {
    const rows = judge([
      page({ id: 'a', display: 'falkenreich – polity' }),
      page({
        id: 'b',
        display: 'Kharûm - Settlement',
        subject: 'Kharum',
        category: 'Place',
        referenceType: 'Settlement Reference',
      }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['templated', 'templated']);
  });

  it('held_no_subject: empty, missing, twice, or an em dash; a hyphen-minus is fine', () => {
    const rows = judge([
      page({ id: 'a', display: 'A', subject: null }),
      page({ id: 'b', display: 'B', subject: '   ' }),
      page({ id: 'c', display: 'C', subjectAmbiguous: true }),
      page({ id: 'd', display: 'D', subject: 'Falken—reich' }),
      page({ id: 'e', display: 'E', subject: 'Falken-Reich' }),
    ]);
    const by = new Map(rows.map((r) => [r.pageId, r]));
    for (const id of ['a', 'b', 'c', 'd']) expect(by.get(id)!.status).toBe('held_no_subject');
    expect(by.get('d')!.reason).toBe('Subject uses an em dash; fix the Subject first');
    expect(by.get('e')!.status).toBe('rename');
    expect(by.get('e')!.proposed).toBe('[BSRC] Falken-Reich - Polity');
  });

  it('held_type: an unmapped variant, no type, another category’s type', () => {
    const rows = judge([
      page({ id: 'a', display: 'A', referenceType: 'Polity Overview' }),
      page({ id: 'b', display: 'B', referenceType: null }),
      page({ id: 'c', display: 'C', referenceType: 'Culture Reference' }),
    ]);
    expect(rows.every((r) => r.status === 'held_type')).toBe(true);
    expect(rows.find((r) => r.pageId === 'a')!.reason).toMatch(/reference_type_noncanonical/);
  });

  it('a draft vocabulary: no templates, every row held_type “the vocabulary is not published”', () => {
    const rows = judge(
      [page({ id: 'a', display: 'A' }), page({ id: 'b', display: 'Falkenreich - Polity' })],
      {
        vocabulary: { ...VOCAB, status: 'draft' },
      },
    );
    expect(rows.map((r) => [r.status, r.reason, r.proposed])).toEqual([
      ['held_type', 'the vocabulary is not published', null],
      ['held_type', 'the vocabulary is not published', null],
    ]);
  });

  it('exempt_specialist: a category-wide type and a type for named pages only', () => {
    const rows = judge([
      page({
        id: 'cal',
        display: 'The Calendar',
        category: 'Chronology',
        referenceType: 'Arkonan Calendar Reference',
      }),
      page({ id: 'charter', display: 'Charter', referenceType: 'Imperial Charter Reference' }),
      page({ id: 'other', display: 'Other Charter', referenceType: 'Imperial Charter Reference' }),
    ]);
    const by = new Map(rows.map((r) => [r.pageId, r]));
    expect(by.get('cal')!.status).toBe('exempt_specialist');
    expect(by.get('charter')!.status).toBe('exempt_specialist');
    // Not one of the named pages: not exempt, and the type is not canonical either.
    expect(by.get('other')!.status).toBe('held_type');
  });

  it('kept: the owner’s ruling holds while the Subject, the type and the name are unchanged, and lapses after', () => {
    const p = page({ id: 'a', display: 'Falkenreich Polity Reference' });
    const rulings = new Map([['a', rulingHash(p)]]);
    expect(judge([p], { rulings })[0]!.status).toBe('kept');
    const changed = { ...p, subject: 'Falkenreichen' };
    const again = judge([changed], { rulings })[0]!;
    expect(again.status).toBe('rename');
    expect(again.proposed).toBe('[BSRC] Falkenreichen - Polity');
    expect(judge([{ ...p, referenceType: 'Polity Constitution Reference' }], { rulings })[0]!.status).toBe(
      'rename',
    );
  });
});

describe('F6d: collisions', () => {
  it('a sibling holds the name already', () => {
    const rows = judge([page({ id: 'a', display: 'Falkenreich Polity Reference' })], {
      siblings: [{ id: 's', rawName: '[BSRC] Falkenreich – Polity' }],
    });
    expect(rows[0]!.status).toBe('held_collision');
    expect(rows[0]!.other).toEqual({ id: 's', name: '[BSRC] Falkenreich – Polity' });
  });

  it('two renames to one full name under one parent: both held, each naming the other', () => {
    const rows = judge([
      page({ id: 'a', display: 'Falkenreich Polity Reference' }),
      page({ id: 'b', display: 'Falkenreich Overview' }),
      page({ id: 'c', display: 'Falkenreich elsewhere', parentId: 'p9' }),
      page({ id: 'd', rawName: '[BWRK] ', display: 'Falkenreich Working' }),
    ]);
    const by = new Map(rows.map((r) => [r.pageId, r]));
    expect(by.get('a')!.status).toBe('held_collision');
    expect(by.get('a')!.reason).toContain('[BSRC] Falkenreich Overview');
    expect(by.get('b')!.status).toBe('held_collision');
    expect(by.get('b')!.reason).toContain('[BSRC] Falkenreich Polity Reference');
    // Another parent, or another prefix (the full name differs): free.
    expect(by.get('c')!.status).toBe('rename');
    expect(by.get('d')!.status).toBe('rename');
  });
});

describe('F6d: order and counts', () => {
  it('orders by primary category, then name; counts every status', () => {
    const rows = judge([
      page({ id: 'z', display: 'Zed', subject: 'Zed', category: 'Polity' }),
      page({
        id: 'm',
        display: 'Mithril',
        subject: 'Mithril',
        category: 'Material',
        referenceType: 'Material Reference',
      }),
      page({ id: 'a', display: 'Aard', subject: 'Aard', category: 'Polity' }),
    ]);
    expect(rows.map((r) => r.pageId)).toEqual(['m', 'a', 'z']);
    const c = countsOf(rows);
    expect(c.rename).toBe(3);
    expect(c.kept).toBe(0);
  });
});
