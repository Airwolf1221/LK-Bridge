/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * The permanent VERSION_CONFLICT of 10 November 2026, end to end through the REAL server and the official MCP client.
 * LegendKeeper gives a key-value property's rows in stored order from `listProperties`, `getProperty` and
 * `getResource`, and sorted by rank from `listPropertyRows`. On a page where a row was ever inserted between two
 * others (Rheashira Aela's, seeded exactly as read on the test world) the plan (stored order) and the check in the lock
 * (rank order) disagreed position by position, so every set_facts conflicted. Rows are now compared in rank order by
 * id: set_facts, the low-level writes and proposals succeed there, and real conflicts are still caught.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, kvText, RHEASHIRA, RHEASHIRA_ROWS, type FactsWorld, type MSidebar } from './world.js';

let w: FactsWorld;
let writer: Client;
let proposer: Client;
let mark = 0;
const sb = () => w.sidebars;
const since = () => sb().requests.slice(mark);
const writesSince = () => since().filter((x) => x.method !== 'GET');
const PAGE = RHEASHIRA.page;
const call = (c: Client, args: Record<string, unknown>) =>
  w.stack.call(c, 'set_facts', { page: PAGE, ...args });
const row = (key: string) =>
  sb()
    .rows(PAGE)
    .find((r) => r.key === key)!;
const rowPath = (key: string) => ({ resourceId: PAGE, propertyId: RHEASHIRA.property, rowId: row(key).id });
const keys = () =>
  sb()
    .rows(PAGE)
    .map((r) => r.key);
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string) => {
  for (let i = 0; i < 250 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};
/** Right after the plan's read and before the job's check in the lock: someone edits the page in the app. */
const afterPlanRead = (fn: (s: MSidebar) => void) =>
  sb().after(new RegExp(`^GET /resources/${PAGE}/properties/?$`), 0, () => sb().outside(PAGE, fn));
const kv = (s: MSidebar) => s.props[0]!.rows!;

beforeAll(async () => {
  w = await factsWorld();
  writer = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('rank-proposer', 'propose').token);
});
afterAll(async () => w.close());
beforeEach(() => {
  mark = sb().requests.length;
  sb().mangle = null;
  sb().placeByStoredOrder = false;
});

describe('the fixture: LegendKeeper’s two orders', () => {
  it('listProperties gives stored order, listPropertyRows rank order, and they differ', async () => {
    const read = (op: string, path: Record<string, string>) =>
      w.stack.runtime.engine.internalRead(PROJECT, op, { path }, { priority: 'P1' });
    const list = { body: await read('listProperties', { resourceId: PAGE }) };
    const rows = {
      body: await read('listPropertyRows', { resourceId: PAGE, propertyId: RHEASHIRA.property }),
    };
    const storedKeys = JSON.stringify(list.body).match(/"key":"[^"]+"/g)!;
    const rankedKeys = JSON.stringify(rows.body).match(/"key":"[^"]+"/g)!;
    expect(storedKeys).toEqual(RHEASHIRA_ROWS.map(([k]) => `"key":"${k}"`));
    expect(rankedKeys.slice(4, 8)).toEqual([
      '"key":"Subject"',
      '"key":"Life State"',
      '"key":"Race / Species"',
      '"key":"Canonical Display Name"',
    ]);
    expect(storedKeys).not.toEqual(rankedKeys);
  });
});

