/**
 * v2 E2 (ADR 0044): "Propose a fix" (src/audits/fixes.ts) against the REAL stack on the mock world. Every fix re-reads its
 * target live first, refuses a finding that is out of date, becomes ONE ordinary proposal (never applied by the audit),
 * runs every guard, does its compare-and-swap inside the lock, and is gone from the next audit once approved:
 *
 * - the paragraph split, block by block (`replaceBlock` for the first part, `insertBlock` for the rest), beside an icon;
 * - `set_facts` only when the right value is unambiguous;
 * - `move_resource` re-placing a page under the same parent;
 * - the additive tag fix, and the canon guard on a status tag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { A, auditsWorld, type AuditsWorld, type MockBlock } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AuditsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const audits = () => w!.stack.runtime.audits;
const pol = () => w!.stack.runtime.policy;
const finding = (code: string, pageId: string, blockId?: string) => {
  const f = audits()
    .list(PROJECT, { limit: 1000 })
    .findings.find(
      (x) => x.code === code && x.pageId === pageId && (blockId === undefined || x.blockId === blockId),
    );
  if (!f) throw new Error(`no ${code} finding on ${pageId}`);
  return f;
};
const stillThere = (code: string, pageId: string, blockId?: string) =>
  audits()
    .list(PROJECT, { limit: 1000 })
    .findings.some(
      (x) => x.code === code && x.pageId === pageId && (blockId === undefined || x.blockId === blockId),
    );

/** As the owner does on the Proposals page: approve, then wait for the job. */
async function approve(
  proposalId: string,
  asCanon = false,
): Promise<{ state: string; jobStatus: string | null }> {
  if (asCanon) await pol().commands.approveAsCanon('owner', proposalId);
  else await pol().commands.approve('owner', proposalId);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol().proposals.get(proposalId)!.state);
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  const p = pol().proposals.get(proposalId)!;
  const job = p.jobId ? w!.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
  return { state: p.state, jobStatus: job?.status ?? null };
}

const ids = (blocks: MockBlock[]) => blocks.map((b) => b.id);
const text = (b: MockBlock) => (b.content ?? []).map((r) => r.text ?? '').join('');

