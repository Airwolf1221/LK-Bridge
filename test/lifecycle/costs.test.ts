/**
 * The costs docs/tools.md states for the page lifecycle tools (v2 C2c, ADR 0035): reads and writes to capture the
 * proposal (planning, the note's place, the related pages' one content search), then the job the owner's "Approve and
 * accept as canon" runs (its checks, the canon guard's and the lifecycle guard's in-lock reads, the writes, the verify
 * step and the tree's re-reads), measured against the mock LegendKeeper so the documented numbers stay true.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accept, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
beforeAll(async () => {
  w = await lifecycleWorld();
});
afterAll(async () => w.close());

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 20));
};

it('reads and writes per call: to capture the proposal, then the job', async () => {
  // v3 F12 (ADR 0081): at scope write these run directly; the proposal and its approval are measured at scope propose.
  const c = await w.stack.connect(w.stack.newToken('lifecycle-costs-propose', 'propose').token);
  const got: Record<string, { capture: [number, number]; job: [number, number] }> = {};
  const split = (lines: string[]): [number, number] => [
    lines.filter((l) => l.startsWith('GET')).length,
    lines.filter((l) => !l.startsWith('GET')).length,
  ];
  const measure = async (label: string, tool: string, args: Record<string, unknown>) => {
    const a = w.seen.length;
    const r = await w.stack.call(c, tool, { project: 'test', ...args });
    expect(r.body.status, `${label}: ${r.text}`).toBe('proposal_captured');
    const b = w.seen.length;
    const done = await accept(w, r);
    expect(done.body, `${label}: ${done.text}`).toMatchObject({ status: 'written', verified: true });
    await settle();
    got[label] = { capture: split(w.seen.slice(a, b)), job: split(w.seen.slice(b)) };
  };
  await measure('archive_page, Authoritative', 'archive_page', { page: 'Old Harbour' });
  await measure('unarchive_page, to Authoritative', 'unarchive_page', { page: 'Old Harbour' });
  await measure('move_to_working', 'move_to_working', { page: 'Harbour Guild' });
  await measure('promote_page', 'promote_page', { page: 'Harbour Guild', destination: 'locs0001' });
  await measure('archive_page, Working', 'archive_page', { page: 'Sky Ferry' });
  await measure('unarchive_page, to Working', 'unarchive_page', { page: 'Sky Ferry' });
  // The job's reads: the approval's re-read of what was captured (the page, its rows, the note's document), its checks
  // inside the lock (the page, its rows, the note's block), the in-lock reads before each write (the page before a
  // rename or move, the rows before the facts and the lifecycle guard's sidebar read for the Status, the document before
  // the note), then the verify step (the new parent's listing, the page, the note) and the tree's one re-read of the
  // page. CR-2026-11 (CR-03) took 4 reads off each job without dropping a check: the canon and lifecycle guards' entry
  // reads of the sidebar (2) now use the approval's re-read of the page, made a moment before; and the tree re-reads the
  // page once when the job ends, not after the rename and the move as well (2). v3 F12 (ADR 0081, op-meta): the fact
  // and note updates now keep a journal pre-image, which costs archive_page and unarchive_page 3 more reads (4 for a
  // Working page's archiving, whose five facts are all updates).
  expect(got).toEqual({
    'archive_page, Authoritative': { capture: [6, 0], job: [18, 8] },
    'unarchive_page, to Authoritative': { capture: [4, 0], job: [18, 7] },
    move_to_working: { capture: [3, 0], job: [11, 3] },
    promote_page: { capture: [2, 0], job: [11, 5] },
    'archive_page, Working': { capture: [5, 0], job: [19, 8] },
    'unarchive_page, to Working': { capture: [4, 0], job: [18, 7] },
  });
});
