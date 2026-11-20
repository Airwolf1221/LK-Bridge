/**
 * CR-2026-11 round 3 (renames): can a rename edit text it should not? ADR 0058 decision 1.3 (D1 (a)'s ticks) and
 * amendment A.3 ("Never wider"), against the mock LegendKeeper of the rename world (test/packs/rename-world.ts). Every
 * test asserts the SAFE behaviour; a failing test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SidebarModel } from '../../resources/world.js';
import { C, O, PROJECT, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import {
  NEW,
  OLD,
  approveAs,
  blockIn,
  closedSelection,
  dryItems,
  factsOf,
  itemsOf,
  mainDoc,
  outsideEdit,
  proposeNadira,
  rowCells,
  tableRow,
  textOf,
  type Obj,
} from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const para = (id: string, text: string): Obj => ({ id, kind: 'paragraph', content: [{ text }] });

/** Inserts blocks after `afterId` in a page's Main document (an edit in the app). */
function insertAfter(w: RenameWorld, pageId: string, afterId: string, ...blocks: Obj[]): void {
  const doc = mainDoc(w, pageId);
  const list = doc.blocks as Obj[];
  const at = list.findIndex((b) => b.id === afterId);
  list.splice(at + 1, 0, ...blocks);
  doc.version += 1;
}

describe('RN widening: a quoted occurrence and its sentence repeated (D1 (a), amendment A.3)', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-11 an edit to a ticked sentence while the proposal waits never renames the quoted occurrence (left unticked)', async () => {
    const QUOTED = `The plaque reads: “Here worked the archivists. ${OLD} kept the seals. May their names endure.”`;
    outsideEdit(w, O.qasr, 'qs4', `${OLD} kept the seals. ${QUOTED}`);
    await w.snapshot();
    const id = await proposeNadira(w);
    const qs4 = itemsOf(w, id).filter((i) => i.id.includes(':qs4:'));
    expect(qs4.map((i) => [i.id.split(':').at(-1), i.selected, i.why ?? null])).toEqual([
      ['0', true, null],
      ['1', false, 'it is inside quotation marks'],
    ]);
    // While the proposal waits for the owner, someone edits the ticked sentence in the app (the plaque untouched).
    outsideEdit(w, O.qasr, 'qs4', `${OLD} kept the royal seals. ${QUOTED}`);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    // Safe: the quotation is never renamed (the ticked item's sentence changed: it is skipped, changed meanwhile).
    expect(textOf(w, O.qasr, 'qs4')).toBe(`${OLD} kept the royal seals. ${QUOTED}`);
    expect(w.stack.runtime.engine.skippedItems(PROJECT, done.jobId!).map((s) => s.item)).toContain(
      qs4[0]!.id,
    );
  });
});

describe('RN widening: the same sentence in two blocks, a sentence moved', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-16 the same sentence in two blocks: only the block the owner approved is edited', async () => {
    const SAME = textOf(w, O.qasr, 'qs4');
    insertAfter(w, O.qasr, 'qs4', para('qs4b', SAME));
    await w.snapshot();
    const id = await proposeNadira(w);
    const items = itemsOf(w, id);
    const twin = items.find((i) => i.id.includes(':qs4b:'))!;
    expect(twin.selected).toBe(true);
    const keep = closedSelection(
      items,
      items.filter((i) => i.selected && i.id !== twin.id).map((i) => i.id),
    );
    // Someone edits another paragraph of the page meanwhile, so each block write is rebased.
    outsideEdit(w, O.qasr, 'qs2', 'The reference for the Emirate of Qasr, revised.');
    const done = await approveAs(w, id, keep);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(textOf(w, O.qasr, 'qs4')).toBe(SAME.replace(OLD, NEW));
    expect(textOf(w, O.qasr, 'qs4b')).toBe(SAME);
  });

  it('RN-17 a sentence moved to another block meanwhile is never renamed where it landed (its item skipped)', async () => {
    const w2 = await renameWorld();
    try {
      const SENTENCE = textOf(w2, O.qasr, 'qs4');
      const id = await proposeNadira(w2);
      outsideEdit(w2, O.qasr, 'qs4', 'The emirate kept its charters.');
      outsideEdit(w2, O.qasr, 'qs2', `The reference for the Emirate of Qasr. ${SENTENCE}`);
      const done = await approveAs(w2, id);
      expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
      expect(textOf(w2, O.qasr, 'qs2')).toBe(`The reference for the Emirate of Qasr. ${SENTENCE}`);
      expect(textOf(w2, O.qasr, 'qs4')).toBe('The emirate kept its charters.');
      const skipped = w2.stack.runtime.engine.skippedItems(PROJECT, done.jobId!);
      expect(skipped.some((s) => s.item.includes(':qs4:0'))).toBe(true);
    } finally {
      await w2.close();
    }
  });
});

