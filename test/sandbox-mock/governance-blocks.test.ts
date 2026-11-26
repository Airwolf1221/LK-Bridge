/**
 * Harness regression (the f6b-nav live run of 26 November 2026): the owner had published the Reference Type Vocabulary,
 * so the copied pack's rule was `published`, the throwaway governance page carried a placeholder under its heading, and the
 * pack could not be approved ("the section lists no category"). The page's blocks are now built by a pure function
 * (test/sandbox/governance-blocks.ts); a published rule is written in its real form, a draft is left out as before, and a
 * parsed section it cannot write fails at once, naming the heading.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { indexTagSectionText, parseIndexTagSection } from '../../src/packs/indextax/rules.js';
import { effectiveVocabulary } from '../../src/packs/reftypes/service.js';
import { parseSection, sameVocabulary } from '../../src/packs/reftypes/vocabulary.js';
import { sectionBlocksOf } from '../../src/packs/sections.js';
import {
  buildGovernanceBlocks,
  indexTagSectionMatches,
  pinnedRuleSections,
  type GovernanceBlocksInput,
} from '../sandbox/governance-blocks.js';

type Obj = Record<string, unknown>;

const base = ARKONA_PACK.rules;
const VOCAB = base.referenceTypes!;
const TAGS = base.indexTaxonomy!;
const SUPP = 'SUPPLEMENTARY';
const SWEEP = 'SWEEP';

const input = (
  over: {
    vocab?: 'draft' | 'published';
    tags?: 'draft' | 'published';
    rules?: Obj;
  } = {},
): GovernanceBlocksInput => ({
  label: 'throwaway governance',
  sources: ARKONA_PACK.governance,
  rules: {
    ...base,
    referenceTypes: { ...VOCAB, status: over.vocab ?? 'draft' },
    indexTaxonomy: { ...TAGS, status: over.tags ?? 'draft' },
    ...over.rules,
  },
  vocabulary: effectiveVocabulary({ ...VOCAB, status: 'published' }, []).lists,
  supplementarySentence: SUPP,
  sweepSentence: SWEEP,
  fallbackSweepSection: base.automation?.section,
});

const text = (b: Obj): string =>
  ((b.content ?? []) as { text?: string; mention?: { text?: string } }[])
    .map((r) => r.text ?? r.mention?.text ?? '')
    .join('');
const headingsOf = (blocks: Obj[]): string[] => blocks.filter((b) => b.kind === 'heading').map(text);

describe('the throwaway governance page’s blocks', () => {
  it('the seed has both rules pinned, and the builder knows every pinned rule section', () => {
    expect(
      pinnedRuleSections(base)
        .map((p) => p.path)
        .sort(),
    ).toEqual(['automation', 'indexTaxonomy', 'referenceTypes', 'retag.supplementary']);
  });

  it('the vocabulary as a draft: its heading is left out; the heading it goes under is there', () => {
    const r = buildGovernanceBlocks(input());
    const h = headingsOf(r.blocks);
    expect(h).not.toContain(VOCAB.section);
    expect(h).toContain(VOCAB.under);
    expect(r.published).toEqual([]);
    expect(JSON.stringify(r.blocks)).not.toContain(`The rules of ${VOCAB.section}.`);
  });

  it('the vocabulary published: the rendered section, under the pinned heading, parses back to the same lists', () => {
    const r = buildGovernanceBlocks(input({ vocab: 'published' }));
    const section = sectionBlocksOf(r.blocks, VOCAB.section);
    const parsed = parseSection(section);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sameVocabulary(parsed.vocabulary, effectiveVocabulary(VOCAB, []).lists)).toBe(true);
    expect(parsed.vocabulary.categories.length).toBeGreaterThan(0);
    // Under "Sidebar Metadata" (level 2), one level below it, and no placeholder paragraph for the heading.
    const blocks = r.blocks;
    const at = blocks.findIndex((b) => b.kind === 'heading' && text(b) === VOCAB.section);
    expect(blocks[at]!.level).toBe(3);
    const parent = blocks.findIndex((b) => b.kind === 'heading' && text(b) === VOCAB.under);
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(parent).toBeLessThan(at);
    expect(JSON.stringify(blocks)).not.toContain('The rules of Reference Type Vocabulary');
    expect(r.published[0]).toContain(VOCAB.section);
  });

  it('the vocabulary published without lists to render is an error naming the heading', () => {
    expect(() => buildGovernanceBlocks({ ...input({ vocab: 'published' }), vocabulary: null })).toThrow(
      /“Reference Type Vocabulary”/,
    );
  });

  it('the index tags rule as a draft: its heading is left out', () => {
    const r = buildGovernanceBlocks(input());
    expect(headingsOf(r.blocks)).not.toContain(TAGS.section);
    expect(sectionBlocksOf(r.blocks, TAGS.section)).toBeNull();
  });

  it('the index tags rule published: the section as the pack holds it (N4’s text), which reads back exactly', () => {
    const r = buildGovernanceBlocks(input({ tags: 'published' }));
    const section = sectionBlocksOf(r.blocks, TAGS.section);
    expect(section).not.toBeNull();
    expect(section!.slice(1).map(text)).toEqual(indexTagSectionText(TAGS));
    const parsed = parseIndexTagSection(section);
    expect(parsed.ok && parsed.navTag).toBe(TAGS.navTag);
    expect(indexTagSectionMatches(r.blocks, { ...TAGS, status: 'published' })).toEqual({ ok: true });
    expect(r.published[0]).toContain(TAGS.section);
  });

  it('both published at once: both sections read, the other headings keep their sentences', () => {
    const r = buildGovernanceBlocks(input({ vocab: 'published', tags: 'published' }));
    expect(parseSection(sectionBlocksOf(r.blocks, VOCAB.section)).ok).toBe(true);
    expect(parseIndexTagSection(sectionBlocksOf(r.blocks, TAGS.section)).ok).toBe(true);
    const supp = base.retag?.supplementary?.section;
    if (supp) expect(JSON.stringify(r.blocks)).toContain(SUPP);
  });

  it('a read-back that differs from the pack is reported (N4)', () => {
    const r = buildGovernanceBlocks(input({ tags: 'published' }));
    const other = { ...TAGS, status: 'published' as const, navTag: 'Elsewhere' };
    const same = indexTagSectionMatches(r.blocks, other);
    expect(same.ok).toBe(false);
  });

  it('a parsed heading that would be left as a placeholder is a clear error naming it', () => {
    const rules = {
      ...input().rules,
      somethingNew: { source: 'source-formatting', section: 'Mystery Rules' },
    };
    expect(() => buildGovernanceBlocks({ ...input(), rules: rules })).toThrow(
      /“Mystery Rules”.*placeholder paragraph would not parse/s,
    );
  });

  it('a heading pinned both as a plain section and as the vocabulary’s would get a placeholder: an error', () => {
    const odd = { ...input(), sources: [{ sections: ['reference type vocabulary'] }] };
    expect(() => buildGovernanceBlocks(odd)).toThrow(/reference type vocabulary/i);
  });

  it('no sandbox check builds a governance page of its own (the placeholder text lives in governance-blocks.ts only)', () => {
    const dir = new URL('../sandbox/', import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'governance-blocks.ts')
      .filter((f) => /The rules of \$\{/.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
