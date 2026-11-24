/**
 * Amendment 1 to ADR 0072 (v3 F7.1a, the owner's bug of 24 November 2026): `core_compact_wording`'s fix rewrote a
 * sentence on Mehrana al-Khalid's Character Core that was about another character's page ("…her identity is owned by the
 * separate compact character reference." → "…the separate Character Core."). A compact phrasing is now replaced only
 * when it refers to the page itself; everything else is listed for the owner, never edited. Fixtures from the real
 * cases. Pure: no LegendKeeper.
 */
import { describe, expect, it } from 'vitest';
import { applyCoreText, reword, wordingLeft } from '../../src/packs/engine/core.js';
import {
  blocksTextChanges,
  replacedWords,
  textChange,
  textChangesSummary,
} from '../../src/jobs/text-change.js';
import type { LkBlock } from '../../src/markdown/index.js';

const para = (id: string, ...content: unknown[]): LkBlock => ({
  id,
  kind: 'paragraph',
  content: content.map((c) => (typeof c === 'string' ? { text: c } : c)),
});
const textOf = (b: LkBlock): string =>
  ((b as unknown as { content: { text?: string }[] }).content ?? []).map((r) => r.text ?? '').join('');

const MEHRANA =
  "Taraji resumed lifelong personal service and is still Mehrana's tailor in 5A 931; her identity is owned by the separate compact character reference.";
const AKARI = "This compact character reference owns Akari's individual identity, voice and history.";
const EMINE = 'Compact Main CANON reference for Emine al-Noor, a courier of the Noor house.';

