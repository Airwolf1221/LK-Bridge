/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * The timeline tools (v2 D1, ADR 0038) end to end through the REAL server, the official MCP client, the policy layer and
 * the job engine against the mock chronology: calendar_date; create, update and delete with the ordering rules (ties,
 * year-only rows, ranges), counts, cross-age moves, refusals and duplicates; the inline icon on a table page (block-level
 * writes); an Authoritative chronology edited at scope `write` (not canon-gated, ADR 0036 decision 6); `propose` scope;
 * `dryRun` and `operation_id`; and each tool's measured cost.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const FOURTH = 'Fourth Arkonan Age';
const costs: Record<string, { reads: number; writes: number }> = {};

beforeAll(async () => {
  // v2 E1a: every timeline write's change snapshot reads the timeline again (the page, the document, its lanes and its
  // events), so the file's calls and the world's setup exceed the mock's published 300 reads a minute; as in
  // sync.test.ts, this world's per-minute limits are raised (the costs measured below include those reads).
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  client = await w.stack.connect();
});
afterAll(async () => {
  console.log(`measured costs: ${JSON.stringify(costs)}`);
  await w.close();
});

describe('calendar_date', () => {
  it('answers every form, an Archon Age date and a day range, with no request while the calendar is cached', async () => {
    const done = w.mark();
    const aa = await call('calendar_date', { date: 'Kumikas 1st, AA 1,988,119' });
    expect(aa.body).toMatchObject({
      form: 'day',
      detail: 3,
      kcy: { start: -1_988_119 },
      kcyText: '-1,988,119',
      age: 'Archon Age',
      era: { abbr: 'AA' },
    });
    const j = await call('calendar_date', { date: 'Jehet 11th - 18th, 4A 424' });
    expect(j.body).toMatchObject({
      form: 'day-range',
      shape: 'date-range',
      formattedStart: 'Jehet 11th, 4A 424',
      formattedEnd: 'Jehet 18th, 4A 424',
      kcyText: '1,250,731 - 1,250,731',
      age: FOURTH,
    });
    for (const d of [
      '4A 881',
      'Unknown, 4A 101',
      'Kumikas - Azaakh, 4A 180',
      'Zahras 4A 367 - Attina 4A 367',
      '4A 881 - 4A 900',
      'Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102',
    ])
      expect((await call('calendar_date', { date: d })).body.text).toBe(d);
    expect(done().lines).toEqual([]);
    costs.calendar_date = { reads: 0, writes: 0 };
  });

  it('turns minutes or a KCY into dates, and refuses precisely', async () => {
    const m = await call('calendar_date', { minutes: 1611395897400 });
    expect(m.body).toMatchObject({ text: 'Azah 18th, 4A 1', kcy: { start: 1_250_308 } });
    const k = await call('calendar_date', { kcy: 1_250_308 });
    expect((k.body.years as { era: string; year: number }[]).map((y) => `${y.era} ${y.year}`)).toEqual([
      '3A 310',
      '4A 1',
    ]);
    const u = await call('calendar_date', { date: 'Unknown' });
    expect(u.body.error.code).toBe('DATE_UNKNOWN_ALONE');
    const o = await call('calendar_date', { date: 'Kumikas 1st, 4A 1' });
    expect(o.body.error).toMatchObject({ code: 'DATE_OUTSIDE_ERA' });
    expect(o.body.error.message).toContain('Azah 18th, 4A 1');
  });
});

