/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * Chronology ties (v3 F2.1, ADR 0048's F2.1 amendments; the owner's Arkona run of 16 November 2026), end to end through
 * the real server, the official MCP client, the policy layer and the job engine against the mock chronology. Mocks and
 * fixtures only: nothing here touches LegendKeeper.
 *
 * - the Arkona fixture (Fourth Age, Selyros 40th, 4A 605): the plain row takes the event ("plain row preferred over
 *   qualified anchor"), the two "before Selyros 40th" rows are each offered a new open-start event named with their
 *   Date cell, and the event is never an event without a row;
 * - the four Arkona tie shapes as the check reports them before the plain rows decide ("Event in a tie", with their
 *   candidate rows, never a delete), and after (paired outright);
 * - a caller's choice is remembered (`event_id` on an agreeing event records the link; the next check pairs them even
 *   with a fourth tied row); `create_new`; candidates named in the refusal's own text;
 * - a row found by its opening words.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventOf, matchRowsAndEvents, type TimelineEvent } from '../../src/chronology/check.js';
import type { AgeConfig } from '../../src/chronology/settings.js';
import { readAgeTable } from '../../src/chronology/table.js';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
const FOURTH = 'Fourth Arkonan Age';

/** The Fourth Age's documents, rows added "in the app", the check and approvals (as in qualified.test.ts). */
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
  /** Adds a row "in the app" (no request), before the row `before` (Kumikas 3rd, 4A 881 by default). */
  const addRow = (r: Row, before = 'rfour006') => {
    const rows = tableBlock().children as Obj[];
    const at = rows.findIndex((x) => x.id === before);
    rows.splice(at < 0 ? rows.length : at, 0, rowBlock(r.id, r.date, r.description, r.kcy));
  };
  const syncCount = () => {
    const main = (w().repo.blocks.get(w().mainDoc)!.blocks as Obj[]).find((b) => b.kind === 'table')!;
    const row = (main.children as Obj[]).find((r) => r.id === w().ages[FOURTH]!.mainRow)!;
    const para = ((row.children as Obj[])[1]!.children as Obj[])[0]!;
    para.content = [{ text: String((tableBlock().children as Obj[]).length - 1) }];
  };
  /** Adds an event "in the app" at a date (day, range, …), linked to the age table. */
  const addEvent = (id: string, name: string, date: string) => {
    const d = CAL.parser.parse(date);
    w()
      .liveEvents(tl())
      .push({
        id,
        laneId: w().ages[FOURTH]!.lane,
        type: 'event',
        rank: `z${id}`,
        name,
        start: d.start,
        ...(d.end !== null ? { end: d.end } : {}),
        detail: d.detail,
        uri: `lk://resources/${C.resource}/docs/${table()}`,
      });
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
  return { table, tl, addRow, addEvent, syncCount, events, check, approve };
}

interface Row {
  readonly id: string;
  readonly date: string;
  readonly description: string;
  readonly kcy: string;
}

const budget = {
  env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
  limits: { 'key-min': 5000, 'write-min': 2000 },
};

// ============================================================================================ the shapes

/** Arkona, Fourth Age table jhk6xcal, Selyros 40th, 4A 605: two qualified rows and one plain row on one day. */
const S1 = {
  qualified: [
    {
      id: 'w26f230j',
      date: 'After Pardis-an placement and before Selyros 40th, 4A 605; exact dates unresolved',
      description:
        'In the final House period, an enslaved auction participant attacks Mehrana during the House auction',
      kcy: '1,250,912 (approximate)',
    },
    {
      id: 'kvqam7yc',
      date: 'Before Selyros 40th, 4A 605; exact day unresolved',
      description:
        'Following Mehrana’s return from Tahira’s treatment, Nadira terminates the House arrangement',
      kcy: '1,250,912',
    },
  ],
  plain: {
    id: 'sebefa0w',
    date: 'Selyros 40th, 4A 605',
    description:
      'After about thirty-five years of independent cultivation at Binbir Kemal Ocagi, Mehrana returns to the House',
    kcy: '1,250,912',
  },
  event: {
    id: 'n4nl9rudexa96czfw2z4wz4c',
    name: 'Mehrana returns from the Binbir Kemal Ocagi after 35 years of House Cultivation…',
    date: 'Selyros 40th, 4A 605',
  },
} as const;

