/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): Revert of a split's phase 1 (ADR 0059 decision 6.2, amending ADR 0055). Each test
 * asserts the SAFE behaviour: a pass means the attempt HELD, a failure is a bypass (a finding).
 *
 * The claims under attack: "The revert job puts back what the job changed (the source's text, the existing owners'
 * appends, ...), each only while it is as the job left it. The pages it made ... go to ONE deletion proposal ..., each
 * only while it is exactly as the split made it; a page changed since is kept and listed." A split moves material, so its
 * targets are coupled: the existing owner's append and the source's edit are two halves of one move.
 *
 * - SP-01: the surviving source edited since phase 1 (an ordinary later revision), then a partial revert the owner
 *   confirms: does the moved material survive somewhere live?
 * - SP-02: the deletion proposal that follows that partial revert: does it claim the material is back, and does its
 *   approval delete the only live copy of the moved sections?
 * - SP-03: the same after phase 2 has archived the source (archive_page's note changes the source's text).
 * - SP-04: a page the split made, edited AFTER the deletion proposal was made and before the owner approves it.
 * - SP-05: a page the split made whose formatting (not its text) was changed since the split.
 * - SP-44 (control): a page someone else made under the index the split made, then Revert.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, statutesBody, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit, zahraSplit } from '../../packs/split-inputs.js';
import { approveSplit, bodyOf, named, recordOf, type Obj } from '../../packs/split-helpers.js';
import { editBody, holders, ownerRevert, para, PROJECT, propose, reverted, S, surviving } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const LAW = ['sh3', 'sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6'];
const FAITH = ['sh4', 'sf1', 'sf2', 'sf3', 'sf4', 'sf5', 'sf6'];

describe('SP-01/02: a partial revert after the surviving source was edited', () => {
  let w: SplitWorld;
  let jobId: string;
  let lawId: string;
  let revertOut: Awaited<ReturnType<typeof ownerRevert>>;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    const p = await propose(w, surviving());
    lawId = p.pages.get('law')!.id;
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    jobId = done.jobId;
    await recordOf(w, jobId, (x) => x.state === 'verified');
    // Afterwards the surviving source gets an ordinary revision in the app (a line added at its end).
    editBody(w, S.statutes, (b) => {
      b.push(para('later01', 'A later note on the charter, added in the app.'));
    });
    revertOut = await ownerRevert(w, jobId, true);
  });
  afterAll(() => w?.close());

  it('SP-01 a confirmed partial revert never leaves a moved block with no live holder', () => {
    const { preview, rv, job } = revertOut;
    // The source's own text is the target that cannot go back (an outside edit is never overwritten).
    const src = preview.targets.find((t) => t.page?.id === S.statutes && t.state !== 'ready');
    expect(src, JSON.stringify(preview.targets)).toBeTruthy();
    // CR-2026-11-R3 (R3-09, fixed): a split's phase 1 is reverted whole or not at all, so the partial revert is refused
    // (nothing is reverted); on the reviewed code it ran, and the moved sections were left on no live page.
    expect(preview.split?.wholeOnly).toBe(true);
    expect(rv).toMatchObject({ status: 'refused', code: 'SPLIT_REVERT_NOT_WHOLE' });
    expect(job).toBeNull();
    const lost = [...LAW, ...FAITH].filter((id) => holders(w, id).length === 0);
    // SAFE: every block the split moved is still held by some live page (the source or a destination).
    expect(lost, `blocks with no live holder after the partial revert: ${lost.join(', ')}`).toEqual([]);
  });

  it('SP-02 the deletion proposal after a partial revert does not claim the material is back, nor delete its only copy', async () => {
    // CR-2026-11-R3 (R3-09, fixed): the partial revert was refused, so the split is not reverted and no deletion is
    // proposed; on the reviewed code a proposal said "the moved material is back" and deleted its only copy.
    if (revertOut.rv.status === 'refused') {
      const now = w.stack.runtime.splits.byJob(PROJECT, jobId)!;
      expect({ state: now.state, revert: now.revert }).toEqual({ state: 'verified', revert: null });
      return;
    }
    const rec = await reverted(w, jobId);
    const proposals = w.stack.runtime.policy.proposals;
    const del = rec.revert.deletionProposalId ? proposals.get(rec.revert.deletionProposalId) : undefined;
    const summary = String(del?.summary ?? '');
    // The source's text was NOT put back (the partial revert left it), so the proposal must not say it was.
    const claimsBack = /the moved material is back/i.test(summary);
    let lawLost: string[] = [];
    if (del && del.state === 'pending') {
      const d = await approveSplit(w, del.id);
      expect(d.job.status).toBe('succeeded');
      lawLost = LAW.filter((id) => holders(w, id).length === 0);
    }
    expect({ claimsBack, lawLost, lawPageLive: w.repo.live(lawId) !== undefined }).toEqual({
      claimsBack: false,
      lawLost: [],
      lawPageLive: expect.any(Boolean),
    });
  });
});

describe('SP-03: Revert of phase 1 once phase 2 has archived the source', () => {
  let w: SplitWorld;
  let jobId: string;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    const p = await propose(w, statutesSplit());
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    jobId = done.jobId;
    const rec = await recordOf(w, jobId, (x) => x.state === 'retiring');
    const archived = await approveSplit(w, rec.phase2.proposalId);
    expect(archived.job.status, JSON.stringify(archived.job.lastError)).toBe('succeeded');
    await recordOf(w, jobId, (x) => x.state === 'retired');
  });
  afterAll(() => w?.close());

  it('SP-03 reverting phase 1 after the archive never leaves the moved sections with no live holder', async () => {
    const out = await ownerRevert(w, jobId, true);
    const pending: string[] = [];
    if (out.rv.status === 'submitted' || out.rv.status === 'proposed') {
      const rec = await reverted(w, jobId);
      const id = rec.revert.deletionProposalId as string | null;
      if (id && w.stack.runtime.policy.proposals.get(id)?.state === 'pending') {
        pending.push(String(w.stack.runtime.policy.proposals.get(id)!.summary));
        await approveSplit(w, id);
      }
    }
    const lost = [...LAW, ...FAITH].filter((x) => holders(w, x).length === 0);
    expect(
      { status: out.rv.status, lost },
      `revert ${JSON.stringify(out.rv.status)}; deletion proposal: ${pending.join(' | ')}`,
    ).toEqual({ status: out.rv.status, lost: [] });
  });
});

