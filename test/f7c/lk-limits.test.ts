/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method -- parsed JSON tool results; the test world's `call` */
/**
 * v3 F7c (ADR 0075, Z5): LegendKeeper's limits during a placement job, against the mock (nothing live):
 *
 * - a 429 `UPLOAD_RATE_EXCEEDED` with a long Retry-After on the second image's upload leaves the job waiting
 *   (`waiting_budget`), not failed; it resumes from that upload, and no image already in LegendKeeper is uploaded again
 *   (the mock's uploads are counted);
 * - a signed upload URL that expired while the job waited is made again by the PUT step (one more createImageUpload,
 *   never a second asset), and the asset binds the new upload's key.
 *
 * The governor's "short wait" threshold is lowered for the test (30 s in production) so a 1-second Retry-After counts
 * as long: the job parks exactly as it would for a long one, without the test waiting half a minute.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ownersWorld, PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { drain, until, uploadZip } from './helpers.js';
import { tinyImage, zip } from './zip.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const CHAR = 'Nadira al-Khalid';
const pngs = async (names: readonly string[]) =>
  zip(await Promise.all(names.map(async (name) => ({ name, data: await tinyImage('png') }))));
const ref = (id: string, entry: string, label: string) => ({
  archive: { id, entry },
  label,
  interpretation: `What ${label} establishes.`,
});
const uploads = (op: string) => w.lkUploads.filter((u) => (u as { op: string }).op === op).length;
const job = (id: string) => w.stack.runtime.engine.queries.getJob(PROJECT, id)!;

/** Wraps the mock's createImageUpload answer. */
function wrapUploads(
  f: (req: MockRequest, base: () => MockResponse | undefined) => MockResponse | undefined,
) {
  const re = [...w.overrides.keys()].find((k) => k.source === '\\/assets\\/uploads$')!;
  const base = w.overrides.get(re)!;
  w.overrides.set(re, (req) => f(req, () => base(req)));
  return () => w.overrides.set(re, base);
}

async function approveOnly(proposalId: string): Promise<string> {
  const policy = w.stack.runtime.policy;
  if (policy.proposals.get(proposalId)!.requiresCanonicalApproval)
    await policy.commands.approveAsCanon('owner', proposalId);
  else await policy.commands.approve('owner', proposalId);
  let jobId: string | null = null;
  await until(() => (jobId = w.stack.runtime.policy.proposals.get(proposalId)?.jobId ?? null) !== null);
  return jobId!;
}

describe('Z5: LegendKeeper limits during a placement job', () => {
  it(
    'a long Retry-After mid-job: waiting (budget), then resumed from the first unfinished upload, nothing uploaded twice',
    { timeout: 90_000 },
    async () => {
      const retry = w.stack.runtime.projects.client(PROJECT)!.governor.settings.retry as {
        maxShortWaitMs: number;
      };
      const short = retry.maxShortWaitMs;
      retry.maxShortWaitMs = 200;
      const r = await uploadZip(w, w.call, await pngs(['r1.png', 'r2.png', 'r3.png']), { stageAll: true });
      await drain(w);
      const p = await w.call('arkona_add_character_art', {
        character: CHAR,
        project: 'test',
        images: [
          ref(r.body.archive_id, 'r1.png', 'Primary Reference - Retry One'),
          ref(r.body.archive_id, 'r2.png', 'Primary Reference - Retry Two'),
          ref(r.body.archive_id, 'r3.png', 'Primary Reference - Retry Three'),
        ],
      });
      expect(p.body.status, p.text).toBe('proposal_captured');
      const before = {
        upload: uploads('createImageUpload'),
        asset: uploads('createImageAsset'),
        puts: w.puts.size,
      };
      let calls = 0;
      const restore = wrapUploads((req, base) => {
        if (req.method !== 'POST') return base();
        calls++;
        if (calls === 2)
          return {
            status: 429,
            body: { code: 'UPLOAD_RATE_EXCEEDED', message: 'Too many uploads', requestId: 'r-429' },
            // The upload tier's own headers (a reset a second or two away), as LegendKeeper's answer would carry.
            headers: {
              'retry-after': '1',
              'x-ratelimit-limit': '20',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1),
            },
          };
        return base();
      });
      try {
        const jobId = await approveOnly(String(p.body.proposalId));
        const seen = new Set<string>();
        await until(() => {
          const j = job(jobId);
          seen.add(j.status);
          return ['succeeded', 'failed'].includes(j.status);
        }, 60_000);
        expect(seen.has('waiting_budget')).toBe(true);
        expect(job(jobId).status, JSON.stringify(job(jobId).lastError)).toBe('succeeded');
        // Three images: three assets, three files sent; the refused upload was asked once more, nothing else repeated.
        expect(uploads('createImageAsset') - before.asset).toBe(3);
        expect(w.puts.size - before.puts).toBe(3);
        expect(calls).toBe(4);
        for (const n of ['One', 'Two', 'Three'])
          expect(w.assets.byName(`${CHAR} - Primary Reference - Retry ${n}`)).toHaveLength(1);
      } finally {
        restore();
        retry.maxShortWaitMs = short;
      }
    },
  );

  it('a signed URL that expired while the job waited is made again; the asset is made once, with the new key', async () => {
    const r = await uploadZip(w, w.call, await pngs(['e1.png']), { stageAll: true });
    await drain(w);
    let first = true;
    const restore = wrapUploads((req, base) => {
      const res = base();
      if (req.method !== 'POST' || !res || !first) return res;
      first = false;
      // The first upload's URL has already expired when the PUT comes to run.
      return {
        ...res,
        body: { ...(res.body as object), expiresAt: new Date(Date.now() - 1000).toISOString() },
      };
    });
    try {
      const before = { upload: uploads('createImageUpload'), asset: uploads('createImageAsset') };
      const p = await w.call('arkona_add_character_art', {
        character: CHAR,
        project: 'test',
        images: [ref(r.body.archive_id, 'e1.png', 'Primary Reference - Renewed')],
      });
      const jobId = await approveOnly(String(p.body.proposalId));
      await until(() => ['succeeded', 'failed'].includes(job(jobId).status), 20_000);
      expect(job(jobId).status, JSON.stringify(job(jobId).lastError)).toBe('succeeded');
      expect(uploads('createImageUpload') - before.upload).toBe(2);
      expect(uploads('createImageAsset') - before.asset).toBe(1);
      const assetCall = w.lkUploads.filter((u) => (u as { op: string }).op === 'createImageAsset').at(-1) as {
        body: { uploadKey: string };
      };
      // The asset names the renewed upload (whose PUT carried the bytes), so its stored file verifies.
      expect(w.puts.has(assetCall.body.uploadKey)).toBe(true);
      const steps = w.stack.runtime.engine.stepResults(PROJECT, jobId) ?? [];
      expect(JSON.stringify(steps)).toMatch(/"storedBytesVerified":true/);
    } finally {
      restore();
    }
  });
});