/** The 4A 613 wedding: a plain row and two qualified rows anchored on Isar 19th. */
const S2 = {
  qualified: [
    {
      id: 'rwed0001',
      date: 'Days following Isar 19th, 4A 613; exact date unresolved',
      description: 'The trial of the envoys who carried the marriage contract',
      kcy: '1,250,920 onward',
    },
    {
      id: 'rwed0002',
      date: 'Isar 19th, 4A 613; wedding feast follows',
      description: 'The House sends its gifts to the bride’s family',
      kcy: '1,250,920',
    },
  ],
  plain: {
    id: 'rwed0003',
    date: 'Isar 19th, 4A 613',
    description: 'Mehrana and Halid are wed',
    kcy: '1,250,920',
  },
  event: { id: 'ewedding', name: 'The wedding at Sarayi Halid', date: 'Isar 19th, 4A 613' },
} as const;

/** The Divan Heirage against the other ranges that start on Isar 3rd, 4A 619 (and the plain Viziers' vote). */
const S3 = {
  rows: [
    {
      id: 'rdivan01',
      date: 'Isar 3rd, 4A 619',
      description: 'The Menkheti Viziers vote to admit Mehrana to active Divan Heirage',
      kcy: '1,250,926',
    },
    {
      id: 'rdivan02',
      date: 'Isar 3rd, 4A 619 through the final personal debrief Camue 8th, 4A 624; exact final legal completion date unresolved',
      description:
        'Mehrana’s Divan Heirage proceeds from formal domestic admission in 4A 619 to the final personal debrief',
      kcy: '1,250,926 - 1,250,931',
    },
    {
      id: 'rdivan03',
      date: 'Isar 3rd, 4A 619 to Selaphos 1st, 4A 620',
      description: 'Mehrana’s first year of Divan instruction under the Viziers',
      kcy: '1,250,926 - 1,250,927',
    },
  ],
  event: { id: 'edivanhr', name: 'The whole Divan Heirage', date: 'Isar 3rd, 4A 619 - Camue 5th, 4A 624' },
} as const;

/** The 4A 630 abdication: four rows on Kumikas 25th, one of them plain. */
const S4 = {
  qualified: [
    {
      id: 'rcoron01',
      date: 'Kumikas 25th, 4A 630; first coronation proceeding, approximately four hours',
      description: 'The first coronation proceeding of the new Sultan',
      kcy: '1,250,937',
    },
    {
      id: 'rcoron02',
      date: 'From Kumikas 25th, 4A 630 through the subsequent reign; no exact peace-onset date or end assigned',
      description: 'The peace of the new reign',
      kcy: '1,250,937 onward',
    },
    {
      id: 'rcoron03',
      date: 'On or after Kumikas 25th, 4A 630',
      description: 'The old Sultan withdraws to the summer palace',
      kcy: '1,250,937 onward',
    },
  ],
  plain: {
    id: 'rcoron04',
    date: 'Kumikas 25th, 4A 630',
    description: 'The Sultan abdicates',
    kcy: '1,250,937',
  },
  event: { id: 'eabdicat', name: 'Abdication at the Divan', date: 'Kumikas 25th, 4A 630' },
} as const;

// ============================================================================================ the pure pairing

