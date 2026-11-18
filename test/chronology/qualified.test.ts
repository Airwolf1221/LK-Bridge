/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * Chronology II (v2 E6, ADR 0048) end to end through the real server, the official MCP client, the policy layer and the
 * job engine against the mock chronology:
 *
 * - qualified rows are read by their anchor: the check offers their events, never rewrites the table, counts their
 *   qualifier words as text, and still reports what stays unreadable (with why);
 * - `sync_timeline_event` makes a qualified row's event for each shape: a year, a month, a range, an open start, an open
 *   end, an approximate date; the event's name keeps the row's opening words and carries the Date cell;
 * - the Divan Heirage pairing of the Fourth Age (16 November 2026): the range row takes the range event, the one-day
 *   row is offered its own;
 * - the table-only mark: set, hidden, and back again when the row's text changes;
 * - an event without a row: "Propose a fix" deletes only the event, naming it and the nearest rows; the MCP route;
 * - the counts on an Arkona-shaped table of 63 qualified rows.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_KCY_STYLE, formatKcy, parseQualified } from '../../src/calendar/index.js';
import { PROJECT } from '../tools/helpers.js';
import { ARKONA_QUALIFIED } from '../fixtures/chronology/qualified-forms.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
const FOURTH = 'Fourth Arkonan Age';

/** The helpers every world of this file uses. */
function helpers(get: () => ChronologyWorld) {
  const w = () => get();
  const table = () => w().ages[FOURTH]!.table;
  const tl = () => w().ages[FOURTH]!.timeline;
  const tableBlock = () => (w().repo.blocks.get(table())!.blocks as Obj[]).find((b) => b.kind === 'table')!;
  const cell = (id: string, text: string) => ({
    id: `${id}c`,
    kind: 'tableCell',
    children: [{ id: `${id}p`, kind: 'paragraph', content: [{ text }] }],
  });
  const rowBlock = (id: string, date: string, description: string, kcy: string) => ({
    id,
    kind: 'tableRow',
    children: [cell(`${id}a`, description), cell(`${id}b`, date), cell(`${id}c`, kcy)],
  });
  /** Adds a row "in the app" (no request): at the end, or before the row `before`. */
  const addRow = (id: string, date: string, description: string, kcy: string, before?: string) => {
    const rows = tableBlock().children as Obj[];
    const at = before ? rows.findIndex((r) => r.id === before) : rows.length;
    rows.splice(at < 0 ? rows.length : at, 0, rowBlock(id, date, description, kcy));
  };
  const setCell = (rowId: string, col: 0 | 1 | 2, text: string) => {
    const row = (tableBlock().children as Obj[]).find((r) => r.id === rowId)!;
    const para = ((row.children as Obj[])[col]!.children as Obj[])[0]!;
    para.content = [{ text }];
  };
  /** The Main table's 4A count set to the table's rows (so the check reports no count mismatch). */
  const syncCount = () => {
    const main = (w().repo.blocks.get(w().mainDoc)!.blocks as Obj[]).find((b) => b.kind === 'table')!;
    const row = (main.children as Obj[]).find((r) => r.id === w().ages[FOURTH]!.mainRow)!;
    const para = ((row.children as Obj[])[1]!.children as Obj[])[0]!;
    para.content = [{ text: String((tableBlock().children as Obj[]).length - 1) }];
  };
  const events = () => w().events(tl());
  const check = async () => {
    await w().stack.runtime.chronology.check(PROJECT, 'manual', 'P0');
    return w().stack.runtime.chronology.store.lastCheck(PROJECT)!;
  };
  const approve = async (id: string) => {
    const proposals = w().stack.runtime.policy.proposals;
    await w().stack.runtime.policy.commands.approve('owner', id);
    for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
      await new Promise((res) => setTimeout(res, 20));
    return proposals.get(id)!;
  };
  const tableJson = () => JSON.stringify(w().repo.blocks.get(table()));
  return { table, tl, addRow, setCell, syncCount, events, check, approve, tableJson };
}

const budget = {
  env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
  limits: { 'key-min': 5000, 'write-min': 2000 },
};

// ============================================================================================ qualified rows