describe('Propose a fix: split a paragraph', () => {
  it('re-reads the page, proposes ONE proposal that changes nothing, and once approved splits block by block', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.breaks, 'bp1');
    const reads = w.requests();
    const before = structuredClone(w.blocksOf(A.breaks));
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    expect(r).toMatchObject({ status: 'proposal_captured', fix: 'split_paragraph' });
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    // It read the live page first (the resource and the document), and wrote nothing.
    expect(w.stack.mock.calls.slice(reads).filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(w.stack.mock.calls.slice(reads).filter((c) => c.method !== 'GET')).toEqual([]);
    expect(w.blocksOf(A.breaks)).toEqual(before);
    const proposal = pol().proposals.get(r.proposalId)!;
    expect(proposal).toMatchObject({ state: 'pending' });
    expect(JSON.stringify(proposal)).toContain('audits.split_paragraph');
    const log = w.stack.db
      .prepare("SELECT after FROM audit_log WHERE action = 'audits.propose_fix'")
      .all() as { after: string }[];
    expect(JSON.parse(log[0]!.after)).toMatchObject({
      code: 'line_break_paragraph',
      fix: 'split_paragraph',
      proposalId: r.proposalId,
    });

    const done = await approve(r.proposalId);
    expect(done, JSON.stringify(done)).toEqual({ state: 'executed', jobStatus: 'succeeded' });
    const after = w.blocksOf(A.breaks);
    expect(after).toHaveLength(before.length + 2);
    expect(ids(after).slice(0, 2)).toEqual(['bh', 'bp1']);
    expect(ids(after).slice(4)).toEqual(['bp2', 'bp3']);
    // Block by block: the first part keeps the block's id; marks are kept in their parts; nothing else was touched.
    expect(after.slice(1, 4).map(text)).toEqual(['first line', 'second line', 'third line']);
    expect(after[2]!.content).toEqual([{ text: 'second ' }, { text: 'line', bold: true }]);
    expect(after[0]).toEqual(before[0]);
    expect(after[4]).toEqual(before[2]);
    // The writes were block writes, not a replace of the whole document.
    const writes = w.repo.mutations
      .map((m) => m.op)
      .filter((o) => ['replaceDocumentBlocks', 'replaceBlock', 'insertBlock'].includes(o));
    // The new paragraphs go in first and the original is cut down last, so a refused write never loses text.
    expect(writes).toEqual(['insertBlock', 'insertBlock', 'replaceBlock']);
    expect(
      w.stack.runtime.engine.queries.getJob(PROJECT, pol().proposals.get(r.proposalId)!.jobId!)!.result,
    ).toMatchObject({ verified: true });
    // Re-run the audit after the next snapshot: that paragraph's finding is gone, the other one is still there.
    await w.snapshotAndAudit();
    expect(stillThere('line_break_paragraph', A.breaks, 'bp1')).toBe(false);
    expect(stillThere('line_break_paragraph', A.breaks, 'bp3')).toBe(true);
    expect(
      audits()
        .list(PROJECT, { state: 'gone', limit: 100 })
        .findings.some((x) => x.id === f.id && x.state === 'gone'),
    ).toBe(true);
  });

  it('works beside an inline icon: the icon paragraph and the unsupported block are untouched', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.icons, 'ip2');
    const before = structuredClone(w.blocksOf(A.icons));
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    expect(await approve(r.proposalId)).toEqual({ state: 'executed', jobStatus: 'succeeded' });
    const after = w.blocksOf(A.icons);
    expect(ids(after)).toEqual(['ip1', 'ip2', ids(after)[2], 'ip3', 'iun']);
    expect(after[0]).toEqual(before[0]); // the paragraph with the icon, exactly as it was
    expect(after[3]).toEqual(before[2]);
    expect(after[4]).toEqual(before[3]);
    expect([after[1]!, after[2]!].map(text)).toEqual(['before', 'after']);
    expect(w.repo.mutations.map((m) => m.op)).not.toContain('replaceDocumentBlocks');
  });

  it('refuses a finding that is out of date when it is proposed; nothing is proposed', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.breaks, 'bp1');
    // Edited in LegendKeeper since the snapshot.
    w.blocksOf(A.breaks)[1]!.content = [{ text: 'edited\nin the app' }];
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({ code: 'FIX_STALE' });
    expect(w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
    // Gone from the page: stale too.
    w.blocksOf(A.breaks).splice(1, 1);
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({ code: 'FIX_STALE' });
  });

  it('the compare-and-swap is inside the lock: a paragraph edited between the proposal and its approval is not touched', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.breaks, 'bp3');
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    w.blocksOf(A.breaks)[3]!.content = [{ text: 'someone\nelse edited this' }];
    const snapshot = structuredClone(w.blocksOf(A.breaks));
    const done = await approve(r.proposalId);
    expect(['failed', 'conflicted']).toContain(done.state);
    expect(w.blocksOf(A.breaks)).toEqual(snapshot);
    expect(w.repo.mutations.map((m) => m.op)).not.toContain('replaceBlock');
  });

  it('a refused insert loses nothing: the new paragraphs go in first, so a paragraph in a container the API refuses stays whole', async () => {
    w = await auditsWorld();
    // A paragraph inside a table cell: the mock (like a LegendKeeper that refuses it) takes insertBlock only at the top level.
    w.blocksOf(A.breaks).push({
      id: 'nested-t',
      kind: 'table',
      children: [
        {
          id: 'nested-r',
          kind: 'tableRow',
          children: [
            {
              id: 'nested-c',
              kind: 'tableCell',
              children: [{ id: 'nested-p', kind: 'paragraph', content: [{ text: 'cell\nover two lines' }] }],
            },
          ],
        },
      ],
    });
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.breaks, 'nested-p');
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    const before = structuredClone(w.blocksOf(A.breaks));
    const done = await approve(r.proposalId);
    expect(done.state).toBe('failed');
    expect(w.blocksOf(A.breaks)).toEqual(before); // nothing was written, nothing lost
    expect(w.repo.mutations.map((m) => m.op)).not.toContain('replaceBlock');
  });

  it('a finding with no fix (the paragraph holds a character other than breaks) offers none', async () => {
    w = await auditsWorld();
    w.blocksOf(A.breaks)[3]!.content = [{ text: 'one\ntwo\u0007' }];
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.breaks, 'bp3');
    expect(f.fix).toBeNull();
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({ code: 'NO_FIX' });
  });
});