describe('the tie shapes in matchRowsAndEvents (no LegendKeeper at all)', () => {
  const age: AgeConfig = {
    name: FOURTH,
    eraId: 'x',
    tableDocumentId: 'tab',
    timelineDocumentId: 'tl',
    laneId: 'lane',
    laneName: 'Historical Events',
    mainRowId: 'm',
  };
  const cell = (t: string) => ({
    kind: 'tableCell',
    children: [{ kind: 'paragraph', content: [{ text: t }] }],
  });
  const rows = (rs: readonly Row[]) =>
    readAgeTable(
      [
        {
          id: 't',
          kind: 'table',
          children: [
            { id: 'h', kind: 'tableRow', children: ['Historical Event', 'Date', 'KCY'].map(cell) },
            ...rs.map((r) => ({
              id: r.id,
              kind: 'tableRow',
              children: [cell(r.description), cell(r.date), cell(r.kcy)],
            })),
          ],
        },
      ],
      CAL.parser,
    )!.rows;
  const ev = (e: { id: string; name: string; date: string }): TimelineEvent => {
    const p = CAL.parser.parse(e.date);
    return eventOf({
      id: e.id,
      laneId: 'lane',
      name: e.name,
      start: p.start,
      ...(p.end !== null ? { end: p.end } : {}),
      detail: p.detail,
    });
  };
  const kcyOf = (m: number) => CAL.engine.kcyOf(m);

  it('Arkona, Selyros 40th, 4A 605: the plain row takes the event; the qualified rows are left to be offered their own', () => {
    const p = matchRowsAndEvents(rows([...S1.qualified, S1.plain]), [ev(S1.event)], [], age, { kcyOf });
    expect(p.pairs.map((x) => [x.row.id, x.event.id, x.how])).toEqual([[S1.plain.id, S1.event.id, 'plain']]);
    expect(p.rows.map((r) => r.id).sort()).toEqual(S1.qualified.map((r) => r.id).sort());
    expect(p.events).toEqual([]);
    expect(p.mismatches).toEqual([]);
    // Without the plain row the two qualified anchors tie: nothing is guessed.
    const tie = matchRowsAndEvents(rows(S1.qualified), [ev(S1.event)], [], age, { kcyOf });
    expect(tie.pairs).toEqual([]);
    expect(tie.events.map((e) => e.id)).toEqual([S1.event.id]);
  });

  it('a plain row against an open-end row anchored on the same day: the plain row', () => {
    const p = matchRowsAndEvents(rows([S4.qualified[2], S4.plain]), [ev(S4.event)], [], age, { kcyOf });
    expect(p.pairs.map((x) => [x.row.id, x.how])).toEqual([[S4.plain.id, 'plain']]);
    expect(p.rows.map((r) => r.id)).toEqual([S4.qualified[2].id]);
  });

  it('four same-day rows, one plain: the plain row', () => {
    const p = matchRowsAndEvents(rows([...S4.qualified, S4.plain]), [ev(S4.event)], [], age, { kcyOf });
    expect(p.pairs.map((x) => [x.row.id, x.how])).toEqual([[S4.plain.id, 'plain']]);
    expect(p.rows).toHaveLength(3);
  });

  it('two plain rows and one event on one day: a name match decides, or nothing does', () => {
    const a = {
      id: 'rplain01',
      date: 'Isar 19th, 4A 613',
      description: 'The envoys arrive at the Divan',
      kcy: '1,250,920',
    };
    const b = {
      id: 'rplain02',
      date: 'Isar 19th, 4A 613',
      description: 'Mehrana and Halid are wed',
      kcy: '1,250,920',
    };
    const named = matchRowsAndEvents(
      rows([a, b]),
      [ev({ id: 'e1', name: 'Mehrana and Halid are wed', date: a.date })],
      [],
      age,
    );
    expect(named.pairs.map((x) => [x.row.id, x.how])).toEqual([[b.id, 'date+name']]);
    const unnamed = matchRowsAndEvents(
      rows([a, b]),
      [ev({ id: 'e1', name: 'The wedding', date: a.date })],
      [],
      age,
    );
    expect(unnamed.pairs).toEqual([]);
    expect(unnamed.events.map((e) => e.id)).toEqual(['e1']);
    // A cut-short name that names both rows decides nothing either (never the first row by luck).
    const both = { ...b, id: 'rplain03', description: 'The envoys arrive at the Divan and are received' };
    const cut = matchRowsAndEvents(
      rows([a, both]),
      [ev({ id: 'e1', name: 'The envoys arrive…', date: a.date })],
      [],
      age,
    );
    expect(cut.pairs).toEqual([]);
  });

  it('the Divan range against same-day ranges: the range that ends in the event’s final year (with the calendar)', () => {
    const p = matchRowsAndEvents(rows(S3.rows), [ev(S3.event)], [], age, { kcyOf });
    expect(p.mismatches.map((m) => [m.row.id, m.event.id, m.by])).toEqual([
      [S3.rows[1].id, S3.event.id, 'start+year'],
    ]);
    expect(p.rows.map((r) => r.id).sort()).toEqual([S3.rows[0].id, S3.rows[2].id]);
    // Without the calendar's years the two ranges tie (the event stays unpaired; the Viziers' vote is never a rival).
    const tie = matchRowsAndEvents(rows(S3.rows), [ev(S3.event)], [], age);
    expect(tie.mismatches).toEqual([]);
    expect(tie.events.map((e) => e.id)).toEqual([S3.event.id]);
  });
});

// ============================================================================================ the Arkona fixture