describe('qualified rows: read by their anchor, never rewritten (ADR 0048)', () => {
  let w: ChronologyWorld;
  let client: Client;
  const h = helpers(() => w);
  const call = (tool: string, args: Record<string, unknown>) =>
    w.stack.call(client, tool, { project: 'test', ...args });
  /** One qualified row per shape, and one the reader leaves unread. */
  const ROWS = {
    year: {
      id: 'rqyear01',
      date: 'c. 4A 563; exact date unresolved',
      description: 'The Menkhet charter is sealed',
      kcy: '1,250,870 (approximate)',
    },
    month: {
      id: 'rqmonth1',
      date: 'Third week of Isar, 4A 566; exact day unresolved',
      description: 'The Isar tribunal convenes',
      kcy: '1,250,873',
    },
    range: {
      id: 'rqrange1',
      date: 'After Isar 6th and before Zarzakh 29th, 4A 610; exact date unresolved',
      description: 'The Selyros embassy travels north',
      kcy: '1,250,917',
    },
    openStart: {
      id: 'rqopens1',
      date: 'By 4A 623; exact comparison date recorded separately',
      description: 'Mehrana completes her comparative study',
      kcy: '1,250,930 (year only)',
    },
    openEnd: {
      id: 'rqopene1',
      date: 'Days following Isar 19th, 4A 613; exact date unresolved',
      description: 'The trial of the envoys',
      kcy: '1,250,920 onward',
    },
    approximate: {
      id: 'rqappro1',
      date: 'Approximately House Year 8 (c. 4A 578); exact dates unresolved',
      description: 'House Menkhet raises its second hall',
      kcy: 'Unassigned - approximate date',
    },
  } as const;
  const UNREAD = {
    id: 'rqunread',
    date: 'Approximately nine months after Isar 1st, 4A 623; precise day unassigned',
    description: 'A child is born to the house',
    kcy: 'Unassigned',
  };

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    client = await w.stack.connect();
    for (const r of [...Object.values(ROWS), UNREAD]) h.addRow(r.id, r.date, r.description, r.kcy);
    h.syncCount();
  });
  afterAll(() => w?.close());

  it('the check offers each certain row’s event, reports the relative offset as unreadable with why, and no KCY or style finding', async () => {
    const c = await h.check();
    const of = (kind: string) => c.findings.filter((f) => f.kind === kind);
    expect(
      of('row_without_event')
        .map((f) => f.detail!.rowId)
        .sort(),
    ).toEqual(
      Object.values(ROWS)
        .map((r) => r.id)
        .sort(),
    );
    expect(of('row_without_event').find((f) => f.detail!.rowId === ROWS.year.id)!.detail).toMatchObject({
      reading: 'year 4A 563, approximate',
    });
    expect(of('unreadable_date').map((f) => [f.detail!.rowId, f.detail!.code])).toEqual([
      [UNREAD.id, 'DATE_RELATIVE'],
    ]);
    expect(of('unreadable_date')[0]!.message).toMatch(/relative offset/);
    // Reported once: an unreadable row is not also a row without an event (no fix could make one).
    expect(of('row_without_event').some((f) => f.detail!.rowId === UNREAD.id)).toBe(false);
    expect(of('wrong_kcy')).toEqual([]);
    expect(of('date_text_differs')).toEqual([]);
    expect(c.findings.map((f) => f.kind).sort()).toEqual([
      ...Array<string>(6).fill('row_without_event'),
      'unreadable_date',
    ]);
    const age = c.ages.find((a) => a.age === FOURTH)!;
    expect(age.dates).toEqual({ qualified: 6, unreadable: 1, tableOnly: 0 });
  });

  it('a wrong KCY on a qualified row is reported; its words are not', async () => {
    h.setCell(ROWS.year.id, 2, '1,250,871 (approximate)');
    const c = await h.check();
    const wrong = c.findings.filter((f) => f.kind === 'wrong_kcy');
    expect(wrong.map((f) => f.detail!.rowId)).toEqual([ROWS.year.id]);
    expect(wrong[0]!.message).toMatch(/should be 1,250,870/);
    h.setCell(ROWS.year.id, 2, ROWS.year.kcy);
  });

  it.each(Object.entries(ROWS))(
    'sync_timeline_event makes the %s row’s event: the anchor’s minutes and precision, the Date cell in the name',
    async (_shape, r) => {
      const before = h.tableJson();
      const count = w.count(FOURTH);
      const res = await call('sync_timeline_event', { row: { row_id: r.id, age: FOURTH } });
      expect(res.body, res.text).toMatchObject({ status: 'written', verified: true, action: 'create' });
      const q = parseQualified(CAL.parser, r.date);
      if (!q.ok) throw new Error(q.message);
      expect(res.body.reading).toMatchObject({
        anchor: q.reading.anchorText,
        qualifier: q.reading.qualifier,
      });
      const made = h.events().filter((e) => String(e.name).startsWith(r.description));
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({
        name: `${r.description} – ${r.date}`,
        start: q.reading.date.start,
        detail: q.reading.date.detail,
        uri: `lk://resources/${C.resource}/docs/${h.table()}`,
      });
      expect(made[0]!.end ?? null).toBe(q.reading.date.end);
      // The table is the authority and is never rewritten; the count is the table's row count.
      expect(h.tableJson()).toBe(before);
      expect(w.count(FOURTH)).toBe(count);
    },
  );

  it('the shapes as the timeline stores them: year, month, range, a point at an open bound', () => {
    const named = (r: { description: string }) =>
      h.events().find((e) => String(e.name).startsWith(r.description))!;
    expect(named(ROWS.year)).toMatchObject({ detail: 1, start: CAL.parser.parse('4A 563').start });
    expect(named(ROWS.month)).toMatchObject({ detail: 2, start: CAL.parser.parse('Isar 4A 566').start });
    const range = CAL.parser.parse('Isar 6th - Zarzakh 29th, 4A 610');
    expect(named(ROWS.range)).toMatchObject({ detail: 3, start: range.start, end: range.end });
    expect(named(ROWS.openStart)).toMatchObject({ detail: 1, start: CAL.parser.parse('4A 623').start });
    expect(named(ROWS.openStart).end).toBeUndefined();
    expect(named(ROWS.openEnd)).toMatchObject({
      detail: 3,
      start: CAL.parser.parse('Isar 19th, 4A 613').start,
    });
    expect(named(ROWS.approximate)).toMatchObject({ detail: 1, start: CAL.parser.parse('4A 578').start });
  });

  it('the check then pairs them (by link) and reports only what stays unreadable', async () => {
    const c = await h.check();
    expect(c.findings.map((f) => f.kind)).toEqual(['unreadable_date']);
    const age = c.ages.find((a) => a.age === FOURTH)!;
    const pairs = age.pairs as { rowId: string; by: string; qualified?: boolean }[];
    for (const r of Object.values(ROWS))
      expect(pairs.find((p) => p.rowId === r.id)).toMatchObject({ by: 'link', qualified: true });
    expect((age.pairedBy as Record<string, number>).link).toBe(6);
  });

  it('a qualified row named by its Date cell as the table shows it, with its description', async () => {
    const r = await call('sync_timeline_event', {
      row: { date: ROWS.range.date, description: ROWS.range.description },
    });
    expect(r.body, r.text).toMatchObject({ status: 'nothing_to_do' });
  });

  it('a row marked table-only is never given an event (ROW_TABLE_ONLY)', async () => {
    h.addRow('rqtonly1', 'c. 4A 640; exact date unresolved', 'A private matter of the house', 'Unassigned');
    h.syncCount();
    await w.stack.runtime.chronology.markTableOnly('owner', PROJECT, { age: FOURTH, rowId: 'rqtonly1' });
    const r = await call('sync_timeline_event', { row: { row_id: 'rqtonly1', age: FOURTH } });
    expect(r.body.error.code, r.text).toBe('ROW_TABLE_ONLY');
  });
});

