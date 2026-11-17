/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3c, section F (ADR 0054): "Propose a fix". Each deterministic fix re-reads its target live (one read), checks the
 * finding still holds, and makes exactly the intended proposal and nothing more; Last Major Revision follows ADR 0051 (a
 * dash or a blank paragraph is not a major revision); a stale finding proposes nothing; a judgement has no fix; the
 * audits' own fixes take sibling order and tags; the dashboard's route is the owner's. Nothing is applied before the
 * owner approves it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { approve } from '../packs/world.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { appraisalWorld, A, C, P, PROJECT, type AppraisalWorld } from './world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: AppraisalWorld;
let findings: any[];
beforeAll(async () => {
  w = await appraisalWorld();
  await w.snapshot();
  const d = await w.call('arkona_appraise_owner', { under: P.desk, limit: 200, project: 'test' });
  const v = await w.call('arkona_visual_hygiene', { limit: 200, project: 'test' });
  findings = [...d.body.findings, ...v.body.findings];
});
afterAll(async () => w?.close());

const finding = (check: string, pageId?: string) => {
  const f = findings.find((x) => x.check === check && (pageId === undefined || x.page?.id === pageId));
  if (!f) throw new Error(`no ${check} finding`);
  return f;
};
const fix = (findingId: string) => w.call('arkona_appraisal_fix', { findingId, project: 'test' });
const proposal = (id: string) => w.stack.runtime.policy.proposals.detail(id)!;
/** The proposal's writes (the bridge's own check and verify steps aside). */
const writes = (id: string) =>
  proposal(id)
    .ops.filter((o) => !o.op.startsWith('bridge.'))
    .map((o) => ({ op: o.op, params: o.params as any }));