describe('RN widening: another character whose name holds the old name ("Azhar" inside "Azhar al-Nasir")', () => {
  let w: RenameWorld;
  const NIECE = `${OLD} al-Sughra`;
  const NIECE_INDEX = 'sughidx1';
  const NIECE_CORE = 'sughcor1';
  beforeAll(async () => {
    w = await renameWorld();
    // Her namesake: another character of Qishen, with her own index, Core, identity facts and text.
    w.repo.seed({ id: NIECE_INDEX, name: `[INDEX] ${NIECE}`, parentId: C.qishen });
    w.repo.seed({
      id: NIECE_CORE,
      name: `[BSRC] ${NIECE} - Character Core`,
      parentId: NIECE_INDEX,
      referenceType: 'Character Core',
      tags: ['CANON', 'Character', 'Qishen'],
    });
    w.sidebars.page(NIECE_CORE, [
      SidebarModel.kv('kvsughc1', 'PROPERTIES', [
        ['Status', 'Authoritative'],
        ['Continuity Type', 'CANON'],
        ['Subject', NIECE],
        ['Canonical Display Name', NIECE],
        ['Personal / Given Name', 'Nadira'],
        ['Reference Type', 'Character Core'],
        ['Scope', 'The archivist’s niece'],
        ['Last Major Revision', '2026-11-01'],
      ]),
      { id: 'tgsughc1', kind: 'unsupported' as const, title: 'TAGS' },
    ]);
    w.repo.blocks.set(w.mainOf(NIECE_CORE), {
      version: 1,
      blocks: [
        { id: 'sg1', kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
        para('sg2', `The identity of ${NIECE}, the archivist’s niece.`),
      ],
    });
    insertAfter(w, O.qasr, 'qs4', para('qs4n', `${NIECE} founded the copying school in 4A 990.`));
    // The bridge learns of her pages (the hourly sweep), then the full-text index (a snapshot).
    await w.stack.runtime.tree.sweep(PROJECT, 'manual');
    await w.stack.runtime.tree.whenIdle();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-12 renaming Nadira al-Khalid never ticks an edit of “Nadira al-Khalid al-Sughra” (her text or identity facts)', async () => {
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      dryRun: true,
    });
    expect(dry.isError, dry.text).toBeFalsy();
    const touching = dryItems(dry.body).filter(
      (i) => i.ticked && JSON.stringify(i.diff ?? i.label).includes(NIECE),
    );
    // Safe: nothing that names the niece is a ticked item (at most listed for review, or unticked with a reason).
    expect(
      touching.map((i) => ({ id: i.id, label: i.label })),
      'items that rename another character',
    ).toEqual([]);
  });

  it('RN-12b approved with the plan’s ticks, the niece keeps her name in her identity facts and text', async () => {
    const id = await proposeNadira(w);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(factsOf(w, NIECE_CORE)).toMatchObject({ Subject: NIECE, 'Canonical Display Name': NIECE });
    expect(textOf(w, NIECE_CORE, 'sg2')).toBe(`The identity of ${NIECE}, the archivist’s niece.`);
    expect(textOf(w, O.qasr, 'qs4n')).toBe(`${NIECE} founded the copying school in 4A 990.`);
  });
});

