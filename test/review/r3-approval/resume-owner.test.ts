/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 3 (Resume) and decision 2.5 ("Propose these again") on a rename that
 * stopped part-way, as the owner would meet it on the dashboard. The attempts: resuming a canonical job whose proposal
 * the owner REJECTED (after it was conflicted); proposing the left-out items again while the approved part has not run
 * (their dependency on it silently dropped); resuming twice; resuming a job that has nothing left; Resume never sending
 * a verified step again. The safe behaviour is asserted; a failure is a finding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approve } from '../../packs/world.js';
import { C, O, P, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import {
  NEW,
  OLD,
  OWNER_ORIGIN,
  PROJECT,
  approveItems,
  itemsOf,
  proposeRename,
  rejection,
  reproposeOrigin,
  settle,
  outsideEdit,
  textOf,
  writesTo,
} from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

let open: RenameWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const ART = '[BSRC] Nadira al-Khalid - Character Art';
const SENTENCE = 'Nadira al-Khalid catalogued the emirate’s charters in her youth.';

describe('Resume: the proposal’s own decision', () => {
  it('AP-20 a job whose proposal is conflicted is not resumed (control)', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    // A page of her set renamed in the app after the proposal was made: the job's first check stops it, nothing
    // written.
    w.repo.outside.rename(P.nadiraArt, '[BSRC] Nadira al-Khalid - Portraits');
    const done = await approve(w, id);
    expect(done.state, JSON.stringify(done.job?.lastError)).toBe('conflicted');
    const view = w.stack.runtime.resume.view(PROJECT, done.jobId!);
    expect(view.resumable).toBe(false);
    expect(view.reason?.code).toBe('PROPOSAL_CONFLICTED');
  });

  it('AP-21 once the owner REJECTS the conflicted proposal, its canonical job is still never resumed', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    w.repo.outside.rename(P.nadiraArt, '[BSRC] Nadira al-Khalid - Portraits');
    const done = await approve(w, id);
    expect(done.state).toBe('conflicted');
    // "Reject it and plan again", as the refusal says.
    w.stack.runtime.policy.commands.reject('owner', id, 'not now');
    expect(w.stack.runtime.policy.proposals.get(id)!.state).toBe('rejected');
    // The page is put back, so the job's own check would pass again.
    w.repo.outside.rename(P.nadiraArt, ART);
    const view = w.stack.runtime.resume.view(PROJECT, done.jobId!);
    const e = await rejection(() =>
      w.stack.runtime.resume.resume(PROJECT, done.jobId!, { kind: 'owner' }, OWNER_ORIGIN),
    );
    if (!e) await settle(w, done.jobId!);
    expect(
      {
        resumable: view.resumable,
        refused: e !== undefined,
        core: w.repo.live(C.nadira)!.name,
        proposal: w.stack.runtime.policy.proposals.get(id)!.state,
      },
      'the rejected rename was resumed and applied',
    ).toEqual({
      resumable: false,
      refused: true,
      core: '[BSRC] Nadira al-Khalid - Character Core',
      proposal: 'rejected',
    });
  });
});

describe('"Propose these again" before the approved part has run', () => {
  it('AP-22 left-out items of a rename stopped before its subject’s name never apply alone', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    // The owner ticks every item but the AU page's restatement (left out for now).
    const au = plan.items.find((i) => i.id.endsWith(':au2:0'))!;
    expect(au.selected).toBe(true);
    const keep = plan.items.filter((i) => i.id !== au.id).map((i) => i.id);
    // The job stops at its very first write: the subject's own new name.
    w.failNext('PATCH', /\/resources\/[^/]+$/, 0);
    const first = await approveItems(w, id, keep);
    expect(first.job?.status).toBe('failed');
    expect(w.repo.live(C.nadira)!.name).toBe('[BSRC] Nadira al-Khalid - Character Core');
    // "Propose these again" is offered on a failed proposal; the reproposal drops the item's dependency on the
    // subject's new name ("what was approved has run"), which never ran.
    const again = await rejection(() =>
      w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id)),
    );
    if (again === undefined) {
      const secondId = w.stack.runtime.policy.proposals.get(id)!.reproposedAs!;
      expect(itemsOf(w, secondId).items.map((i) => [i.id, i.dependsOn])).toEqual([[au.id, []]]);
      const r = await rejection(approve(w, secondId));
      expect(r, String(r)).toBeUndefined();
    }
    // SAFE: no text says "Laila al-Khalid" while the subject itself still has its old name.
    const core = w.repo.live(C.nadira)!.name;
    const auText = textOf(w, C.au, 'au2');
    expect(
      { core, renamedAlone: auText.includes(NEW) && core.includes(OLD) },
      `the AU page now reads “${auText}” while the subject is still ${core}`,
    ).toEqual({ core: '[BSRC] Nadira al-Khalid - Character Core', renamedAlone: false });
  });

  it('AP-26 after a rename’s default approval, "Propose these again" makes its proposal', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const done = await approve(w, id);
    expect(done.job?.status).toBe('succeeded');
    expect(itemsOf(w, id).omitted!.length).toBeGreaterThan(0);
    const e = await rejection(() =>
      w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id)),
    );
    expect(e?.message, 'the left-out items cannot be proposed again').toBeUndefined();
    expect(w.stack.runtime.policy.proposals.get(id)!.reproposedAs).toBeTruthy();
  });
});