describe('Arkona’s ties (16 November 2026): Event in a tie, then paired outright', () => {
  let w: ChronologyWorld;
  let client: Client;
  const h = helpers(() => w);
  const call = (tool: string, args: Record<string, unknown>) =>
    w.stack.call(client, tool, { project: 'test', ...args });

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    client = await w.stack.connect();
    // The shapes without their plain rows first: the ties as the owner's check saw them.
    for (const r of [...S1.qualified, ...S2.qualified, ...S3.rows, ...S4.qualified]) h.addRow(r);
    h.syncCount();
    for (const s of [S1, S2, S3, S4]) h.addEvent(s.event.id, s.event.name, s.event.date);
  });
  afterAll(() => w?.close());

  it('each event caught in a tie is "Event in a tie" with its candidate rows, never an event without a row', async () => {
    const c = await h.check();
    const ties = c.findings.filter((f) => f.kind === 'event_in_tie');
    const cands = (id: string) =>
      (ties.find((f) => f.detail!.eventId === id)!.detail!.candidates as Obj[]).map((x) => x.rowId).sort();
    expect(ties.map((f) => f.detail!.eventId).sort()).toEqual([S1.event.id, S2.event.id, S4.event.id].sort());
    expect(cands(S1.event.id)).toEqual(S1.qualified.map((r) => r.id).sort());
    expect(cands(S2.event.id)).toEqual(S2.qualified.map((r) => r.id).sort());
    expect(cands(S4.event.id)).toEqual(S4.qualified.map((r) => r.id).sort());
    // Each candidate is shown by its date and opening words.
    const first = (ties[0]!.detail!.candidates as Obj[])[0]!;
    expect([typeof first.date, typeof first.words]).toEqual(['string', 'string']);
    expect(ties[0]!.message).toMatch(/is in a tie: \d rows of the table could be its own/);
    // The Divan Heirage is paired with its own range (the same start and final year), the vote offered its own.
    expect(
      c.findings.filter((f) => f.kind === 'date_mismatch').map((f) => [f.detail!.rowId, f.detail!.pairedBy]),
    ).toEqual([[S3.rows[1].id, 'start+year']]);
    // Never offered for deletion.
    expect(c.findings.filter((f) => f.kind === 'event_without_row')).toEqual([]);
  });

  it('in the audits too: chronology_event_in_tie, with "Pair with this row" per candidate and no delete', async () => {
    const { chronologyCheck } = await import('../../src/audits/checks/lifecycle.js');
    const run = w.stack.runtime.chronology.store.lastCheck(PROJECT)!;
    const drafts = chronologyCheck({
      chronologyConfigured: true,
      chronology: run,
      chronologyResourceId: C.resource,
    } as never);
    const tie = drafts.find(
      (d) => d.code === 'chronology_event_in_tie' && (d.evidence as Obj).eventId === S1.event.id,
    )!;
    expect(tie.fix).toMatchObject({ kind: 'chronology_pair', args: { age: FOURTH, eventId: S1.event.id } });
    expect(((tie.fix!.args as Obj).candidates as Obj[]).map((x) => x.rowId).sort()).toEqual(
      S1.qualified.map((r) => r.id).sort(),
    );
    expect(drafts.some((d) => d.code === 'chronology_event_without_row')).toBe(false);
  });

  it('a delete reached anyway is refused in plain words: not an orphan, pair it instead', async () => {
    const r = await call('delete_timeline_event', {
      event: { event_id: S1.event.id, age: FOURTH },
      orphan: true,
      confirm: true,
    });
    expect(r.body.error.code, r.text).toBe('PAIRING_AMBIGUOUS');
    expect(r.body.error.message).toMatch(
      /^This event is not an orphan: 2 rows of the table could be its own \(/,
    );
    for (const q of S1.qualified) expect(r.body.error.message).toContain(q.id);
    expect(r.body.error.message).toContain('Pair it with one instead of deleting it');
  });

  it('a qualified row’s refused fix names every candidate in the message itself', async () => {
    const r = await call('sync_timeline_event', {
      row: { row_id: S1.qualified[1].id, age: FOURTH },
      dryRun: true,
    });
    expect(r.body.error.code, r.text).toBe('PAIRING_AMBIGUOUS');
    expect(r.body.error.message).toContain(S1.event.id);
    expect(r.body.error.message).toContain('Mehrana returns from the Binbir Kemal Ocagi');
    expect(r.body.error.message).toContain('Selyros 40th, 4A 605');
  });

  it('with the plain rows, every tie pairs outright (plain row preferred over qualified anchor)', async () => {
    h.addRow(S1.plain, S1.qualified[1].id);
    h.addRow(S2.plain, S2.qualified[0].id);
    h.addRow(S4.plain, S4.qualified[0].id);
    h.syncCount();
    const c = await h.check();
    expect(c.findings.filter((f) => f.kind === 'event_in_tie')).toEqual([]);
    expect(c.findings.filter((f) => f.kind === 'event_without_row')).toEqual([]);
    const pairs = (c.ages.find((a) => a.age === FOURTH)!.pairs as Obj[]).filter((p) => p.by === 'plain');
    expect(pairs.map((p) => [p.rowId, p.eventId]).sort()).toEqual(
      [
        [S1.plain.id, S1.event.id],
        [S2.plain.id, S2.event.id],
        [S4.plain.id, S4.event.id],
      ].sort(),
    );
    // The qualified rows anchored on those days are rows without an event (each offered its own); nothing else.
    expect(
      c.findings
        .filter((f) => f.kind === 'row_without_event')
        .map((f) => f.detail!.rowId)
        .sort(),
    ).toEqual(
      [...S1.qualified, ...S2.qualified, ...S4.qualified, S3.rows[0], S3.rows[2]].map((r) => r.id).sort(),
    );
    expect(c.findings.map((f) => f.kind).filter((k) => k !== 'row_without_event')).toEqual(['date_mismatch']);
  });

  it('the plain row is not refused: its event already agrees', async () => {
    const r = await call('sync_timeline_event', { row: { row_id: S1.plain.id, age: FOURTH }, dryRun: true });
    expect(r.body, r.text).toMatchObject({
      status: 'nothing_to_do',
      pairedBy: 'plain row preferred over qualified anchor',
    });
  });

  it('a row is found by its opening words; an ambiguous, short or missing prefix is refused', async () => {
    const ok = await call('sync_timeline_event', {
      row: {
        date: S1.plain.date,
        description: 'After about thirty-five years of independent cultivation at Binbir Kemal Ocagi',
      },
      dryRun: true,
    });
    expect(ok.body, ok.text).toMatchObject({ status: 'nothing_to_do', row: { id: S1.plain.id } });
    // The same words with other spacing.
    const spaced = await call('sync_timeline_event', {
      row: {
        date: S1.plain.date,
        description: '  After about   thirty-five years of independent  cultivation ',
      },
      dryRun: true,
    });
    expect(spaced.body.row?.id, spaced.text).toBe(S1.plain.id);
    const short = await call('sync_timeline_event', {
      row: { date: S1.plain.date, description: 'After about' },
      dryRun: true,
    });
    expect(short.body.error.code, short.text).toBe('ROW_PREFIX_TOO_SHORT');
    const miss = await call('sync_timeline_event', {
      row: { date: S1.plain.date, description: 'Nothing on this day begins like this at all' },
      dryRun: true,
    });
    expect(miss.body.error.code, miss.text).toBe('ROW_NOT_FOUND');
    // The rows of that date are named in the message, and listed.
    expect(miss.body.error.message).toContain(S1.plain.id);
    expect((miss.body.error.sameDate as Obj[]).map((r) => r.id)).toContain(S1.plain.id);
    // Two rows of Kumikas 25th, 4A 630 begin “The ”…: an ambiguous prefix lists them.
    const amb = await call('sync_timeline_event', {
      row: { date: S4.plain.date, description: 'The first coronation proceeding' },
      dryRun: true,
    });
    expect(amb.body.status ?? amb.body.error.code, amb.text).not.toBe('ROW_AMBIGUOUS');
    h.addRow(
      {
        id: 'rcoron05',
        date: 'Kumikas 25th, 4A 630; repeated for the court',
        description: 'The first coronation proceeding, repeated for the court',
        kcy: '1,250,937',
      },
      S4.qualified[0].id,
    );
    h.syncCount();
    const two = await call('sync_timeline_event', {
      row: { date: S4.plain.date, description: 'The first coronation proceeding' },
      dryRun: true,
    });
    expect(two.body.error.code, two.text).toBe('ROW_AMBIGUOUS');
    expect((two.body.error.rows as Obj[]).map((r) => r.id).sort()).toEqual(['rcoron01', 'rcoron05']);
    expect(two.body.error.message).toContain('rcoron05');
    // An exact match still wins over a longer row it is the start of.
    const exact = await call('sync_timeline_event', {
      row: { date: S4.plain.date, description: 'The Sultan abdicates' },
      dryRun: true,
    });
    expect(exact.body.row?.id, exact.text).toBe(S4.plain.id);
  });

  it('the two “before Selyros 40th” rows’ fixes each make a new open-start event named with its Date cell; the check is then clean there', async () => {
    const chronology = w.stack.runtime.chronology;
    for (const q of S1.qualified) {
      const p = await chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: q.id });
      expect(p).toMatchObject({ status: 'proposal_captured' });
      expect((await h.approve((p as { proposalId: string }).proposalId)).state).toBe('executed');
    }
    const at = CAL.parser.parse('Selyros 40th, 4A 605');
    const made = h.events().filter((e) => e.start === at.start && e.id !== S1.event.id);
    expect(made).toHaveLength(2);
    for (const q of S1.qualified) {
      const e = made.find((x) => String(x.name).endsWith(q.date))!;
      expect(e, q.id).toBeDefined();
      expect(e).toMatchObject({ detail: 3 });
      expect(e.end).toBeUndefined();
      expect(String(e.name)).toContain(' – ');
    }
    const c = await h.check();
    const ids = new Set<unknown>([
      ...S1.qualified.map((r) => r.id),
      S1.plain.id,
      S1.event.id,
      ...made.map((e) => e.id),
    ]);
    expect(c.findings.filter((f) => ids.has(f.detail?.rowId) || ids.has(f.detail?.eventId))).toEqual([]);
  });
});

