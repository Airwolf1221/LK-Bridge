/**
 * R2-revert, attacks (a)/(d): a LATER job's change overwritten, and ids reused.
 *
 * Revert decides "nothing has changed since the job" by comparing each target's content with what the job left
 * (src/review/revert-plan.ts). It never asks the journal whether another job wrote the same target afterwards. When a
 * later job leaves the target with the same content (it re-applied the same change after the owner undid it by hand, or
 * re-inserted a block under the same id), reverting the EARLIER job silently undoes the later one, which stays on the
 * Review page as an unreviewed job whose own revert now finds "nothing to revert".
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

type Obj = Record<string, unknown>;
let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-later-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const notes = () => w.sidebars.rows(P.miyabi).find((r) => r.key === 'Notes')!.text;

describe('a later job’s change is never reverted with an earlier job', () => {
  it('a fact: job 1 sets it, the owner undoes it by hand, job 2 sets it again; reverting job 1 keeps job 2’s value', async () => {
    const value = 'Kept the lamps of the inner shrine';
    const a = await call('set_facts', { page: P.miyabi, facts: { Notes: value } });
    expect(a.body.status, a.text).toBe('written');
    const job1 = jobOf(a);
    await rt().engine.wait(PROJECT, job1, 25_000);
    // The owner puts the old value back in the app …
    w.sidebars.outside(P.miyabi, (sb) => {
      const row = sb.props.find((p) => p.title === 'PROPERTIES')!.rows!.find((r) => r.key === 'Notes')!;
      row.content = [{ text: 'First notes' }];
    });
    // … and later an agent sets it again (job 2: a direct write of its own, on the Review page).
    const b = await call('set_facts', { page: P.miyabi, facts: { Notes: value } });
    expect(b.body.status, b.text).toBe('written');
    const job2 = jobOf(b);
    await rt().engine.wait(PROJECT, job2, 25_000);
    expect(notes()).toBe(value);

    const { r } = await revertAndWait(w.stack, job1);
    const r2 = await rt().reverts.preview(PROJECT, job2);
    expect(
      { notes: notes(), job2: r2.targets.map((t) => `${t.kind}:${t.state}`) },
      `revert of job 1: ${r.status}`,
    ).toEqual({ notes: value, job2: ['facts:ready'] });
  });

  it('a block id reused: job 2 re-inserts the block job 1 added (the owner had deleted it); reverting job 1 keeps it', async () => {
    const page = 'ashg0002';
    const doc = w.repo.liveDocs(w.repo.live(page)!).find((d) => d.name === 'Main')!.id;
    const block = {
      id: 'r2blk001',
      kind: 'paragraph',
      content: [{ text: 'The harbour chain is raised at dusk.' }],
    };
    const insert = () =>
      call('lk_api_write', {
        operationId: 'insertBlock',
        params: { path: { resourceId: page, documentId: doc }, body: { block } },
      });
    const a = await insert();
    expect(a.isError, a.text).toBe(false);
    const job1 = jobOf(a);
    await rt().engine.wait(PROJECT, job1, 25_000);
    // The owner deletes it in the app.
    const d = w.repo.blocks.get(doc)!;
    d.blocks = (d.blocks as Obj[]).filter((x) => x.id !== block.id);
    d.version++;
    // Job 2 inserts it again, same id and words.
    const b = await insert();
    expect(b.isError, b.text).toBe(false);
    const job2 = jobOf(b);
    await rt().engine.wait(PROJECT, job2, 25_000);
    const has = () => (w.repo.blocks.get(doc)!.blocks as Obj[]).some((x) => x.id === block.id);
    expect(has()).toBe(true);

    const { r } = await revertAndWait(w.stack, job1);
    expect(has(), `revert of job 1: ${r.status}`).toBe(true);
  });
});
