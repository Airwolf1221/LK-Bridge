/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect matchers */
/**
 * v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H1 and H3), the retag engine, pure, on
 * the Arkona seed's rules:
 *
 * - H1: the Tagging Standard's "Approved Supplementary Tags" (Cosmology, Chronology, Setting Framework) are permitted
 *   wherever they appear: kept after the grammar's slots, never added, never proposed for removal. The seven pages of the
 *   live audit of 23 November 2026 (run rtg_a461df416ac3ce1b) become corrections, with exactly the owner's arrays.
 * - H3: every correction is in full grammar order (status, primary, specialist, race, culture, then the supplementary
 *   tags in their existing order); a page that needs only reordering is a correction like any other.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { retagPage, tagsHashOf, type RetagPageInput } from '../../src/packs/retag/engine.js';
import { packRulesSchema, type PackRules } from '../../src/packs/types.js';
import { CTX, page } from './retag-engine.test.js';

const RULES: PackRules = ARKONA_PACK.rules;
const owner = (primary: string, specialist: string | null = null) => ({
  primary,
  specialist,
  detail: 'the owner, 2026-11-22: classified on the Tagging page',
});

/** The seven pages, their current arrays, the owner's classifications of 22 November, and the arrays expected. */
export const SEVEN: readonly {
  name: string;
  current: string[];
  primary: string;
  specialist: string | null;
  proposed: string[];
}[] = [
  {
    name: '[BSRC] Arkona - Geography & Contemporary World State',
    current: ['CANON', 'Setting Framework'],
    primary: 'Place',
    specialist: 'Continent',
    proposed: ['CANON', 'Place', 'Continent', 'Setting Framework'],
  },
  {
    name: '[BSRC] Arkona - Physical Foundations',
    current: ['CANON', 'Cosmology'],
    primary: 'Place',
    specialist: null,
    proposed: ['CANON', 'Place', 'Cosmology'],
  },
  {
    name: '[BSRC] Cosmology & Elysaria System',
    current: ['CANON', 'Cosmology'],
    primary: 'Law',
    specialist: null,
    proposed: ['CANON', 'Law', 'Cosmology'],
  },
  {
    name: '[BSRC] Divine Realms - Structure & Realm Overview',
    current: ['CANON', 'Cosmology'],
    primary: 'Law',
    specialist: null,
    proposed: ['CANON', 'Law', 'Cosmology'],
  },
  {
    name: '[BSRC] Shenxian Political Ages',
    current: ['CANON', 'Chronology'],
    primary: 'Event',
    specialist: null,
    proposed: ['CANON', 'Event', 'Chronology'],
  },
  {
    name: '[BSRC] Universal Chronology',
    current: ['CANON', 'Chronology'],
    primary: 'Event',
    specialist: null,
    proposed: ['CANON', 'Event', 'Chronology'],
  },
  {
    name: '[BSRC] Voidal Threats & Divine Defences',
    current: ['CANON', 'Setting Framework'],
    primary: 'Law',
    specialist: null,
    proposed: ['CANON', 'Law', 'Setting Framework'],
  },
];

const sevenPage = (s: (typeof SEVEN)[number], i: number): RetagPageInput =>
  page({ id: `seven00${i}`, rawName: s.name, tags: s.current, owner: owner(s.primary, s.specialist) });

/** The same rules without the supplementary list (as the pack before F5a). */
const withoutSupplementary = (): PackRules =>
  packRulesSchema.parse({ ...RULES, retag: { ...RULES.retag!, supplementary: undefined } });

