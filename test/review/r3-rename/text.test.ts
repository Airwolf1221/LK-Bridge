/**
 * CR-2026-11 round 3 (renames), pure attacks on the rename's text rules (src/packs/rename/text.ts) and its block rebaser
 * (src/packs/rename/checks.ts): ADR 0058 amendment A.3, "Never wider. A rebase only re-applies the same change to the
 * same text". Every test asserts the SAFE behaviour; a failing test is a finding.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  blockOccurrences,
  d1Why,
  fingerprint,
  occurrences,
  occurrencesWithSentences,
  rebaseEdits,
  sentenceAround,
  textOf,
  type PlannedEdit,
} from '../../../src/packs/rename/text.js';
import { renameCheckers, renameRebasers } from '../../../src/packs/rename/checks.js';
import type { RebaseContext } from '../../../src/jobs/rebase.js';

type Obj = Record<string, unknown>;
const OLD = 'Nadira al-Khalid';
const NEW = 'Laila al-Khalid';
const para = (id: string, ...runs: (string | Obj)[]): Obj => ({
  id,
  kind: 'paragraph',
  content: runs.map((r) => (typeof r === 'string' ? { text: r } : r)),
});
const visible = (b: Obj | null): string =>
  ((b?.content as Obj[] | undefined) ?? [])
    .map((r) => {
      const label = (r.mention as Obj | undefined)?.text;
      return typeof r.text === 'string' ? r.text : typeof label === 'string' ? label : '';
    })
    .join('');

/** The planner's edits for a block (src/packs/rename/plan.ts, step 4): one per old-name occurrence, with its sentence. */
function plannedEdits(block: Obj, oldName = OLD, newName = NEW): (PlannedEdit & { why: string | null })[] {
  const text = textOf(block);
  const found = blockOccurrences(block, oldName, newName);
  let offset = 0;
  const starts: number[] = [];
  for (const r of (block.content as Obj[]) ?? []) {
    starts.push(offset);
    if (typeof r.text === 'string') offset += r.text.length;
  }
  const out: (PlannedEdit & { why: string | null })[] = [];
  found.text.forEach((o, k) => {
    if (!o.isOld) return;
    const start = starts[o.run]! + o.start;
    out.push({
      kind: 'text',
      ordinal: k,
      item: `text:doc:${String(block.id)}:${k}`,
      sentence: sentenceAround(text, start, start + oldName.length),
      why: d1Why(text, start, [], 'Unresolved Material'),
    });
  });
  return out;
}

/** The block rebaser, as the engine calls it inside the write's lock with the block read now. */
function rebaseNow(
  current: Obj,
  planned: Obj,
  approved: readonly PlannedEdit[],
  oldName = OLD,
  newName = NEW,
) {
  const ctx: RebaseContext = {
    projectId: 'p',
    jobId: 'j',
    stepNo: 2,
    opId: 'replaceBlock',
    params: { path: { resourceId: 'r', documentId: 'd', blockId: String(planned.id) }, body: planned },
    input: {
      oldName,
      newName,
      fingerprint: fingerprint(planned, oldName, newName),
      edits: approved.map(({ kind, ordinal, item, sentence }) => ({ kind, ordinal, item, sentence })),
      // CR-2026-11-R3 (R3-25): the planner now keeps every occurrence's sentence with the block (ticked or not).
      sentences: occurrencesWithSentences(planned, oldName, newName)
        .filter((o) => o.isOld)
        .map((o) => o.sentence),
    },
    conflict: 1,
    current: { exists: true, version: 'v9', body: { ...current, version: 'v9' }, entity: null },
  };
  return renameRebasers.rebaseBlock(ctx);
}

describe('RN text: overlapping names', () => {
  it('RN-01 the old name a substring of the new ("Ann" → "Anna"): a rebase never edits "Anna"', () => {
    const planned = para('b1', 'Ann met Anna at the gate. They spoke.');
    const edits = plannedEdits(planned, 'Ann', 'Anna');
    expect(edits.map((e) => e.ordinal)).toEqual([0]);
    // Fast path (unchanged apart from the rename): only the planned occurrence.
    const fast = rebaseEdits(planned, {
      fingerprint: fingerprint(planned, 'Ann', 'Anna'),
      edits,
      oldName: 'Ann',
      newName: 'Anna',
    });
    expect(visible(applyEdits(planned, fast.edits, 'Ann', 'Anna'))).toBe(
      'Anna met Anna at the gate. They spoke.',
    );
    // Slow path (another sentence edited meanwhile): found again by its sentence, still only that one.
    const now = para('b1', 'Ann met Anna at the gate. They spoke at length.');
    const r = rebaseNow(now, planned, edits, 'Ann', 'Anna');
    expect(r.kind).toBe('retry');
    expect(visible((r as { params: { body: Obj } }).params.body)).toBe(
      'Anna met Anna at the gate. They spoke at length.',
    );
  });

  it('RN-02 a name inside a longer word or hyphenated name is never an occurrence', () => {
    for (const t of ['Annabel rode.', 'Joann rode.', 'Ann-Marie rode.', 'Ann2 rode.', 'O’Ann rode.'])
      expect(occurrences(t, 'Ann'), t).toEqual([]);
    // A possessive is the name.
    expect(occurrences('Ann’s horse.', 'Ann')).toHaveLength(1);
  });

  it('RN-03 a name split by a mark (part bold) is not found in runs and never rewritten', () => {
    const b = para('b1', 'Nadira ', { text: 'al-Khalid', bold: true }, ' kept the seals. ', OLD, ' left.');
    const found = blockOccurrences(b, OLD, NEW);
    expect(found.text).toHaveLength(1);
    const next = applyEdits(b, [{ kind: 'text', ordinal: 0 }], OLD, NEW)!;
    expect((next.content as Obj[])[0]).toEqual({ text: 'Nadira ' });
    expect((next.content as Obj[])[1]).toEqual({ text: 'al-Khalid', bold: true });
    expect(visible(next)).toBe(`Nadira al-Khalid kept the seals. ${NEW} left.`);
  });
});

