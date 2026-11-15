/**
 * v2 E5 hotfix: "Propose a fix" for a `count_mismatch` (the owner's test world, 15 November 2026: the 4A row of the Main
 * table said 337 against 336 table rows, and could only be fixed by hand). End to end through the real stack against the
 * mock chronology: ONE ordinary proposal setting the age's Event count cell in the Main table to the age table's row
 * count, captured whatever the caller, both sides re-read live; approved, it changes only that cell (its marks kept);
 * a count that already matches gives "nothing to fix"; a Main version change, or a table row added, between proposal and
 * approval conflicts and writes nothing; a missing Main row has no fix. The thousands-separator style is checked on the
 * planner itself (this world's tables are under 1,000 rows).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planCountFix } from '../../src/chronology/count.js';
import { DEFAULT_CHRONOLOGY, type ChronologyConfig } from '../../src/chronology/settings.js';
import { PROJECT } from '../tools/helpers.js';
import { CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
let w: ChronologyWorld;
const FOURTH = 'Fourth Arkonan Age';

const rt = () => w.stack.runtime;
const chronology = () => rt().chronology;
const mainDoc = () => w.repo.blocks.get(w.mainDoc)! as { version: number; blocks: Obj[] };
const mainTable = () => mainDoc().blocks.find((b) => b.kind === 'table')!;
const mainRowOf = (age: string) =>
  (mainTable().children as Obj[]).find((r) => r.id === w.ages[age]!.mainRow)!;
/** The count cell's paragraph of an age's Main row (an edit "in the app": no request, the version bumped). */
const countParagraph = (age: string) =>
  ((mainRowOf(age).children as Obj[])[1]!.children as Obj[])[0] as { id: string; content: Obj[] };
const setCountInApp = (age: string, content: Obj[]) => {
  countParagraph(age).content = content;
  mainDoc().version++;
};
const tableRowCount = (age: string) => w.rows(age).length;
const check = async () => {
  await chronology().check(PROJECT, 'manual', 'P0');
  return chronology().store.lastCheck(PROJECT)!;
};
const approve = async (id: string) => {
  const proposals = rt().policy.proposals;
  await rt().policy.commands.approve('owner', id);
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  return proposals.get(id)!;
};

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
});
afterAll(async () => w.close());

