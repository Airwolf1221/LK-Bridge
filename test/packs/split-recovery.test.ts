/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3e (ADR 0059): what happens when a split does not go as planned, against the mock LegendKeeper (never a real one):
 *
 * - a verification failure (the mock drops a moved block): phase 1 stops BEFORE anything leaves the source and before
 *   phase 2; Resume (once it is put right) reads the write that did not land as planned back again first (ADR 0061 part
 *   B decision 6, the owner's (b)): it now reads back as planned, so it counts as verified ("put right since", in the
 *   job's result), the job runs to its end verified and phase 2 is proposed; Revert puts back what it did and proposes
 *   deleting the pages it made (with nothing to put back, only that proposal);
 * - selective approval (D6): a destination left out keeps its sections in the source, coverage holds, phase 2 is
 *   withheld; a selection that is not closed is refused;
 * - rebase on conflict (F3d.1): an outside edit to an existing owner just as the append is sent (LegendKeeper answers
 *   412) is rebased on the fresh page and applied, the outside edit kept; the extra reads pinned;
 * - the source changed since the plan: the job's first check stops it before any write.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PolicyError } from '../../src/policy/errors.js';
import { C, PROJECT, S, splitWorld, statutesBody, type SplitWorld } from './split-world.js';
import { statutesSplit, zahraSplit } from './split-inputs.js';
import {
  approveSplit,
  bodyOf,
  ids,
  intercept,
  linksOf,
  named,
  OWNER_ORIGIN,
  recordOf,
  settle,
  split,
  textOf,
  type Obj,
} from './split-helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const STATUTES = '[BSRC] Ostrand Statutes and Rites - General Source';

/** Drops block `id` from the first replaceDocumentBlocks sent to `pageId` (LegendKeeper "losing" a moved block). */
function dropOnWrite(w: SplitWorld, pageId: string, id: string) {
  return intercept(w, 'PUT', new RegExp(`/resources/${pageId}/docs/[^/]+/blocks$`), (n, req) => {
    const body = req.body as { blocks?: Obj[] };
    if (n === 0 && Array.isArray(body.blocks)) {
      const at = body.blocks.findIndex((b) => b.id === id);
      if (at >= 0) body.blocks.splice(at, 1);
    }
    return undefined;
  });
}

describe('a verification failure: phase 1 stops before phase 2; Resume continues it', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('the mock drops a moved block: stopped before anything left the source; no phase 2; Resume completes it', async () => {
    const r = await split(w, statutesSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const lawId = (r.body.destinations as any[]).find((d) => d.key === 'law').page.id;
    const drop = dropOnWrite(w, lawId, 'sl3');
    const done = await approveSplit(w, String(r.body.proposalId));
    drop.off();
    expect(done.job.status).toBe('failed');
    expect(done.job.lastError).toMatchObject({ code: 'SPLIT_DESTINATIONS_UNVERIFIED' });
    expect(done.job.lastError!.message).toContain('sl3');
    // Nothing left the source: every block is still there, as it was.
    expect(ids(bodyOf(w, S.statutes))).toEqual(statutesBody().map((b) => b.id));
    // No phase 2: the record says why, and nothing proposes the archive.
    const rec = await recordOf(w, done.jobId, (x) => x.state === 'stopped');
    expect(rec.phase2.reason).toContain('stopped before it verified');
    expect(rec.phase2.proposalId).toBeUndefined();
    // Where it stopped, and that the owner may resume it.
    const view = w.stack.runtime.resume.view(PROJECT, done.jobId);
    expect(view.resumable).toBe(true);

    // Put right (the block written where it belongs), then resumed: it continues from the check that stopped it.
    const doc = w.repo.blocks.get(w.mainOf(lawId))!;
    const blocks = doc.blocks as Obj[];
    const sl3 = statutesBody().find((b) => b.id === 'sl3')!;
    blocks.splice(blocks.findIndex((b) => b.id === 'sl2') + 1, 0, JSON.parse(JSON.stringify(sl3)) as Obj);
    doc.version += 1;
    const out = await w.stack.runtime.resume.resume(PROJECT, done.jobId, { kind: 'owner' }, OWNER_ORIGIN);
    expect(out.status, JSON.stringify(out)).toBe('resumed');
    const job = await settle(w, done.jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(ids(bodyOf(w, S.statutes))).toEqual(['sh1', 'sp1', 'sh2', 'so1', 'sh5', 'ss1', 'sh6', 'su1']);
    expect(ids(bodyOf(w, lawId))).toEqual(expect.arrayContaining(['sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6']));
    // The append made before it stopped was not made twice.
    expect(ids(bodyOf(w, S.sunRite)).filter((x) => x === 'sf1')).toEqual(['sf1']);
    // CR-2026-11-R3 (R3-67) and ADR 0061 part B decision 6 (the owner's (b)): the split is verified only when its job's
    // verification is; Resume read the write that did not land as planned (the Law page without sl3) back again first,
    // and, put right by hand since, it now reads back as planned: it counts as verified, and the job's result says so.
    const job2 = w.stack.runtime.engine.queries.getJob(PROJECT, done.jobId)!;
    expect((job2.result as any).verified).toBe(true);
    const law = job2.steps.find(
      (x) => x.opId === 'replaceDocumentBlocks' && x.params?.path?.resourceId === lawId,
    )!;
    expect((job2.result as any).putRightSince).toEqual([law.stepNo]);
    expect((law.resultSummary as any).verification).toMatchObject({
      status: 'verified',
      putRightSince: true,
      earlier: { status: 'mismatch' },
    });
    // So the split is verified, and phase 2 runs as for any verified split (v3 F12: at once, the owner's approval of
    // the split having asked for it).
    const after = await recordOf(w, done.jobId, (x) => x.state !== 'running' && x.state !== 'stopped');
    expect(after.state).not.toBe('unverified');
    expect(after.phase2.jobId).toEqual(expect.any(String));
    const rep = await split(w, { report: after.id });
    expect(rep.body).toMatchObject({ verified: true });
  });
});

describe('a verification failure: Revert', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('puts back what phase 1 did (her place, the links) and proposes deleting the pages it made', async () => {
    const r = await split(w, zahraSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const pages = (r.body.destinations as any[]).filter((d) => d.page).map((d) => d.page);
    const bio = pages.find((p: any) => p.name.endsWith('Biography'));
    const drop = dropOnWrite(w, bio.id, 'zb5');
    const done = await approveSplit(w, String(r.body.proposalId));
    drop.off();
    expect(done.job.status).toBe('failed');
    expect(done.job.lastError).toMatchObject({ code: 'SPLIT_DESTINATIONS_UNVERIFIED' });
    const index = named(w, '[INDEX] Zahra al-Rashid')!;
    expect(w.repo.live(S.zahra)!.parentId).toBe(index.id);
    const before = JSON.stringify(bodyOf(w, S.zahra));

    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, done.jobId);
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    if (rv.status !== 'submitted') return;
    expect((await settle(w, rv.revertJobId)).status).toBe('succeeded');
    // Her reference back where it was; its text never changed; the relationship links taken off again.
    expect(w.repo.live(S.zahra)!.parentId).toBe(C.qishen);
    expect(JSON.stringify(bodyOf(w, S.zahra))).toBe(before);
    const rel = pages.find((p: any) => p.name.includes('&'));
    expect(linksOf(w, S.zahra, 'Related Sources')).not.toContain(rel.id);
    // The pages it made, and its index, to ONE deletion proposal; the Biography page is not as the split made it (the
    // block LegendKeeper dropped), so it is kept and listed: the owner decides.
    const rec = await recordOf(w, done.jobId, (x) => x.state === 'reverted');
    // v3 F12 (ADR 0081): the index the Biography page is in is kept with it (it cannot be deleted with a child).
    expect(rec.revert.deleted.map((p: any) => p.id).sort()).toEqual(
      [...pages.filter((p: any) => p.id !== bio.id).map((p: any) => p.id)].sort(),
    );
    expect(rec.revert.kept).toEqual([
      { id: bio.id, name: bio.name, why: 'its text changed since the split made it' },
      { id: index.id, name: index.name, why: 'a page under it is kept' },
    ]);
    // v3 F12 (ADR 0081): deleted at once, as part of the owner's Revert (each page checked first).
    expect(rec.revert.deletionProposalId).toBeNull();
    const delJob = await settle(w, String(rec.revert.deletionJobId));
    expect(delJob.status, JSON.stringify(delJob.lastError)).toBe('succeeded');
    expect(w.repo.live(index.id)).toBeTruthy();
    expect(w.repo.live(bio.id)).toBeTruthy();
    // Reverted: never resumed.
    const resumed = await w.stack.runtime.resume
      .resume(PROJECT, done.jobId, { kind: 'owner' }, OWNER_ORIGIN)
      .catch((e: unknown) => e);
    expect((resumed as { code?: string }).code).toBe('REVERTED');
  });

  it('with nothing else to put back, only the deletion proposal (no revert job)', async () => {
    // The Ostrand split without its Religion owner: the Law page is made (its text as planned), but LegendKeeper drops
    // its Scope, so the check stops the job before anything leaves the source.
    const r = await split(w, statutesSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const lawId = (r.body.destinations as any[]).find((d) => d.key === 'law').page.id;
    const keep = (r.body.items.list as any[]).map((i) => i.id).filter((id: string) => id !== 'dest:rite');
    const drop = intercept(
      w,
      'PATCH',
      new RegExp(`/resources/${lawId}/properties/[^/]+/rows/[^/]+$`),
      (_n, req) => {
        const body = req.body as { content?: Obj[] };
        if (body.content?.[0]?.text === 'The statutes and assize courts of Ostrand') body.content = [];
        return undefined;
      },
    );
    const done = await approveSplit(w, String(r.body.proposalId), keep);
    drop.off();
    expect(done.job.status).toBe('failed');
    expect(done.job.lastError).toMatchObject({ code: 'SPLIT_DESTINATIONS_UNVERIFIED' });
    expect(done.job.lastError!.message).toContain('Scope');
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, done.jobId);
    // v3 F12 (ADR 0081): the pages it made are deleted at once, part of the owner's Revert (no second approval).
    expect(rv).toMatchObject({
      status: 'proposed',
      deletionProposalId: null,
      deletionJobId: expect.any(String),
    });
    if (rv.status !== 'proposed') return;
    const d = await settle(w, rv.deletionJobId!);
    expect(d.status, JSON.stringify(d.lastError)).toBe('succeeded');
    expect(w.repo.live(lawId)).toBeFalsy();
    expect(ids(bodyOf(w, S.statutes))).toEqual(statutesBody().map((b) => b.id));
    // Once only.
    expect(await w.stack.runtime.reverts.revert('owner', PROJECT, done.jobId)).toMatchObject({
      status: 'refused',
      code: 'ALREADY_REVERTED',
    });
  });
});

describe('selective approval (D6): a destination left out keeps its sections in the source', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('the owner sees what leaving it out means; a selection that is not closed is refused', async () => {
    const r = await split(w, statutesSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    const view = w.stack.runtime.policy.proposals.get(id)!;
    const plan = w.stack.runtime.policy.proposals.detail(id)!.itemPlan!;
    expect(plan.items.find((i) => i.id === 'dest:rite')!.diff!.context).toBe(
      `If left out, “Faith and Worship” stays in ${STATUTES} (nothing is lost).`,
    );
    // The remapped Dependencies need the Law owner: keeping them without it is not a closed selection.
    const open = plan.items.map((i) => i.id).filter((x) => x !== 'dest:law');
    const refused = await w.stack.runtime.policy.commands
      .approveAsCanon('owner', id, { items: open })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PolicyError);
    expect((refused as PolicyError).code).toBe('SELECTION_NOT_CLOSED');
    expect(view.requiresCanonicalApproval).toBe(true);

    // Everything but the Religion owner: Faith and Worship stays where it is, coverage holds.
    const keep = plan.items.map((i) => i.id).filter((x) => x !== 'dest:rite');
    const done = await approveSplit(w, id, keep);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const lawId = (r.body.destinations as any[]).find((d) => d.key === 'law').page.id;
    const src = ids(bodyOf(w, S.statutes));
    expect(src).toEqual([
      'sh1',
      'sp1',
      'sh2',
      'so1',
      'sh4',
      'sf1',
      'sf2',
      'sf3',
      'sf4',
      'sf5',
      'sf6',
      'sh5',
      'ss1',
      'sh6',
      'su1',
    ]);
    expect(ids(bodyOf(w, S.sunRite))).not.toContain('sf1');
    // Every block of the source in exactly one place.
    const law = ids(bodyOf(w, lawId));
    for (const b of statutesBody())
      expect([src.includes(b.id), law.includes(b.id)].filter(Boolean).length, b.id).toBe(1);
    // Phase 2 is withheld: the source still owns material.
    const rec = await recordOf(w, id, (x) => x.state === 'verified');
    expect(rec.phase2.reason).toContain('left out 1 item (dest:rite)');
    expect(rec.phase2.proposalId).toBeUndefined();
    expect(w.stack.runtime.policy.proposals.get(id)!.items).toMatchObject({ omitted: 1 });
  });
});