describe('RN text: the occurrence a rebase edits', () => {
  it('RN-04 fast path: the old and the new name swapped meanwhile (masked alike) never edit an unplanned occurrence', () => {
    // Planned: occurrence 0 the subject (ticked); occurrence 1 already the new name (another person's text).
    const planned = para('b1', `${OLD} kept the seals; ${NEW} watched.`);
    const edits = plannedEdits(planned);
    expect(edits.map((e) => e.ordinal)).toEqual([0]);
    const swapped = para('b1', `${NEW} kept the seals; ${OLD} watched.`);
    expect(fingerprint(swapped, OLD, NEW)).toBe(fingerprint(planned, OLD, NEW));
    const r = rebaseEdits(swapped, {
      fingerprint: fingerprint(planned, OLD, NEW),
      edits,
      oldName: OLD,
      newName: NEW,
    });
    // Nothing is written over the occurrence that was not planned.
    const next = r.edits.length > 0 ? applyEdits(swapped, r.edits, OLD, NEW) : swapped;
    expect(visible(next)).toBe(`${NEW} kept the seals; ${OLD} watched.`);
  });

  it('RN-05 a quoted occurrence (unticked by D1 (a)) is never renamed in place of a ticked one whose sentence changed', () => {
    // A ticked sentence, and an inscription quoting the same sentence (inside quotation marks: unticked).
    const planned = para(
      'b1',
      `${OLD} kept the seals. The plaque reads: “Here worked the archivists. ${OLD} kept the seals. May their names endure.”`,
    );
    const edits = plannedEdits(planned);
    expect(edits.map((e) => [e.ordinal, e.why])).toEqual([
      [0, null],
      [1, 'it is inside quotation marks'],
    ]);
    expect(edits[0]!.sentence).toBe(edits[1]!.sentence);
    const approved = edits.filter((e) => e.why === null);
    // Meanwhile another writer edits the ticked sentence (the inscription is untouched).
    const now = para(
      'b1',
      `${OLD} kept the royal seals. The plaque reads: “Here worked the archivists. ${OLD} kept the seals. May their names endure.”`,
    );
    const r = rebaseNow(now, planned, approved);
    const after = r.kind === 'retry' ? visible((r as { params: { body: Obj } }).params.body) : visible(now);
    // Safe: the quotation keeps the old name (the item is skipped, "changed meanwhile").
    expect(after).toContain(`“Here worked the archivists. ${OLD} kept the seals.`);
    expect(r.kind).toBe('skip');
  });

  it('RN-06 an occurrence the owner left out is never renamed in place of an approved one whose sentence changed', () => {
    // The same sentence twice in one paragraph; the owner approves the first and leaves the second out.
    const planned = para('b1', `${OLD} kept the seals. The guards slept. ${OLD} kept the seals.`);
    const edits = plannedEdits(planned);
    expect(edits.map((e) => e.ordinal)).toEqual([0, 1]);
    const approved = [edits[0]!];
    const now = para('b1', `${OLD} kept the seals of Qasr. The guards slept. ${OLD} kept the seals.`);
    const r = rebaseNow(now, planned, approved);
    const after = r.kind === 'retry' ? visible((r as { params: { body: Obj } }).params.body) : visible(now);
    expect(after).toBe(`${OLD} kept the seals of Qasr. The guards slept. ${OLD} kept the seals.`);
  });

  it('RN-06b sentences that differ only by a mention are told apart (the one left out is never renamed)', () => {
    // "Nadira al-Khalid met @Tarek. Nadira al-Khalid met @Mehrana." The owner approves the first only.
    const tarek = { mention: { resourceId: 'tarekidx' } };
    const mehrana = { mention: { resourceId: 'mehr1cor' } };
    const planned = para('b1', `${OLD} met `, tarek, `. ${OLD} met `, mehrana, '.');
    const edits = plannedEdits(planned);
    expect(edits.map((e) => e.ordinal)).toEqual([0, 1]);
    // The first sentence is deleted meanwhile; the one about Mehrana is still there.
    const now = para('b1', `${OLD} met `, mehrana, '.');
    const r = rebaseNow(now, planned, [edits[0]!]);
    const after = r.kind === 'retry' ? visible((r as { params: { body: Obj } }).params.body) : visible(now);
    expect(after).toBe(`${OLD} met .`);
  });

  it('RN-07 a sentence edited meanwhile to hold the name twice is skipped, never edited twice', () => {
    const planned = para('b1', `${OLD} rode north. The guards slept.`);
    const edits = plannedEdits(planned);
    for (const now of [
      para('b1', `${OLD} rode north. The guards slept. ${OLD} rode north.`),
      para('b1', `${OLD} rode north with ${OLD}’s cousin. The guards slept.`),
    ]) {
      const r = rebaseNow(now, planned, edits);
      expect(r.kind, visible(now)).toBe('skip');
    }
  });

  it('RN-08 the read-back of a rebased block accepts nothing wider than the planned sentence', () => {
    // The document check (job step 1) with the quoted repeat: the planned body leaves the quotation alone.
    const planned = para(
      'b1',
      `${OLD} kept the seals. The plaque reads: “Here worked the archivists. ${OLD} kept the seals. May their names endure.”`,
    );
    const edits = plannedEdits(planned).filter((e) => e.why === null);
    const now = para(
      'b1',
      `${OLD} kept the royal seals. The plaque reads: “Here worked the archivists. ${OLD} kept the seals. May their names endure.”`,
    );
    const out = renameCheckers.documentCheck({
      label: 'doc:d',
      input: {
        documentId: 'd',
        oldName: OLD,
        newName: NEW,
        blocks: [{ blockId: 'b1', fingerprint: fingerprint(planned, OLD, NEW), edits }],
      },
      document: { version: 'v2', blocks: [now] },
    } as never);
    const body = (out.bodies ?? {})['block:d:b1'] as Obj | undefined;
    // Safe: nothing to write for this block (its item skipped), or a body that keeps the quotation.
    if (body) expect(visible(body)).toContain(`“Here worked the archivists. ${OLD} kept the seals.`);
    expect((out.skipped ?? []).map((s) => s.item)).toEqual([edits[0]!.item]);
  });
});

