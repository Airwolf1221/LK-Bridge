/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c (ADR 0054): no appraisal tool writes. Across every one (the full-text search, A2 to A5, their stored runs read
 * back, the dashboard's runs), the mock LegendKeeper records no write and no read at all, and the bridge submits no job.
 * Only "Propose a fix" writes, and only through a proposal: one live read, a proposal captured, nothing written until the
 * owner approves it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appraisalWorld, C, P, PROJECT, type AppraisalWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: AppraisalWorld;
beforeAll(async () => {
  w = await appraisalWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

const jobs = () => (w.stack.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
const proposals = () => (w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;

describe('no writes', () => {
  it('every appraisal tool, and the search, read nothing from LegendKeeper and write nothing', async () => {
    const before = w.requests();
    const j0 = jobs();
    const p0 = proposals();
    const calls: [string, Record<string, unknown>][] = [
      ['search', { query: '"tide gate" OR archive', content: true }],
      ['arkona_appraise_owner', { page: P.dashText }],
      ['arkona_appraise_owner', { under: P.desk, limit: 5 }],
      ['arkona_appraise_owner', { all: true, include: ['legacy', 'design', 'archived'], limit: 5 }],
      ['arkona_change_impact', { page: C.nadira, renameTo: 'Nadira al-Qasim' }],
      ['arkona_working_digest', {}],
      ['arkona_visual_hygiene', {}],
      ['arkona_visual_hygiene', { under: C.nadiraIndex }],
    ];
    const runs: string[] = [];
    for (const [name, args] of calls) {
      const r = await w.call(name, { ...args, project: 'test' });
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      if (typeof r.body.runId === 'string') runs.push(r.body.runId);
    }
    // Reading a stored run back costs nothing either.
    for (const id of runs.slice(1, 3)) {
      const tool = w.stack.runtime.appraisal.store.report(PROJECT, id)!.tool;
      const again = await w.call(tool, { runId: id, offset: 1, project: 'test' });
      expect(again.isError, again.text).toBe(false);
    }
    // A read-scope connection may use every report.
    const ro = await w.callRead('arkona_appraise_owner', { page: P.clean, project: 'test' });
    expect(ro.isError, ro.text).toBe(false);
    expect(w.requests()).toEqual(before);
    expect(jobs()).toBe(j0);
    expect(proposals()).toBe(p0);
  });

  it('Propose a fix writes only through a proposal: one read, nothing written until approval', async () => {
    const a = await w.call('arkona_appraise_owner', { page: P.blanks, project: 'test' });
    const f = (a.body.findings as any[]).find((x) => x.check === 'blank_paragraphs');
    const before = w.requests();
    const p0 = proposals();
    const r = await w.call('arkona_appraisal_fix', { findingId: f.id, project: 'test' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(proposals()).toBe(p0 + 1);
    expect(w.requests().writes).toBe(before.writes);
    // The re-read (the document), and what the proposal's capture reads to fix its targets' versions: reads only.
    expect(w.requests().all - before.all).toBeGreaterThanOrEqual(1);
    expect(w.stack.runtime.policy.proposals.get(r.body.proposalId as string)!.state).toBe('pending');
    // The page is untouched.
    const blocks = w.repo.blocks.get(w.mainOf(P.blanks))!.blocks as { id: string }[];
    expect(blocks.map((b) => b.id)).toContain('bl1');
  });
});
