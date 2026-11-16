/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F2 (ADR 0049 decision 1): a qualified event's name stays true to its row.
 *
 * The bridge names a qualified row's event `<opening words> – <Date cell>` (ADR 0048 decision 3). When the owner later
 * edits the cell, the tail follows it in the same proposal as the date; a plain row loses the tail; a change of wording
 * alone is a `name_drift` finding with a name-only fix. Only tails the bridge wrote count: an unlinked event, an
 * event the owner renamed and the opening words are never touched. Only the LAST ` – ` separates the tail.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renameFor, renameLine, splitNameTail, nameWithTail } from '../../src/chronology/names.js';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from './world.js';

type Obj = Record<string, unknown>;
const FOURTH = 'Fourth Arkonan Age';

const budget = {
  env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
  limits: { 'key-min': 5000, 'write-min': 2000 },
};

describe('the name helpers', () => {
  it('splits at the last separator only', () => {
    expect(splitNameTail('The war – first phase – c. 4A 580')).toEqual({
      opening: 'The war – first phase',
      tail: 'c. 4A 580',
    });
    expect(splitNameTail('No tail here')).toBeNull();
  });
  it('caps the whole name at 500 characters', () => {
    const name = nameWithTail('x'.repeat(480), `c. 4A 563; ${'y'.repeat(100)}`);
    expect(name.length).toBeLessThanOrEqual(500);
    expect(name.endsWith('...')).toBe(true);
  });
  it('the proposal line shows the unchanged opening words as …', () => {
    expect(renameLine('A – c. 4A 563; exact date unresolved', 'A – Isar 3rd, 4A 563; disputed')).toBe(
      'name: "… – c. 4A 563; exact date unresolved" → "… – Isar 3rd, 4A 563; disputed"',
    );
    expect(renameLine('A – c. 4A 563', 'A')).toBe('name: "… – c. 4A 563" → "A" (the date tail dropped)');
  });
  it('renames only an event linked with a tail the bridge wrote, still in its name', () => {
    const row = { id: 'r1', dateText: 'c. 4A 564; x', reading: {} } as never;
    const link = { tableDocumentId: 't', rowId: 'r1', timelineDocumentId: 'l', eventId: 'e1', age: 'A' };
    const ev = { id: 'e1', name: 'Words – c. 4A 563; x' };
    expect(renameFor(ev, { ...link, nameTail: 'c. 4A 563; x' }, row)).toBe('Words – c. 4A 564; x');
    expect(renameFor(ev, { ...link, nameTail: '' }, row)).toBeNull();
    expect(renameFor(ev, null, row)).toBeNull();
    expect(
      renameFor({ ...ev, name: 'Words – my own note' }, { ...link, nameTail: 'c. 4A 563; x' }, row),
    ).toBeNull();
  });
});