// ============================================================================================ the Divan Heirage

describe('the Divan Heirage (Fourth Age, 16 November 2026): the range row takes the range event', () => {
  let w: ChronologyWorld;
  const h = helpers(() => w);
  const VOTE = {
    id: 'rdivan01',
    date: 'Isar 3rd, 4A 619',
    description: 'The Menkheti Viziers vote to admit Mehrana to active Divan Heirage',
    kcy: '1,250,926',
  };
  const HEIRAGE = {
    id: 'rdivan02',
    date: 'Isar 3rd, 4A 619 through the final personal debrief Camue 8th, 4A 624; exact final legal completion date unresolved',
    description:
      'Mehrana’s Divan Heirage proceeds from formal domestic admission in 4A 619 to the final personal debrief',
    kcy: '1,250,926 - 1,250,931',
  };
  const event = CAL.parser.parse('Isar 3rd, 4A 619 - Camue 5th, 4A 624');

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    // Both rows, in calendar order (the plain row before Kumikas 3rd, 4A 881), and the one range event.
    h.addRow(VOTE.id, VOTE.date, VOTE.description, VOTE.kcy, 'rfour006');
    h.addRow(HEIRAGE.id, HEIRAGE.date, HEIRAGE.description, HEIRAGE.kcy);
    h.syncCount();
    w.liveEvents(h.tl()).push({
      id: 'edivanhr',
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: 'z1',
      name: 'Mehrana completes the Divan Heirage',
      start: event.start,
      end: event.end,
      detail: 3,
      uri: `lk://resources/${C.resource}/docs/${h.table()}`,
    });
  });
  afterAll(() => w?.close());

  it('pairs the event with the range row (same start, both ranges) and offers the Viziers’ vote its own event', async () => {
    const c = await h.check();
    const mismatch = c.findings.filter((f) => f.kind === 'date_mismatch');
    expect(mismatch.map((f) => [f.detail!.rowId, f.detail!.eventId, f.detail!.pairedBy])).toEqual([
      [HEIRAGE.id, 'edivanhr', 'start+shape'],
    ]);
    // A range against a range: the fix corrects the end; it never shrinks the range to one day.
    expect(mismatch[0]!.detail!.shapeChange).toBeUndefined();
    expect(c.findings.filter((f) => f.kind === 'row_without_event').map((f) => f.detail!.rowId)).toEqual([
      VOTE.id,
    ]);
    expect(c.findings.filter((f) => f.kind === 'event_without_row')).toEqual([]);
  });

  it('“Propose a fix” corrects the range’s end, and makes the vote’s one-day event; the check is then clean', async () => {
    const chronology = w.stack.runtime.chronology;
    const fixRange = await chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: HEIRAGE.id });
    expect(fixRange).toMatchObject({ status: 'proposal_captured' });
    const fixVote = await chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: VOTE.id });
    expect(fixVote).toMatchObject({ status: 'proposal_captured' });
    for (const f of [fixRange, fixVote])
      expect((await h.approve((f as { proposalId: string }).proposalId)).state).toBe('executed');
    const heirage = h.events().find((e) => e.id === 'edivanhr')!;
    expect(heirage).toMatchObject({ start: event.start, end: CAL.parser.parse('Camue 8th, 4A 624').start });
    const vote = h.events().find((e) => e.name === VOTE.description)!;
    expect(vote).toMatchObject({ start: CAL.parser.parse(VOTE.date).start, detail: 3 });
    expect(vote.end).toBeUndefined();
    expect((await h.check()).findings).toEqual([]);
  });
});

