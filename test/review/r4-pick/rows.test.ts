/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- mock documents */
/**
 * CR-2026-11-R4 pass 2: "Pick the right value" on a chronology row (ADR 0064 D6.2: "a chronology row's date through
 * update_timeline_event's own plan, `planEventChange`"). As test/consistency/pick-chronology.test.ts does, the edits go
 * to `Consistency.propose` (what `pick` calls with the edits it works out from the snapshot's facts) on the chronology
 * world (a confirmed Universal Chronology on the mock LegendKeeper). The attempts: the row changed in the app between
 * the run and the pick (the edit's `from` is the run's value), the row's other cells changed between the pick and its
 * approval (a bold mark, a mention: the same words), its date changed then, the cells it must keep, and Revert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KCY_STYLE, formatKcy } from '../../../src/calendar/index.js';
import { PROJECT } from '../../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from '../../chronology/world.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

type Obj = Record<string, any>;
const FOURTH = 'Fourth Arkonan Age';
let w: ChronologyWorld;

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
});
afterAll(async () => {
  await w?.close();
});

const tableDoc = () => w.repo.blocks.get(w.ages[FOURTH]!.table)!;
const rowBlock = (rowId: string): Obj =>
  ((tableDoc().blocks as Obj[]).find((b) => b.kind === 'table')!.children as Obj[]).find(
    (r) => r.id === rowId,
  )!;
/** A cell's paragraph runs: 0 the Historical Event, 1 the Date, 2 the KCY. */
const cellRuns = (rowId: string, i: number): Obj[] =>
  structuredClone(rowBlock(rowId).children[i].children[0].content as Obj[]);
/** An edit in the LegendKeeper app: a cell's runs replaced, the table's version moved on. */
function outsideCell(rowId: string, i: number, runs: Obj[]): void {
  rowBlock(rowId).children[i].children[0].content = runs;
  tableDoc().version += 1;
}
/** An edit in the LegendKeeper app: the row and its event moved to another date together (they stay in step). */
function outsideRedate(rowId: string, eventId: string, date: string): void {
  const p = CAL.parser.parse(date);
  outsideCell(rowId, 1, [{ text: date }]);
  outsideCell(rowId, 2, [{ text: formatKcy(p.kcy, DEFAULT_KCY_STYLE) }]);
  const ev = w.liveEvents(w.ages[FOURTH]!.timeline).find((e) => e.id === eventId)!;
  ev.start = p.start;
  ev.detail = p.detail;
}
const eventOf = (id: string) => w.events(w.ages[FOURTH]!.timeline).find((e) => e.id === id)!;

async function propose(rowId: string, from: string, to: string) {
  return w.stack.runtime.consistency.propose({
    projectId: PROJECT,
    edits: [
      {
        kind: 'row',
        pageId: C.resource,
        pageName: '[BSRC] Universal Chronology',
        documentId: w.ages[FOURTH]!.table,
        rowId,
        from,
        to,
      },
    ],
    title: `Pick the right value: a test row → ${to}`,
    operation: { tool: 'arkona_consistency' },
  });
}

