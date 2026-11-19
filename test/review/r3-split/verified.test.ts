/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3, R3-67 (the owner's split fix 2, found on the test world): a split's job (79 of 79 steps) ended with its
 * generic verification "not verified" while the split's own report said "verified". LegendKeeper answers a mention run
 * with the mentioned page's current name filled in (`name`, and `text` as its label); the generic verify compared the
 * label, so every interface summary and index line the split wrote ("See @page.") read back as a difference. And the split
 * took "verified" from its job having run to its end, not from the job's verification. Now a mention is compared by its
 * target (resourceId, documentId), and the split is verified only when the job's verification says so (its report states
 * the job's own verdict). Each test asserts the SAFE behaviour; the mock LegendKeeper only (its `fillMentions` answers
 * mentions as LegendKeeper does).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit } from '../../packs/split-inputs.js';
import { approveSplit, intercept, recordOf, split } from '../../packs/split-helpers.js';
import { propose, S, surviving } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('R3-67: mentions read back with their names filled in', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
    w.repo.fillMentions = true;
  });
  afterAll(() => w?.close());

  it('the job verifies, and the split says what the job says', async () => {
    const p = await propose(w, surviving());
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    // On the reviewed code: "not verified" (each mention's filled-in label a difference), the split "verified".
    const res = done.job.result as any;
    expect(res.verified, JSON.stringify(res.verification).slice(0, 3000)).toBe(true);
    const rec = await recordOf(w, done.jobId, (r) => r.state !== 'running' && r.state !== 'proposed');
    expect(rec.state).toBe('verified');
    const r = await split(w, { report: rec.id });
    expect(r.body).toMatchObject({ state: 'verified', verified: true });
  });
});

describe('R3-67: a job whose verification found a difference', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('the split is not verified, and its source is not retired', async () => {
    const p = await propose(w, statutesSplit());
    const lawId = p.pages.get('law')!.id;
    // Once the source's edits have begun (after the destinations check), someone renames the new Law page in the app:
    // the job's final verification (its generic read-back of the page's name) finds the difference, while the split's
    // own check of the moved blocks passes, so the job runs to its end.
    const sourceEdit = intercept(w, 'PUT', new RegExp(`/resources/${S.statutes}/docs/[^/]+/blocks$`), () => {
      const res = w.repo.live(lawId);
      if (res) res.name = '[BSRC] Ostrand Statutes - Someone Else';
      return undefined;
    });
    const done = await approveSplit(w, p.proposalId);
    sourceEdit.off();
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    expect((done.job.result as any).verified).toBe(false);
    // On the reviewed code: "verified" (the job ran to its end), and phase 2 proposed archiving the source.
    const rec = await recordOf(w, done.jobId, (r) => r.state !== 'running' && r.state !== 'proposed');
    expect(rec.state).toBe('unverified');
    expect(rec.phase2.proposalId).toBeUndefined();
    expect(rec.phase2.reason).toContain('its verification found differences');
    const r = await split(w, { report: rec.id });
    expect(r.body).toMatchObject({ state: 'unverified', verified: false });
    expect(w.repo.live(S.statutes)!.name).toBe('[BSRC] Ostrand Statutes and Rites - General Source');
  });
});