describe('Propose a fix for a count mismatch', () => {
  it('ONE proposal; approved, it changes only that cell, keeping its marks; the check then finds nothing', async () => {
    const rows = tableRowCount(FOURTH);
    // The test world's drift: the Main table says one more than the table has (bold, as the owner writes it).
    setCountInApp(FOURTH, [{ text: String(rows + 1), bold: true }]);
    const found = await check();
    const mismatch = found.findings.find((f) => f.kind === 'count_mismatch' && f.age === FOURTH)!;
    expect(mismatch.detail).toMatchObject({ main: String(rows + 1), rows });
    const events = Number(mismatch.detail!.events);

    const before = structuredClone(mainDoc());
    const done = w.mark();
    const r = await chronology().proposeFix('owner', PROJECT, { kind: 'count', age: FOURTH });
    const cost = done();
    expect(cost.writes).toBe(0); // nothing is written until the owner approves
    // The calendar, the Main document, the age table, one page of events per 100, and the proposal's capture of the
    // Main document's version (a Main change before approval conflicts).
    expect(cost.reads).toBe(4 + Math.ceil(events / 100));
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    const summary = `${FOURTH}: Main ${rows + 1} → ${rows} (table rows ${rows}; timeline events ${events})`;
    expect(r.summary).toBe(summary);
    const p = rt().policy.proposals.get(r.proposalId)!;
    // An ordinary proposal (a content edit, ADR 0036 decision 6, option (a)): no canon approval, proposed by the system.
    expect(p).toMatchObject({ state: 'pending', requiresCanonicalApproval: false, summary });
    expect(mainDoc()).toEqual(before);

    const approved = await approve(r.proposalId);
    expect(approved.state, JSON.stringify(approved)).toBe('executed');
    expect(w.count(FOURTH)).toBe(String(rows));
    // Only that cell's paragraph changed: its text, with the run's marks and every id kept.
    const expected = structuredClone(before);
    const t = expected.blocks.find((b) => b.kind === 'table')!;
    const row = (t.children as Obj[]).find((x) => x.id === w.ages[FOURTH]!.mainRow)!;
    (((row.children as Obj[])[1]!.children as Obj[])[0] as Obj).content = [
      { text: String(rows), bold: true },
    ];
    expect(mainDoc().blocks).toEqual(expected.blocks);
    expect(mainDoc().version).toBe(before.version + 1); // one write
    expect((await check()).findings).toEqual([]);
    expect(rt().policy.store.listAudit({ action: 'chronology.propose_fix' })[0]).toMatchObject({
      actor: 'owner',
      target: PROJECT,
    });
    // The change is recorded like the timeline tools' (Chronology page, "Recent changes").
    const rec = chronology().store.byJob(PROJECT, approved.jobId!);
    expect(rec).toMatchObject({ tool: 'chronology_count_fix', state: 'complete', ages: [FOURTH] });
  });

  it('a count that already matches gives "nothing to fix", and proposes nothing', async () => {
    const proposals = rt().policy.proposals.list({ project: PROJECT }).length;
    const r = await chronology().proposeFix('owner', PROJECT, { kind: 'count', age: FOURTH });
    expect(r.status).toBe('nothing_to_do');
    expect(r.status === 'nothing_to_do' && r.message).toMatch(/nothing to fix/);
    expect(rt().policy.proposals.list({ project: PROJECT })).toHaveLength(proposals);
  });

  it('a Main version change between the proposal and its approval conflicts as usual: nothing is written', async () => {
    const rows = tableRowCount(FOURTH);
    setCountInApp(FOURTH, [{ text: String(rows + 2) }]);
    const r = await chronology().proposeFix('owner', PROJECT, { kind: 'count', age: FOURTH });
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    // Someone edits another block of the Main document in the app before the owner approves.
    const intro = mainDoc().blocks.find((b) => b.id === 'mp1')!;
    intro.content = [{ text: 'The index of the ages, edited.' }];
    mainDoc().version++;
    const version = mainDoc().version;
    const p = await approve(r.proposalId);
    expect(p.state).toBe('conflicted');
    expect(w.count(FOURTH)).toBe(String(rows + 2));
    expect(mainDoc().version).toBe(version);
  });

  it('a table row added between the proposal and its approval stops the job inside the lock: nothing is written', async () => {
    const rows = tableRowCount(FOURTH);
    const r = await chronology().proposeFix('owner', PROJECT, { kind: 'count', age: FOURTH });
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    // A row added to the 4A table in the app: the count planned is no longer the table's.
    const table = (
      w.repo.blocks.get(w.ages[FOURTH]!.table)! as { version: number; blocks: Obj[] }
    ).blocks.find((b) => b.kind === 'table')!;
    const last = (table.children as Obj[]).at(-1)!;
    const copy = structuredClone(last);
    copy.id = 'rfourzzz';
    (table.children as Obj[]).push(copy);
    (w.repo.blocks.get(w.ages[FOURTH]!.table)! as { version: number }).version++;
    const p = await approve(r.proposalId);
    expect(p.state).toBe('conflicted');
    expect(w.count(FOURTH)).toBe(String(rows + 2));
    // Put the table back; a fresh proposal then sets the count.
    (table.children as Obj[]).pop();
    const again = await chronology().proposeFix('owner', PROJECT, { kind: 'count', age: FOURTH });
    if (again.status !== 'proposal_captured') throw new Error('not captured');
    expect((await approve(again.proposalId)).state).toBe('executed');
    expect(w.count(FOURTH)).toBe(String(rows));
  });

  it('a Main table with no row for the age has no fix, and says so', async () => {
    const t = mainTable();
    const kids = t.children as Obj[];
    const at = kids.findIndex((r) => r.id === w.ages[FOURTH]!.mainRow);
    const [removed] = kids.splice(at, 1);
    mainDoc().version++;
    try {
      const found = await check();
      const f = found.findings.find((x) => x.kind === 'count_mismatch' && x.age === FOURTH)!;
      expect(f.message).toMatch(/has no row/);
      expect(f.detail).toMatchObject({ main: null });
      const refused = chronology().proposeFix('owner', PROJECT, { kind: 'count', age: FOURTH });
      await expect(refused).rejects.toMatchObject({ code: 'MAIN_ROW_NOT_FOUND' });
      await expect(refused).rejects.toThrow(/no fix/);
    } finally {
      kids.splice(at, 0, removed!);
      mainDoc().version++;
    }
  });
});

