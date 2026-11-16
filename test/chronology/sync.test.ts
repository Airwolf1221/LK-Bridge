/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * sync_timeline_event (v2 D1.1, ADR 0039) end to end through the REAL server, the official MCP client, the policy layer
 * and the job engine against the mock chronology: the table is the authority, the timeline event is created or
 * corrected, the table and the Main count are never touched. A missing year-only event is created; a single-day event
 * is corrected to the row's range (and a range made again as a single date); a correct event gets "nothing to do"; an
 * ambiguous pairing is refused with the candidates; `propose` scope; `dryRun`; the dashboard's "Propose a fix"; a row
 * edited between the plan and the lock; and the check's own `date_mismatch` finding.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const FOURTH = 'Fourth Arkonan Age';
const costs: Record<string, { reads: number; writes: number }> = {};

const engine = () => w.stack.runtime.engine;
const tl = () => w.ages[FOURTH]!.timeline;
const lane = () => w.ages[FOURTH]!.lane;
const table = () => w.ages[FOURTH]!.table;
const tableUri = () => `lk://resources/${C.resource}/docs/${table()}`;

/**
 * The events as the mock stores them (raw: no formatted text), and edits made "outside the bridge", straight on the
 * stored events: they cost no request, so the tests stay inside the rate budget the bridge's own reads need.
 */
const events = (): Obj[] => w.events(tl());
const eventNamed = (name: string): Obj[] => events().filter((e) => e.name === name);
const deleteEvent = (id: string) => {
  const list = w.liveEvents(tl());
  const at = list.findIndex((e) => e.id === id);
  if (at < 0) throw new Error(`no event ${id}`);
  list.splice(at, 1);
};
let seq = 0;
const createEvent = (body: Obj) => {
  w.liveEvents(tl()).push({
    id: `xevent${String(++seq).padStart(2, '0')}`,
    laneId: lane(),
    type: 'event',
    rank: `z${seq}`,
    uri: tableUri(),
    detail: 3,
    ...body,
  });
};
const editEvent = (id: string, fields: Obj) => {
  const e = w.liveEvents(tl()).find((x) => x.id === id);
  if (!e) throw new Error(`no event ${id}`);
  Object.assign(e, fields);
};
const tableJson = () => JSON.stringify(w.repo.blocks.get(table()));
const mainJson = () => JSON.stringify(w.repo.blocks.get(w.mainDoc));
const check = async () => {
  await w.stack.runtime.chronology.check(PROJECT, 'manual', 'P0');
  return w.stack.runtime.chronology.store.lastCheck(PROJECT)!;
};
const approve = async (id: string) => {
  const proposals = w.stack.runtime.policy.proposals;
  await w.stack.runtime.policy.commands.approve('owner', id);
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  return proposals.get(id)!;
};

