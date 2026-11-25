/**
 * v3 F6a (ADR 0076; design T2): the suggestion rules, with real values from the design's table (live Arkona, 23 November
 * 2026), and the published section's exact text, its parsing and its writing into a document.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { suggest } from '../../src/packs/reftypes/suggest.js';
import {
  INTRO_SPECIALIST,
  INTRO_TYPES,
  parseSection,
  renderSection,
  sameVocabulary,
  sectionLines,
  spliceSection,
  type VocabularyLists,
} from '../../src/packs/reftypes/vocabulary.js';
import { packRulesSchema } from '../../src/packs/types.js';

const RT = ARKONA_PACK.rules.referenceTypes!;
const V: VocabularyLists = { rule: RT.rule, categories: RT.categories, specialist: RT.specialist };
const N = RT.normalise;
const s = (value: string, category: string | null, v: VocabularyLists = V) => suggest(value, category, v, N);

describe('the draft vocabulary in the seed', () => {
  it('is a draft, pinned on Source Formatting, with role words', () => {
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-25-f6b');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-23-f7b');
    expect(RT.status).toBe('draft');
    expect(RT.source).toBe('source-formatting');
    expect(RT.under).toBe('Sidebar Metadata');
    expect(ARKONA_PACK.governance.find((g) => g.key === 'source-formatting')?.sections).toContain(
      'Reference Type Vocabulary',
    );
    const role = (name: string) => RT.categories.flatMap((c) => c.types).find((t) => t.name === name)?.role;
    expect(role('Polity Reference')).toBe('Polity');
    expect(role('Polity Constitution Reference')).toBe('Constitution');
    expect(role('Language & Naming Reference')).toBe('Language & Naming');
    expect(role('Race Core Reference')).toBe('Race');
  });

  it('holds the pack’s own character Reference Types as they stand', () => {
    const character = RT.categories.find((c) => c.category === 'Character')!.types.map((t) => t.name);
    const type = ARKONA_PACK.rules.types.find((t) => t.name === 'Character')!;
    for (const r of type.roles) if (r.referenceType) expect(character).toContain(r.referenceType);
    for (const v of Object.values(type.suggestedReferenceTypes)) expect(character).toContain(v);
  });

  it('refuses a name the section could not write back', () => {
    const bad = structuredClone(ARKONA_PACK.rules) as Record<string, unknown> & { referenceTypes: typeof RT };
    bad.referenceTypes.categories[1]!.types.push({ name: 'Polity (Old) Reference', role: 'Polity' });
    expect(packRulesSchema.safeParse(bad).success).toBe(false);
  });
});

describe('the suggestion rules', () => {
  it('canonical as it is', () => {
    expect(s('Polity Reference', 'Polity')).toMatchObject({ kind: 'canonical', value: 'Polity Reference' });
  });

  it('a time word is stripped and named in the reason: “Historical Cultural Reference” → Culture Reference', () => {
    const r = s('Historical Cultural Reference', 'Culture');
    expect(r).toMatchObject({ kind: 'suggested', value: 'Culture Reference' });
    expect(r.moved.time).toEqual(['Historical']);
    expect(r.synonyms).toEqual(['Cultural → Culture']);
    expect(r.reason).toContain('Historical');
    expect(r.reason).toContain('Temporal Scope');
  });

  it('a synonym: “Cultural Reference” → Culture Reference', () => {
    expect(s('Cultural Reference', 'Culture')).toMatchObject({
      kind: 'suggested',
      value: 'Culture Reference',
    });
  });

  it('scope adjectives are stripped and named: “Regional Culture Reference”, “Shared National Polity Reference”', () => {
    const a = s('Regional Culture Reference', 'Culture');
    expect(a).toMatchObject({ kind: 'suggested', value: 'Culture Reference' });
    expect(a.moved.scope).toEqual(['Regional']);
    expect(a.reason).toContain('Scope');
    const b = s('Shared National Polity Reference', 'Polity');
    expect(b).toMatchObject({ kind: 'suggested', value: 'Polity Reference' });
    expect(b.moved.scope).toEqual(['Shared', 'National']);
    expect(s('Cross-National Culture Reference', 'Culture').value).toBe('Culture Reference');
  });

  it('a missing or extra “Reference”, and “and” for “&”', () => {
    expect(s('Polity', 'Polity')).toMatchObject({ kind: 'suggested', value: 'Polity Reference' });
    expect(s('Language and Naming Reference', 'Culture')).toMatchObject({
      kind: 'suggested',
      value: 'Language & Naming Reference',
    });
    expect(s('Character Biography Reference', 'Character')).toMatchObject({
      kind: 'suggested',
      value: 'Character Biography',
    });
    expect(s('culture reference', 'Culture').value).toBe('Culture Reference');
  });

  it('“Culture & Naming Reference” → Language & Naming Reference only if the vocabulary says so', () => {
    const without = s('Culture & Naming Reference', 'Culture');
    expect(without.kind).toBe('none');
    expect(without.value).toBeNull();
    expect(without.reason).toMatch(/^no confident suggestion/);
    const withAlias: VocabularyLists = {
      ...V,
      categories: V.categories.map((c) =>
        c.category === 'Culture'
          ? {
              ...c,
              types: c.types.map((t) =>
                t.name === 'Language & Naming Reference'
                  ? { ...t, aliases: ['Culture & Naming Reference'] }
                  : t,
              ),
            }
          : c,
      ),
    };
    expect(s('Culture & Naming Reference', 'Culture', withAlias)).toMatchObject({
      kind: 'suggested',
      value: 'Language & Naming Reference',
    });
  });

  it('two roles or two categories: no confident suggestion, both candidates listed', () => {
    const r = s('Historical Polity and Institution Reference', 'Polity');
    expect(r.kind).toBe('none');
    expect(r.value).toBeNull();
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['Institution Reference', 'Polity Reference']);
    expect(r.moved.time).toEqual(['Historical']);
    expect(r.reason).toContain('two categories');
  });

  it('the design’s T1 types: “Historical Conflict Reference” → Conflict Reference', () => {
    const r = s('Historical Conflict Reference', 'Event');
    expect(r).toMatchObject({ kind: 'suggested', value: 'Conflict Reference' });
    expect(r.moved.time).toEqual(['Historical']);
    expect(r.reason).toContain('Temporal Scope');
  });

  it('the design’s T1 types: “Historical Regional Reference” → Region Reference (the adjective names the role)', () => {
    const r = s('Historical Regional Reference', 'Place');
    expect(r).toMatchObject({ kind: 'suggested', value: 'Region Reference' });
    expect(r.moved.time).toEqual(['Historical']);
    expect(r.moved.scope).toEqual([]);
    expect(r.synonyms).toEqual(['Regional → Region']);
    // Where another word names the role, "Regional" is still scope, moved out.
    expect(s('Regional Settlement Reference', 'Place')).toMatchObject({ value: 'Settlement Reference' });
    expect(s('Regional Settlement Reference', 'Place').moved.scope).toEqual(['Regional']);
  });

  it('a canonical type that is an adjective’s word is found before any synonym: “Historical Legal Reference”', () => {
    expect(s('Historical Legal Reference', 'Law')).toMatchObject({
      kind: 'suggested',
      value: 'Legal Reference',
    });
    expect(s('Historical Religious Practice Reference', 'Religion')).toMatchObject({
      value: 'Religious Practice Reference',
    });
    expect(s('Shared Magical Tradition Reference', 'Magic')).toMatchObject({
      value: 'Magical Tradition Reference',
    });
  });

  it('Programme Reference is the Programme category’s (the owner’s ruling), and Technology keeps Technology Reference only', () => {
    const cat = (c: string) => RT.categories.find((x) => x.category === c)!.types;
    expect(cat('Programme')).toEqual([{ name: 'Programme Reference', role: 'Programme' }]);
    expect(cat('Technology')).toEqual([{ name: 'Technology Reference', role: 'Technology' }]);
    expect(s('Programme Reference', 'Programme')).toMatchObject({
      kind: 'canonical',
      canonicalIn: 'Programme',
    });
    const hist = s('Historical Programme Reference', 'Programme');
    expect(hist).toMatchObject({ kind: 'suggested', value: 'Programme Reference' });
    expect(hist.moved.time).toEqual(['Historical']);
    // On a Technology page it is another category's type: never suggested there, the owner rules.
    expect(s('Programme Reference', 'Technology')).toMatchObject({
      kind: 'canonical',
      canonicalIn: 'Programme',
    });
    const tech = s('Historical Programme Reference', 'Technology');
    expect(tech.kind).toBe('none');
    expect(tech.candidates.map((c) => `${c.name} (${c.category})`)).toEqual([
      'Programme Reference (Programme)',
    ]);
  });

  it('category scoping: the same word in two categories', () => {
    // “Relationship” is the role word of the Character category's joint relationship and of the Relationship category.
    expect(s('Relationship', 'Character')).toMatchObject({
      kind: 'suggested',
      value: 'Joint Character Relationship Reference',
    });
    expect(s('Relationship', 'Relationship')).toMatchObject({
      kind: 'suggested',
      value: 'Relationship Reference',
    });
    // Another category's type is never suggested: the owner chooses.
    const other = s('Culture Reference', 'Polity');
    expect(other).toMatchObject({ kind: 'canonical', canonicalIn: 'Culture' });
    const wrong = s('Cultural Reference', 'Polity');
    expect(wrong.kind).toBe('none');
    expect(wrong.candidates.map((c) => c.name)).toEqual(['Culture Reference']);
  });

  it('a page without a primary category tag has no confident suggestion', () => {
    const r = s('Cultural Reference', null);
    expect(r.kind).toBe('none');
    expect(r.candidates.map((c) => c.name)).toEqual(['Culture Reference']);
  });

  it('content detail is never guessed: “Sovereign State and Historical Development Reference”', () => {
    const r = s('Sovereign State and Historical Development Reference', 'Polity');
    expect(r.kind).toBe('none');
    expect(r.value).toBeNull();
  });
});

describe('the published section', () => {
  const v: VocabularyLists = {
    ...V,
    specialist: [
      { type: 'Arkonan Calendar Reference', category: 'Event', pages: null },
      {
        type: 'Imperial Charter Reference',
        category: 'Polity',
        pages: [{ id: 'p1', name: 'Falkenreich Charter' }],
      },
    ],
  };

  it('its exact text', () => {
    const lines = sectionLines(v, 'Reference Type Vocabulary');
    expect(lines[0]).toBe('Reference Type Vocabulary');
    expect(lines[1]).toBe(RT.rule);
    expect(lines[2]).toBe(INTRO_TYPES);
    expect(lines).toContain(
      'Polity: Polity Reference (Polity); Polity Constitution Reference (Constitution); Polity History Reference (History); Polity Directory (Directory).',
    );
    expect(lines).toContain(
      'Culture: Culture Reference (Culture); Culture Foundations Reference (Culture Foundations); Language & Naming Reference (Language & Naming); Lexicon Reference (Lexicon).',
    );
    expect(lines).toContain('Technology: Technology Reference (Technology).');
    expect(lines).toContain('Programme: Programme Reference (Programme).');
    expect(lines).toContain(INTRO_SPECIALIST);
    expect(lines).toContain(
      'Specialist type: Arkonan Calendar Reference (Event), any page in this category.',
    );
    expect(lines).toContain(
      'Specialist type: Imperial Charter Reference (Polity), for these pages: Falkenreich Charter.',
    );
    expect(lines.at(-1)).toBe(
      'Specialist type: Imperial Charter Reference (Polity), for these pages: Falkenreich Charter.',
    );
  });

  it('reads back exactly what it writes (the pages by their mentions)', () => {
    const blocks = renderSection(v, 'Reference Type Vocabulary', 2);
    const parsed = parseSection(blocks);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sameVocabulary(parsed.vocabulary, v)).toBe(true);
    expect(parsed.vocabulary.specialist[1]!.pages).toEqual([{ id: 'p1', name: 'Falkenreich Charter' }]);
  });

  it('fails closed on a line it cannot read', () => {
    const blocks = renderSection(V, 'Reference Type Vocabulary', 2);
    blocks.push({ kind: 'paragraph', content: [{ text: 'Polity: Polity Reference, Kingdom Reference.' }] });
    const r = parseSection(blocks);
    expect(r.ok).toBe(false);
  });

  it('is written under Sidebar Metadata, then replaced in place, every other block kept', () => {
    const doc = [
      { id: 'h1', kind: 'heading', level: 1, content: [{ text: 'Source Formatting' }] },
      { id: 'h2', kind: 'heading', level: 2, content: [{ text: 'Sidebar Metadata' }] },
      { id: 'p1', kind: 'paragraph', content: [{ text: 'Every page carries PROPERTIES.' }] },
      { id: 'u1', kind: 'unsupported' },
      { id: 'h3', kind: 'heading', level: 2, content: [{ text: 'Page Names and Templates' }] },
      { id: 'p2', kind: 'paragraph', content: [{ text: 'Names.' }] },
    ];
    const first = spliceSection(doc, 'Sidebar Metadata', 'Reference Type Vocabulary', V);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replaced).toBe(false);
    expect(first.level).toBe(3);
    const ids = first.blocks.map((b) => b.id ?? null);
    expect(ids.slice(0, 4)).toEqual(['h1', 'h2', 'p1', 'u1']);
    expect(ids.slice(-2)).toEqual(['h3', 'p2']);
    expect(first.blocks[4]).toMatchObject({ kind: 'heading', level: 3 });
    // Again, with another vocabulary: replaced in place, the same number of other blocks.
    const second = spliceSection(first.blocks, 'Sidebar Metadata', 'Reference Type Vocabulary', v);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replaced).toBe(true);
    const headings = second.blocks.filter(
      (b) => b.kind === 'heading' && JSON.stringify(b.content).includes('Reference Type Vocabulary'),
    );
    expect(headings).toHaveLength(1);
    expect(second.blocks.filter((b) => b.id === 'u1')).toHaveLength(1);
    expect(second.blocks.map((b) => b.id ?? null).slice(-2)).toEqual(['h3', 'p2']);
  });

  it('refuses when there is no Sidebar Metadata to write under', () => {
    const r = spliceSection(
      [{ id: 'h', kind: 'heading', level: 1, content: [{ text: 'Other' }] }],
      'Sidebar Metadata',
      'Reference Type Vocabulary',
      V,
    );
    expect(r).toMatchObject({ ok: false, code: 'SECTION_PARENT_MISSING' });
  });
});
