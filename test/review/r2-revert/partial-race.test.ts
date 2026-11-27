/**
 * R2-revert, attack (c): a partial revert the owner did not confirm.
 *
 * ADR 0055 B4: "The default is all or nothing: when any target cannot be reverted the revert is refused
 * (PARTIAL_REVERT_NEEDS_CONFIRMATION) unless the owner confirms a partial revert."
 *
 * 1. Race between the revert's submission and its job reaching a later target (writes paused, as the owner may do):
 *    each target's check runs just before that target's own writes (src/review/revert.ts joins the parts one after the
 *    other), so an outside edit to the SECOND target after the first has been written leaves a half-reverted job that
 *    the owner asked to be all or nothing.
 * 2. Race between the preview and the request: `confirmPartial` is a bare boolean, bound to nothing the owner saw. The
 *    dashboard asks "Revert the other N anyway"; a target that changed meanwhile drops out and the revert goes ahead
 *    with fewer (or other) targets than the owner confirmed.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { londonDate } from '../../../src/jobs/internal-steps.js';
import { factsWorld, RHEASHIRA, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, sleep, until, writeAgent } from './helpers.js';

let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-partial-agent')).client;
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify([
      {
        id: RHEASHIRA.property,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [{ key: 'Last Major Revision', text: '9 November 2026' }],
      },
    ]),
    PROJECT,
    RHEASHIRA.page,
  );
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const docOf = (page: string) => w.repo.liveDocs(w.repo.live(page)!).find((d) => d.name === 'Main')!.id;
const lmrRow = () =>
  w.sidebars.pages.get(RHEASHIRA.page)!.props[0]!.rows!.find((x) => x.key === 'Last Major Revision')!;
const text = () => JSON.stringify(w.repo.blocks.get(docOf(RHEASHIRA.page))!.blocks);

describe('all or nothing', () => {
  it('an outside edit to the second target while the revert job waits: nothing may be written', async () => {
    w.repo.blocks.set(docOf(RHEASHIRA.page), {
      version: 11,
      blocks: [{ id: 'rhpara01', kind: 'paragraph', content: [{ text: 'An envoy of the Hollow Court.' }] }],
    });
    const a = await call('write_page', {
      page: RHEASHIRA.page,
      mode: 'append',
      markdown: 'She crossed the northern marches twice and returned with the treaty sealed in silver.',
    });
    expect(a.body.status, a.text).toBe('written');
    const jobId = jobOf(a);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(lmrRow().content).toEqual([{ text: londonDate(Date.now()) }]);
    const asTheJobLeftIt = text();

    // Every target is ready; the owner reverts without a partial confirmation (all or nothing).
    const preview = await rt().reverts.preview(PROJECT, jobId);
    expect(preview.targets.map((t) => `${t.kind}:${t.state}`).sort()).toEqual(['lmr:ready', 'text:ready']);
    rt().engine.controls.pauseWrites('owner');
    let revertJobId: string;
    try {
      const r = await rt().reverts.revert('owner', PROJECT, jobId);
      expect(r.status, JSON.stringify(r)).toBe('submitted');
      revertJobId = (r as { revertJobId: string }).revertJobId;
      await sleep(300);
      // Meanwhile the owner sets the date by hand in the app.
      w.sidebars.outside(RHEASHIRA.page, () => {
        lmrRow().content = [{ text: 'set by hand' }];
      });
    } finally {
      rt().engine.controls.resumeWrites('owner');
    }
    const job = await rt().engine.wait(PROJECT, revertJobId, 25_000);
    expect(lmrRow().content).toEqual([{ text: 'set by hand' }]); // never overwritten: good
    expect(job.status).toBe('failed'); // the date's check stopped it …
    // … and all or nothing means the page text must still be as the job left it.
    expect(text() === asTheJobLeftIt, `revert job error: ${job.lastError?.message ?? ''}`).toBe(true);
  });

  it('a target that changes between the preview and the request drops out of a confirmed partial revert', async () => {
    // A job with three targets: aliases (ready), a move to another index (ready) and a document it made (v3 F12: deleted
    // again by Revert while untouched; here renamed in the app since, so it is kept: changed).
    const page = 'bk000004';
    const res = () => w.repo.live(page)!;
    const r = await call('lk_api_batch', {
      onError: 'stop',
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: page }, body: { aliases: ['Gate notes'] } },
        },
        {
          operationId: 'moveResource',
          params: { path: { resourceId: page }, body: { parentId: 'grp00003' } },
        },
        {
          operationId: 'createDocument',
          params: { path: { resourceId: page }, body: { name: 'Notes', type: 'page' } },
        },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    const done = await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(done.status, JSON.stringify(done.lastError)).toBe('succeeded');
    expect(res().parentId).toBe('grp00003');
    // Someone renames the document the job made, in the app: Revert keeps it.
    const made = w.repo.liveDocs(res()).find((d) => d.name === 'Notes')!;
    made.name = 'Notes (kept)';
    // The owner's preview: two targets ready, one that is not reverted. The dashboard therefore asks "Revert the
    // other 2 anyway (a partial revert)" and, confirmed, sends confirmPartial: true.
    const preview = await rt().reverts.preview(PROJECT, jobId);
    const seen = preview.targets
      .filter((t) => t.state === 'ready')
      .map((t) => t.key)
      .sort();
    expect(seen, JSON.stringify(preview.targets)).toEqual([`move:${page}`, `resource:${page}`]);
    expect(preview.notReverted).toBe(1);
    // While the owner re-authenticates, someone moves the page again in the app.
    w.repo.outside.move(page, 'grp00005');
    const rv = await rt().reverts.revert('owner', PROJECT, jobId, { confirmPartial: true });
    const reverted =
      rv.status === 'submitted'
        ? rv.targets
            .filter((t) => t.state === 'ready')
            .map((t) => t.key)
            .sort()
        : [];
    if (rv.status === 'submitted') await rt().engine.wait(PROJECT, rv.revertJobId, 25_000);
    // Safe: refused because the set changed (as "Mark all reviewed" refuses with REVIEW_CHANGED), or exactly the set
    // the owner confirmed.
    expect(
      rv.status === 'refused' || reverted.join() === seen.join(),
      `confirmed ${seen.join(', ')}; reverted ${reverted.join(', ')}`,
    ).toBe(true);
  });
});

void until;