describe('Propose a fix: set_facts, only when unambiguous', () => {
  it('Kamigawa Miyuki: the Reference Type becomes Compact Character Reference, through set_facts’ own plan, once approved', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('unknown_reference_type', A.kami);
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    expect(r.fix).toBe('set_facts');
    expect(rows(A.kami)['Reference Type']).toBe('Character Reference'); // not applied
    expect(await approve(r.proposalId)).toEqual({ state: 'executed', jobStatus: 'succeeded' });
    expect(rows(A.kami)['Reference Type']).toBe('Compact Character Reference');
    await w.snapshotAndAudit();
    expect(stillThere('unknown_reference_type', A.kami)).toBe(false);
  });

  it('Mehrana al-Khalid, Founder: the Subject is reported and no fix is offered (the name or the Subject may be wrong)', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('subject_mismatch', A.mehrana);
    expect(f.fix).toBeNull();
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({ code: 'NO_FIX' });
    // The Reference Type of the same page is unambiguous (the name says Core), so that one has a fix.
    expect(finding('unknown_reference_type', A.mehrana).fix).toMatchObject({
      kind: 'set_facts',
      args: { facts: { 'Reference Type': 'Character Core' } },
    });
  });

  it('refuses when the row is not what the finding saw (someone changed it); nothing is proposed', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('unknown_reference_type', A.kami);
    w.sidebars.outside(A.kami, (sb) => {
      const row = sb.props
        .find((p) => p.title === 'PROPERTIES')!
        .rows!.find((x) => x.key === 'Reference Type')!;
      row.content = [{ text: 'Something Else' }];
    });
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({ code: 'FIX_STALE' });
    expect(w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
  });
});

/** The PROPERTIES rows of a seeded page, as the mock holds them now. */
const rows = (pageId: string): Record<string, string> =>
  Object.fromEntries(w!.sidebars.rows(pageId).map((r) => [r.key, r.text]));

describe('Propose a fix: move_resource', () => {
  it('re-places the page alphabetically under the same parent, with the siblings compared again inside the lock', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('out_of_order', A.cherry);
    const order = () => w!.repo.children(A.zoo).map((r) => r.name);
    const before = order();
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    expect(order()).toEqual(before);
    expect(await approve(r.proposalId)).toEqual({ state: 'executed', jobStatus: 'succeeded' });
    const after = order();
    expect(after.indexOf('[BSRC] Banana')).toBeLessThan(after.indexOf('[BSRC] Cherry'));
    expect(w.repo.live(A.cherry)!.parentId).toBe(A.zoo); // the same parent
    expect(w.repo.mutations.filter((m) => m.op === 'moveResource')).toHaveLength(1);
    await w.snapshotAndAudit();
    expect(stillThere('out_of_order', A.cherry)).toBe(false);
  });

  it('a sibling added between the proposal and its approval stops it (nothing moves)', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('out_of_order', A.cherry);
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    w.repo.seed({
      id: 'newkid01',
      name: '[BSRC] Elderberry',
      parentId: A.zoo,
      referenceType: 'General Source',
    });
    const before = w.repo.children(A.zoo).map((x) => x.id);
    const done = await approve(r.proposalId);
    expect(['failed', 'conflicted']).toContain(done.state);
    expect(w.repo.children(A.zoo).map((x) => x.id)).toEqual(before);
  });

  it('refuses a page that is no longer under the parent the audit saw', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('out_of_order', A.cherry);
    w.repo.live(A.cherry)!.parentId = A.apple;
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({ code: 'FIX_STALE' });
  });

  it('is nothing to do when the page is already in its place', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('out_of_order', A.cherry);
    w.repo.live(A.cherry)!.rank = 'zzzz';
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    expect(['nothing_to_do', 'proposal_captured']).toContain(r.status);
  });
});