describe('RN widening: restatements in other pages’ sidebar facts (one item per page, D1 (a))', () => {
  let w: RenameWorld;
  const SCHOLARS = `${OLD}, whom the plaque calls “${OLD}, keeper of charters”`;
  const ARCHIVIST = `${OLD}i copied the line “${OLD} kept the seals” into the ledger`;
  beforeAll(async () => {
    w = await renameWorld();
    w.sidebars.page(O.qasr, [
      SidebarModel.kv('kvqasr01', 'PROPERTIES', [
        ['Status', 'Authoritative'],
        ['Subject', 'Emirate of Qasr'],
        ['Reference Type', 'Polity Reference'],
        ['Notable Scholars', SCHOLARS],
        ['Last Major Revision', '2026-11-01'],
      ]),
      { id: 'tgqasr01', kind: 'unsupported' as const, title: 'TAGS' },
    ]);
    w.sidebars.page(O.tarim, [
      SidebarModel.kv('kvtarim1', 'PROPERTIES', [
        ['Status', 'Authoritative'],
        ['Subject', 'Sultanate of Tarim'],
        ['Reference Type', 'Historical Polity Reference'],
        ['Court Archivist', ARCHIVIST],
        ['Last Major Revision', '2026-11-01'],
      ]),
      { id: 'tgtarim1', kind: 'unsupported' as const, title: 'TAGS' },
    ]);
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-13 a quoted occurrence later in a fact is not ticked (nor written) with the fact’s first, plain one', async () => {
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      dryRun: true,
    });
    const item = dryItems(dry.body).find((i) => i.id === `factText:${O.qasr}`)!;
    expect(item, 'the Qasr fact item').toBeTruthy();
    const after = ((item.diff as { changes: { what: string; after: string }[] }).changes ?? []).find(
      (c) => c.what === 'Notable Scholars',
    )!.after;
    // Safe: either the item starts unticked (a quotation in it), or its write keeps the quotation.
    expect({ ticked: item.ticked, after }).toSatisfy(
      (x: { ticked: boolean; after: string }) =>
        !x.ticked || x.after.includes(`“${OLD}, keeper of charters”`),
    );
  });

  it('RN-14 a fact whose only whole-name occurrence is quoted starts unticked (never judged on “Nadira al-Khalidi”)', async () => {
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      dryRun: true,
    });
    const item = dryItems(dry.body).find((i) => i.id === `factText:${O.tarim}`)!;
    expect(item, 'the Tarim fact item').toBeTruthy();
    expect({ ticked: item.ticked, why: item.why ?? null }).toEqual({
      ticked: false,
      why: 'it is inside quotation marks',
    });
  });

  it('RN-13b approved with the plan’s ticks, both quotations still read the old name', async () => {
    const id = await proposeNadira(w);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect({
      qasr: factsOf(w, O.qasr)['Notable Scholars']!.includes(`“${OLD}, keeper of charters”`),
      tarim: factsOf(w, O.tarim)['Court Archivist']!.includes(`“${OLD} kept the seals”`),
      tarimText: factsOf(w, O.tarim)['Court Archivist'],
    }).toMatchObject({ qasr: true, tarim: true });
  });
});

describe('RN widening: a chronology row whose only occurrence is quoted (D1 (a))', () => {
  let w: RenameWorld;
  const QUOTED = `The plaque “${OLD}, keeper of charters” is set over the reading room`;
  beforeAll(async () => {
    w = await renameWorld();
    const row = tableRow(w, 'Fourth Arkonan Age', R.rowEarly);
    const cell = (row.children as Obj[])[0]!;
    (cell.children as Obj[])[0]!.content = [{ text: QUOTED }];
    w.repo.blocks.get(w.ages['Fourth Arkonan Age']!.table)!.version += 1;
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-15 the row starts unticked (inside quotation marks), and the plan’s ticks leave the quotation alone', async () => {
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      dryRun: true,
    });
    const item = dryItems(dry.body).find(
      (i) => i.id.startsWith('chronology:') && i.id.endsWith(`:${R.rowEarly}`),
    )!;
    expect(item, 'the row item').toBeTruthy();
    const id = await proposeNadira(w);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const cells = rowCells(tableRow(w, 'Fourth Arkonan Age', R.rowEarly));
    expect({ ticked: item.ticked, cell: cells[0] }).toEqual({ ticked: false, cell: QUOTED });
  });
});

describe('RN widening: a block quotation (a `quote` block, no quotation marks)', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
    insertAfter(w, O.qasr, 'qs4', {
      id: 'qsq1',
      kind: 'quote',
      children: [para('qsq2', `${OLD} kept the seals of the eastern hall, and no other.`)],
    });
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-29 an occurrence inside a quote block starts unticked, as one inside quotation marks does (D1 (a))', async () => {
    const dry = await w.call('arkona_rename', {
      subject: C.nadira,
      newName: NEW,
      given: 'Laila',
      dryRun: true,
    });
    const item = dryItems(dry.body).find((i) => i.id.includes(':qsq2:'));
    expect(item, 'the quoted paragraph is found').toBeTruthy();
    expect({ ticked: item!.ticked, why: item!.why ?? null }).toMatchObject({ ticked: false });
  });
});

void blockIn;