describe('the self-reference rule (the Core)', () => {
  it('Mehrana’s sentence: not replaced, and listed for the owner', () => {
    const blocks = [para('m1', MEHRANA)];
    const r = reword(blocks, 'core', 'Mehrana al-Khalid', undefined, { others: ['Taraji'] });
    expect(r.replacements).toEqual([]);
    expect(textOf(r.blocks[0]!)).toBe(MEHRANA);
    expect(r.skipped).toEqual([
      expect.objectContaining({ blockId: 'm1', phrase: 'compact character reference', sentence: MEHRANA }),
    ]);
    expect(wordingLeft(r.blocks, r.skipped, '[BSRC] Mehrana al-Khalid - Character Core')).toEqual([
      { page: '[BSRC] Mehrana al-Khalid - Character Core', blockId: 'm1', sentence: MEHRANA },
    ]);
  });

  it('Akari’s “This compact character reference owns Akari’s …”: replaced', () => {
    const r = reword([para('a1', AKARI)], 'core', 'Shibukawa Akari');
    expect(r.replacements).toEqual([
      {
        blockId: 'a1',
        before: AKARI,
        after: "This Character Core owns Akari's individual identity, voice and history.",
      },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('Emine’s Purpose “Compact Main CANON reference for Emine al-Noor …”: replaced', () => {
    const r = reword([para('e1', EMINE)], 'core', 'Emine al-Noor');
    expect(r.replacements.map((x) => x.after)).toEqual([
      'Main CANON Character Core for Emine al-Noor, a courier of the Noor house.',
    ]);
  });

  it('the Purpose opener by the Canonical Display Name; never for another character', () => {
    const own = reword(
      [para('e2', 'Compact Main CANON reference for Emine, a courier.')],
      'core',
      'Emine al-Noor',
      undefined,
      { names: ['Emine'] },
    );
    expect(own.replacements).toHaveLength(1);
    const other = reword(
      [para('e3', 'Compact Main CANON reference for Taraji, her tailor.')],
      'core',
      'Emine al-Noor',
    );
    expect(other.replacements).toEqual([]);
    expect(other.skipped).toHaveLength(1);
    // “The …” opens the Purpose paragraph too (Kamigawa Shirahime's); outside the Purpose paragraph it is not the opener.
    const the = reword(
      [
        { id: 'ph', kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
        para('e5', 'The Compact Character Reference for Kamigawa Shirahime.'),
        { id: 'oh', kind: 'heading', level: 2, content: [{ text: 'Household' }] },
        para('e6', 'The compact reference for Kamigawa Shirahime lists her servants.'),
      ],
      'core',
      'Kamigawa Shirahime',
    );
    expect(the.replacements.map((x) => [x.blockId, x.after])).toEqual([
      ['e5', 'The Character Core for Kamigawa Shirahime.'],
    ]);
    expect(the.skipped.map((x) => x.blockId)).toEqual(['e6']);
    // Not at the start of its sentence: not the opener.
    const mid = reword(
      [para('e4', 'See the compact Main CANON reference for Emine al-Noor.')],
      'core',
      'Emine al-Noor',
    );
    expect(mid.replacements).toEqual([]);
  });

  it('“the separate compact character reference” with no other name: not replaced, listed', () => {
    const s = 'Her identity is owned by the separate compact character reference.';
    const r = reword([para('s1', s)], 'core', 'Mehrana al-Khalid');
    expect(r.replacements).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ blockId: 's1', sentence: s })]);
  });

  it('a sentence that mentions another character page: not replaced, even after “this”', () => {
    const r = reword(
      [
        para(
          't1',
          'This compact reference sits beside ',
          { mention: { resourceId: 'tarajiid', text: 'Taraji' } },
          '.',
        ),
      ],
      'core',
      'Mehrana al-Khalid',
    );
    expect(r.replacements).toEqual([]);
    expect(r.skipped[0]?.why).toMatch(/links to another page/);
  });

  it('a sentence naming another character (by possessive, or by a known name): not replaced', () => {
    const pos = reword(
      [para('p1', "This compact reference holds Taraji's tailoring notes.")],
      'core',
      'Mehrana al-Khalid',
    );
    expect(pos.replacements).toEqual([]);
    const known = reword(
      [para('p2', 'This compact reference also records Taraji in passing.')],
      'core',
      'Mehrana al-Khalid',
      undefined,
      { others: ['Taraji Oyelaran'] },
    );
    expect(known.replacements).toEqual([]);
    // Only the sentence naming her is held: the next sentence of the same paragraph is the page's own.
    const two = reword(
      [para('p3', "Taraji's compact reference is hers. This compact reference owns Mehrana's identity.")],
      'core',
      'Mehrana al-Khalid',
    );
    expect(two.replacements.map((x) => x.after)).toEqual([
      "Taraji's compact reference is hers. This Character Core owns Mehrana's identity.",
    ]);
    expect(two.skipped.map((x) => x.phrase)).toEqual(['compact reference']);
  });

  it('only a capitalised word of another character’s name counts (“Kumi the Elder” does not make “the” a name)', () => {
    const r = reword(
      [para('k1', 'This compact character reference embeds the image below.')],
      'core',
      'Emine al-Noor',
      undefined,
      {
        others: ['Kumi the Elder', 'Kaito of the Shattered Sky'],
      },
    );
    expect(r.replacements).toHaveLength(1);
    const named = reword(
      [para('k2', 'This compact reference was drawn by Kumi.')],
      'core',
      'Emine al-Noor',
      undefined,
      {
        others: ['Kumi the Elder'],
      },
    );
    expect(named.replacements).toEqual([]);
  });

  it('the page’s own old name is always the page itself', () => {
    const r = reword(
      [para('n1', 'Linked from Mehrana al-Khalid - Character Reference.')],
      'core',
      'Mehrana al-Khalid',
    );
    expect(r.replacements.map((x) => x.after)).toEqual(['Linked from Mehrana al-Khalid - Character Core.']);
  });
});

describe('the Art page’s “character reference” test (at least as strict)', () => {
  it('the character’s own possessive: replaced; “the character reference” is never enough', () => {
    const r = reword(
      [
        para('x1', "Emine's character reference owns her identity."),
        para('x2', 'The character reference owns her identity.'),
      ],
      'art',
      'Emine al-Noor',
    );
    expect(r.replacements.map((x) => x.after)).toEqual(["Emine's Character Core owns her identity."]);
    expect(r.skipped.map((x) => x.blockId)).toEqual(['x2']);
  });

  it('“her character reference” only when the paragraph names nobody else', () => {
    const own = reword(
      [para('h1', 'Her approved visual references; her character reference owns her identity.')],
      'art',
      'Hana Mori',
    );
    expect(own.replacements).toHaveLength(1);
    const other = reword(
      [para('h2', 'Taraji sewed the coat. Her character reference owns her identity.')],
      'art',
      'Hana Mori',
      undefined,
      { others: ['Taraji'] },
    );
    expect(other.replacements).toEqual([]);
    expect(other.skipped).toHaveLength(1);
    const other2 = reword(
      [para('h3', "Taraji's coat is shown. Her character reference owns her identity.")],
      'art',
      'Hana Mori',
    );
    expect(other2.replacements).toEqual([]);
  });

  it('“character reference images” stays as it is', () => {
    const r = reword([para('i1', "Hana's character reference images stay here.")], 'art', 'Hana Mori');
    expect(r.replacements).toEqual([]);
  });
});

describe('inside the lock: never more than the owner was shown', () => {
  it('a block whose replacements differ from the shown ones is left as it is', () => {
    const planned = reword([para('a1', AKARI)], 'core', 'Shibukawa Akari');
    // The paragraph was edited after the proposal: it now also names Taraji (so its phrase is no longer the page's).
    const now = [para('a1', `${AKARI} Taraji's notes are kept here.`)];
    const r = applyCoreText(now, {
      role: 'core',
      subject: 'Shibukawa Akari',
      reword: ['a1'],
      expect: planned.replacements,
      remove: [],
    });
    expect(r.held).toBe(1);
    expect(r.replaced).toBe(0);
    expect(textOf(r.blocks[0]!)).toBe(`${AKARI} Taraji's notes are kept here.`);
    // As planned: written.
    const ok = applyCoreText([para('a1', AKARI)], {
      role: 'core',
      subject: 'Shibukawa Akari',
      reword: ['a1'],
      expect: planned.replacements,
      remove: [],
    });
    expect(ok.held).toBe(0);
    expect(textOf(ok.blocks[0]!)).toBe(
      "This Character Core owns Akari's individual identity, voice and history.",
    );
  });
});

describe('text changes: the sentence before and after, the replaced words marked', () => {
  it('one sentence of a longer run, the phrase marked in each', () => {
    const before = `Her coat is grey. ${AKARI} She keeps it.`;
    const after = before.replace('compact character reference', 'Character Core');
    const c = textChange({ page: 'P', before, after })!;
    expect(c.before).toBe(AKARI);
    expect(c.after).toBe("This Character Core owns Akari's individual identity, voice and history.");
    expect(c.before.slice(c.removed.start, c.removed.end)).toBe('compact character reference');
    expect(c.after.slice(c.added.start, c.added.end)).toBe('Character Core');
    expect(replacedWords(c)).toBe('“compact character reference” → “Character Core”');
  });

  it('a dash, a dropped heading link and an added dateline', () => {
    const dash = blocksTextChanges(
      [para('d1', 'The gate—its keepers say—never closes.')],
      [para('d1', 'The gate - its keepers say - never closes.')],
      { name: 'P' },
      'dash',
    );
    expect(dash).toHaveLength(1);
    expect(dash[0]!.before).toBe('The gate—its keepers say—never closes.');
    const link = blocksTextChanges(
      [
        {
          id: 'h1',
          kind: 'heading',
          content: [{ text: 'Relations with ' }, { mention: { resourceId: 'r', text: 'Tarim' } }],
        },
      ],
      [{ id: 'h1', kind: 'heading', content: [{ text: 'Relations with Tarim' }] }],
      { name: 'P' },
      'heading link',
    );
    expect(link.map((c) => [c.before, c.after])).toEqual([
      ['Relations with [Tarim]', 'Relations with Tarim'],
    ]);
    const added = textChange({ page: 'P', before: '', after: '5 Mid-Thaw, 5A 931' })!;
    expect(replacedWords(added)).toBe('added “5 Mid-Thaw, 5A 931”');
  });

  it('a summary keeps the changes within its budget and counts the rest', () => {
    const cs = Array.from({ length: 5 }, (_, i) =>
      textChange({
        page: 'P',
        before: `${AKARI} (${i})`,
        after: `${AKARI.replace('compact character reference', 'Character Core')} (${i})`,
      })!,
    );
    const s = textChangesSummary(cs, 260);
    expect(s.length).toBeLessThanOrEqual(260);
    expect(s).toMatch(/^Text: “/);
    expect(s).toContain('compact character reference');
    expect(s).toMatch(/more on the proposal$/);
  });
});
