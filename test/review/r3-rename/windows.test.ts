/**
 * CR-2026-11 round 3 (renames): the per-step locks (ADR 0058 amendment, "The locks (chosen)"). A rename holds no
 * job-level lock: each write takes its own page's (document's, asset's) lock only for itself, and "its in-lock re-check
 * is the rebase". These attempts look for a window where another writer slips in and is overwritten without a word.
 * Against the mock LegendKeeper of the rename world only. Every test asserts the SAFE behaviour; a failing test is a
 * finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { C, P, PROJECT, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import {
  NEW,
  OLD,
  OWNER_ORIGIN,
  approveAs,
  settle,
  factsOf,
  intercept,
  proposeNadira,
  tableRow,
  type Obj,
} from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const AGE = 'Fourth Arkonan Age';

describe('RN windows: writes LegendKeeper does not version', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-20 an asset renamed in the app after the job’s check is never overwritten by the rename', async () => {
    const id = await proposeNadira(w);
    const THEIRS = 'Nadira al-Khalid - Primary Reference - Portrait (approved).png';
    // The job is under way (its first block write): someone renames the portrait in the app.
    intercept(w, 'PUT', /\/blocks\/an3$/, (n) => {
      if (n === 0) w.assets.outsideRename('imgpng01', THEIRS);
      return undefined;
    });
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const skipped = w.stack.runtime.engine.skippedItems(PROJECT, done.jobId!).map((s) => s.item);
    // Safe: their name stands (the item skipped, changed meanwhile), as amendment A promises for an asset.
    expect({
      name: w.assets.assets.get('imgpng01')!.name,
      skipped: skipped.includes('asset:imgpng01'),
    }).toEqual({
      name: THEIRS,
      skipped: true,
    });
  });

  it('RN-21 a timeline event renamed after the chronology check is never overwritten by the rename', async () => {
    const w2 = await renameWorld();
    try {
      const id = await proposeNadira(w2);
      const timeline = w2.ages[AGE]!.timeline;
      const THEIRS = 'Nadira al-Khalid founds the Great Reading Room';
      // Between the chronology's check and the event's own write (as the linked row is written), another writer
      // renames the event (sync_timeline_event, or the app).
      intercept(w2, 'PUT', new RegExp(`/blocks/${R.rowLinked}$`), (n) => {
        if (n === 0) w2.liveEvents(timeline).find((e) => e.id === R.event)!.name = THEIRS;
        return undefined;
      });
      const done = await approveAs(w2, id);
      expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
      const name = w2.liveEvents(timeline).find((e) => e.id === R.event)!.name;
      const skipped = w2.stack.runtime.engine.skippedItems(PROJECT, done.jobId!).map((s) => s.item);
      // Safe: their name stands, or the rename re-applies its change to it ("Laila … Great Reading Room"); never the
      // planned name over theirs without a word.
      expect(
        name === THEIRS || name === THEIRS.replace(OLD, NEW) || skipped.includes(`chronology:${R.rowLinked}`),
        String(name),
      ).toBe(true);
    } finally {
      await w2.close();
    }
  });
});

describe('RN windows: a chronology row written from the plan', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-22 formatting added to a row while the proposal waits is never lost (the row is not written from the plan)', async () => {
    const id = await proposeNadira(w);
    // While the proposal waits, the owner bolds "reading room" in the row (its words unchanged).
    const row = tableRow(w, AGE, R.rowLinked);
    const para = ((row.children as Obj[])[0]!.children as Obj[])[0]!;
    para.content = [{ text: `${OLD} founds the ` }, { text: 'reading room', bold: true }];
    w.repo.blocks.get(w.ages[AGE]!.table)!.version += 1;
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const now = ((tableRow(w, AGE, R.rowLinked).children as Obj[])[0]!.children as Obj[])[0]!
      .content as Obj[];
    const skipped = w.stack.runtime.engine.skippedItems(PROJECT, done.jobId!).map((s) => s.item);
    // Safe: the bold run is still there (renamed or not), or the item was skipped as changed meanwhile.
    expect(
      now.some((r) => r.bold === true) || skipped.includes(`chronology:${R.rowLinked}`),
      JSON.stringify(now),
    ).toBe(true);
  });
});

describe('RN windows: a page of the set moved while the proposal waits', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-23 the rename’s re-placing never moves a page back to where it was planned', async () => {
    const id = await proposeNadira(w);
    // While the proposal waits, the owner files her index (and so her whole set) under Humans: an ordinary move.
    w.repo.outside.move(C.nadiraIndex, C.humans);
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    // Safe: the owner's move stands (the index renamed in place), or the job stops and says so.
    expect(w.repo.live(C.nadiraIndex)!.parentId).toBe(C.humans);
  });

  it('RN-23b a sibling moved away meanwhile does not leave the set half-renamed for good (Resume completes it)', async () => {
    const w2 = await renameWorld();
    try {
      const id = await proposeNadira(w2);
      // The owner files the Biography under Tarek Basri's index while the proposal waits; it stays there.
      w2.repo.outside.move(P.nadiraBio, R.tarekIndex);
      const done = await approveAs(w2, id);
      if (done.job?.status !== 'succeeded') {
        const out = await w2.stack.runtime.resume.resume(
          PROJECT,
          done.jobId!,
          { kind: 'owner' },
          OWNER_ORIGIN,
        );
        expect(out.status).toBe('resumed');
        const job = await settle(w2, done.jobId!);
        expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
      }
      expect(w2.repo.live(P.nadiraBio)!.name).toBe(`[BSRC] ${NEW} - Biography`);
      expect(factsOf(w2, C.nadira).Subject).toBe(NEW);
    } finally {
      await w2.close();
    }
  });
});

describe('RN windows: a page’s chained writes (sidebar rows)', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-24 another row changed between two of the rename’s fact writes on one page is kept (the chain is rebased)', async () => {
    const id = await proposeNadira(w);
    // Right after the Subject row is written, another writer changes the Core's Scope row.
    w.sidebars.after(/^PATCH \/resources\/nadircor\/properties\/kvnadirc\/rows\/kvnadircr5\/?$/, 0, () =>
      w.sidebars.outside(C.nadira, (sb) => {
        const row = sb.props.find((p) => p.kind === 'keyValue')!.rows!.find((r) => r.key === 'Scope')!;
        row.content = [{ text: 'An archivist of Menkhet (revised)' }];
      }),
    );
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(factsOf(w, C.nadira)).toMatchObject({
      Subject: NEW,
      'Canonical Display Name': NEW,
      Scope: 'An archivist of Menkhet (revised)',
    });
  });

  it('RN-25 the next identity fact changed between two of the rename’s writes stops the job (core), never overwritten', async () => {
    const w2 = await renameWorld();
    try {
      const id = await proposeNadira(w2);
      w2.sidebars.after(/^PATCH \/resources\/nadircor\/properties\/kvnadirc\/rows\/kvnadircr5\/?$/, 0, () =>
        w2.sidebars.outside(C.nadira, (sb) => {
          const kv = sb.props.find((p) => p.kind === 'keyValue')!;
          kv.rows!.find((r) => r.key === 'Canonical Display Name')!.content = [
            { text: 'Nadira bint Khalid' },
          ];
        }),
      );
      const done = await approveAs(w2, id);
      expect(done.job?.status).toBe('failed');
      expect(factsOf(w2, C.nadira)['Canonical Display Name']).toBe('Nadira bint Khalid');
      const stopped = done.job!.steps.find((s) => s.status === 'failed')!;
      expect(stopped.error).toMatchObject({ code: 'VERSION_CONFLICT' });
    } finally {
      await w2.close();
    }
  });
});

describe('RN windows: two documents of one page', () => {
  let w: RenameWorld;
  let notes = '';
  beforeAll(async () => {
    w = await renameWorld();
    const doc = w.repo.outside.addDocument('qasrref1', 'Notes');
    notes = doc.id;
    w.repo.blocks.set(notes, {
      version: 1,
      blocks: [
        { id: 'qn1', kind: 'paragraph', content: [{ text: 'Notes on the emirate.' }] },
        { id: 'qn2', kind: 'paragraph', content: [{ text: `${OLD} left a note in the margin.` }] },
      ],
    });
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('RN-24c an edit to the second document between the page’s two documents’ writes is kept, and its item rebased', async () => {
    const id = await proposeNadira(w);
    // As the first document's restatement is written, someone edits the other document of the same page.
    intercept(w, 'PUT', /\/blocks\/qs4$/, (n) => {
      if (n === 0) {
        const d = w.repo.blocks.get(notes)!;
        (d.blocks as Obj[])[0]!.content = [{ text: 'Notes on the emirate, revised.' }];
        d.version += 1;
      }
      return undefined;
    });
    const done = await approveAs(w, id);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const d = w.repo.blocks.get(notes)!.blocks as Obj[];
    expect(d.map((b) => ((b.content as Obj[])[0] as { text: string }).text)).toEqual([
      'Notes on the emirate, revised.',
      `${NEW} left a note in the margin.`,
    ]);
  });
});
