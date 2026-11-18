/**
 * v3 F3d amendment (ADR 0058, A and B), pure: a block's planned edits re-applied to the block as it is now (never wider:
 * found again by their sentence, done already, changed meanwhile, or ambiguous), and the review list of the old name's
 * parts (whole words only, never inside the full old name, another character's set flagged, capped at 200).
 */
import { describe, expect, it } from 'vitest';
import type { TextHit } from '../../src/appraisal/fts.js';
import { REVIEW_CAP, reviewList, reviewParts } from '../../src/packs/rename/review.js';
import { applyEdits, fingerprint, rebaseEdits, type PlannedEdit } from '../../src/packs/rename/text.js';

const OLD = 'Azhar al-Nasir';
const NEW = 'Mikhar al-Narif';
const para = (text: string) => ({ id: 'b1', kind: 'paragraph', content: [{ text }] });

describe('rebaseEdits: the same change on the fresh content, never wider', () => {
  const planned = para('Azhar al-Nasir held the gate. Later, Azhar al-Nasir left.');
  const edits: PlannedEdit[] = [
    { kind: 'text', ordinal: 0, item: 'a', sentence: 'Azhar al-Nasir held the gate.' },
    { kind: 'text', ordinal: 1, item: 'b', sentence: 'Later, Azhar al-Nasir left.' },
  ];
  const plan = { fingerprint: fingerprint(planned, OLD, NEW), edits, oldName: OLD, newName: NEW };

  it('a block unchanged apart from the rename’s own edits keeps each edit’s number', () => {
    const r = rebaseEdits(para('Mikhar al-Narif held the gate. Later, Azhar al-Nasir left.'), plan);
    expect(r).toMatchObject({
      edits: [{ kind: 'text', ordinal: 1 }],
      items: ['b'],
      done: ['a'],
      skipped: [],
    });
  });

  it('text added around it: each occurrence found again by its sentence', () => {
    const now = para('A new opening line. Azhar al-Nasir held the gate. Later, Azhar al-Nasir left.');
    const r = rebaseEdits(now, plan);
    expect(r.skipped).toEqual([]);
    expect(r.items).toEqual(['a', 'b']);
    expect(applyEdits(now, r.edits, OLD, NEW)!.content).toEqual([
      { text: 'A new opening line. Mikhar al-Narif held the gate. Later, Mikhar al-Narif left.' },
    ]);
  });

  it('its sentence edited meanwhile: skipped with a before and after excerpt; the other still applied', () => {
    const now = para('Azhar al-Nasir guarded the gate. Later, Azhar al-Nasir left.');
    const r = rebaseEdits(now, plan);
    expect(r.items).toEqual(['b']);
    expect(r.skipped).toEqual([
      {
        item: 'a',
        reason: 'changed meanwhile',
        before: 'Azhar al-Nasir held the gate.',
        after: 'Azhar al-Nasir guarded the gate. Later, Azhar al-Nasir left.',
      },
    ]);
  });

  it('its sentence now twice: which is meant cannot be told, so it is skipped', () => {
    const now = para(
      'Azhar al-Nasir held the gate. Azhar al-Nasir held the gate. Later, Azhar al-Nasir left.',
    );
    const r = rebaseEdits(now, plan);
    expect(r.skipped.map((s) => s.item)).toEqual(['a']);
    expect(r.skipped[0]!.reason).toContain('more than once');
    expect(r.items).toEqual(['b']);
  });

  it('an edit planned before the amendment (a mention label, no sentence) keeps its kind, or is skipped when moved', () => {
    const block = {
      id: 'b2',
      kind: 'paragraph',
      content: [{ text: 'Kept by ' }, { mention: { resourceId: 'x', text: OLD } }, { text: '.' }],
    };
    const old = [{ kind: 'mention', ordinal: 0, item: 'm' }] as unknown as PlannedEdit[];
    const same = rebaseEdits(block, {
      fingerprint: fingerprint(block, OLD, NEW),
      edits: old,
      oldName: OLD,
      newName: NEW,
    });
    expect(same).toMatchObject({ edits: [{ kind: 'mention', ordinal: 0 }], items: ['m'], skipped: [] });
    const moved = { ...block, content: [{ text: 'Now kept by ' }, ...block.content.slice(1)] };
    const r = rebaseEdits(moved, {
      fingerprint: fingerprint(block, OLD, NEW),
      edits: old,
      oldName: OLD,
      newName: NEW,
    });
    expect(r.edits).toEqual([]);
    expect(r.skipped.map((x) => x.item)).toEqual(['m']);
  });

  it('the paragraph gone: every edit skipped', () => {
    expect(rebaseEdits(null, plan).skipped.map((s) => [s.item, s.reason])).toEqual([
      ['a', 'changed meanwhile: the paragraph is gone'],
      ['b', 'changed meanwhile: the paragraph is gone'],
    ]);
  });
});

describe('the review list (name parts on their own)', () => {
  const hit = (pageId: string, text: string): TextHit => ({
    pageId,
    documentId: 'd1',
    blockId: `b-${pageId}-${text.length}`,
    unit: 'block',
    field: null,
    section: 'Overview',
    snippet: text,
    text,
    rank: 0,
  });

  it('only the parts the new name no longer holds; never the whole name', () => {
    expect(
      reviewParts({ oldName: OLD, newName: NEW, given: 'Azhar', family: 'al-Nasir', aliases: [OLD, 'Az'] }),
    ).toEqual([
      { part: 'Azhar', kind: 'given name' },
      { part: 'al-Nasir', kind: 'family name' },
    ]);
    expect(
      reviewParts({ oldName: OLD, newName: 'Azhar al-Rashid', given: 'Azhar', family: 'al-Nasir' }),
    ).toEqual([{ part: 'al-Nasir', kind: 'family name' }]);
  });

  it('whole words, not inside the full old name, another character sharing the part flagged, capped at 200', () => {
    const hits = [
      hit('p1', 'Azhar al-Nasir met Azhar at the well.'),
      hit('p2', 'Azharan is a town; Azhar rode there.'),
      ...Array.from({ length: 250 }, (_, i) => hit(`q${i}`, `Azhar spoke (${i}).`)),
    ];
    const list = reviewList(
      {
        projectId: 'p',
        search: (_p, v) => (v === 'Azhar' ? hits : []),
        labels: () => null,
        pageName: (id) => `[BSRC] ${id}`,
        characterOf: (id) => (id === 'p2' ? 'Azhar al-Rashid' : null),
      },
      { subjectName: OLD, oldName: OLD, parts: [{ part: 'Azhar', kind: 'given name' }] },
    );
    expect(list.count).toBe(252);
    expect(list.occurrences).toHaveLength(REVIEW_CAP);
    expect(list.more).toBe(52);
    expect(list.note).toContain(`Only the first ${REVIEW_CAP} are listed; 52 more are not.`);
    expect(list.occurrences[0]).toMatchObject({
      kind: 'name part',
      part: 'Azhar',
      page: { id: 'p1' },
      sentence: 'Azhar al-Nasir met Azhar at the well.',
    });
    expect(list.occurrences[0]!.sharedWith).toBeUndefined();
    expect(list.occurrences[1]).toMatchObject({
      page: { id: 'p2' },
      sharedWith: "this page is in Azhar al-Rashid's set",
    });
    // "Azharan" is not "Azhar"; the "Azhar" inside "Azhar al-Nasir" is not listed.
    expect(list.occurrences.filter((o) => o.page.id === 'p1')).toHaveLength(1);
    expect(list.occurrences.filter((o) => o.page.id === 'p2')).toHaveLength(1);
  });
});
