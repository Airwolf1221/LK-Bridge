/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F5c (ADR 0069, H8): workstreams against the Menkheti world: the label on the journal entries, the job and the
 * proposal (an approved proposal's job keeping it); a connection's default label and its expiry; a write's result
 * echoing the label in force; and a report over a mixed workstream (applied and verified, an unknown outcome then
 * settled, pending, conflicted, a skipped item, a FIX_STALE refusal, open findings) putting each in the right group,
 * for free; and the dashboard's Workstreams list.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TTL_MS, WorkstreamDefaults } from '../../src/workstreams/defaults.js';
import { M, PROJECT, identityWorld, type IdentityWorld } from '../packs/identity-world.js';
import { P } from '../appraisal/world.js';

vi.setConfig({ testTimeout: 180_000 });

const WS = 'Menkheti culture split';
let w: IdentityWorld;
beforeAll(async () => {
  w = await identityWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const jobWs = (id: string) =>
  (w.stack.db.prepare('SELECT workstream FROM jobs WHERE id = ?').get(id) as { workstream: string | null }).workstream;
const journalWs = (jobId: string) =>
  (w.stack.db.prepare('SELECT DISTINCT workstream FROM write_journal WHERE job_id = ?').all(jobId) as { workstream: string | null }[]).map(
    (r) => r.workstream,
  );
const reconcile = (items: unknown[], extra: Record<string, unknown> = {}) =>
  w.call('arkona_identity_reconcile', { project: 'test', items, ...extra });

describe('the label', () => {
  it('an argument is recorded on the job and its journal entries, and echoed', async () => {
    const r = await reconcile([{ character: 'Arin al-Jamail', facts: { 'Naming Culture': 'Orzheni' } }], {
      workstream: WS,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.workstream).toBe(WS);
    expect(jobWs(r.body.jobId)).toBe(WS);
    expect(journalWs(r.body.jobId)).toEqual([WS]);
  });

  it('bridge_workstream sets a default for the connection; an argument wins; it lapses after 12 hours unused', async () => {
    const set = await w.call('bridge_workstream', { set: 'Default stream' });
    expect(set.body).toMatchObject({ status: 'set', workstream: 'Default stream' });
    const r = await reconcile([{ character: 'Daryan Sefet', facts: { 'Life State': 'Wounded' } }]);
    expect(r.body).toMatchObject({ workstream: 'Default stream', workstreamSource: 'default (bridge_workstream)' });
    expect(jobWs(r.body.jobId)).toBe('Default stream');
    const own = await reconcile([{ character: 'Daryan Sefet', facts: { 'Life State': 'Alive' } }], { workstream: WS });
    expect(own.body.workstream).toBe(WS);
    // Lapsed: no write for more than 12 hours.
    w.stack.db.prepare('UPDATE workstream_defaults SET last_used_at = ?').run(Date.now() - DEFAULT_TTL_MS - 1000);
    const read = await w.call('bridge_workstream', {});
    expect(read.body.workstream).toBeNull();
    const after = await reconcile([{ character: 'Daryan Sefet', facts: { 'Life State': 'Resting' } }]);
    expect(after.body.workstream).toBeUndefined();
    expect(jobWs(after.body.jobId)).toBeNull();
  });

  it('the store: set, read (touching keeps it alive), clear, expiry', () => {
    let now = 1_000_000;
    const d = new WorkstreamDefaults(w.stack.db, () => now);
    d.set('pat_x', '  Menkheti   split ');
    expect(d.get('pat_x')?.label).toBe('Menkheti split');
    now += DEFAULT_TTL_MS - 10;
    expect(d.get('pat_x', { touch: true })?.label).toBe('Menkheti split');
    now += DEFAULT_TTL_MS - 10;
    expect(d.get('pat_x')?.label).toBe('Menkheti split');
    now += 20;
    expect(d.get('pat_x')).toBeNull();
    d.set('pat_x', 'again');
    d.set('pat_x', null);
    expect(d.get('pat_x')).toBeNull();
  });

  it('a proposal records it, and its approved job keeps it', async () => {
    const t = w.stack.newToken('ws-proposer', 'propose');
    const agent = await w.stack.connect(t.token);
    const r = await w.stack.call(agent, 'arkona_identity_reconcile', {
      project: 'test',
      items: [{ character: 'Khepri Nadu', facts: { 'Life State': 'Travelling' } }],
      workstream: WS,
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(w.stack.runtime.policy.proposals.get(r.body.proposalId)!.workstream).toBe(WS);
    await w.stack.runtime.policy.commands.approve('owner', r.body.proposalId);
    const jobId = await jobOf(r.body.proposalId);
    expect(jobWs(jobId)).toBe(WS);
    expect(journalWs(jobId)).toEqual([WS]);
  });
});

describe('the report', () => {
  it('a mixed workstream: each thing in its group, the still-to-do list drawn from them, free', async () => {
    const t = w.stack.newToken('ws-mixed', 'propose');
    const proposer = await w.stack.connect(t.token);
    // Applied and verified (above), and one more direct reconcile.
    const done = await reconcile([{ character: 'Azar al-Nafir', facts: { 'Naming Culture': 'Khayali' } }], {
      workstream: WS,
    });
    expect(done.body.status).toBe('finished');
    // Pending: a proposal nobody has decided.
    const pending = await w.stack.call(proposer, 'arkona_identity_reconcile', {
      project: 'test',
      items: [{ character: 'Zahira al-Rachid', facts: { 'Life State': 'Exiled' } }],
      workstream: WS,
    });
    // Conflicted: a set_facts proposal whose sidebar changed before approval.
    const conflicted = await w.stack.call(proposer, 'set_facts', {
      project: 'test',
      page: M.mansur,
      facts: { 'Temporal Scope': '4A 100 - 4A 160' },
      workstream: WS,
    });
    expect(conflicted.body.status, conflicted.text).toBe('proposal_captured');
    w.repo.outside.setRow(M.mansur, 'Temporal Scope', '4A 99');
    await w.stack.runtime.policy.commands.approve('owner', conflicted.body.proposalId).catch(() => undefined);
    expect(w.stack.runtime.policy.proposals.get(conflicted.body.proposalId)!.state).toBe('conflicted');
    // Skipped: a character changed between the proposal and its approval.
    const stale = await w.stack.call(proposer, 'arkona_identity_reconcile', {
      project: 'test',
      items: [{ character: 'Khepri Nadu', facts: { 'Life State': 'Home' } }],
      workstream: WS,
    });
    w.repo.outside.setRow(M.khepri, 'Temporal Scope', '5A 1');
    await w.stack.runtime.policy.commands.approve('owner', stale.body.proposalId);
    await jobOf(stale.body.proposalId);
    // A refused fix (FIX_STALE): the dash was removed in the app after the appraisal saw it.
    const appraised = await w.call('arkona_appraise_owner', { under: P.desk, limit: 200, project: 'test' });
    const dash = (appraised.body.findings as any[]).find((f) => f.check === 'em_dash_text' && f.page?.id === P.dashText);
    expect(dash).toBeDefined();
    const doc = w.repo.blocks.get(w.mainOf(P.dashText))!;
    doc.blocks = JSON.parse(JSON.stringify(doc.blocks).replace(/—/g, ', '));
    doc.version++;
    const refused = await w.call('arkona_appraisal_fix', { project: 'test', findingId: dash.id, workstream: WS });
    expect(refused.body.error?.code, refused.text).toBe('FIX_STALE');
    expect(refused.body.workstream).toBe(WS);
    // An unknown outcome, then settled by the reconciler (H10), and one still unresolved.
    const entries = w.stack.db
      .prepare('SELECT id FROM write_journal WHERE job_id = ? ORDER BY id')
      .all(done.body.jobId) as { id: number }[];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const ins = w.stack.db.prepare(
      `INSERT INTO write_reconciliations (journal_id, project_id, state, outcome, attempts, first_at, settled_at, settled_by, reason)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    );
    ins.run(entries[0]!.id, PROJECT, 'settled', 'applied', Date.now(), Date.now(), 'bridge', 'read back: applied');
    w.stack.db.prepare("UPDATE write_journal SET outcome = 'unknown' WHERE id = ?").run(entries[1]!.id);
    ins.run(entries[1]!.id, PROJECT, 'unresolved', null, Date.now(), null, null, 'could not be told');

    const before = w.requests().all;
    const r = await w.call('bridge_workstream_report', { project: 'test', workstream: WS });
    expect(r.isError, r.text).toBe(false);
    expect(w.requests().all).toBe(before);
    const g = r.body.groups;
    expect(r.body.cost).toMatch(/^free/);
    // Written and verified: every page, each write with its versions and who made it.
    const azar = g.writtenAndVerified.find((p: any) => p.page.id === M.azar);
    expect(azar).toMatchObject({ verified: true });
    expect(azar.writes.some((x: any) => x.op === 'updateResource' && x.what === 'tags')).toBe(true);
    expect(azar.writes[0]).toMatchObject({ by: { principal: expect.any(String) }, versionBefore: expect.anything() });
    expect(g.writtenAndVerified.find((p: any) => p.page.id === M.khepri)).toBeDefined(); // the approved proposal's job
    // Awaiting the author's judgement: pending and conflicted proposals.
    const waiting = g.awaitingJudgement.map((x: any) => [x.proposalId, x.state]);
    expect(waiting).toContainEqual([pending.body.proposalId, 'pending']);
    expect(waiting).toContainEqual([conflicted.body.proposalId, 'conflicted']);
    // Deliberately excluded: the skipped character, the FIX_STALE refusal.
    const ex = g.deliberatelyExcluded;
    expect(ex.some((x: any) => x.kind === 'skipped' && /FACTS_STALE/.test(x.why))).toBe(true);
    expect(ex.some((x: any) => x.kind === 'refused' && x.code === 'FIX_STALE' && x.tool === 'arkona_appraisal_fix')).toBe(
      true,
    );
    // Residual inconsistencies: the unknown outcomes, settled and not.
    const unk = g.residualInconsistencies.unknownOutcomes;
    expect(unk.find((u: any) => u.journalId === entries[0]!.id).reconciliation).toMatchObject({
      state: 'settled',
      outcome: 'applied',
    });
    expect(unk.find((u: any) => u.journalId === entries[1]!.id)).toMatchObject({
      outcome: 'unknown',
      reconciliation: { state: 'unresolved' },
    });
    // Open findings on the pages touched (the identity pages' consistency follow-ups, Al-Mansur's Biography).
    expect(Array.isArray(g.residualInconsistencies.openFindings)).toBe(true);
    // Still to do: only from the groups.
    const todo = (r.body.stillToDo as string[]).join('\n');
    expect(todo).toMatch(new RegExp(`Pending proposal ${pending.body.proposalId}`));
    expect(todo).toMatch(new RegExp(`Conflicted proposal ${conflicted.body.proposalId}`));
    expect(todo).toMatch(new RegExp(`Write ${entries[1]!.id} .* unknown outcome`));
    expect(todo).not.toMatch(new RegExp(`Write ${entries[0]!.id} `));
    expect(todo).toMatch(/FIX_STALE/);
    // By principal and by jobIds too; the scope is required.
    const byJob = await w.call('bridge_workstream_report', { project: 'test', jobIds: [done.body.jobId] });
    expect(byJob.body.counts.jobs).toBe(1);
    const none = await w.call('bridge_workstream_report', { project: 'test' });
    expect(none.body.error.code).toBe('INVALID_PARAMS');
  });

  it('the dashboard lists the workstreams with their counts', () => {
    const list = w.stack.runtime.workstreamReports.list(PROJECT);
    const ws = list.find((x: any) => x.workstream === WS) as any;
    expect(ws).toMatchObject({ workstream: WS });
    expect(ws.jobs).toBeGreaterThan(0);
    expect(ws.awaitingOwner).toBeGreaterThanOrEqual(2);
    expect(ws.principals.length).toBeGreaterThanOrEqual(2);
  });
});

async function jobOf(proposalId: string): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const p = w.stack.runtime.policy.proposals.get(proposalId)!;
    if (p.jobId) {
      const j = w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId);
      if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) {
        await w.stack.runtime.identity.conclude(PROJECT, j.id);
        return j.id;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no job');
}
