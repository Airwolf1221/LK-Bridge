/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matchers (expect.any, expect.stringMatching) are typed any */
/**
 * v3 F10 (ADR 0078), end to end on the mock: a row added DIRECTLY to an age table with write_page (as ChatGPT does), its
 * change snapshot, the chronology check a moment later (CHRONOLOGY_CHECK_DELAY_MS shortened to a second here), and then
 * a sync proposal (the code at Propose, the default) or the event created and verified (the code at Apply). The
 * write_page result carries the chronology note (C4); a write to any other document does not. The repair is in the
 * workstream of the table edit that caused it (C5). Repeated checks and syncs return to their memory baseline.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatKcy } from '../../src/calendar/index.js';
import { CHRONOLOGY_TABLE_NOTE } from '../../src/mcp/tools/chronology-note.js';
import { CAL } from '../chronology/world.js';
import { cellText, f10World, PROJECT, tableRows, type F10World } from './world.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

type Obj = Record<string, unknown>;
const THIRD = 'Third Arkonan Age';
let w: F10World;
let client: Client;
const rt = () => w.stack.runtime;
const call = (tool: string, args: Obj) => w.stack.call(client, tool, { project: 'test', ...args });
const tl = () => w.ages[THIRD]!.timeline;

/** Adds one row at the end of the Third Age's table with write_page (read first, its version passed back). */
async function addRow(date: string, description: string, o: { workstream?: string } = {}) {
  const read = await call('read_document', { resource: 'chrono01', document: `${THIRD} - Table` });
  const body = read.body as { markdown: string; version: string };
  const kcy = formatKcy(CAL.parser.parse(date).kcy, rt().chronology.config(PROJECT).style.kcy);
  const lines = body.markdown.split('\n');
  const last = lines.reduce((at, l, i) => (l.startsWith('|') ? i : at), -1);
  lines.splice(last + 1, 0, `| ${description} | ${date} | ${kcy} |`);
  return call('write_page', {
    page: 'chrono01',
    document: `${THIRD} - Table`,
    mode: 'replace',
    markdown: lines.join('\n'),
    baseVersion: body.version,
    ...(o.workstream ? { workstream: o.workstream } : {}),
  });
}