// ------------------------------------------------------------------------------------------ the planner on its own

const t = (text: string) => [{ text }];
const cell = (id: string, text: string, marks: Obj = {}) => ({
  id: `${id}c`,
  kind: 'tableCell',
  children: [{ id: `${id}p`, kind: 'paragraph', content: [{ text, ...marks }] }],
});
const row = (id: string, texts: string[], marks: Obj = {}) => ({
  id,
  kind: 'tableRow',
  children: texts.map((x, i) => cell(`${id}${i}`, x, i === 1 ? marks : {})),
});

describe('the count fix planner', () => {
  const config: ChronologyConfig = {
    ...DEFAULT_CHRONOLOGY,
    confirmed: true,
    resourceId: 'chrono01',
    mainDocumentId: 'maindoc1',
    calendarId: 'cal',
    ages: [
      {
        name: 'Archon Age',
        eraId: 'era',
        tableDocumentId: 'tabledoc',
        timelineDocumentId: 'timeline',
        laneId: 'lane1',
        laneName: 'Events',
        mainRowId: 'marchon1',
      },
    ],
  } as unknown as ChronologyConfig;
  const main = (count: string, other: string) => ({
    version: 'v1',
    blocks: [
      {
        id: 'mtab',
        kind: 'table',
        children: [
          row('mhdr', ['Age', 'Event count', 'Complete dated table', 'Interactive timeline']),
          row('marchon1', ['Archon Age', count, '', ''], { italic: true }),
          row('mfirst01', ['First Age', other, '', '']),
        ],
      },
      { id: 'after1', kind: 'paragraph', content: t('Untouched.') },
    ],
  });
  const ageTable = (n: number) => ({
    version: 'v1',
    blocks: [
      {
        id: 'atab',
        kind: 'table',
        children: [
          row('ahdr', ['Historical Event', 'Date', 'KCY']),
          ...Array.from({ length: n }, (_, i) =>
            row(`r${String(i).padStart(6, '0')}`, [`Event ${i}`, 'x', '']),
          ),
        ],
      },
    ],
  });
  const reader =
    (mainBlocks: Obj, table: Obj, events = 2) =>
    (op: string, params: Obj) => {
      const path = (params.path ?? {}) as Obj;
      if (op === 'getDocumentBlocks')
        return Promise.resolve(path.documentId === 'maindoc1' ? mainBlocks : table);
      if (op === 'listEvents')
        return Promise.resolve({
          data: Array.from({ length: events }, (_, i) => ({
            id: `e${i}`,
            laneId: 'lane1',
            start: i,
            detail: 3,
          })),
          hasMore: false,
        });
      return Promise.reject(new Error(`unexpected ${op}`));
    };

  it('keeps the Main table’s thousands separators and the cell’s marks, and names both figures', async () => {
    const plan = await planCountFix({
      config,
      calendar: CAL,
      read: reader(main('1,205', '2,310'), ageTable(1204)),
      age: config.ages[0]!,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.action).toBe('set');
    expect(plan.main).toMatchObject({ text: '1,205', value: 1205, after: '1,204' });
    expect(plan.summary).toBe('Archon Age: Main 1,205 → 1,204 (table rows 1204; timeline events 2)');
    expect(plan.ctx.counts.marchon1).toEqual({ paragraphId: 'marchon11p', text: '1,204', age: 'Archon Age' });
    expect(plan.ctx.expectBefore).toEqual({ marchon1: 1205 });
    expect(plan.writes.map((x) => x.kind)).toEqual(['row.count', 'count']);
    expect(plan.writes[1]).toMatchObject({ rowId: 'marchon1', delta: -1, documentId: 'maindoc1' });
  });

  it('writes no separator when the Main table writes none', async () => {
    const plan = await planCountFix({
      config,
      calendar: CAL,
      read: reader(main('1205', '2310'), ageTable(1204)),
      age: config.ages[0]!,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.main.after).toBe('1204');
  });

  it('refuses a count that is not a number', async () => {
    const plan = await planCountFix({
      config,
      calendar: CAL,
      read: reader(main('about 300', '12'), ageTable(3)),
      age: config.ages[0]!,
    });
    expect(plan).toMatchObject({ ok: false, code: 'COUNT_UNREADABLE' });
  });
});