describe('create_timeline_event', () => {
  it('adds the row in calendar order (after the same date, before the year-only row), the event and one to the count', async () => {
    const done = w.mark();
    const r = await call('create_timeline_event', {
      date: 'Kumikas 3rd, 4A 881',
      name: 'Bells rung',
      description: 'The bells of Ashgate are rung for the fallen',
    });
    costs.create_timeline_event = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true, age: FOURTH });
    const rows = w.rows(FOURTH);
    const at = rows.indexOf('Kumikas 3rd, 4A 881 | The bells of Ashgate are rung for the fallen | 1,251,188');
    expect(rows[at - 1]).toBe('Kumikas 3rd, 4A 881 | Ashgate falls to the Isar host | 1,251,188');
    expect(rows[at + 1]).toBe('4A 881 | The year of the long harvest | 1,251,188');
    expect(w.count(FOURTH)).toBe('10');
    const ev = w.events(w.ages[FOURTH]!.timeline).find((e) => e.name === 'Bells rung')!;
    expect(ev).toMatchObject({
      laneId: w.ages[FOURTH]!.lane,
      start: CAL.parser.parse('Kumikas 3rd, 4A 881').start,
      detail: 3,
      uri: `lk://resources/${C.resource}/docs/${w.ages[FOURTH]!.table}`,
    });
    // Block by block: the inline icon paragraph and the boundary paragraph are untouched.
    const blocks = w.repo.blocks.get(w.ages[FOURTH]!.table)!.blocks as { id: string; content?: unknown }[];
    expect(blocks.map((b) => b.id)).toEqual(['hfour', 'ifour', 'tfour', 'bfour']);
    expect(JSON.stringify(blocks[1])).toContain('hourglass');
  });

  it('puts a year-only row after the dated rows of its year, and a range by its start', async () => {
    const y = await call('create_timeline_event', {
      date: 'Unknown, 4A 424',
      name: 'Plague',
      description: 'A plague year',
    });
    expect(y.body.status, y.text).toBe('written');
    const r = await call('create_timeline_event', {
      date: 'Isar 1st, 4A 424 - Camue 5th, 4A 430',
      name: 'Wars',
      description: 'The Border Wars',
    });
    expect(r.body.status, r.text).toBe('written');
    const rows = w.rows(FOURTH);
    const i = (s: string) => rows.findIndex((x) => x.includes(s));
    expect(i('The Border Wars')).toBeLessThan(i('The Week of Lanterns'));
    expect(i('A plague year')).toBe(i('The Week of Lanterns') + 1);
    expect(rows[i('A plague year')]).toBe('Unknown, 4A 424 | A plague year | 1,250,731');
    expect(rows[i('The Border Wars')]).toBe(
      'Isar 1st, 4A 424 - Camue 5th, 4A 430 | The Border Wars | 1,250,731 - 1,250,737',
    );
    expect(w.count(FOURTH)).toBe('12');
  });

  it('counts down in the Archon Age and writes negative KCY values', async () => {
    const r = await call('create_timeline_event', {
      date: 'Isar 5th, AA 1,000,000',
      name: 'Concord drafted',
      description: 'The Concord is drafted',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(w.rows('Archon Age')).toEqual([
      'Kumikas 1st, AA 1,988,119 | The Archons wake on the first day of the reckoning | -1,988,119',
      'Isar 5th, AA 1,000,000 | The Concord is drafted | -1,000,000',
      'AA 1,000,000 | The Archon Concord is sealed | -1,000,000',
      'Isar 3rd - 9th, AA 5 | The Last Archon Council sits for a week | -5 - -5',
    ]);
    expect(w.count('Archon Age')).toBe('4');
  });

  it('is an ordinary edit on the Authoritative chronology (never canon-gated: ADR 0036 decision 6)', async () => {
    const r = await call('create_timeline_event', {
      date: 'Azah 18th, 4A 1',
      name: 'Dawn',
      description: 'The first dawn of the age',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.requiresCanonicalApproval).toBeUndefined();
    // A tie on the age's first day goes after the existing row.
    expect(
      w
        .rows(FOURTH)
        .slice(0, 2)
        .map((x) => x.split(' | ')[1]),
    ).toEqual(['The Divine System is deployed in the Heart of Arkona', 'The first dawn of the age']);
  });

  it('refuses a duplicate, an age mismatch, an unknown date, and Unknown alone; dryRun writes nothing', async () => {
    const dup = await call('create_timeline_event', {
      date: 'Jehet 11th - 18th, 4A 424',
      name: 'x',
      description: 'the week of lanterns',
    });
    expect(dup.body.error.code).toBe('DUPLICATE_EVENT');
    const mis = await call('create_timeline_event', {
      date: '4A 900',
      name: 'x',
      description: 'y',
      age: 'Archon Age',
    });
    expect(mis.body.error.code).toBe('AGE_MISMATCH');
    expect(
      (await call('create_timeline_event', { date: 'Unknown', name: 'x', description: 'y' })).body.error.code,
    ).toBe('DATE_UNKNOWN_ALONE');
    expect(
      (await call('create_timeline_event', { date: 'Frogmonth 2nd, 4A 3', name: 'x', description: 'y' })).body
        .error.code,
    ).toBe('DATE_UNKNOWN_MONTH');
    const before = w.rows(FOURTH);
    const dry = await call('create_timeline_event', {
      date: '4A 950',
      name: 'x',
      description: 'Dry',
      dryRun: true,
    });
    expect(dry.body).toMatchObject({
      status: 'dry_run',
      row: { place: { after: { date: '4A 881 - 4A 900' } } },
    });
    expect(w.rows(FOURTH)).toEqual(before);
  });

  it('answers a repeat of the same operation_id with the earlier result and makes nothing twice', async () => {
    const a = await call('create_timeline_event', {
      date: 'Selyros 2nd, 4A 5',
      name: 'Op',
      description: 'Operation once',
      operation_id: 'chron-op-1',
    });
    const b = await call('create_timeline_event', {
      date: 'Selyros 2nd, 4A 5',
      name: 'Op',
      description: 'Operation once',
      operation_id: 'chron-op-1',
    });
    expect(a.body.status).toBe('written');
    expect(b.body).toMatchObject({ repeated: true });
    expect(w.rows(FOURTH).filter((x) => x.includes('Operation once'))).toHaveLength(1);
  });
});

describe('update_timeline_event', () => {
  it('moves a row within its table when the date changes, keeping the event in step', async () => {
    const done = w.mark();
    const r = await call('update_timeline_event', {
      event: { date: 'Kumikas 3rd, 4A 881', description: 'The bells of Ashgate are rung for the fallen' },
      date: 'Isar 2nd, 4A 182',
      name: 'Bells rung early',
    });
    costs.update_timeline_event = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.verified).toBe(true);
    const rows = w.rows(FOURTH);
    const i = rows.indexOf('Isar 2nd, 4A 182 | The bells of Ashgate are rung for the fallen | 1,250,489');
    expect(i).toBeGreaterThan(rows.findIndex((x) => x.includes('famine months')));
    const ev = w.events(w.ages[FOURTH]!.timeline).find((e) => e.name === 'Bells rung early')!;
    expect(ev.detail).toBe(3);
    expect(w.count(FOURTH)).toBe('14');
  });

  it('moves the row and the event to another age, with both counts', async () => {
    const before = { fourth: w.count(FOURTH), third: w.count('Third Arkonan Age') };
    const done = w.mark();
    const r = await call('update_timeline_event', {
      event: { date: 'Selyros 2nd, 4A 5', description: 'Operation once' },
      date: '3A 200',
    });
    costs.update_timeline_event_other_age = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body.status, r.text).toBe('written');
    expect(w.count(FOURTH)).toBe(String(Number(before.fourth) - 1));
    expect(w.count('Third Arkonan Age')).toBe(String(Number(before.third) + 1));
    expect(w.rows('Third Arkonan Age')).toContain(
      `3A 200 | Operation once | ${CAL.parser.parse('3A 200').kcy.start.toLocaleString('en-GB')}`,
    );
    expect(w.rows(FOURTH).some((x) => x.includes('Operation once'))).toBe(false);
    expect(w.events(w.ages['Third Arkonan Age']!.timeline).find((e) => e.name === 'Op')).toMatchObject({
      uri: `lk://resources/${C.resource}/docs/${w.ages['Third Arkonan Age']!.table}`,
      detail: 1,
    });
    expect(w.events(w.ages[FOURTH]!.timeline).find((e) => e.name === 'Op')).toBeUndefined();
  });

  it('changes only the description, or a range to a single date (the event is made again: an end cannot be taken away)', async () => {
    const d = await call('update_timeline_event', {
      event: { date: '4A 881 - 4A 900', name: 'The Quiet Years' },
      description: 'The Quiet Years of the north',
    });
    expect(d.body.status, d.text).toBe('written');
    expect(w.rows(FOURTH)).toContain(
      '4A 881 - 4A 900 | The Quiet Years of the north | 1,251,188 - 1,251,207',
    );
    const r = await call('update_timeline_event', {
      event: { date: '4A 881 - 4A 900', description: 'The Quiet Years of the north' },
      date: '4A 890',
    });
    expect(r.body.status, r.text).toBe('written');
    const ev = w.events(w.ages[FOURTH]!.timeline).filter((e) => e.name === 'The Quiet Years');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.end).toBeUndefined();
    expect(ev[0]!.detail).toBe(1);
  });

  it('refuses when the row and its event have drifted apart', async () => {
    const tl = w.ages[FOURTH]!.timeline;
    const lantern = w.events(tl).find((e) => e.name === 'The Week of Lanterns')!;
    // Outside the bridge, the event is moved to another day.
    const ev = (w as unknown as { events(d: string): Record<string, unknown>[] }).events(tl);
    void ev;
    await w.stack.runtime.engine.run(
      'updateEvent',
      {
        path: { resourceId: C.resource, documentId: tl, eventId: lantern.id as string },
        body: { start: (lantern.start as number) + 1800 },
      },
      { project: PROJECT, origin: { kind: 'test' } },
    );
    const r = await call('update_timeline_event', {
      event: { date: 'Jehet 11th - 18th, 4A 424', description: 'The Week of Lanterns' },
      name: 'Lanterns',
    });
    expect(r.body.error.code, r.text).toBe('CHRONOLOGY_DRIFT');
  });
});

