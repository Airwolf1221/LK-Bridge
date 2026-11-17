/**
 * R2-revert, attacks (a)/(c) on the sidebar facts.
 *
 * 1. "Succeeded" although the revert did not land: the revert's own verify step finds the row not as planned
 *    (LegendKeeper stored something else), which a verify step records but never turns into a failure. RevertService
 *    `finished()` (src/review/revert.ts) settles the revert from the job's status alone: `succeeded`, the item marked
 *    reviewed via revert, audited `succeeded`.
 * 2. A row matched by its key, not its identity: src/review/revert-plan.ts `rowDiffs` matches a row by id, then by key
 *    whatever the ids. The owner replacing the job's row with a new row of the same key and words (delete and re-add in
 *    the app) is "nothing changed since the job", and the revert rewrites the owner's row, which the job never touched.
 * 3. Rows re-ordered by the owner after the job (control): the values go back, the owner's order is kept.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-facts-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const props = (page: string) => w.sidebars.pages.get(page)!.props.find((p) => p.title === 'PROPERTIES')!;
const value = (page: string, key: string) => w.sidebars.rows(page).find((r) => r.key === key)?.text;

describe('sidebar facts', () => {
  it('a revert whose own verify finds the row not as planned is not reported as succeeded', async () => {
    const r = await call('set_facts', { page: P.mehrana, facts: { Notes: 'Tidied by the agent' } });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    // LegendKeeper stores the revert's write differently (e.g. normalised): Notes is not "Loose" afterwards.
    w.sidebars.mangle = (req, sb) => {
      if (req.method !== 'PATCH') return;
      const row = sb.props.find((p) => p.title === 'PROPERTIES')!.rows!.find((x) => x.key === 'Notes');
      if (row) row.content = [{ text: 'Loose (stored otherwise)' }];
    };
    try {
      const { r: rv, job } = await revertAndWait(w.stack, jobId);
      expect(rv.status).toBe('submitted');
      expect(value(P.mehrana, 'Notes')).not.toBe('Loose'); // not back as it was
      // Precondition: the revert job's own verify step saw it.
      const verify = (rt().engine.stepRecords(PROJECT, job!.id) ?? []).filter(
        (s) => s.opId === 'bridge.verify',
      );
      expect(
        verify.some(
          (s) => (s.result as { verification?: { status?: string } }).verification?.status === 'mismatch',
        ),
      ).toBe(true);
      const audit = rt().policy.store.listAudit({ action: 'job.revert', limit: 1 })[0]!;
      expect({
        reviewedVia: rt().review.store.get(PROJECT, jobId)!.reviewedVia,
        outcome: (audit.after as { outcome?: string }).outcome,
        job: job?.status,
      }).not.toMatchObject({ reviewedVia: 'revert', outcome: 'succeeded' });
    } finally {
      w.sidebars.mangle = null;
    }
  });

  it('the owner replaces the job’s row with a new one of the same key and words: the revert must not write it', async () => {
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: 'Set by the agent' } });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    // In the app: the row deleted, and a new "Notes" row added with the same words (a new row id).
    let ownersRowId = '';
    w.sidebars.outside(P.miyabi, (sb) => {
      const p = sb.props.find((x) => x.title === 'PROPERTIES')!;
      const old = p.rows!.find((x) => x.key === 'Notes')!;
      p.rows = p.rows!.filter((x) => x !== old);
      ownersRowId = 'ownrow01';
      p.rows.push({
        id: ownersRowId,
        rank: `${old.rank}~`,
        key: 'Notes',
        content: [{ text: 'Set by the agent' }],
      });
    });
    const { r: rv } = await revertAndWait(w.stack, jobId);
    const row = props(P.miyabi).rows!.find((x) => x.id === ownersRowId);
    expect(
      { revert: rv.status, ownersRow: row?.content },
      'the owner’s new row is not the row the job wrote',
    ).toEqual({ revert: 'refused', ownersRow: [{ text: 'Set by the agent' }] });
  });

  it('a set_facts job that failed part-way (no outside edit): what it wrote can be reverted, and no outside edit is claimed', async () => {
    // LegendKeeper refuses the second row write (400): the first was written, the second not; nobody else edits.
    const refuseNotes = (req: { method: string; path: string }) =>
      req.method === 'PATCH' && /\/properties\/kvmehr01\/rows\/kvmehr01r4\/?$/.test(req.path)
        ? {
            status: 400,
            body: { message: 'model VALIDATION_ERROR', code: 'VALIDATION_ERROR', requestId: 'r2' },
          }
        : undefined;
    const others = [...w.overrides.entries()];
    w.overrides.clear();
    w.overrides.set(/\/properties\//, refuseNotes);
    for (const [re, fn] of others) w.overrides.set(re, fn);
    let jobId: string;
    try {
      const r = await call('set_facts', {
        page: P.mehrana,
        facts: { Scope: 'Qishen scholar of the river archives', Notes: 'Will not be written' },
      });
      jobId = jobOf(r);
      if (jobId === 'undefined') {
        // The tool answers the failure inline; the job is the newest of this agent's set_facts jobs.
        const rows = w.stack.db
          .prepare(`SELECT id FROM jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .all(PROJECT) as { id: string }[];
        jobId = rows[0]!.id;
      }
      const job = await rt().engine.wait(PROJECT, jobId, 25_000);
      expect(job.status, r.text).toBe('failed');
    } finally {
      for (const [re, fn] of w.overrides) if (fn === refuseNotes) w.overrides.delete(re);
    }
    expect(value(P.mehrana, 'Scope')).toBe('Qishen scholar of the river archives');
    expect(value(P.mehrana, 'Notes')).not.toBe('Will not be written');
    const preview = await rt().reverts.preview(PROJECT, jobId);
    const t = preview.targets.find((x) => x.kind === 'facts')!;
    expect(
      { state: t.state, claimsOutsideEdit: /outside edit/.test(t.detail) },
      `${t.state}: ${t.detail}`,
    ).toEqual({ state: 'ready', claimsOutsideEdit: false });
  });

  it('rows re-ordered by the owner after the job: the value goes back and the owner’s order stays (control)', async () => {
    const r = await call('set_facts', { page: P.ashgate, facts: { Scope: 'A walled town on the river' } });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    // The owner drags Scope above Reference Type.
    w.sidebars.outside(P.ashgate, (sb) => {
      const rows = sb.props.find((x) => x.title === 'PROPERTIES')!.rows!;
      const scope = rows.find((x) => x.key === 'Scope')!;
      scope.rank = '!';
    });
    const order = () => w.sidebars.rows(P.ashgate).map((x) => x.key);
    const owners = order();
    expect(owners[0]).toBe('Scope');
    const { job } = await revertAndWait(w.stack, jobId);
    expect(job?.status).toBe('succeeded');
    expect({ scope: value(P.ashgate, 'Scope'), order: order() }).toEqual({
      scope: 'A walled town',
      order: owners,
    });
  });
});