// ============================================================================================ choices

describe('a caller’s choice is remembered; create_new makes a new event', () => {
  let w: ChronologyWorld;
  let client: Client;
  const h = helpers(() => w);
  const call = (tool: string, args: Record<string, unknown>) =>
    w.stack.call(client, tool, { project: 'test', ...args });
  const A = {
    id: 'rtie0001',
    date: 'Isar 19th, 4A 613',
    description: 'The envoys arrive at the Divan of the south',
    kcy: '1,250,920',
  };
  const B = {
    id: 'rtie0002',
    date: 'Isar 19th, 4A 613',
    description: 'Mehrana and Halid are wed at the Sarayi',
    kcy: '1,250,920',
  };
  const D = {
    id: 'rtie0004',
    date: 'Isar 19th, 4A 613',
    description: 'A fourth account of the same day',
    kcy: '1,250,920',
  };
  const X = { id: 'ewed0001', name: 'The wedding', date: 'Isar 19th, 4A 613' };
  const P = {
    id: 'rtie0005',
    date: 'Selaphos 9th, 4A 643',
    description: 'The harbour of Kemal is opened to the fleet',
    kcy: '1,250,950',
  };
  const Q = {
    id: 'rtie0006',
    date: 'Selaphos 9th, 4A 643',
    description: 'The harbour master is appointed',
    kcy: '1,250,950',
  };
  const Y = { id: 'eharbour', name: 'Harbour day', date: 'Selaphos 9th, 4A 643' };

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    client = await w.stack.connect();
    for (const r of [A, B, P, Q]) h.addRow(r);
    h.syncCount();
    h.addEvent(X.id, X.name, X.date);
    h.addEvent(Y.id, Y.name, Y.date);
  });
  afterAll(() => w?.close());

  it('event_id on an event that already agrees records the link ("linked", no LegendKeeper write); the next check pairs them, even with a fourth tied row', async () => {
    const refused = await call('sync_timeline_event', { row: { row_id: A.id, age: FOURTH } });
    expect(refused.body.error.code, refused.text).toBe('PAIRING_AMBIGUOUS');
    expect(refused.body.error.message).toContain(X.id);
    const before = w.mark();
    const r = await call('sync_timeline_event', { row: { row_id: A.id, age: FOURTH }, event_id: X.id });
    // v3 F12 follow-up (ADR 0081 amendment 1, decision 3): at scope write a link is direct (on the owner's Review page,
    // with Revert), recorded with no LegendKeeper write.
    expect(r.body, r.text).toMatchObject({ status: 'linked' });
    await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 20_000);
    expect(before().writes).toBe(0);
    const link = w.stack.runtime.chronology.store.links(PROJECT).find((l) => l.rowId === A.id);
    expect(link).toMatchObject({ eventId: X.id, tableDocumentId: h.table() });
    // A fourth row of the day: without the link, three plain rows and one event would be a tie.
    h.addRow(D);
    h.syncCount();
    const c = await h.check();
    const pairs = c.ages.find((a) => a.age === FOURTH)!.pairs as Obj[];
    expect(pairs.find((p) => p.rowId === A.id)).toMatchObject({ eventId: X.id, by: 'link' });
    expect(
      c.findings.filter(
        (f) => (f.kind === 'event_in_tie' || f.kind === 'event_without_row') && f.detail!.eventId === X.id,
      ),
    ).toEqual([]);
    // D and B are rows without an event (X is A's); P and Q still tie over Y (two plain rows, one event).
    expect(c.findings.filter((f) => f.kind === 'event_in_tie').map((f) => f.detail!.eventId)).toEqual([Y.id]);
    // The same request again: already linked, nothing to do.
    const again = await call('sync_timeline_event', { row: { row_id: A.id, age: FOURTH }, event_id: X.id });
    expect(again.body.status, again.text).toBe('nothing_to_do');
  });

  it('at scope propose a link is still a proposal (“link row … to event …”); approving it records the link', async () => {
    const proposer = await w.stack.connect(w.stack.newToken('tie-proposer', 'propose').token);
    const r = await w.stack.call(proposer, 'sync_timeline_event', {
      project: 'test',
      row: { row_id: P.id, age: FOURTH },
      event_id: Y.id,
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', action: 'link' });
    expect(String(r.body.summary)).toMatch(
      /link row “Selaphos 9th, 4A 643” .* to event “Harbour day” \(eharbour\)/,
    );
    expect(w.stack.runtime.chronology.store.links(PROJECT).some((l) => l.rowId === P.id)).toBe(false);
    expect((await h.approve(String(r.body.proposalId))).state).toBe('executed');
    expect(w.stack.runtime.chronology.store.links(PROJECT).find((l) => l.rowId === P.id)).toMatchObject({
      eventId: Y.id,
    });
  });

  it('create_new with candidates makes the event and names the candidates it passed over; with event_id it is refused', async () => {
    // Y is now P's by the link: give Q two candidates of its own (one alone would pair by its date).
    h.addEvent('eharbou2', 'Harbour day, second telling', Q.date);
    h.addEvent('eharbou3', 'Harbour day, third telling', Q.date);
    const both = await call('sync_timeline_event', {
      row: { row_id: Q.id, age: FOURTH },
      event_id: 'eharbou2',
      create_new: true,
    });
    expect(both.body.error.code, both.text).toBe('INVALID_PARAMS');
    const dry = await call('sync_timeline_event', {
      row: { row_id: Q.id, age: FOURTH },
      create_new: true,
      dryRun: true,
    });
    expect(dry.body, dry.text).toMatchObject({ status: 'dry_run', action: 'create' });
    expect((dry.body.passedOver as Obj[]).map((p) => p.eventId).sort()).toEqual(['eharbou2', 'eharbou3']);
    // The dashboard's "Make a new event": the proposal names the candidate passed over.
    const p = await w.stack.runtime.chronology.proposeFix('owner', PROJECT, {
      age: FOURTH,
      rowId: Q.id,
      createNew: true,
    });
    expect(p).toMatchObject({ status: 'proposal_captured' });
    const proposal = w.stack.runtime.policy.proposals.get((p as { proposalId: string }).proposalId)!;
    expect(JSON.stringify(proposal)).toContain('eharbou2');
    expect((await h.approve((p as { proposalId: string }).proposalId)).state).toBe('executed');
    expect(h.events().filter((e) => e.start === CAL.parser.parse(Q.date).start)).toHaveLength(4);
    // A row that has its event already is refused create_new.
    const has = await call('sync_timeline_event', { row: { row_id: A.id, age: FOURTH }, create_new: true });
    expect(has.body.error.code, has.text).toBe('ROW_HAS_EVENT');
  });

  it('the dashboard’s "Use this event" and "Pair with this row" go through the same choice', async () => {
    // B and D tie over one event of their day (X is A's): the owner chooses it for B.
    h.addEvent('ewed0002', 'The wedding feast', B.date);
    const chronology = w.stack.runtime.chronology;
    await expect(chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: B.id })).rejects.toMatchObject(
      {
        code: 'PAIRING_AMBIGUOUS',
      },
    );
    const p = await chronology.proposeFix('owner', PROJECT, {
      age: FOURTH,
      rowId: B.id,
      eventId: 'ewed0002',
    });
    expect(p).toMatchObject({ status: 'proposal_captured' });
    expect((p as { summary: string }).summary).toMatch(/link row/);
    expect((await h.approve((p as { proposalId: string }).proposalId)).state).toBe('executed');
    expect(w.stack.runtime.chronology.store.links(PROJECT).find((l) => l.rowId === B.id)).toMatchObject({
      eventId: 'ewed0002',
    });
  });

  it('a range inside one KCY may write its KCY as the single value or as the range: neither is “written differently”', async () => {
    const single = {
      id: 'rkcy0001',
      date: 'Kumikas 17th - 24th, 4A 611',
      description: 'The Kumikas assizes sit',
      kcy: '1,250,918',
    };
    const range = {
      ...single,
      id: 'rkcy0002',
      description: 'The Kumikas assizes sit again',
      kcy: '1,250,918 - 1,250,918',
    };
    const wrong = {
      ...single,
      id: 'rkcy0003',
      description: 'The Kumikas assizes sit a third time',
      kcy: '1,250,919',
    };
    for (const r of [single, range, wrong]) h.addRow(r, A.id);
    h.syncCount();
    const c = await h.check();
    const about = (id: string) => c.findings.filter((f) => f.detail?.rowId === id).map((f) => f.kind);
    expect(about(single.id)).toEqual(['row_without_event']);
    expect(about(range.id)).toEqual(['row_without_event']);
    expect(about(wrong.id).sort()).toEqual(['row_without_event', 'wrong_kcy']);
  });
});