describe('delete_timeline_event', () => {
  it('removes the row and the event and takes one from the count; the journal keeps both', async () => {
    const before = Number(w.count(FOURTH));
    const done = w.mark();
    const r = await call('delete_timeline_event', {
      event: { date: 'Azah 18th, 4A 1', description: 'The first dawn of the age' },
      confirm: true,
    });
    costs.delete_timeline_event = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.verified).toBe(true);
    expect(w.rows(FOURTH).some((x) => x.includes('first dawn'))).toBe(false);
    expect(w.events(w.ages[FOURTH]!.timeline).some((e) => e.name === 'Dawn')).toBe(false);
    expect(w.count(FOURTH)).toBe(String(before - 1));
    const journal = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
      jobId: r.body.jobId,
      includePreImage: true,
      limit: 20,
    });
    const ops = journal.map((j) => j.opId);
    expect(ops).toEqual(expect.arrayContaining(['deleteBlock', 'deleteEvent', 'updateBlock']));
    expect(JSON.stringify(journal.find((j) => j.opId === 'deleteBlock')!.preImage)).toContain(
      'The first dawn of the age',
    );
    expect(JSON.stringify(journal.find((j) => j.opId === 'deleteEvent')!.preImage)).toContain('Dawn');
  });
});

describe('propose scope', () => {
  it('captures one proposal per call; two approved proposals on the same age both land with the right count', async () => {
    const proposer = await w.stack.connect(w.stack.newToken('chronology-proposer', 'propose').token);
    const p = (args: Record<string, unknown>) =>
      w.stack.call(proposer, 'create_timeline_event', { project: 'test', ...args });
    const before = Number(w.count(FOURTH));
    const a = await p({ date: 'Surion 4th, 4A 600', name: 'A', description: 'Proposal A' });
    const b = await p({ date: 'Surion 2nd, 4A 600', name: 'B', description: 'Proposal B' });
    expect(a.body.status, a.text).toBe('proposal_captured');
    expect(b.body.status).toBe('proposal_captured');
    expect(w.rows(FOURTH).some((x) => x.includes('Proposal'))).toBe(false);
    const proposals = w.stack.runtime.policy.proposals;
    const detail = proposals.detail ? proposals.detail(String(a.body.proposalId)) : null;
    void detail;
    for (const id of [a.body.proposalId, b.body.proposalId]) {
      await w.stack.runtime.policy.commands.approve('owner', String(id));
      for (
        let i = 0;
        i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(String(id))!.state);
        i++
      )
        await new Promise((res) => setTimeout(res, 20));
      expect(proposals.get(String(id))!.state).toBe('executed');
    }
    const rows = w.rows(FOURTH);
    expect(rows.findIndex((x) => x.includes('Proposal B'))).toBeLessThan(
      rows.findIndex((x) => x.includes('Proposal A')),
    );
    expect(w.count(FOURTH)).toBe(String(before + 2));
  });
});

describe('create_timeline_lane', () => {
  it('adds a lane to an ordinary timeline, and refuses the chronology’s age timelines', async () => {
    const done = w.mark();
    const r = await call('create_timeline_lane', {
      page: 'Battle Plans',
      document: 'Campaign',
      name: 'Navy',
    });
    costs.create_timeline_lane = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body.status, r.text).toBe('written');
    expect(r.body.verified).toBe(true);
    expect(w.lanes(w.planTimeline).map((l) => l.name)).toEqual(['Army', 'Navy']);
    const no = await call('create_timeline_lane', {
      page: C.resource,
      document: `${FOURTH} - Timeline`,
      name: 'Second',
    });
    expect(no.body.error.code).toBe('CHRONOLOGY_TIMELINE');
    const dup = await call('create_timeline_lane', {
      page: 'Battle Plans',
      document: 'Campaign',
      name: 'navy',
    });
    expect(dup.body.error.code).toBe('LANE_EXISTS');
  });
});