// ============================================================================================ table-only and orphans

describe('the table-only mark and events without a row', () => {
  let w: ChronologyWorld;
  let client: Client;
  const h = helpers(() => w);
  const call = (tool: string, args: Record<string, unknown>) =>
    w.stack.call(client, tool, { project: 'test', ...args });
  const UNREAD = {
    id: 'rtounrd1',
    date: 'Some months after the coronation; undated',
    description: 'The palace kitchens are rebuilt',
    kcy: 'Unassigned',
  };

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    client = await w.stack.connect();
    h.addRow(UNREAD.id, UNREAD.date, UNREAD.description, UNREAD.kcy);
    h.syncCount();
  });
  afterAll(() => w?.close());

  it('table-only: set (audited), hidden from the check, and back when the row’s text changes', async () => {
    const chronology = w.stack.runtime.chronology;
    expect((await h.check()).findings.map((f) => f.detail?.rowId)).toEqual([UNREAD.id]);
    const mark = await chronology.markTableOnly('owner', PROJECT, {
      age: FOURTH,
      rowId: UNREAD.id,
      reason: 'kept in the table only',
    });
    expect(mark).toMatchObject({ rowId: UNREAD.id, age: FOURTH, texts: { date: UNREAD.date } });
    expect(w.stack.runtime.policy.store.listAudit({ action: 'chronology.table_only' })).toHaveLength(1);
    const hidden = await h.check();
    expect(hidden.findings).toEqual([]);
    expect(hidden.ages.find((a) => a.age === FOURTH)!.dates).toMatchObject({ tableOnly: 1 });
    // The owner edits the row in the app: the mark no longer holds, and the row is back.
    h.setCell(UNREAD.id, 0, 'The palace kitchens are rebuilt after the fire');
    const back = await h.check();
    expect(back.findings.map((f) => [f.kind, f.detail?.rowId])).toEqual([['unreadable_date', UNREAD.id]]);
    expect(back.ages.find((a) => a.age === FOURTH)!.tableOnlyLapsed).toEqual([
      { rowId: UNREAD.id, date: UNREAD.date },
    ]);
    // Marked again (with the new text), then cleared: both audited.
    await chronology.markTableOnly('owner', PROJECT, { age: FOURTH, rowId: UNREAD.id });
    expect((await h.check()).findings).toEqual([]);
    chronology.unmarkTableOnly('owner', PROJECT, { age: FOURTH, rowId: UNREAD.id });
    expect((await h.check()).findings.map((f) => f.kind)).toEqual(['unreadable_date']);
    expect(w.stack.runtime.policy.store.listAudit({ action: 'chronology.table_only' })).toHaveLength(3);
    expect(() => chronology.unmarkTableOnly('owner', PROJECT, { age: FOURTH, rowId: UNREAD.id })).toThrow(
      /not marked/,
    );
  });

  it('an event without a row: the finding names it and the three nearest rows; the fix deletes only the event', async () => {
    const quiet = CAL.parser.parse('4A 890');
    w.liveEvents(h.tl()).push({
      id: 'eorphan1',
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: 'z9',
      name: 'A superseded telling of the Quiet Years',
      start: quiet.start,
      detail: 1,
      uri: `lk://resources/${C.resource}/docs/${h.table()}`,
    });
    const c = await h.check();
    const orphan = c.findings.find((f) => f.kind === 'event_without_row')!;
    expect(orphan.detail).toMatchObject({
      eventId: 'eorphan1',
      name: 'A superseded telling of the Quiet Years',
      date: '4A 890',
    });
    const nearest = orphan.detail!.nearest as { rowId: string; date: string; words: string }[];
    // The range that holds the event first, then the closest by date.
    expect(nearest.map((n) => n.date)).toEqual(['4A 881 - 4A 900', 'Kumikas 3rd, 4A 881', '4A 881']);
    expect(nearest[0]!.words).toBe('The Quiet Years');

    const chronology = w.stack.runtime.chronology;
    // ADR 0057 decision 2: the unreadable row of the test before (its mark cleared) could be this event's own, so the
    // delete is refused until the owner marks it table-only (or fixes its date).
    await expect(
      chronology.proposeFix('owner', PROJECT, { kind: 'orphan', age: FOURTH, eventId: 'eorphan1' }),
    ).rejects.toMatchObject({
      code: 'ORPHAN_NEAR_UNREADABLE',
      details: { unreadable: [{ rowId: UNREAD.id }] },
    });
    await chronology.markTableOnly('owner', PROJECT, { age: FOURTH, rowId: UNREAD.id });

    const tableBefore = h.tableJson();
    const mainBefore = JSON.stringify(w.repo.blocks.get(w.mainDoc));
    const done = w.mark();
    const fix = (await chronology.proposeFix('owner', PROJECT, {
      kind: 'orphan',
      age: FOURTH,
      eventId: 'eorphan1',
    })) as { status: string; proposalId: string; summary: string };
    expect(done().writes).toBe(0);
    expect(fix.status).toBe('proposal_captured');
    expect(fix.summary).toMatch(
      /delete the Fourth Arkonan Age event “A superseded telling of the Quiet Years” \(4A 890\)/,
    );
    const detail = w.stack.runtime.policy.proposals.detail(fix.proposalId)!;
    expect((detail.operationDetail!.chronology as Obj).nearest).toEqual(nearest);
    expect(String(detail.operationDetail!.before)).toContain('4A 881 - 4A 900: The Quiet Years');
    expect(await h.approve(fix.proposalId)).toMatchObject({ state: 'executed' });
    expect(h.events().find((e) => e.id === 'eorphan1')).toBeUndefined();
    // Only the event: the table and the Main count are as they were; the journal keeps the event.
    expect(h.tableJson()).toBe(tableBefore);
    expect(JSON.stringify(w.repo.blocks.get(w.mainDoc))).toBe(mainBefore);
    const job = w.stack.runtime.policy.proposals.get(fix.proposalId)!.jobId!;
    const entries = w.stack.runtime.engine.queries.journalLookup(PROJECT, { jobId: job });
    expect(entries.map((e) => e.opId)).toEqual(['deleteEvent']);
    expect(JSON.stringify(entries[0]!.preImage)).toContain('A superseded telling of the Quiet Years');
    // The unreadable row is marked table-only: nothing is left.
    expect((await h.check()).findings).toEqual([]);
  });

  it('refuses an event a row owns, by date or by a mismatch (EVENT_HAS_ROW), and one an unpaired row could own (PAIRING_AMBIGUOUS)', async () => {
    const chronology = w.stack.runtime.chronology;
    await expect(
      chronology.proposeFix('owner', PROJECT, { kind: 'orphan', age: FOURTH, eventId: 'efour006' }),
    ).rejects.toMatchObject({ code: 'EVENT_HAS_ROW' });
    // A row without its event, and an event at that date with another name and shape: the event could be the row's.
    const ashgate = h.events().find((e) => e.id === 'efour006')!;
    w.liveEvents(h.tl()).splice(
      w.liveEvents(h.tl()).findIndex((e) => e.id === 'efour006'),
      1,
    );
    w.liveEvents(h.tl()).push({
      ...ashgate,
      id: 'eashgat2',
      name: 'Ashgate burns',
      end: (ashgate.start as number) + 1800 * 2,
    });
    await expect(
      chronology.proposeFix('owner', PROJECT, { kind: 'orphan', age: FOURTH, eventId: 'eashgat2' }),
    ).rejects.toMatchObject({ code: 'EVENT_HAS_ROW' });
    w.liveEvents(h.tl()).splice(
      w.liveEvents(h.tl()).findIndex((e) => e.id === 'eashgat2'),
      1,
    );
    w.liveEvents(h.tl()).push(ashgate);
    // Two rows on one date and one event there: which row is its own is not certain, so nothing is deleted.
    h.addRow('rtwin001', 'Isar 20th, 4A 700', 'The first council of Isar', '1,251,007', 'rfour006');
    h.addRow('rtwin002', 'Isar 20th, 4A 700', 'The second council of Isar', '1,251,007', 'rfour006');
    w.liveEvents(h.tl()).push({
      id: 'etwin001',
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: 'z7',
      name: 'A council at Isar',
      start: CAL.parser.parse('Isar 20th, 4A 700').start,
      detail: 3,
      uri: `lk://resources/${C.resource}/docs/${h.table()}`,
    });
    const tie = chronology.proposeFix('owner', PROJECT, { kind: 'orphan', age: FOURTH, eventId: 'etwin001' });
    await expect(tie).rejects.toMatchObject({ code: 'PAIRING_AMBIGUOUS' });
    await expect(tie).rejects.toMatchObject({
      details: { candidates: [{ id: 'rtwin001' }, { id: 'rtwin002' }] },
    });
    const rows = (w.repo.blocks.get(h.table())!.blocks as Obj[]).find((b) => b.kind === 'table')!
      .children as Obj[];
    for (const id of ['rtwin001', 'rtwin002'])
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      );
    w.liveEvents(h.tl()).splice(
      w.liveEvents(h.tl()).findIndex((e) => e.id === 'etwin001'),
      1,
    );
  });

  it('delete_timeline_event with orphan: true: the dry run names the nearest rows; then only the event goes', async () => {
    const t = CAL.parser.parse('Isar 20th, 4A 500');
    w.liveEvents(h.tl()).push({
      id: 'eorphan2',
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: 'z8',
      name: 'An event that lost its row',
      start: t.start,
      detail: 3,
      uri: `lk://resources/${C.resource}/docs/${h.table()}`,
    });
    const count = w.count(FOURTH);
    const dry = await call('delete_timeline_event', {
      event: { event_id: 'eorphan2' },
      orphan: true,
      confirm: true,
      dryRun: true,
    });
    expect(dry.body, dry.text).toMatchObject({ status: 'dry_run', action: 'delete_orphan', age: FOURTH });
    expect((dry.body.nearest as unknown[]).length).toBe(3);
    const noId = await call('delete_timeline_event', {
      event: { row_id: 'rfour000', age: FOURTH },
      orphan: true,
      confirm: true,
    });
    expect(noId.body.error.code).toBe('INVALID_PARAMS');
    const done = w.mark();
    const r = await call('delete_timeline_event', {
      event: { event_id: 'eorphan2', age: '4A' },
      orphan: true,
      confirm: true,
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    // The cost (ADR 0048): the calendar, the age's events (one page per 100) and its table to plan; in the lock the
    // table and the event; the event's journal pre-image; ONE write; the event read back. Then, as after every timeline
    // write since E1a, the change snapshot reads the timeline again (3 reads and 1 per 100 events).
    const spent = done();
    const kinds = spent.lines.map((l) =>
      l
        .replace(/\?.*$/, '')
        .replace(/\/resources\/[^/]+/, '')
        .split(' '),
    );
    const shape = kinds.map(([m, p]) =>
      `${m} ${p!.replace(/\/docs\/[^/]+/, '/doc').replace(/\/events\/[^/]+/, '/events/:id')}`.trim(),
    );
    expect(shape).toEqual([
      'GET /calendars',
      'GET /doc/events',
      'GET /doc/blocks',
      'GET /doc/blocks',
      'GET /doc/events/:id',
      'GET /doc/events/:id',
      'DELETE /doc/events/:id',
      'GET /doc/events/:id',
      'GET',
      'GET /doc',
      'GET /doc/lanes',
      'GET /doc/events',
    ]);
    expect((({ reads, writes }) => ({ reads, writes }))(spent)).toEqual({ reads: 11, writes: 1 });
    expect(h.events().find((e) => e.id === 'eorphan2')).toBeUndefined();
    expect(w.count(FOURTH)).toBe(count);
    const rec = w.stack.runtime.chronology.store.recent(PROJECT, { limit: 1 })[0]!;
    expect(rec).toMatchObject({ tool: 'delete_timeline_event', state: 'complete' });
  });
});