beforeAll(async () => {
  // Many plans, checks and repairs in one file: the bridge's own model of the key's minute (300 requests) and the mock's
  // would stop the file part-way, so both get more than LegendKeeper publishes (the budget is not what is tested here).
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

describe('sync_timeline_event: a row with no event', () => {
  it('creates a missing year-only event: minutes, detail 1, the uri to the 4A table; the table and the count untouched', async () => {
    const [gone] = eventNamed('A comet is seen over Isar');
    deleteEvent(String(gone!.id));
    // The check reports it as a row without an event.
    const found = await check();
    expect(found.findings.map((f) => f.kind)).toEqual(['row_without_event']);
    const rowBefore = tableJson();
    const mainBefore = mainJson();
    const countBefore = w.count(FOURTH);

    const done = w.mark();
    const r = await call('sync_timeline_event', {
      row: { date: 'Unknown, 4A 101', description: 'A comet is seen over Isar' },
    });
    costs.create = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      action: 'create',
      age: FOURTH,
      note: expect.stringMatching(/not touched/),
    });
    const made = eventNamed('A comet is seen over Isar');
    expect(made).toHaveLength(1);
    const want = CAL.parser.parse('Unknown, 4A 101');
    expect(made[0]).toMatchObject({
      laneId: lane(),
      type: 'event',
      start: want.start,
      detail: 1,
      uri: tableUri(),
    });
    expect(made[0]!.end).toBeUndefined();
    // LegendKeeper's text for it, in LegendKeeper's style.
    expect(CAL.engine.format(made[0]!.start as number, 1)).toBe('4A 101');
    // The table and the Main page are exactly as they were; the count is the same.
    expect(tableJson()).toBe(rowBefore);
    expect(mainJson()).toBe(mainBefore);
    expect(w.count(FOURTH)).toBe(countBefore);
    // One job, one write, the journal and the record; the link is kept.
    const job = engine().queries.getJob(PROJECT, String(r.body.jobId))!;
    expect(job.status).toBe('succeeded');
    const entries = engine().queries.journalLookup(PROJECT, { jobId: String(r.body.jobId) });
    expect(entries.map((e) => e.opId)).toEqual(['createEvent']);
    expect(entries[0]!.operation).toMatchObject({ tool: 'sync_timeline_event' });
    const rec = w.stack.runtime.chronology.store.byJob(PROJECT, String(r.body.jobId))!;
    expect(rec).toMatchObject({ tool: 'sync_timeline_event', state: 'complete' });
    expect(w.stack.runtime.chronology.store.links(PROJECT).some((l) => l.eventId === made[0]!.id)).toBe(true);
    // And the check is clean again.
    expect((await check()).findings).toEqual([]);
    // Doing it again is "nothing to do", with no write at all.
    const again = w.mark();
    const r2 = await call('sync_timeline_event', {
      row: { date: 'Unknown, 4A 101', description: 'A comet is seen over Isar' },
    });
    expect(r2.body.status, r2.text).toBe('nothing_to_do');
    expect(again().writes).toBe(0);
    expect(eventNamed('A comet is seen over Isar')).toHaveLength(1);
  });

  it('by the row’s block id, with the age', async () => {
    const [gone] = eventNamed('The year of the long harvest');
    deleteEvent(String(gone!.id));
    const r = await call('sync_timeline_event', { row: { row_id: 'rfour007', age: '4A' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', action: 'create' });
    expect(eventNamed('The year of the long harvest')).toHaveLength(1);
    // A row id alone finds the age by reading the tables.
    const [g2] = eventNamed('The year of the long harvest');
    deleteEvent(String(g2!.id));
    const r2 = await call('sync_timeline_event', { row: { row_id: 'rfour007' } });
    expect(r2.body, r2.text).toMatchObject({ status: 'written', action: 'create' });
  });
});

describe('sync_timeline_event: an event that disagrees with its row', () => {
  it('corrects a single-day event to the row’s range (the check names it a date mismatch first)', async () => {
    const [week] = eventNamed('The Week of Lanterns');
    const row = CAL.parser.parse('Jehet 11th - 18th, 4A 424');
    // Outside the bridge, the event becomes a single day.
    deleteEvent(String(week!.id));
    createEvent({ name: 'The Week of Lanterns', start: row.start });
    const c = await check();
    const kinds = c.findings.map((f) => f.kind);
    expect(kinds).toEqual(['date_mismatch']);
    expect(c.findings[0]!.detail).toMatchObject({ rowId: 'rfour005', rowDate: 'Jehet 11th - 18th, 4A 424' });
    expect(c.findings[0]!.message).toMatch(/the row says a range .*the event one date/);
    const id = eventNamed('The Week of Lanterns')[0]!.id;

    const rowBefore = tableJson();
    // v2 E6 (ADR 0048): a single day made a range is never one call: the caller confirms it, after a refusal that says so.
    expect(c.findings[0]!.detail).toMatchObject({ shapeChange: 'single day → range' });
    const unconfirmed = await call('sync_timeline_event', {
      row: { date: 'Jehet 11th - 18th, 4A 424', description: 'The Week of Lanterns' },
    });
    expect(unconfirmed.body.error).toMatchObject({
      code: 'SHAPE_CHANGE_UNCONFIRMED',
      shapeChange: 'single day → range',
    });
    expect(tableJson()).toBe(rowBefore);
    expect(eventNamed('The Week of Lanterns')[0]!.end).toBeUndefined();
    const done = w.mark();
    const r = await call('sync_timeline_event', {
      row: { date: 'Jehet 11th - 18th, 4A 424', description: 'The Week of Lanterns' },
      confirm_shape_change: true,
    });
    costs.correct = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true, action: 'correct' });
    expect(r.body.changes).toEqual([{ field: 'end', from: null, to: row.end }]);
    const [fixed] = eventNamed('The Week of Lanterns');
    // The same event, updated: its id and name stay; its end, minutes and detail now match the row.
    expect(fixed).toMatchObject({ id, start: row.start, end: row.end, detail: 3, uri: tableUri() });
    expect(tableJson()).toBe(rowBefore);
    expect((await check()).findings).toEqual([]);
    const entries = engine().queries.journalLookup(PROJECT, { jobId: String(r.body.jobId) });
    expect(entries.map((e) => e.opId)).toEqual(['updateEvent']);
  });

  it('corrects a wrong year, detail and uri at once', async () => {
    const [harvest] = eventNamed('Ashgate falls to the Isar host');
    editEvent(String(harvest!.id), {
      start: (harvest!.start as number) + 1800 * 800,
      detail: 1,
      uri: `lk://resources/${C.resource}`,
    });
    const r = await call('sync_timeline_event', {
      row: { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', action: 'correct' });
    expect((r.body.changes as { field: string }[]).map((x) => x.field).sort()).toEqual([
      'detail',
      'start',
      'uri',
    ]);
    const [fixed] = eventNamed('Ashgate falls to the Isar host');
    expect(fixed).toMatchObject({
      start: CAL.parser.parse('Kumikas 3rd, 4A 881').start,
      detail: 3,
      uri: tableUri(),
    });
    expect((await check()).findings).toEqual([]);
  });

  it('makes an event again when the row is a single date and the event a range (LegendKeeper cannot take an end away)', async () => {
    const [harvest] = eventNamed('Ashgate falls to the Isar host');
    editEvent(String(harvest!.id), { end: (harvest!.start as number) + 1800 * 3 });
    expect((await check()).findings.map((f) => f.kind)).toEqual(['date_mismatch']);
    const r = await call('sync_timeline_event', {
      row: { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
      confirm_shape_change: true,
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true, action: 'recreate' });
    expect(r.body.shapeChange).toBe('range → single day');
    const made = eventNamed('Ashgate falls to the Isar host');
    expect(made).toHaveLength(1);
    expect(made[0]!.id).not.toBe(harvest!.id);
    expect(made[0]!.end).toBeUndefined();
    expect(made[0]).toMatchObject({ laneId: lane(), detail: 3, uri: tableUri() });
    const entries = engine().queries.journalLookup(PROJECT, { jobId: String(r.body.jobId) });
    expect([...entries].sort((a, b) => (a.stepNo ?? 0) - (b.stepNo ?? 0)).map((e) => e.opId)).toEqual([
      'deleteEvent',
      'createEvent',
    ]);
    expect((await check()).findings).toEqual([]);
  });

  it('a correct event gets "nothing to do", and a wording difference alone is not drift', async () => {
    // The timeline's name differs from the description in wording only: same date, so they pair and agree.
    const [dawn] = eventNamed('The Divine System is deployed in the Heart of Arkona');
    editEvent(String(dawn!.id), { name: 'Divine System deployed' });
    expect((await check()).findings).toEqual([]);
    const done = w.mark();
    const r = await call('sync_timeline_event', {
      row: {
        date: 'Azah 18th, 4A 1',
        description: 'The Divine System is deployed in the Heart of Arkona',
      },
    });
    expect(r.body, r.text).toMatchObject({ status: 'nothing_to_do', action: 'nothing' });
    expect(done().writes).toBe(0);
    // The event keeps its short name (sync never renames).
    expect(eventNamed('Divine System deployed')).toHaveLength(1);
  });
});

describe('sync_timeline_event: refusals', () => {
  it('refuses an ambiguous pairing with the candidates, and does nothing', async () => {
    const [harvest] = eventNamed('The year of the long harvest');
    deleteEvent(String(harvest!.id));
    const year = CAL.parser.parse('4A 881');
    // Two unpaired events that could each be the row's own.
    createEvent({ name: 'Harvest, one telling', start: year.start, detail: 1 });
    createEvent({ name: 'Harvest, another telling', start: year.start, detail: 1 });
    const before = events().length;
    const done = w.mark();
    const r = await call('sync_timeline_event', {
      row: { date: '4A 881', description: 'The year of the long harvest' },
    });
    expect(r.body.error, r.text).toMatchObject({ code: 'PAIRING_AMBIGUOUS' });
    expect((r.body.error.candidates as Obj[]).map((c) => c.name).sort()).toEqual([
      'Harvest, another telling',
      'Harvest, one telling',
    ]);
    expect(done().writes).toBe(0);
    expect(events().length).toBe(before);
    // Naming one of them is the caller's choice.
    const choice = (r.body.error.candidates as Obj[]).find((c) => c.name === 'Harvest, one telling')!;
    const ok = await call('sync_timeline_event', {
      row: { date: '4A 881', description: 'The year of the long harvest' },
      event_id: choice.id,
    });
    // It already agrees with the row (same date, detail and uri), so there is nothing to write.
    expect(ok.body.status, ok.text).toBe('nothing_to_do');
    // A choice that is not an event of the age is refused.
    const bad = await call('sync_timeline_event', {
      row: { date: '4A 881', description: 'The year of the long harvest' },
      event_id: 'nosuchev',
    });
    expect(bad.body.error.code).toBe('EVENT_NOT_FOUND');
    deleteEvent(String(eventNamed('Harvest, one telling')[0]!.id));
    deleteEvent(String(eventNamed('Harvest, another telling')[0]!.id));
    // Put the row's event back so later tests start clean.
    const fix = await call('sync_timeline_event', {
      row: { date: '4A 881', description: 'The year of the long harvest' },
    });
    expect(fix.body.status, fix.text).toBe('written');
  });

  it('refuses a row that is not there, an under-specified request and a bad date', async () => {
    const none = await call('sync_timeline_event', {
      row: { date: 'Kumikas 3rd, 4A 881', description: 'No such row' },
    });
    expect(none.body.error.code).toBe('EVENT_NOT_FOUND');
    expect(none.body.error.sameDate).toHaveLength(1);
    const only = await call('sync_timeline_event', { row: { date: 'Kumikas 3rd, 4A 881' } });
    expect(only.body.error.code).toBe('INVALID_PARAMS');
    const bad = await call('sync_timeline_event', { row: { date: 'Unknown', description: 'x' } });
    expect(bad.body.error.code).toBe('DATE_UNKNOWN_ALONE');
    const gone = await call('sync_timeline_event', { row: { row_id: 'rfour999', age: FOURTH } });
    expect(gone.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('dryRun shows the plan and writes nothing', async () => {
    const [quiet] = eventNamed('The Quiet Years');
    deleteEvent(String(quiet!.id));
    const before = events().length;
    const done = w.mark();
    const r = await call('sync_timeline_event', {
      row: { date: '4A 881 - 4A 900', description: 'The Quiet Years' },
      dryRun: true,
    });
    expect(r.body, r.text).toMatchObject({ status: 'dry_run', action: 'create', age: FOURTH });
    expect(done().writes).toBe(0);
    expect(events().length).toBe(before);
    const real = await call('sync_timeline_event', {
      row: { date: '4A 881 - 4A 900', description: 'The Quiet Years' },
    });
    expect(real.body.status, real.text).toBe('written');
    const [made] = eventNamed('The Quiet Years');
    expect(made).toMatchObject({ detail: 1, end: CAL.parser.parse('4A 881 - 4A 900').end });
  });
});

describe('sync_timeline_event: stopped part-way', () => {
  it('a job that stops after deleting the old event is finished by the same request again, never replayed', async () => {
    // A range event where the row is a single date: made again (delete, then create). The create fails once.
    const [harvest] = eventNamed('Ashgate falls to the Isar host');
    editEvent(String(harvest!.id), { end: (harvest!.start as number) + 1800 * 3 });
    w.failAt('createEvent', 0);
    const ref = {
      row: { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' },
      confirm_shape_change: true,
    };
    const first = await call('sync_timeline_event', ref);
    expect(first.body.error, first.text).toBeDefined();
    // The old event is gone and the new one was not made: the row has no event now.
    expect(eventNamed('Ashgate falls to the Isar host')).toHaveLength(0);
    const open = w.stack.runtime.chronology.store.incomplete(PROJECT);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ tool: 'sync_timeline_event', state: 'incomplete' });
    // Another change of the age waits for it.
    const blocked = await call('create_timeline_event', {
      date: 'Surion 9th, 4A 700',
      name: 'Blocked',
      description: 'Blocked until the repair is finished',
    });
    expect(blocked.body.error.code, blocked.text).toBe('CHRONOLOGY_INCOMPLETE');
    // The same request again does only what is left: it makes the event once.
    const done = w.mark();
    const again = await call('sync_timeline_event', ref);
    expect(again.body, again.text).toMatchObject({ status: 'written' });
    expect(done().lines.filter((l) => l.startsWith('DELETE'))).toHaveLength(0);
    const made = eventNamed('Ashgate falls to the Isar host');
    expect(made).toHaveLength(1);
    expect(made[0]!.end).toBeUndefined();
    expect(w.stack.runtime.chronology.store.incomplete(PROJECT)).toHaveLength(0);
    expect((await check()).findings).toEqual([]);
  });
});

describe('propose scope and the dashboard’s "Propose a fix"', () => {
  it('at scope propose it captures ONE proposal and writes nothing; approving it makes the event', async () => {
    const [gone] = eventNamed('The Long Winter');
    deleteEvent(String(gone!.id));
    const proposer = await w.stack.connect(w.stack.newToken('sync-proposer', 'propose').token);
    const before = events().length;
    const r = await w.stack.call(proposer, 'sync_timeline_event', {
      project: 'test',
      row: { date: 'Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102', description: 'The Long Winter' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', action: 'create' });
    expect(events().length).toBe(before);
    const id = String(r.body.proposalId);
    const p = await approve(id);
    expect(p.state).toBe('executed');
    const [made] = eventNamed('The Long Winter');
    const want = CAL.parser.parse('Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102');
    expect(made).toMatchObject({ start: want.start, end: want.end, detail: 3, uri: tableUri() });
  });

  it('Propose a fix creates the proposal for a row without an event, and for a date mismatch; the owner approves each as normal; the check is then clean', async () => {
    // Drift: a missing event and a date mismatch.
    const [comet] = eventNamed('A comet is seen over Isar');
    deleteEvent(String(comet!.id));
    const [week] = eventNamed('The Week of Lanterns');
    const row = CAL.parser.parse('Jehet 11th - 18th, 4A 424');
    deleteEvent(String(week!.id));
    createEvent({ name: 'The Week of Lanterns', start: row.start });
    const c = await check();
    expect(c.findings.map((f) => f.kind).sort()).toEqual(['date_mismatch', 'row_without_event']);
    const missing = c.findings.find((f) => f.kind === 'row_without_event')!;
    const mismatch = c.findings.find((f) => f.kind === 'date_mismatch')!;
    const eventsBefore = events().length;
    const tableBefore = tableJson();

    const chronology = w.stack.runtime.chronology;
    const done = w.mark();
    const first = await chronology.proposeFix('owner', PROJECT, {
      age: FOURTH,
      rowId: String(missing.detail!.rowId),
    });
    costs.proposeFix = (({ reads, writes }) => ({ reads, writes }))(done());
    expect(first).toMatchObject({ status: 'proposal_captured' });
    expect(done().writes).toBe(0);
    // v2 E6 (ADR 0048): a single day made a range is not one click: refused until the owner confirms it.
    await expect(
      chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: String(mismatch.detail!.rowId) }),
    ).rejects.toMatchObject({
      code: 'SHAPE_CHANGE_UNCONFIRMED',
      details: { shapeChange: 'single day → range' },
    });
    const second = await chronology.proposeFix('owner', PROJECT, {
      age: FOURTH,
      rowId: String(mismatch.detail!.rowId),
      confirmShapeChange: true,
    });
    expect(second).toMatchObject({ status: 'proposal_captured' });
    expect(
      w.stack.runtime.policy.proposals.get((second as { proposalId: string }).proposalId)!.summary,
    ).toMatch(/single day → range/);
    // Nothing was written until the owner approves; the proposals are ordinary ones, proposed by the system.
    expect(events().length).toBe(eventsBefore);
    expect(tableJson()).toBe(tableBefore);
    const proposals = w.stack.runtime.policy.proposals;
    const ids = [first, second].map((x) => (x as { proposalId: string }).proposalId);
    for (const id of ids) {
      const p = proposals.get(id)!;
      expect(p).toMatchObject({ state: 'pending', requiresCanonicalApproval: false });
      expect(p.summary).toMatch(/sync_timeline_event/);
    }
    expect(
      w.stack.runtime.engine.queries
        .listErrors(PROJECT, { limit: 5 })
        .filter((e) => e.code === 'POLICY_DENIED'),
    ).toEqual([]);
    for (const id of ids) expect((await approve(id)).state).toBe('executed');
    const [fixedWeek] = eventNamed('The Week of Lanterns');
    expect(fixedWeek).toMatchObject({ start: row.start, end: row.end });
    expect(eventNamed('A comet is seen over Isar')).toHaveLength(1);
    expect(tableJson()).toBe(tableBefore);
    expect((await check()).findings).toEqual([]);
    // The audit trail records who proposed.
    const audited = w.stack.runtime.policy.store.listAudit({ action: 'chronology.propose_fix' });
    expect(audited).toHaveLength(2);
    expect(audited[0]).toMatchObject({ actor: 'owner', target: PROJECT });
  });

  it('Propose a fix on a row whose event already agrees says so, and refuses a row that is gone or a change that stopped part-way', async () => {
    const chronology = w.stack.runtime.chronology;
    const ok = await chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: 'rfour000' });
    expect(ok).toMatchObject({ status: 'nothing_to_do' });
    await expect(
      chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId: 'rfour999' }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
    await expect(
      chronology.proposeFix('owner', PROJECT, { age: 'Seventh Age', rowId: 'rfour000' }),
    ).rejects.toMatchObject({ code: 'AGE_NOT_FOUND' });
  });

  it('a row edited between the proposal and its approval stops the job inside the lock: nothing is written', async () => {
    const [gone] = eventNamed('The Quiet Years');
    deleteEvent(String(gone!.id));
    const chronology = w.stack.runtime.chronology;
    const made = (await chronology.proposeFix('owner', PROJECT, {
      age: FOURTH,
      rowId: 'rfour008',
    })) as { proposalId: string };
    // Someone edits the row's description in the app before the owner approves.
    const t = (w.repo.blocks.get(table())!.blocks as Obj[]).find((b) => b.kind === 'table')!;
    const row = (t.children as Obj[]).find((r) => r.id === 'rfour008')!;
    ((((row.children as Obj[])[0]!.children as Obj[])[0]!.content as Obj[])[0] as Obj).text =
      'The Quiet Years, retold';
    const before = events().length;
    const p = await approve(made.proposalId);
    // Stopped by the bridge's own check inside the lock, before any write.
    expect(p.state).toBe('conflicted');
    expect(events().length).toBe(before);
    // Put the row back for the checks that follow, and repair properly.
    ((((row.children as Obj[])[0]!.children as Obj[])[0]!.content as Obj[])[0] as Obj).text =
      'The Quiet Years';
    const r = await call('sync_timeline_event', { row: { row_id: 'rfour008', age: FOURTH } });
    expect(r.body.status, r.text).toBe('written');
  });
});