describe('H1: the seed lists the Approved Supplementary Tags', () => {
  it('as the Tagging Standard states them on 23 November 2026, and pins the section', () => {
<<<<<<< HEAD
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-26-f12'); // v3 F12 (ADR 0081): -f12 supersedes -f6c
=======
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-28-f5b1'); // v3 F5b.1 (ADR 0068 amendment 1): -f5b1 supersedes -f6c
>>>>>>> origin/main
    expect(RULES.retag?.supplementary).toEqual({
      source: 'tagging-standard',
      section: 'Approved Supplementary Tags',
      tags: ['Cosmology', 'Chronology', 'Setting Framework'],
    });
    expect(ARKONA_PACK.governance.find((g) => g.key === 'tagging-standard')!.sections).toContain(
      'Approved Supplementary Tags',
    );
    // Never merged with the opposite list.
    expect(RULES.retag?.excludedRoutineTags).toEqual([]);
  });
});

describe('H1: the seven pages of the live audit', () => {
  it('were exceptions before (the extra tag blocked the owner’s classification)', () => {
    const ctx = { ...CTX, rules: withoutSupplementary() };
    for (const [i, s] of SEVEN.entries()) {
      const v = retagPage(sevenPage(s, i), ctx);
      expect(v.disposition, s.name).toBe('exception');
    }
  });

  it('all seven become corrections, with exactly the owner’s arrays', () => {
    for (const [i, s] of SEVEN.entries()) {
      const v = retagPage(sevenPage(s, i), CTX);
      expect(v.disposition, s.name).toBe('correction');
      expect(v.proposed, s.name).toEqual(s.proposed);
      expect(v.exceptions).toEqual([]);
      expect(v.holds).toEqual([]);
      expect(v.removals).toEqual([]);
      expect(v.slots.find((x) => x.slot === 'supplementary')).toMatchObject({
        tag: s.current[1],
        source: expect.stringMatching(/an Approved Supplementary Tag \(the Tagging Standard\)/),
      });
    }
  });
});

describe('H1: a supplementary tag is never added and never proposed for removal', () => {
  it('a page without one gets none (never added by inference)', () => {
    const v = retagPage(page({ tags: ['CANON'], owner: owner('Law') }), CTX);
    expect(v.proposed).toEqual(['CANON', 'Law']);
    expect(v.proposed).not.toContain('Cosmology');
  });

  it('never removed: not as incidental, not as a held slot’s token, not when duplicated (kept once)', () => {
    const dup = retagPage(
      page({ tags: ['CANON', 'Cosmology', 'Law', 'cosmology'], owner: owner('Law') }),
      CTX,
    );
    expect(dup.proposed).toEqual(['CANON', 'Law', 'Cosmology']);
    expect(dup.removals).toEqual([{ tag: 'cosmology', why: 'a duplicate (the same tag twice)' }]);
    // A held page keeps its supplementary tag in the array it shows.
    const held = retagPage(page({ tags: ['CANON', 'Chronology'] }), CTX);
    expect(held.disposition).toBe('hold');
    expect(held.proposed).toContain('Chronology');
    expect(held.removals.map((r) => r.tag)).not.toContain('Chronology');
  });

  it('a page whose only exception was such a tag and is otherwise right is compliant', () => {
    const v = retagPage(page({ tags: ['CANON', 'Law', 'Cosmology'], owner: owner('Law') }), CTX);
    expect(v.disposition).toBe('compliant');
  });
});

describe('H1: the Excluded Routine Tags behave as before', () => {
  it('a listed routine tag is still a deterministic removal; another tag still an exception', () => {
    const rules = packRulesSchema.parse({
      ...RULES,
      retag: { ...RULES.retag!, excludedRoutineTags: ['Lore'] },
    });
    const v = retagPage(page({ tags: ['CANON', 'Law', 'Lore', 'Cosmology'], owner: owner('Law') }), {
      ...CTX,
      rules,
    });
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Law', 'Cosmology']);
    expect(v.removals).toEqual([
      { tag: 'Lore', why: 'listed in the Tagging Standard’s Excluded Routine Tags' },
    ]);
    const ex = retagPage(page({ tags: ['CANON', 'Law', 'Imported'], owner: owner('Law') }), {
      ...CTX,
      rules,
    });
    expect(ex.disposition).toBe('exception');
  });

  it('a tag on both lists is never removed: the owner’s exception', () => {
    const rules = packRulesSchema.parse({
      ...RULES,
      retag: { ...RULES.retag!, excludedRoutineTags: ['Cosmology'] },
    });
    const v = retagPage(page({ tags: ['CANON', 'Law', 'Cosmology'], owner: owner('Law') }), {
      ...CTX,
      rules,
    });
    expect(v.disposition).toBe('exception');
    expect(v.proposed).toContain('Cosmology');
    expect(v.exceptions[0]!.reason).toMatch(
      /both in the Tagging Standard’s Approved Supplementary Tags and in its Excluded Routine Tags/,
    );
  });
});