describe('RN text: custom mention labels (ADR 0058 amendment D)', () => {
  it('RN-09 a mention label edit (a proposal captured before the amendment) is never applied', () => {
    const planned = para(
      'b1',
      'Its archive was kept by ',
      { mention: { resourceId: 'nadircor', text: OLD } },
      '.',
    );
    const legacy = [{ kind: 'mention' as const, ordinal: 0, item: 'label:d:b1:0', sentence: '' }];
    const r = rebaseEdits(planned, {
      fingerprint: fingerprint(planned, OLD, NEW),
      edits: legacy,
      oldName: OLD,
      newName: NEW,
    });
    const next = r.edits.length > 0 ? applyEdits(planned, r.edits, OLD, NEW)! : planned;
    // Safe: the custom label is never written (LegendKeeper's API cannot change it; the item is review only).
    expect(((next.content as Obj[])[1]!.mention as Obj).text).toBe(OLD);
  });
});

describe('RN text: custom labels beside a renamed occurrence', () => {
  it('RN-09b a rebased block renames its text occurrence and keeps the custom label in the same sentence', () => {
    const planned = para(
      'b1',
      'Later ',
      { mention: { resourceId: 'nadircor', text: OLD } },
      ` met ${OLD} at the gate.`,
    );
    const edits = plannedEdits(planned);
    expect(edits).toHaveLength(1);
    const now = para(
      'b1',
      'Later ',
      { mention: { resourceId: 'nadircor', text: OLD } },
      ` met ${OLD} at the gate. Then rain.`,
    );
    const r = rebaseNow(now, planned, edits);
    expect(r.kind).toBe('retry');
    const body = (r as { params: { body: Obj } }).params.body;
    expect(((body.content as Obj[])[1]!.mention as Obj).text).toBe(OLD);
    expect(visible(body)).toBe(`Later ${OLD} met ${NEW} at the gate. Then rain.`);
  });
});

describe('RN text: sentences', () => {
  it('RN-10 occurrences in one block are told apart by sentence, including an abbreviation before the name', () => {
    const b = para('b1', `Dr. ${OLD} rode. ${OLD} rode.`);
    const occ = occurrencesWithSentences(b, OLD, NEW);
    // Both sentences read "Nadira al-Khalid rode." to the rebase: a change to either skips (never guesses).
    expect(occ.map((o) => o.sentence)).toEqual([`${OLD} rode.`, `${OLD} rode.`]);
    const planned = plannedEdits(b);
    const now = para('b1', `Dr. ${OLD} rode. ${OLD} rode. The end.`);
    const r = rebaseNow(now, b, [planned[0]!]);
    expect(r.kind).toBe('skip');
  });
});