describe('Propose a fix: the additive tag fix', () => {
  const rules = {
    rules: [
      {
        id: 'zoo',
        name: 'Zoo pages',
        enabled: true,
        selectors: { ancestorName: 'Audit Zoo', kind: 'bsrc' as const, referenceType: 'General Source' },
        template: { templateName: 'AI General Source' },
      },
    ],
  };

  it('adds the missing required tag to the page’s tags and never removes one, once approved', async () => {
    w = await auditsWorld();
    w.repo.live(A.apple)!.tags = ['atlas'];
    audits().setConfig('owner', PROJECT, {
      ...rules,
      tagSource: { pageId: A.tagdef, documentId: w.mainOf(A.tagdef) },
    });
    await w.snapshotAndAudit();
    const f = finding('missing_required_tags', A.apple);
    expect(f.fix).toMatchObject({ kind: 'add_tags', args: { add: ['fruit'] } });
    // A tag outside the definition has a finding and no proposal.
    w.repo.live(A.banana)!.tags = ['sour', 'fruit'];
    await w.snapshotAndAudit();
    const out = finding('tags_outside_definition', A.banana);
    expect(out.fix).toBeNull();
    const r = await audits().proposeFix('owner', PROJECT, f.id);
    if (r.status !== 'proposal_captured') throw new Error('not captured');
    expect(await approve(r.proposalId)).toEqual({ state: 'executed', jobStatus: 'succeeded' });
    expect(w.repo.live(A.apple)!.tags).toEqual(['atlas', 'fruit']);
    expect(w.repo.live(A.banana)!.tags).toEqual(['sour', 'fruit']); // never removed
    await w.snapshotAndAudit();
    expect(stillThere('missing_required_tags', A.apple)).toBe(false);
  });

  it('every guard runs: a status tag in the definition is refused by the lifecycle guard, never written', async () => {
    w = await auditsWorld();
    // The definition now requires CANON, a status tag the lifecycle guard protects.
    w.blocksOf(A.tagdef)[1]!.text = JSON.stringify({
      schema: 1,
      rules: [{ id: 'zoo', required_tags: ['CANON'] }],
    });
    audits().setConfig('owner', PROJECT, {
      ...rules,
      tagSource: { pageId: A.tagdef, documentId: w.mainOf(A.tagdef) },
    });
    await w.snapshotAndAudit();
    const f = finding('missing_required_tags', A.apple);
    // The status tags are the lifecycle tools' to change: the engine's guard refuses the proposal at capture.
    await expect(audits().proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(w.repo.live(A.apple)!.tags).not.toContain('CANON');
    expect(w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
  });
});

describe('Re-check now', () => {
  it('reads the page live: still present (the source becomes live), or gone when it was fixed in the app', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = finding('line_break_paragraph', A.breaks, 'bp1');
    const before = w.requests();
    const same = await audits().recheck('owner', PROJECT, f.id);
    expect(same.status).toBe('still_present');
    expect(same.reads).toBeGreaterThanOrEqual(2);
    expect(w.requests() - before).toBe(same.reads);
    expect(w.stack.mock.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
    expect(same.finding!.source).toMatchObject({ kind: 'live', ageMs: 0 });
    // Fixed in the LegendKeeper app: the page's block no longer has the break.
    w.blocksOf(A.breaks)[1]!.content = [{ text: 'first line second line third line' }];
    const gone = await audits().recheck('owner', PROJECT, f.id);
    expect(gone.status).toBe('gone');
    expect(gone.finding).toMatchObject({ state: 'gone' });
    // The audit log has both.
    const log = w.stack.db.prepare("SELECT after FROM audit_log WHERE action = 'audits.recheck'").all() as {
      after: string;
    }[];
    expect(log.map((l) => (JSON.parse(l.after) as { result: string }).result)).toEqual([
      'still present',
      'gone',
    ]);
  });

  it('says why when a finding cannot be re-checked from one page', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f =
      audits().list(PROJECT, { category: ['taxonomy'], limit: 5 }).findings[0] ??
      audits()
        .list(PROJECT, { category: ['rules'], limit: 50 })
        .findings.find((x) => x.pageId === null);
    if (f)
      await expect(audits().recheck('owner', PROJECT, f.id)).rejects.toMatchObject({
        code: 'RECHECK_UNSUPPORTED',
      });
  });
});