describe('H2 (engine): "Keep this tag here"', () => {
  it('keeps the tag on that page alone while its array is unchanged, and lapses when it changes', () => {
    const tags = ['CANON', 'Law', 'Imported'];
    const ruling = { tag: 'Imported', tagsHash: tagsHashOf(tags), detail: 'owner, 2026-11-23: kept' };
    const kept = retagPage({ ...page({ tags, owner: owner('Law') }), rulings: [ruling] }, CTX);
    expect(kept.disposition).toBe('compliant');
    expect(kept.slots.find((s) => s.slot === 'supplementary')!.source).toMatch(
      /kept on this page by the owner’s ruling/,
    );
    // Another page with the same tag: still an exception (the ruling is for one page).
    expect(retagPage(page({ id: 'other', tags, owner: owner('Law') }), CTX).disposition).toBe('exception');
    // The array changed: lapsed, the exception is back and says why.
    const lapsed = retagPage(
      { ...page({ tags: ['CANON', 'Imported', 'Law'], owner: owner('Law') }), rulings: [ruling] },
      CTX,
    );
    expect(lapsed.disposition).toBe('exception');
    expect(lapsed.exceptions[0]!.reason).toMatch(/lapsed when the page’s tags changed/);
  });
});

describe('H3: ordering in apply', () => {
  const genie = packRulesSchema.parse({
    ...RULES,
    tags: {
      ...RULES.tags,
      race: { ...RULES.tags.race, Genie: 'Genie' },
      culture: { ...RULES.tags.culture, Khayali: 'Khayali' },
    },
  });
  const zahira = (tags: string[]) =>
    page({
      rawName: '[BSRC] Zahira al-Rachid - Character Core',
      tags,
      facts: { 'Reference Type': 'Character Core', 'Race / Species': 'Genie', 'Naming Culture': 'Khayali' },
    });

  it('a page whose tags are right but in the wrong order (…, Khayali, Genie) is one correction: …, Genie, Khayali', () => {
    const v = retagPage(zahira(['CANON', 'Character', 'Khayali', 'Genie']), { ...CTX, rules: genie });
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Genie', 'Khayali']);
    expect(v.removals).toEqual([]);
    // Already in order: compliant (no separate reordering proposal is ever needed).
    expect(
      retagPage(zahira(['CANON', 'Character', 'Genie', 'Khayali']), { ...CTX, rules: genie }).disposition,
    ).toBe('compliant');
  });

  it('mixed corrections come out in grammar order, the supplementary tags last in their existing order', () => {
    const v = retagPage(
      zahira(['Setting Framework', 'Khayali', 'Chronology', 'CANON', 'Genie', 'Character']),
      { ...CTX, rules: genie },
    );
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Genie', 'Khayali', 'Setting Framework', 'Chronology']);
    const law = retagPage(page({ tags: ['Cosmology', 'Law', 'CANON'], owner: owner('Law') }), CTX);
    expect(law.proposed).toEqual(['CANON', 'Law', 'Cosmology']);
    const place = retagPage(
      page({ tags: ['Setting Framework', 'Continent', 'CANON'], owner: owner('Place', 'Continent') }),
      CTX,
    );
    expect(place.proposed).toEqual(['CANON', 'Place', 'Continent', 'Setting Framework']);
  });
});