describe('a qualified event’s name follows its row (ADR 0049 decision 1)', () => {
  let w: ChronologyWorld;
  let client: Client;
  const call = (tool: string, args: Record<string, unknown>) =>
    w.stack.call(client, tool, { project: 'test', ...args });
  const table = () => w.ages[FOURTH]!.table;
  const tl = () => w.ages[FOURTH]!.timeline;
  const tableBlock = () => (w.repo.blocks.get(table())!.blocks as Obj[]).find((b) => b.kind === 'table')!;
  const cell = (id: string, text: string) => ({
    id: `${id}c`,
    kind: 'tableCell',
    children: [{ id: `${id}p`, kind: 'paragraph', content: [{ text }] }],
  });
  const addRow = (id: string, date: string, description: string, kcy: string) =>
    (tableBlock().children as Obj[]).push({
      id,
      kind: 'tableRow',
      children: [cell(`${id}a`, description), cell(`${id}b`, date), cell(`${id}c`, kcy)],
    });
  const setDate = (rowId: string, text: string) => {
    const row = (tableBlock().children as Obj[]).find((r) => r.id === rowId)!;
    ((row.children as Obj[])[1]!.children as Obj[])[0]!.content = [{ text }];
  };
  const syncCount = () => {
    const main = (w.repo.blocks.get(w.mainDoc)!.blocks as Obj[]).find((b) => b.kind === 'table')!;
    const row = (main.children as Obj[]).find((r) => r.id === w.ages[FOURTH]!.mainRow)!;
    ((row.children as Obj[])[1]!.children as Obj[])[0]!.content = [
      { text: String((tableBlock().children as Obj[]).length - 1) },
    ];
  };
  const named = (prefix: string) => w.events(tl()).find((e) => String(e.name).startsWith(prefix))!;
  const check = async () => {
    await w.stack.runtime.chronology.check(PROJECT, 'manual', 'P0');
    return w.stack.runtime.chronology.store.lastCheck(PROJECT)!;
  };
  const drift = async () =>
    (await check()).findings.filter((f) => f.kind === 'name_drift').map((f) => f.detail!.rowId);
  const approve = async (id: string) => {
    const proposals = w.stack.runtime.policy.proposals;
    await w.stack.runtime.policy.commands.approve('owner', id);
    for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
      await new Promise((res) => setTimeout(res, 20));
    return proposals.get(id)!;
  };
  const fix = async (rowId: string) => {
    const r = await w.stack.runtime.chronology.proposeFix('owner', PROJECT, { age: FOURTH, rowId });
    expect(r).toMatchObject({ status: 'proposal_captured' });
    const id = (r as { proposalId: string }).proposalId;
    const summary = w.stack.runtime.policy.proposals.get(id)!.summary;
    expect((await approve(id)).state).toBe('executed');
    return summary;
  };

  const R = {
    moved: { id: 'rntmove1', date: 'c. 4A 563; exact date unresolved', d: 'The Menkhet charter is sealed' },
    plain: { id: 'rntplan1', date: 'c. 4A 565; exact date unresolved', d: 'The Isar tribunal convenes' },
    words: { id: 'rntword1', date: 'c. 4A 567; exact date unresolved', d: 'Mehrana writes to the Divan' },
    dash: { id: 'rntdash1', date: 'c. 4A 569; exact date unresolved', d: 'The war – first phase' },
    renamed: { id: 'rntownr1', date: 'c. 4A 571; exact date unresolved', d: 'The envoys return' },
    owner: { id: 'rntunln1', date: 'c. 4A 573; exact date unresolved', d: 'The owner’s own event' },
  } as const;

  beforeAll(async () => {
    w = await chronologyWorld(budget);
    client = await w.stack.connect();
    for (const r of Object.values(R)) addRow(r.id, r.date, r.d, 'Unassigned');
    syncCount();
    for (const r of [R.moved, R.plain, R.words, R.dash, R.renamed]) {
      const res = await call('sync_timeline_event', { row: { row_id: r.id, age: FOURTH } });
      expect(res.body, res.text).toMatchObject({ status: 'written', action: 'create' });
      expect(named(r.d).name).toBe(`${r.d} – ${r.date}`);
    }
    // An event the owner made in the app, with a ` – ` of their own; paired by its date and name, never linked.
    w.liveEvents(tl()).push({
      id: 'eownerev',
      laneId: w.ages[FOURTH]!.lane,
      type: 'event',
      rank: 'z9',
      name: `${R.owner.d} – my own note`,
      start: CAL.parser.parse('4A 573').start,
      detail: 1,
      uri: `lk://resources/${C.resource}/docs/${table()}`,
    });
    expect(await drift()).toEqual([]);
  });
  afterAll(() => w?.close());

  it('a date change rewrites the tail in the same proposal, and says so', async () => {
    setDate(R.moved.id, 'Isar 3rd, 4A 563; exact day disputed');
    const summary = await fix(R.moved.id);
    expect(summary).toContain(
      'name: "… – c. 4A 563; exact date unresolved" → "… – Isar 3rd, 4A 563; exact day disputed"',
    );
    const e = named(R.moved.d);
    expect(e).toMatchObject({
      name: `${R.moved.d} – Isar 3rd, 4A 563; exact day disputed`,
      start: CAL.parser.parse('Isar 3rd, 4A 563').start,
      detail: 3,
    });
    // The link now records the new tail: no drift, and a later change follows it again.
    expect(await drift()).toEqual([]);
  });

  it('a row that becomes plain drops the tail and its separator', async () => {
    setDate(R.plain.id, 'Isar 3rd, 4A 565');
    const summary = await fix(R.plain.id);
    expect(summary).toContain('(the date tail dropped)');
    expect(named(R.plain.d)).toMatchObject({ name: R.plain.d, detail: 3 });
    expect(await drift()).toEqual([]);
  });

  it('wording alone: a name_drift finding, fixed by a name-only update', async () => {
    setDate(R.words.id, 'circa 4A 567; exact date unresolved');
    const before = named(R.words.d);
    const c = await check();
    const f = c.findings.filter((x) => x.kind === 'name_drift');
    expect(f.map((x) => x.detail!.rowId)).toEqual([R.words.id]);
    expect(f[0]!.message).toContain(
      '"… – c. 4A 567; exact date unresolved" → "… – circa 4A 567; exact date unresolved"',
    );
    expect(c.findings.filter((x) => x.kind === 'date_mismatch')).toEqual([]);
    const mark = w.mark();
    const summary = await fix(R.words.id);
    expect(summary).toMatch(/correct the .* \(name\)/);
    const after = named(R.words.d);
    expect(after).toMatchObject({ id: before.id, start: before.start, detail: before.detail });
    expect(after.name).toBe(`${R.words.d} – circa 4A 567; exact date unresolved`);
    const writes = mark().lines.filter((l) => !l.startsWith('GET '));
    expect(writes.filter((l) => l.includes('/events/'))).toHaveLength(1);
    expect(await drift()).toEqual([]);
  });

  it('only the last – counts: opening words with their own – are kept', async () => {
    setDate(R.dash.id, 'c. 4A 569; disputed');
    expect(await drift()).toEqual([R.dash.id]);
    await fix(R.dash.id);
    expect(named(R.dash.d).name).toBe('The war – first phase – c. 4A 569; disputed');
  });

  it('an event the owner renamed is theirs: never renamed', async () => {
    const live = w.liveEvents(tl()).find((e) => String(e.name).startsWith(R.renamed.d))!;
    live.name = `${R.renamed.d} – as the owner wrote it`;
    setDate(R.renamed.id, 'circa 4A 571; exact date unresolved');
    expect(await drift()).toEqual([]);
    setDate(R.renamed.id, 'c. 4A 572; exact date unresolved');
    const summary = await fix(R.renamed.id);
    expect(summary).not.toContain('name:');
    expect(named(R.renamed.d).name).toBe(`${R.renamed.d} – as the owner wrote it`);
  });

  it('an unlinked event with a – of its own is never renamed, and stays so after a fix links it', async () => {
    setDate(R.owner.id, 'c. 4A 574; exact date unresolved');
    expect(await drift()).toEqual([]);
    const summary = await fix(R.owner.id);
    expect(summary).not.toContain('name:');
    expect(w.events(tl()).find((e) => e.id === 'eownerev')).toMatchObject({
      name: `${R.owner.d} – my own note`,
      start: CAL.parser.parse('4A 574').start,
    });
    setDate(R.owner.id, 'circa 4A 574; exact date unresolved');
    expect(await drift()).toEqual([]);
  });

  it('a link made before migration 2800 is recognised from its record', async () => {
    const db = w.stack.runtime.chronology.store.db;
    db.prepare('UPDATE chronology_links SET name_tail = NULL WHERE project_id = ?').run(PROJECT);
    const links = w.stack.runtime.chronology.store.links(PROJECT);
    const ofRow = (id: string) => links.find((l) => l.rowId === id)!.nameTail;
    // Made with a tail, which the record of its creation shows: recognised as the tail written then (F1 never renamed).
    expect(ofRow(R.plain.id)).toBe('c. 4A 565; exact date unresolved');
    // The tail is only used while the name still ends with it: this one was rewritten since, so it is left alone.
    expect(ofRow(R.moved.id)).toBe('c. 4A 563; exact date unresolved');
    // The owner's event: no record created it, so it has no tail of the bridge's.
    expect(ofRow(R.owner.id)).toBe('');
    // Stored, so the next read is the same.
    expect(
      (
        db
          .prepare('SELECT name_tail FROM chronology_links WHERE project_id = ? AND row_id = ?')
          .get(PROJECT, R.owner.id) as { name_tail: string | null }
      ).name_tail,
    ).toBe('');
  });
});