describe('Resume: nothing twice', () => {
  it('AP-23 resuming twice at once sends each remaining write once, and the verified prefix never again', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    w.failNext('PUT', /\/blocks\/[^/]+$/, 2);
    const done = await approve(w, id);
    expect(done.job?.status).toBe('failed');
    const jobId = done.jobId!;
    const stop = w.stack.runtime.resume.stopOf(PROJECT, jobId)!;
    const renamesBefore = writesTo(w, /\/resources\/[^/]+$/);
    const blocksBefore = writesTo(w, /\/blocks\/[^/]+$/);
    const [a, b] = await Promise.allSettled([
      w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN),
      w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN),
    ]);
    const job = await settle(w, jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect([a.status, b.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    // No page rename (all verified before the stop) was sent again.
    expect(writesTo(w, /\/resources\/[^/]+$/) - renamesBefore).toBe(
      job.steps.filter((s) => s.stepNo > stop.lastVerifiedStep && s.opId === 'updateResource').length,
    );
    // Every block write left was sent once (the one that failed, once more).
    const left = job.steps.filter(
      (s) => s.stepNo > stop.lastVerifiedStep && s.opId === 'replaceBlock',
    ).length;
    expect(writesTo(w, /\/blocks\/[^/]+$/) - blocksBefore).toBe(left);
  });

  it('AP-24 a job that has succeeded is not resumed (NOTHING_LEFT)', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const done = await approve(w, id);
    expect(done.job?.status).toBe('succeeded');
    const e = await rejection(() =>
      w.stack.runtime.resume.resume(PROJECT, done.jobId!, { kind: 'owner' }, OWNER_ORIGIN),
    );
    expect(e?.code).toBe('NOTHING_LEFT');
  });
});

describe('Resume: an item skipped before the stop', () => {
  it('AP-25 an item the first check skipped is either applied on Resume or still reported as skipped', async () => {
    const w = (open = await renameWorld());
    const id = await proposeRename(w);
    const plan = itemsOf(w, id);
    const qs4 = plan.items.find((i) => i.id.endsWith(':qs4:0'))!;
    // Edited in the app after the proposal: the job's first check skips its item (changed meanwhile).
    outsideEdit(w, O.qasr, 'qs4', `${OLD} catalogued every charter of the emirate.`);
    // The job stops later, at the art folder's new name.
    w.failNext('PATCH', /\/assets\/[^/]+$/, 0);
    const done = await approve(w, id);
    expect(done.job?.status).toBe('failed');
    const jobId = done.jobId!;
    expect(w.stack.runtime.engine.skippedItems(PROJECT, jobId).map((x) => x.item)).toContain(qs4.id);
    // The sentence is put back as it was planned; the owner resumes (the first check runs again).
    outsideEdit(w, O.qasr, 'qs4', SENTENCE);
    await w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN);
    const job = await settle(w, jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    const applied = textOf(w, O.qasr, 'qs4').startsWith(NEW);
    const reported = w.stack.runtime.engine.skippedItems(PROJECT, jobId).some((x) => x.item === qs4.id);
    // SAFE: an approved item is never lost silently (neither applied nor listed as skipped for "Propose these again").
    expect({ applied, reported }, 'the approved item was neither applied nor reported').not.toEqual({
      applied: false,
      reported: false,
    });
  });
});