/** Waits (real time) until the project's newest chronology check is an after-edit one that ended, and its run. */
async function afterEditSettled(since: number) {
  for (let i = 0; i < 400; i++) {
    const last = rt().chronology.store.lastCheck(PROJECT);
    const run = rt()
      .automation.store.runs(PROJECT, { since, limit: 5 })
      .find((r) => r.trigger === 'chronology');
    if (last && last.trigger === 'after-edit' && last.startedAt >= since && run?.finishedAt)
      return { last, run };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the check after the edit did not run');
}

beforeAll(async () => {
  w = await f10World({ checkDelayMs: 1000 });
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('a row added directly to an age table', () => {
  it('Propose (the default): the result carries the note; a check a moment later; ONE sync proposal for the row', async () => {
    const since = Date.now();
    const r = await addRow('Kumikas 1st, 3A 301', 'The Hollow Court is sealed');
    expect(r.body, r.text).toMatchObject({ status: 'written', chronologyNote: CHRONOLOGY_TABLE_NOTE });
    const { last, run } = await afterEditSettled(since);
    expect(last.findings.map((f) => f.kind)).toContain('row_without_event');
    const item = rt()
      .automation.store.items(run.id)
      .find((i) => i.code === 'chronology_row_without_event');
    expect(item).toMatchObject({ outcome: 'proposed', proposalId: expect.any(String) });
    // Nothing on the timeline yet: the owner approves the proposal.
    expect(w.liveEvents(tl()).some((e) => e.name === 'The Hollow Court is sealed')).toBe(false);
  });

  it('Apply: the event created and verified, in the edit’s workstream', async () => {
    rt().automation.store.setMode(PROJECT, 'chronology_row_without_event', 'apply', 'owner');
    const since = Date.now();
    const r = await addRow('Kumikas 1st, 3A 302', 'The Hollow Court is opened again', {
      workstream: 'f10-hollow-court',
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', chronologyNote: CHRONOLOGY_TABLE_NOTE });
    const { run } = await afterEditSettled(since);
    const item = rt()
      .automation.store.items(run.id)
      .find((i) => i.code === 'chronology_row_without_event' && i.outcome === 'applied');
    expect(item).toMatchObject({ jobId: expect.any(String) });
    const job = rt().engine.queries.getJob(PROJECT, item!.jobId!)!;
    expect(job.status).toBe('succeeded');
    expect(job.origin.workstream).toBe('f10-hollow-court');
    const made = w.liveEvents(tl()).find((e) => e.name === 'The Hollow Court is opened again');
    expect(made).toMatchObject({ start: CAL.parser.parse('Kumikas 1st, 3A 302').start });
    expect(rt().chronology.store.byJob(PROJECT, item!.jobId!)).toMatchObject({
      state: 'complete',
      detail: expect.objectContaining({ verified: true }),
    });
    // C5: bridge_workstream_report attributes the sync to the edit's workstream.
    const rep = await call('bridge_workstream_report', { workstream: 'f10-hollow-court' });
    expect(JSON.stringify(rep.body)).toContain(item!.jobId!);
    // The Chronology page's view: the synced row, and when the automation last ran.
    const view = rt().automation.chronologyView(PROJECT);
    expect(view.items.some((i) => i.jobId === item!.jobId && i.outcome === 'applied')).toBe(true);
    expect(view.lastChronologyRun?.id).toBe(run.id);
  });

  it('a write to a document that is not an age table carries no note', async () => {
    const read = await call('read_document', { resource: 'chrono01', document: 'Main' });
    const body = read.body as { markdown: string; version: string };
    const r = await call('write_page', {
      page: 'chrono01',
      document: 'Main',
      mode: 'replace',
      markdown: body.markdown,
      baseVersion: body.version,
    });
    expect((r.body as Obj).chronologyNote).toBeUndefined();
  });

  it('repeated checks and syncs return to their memory baseline', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const heapMb = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 20));
        gc();
      }
      return process.memoryUsage().heapUsed / 1048576;
    };
    rt().automation.store.setMode(PROJECT, 'chronology_row_without_event', 'apply', 'owner');
    const ev = () =>
      w.liveEvents(tl()).findIndex((e) => String(e.name).startsWith('The Hollow Court is founded'));
    const row = () => tableRows(w, THIRD).find((r) => cellText(r, 1) === '3A 300')!;
    let n = 0;
    const cycle = async () => {
      // An edit in the app rewords the row and takes its event away (a new finding each time: a finding the automation
      // applied is never acted on twice); the check finds it; the automation makes the event again.
      n++;
      const cell = (row().children as Obj[])[0]!;
      ((cell.children as Obj[])[0] as Obj).content = [{ text: `The Hollow Court is founded (${n})` }];
      (w.repo.blocks.get(w.ages[THIRD]!.table)! as { version: number }).version++;
      const at = ev();
      if (at >= 0) w.liveEvents(tl()).splice(at, 1);
      await rt().chronology.check(PROJECT, 'manual', 'P0');
      await rt().automation.runChronology(PROJECT);
      expect(ev()).toBeGreaterThanOrEqual(0);
    };
    for (let i = 0; i < 2; i++) await cycle();
    const base = await heapMb();
    for (let i = 0; i < 8; i++) await cycle();
    const after = await heapMb();
    console.info(
      `[F10] checks and syncs: heap ${base.toFixed(1)} MB after 2, ${after.toFixed(1)} MB after 10`,
    );
    expect(after - base).toBeLessThan(8);
    expect(tableRows(w, THIRD).map((r) => cellText(r, 1))).toContain('Kumikas 1st, 3A 302');
  });
});