describe('SP-04: a made page edited after the deletion proposal was made', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-04 a made page edited after the deletion proposal was made is not deleted when the owner approves it', async () => {
    const p = await propose(w, surviving());
    const lawId = p.pages.get('law')!.id;
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    await recordOf(w, done.jobId, (x) => x.state === 'verified');
    // A full revert (nothing changed since): the moved material goes back, the Law page to a deletion proposal.
    const out = await ownerRevert(w, done.jobId);
    expect(out.rv.status, JSON.stringify(out.rv)).toBe('submitted');
    expect(out.job?.status).toBe('succeeded');
    const rec = await reverted(w, done.jobId);
    expect(rec.revert.deleted.map((x: any) => x.id)).toEqual([lawId]);
    const delId = rec.revert.deletionProposalId as string;
    expect(w.stack.runtime.policy.proposals.get(delId)!.state).toBe('pending');
    // While the proposal waits for the owner, someone writes new material on the Law page (a live page).
    editBody(w, lawId, (b) => {
      b.push(
        para(
          'owner01',
          'New material written on the Law page after the revert, before the deletion is approved.',
        ),
      );
    });
    await approveSplit(w, delId);
    // SAFE: a page changed since the split made it is kept (ADR 0059 6.2), whenever the change came.
    expect(holders(w, 'owner01').map((h) => h.pageId)).toEqual([lawId]);
  });
});

describe('SP-05: a made page whose formatting changed since the split', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-05 a made page whose formatting changed since the split is kept, not proposed for deletion', async () => {
    expect(bodyOf(w, S.statutes).map((b) => b.id)).toEqual(statutesBody().map((b) => b.id));
    const p = await propose(w, surviving());
    const lawId = p.pages.get('law')!.id;
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    await recordOf(w, done.jobId, (x) => x.state === 'verified');
    // The owner then formats the moved text on the new page: the first statute's runs made bold, with a link.
    editBody(w, lawId, (b) => {
      const sl1 = b.find((x) => x.id === 'sl1')!;
      sl1.content = (sl1.content as Obj[]).map((r) => ({
        ...r,
        bold: true,
        link: 'https://example.test/law',
      }));
    });
    const out = await ownerRevert(w, done.jobId);
    expect(out.rv.status, JSON.stringify(out.rv)).toBe('submitted');
    const rec = await reverted(w, done.jobId);
    // SAFE: the page is not "exactly as the split made it", so it is kept and listed, never proposed for deletion.
    expect({
      deleted: rec.revert.deleted.map((x: any) => x.id),
      kept: rec.revert.kept.map((x: any) => x.id),
    }).toEqual({ deleted: [], kept: [lawId] });
  });
});

describe('SP-44 (control): a page someone else made under the index a split made', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-44 the deletion proposal after a Revert never deletes a page the split did not make', async () => {
    const p = await propose(w, zahraSplit());
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    await recordOf(w, done.jobId, (x) => x.state === 'verified');
    const index = named(w, '[INDEX] Zahra al-Rashid')!;
    // Someone files a page of their own under the new index, with material of its own.
    w.repo.seed({ id: 'zahnotes', name: '[BWRK] Zahra al-Rashid - Notes', parentId: index.id });
    w.repo.blocks.set(w.mainOf('zahnotes'), {
      version: 1,
      blocks: [para('zn1', 'Notes kept by another writer.')],
    });
    const out = await ownerRevert(w, done.jobId);
    expect(out.rv.status, JSON.stringify(out.rv)).toBe('submitted');
    const rec = await reverted(w, done.jobId);
    if (rec.revert.deletionProposalId)
      await approveSplit(w, rec.revert.deletionProposalId).catch(() => undefined);
    expect({ notes: w.repo.live('zahnotes') !== undefined, zn1: holders(w, 'zn1').length }).toEqual({
      notes: true,
      zn1: 1,
    });
  });
});

describe('SP-02b (CR-2026-11-R3, R3-10): the deletion proposal only once the material is back in the source', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('a page whose moved blocks are not back in the source is kept and listed, never proposed for deletion', async () => {
    const p = await propose(w, surviving());
    const lawId = p.pages.get('law')!.id;
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    await recordOf(w, done.jobId, (x) => x.state === 'verified');
    // As if a revert job had run but the source were still without the Law section (the R3-09 path, or any other):
    // the follow-up reads the source before it proposes anything.
    const out = await w.stack.runtime.splits.afterRevert(PROJECT, done.jobId, 'a-revert-job');
    const rec = w.stack.runtime.splits.byJob(PROJECT, done.jobId)!;
    expect(out?.deletionProposalId ?? null).toBeNull();
    expect(rec.revert?.deleted ?? []).toEqual([]);
    expect(rec.revert?.kept.map((k) => [k.id, k.why.slice(0, 60)])).toEqual([
      [lawId, expect.stringContaining('the material it took is not back in [BSRC] Ostrand Statutes')],
    ]);
    expect(LAW.filter((id) => holders(w, id).length === 0)).toEqual([]);
  });
});