describe('rebase on conflict (F3d.1): an existing owner edited just as the append is sent', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('LegendKeeper answers 412: the append is rebased on the fresh page and applied; the outside edit kept', async () => {
    const r = await split(w, statutesSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const RITE = new RegExp(`/resources/${S.sunRite}/docs/[^/]+/blocks$`);
    const put = intercept(w, 'PUT', RITE, (n) => {
      if (n === 0) {
        // Edited in the app just as the append is sent: the document's version moves on.
        const doc = w.repo.blocks.get(w.mainOf(S.sunRite))!;
        (doc.blocks as Obj[]).find((b) => b.id === 'rt2')!.content = [
          { text: 'The Sun Rite of Ostrand, revised.' },
        ];
        doc.version += 1;
      }
      return undefined;
    });
    const get = intercept(w, 'GET', RITE, () => undefined);
    const done = await approveSplit(w, String(r.body.proposalId));
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    const rite = bodyOf(w, S.sunRite);
    expect(textOf(rite.find((b) => b.id === 'rt2')!)).toBe('The Sun Rite of Ostrand, revised.');
    const at = rite.findIndex((b) => textOf(b) === 'Worship under the Statutes');
    expect(ids(rite.slice(at + 1, at + 8))).toEqual(['sh4', 'sf1', 'sf2', 'sf3', 'sf4', 'sf5', 'sf6']);
    // The cost of the conflict: the append sent twice, and ONE extra read of the page (after the 412).
    expect(put.count()).toBe(2);
    expect(get.count()).toBe(GETS_WITH_CONFLICT);
    // The rebase is recorded with the write.
    const steps = w.stack.runtime.engine.stepRecords(PROJECT, done.jobId)!;
    expect(JSON.stringify(steps.map((s) => s.result))).toContain('"rebased":{"conflicts":1');
  });

  it('the source changed since the plan: the first check stops the job before any write', async () => {
    const r = await split(w, zahraSplit());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const doc = w.repo.blocks.get(w.mainOf(S.zahra))!;
    (doc.blocks as Obj[]).find((b) => b.id === 'zb3')!.content = [{ text: 'Rewritten in the app.' }];
    doc.version += 1;
    const writes = w.requests().writes;
    const done = await approveSplit(w, String(r.body.proposalId));
    expect(done.job.status).toBe('failed');
    expect(done.job.lastError).toMatchObject({ code: 'SPLIT_SOURCE_CHANGED' });
    expect(w.requests().writes).toBe(writes);
  });
});

/**
 * The reads of the Religion owner's document in the job with one conflict (pinned): without it, 4 (the read inside the
 * append's lock, the read-back after the write, the destinations check and the verification; test/packs/split.test.ts),
 * and ONE more, the re-read after the 412.
 */
const GETS_WITH_CONFLICT = 5;