const blocksOf = (id: string) => w.repo.blocks.get(w.mainOf(id))!.blocks as any[];
const proposals = () => (w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;

describe('the deterministic fixes', () => {
  it('em dashes in the headings and prose: each block’s dashes replaced, every other character and block kept', async () => {
    const before = w.requests();
    const blocks0 = structuredClone(blocksOf(P.dashText));
    const r = await fix(finding('em_dash_text', P.dashText).id);
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ status: 'proposal_captured', fix: 'em_dash_text', reads: 1 });
    // One read (the document), and nothing written before the owner approves.
    expect(w.requests().writes).toBe(before.writes);
    const ops = writes(r.body.proposalId);
    expect(ops.map((o) => `${o.op} ${o.params.path.blockId}`)).toEqual([
      'replaceBlock dh1',
      'replaceBlock dp1',
    ]);
    expect(ops[0]!.params.body.content).toEqual([{ text: 'Trade - and Tolls' }]);
    expect(ops[1]!.params.body.content).toEqual([
      { text: 'The gate - its keepers say - never closes; ' },
      { text: 'never', bold: true },
      { text: '.' },
    ]);
    // ADR 0051: a dash is punctuation, not a major revision: Last Major Revision is skipped, and the proposal says so.
    expect(proposal(r.body.proposalId).ops.some((o) => o.op === 'bridge.lmr')).toBe(false);
    expect(r.body.summary).toMatch(/Last Major Revision skipped/);
    const done = await approve(w, r.body.proposalId);
    expect(done.state).toBe('executed');
    const after = blocksOf(P.dashText);
    expect(after.find((b) => b.id === 'dh1').content).toEqual([{ text: 'Trade - and Tolls' }]);
    // Every other block is exactly as it was.
    const others = (bs: any[]) =>
      bs.filter((b) => b.id !== 'dh1' && b.id !== 'dp1').map((b) => JSON.stringify(b));
    expect(others(after)).toEqual(others(blocks0));
  });

  it('decorative blank paragraphs removed (and Last Major Revision skipped)', async () => {
    const r = await fix(finding('blank_paragraphs', P.blanks).id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(writes(r.body.proposalId).map((o) => `${o.op} ${o.params.path.blockId}`)).toEqual([
      'deleteBlock bl2',
      'deleteBlock bl1',
    ]);
    expect(proposal(r.body.proposalId).ops.some((o) => o.op === 'bridge.lmr')).toBe(false);
    expect(r.body.summary).toMatch(/Last Major Revision skipped/);
  });

  it('a link inside a heading: the heading’s text kept, its link dropped', async () => {
    const r = await fix(finding('heading_links', P.headingLink).id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    const ops = writes(r.body.proposalId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'replaceBlock', params: { path: { blockId: 'hl1' } } });
    expect(ops[0]!.params.body).toMatchObject({
      kind: 'heading',
      level: 2,
      content: [{ text: 'Relations with Tarim' }],
    });
    // The heading's words are unchanged (a mention reads as its label): not a major revision.
    expect(r.body.summary).toMatch(/Last Major Revision skipped/);
  });

  it('an em dash in the page name: update_resource with the prefix kept, nothing else', async () => {
    const r = await fix(finding('em_dash_name', P.dashName).id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    const ops = writes(r.body.proposalId);
    expect(ops.map((o) => o.op)).toEqual(['updateResource']);
    expect(ops[0]!.params.body).toEqual({ name: '[BSRC] Gata - Lund - Polity Reference' });
    // A name never counts as a major revision.
    expect(proposal(r.body.proposalId).ops.some((o) => o.op === 'bridge.lmr')).toBe(false);
  });

  it('a Working or Archived page in an Authoritative page’s Related Sources: that one link removed', async () => {
    const r = await fix(finding('related_noncurrent', P.archivedRelated).id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    const ops = writes(r.body.proposalId);
    expect(ops.map((o) => o.op)).toEqual(['updateProperty']);
    expect(ops[0]!.params.body.items).toEqual([]);
    const done = await approve(w, r.body.proposalId);
    expect(done.state).toBe('executed');
    const rel = w.sidebars.pages.get(P.archivedRelated)!.props.find((p) => p.title === 'Related Sources')!;
    expect(rel.items).toEqual([]);
    // Dependencies are untouched.
    const dep = w.sidebars.pages.get(P.archivedRelated)!.props.find((p) => p.title === 'Dependencies')!;
    expect(dep.items!.map((i) => i.resourceId)).toEqual(['salahref']);
  });

  it('an asset name with an extension: renamed without it; a name already taken in the folder is refused', async () => {
    const f = finding('asset_extension');
    // Another asset in the same folder already holds the plain name: refused, nothing proposed.
    w.assets.image('Nadira al-Khalid - Primary Reference - Portrait', A.nadira, {
      id: 'imgtaken',
      width: 8,
      height: 4,
    });
    const { buildModels } = await import('../discover/world.js');
    buildModels(w.stack, w.repo, w.assets);
    const n0 = proposals();
    const refused = await fix(f.id);
    expect(refused.body.error.code).toBe('FIX_NOT_APPLICABLE');
    expect(refused.body.error.message).toMatch(/already holds an asset named/);
    expect(proposals()).toBe(n0);
    w.assets.assets.delete('imgtaken');
    w.stack.db.prepare('DELETE FROM asset_items WHERE project_id = ? AND id = ?').run(PROJECT, 'imgtaken');
    const r = await fix(f.id);
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(writes(r.body.proposalId)).toEqual([
      {
        op: 'updateAsset',
        params: {
          path: { assetId: A.portraitPng },
          body: { name: 'Nadira al-Khalid - Primary Reference - Portrait' },
        },
      },
    ]);
  });
});

describe('handed over to the audits, refused, stale', () => {
  it('sibling order and tags: the audits’ own fix, as the agent’s proposal', async () => {
    const order = await fix(finding('sibling_order', P.zebra).id);
    expect(order.body.status, order.text).toBe('proposal_captured');
    expect(order.body.fix).toBe('audit:move_resource');
    expect(writes(order.body.proposalId).map((o) => o.op)).toEqual(['moveResource']);
    expect(w.stack.runtime.policy.proposals.get(order.body.proposalId)!.principalId).not.toBe('system');
    const tags = await fix(finding('tag_grammar', P.untagged).id);
    expect(tags.body.status, tags.text).toBe('proposal_captured');
    expect(tags.body.fix).toBe('audit:add_tags');
    expect(writes(tags.body.proposalId)).toEqual([
      expect.objectContaining({
        op: 'updateResource',
        params: expect.objectContaining({ body: { tags: ['CANON', 'Polity'] } }),
      }),
    ]);
  });

  it('a judgement finding has no fix: nothing is proposed', async () => {
    const n0 = proposals();
    const r = await fix(finding('purpose_first', P.noPurpose).id);
    expect(r.body.error.code).toBe('NO_FIX');
    expect(r.body.error.message).toMatch(/no single right repair/);
    expect(proposals()).toBe(n0);
  });

  it('a stale finding proposes nothing and says why', async () => {
    // The owner removed the dash in the app since the snapshot (the bridge has not seen it).
    const f = finding('em_dash_text', P.dashText); // already fixed and approved above: no dash is left
    const n0 = proposals();
    const r = await fix(f.id);
    expect(r.body.error.code).toBe('FIX_STALE');
    expect(r.body.error.message).toMatch(/no longer holds a dash.*nothing was proposed/);
    expect(proposals()).toBe(n0);
  });

  it('an unknown finding id', async () => {
    const r = await fix('af_00000000000000000000');
    expect(r.body.error.code).toBe('FINDING_NOT_FOUND');
  });

  it('a read-scope connection cannot propose a fix', async () => {
    const r = await w.callRead('arkona_appraisal_fix', {
      findingId: finding('heading_links', P.headingLink).id,
      project: 'test',
    });
    expect(r.isError).toBe(true);
  });
});

describe('the dashboard’s Propose a fix', () => {
  it('is the owner’s: one proposal, audited; a judgement is refused', async () => {
    const s = w.stack.services;
    const session = s.owner.createSession('127.0.0.1', 'vitest');
    const headers = {
      cookie: `${s.owner.sessionCookie}=${session}`,
      origin: PUBLIC_URL,
      'x-csrf-token': s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE),
      'content-type': 'application/json',
    };
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${w.stack.base}/api/admin${path}?project=test`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    // A fresh appraisal of the desk (the earlier fixes changed some pages).
    await w.snapshot();
    const run = await post('/appraisal/run', { confirm: true, tool: 'owner', under: 'Appraisal Desk' });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    const fl = run.json.report.findings as any[];
    const blanks = fl.find((f) => f.check === 'blank_paragraphs');
    const r = await post(`/appraisal/findings/${blanks.id}/propose-fix`, { confirm: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.status).toBe('proposal_captured');
    expect(w.stack.runtime.policy.proposals.get(r.json.proposalId)!.principalId).toBe('system');
    const audit = w.stack.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'appraisal.propose_fix'`)
      .get() as { n: number };
    expect(audit.n).toBeGreaterThan(0);
    const judgement = fl.find((f) => f.check === 'purpose_first');
    const no = await post(`/appraisal/findings/${judgement.id}/propose-fix`, { confirm: true });
    expect(no.status).toBe(409);
    expect(no.json.error.code).toBe('NO_FIX');
    expect((await post(`/appraisal/findings/${blanks.id}/propose-fix`, {})).status).toBe(400); // confirm is required
    void C;
  });
});