describe('set_facts on Rheashira: no false conflict', () => {
  it('one changed fact (Scope, the 12th stored row): written, no conflict in the lock, verified', async () => {
    const r = await call(writer, { facts: { Scope: 'Moon elf envoy and archivist' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(since().map((x) => `${x.method} ${x.path.replace(/\/$/, '')}`)).toEqual([
      `GET /resources/${PAGE}/properties`, // the plan (stored order)
      `GET /resources/${PAGE}/properties/${RHEASHIRA.property}/rows`, // the check in the lock (rank order)
      `PATCH /resources/${PAGE}/properties/${RHEASHIRA.property}/rows/rhea0012`,
      `GET /resources/${PAGE}`, // verify (stored order)
      `GET /resources/${PAGE}`, // the tree's re-read
    ]);
    expect(row('Scope').text).toBe('Moon elf envoy and archivist');
  });

  it('two changed facts (Aliases and Last Major Revision): written and verified', async () => {
    const r = await call(writer, {
      facts: { Aliases: 'Rhea; the Envoy', 'Last Major Revision': '10 November 2026' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(writesSince().map((x) => x.method)).toEqual(['PATCH', 'PATCH']);
    expect(kvText(sb().rows(PAGE))).toEqual(
      expect.arrayContaining(['Aliases=Rhea; the Envoy', 'Last Major Revision=10 November 2026']),
    );
  });

  it('a new template fact and a non-template fact: placed between the right rank-sorted neighbours, verified', async () => {
    const r = await call(writer, { facts: { Epithet: 'the Quiet Envoy', 'Favourite Colour': 'Silver' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const posts = writesSince().filter((x) => x.method === 'POST');
    // Epithet after Subject (its template predecessor); the other at the bottom.
    expect(posts.map((x) => x.body)).toEqual([
      expect.objectContaining({ key: 'Epithet', after: 'rhea0005' }),
      expect.not.objectContaining({ after: expect.anything() }),
    ]);
    // Ranked between Subject (a) and Life State (aR), the next row in RANK order, not Canonical Display Name (b).
    const epithet = row('Epithet');
    expect(epithet.rank > 'a' && epithet.rank < 'aR', epithet.rank).toBe(true);
    expect(keys().slice(4, 7)).toEqual(['Subject', 'Epithet', 'Life State']);
    expect(keys().at(-1)).toBe('Favourite Colour');
    // No rank collides; LegendKeeper appended both rows to the stored order.
    const ranks = sb()
      .rows(PAGE)
      .map((x) => x.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(
      sb()
        .storedRows(PAGE)
        .slice(-2)
        .map((x) => x.key),
    ).toEqual(['Epithet', 'Favourite Colour']);
  });

  it('the live check: Mood “Happy” as a dry run, then for real; it lands after Scope (g), before Temporal Scope (i)', async () => {
    const dry = await call(writer, { facts: { Mood: 'Happy' }, dryRun: true });
    expect(dry.body, dry.text).toMatchObject({ status: 'dry_run', writes: ['Mood: added'] });
    expect(dry.body.requiresCanonicalApproval).toBeUndefined();
    expect(writesSince()).toHaveLength(0);
    const r = await call(writer, { facts: { Mood: 'Happy' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const mood = row('Mood');
    expect(mood.rank > 'g' && mood.rank < 'i', mood.rank).toBe(true); // stored order would have put it before l
    const k = keys();
    expect(k.slice(k.indexOf('Scope'), k.indexOf('Scope') + 3)).toEqual(['Scope', 'Mood', 'Temporal Scope']);
  });

  it('the verify step catches a new row LegendKeeper ranked somewhere else than planned', async () => {
    const gone = await call(writer, { facts: { Epithet: null } });
    expect(gone.body, gone.text).toMatchObject({ status: 'written', verified: true });
    sb().placeByStoredOrder = true; // "after Subject" taken as "just before the row STORED after Subject"
    const r = await call(writer, { facts: { Epithet: 'the Quiet Envoy' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: false });
    expect(JSON.stringify(r.body.verification)).toMatch(/Epithet.{0,40}\(order\)/);
    const epithet = row('Epithet');
    expect(epithet.rank > 'af' && epithet.rank < 'b', epithet.rank).toBe(true); // after Race / Species
  });
});

describe('set_facts on Rheashira: real conflicts are still caught', () => {
  it('an outside edit of a row’s value between the plan and the lock: VERSION_CONFLICT naming that row', async () => {
    afterPlanRead((s) => {
      kv(s).find((x) => x.key === 'Naming Culture')!.content = [{ text: 'Changed in the app' }];
    });
    const r = await call(writer, { facts: { Scope: 'Should not be written' } });
    expect(r.body.error, r.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(r.body.error.message).toMatch(/“Naming Culture” \(rhea0010\)\.value/);
    expect(writesSince()).toHaveLength(0);
  });
  it('an outside reorder (a rank changed): conflict', async () => {
    afterPlanRead((s) => {
      kv(s).find((x) => x.key === 'Aliases')!.rank = 'zz';
    });
    const r = await call(writer, { facts: { Scope: 'Should not be written' } });
    expect(r.body.error, r.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(r.body.error.message).toMatch(/“Aliases” \(rhea0011\)\.rank \(reordered\)/);
    expect(writesSince()).toHaveLength(0);
  });
  it('an outside added row, and an outside deleted row: conflict', async () => {
    afterPlanRead((s) => {
      kv(s).push({ id: 'outsid01', rank: 'n', key: 'Outside Note', content: [{ text: 'x' }] });
    });
    const added = await call(writer, { facts: { Scope: 'Should not be written' } });
    expect(added.body.error, added.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(added.body.error.message).toMatch(/“Outside Note” \(outsid01\) \(added\)/);
    afterPlanRead((s) => {
      s.props[0]!.rows = kv(s).filter((x) => x.key !== 'Outside Note');
    });
    const removed = await call(writer, { facts: { Scope: 'Should not be written' } });
    expect(removed.body.error, removed.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(removed.body.error.message).toMatch(/“Outside Note” \(outsid01\) \(removed\)/);
    expect(writesSince()).toHaveLength(0);
    expect(row('Scope').text).not.toBe('Should not be written');
  });
});

describe('low-level writes and proposals on Rheashira', () => {
  it('lk_api_write updatePropertyRow at scope write: succeeds', async () => {
    const r = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: { path: rowPath('Temporal Scope'), body: { content: [{ text: 'Fourth and Fifth Ages' }] } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'succeeded' });
    expect(row('Temporal Scope').text).toBe('Fourth and Fifth Ages');
  });

  it('a proposal (as ChatGPT makes them) captures the rows; approved with no outside change, it executes', async () => {
    const low = await w.stack.call(proposer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: { path: rowPath('Naming Culture'), body: { content: [{ text: 'Sylvan (Moon)' }] } },
    });
    expect(low.body, low.text).toMatchObject({ status: 'proposal_captured' });
    await w.stack.runtime.policy.commands.approve('owner', String(low.body.proposalId));
    expect((await settle(String(low.body.proposalId))).state).toBe('executed');
    expect(row('Naming Culture').text).toBe('Sylvan (Moon)');

    const facts = await call(proposer, { facts: { Scope: 'Envoy of the Moon Court', Pronouns: 'she/her' } });
    expect(facts.body, facts.text).toMatchObject({ status: 'proposal_captured' });
    const id = String(facts.body.proposalId);
    expect(
      proposals()
        .detail(id)!
        .pageSummary.map((e) => e.label),
    ).toEqual(['Rheashira Aela: sidebar, 1 fact changed, 1 fact added']);
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id);
    expect(p.state, JSON.stringify(p.error)).toBe('executed');
    expect(proposals().detail(id)!.execution).toMatchObject({ verified: true });
    expect(row('Scope').text).toBe('Envoy of the Moon Court');
  });

  it('approved after an outside value edit: conflicted, nothing written', async () => {
    const r = await call(proposer, { facts: { Scope: 'Never written' } });
    const id = String(r.body.proposalId);
    sb().outside(PAGE, (s) => {
      kv(s).find((x) => x.key === 'Aliases')!.content = [{ text: 'Changed in the app' }];
    });
    const before = writesSince().length;
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id);
    expect(p.state).toBe('conflicted');
    expect(writesSince().length).toBe(before);
    expect(row('Scope').text).not.toBe('Never written');
  });
});

describe('the canonical guard on Rheashira', () => {
  it('changing Status to Authoritative still needs canonical approval, by set_facts and by lk_api_write', async () => {
    const r = await call(writer, { facts: { Status: 'Authoritative' } });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(/Status would be set to Authoritative/);
    const low = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: { path: rowPath('Status'), body: { content: [{ text: 'Authoritative' }] } },
    });
    expect(low.body, low.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
    });
    expect(writesSince()).toHaveLength(0);
    expect(row('Status').text).toBe('Outline');
  });
  it('changing Scope does not, and neither is confused by the order', async () => {
    const dry = await call(writer, { facts: { Scope: 'Moon elf envoy' }, dryRun: true });
    expect(dry.body.requiresCanonicalApproval).toBeUndefined();
    const r = await call(writer, { facts: { Scope: 'Moon elf envoy' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, String(r.body.jobId))!;
    expect(job.status).toBe('succeeded');
  });
});