/** The Fourth Age's pairs as a check stored them. */
const fourthPairs = (c: { ages: readonly Obj[] }) =>
  (c.ages.find((a) => a.age === FOURTH)?.pairs ?? []) as { rowId: string; eventId: string }[];

describe('same-day pairing without guessing (v3 F3c, ADR 0051 decision 2)', () => {
  let w: ChronologyWorld;
  let client: Client;
  const h = helpers(() => w);
  const call = (tool: string, args: Record<string, unknown>) =>
    w.stack.call(client, tool, { project: 'test', ...args });
  const day = 'Zarzakh 29th, 4A 610';
  const R1 = {
    id: 'rsam0001',
    date: day,
    description: 'The council of the north meets at dawn',
    kcy: '1,250,917',
  };
  const R2 = { id: 'rsam0002', date: day, description: 'The southern envoys are received', kcy: '1,250,917' };
  const E1 = { id: 'esam0001', name: 'A day of meetings', date: day };
  const E2 = { id: 'esam0002', name: 'Another account of the day', date: day };

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    client = await w.stack.connect();
    for (const r of [R1, R2]) h.addRow(r);
    h.syncCount();
    h.addEvent(E1.id, E1.name, E1.date);
    h.addEvent(E2.id, E2.name, E2.date);
  });
  afterAll(() => w?.close());

  it('two rows and two events with indistinct names are a tie, shown with F2.1’s candidates; never paired by order', async () => {
    const c = await h.check();
    const pairsOf = (rowId: string) => fourthPairs(c).filter((p) => p.rowId === rowId);
    expect(pairsOf(R1.id)).toEqual([]);
    expect(pairsOf(R2.id)).toEqual([]);
    const ties = c.findings.filter((f) => f.kind === 'event_in_tie');
    expect(ties.map((f) => f.detail?.eventId).sort()).toEqual([E1.id, E2.id]);
    for (const t of ties)
      expect((t.detail?.candidates as { rowId: string }[]).map((x) => x.rowId).sort()).toEqual([
        R1.id,
        R2.id,
      ]);
    expect(c.findings.filter((f) => f.kind === 'event_without_row')).toEqual([]);
    const r = await call('sync_timeline_event', { row: { row_id: R1.id, age: FOURTH } });
    expect(r.body.error.code, r.text).toBe('PAIRING_AMBIGUOUS');
    expect(r.body.error.message).toContain(E1.name);
    expect(r.body.error.message).toContain(E2.name);
  });

  it('once the owner picks one (a stored link), the one row and one event left pair by the date', async () => {
    const r = await call('sync_timeline_event', { row: { row_id: R1.id, age: FOURTH }, event_id: E2.id });
    // v3 F12 follow-up: at scope write the pick is a direct link.
    expect(r.body.status, r.text).toBe('linked');
    await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 20_000);
    const c = await h.check();
    const pairs = fourthPairs(c);
    expect(pairs.find((p) => p.rowId === R1.id)).toMatchObject({ eventId: E2.id });
    expect(pairs.find((p) => p.rowId === R2.id)).toMatchObject({ eventId: E1.id });
    expect(c.findings.filter((f) => f.kind === 'event_in_tie')).toEqual([]);
  });
});
