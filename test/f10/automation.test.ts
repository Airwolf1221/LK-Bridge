/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matchers (expect.any, expect.stringMatching) are typed any */
/**
 * v3 F10 (ADR 0078, C1 and C2): the chronology's fixes as automation codes.
 *
 * End to end (the real stack against the mock chronology, the Arkona pack and its Repository Automation governance):
 * each code starts at Propose and proposes; switched to Apply, it runs the same plan as a job, verified; a sync that
 * changes the event's shape is proposed even at Apply, with the reason; a finding already proposed is not proposed
 * again; a row the owner marked table-only gets nothing.
 *
 * With the chronology's findings and repair stubbed (the engine's own logic under test): every code dispatches its own
 * fix, the guarded cases are proposed with the reason, the judgements are left for the owner (and never pause the code),
 * a table-only refusal is skipped, and the caps (25 per code, 100 per run) hold.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROPOSE_ONLY } from '../../src/automation/registry.js';
import { ChronologyError, type CheckRun, type ChronologyFix } from '../../src/chronology/index.js';
import { approve, check, f10World, FOURTH, PROJECT, rowByDate, type F10World } from './world.js';

type Obj = Record<string, unknown>;
let w: F10World;
const rt = () => w.stack.runtime;
const a = () => rt().automation;
const CHRONO = PROPOSE_ONLY.filter((e) => e.source === 'chronology').map((e) => e.code);
const setMode = (code: string, mode: 'off' | 'propose' | 'apply') =>
  a().store.setMode(PROJECT, code, mode, 'owner');
const itemsOf = (runId: string) => a().store.items(runId);
const tl = () => w.ages[FOURTH]!.timeline;
const eventNamed = (name: string) => w.liveEvents(tl()).find((e) => e.name === name);
const dropEvent = (name: string) => {
  const list = w.liveEvents(tl());
  const at = list.findIndex((e) => e.name === name);
  if (at < 0) throw new Error(`no event ${name}`);
  list.splice(at, 1);
};

beforeAll(async () => {
  w = await f10World();
}, 120_000);
afterAll(async () => w.close());
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of CHRONO) setMode(c, 'propose');
});

describe('the chronology codes (C1, C2)', () => {
  it('eight codes, Propose by default, Apply allowed; the judgements stay unswitchable', () => {
    expect(CHRONO.sort()).toEqual(
      [
        'chronology_row_without_event',
        'chronology_date_mismatch',
        'chronology_name_drift',
        'chronology_count_mismatch',
        'chronology_wrong_kcy',
        'chronology_wrong_uri',
        'chronology_row_out_of_order',
        'chronology_date_text_differs',
      ].sort(),
    );
    const view = a()
      .codes(PROJECT)
      .filter((c) => CHRONO.includes(c.code));
    expect(view).toHaveLength(8);
    for (const c of view) {
      expect(c.mode, c.code).toBe('propose');
      expect(c.modes, c.code).toEqual(['off', 'propose', 'apply']);
    }
    // C6: these stay judgements (not switchable).
    for (const code of [
      'chronology_event_without_row',
      'chronology_event_in_tie',
      'chronology_unreadable_date',
      'chronology_not_found',
    ])
      expect(
        a()
          .codes(PROJECT)
          .map((c) => c.code),
      ).not.toContain(code);
  });

  it('a row without an event: proposed (once); at Apply the event is made and verified', async () => {
    dropEvent('A comet is seen over Isar');
    await check(w);
    const run = await a().runChronology(PROJECT);
    const [item] = itemsOf(run.id).filter((i) => i.code === 'chronology_row_without_event');
    expect(item).toMatchObject({ outcome: 'proposed', proposalId: expect.any(String) });
    expect(rt().policy.proposals.get(item!.proposalId!)!.summary).toMatch(/sync_timeline_event/);
    // The same finding is not proposed again (the owner decides it once).
    const again = await a().runChronology(PROJECT);
    expect(itemsOf(again.id).filter((i) => i.code === 'chronology_row_without_event')).toEqual([]);
    expect((await approve(w, item!.proposalId!)).state).toBe('executed');
    expect(eventNamed('A comet is seen over Isar')).toBeDefined();

    setMode('chronology_row_without_event', 'apply');
    dropEvent('The Week of Lanterns');
    await check(w);
    const run2 = await a().runChronology(PROJECT);
    const [applied] = itemsOf(run2.id).filter((i) => i.code === 'chronology_row_without_event');
    expect(applied).toMatchObject({ outcome: 'applied', jobId: expect.any(String) });
    const job = rt().engine.queries.getJob(PROJECT, applied!.jobId!)!;
    expect(job.status).toBe('succeeded');
    expect(job.principalId).toBe('automation');
    expect(eventNamed('The Week of Lanterns')).toBeDefined();
    const rec = rt().chronology.store.byJob(PROJECT, applied!.jobId!)!;
    expect(rec).toMatchObject({ state: 'complete', tool: 'sync_timeline_event' });
    expect((await check(w)).findings.filter((f) => f.kind === 'row_without_event')).toEqual([]);
  });

  it('a date mismatch at Apply: the event moved to the row’s date; one that changes its shape is proposed with the reason', async () => {
    setMode('chronology_date_mismatch', 'apply');
    const ev = eventNamed('Ashgate falls to the Isar host')!;
    const start = Number(ev.start);
    ev.start = start + 24 * 60; // a day later, in the app
    await check(w);
    const run = await a().runChronology(PROJECT);
    expect(itemsOf(run.id).find((i) => i.code === 'chronology_date_mismatch')).toMatchObject({
      outcome: 'applied',
    });
    expect(eventNamed('Ashgate falls to the Isar host')!.start).toBe(start);

    // A single day made a range in the app: the repair would make it a single day again (a shape change).
    const day = eventNamed('Ashgate falls to the Isar host')!;
    day.end = start + 5 * 24 * 60;
    await check(w);
    const run2 = await a().runChronology(PROJECT);
    const guarded = itemsOf(run2.id).find((i) => i.code === 'chronology_date_mismatch');
    expect(guarded).toMatchObject({
      outcome: 'proposed',
      reasonCode: 'SHAPE_CHANGE',
      reason: expect.stringMatching(/shape .*range → single/),
      proposalId: expect.any(String),
    });
    expect(rt().policy.proposals.get(guarded!.proposalId!)!.summary).toMatch(/Proposed, not applied/);
    expect(eventNamed('Ashgate falls to the Isar host')!.end).toBe(start + 5 * 24 * 60);
  });

  it('a Main count that differs: proposed; at Apply the count is set to the table’s rows', async () => {
    const rows = w.rows(FOURTH).length;
    const mainDoc = w.repo.blocks.get(w.mainDoc)! as { version: number; blocks: Obj[] };
    const table = mainDoc.blocks.find((b) => b.kind === 'table')!;
    const row = (table.children as Obj[]).find((r) => r.id === w.ages[FOURTH]!.mainRow)!;
    const para = ((row.children as Obj[])[1]!.children as Obj[])[0] as Obj;
    para.content = [{ text: String(rows + 2) }];
    mainDoc.version++;
    await check(w);
    const run = await a().runChronology(PROJECT);
    expect(itemsOf(run.id).find((i) => i.code === 'chronology_count_mismatch')).toMatchObject({
      outcome: 'proposed',
    });
    setMode('chronology_count_mismatch', 'apply');
    para.content = [{ text: String(rows + 3) }];
    mainDoc.version++;
    await check(w);
    const run2 = await a().runChronology(PROJECT);
    expect(itemsOf(run2.id).find((i) => i.code === 'chronology_count_mismatch')).toMatchObject({
      outcome: 'applied',
    });
    expect(w.count(FOURTH)).toBe(String(rows));
  });

  it('a row the owner marked table-only is never given an event', async () => {
    setMode('chronology_row_without_event', 'apply');
    const rowId = String(rowByDate(w, FOURTH, 'Kumikas 3rd, 4A 881').id);
    await rt().chronology.markTableOnly('owner', PROJECT, { age: FOURTH, rowId, reason: 'test' });
    dropEvent('Ashgate falls to the Isar host');
    const c = await check(w);
    expect(c.findings.filter((f) => f.kind === 'row_without_event' && f.detail?.rowId === rowId)).toEqual([]);
    const run = await a().runChronology(PROJECT);
    expect(itemsOf(run.id).filter((i) => i.code === 'chronology_row_without_event')).toEqual([]);
    expect(eventNamed('Ashgate falls to the Isar host')).toBeUndefined();
    rt().chronology.unmarkTableOnly('owner', PROJECT, { age: FOURTH, rowId });
  });
});

describe('the engine with the chronology stubbed', () => {
  const fakeRun = (findings: CheckRun['findings']): CheckRun => ({
    id: 999_999,
    projectId: PROJECT,
    trigger: 'manual',
    state: 'succeeded',
    requests: 0,
    summary: 'stub',
    findings,
    ages: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });
  let seq = 0;
  const finding = (kind: string, detail: Obj = {}) => ({
    kind: kind as CheckRun['findings'][number]['kind'],
    age: FOURTH,
    message: `stub ${kind} ${++seq}`,
    detail: { rowId: `r${seq}`, eventId: `e${seq}`, main: '9', cell: `c${seq}`, ...detail },
  });
  const stub = (findings: CheckRun['findings'], repair: (fix: ChronologyFix) => unknown) => {
    vi.spyOn(rt().chronology.store, 'lastCheck').mockReturnValue(fakeRun(findings));
    const calls: ChronologyFix[] = [];
    vi.spyOn(rt().chronology, 'repair').mockImplementation((_actor, _p, fix) => {
      calls.push(fix);
      return Promise.resolve(repair(fix) as never);
    });
    return calls;
  };
  const proposed = () => ({
    status: 'proposal_captured',
    proposalId: `prop_${++seq}`,
    summary: 's',
    guard: null,
  });

  it('every code dispatches its own fix (name drift and the four repairs included)', async () => {
    const kinds = [
      'row_without_event',
      'date_mismatch',
      'name_drift',
      'count_mismatch',
      'wrong_kcy',
      'wrong_uri',
      'row_out_of_order',
      'date_text_differs',
    ];
    const calls = stub(
      kinds.map((k) => finding(k)),
      () => proposed(),
    );
    const run = await a().runChronology(PROJECT);
    const kindsOf = (f: ChronologyFix) => f.kind ?? 'sync';
    expect(calls.map(kindsOf).sort()).toEqual(
      ['sync', 'sync', 'sync', 'count', 'kcy', 'uri', 'order', 'style'].sort(),
    );
    expect(itemsOf(run.id).map((i) => i.outcome)).toEqual(Array(8).fill('proposed'));
  });

  it('the guarded cases are proposed with the reason; judgements are left for the owner and never pause the code', async () => {
    setMode('chronology_row_without_event', 'apply');
    let n = 0;
    stub(
      Array.from({ length: 5 }, () => finding('row_without_event')),
      () => {
        n++;
        if (n === 1)
          return { ...proposed(), guard: { code: 'QUALIFIED_DATE', reason: 'the row’s date is qualified' } };
        if (n === 2)
          return {
            ...proposed(),
            guard: {
              code: 'TABLE_ONLY_LAPSED',
              reason: 'you marked this row table-only, and its cells have changed',
            },
          };
        throw new ChronologyError(
          n === 5 ? 'ROW_DATE_UNREADABLE' : 'PAIRING_AMBIGUOUS',
          n === 5 ? 'The row’s date cannot be read.' : 'Two events could be this row’s.',
        );
      },
    );
    const run = await a().runChronology(PROJECT);
    const items = itemsOf(run.id);
    expect(items.map((i) => [i.outcome, i.reasonCode])).toEqual([
      ['proposed', 'QUALIFIED_DATE'],
      ['proposed', 'TABLE_ONLY_LAPSED'],
      ['guarded', 'PAIRING_AMBIGUOUS'],
      ['guarded', 'PAIRING_AMBIGUOUS'],
      ['guarded', 'ROW_DATE_UNREADABLE'],
    ]);
    expect(items[0]!.reason).toMatch(/proposed, not applied: the row’s date is qualified/);
    expect(items[2]!.reason).toMatch(/left for the owner/);
    expect(a().store.setting(PROJECT, 'chronology_row_without_event')?.pausedAt ?? null).toBeNull();
  });

  it('a table-only refusal is skipped, never counted towards a pause', async () => {
    stub(
      Array.from({ length: 4 }, () => finding('row_without_event')),
      () => {
        throw new ChronologyError('ROW_TABLE_ONLY', 'The owner marked the row table-only.');
      },
    );
    const run = await a().runChronology(PROJECT);
    expect(itemsOf(run.id).map((i) => [i.outcome, i.reasonCode])).toEqual(
      Array(4).fill(['skipped', 'TABLE_ONLY']),
    );
    expect(a().store.setting(PROJECT, 'chronology_row_without_event')?.pausedAt ?? null).toBeNull();
  });

  it('the caps: 25 a code, 100 a run', async () => {
    const codes = ['row_without_event', 'date_mismatch', 'name_drift', 'wrong_kcy', 'date_text_differs'];
    const calls = stub(
      codes.flatMap((k) => Array.from({ length: 30 }, () => finding(k))),
      () => proposed(),
    );
    const run = await a().runChronology(PROJECT);
    expect(calls).toHaveLength(100);
    expect(run).toMatchObject({ state: 'stopped', stopReason: 'cap' });
    const per = new Map<string, number>();
    for (const i of itemsOf(run.id)) per.set(i.code, (per.get(i.code) ?? 0) + 1);
    expect([...per.values()]).toEqual([25, 25, 25, 25]);
  });
});
