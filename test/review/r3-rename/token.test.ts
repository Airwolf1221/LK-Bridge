/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * CR-2026-11 round 3 (renames): a culture's or race's identity token (ADR 0058 decision 1.5, D3). The token change
 * comes in as a NEW pack version; the job waits (`waitFor`) until the owner approves it, and "its check confirms inside
 * the lock that the APPROVED version maps the new value to the new token". Can a character's new identity tag be written
 * while the approved pack does not map it? Against the mock LegendKeeper only. Every test asserts the SAFE behaviour; a
 * failing test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT, R, renameWorld, type RenameWorld } from '../../packs/rename-world.js';
import { intercept, settle } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const tagsOf = (w: RenameWorld) => R.characters.map((id) => w.repo.live(id)!.tags);

describe('RN token: before and instead of the approved version', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('RN-60 a second rename of the same culture cannot race the first for its token while it waits', async () => {
    const a = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    expect(a.body.status, a.text).toBe('proposal_captured');
    const b = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarisk' });
    expect(b.body.error?.code, b.text.slice(0, 300)).toBe('DUPLICATE_REQUEST');
    // From the culture's index (another page of the same subject) as well.
    const c = await w.call('arkona_rename', { subject: R.velaranIndex, newName: 'Velarisk' });
    expect(c.body.error?.code, c.text.slice(0, 300)).toBe('DUPLICATE_REQUEST');
    w.stack.runtime.policy.commands.reject('owner', String(a.body.proposalId), 'next test');
  });

  it('RN-61 the job never writes before its version is approved, and a different version approved refuses it', async () => {
    const packs = w.stack.runtime.packs;
    const before = packs.get('arkona')!;
    const oldCulture = { ...before.rules.tags.culture };
    const r = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const proposalId = String(r.body.proposalId);
    const mid = w.requests().writes;
    await w.stack.runtime.policy.commands.approveAsCanon('owner', proposalId);
    const jobId = w.stack.runtime.policy.proposals.get(proposalId)!.jobId!;
    expect(packs.get('arkona')!.rules.tags.culture.Velarine).toBe('Velarine');
    await new Promise((res) => setTimeout(res, 300));
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!.status).toBe('queued');
    expect(w.requests().writes - mid).toBe(0);
    // The owner withdraws the token change: a version with the old map, approved instead.
    packs.commands.setTokens('owner', 'arkona', { culture: oldCulture });
    await packs.commands.approve('owner', 'arkona');
    const job = await settle(w, jobId);
    expect(job.status).toBe('failed');
    expect(JSON.stringify(job.lastError)).toContain('PACK_TOKEN_NOT_APPROVED');
    expect(w.requests().writes - mid).toBe(0);
    for (const t of tagsOf(w)) expect(t).toContain('Velaran');
  });
});

describe('RN token: the approved version changing while the job runs', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  // CR-2026-11-R3 (R3-60): built (docs/reviews/CR-2026-11-R3.md section 7; ADR 0058's second amendment): each tag write judges the approved token map inside its lock, and skips (saying so) when it no longer maps the new tag.
  it('RN-62 a character’s new tag is never written once the approved version no longer maps it (modelled)', async () => {
    const packs = w.stack.runtime.packs;
    const oldCulture = { ...packs.get('arkona')!.rules.tags.culture };
    const r = await w.call('arkona_rename', { subject: 'Velaran', newName: 'Velarine' });
    const proposalId = String(r.body.proposalId);
    await w.stack.runtime.policy.commands.approveAsCanon('owner', proposalId);
    const jobId = w.stack.runtime.policy.proposals.get(proposalId)!.jobId!;
    // Just as the first character's tag is about to be written (its own read inside its lock), the owner sets the pack
    // back: a version with the old map, approved (the store's approval, as the dashboard's approve ends).
    intercept(w, 'GET', new RegExp(`/resources/${R.characters[0]}$`), (n) => {
      if (n === 0) {
        const approved = packs.get('arkona')!.approved!;
        const v = packs.commands.setTokens('owner', 'arkona', { culture: oldCulture });
        packs.store.approve('arkona', {
          version: v.version,
          at: Date.now(),
          by: 'owner',
          sources: approved.sources,
        });
      }
      return undefined;
    });
    await packs.commands.approve('owner', 'arkona');
    const job = await settle(w, jobId);
    const approvedMap = packs.get('arkona')!.rules.tags.culture;
    expect(approvedMap.Velarine).toBeUndefined();
    // Safe: no character carries a tag the approved pack does not map (the tag writes stop, or are skipped).
    const tagged = tagsOf(w).filter((t) => t.includes('Velarine')).length;
    expect({ status: job.status, tagged }).toMatchObject({ tagged: 0 });
  });
});