async function approveAndWait(proposalId: string) {
  const rt = w.stack.runtime;
  await rt.policy.commands.approve('owner', proposalId);
  for (let i = 0; i < 1000; i++) {
    const p = rt.policy.proposals.get(proposalId)!;
    if (p.state === 'conflicted') return { p, job: undefined };
    const job = p.jobId ? rt.engine.queries.getJob(PROJECT, p.jobId) : undefined;
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return { p, job };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not finish');
}

describe('a chronology row (ADR 0064 D6.2, planEventChange)', () => {
  it('PK-36 the row and its event re-dated in the app after the run: the pick does not overwrite the newer date', async () => {
    // The run read "Azah 18th, 4A 1"; the row (and its event, in step) now say "Azah 19th, 4A 1".
    outsideRedate('rfour000', 'efour000', 'Azah 19th, 4A 1');
    const r = await propose('rfour000', 'Azah 18th, 4A 1', 'Azah 20th, 4A 1');
    if (r.items.length > 0) {
      // What the owner is shown: the run's value as "before".
      const shown = r.items[0]!.diff?.changes?.[0];
      const done = await approveAndWait(r.proposalId);
      expect(['succeeded', 'failed', undefined]).toContain(done.job?.status);
      void shown;
    }
    // SAFE ("a value changed since the snapshot is not planned and is listed"): the newer date is kept.
    expect(cellRuns('rfour000', 1)).toEqual([{ text: 'Azah 19th, 4A 1' }]);
    expect(eventOf('efour000').start).toBe(CAL.parser.parse('Azah 19th, 4A 1').start);
  });

  it('PK-37 a bold mark added to the row’s Historical Event between the pick and approval is kept', async () => {
    const r = await propose('rfour006', 'Kumikas 3rd, 4A 881', 'Kumikas 4th, 4A 881');
    expect(r.notPlanned).toEqual([]);
    // Another writer marks part of the event bold (the same words).
    outsideCell('rfour006', 0, [{ text: 'Ashgate falls to the ' }, { text: 'Isar host', bold: true }]);
    const done = await approveAndWait(r.proposalId);
    // SAFE: either the job stops (the row is not as planned) or the mark is kept.
    if (done.job?.status === 'succeeded')
      expect(cellRuns('rfour006', 1)).toEqual([{ text: 'Kumikas 4th, 4A 881' }]);
    expect(cellRuns('rfour006', 0)).toEqual([
      { text: 'Ashgate falls to the ' },
      { text: 'Isar host', bold: true },
    ]);
  });

  it('PK-38 a mention added to the row’s Historical Event between the pick and approval is kept', async () => {
    const r = await propose('rfour005', 'Jehet 11th - 18th, 4A 424', 'Jehet 12th - 18th, 4A 424');
    expect(r.notPlanned, JSON.stringify(r.notPlanned)).toEqual([]);
    outsideCell('rfour005', 0, [
      { text: 'The ' },
      { mention: { resourceId: C.plans, text: 'Week of Lanterns' } },
    ]);
    const done = await approveAndWait(r.proposalId);
    if (done.job?.status === 'succeeded')
      expect(cellRuns('rfour005', 1)).toEqual([{ text: 'Jehet 12th - 18th, 4A 424' }]);
    expect(cellRuns('rfour005', 0)).toEqual([
      { text: 'The ' },
      { mention: { resourceId: C.plans, text: 'Week of Lanterns' } },
    ]);
  });

  it('PK-39 the row re-dated in the app between the pick and approval: the job stops, the newer date is kept', async () => {
    const r = await propose('rfour002', 'Unknown, 4A 101', '4A 102');
    expect(r.notPlanned, JSON.stringify(r.notPlanned)).toEqual([]);
    outsideRedate('rfour002', 'efour002', '4A 103');
    const done = await approveAndWait(r.proposalId);
    expect(done.job?.status).not.toBe('succeeded');
    expect(cellRuns('rfour002', 1)).toEqual([{ text: '4A 103' }]);
    expect(eventOf('efour002').start).toBe(CAL.parser.parse('4A 103').start);
  });

  let pickJob: string;
  it('PK-40 the pick keeps every run of the row’s other cells (a bold and a mention present before the pick)', async () => {
    outsideCell('rfour007', 0, [
      { text: 'The year of the ' },
      { text: 'long', italic: true },
      { text: ' harvest at ' },
      { mention: { resourceId: C.plans, text: 'the plans' } },
    ]);
    const before = cellRuns('rfour007', 0);
    const r = await propose('rfour007', '4A 881', '4A 882');
    expect(r.notPlanned, JSON.stringify(r.notPlanned)).toEqual([]);
    const done = await approveAndWait(r.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    pickJob = done.job!.id;
    expect(cellRuns('rfour007', 0)).toEqual(before);
    expect(cellRuns('rfour007', 1)).toEqual([{ text: '4A 882' }]);
  });

  it('PK-41 Revert of the pick’s chronology job puts the row (Date, KCY) and its event back together', async () => {
    expect(pickJob).toBeDefined();
    const rt = w.stack.runtime;
    // As `pick` records it (Revert recognises a pick's job by its recorded proposal).
    const proposal = rt.policy.proposals
      .list({ project: PROJECT, limit: 50 })
      .find((p) => p.jobId === pickJob)!;
    w.stack.db
      .prepare(
        `INSERT INTO consistency_picks (id, project_id, finding_id, audit_finding_id, value, side, picked_by, picked_at,
           proposal_id, items) VALUES (?, ?, ?, NULL, ?, NULL, 'owner', ?, ?, '[]')`,
      )
      .run('cpk_r4rows00000001', PROJECT, 'cf_00000000000000000000', '4A 882', Date.now(), proposal.id);
    const eventBefore = eventOf('efour007');
    const res = (await rt.reverts.revert('owner', PROJECT, pickJob, {})) as Obj;
    expect(res.status, JSON.stringify(res)).toBe('submitted');
    for (let i = 0; i < 1000; i++) {
      const j = rt.engine.queries.getJob(PROJECT, String(res.revertJobId))!;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) {
        expect(j.status, JSON.stringify(j.lastError ?? null)).toBe('succeeded');
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const p = CAL.parser.parse('4A 881');
    expect(cellRuns('rfour007', 1)).toEqual([{ text: '4A 881' }]);
    expect(cellRuns('rfour007', 2)).toEqual([{ text: formatKcy(p.kcy, DEFAULT_KCY_STYLE) }]);
    expect(eventOf('efour007').start).toBe(p.start);
    expect(eventOf('efour007').start).not.toBe(eventBefore.start);
  });
});
