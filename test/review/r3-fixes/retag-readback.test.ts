/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3, fix C (the owner's request): retagging's read-back. F3f claimed "documents unchanged" from the
 * per-document `updatedAt` that `getResource` lists, which Arkona's Repository Automation tab warns "can describe
 * creation/metadata time rather than body version". The read-back now compares each page document's body by its real
 * version (`getDocumentBlocks`, one read before the write and one after), and the disposition says exactly what was
 * compared. On the reviewed code a body edited during the job was read back "exactly" (this test failed there).
 * Mocks and fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockRequest } from '../../contract/mock-lk.js';
import { READ_BACK_VERIFIED } from '../../../src/packs/retag/service.js';
import { approve } from '../../packs/world.js';
import { PROJECT, R, retagWorld, type RetagWorld } from '../../packs/retag-world.js';

vi.setConfig({ testTimeout: 180_000 });

let w: RetagWorld;
let runId: string;
beforeAll(async () => {
  w = await retagWorld();
  await w.snapshot();
  const r = await w.callRead('arkona_retag_audit', { project: 'test', limit: 200, under: R.desk });
  expect(r.isError, r.text).toBe(false);
  runId = String(r.body.runId);
});
afterAll(async () => w?.close());

const mainOf = (id: string): string =>
  w.repo.liveDocs(w.repo.live(id)!).find((d: any) => d.name === 'Main')!.id;

describe('CR-2026-11-R3 fix C: the retag read-back compares document bodies by their version', () => {
  it("a page document's body edited during the job (after the check, before the read-back) is reported, never read back as unchanged", async () => {
    const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages: [R.order] });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const doc = mainOf(R.order);
    let reads = 0;
    // An edit in the app right after the job's check has read the body (its first read of it in the job).
    w.overrides.set(new RegExp(`/resources/${R.order}/docs/${doc}/blocks$`), (req: MockRequest) => {
      if (req.method !== 'GET') return undefined;
      const answer = w.repo.respond(req);
      if (++reads === 1) {
        const b = w.repo.blocks.get(doc)!;
        b.blocks = [
          ...(b.blocks as object[]),
          { id: 'r3edit1', kind: 'paragraph', content: [{ text: 'Edited.' }] },
        ];
        b.version++;
      }
      return answer;
    });
    const done = await approve(w, String(r.body.proposalId));
    w.overrides.delete(new RegExp(`/resources/${R.order}/docs/${doc}/blocks$`));
    expect(done.job?.status).toBe('succeeded');
    expect(reads).toBe(2); // one before the write (the check), one after (the read-back)
    const b = w.stack.runtime.retag.store.batchByProposal(String(r.body.proposalId))!;
    const d = b.dispositions![R.order]!;
    expect(d).toMatchObject({ outcome: 'applied', verified: false });
    expect(d.reason).toBe('written; the read-back found a difference');
    expect(JSON.stringify((d as any).differences)).toContain('body unchanged (by its version)');
  });

  it('a clean apply says exactly what its read-back compared (page bodies by version, other documents by metadata only)', async () => {
    const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages: [R.missing] });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const before = w.requests();
    const done = await approve(w, String(r.body.proposalId));
    expect(done.job?.status).toBe('succeeded');
    const b = w.stack.runtime.retag.store.batchByProposal(String(r.body.proposalId))!;
    expect(b.dispositions![R.missing]).toMatchObject({
      outcome: 'applied',
      verified: true,
      reason: READ_BACK_VERIFIED,
    });
    expect(READ_BACK_VERIFIED).toContain('metadata timestamps only');
    expect(READ_BACK_VERIFIED).not.toMatch(/read back exactly/);
    // The page's one page document was read before the write and compared after it (one read each, besides the change
    // snapshot's own reads after the job).
    const steps = w.stack.runtime.engine.stepRecords(PROJECT, done.job!.id)!;
    const check = steps.find(
      (s) => s.opId === 'bridge.expect' && JSON.stringify(s.result).includes('"bodies"'),
    )!;
    const bodies = JSON.stringify(check.result).match(/"bodies":\{[^}]*\}/)?.[0] ?? '';
    expect(bodies).toContain(`"${mainOf(R.missing)}":"version `);
    const bodyReads = w.stack.mock.calls
      .slice(before.all)
      .filter((c) => c.method === 'GET' && /\/docs\/[^/]+\/blocks\/?$/.test(c.path)).length;
    expect(bodyReads).toBeGreaterThanOrEqual(2);
  });
});