// ============================================================================================ Arkona-shaped counts

describe('an Arkona-shaped Fourth Age: 63 qualified rows', () => {
  let w: ChronologyWorld;
  const h = helpers(() => w);
  beforeAll(async () => {
    w = await chronologyWorld(budget);
    ARKONA_QUALIFIED.forEach(({ cell }, i) => {
      const q = parseQualified(CAL.parser, cell);
      const kcy =
        q.ok && !q.reading.openStart && !q.reading.openEnd
          ? `${formatKcy(q.reading.date.kcy, DEFAULT_KCY_STYLE)}${q.reading.approximate ? ' (approximate)' : ''}`
          : 'Unassigned - approximate date';
      h.addRow(`rark${String(i).padStart(4, '0')}`, cell, `Arkona event ${i + 1} of the Fourth Age`, kcy);
    });
    h.syncCount();
  });
  afterAll(() => w?.close());

  it('before: none of the 63 is read by the plain forms; after: 54 are certain (events now fixable), 9 stay unreadable', async () => {
    for (const { cell } of ARKONA_QUALIFIED) expect(() => CAL.parser.parse(cell)).toThrow();
    const c = await h.check();
    const count = (kind: string) => c.findings.filter((f) => f.kind === kind).length;
    expect({
      unreadable: count('unreadable_date'),
      withoutEvent: count('row_without_event'),
      wrongKcy: count('wrong_kcy'),
      styleDiffers: count('date_text_differs'),
      others: c.findings.length - count('unreadable_date') - count('row_without_event'),
    }).toEqual({ unreadable: 9, withoutEvent: 54, wrongKcy: 0, styleDiffers: 0, others: 0 });
    expect(c.ages.find((a) => a.age === FOURTH)!.dates).toEqual({
      qualified: 54,
      unreadable: 9,
      tableOnly: 0,
    });
    // Each unreadable one says why.
    const reasons = c.findings
      .filter((f) => f.kind === 'unreadable_date')
      .map((f) => f.detail!.code)
      .sort();
    expect(reasons).toEqual(
      [
        'DATE_AMBIGUOUS',
        'DATE_UNKNOWN_MONTH',
        'DATE_BOUND_UNREADABLE',
        'DATE_NO_ANCHOR',
        'DATE_QUALIFIER_ON_DAY',
        'DATE_RELATIVE',
        'DATE_RELATIVE',
        'DATE_RELATIVE',
        'DATE_RELATIVE',
      ].sort(),
    );
  });
});
