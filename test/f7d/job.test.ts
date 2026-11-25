/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method -- parsed JSON tool results; the test world's `call` */
/**
 * v3 F7d (ADR 0077, A4 to A6): the groups call's job against the mock: archive entries end to end (one held, so the job
 * waits, `waiting_staging`, then runs), and a long rate wait that parks the job, which resumes without uploading again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import type { OwnersWorld } from '../packs/owners-world.js';
import { drain, until, uploadZip } from '../f7c/helpers.js';
import { tinyImage, zip } from '../f7c/zip.js';
import { f7dWorld, headingsOf, pageNamed, PROJECT } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await f7dWorld();
});
afterAll(async () => {
  await w?.close();
});

const CHAR = 'Nadira al-Khalid';
const ref = (id: string, entry: string, label: string) => ({
  archive: { id, entry },
  label,
  interpretation: `What ${label} establishes.`,
});
const pngs = async (names: readonly string[]) =>
  zip(await Promise.all(names.map(async (name) => ({ name, data: await tinyImage('png') }))));
const job = (id: string) => w.stack.runtime.engine.queries.getJob(PROJECT, id)!;
const uploads = (op: string) => w.lkUploads.filter((u) => (u as { op: string }).op === op).length;

async function approveOnly(proposalId: string): Promise<string> {
  const policy = w.stack.runtime.policy;
  if (policy.proposals.get(proposalId)!.requiresCanonicalApproval)
    await policy.commands.approveAsCanon('owner', proposalId);
  else await policy.commands.approve('owner', proposalId);
  let jobId: string | null = null;
  await until(() => (jobId = w.stack.runtime.policy.proposals.get(proposalId)?.jobId ?? null) !== null);
  return jobId!;
}

describe('A6: archives end to end', () => {
  it('upload_image_archive (with character), one groups call by entries, one proposal; a held entry makes the job wait', async () => {
    const images = w.stack.runtime.images;
    // Two entries staged now, then no room: the third and fourth are held.
    const first = await uploadZip(w, w.call, await pngs(['portrait.png', 'Gala/front.png']), {
      stageAll: true,
      character: CHAR,
    });
    await drain(w);
    const settings = images.settings.images as { stagedMaxBytes: number };
    const cap = settings.stagedMaxBytes;
    settings.stagedMaxBytes = images.stagingRoom().used;
    try {
      const second = await uploadZip(w, w.call, await pngs(['Gala/back.png', 'Hunt/front.png']), {
        character: CHAR,
      });
      const a = await w.call('arkona_add_character_art', {
        character: CHAR,
        project: 'test',
        groups: [
          { images: [ref(first.body.archive_id, 'portrait.png', 'Primary Reference - Portrait')] },
          {
            outfit: 'Gala Gown',
            images: [
              ref(first.body.archive_id, 'Gala/front.png', 'Outfit Reference - Front'),
              ref(second.body.archive_id, 'Gala/back.png', 'Outfit Reference - Back'),
            ],
          },
          {
            outfit: 'Hunting Garb',
            images: [ref(second.body.archive_id, 'Hunt/front.png', 'Outfit Reference - Front')],
          },
        ],
      });
      expect(a.body.status, a.text).toBe('proposal_captured');
      expect(JSON.stringify(a.body)).toMatch(/waiting_staging/);
      const jobId = await approveOnly(String(a.body.proposalId));
      await until(() => job(jobId).waitReason?.held === 'waiting_staging');
      settings.stagedMaxBytes = cap;
      images.archives.kick();
      await until(() => ['succeeded', 'failed'].includes(job(jobId).status), 20_000);
      expect(job(jobId).status, JSON.stringify(job(jobId).lastError)).toBe('succeeded');
      expect((job(jobId).result as { verified?: boolean }).verified, JSON.stringify(job(jobId).result)).toBe(
        true,
      );
      const page = pageNamed(w, `[BSRC] ${CHAR} - Character Art`)!;
      expect(headingsOf(w, page.id)).toEqual(expect.arrayContaining(['3:Gala Gown', '3:Hunting Garb']));
      const gala = w.assets.byName('Gala Gown').find((x) => x.type === 'FOLDER')!;
      expect(w.assets.byName(`${CHAR} - Gala Gown - Outfit Reference - Back`)[0]!.folderId).toBe(gala.id);
    } finally {
      settings.stagedMaxBytes = cap;
    }
  });
});

describe('A5: a long rate wait parks the job; it resumes without uploading again', () => {
  it(
    'a 429 with a long Retry-After on an upload: waiting_budget, then resumed; every image uploaded once',
    { timeout: 90_000 },
    async () => {
      const retry = w.stack.runtime.projects.client(PROJECT)!.governor.settings.retry as {
        maxShortWaitMs: number;
      };
      const short = retry.maxShortWaitMs;
      retry.maxShortWaitMs = 200;
      const r = await uploadZip(w, w.call, await pngs(['w1.png', 'w2.png', 'w3.png']), { stageAll: true });
      await drain(w);
      const p = await w.call('arkona_add_character_art', {
        character: CHAR,
        project: 'test',
        groups: [
          { images: [ref(r.body.archive_id, 'w1.png', 'Primary Reference - Wait One')] },
          {
            outfit: 'Rain Cloak',
            images: [
              ref(r.body.archive_id, 'w2.png', 'Outfit Reference - Front'),
              ref(r.body.archive_id, 'w3.png', 'Outfit Reference - Back'),
            ],
          },
        ],
      });
      expect(p.body.status, p.text).toBe('proposal_captured');
      const before = { asset: uploads('createImageAsset'), puts: w.puts.size };
      const re = [...w.overrides.keys()].find((k) => k.source === '\\/assets\\/uploads$')!;
      const base = w.overrides.get(re)!;
      let calls = 0;
      w.overrides.set(re, (req: MockRequest): MockResponse | undefined => {
        if (req.method !== 'POST') return base(req);
        calls++;
        if (calls === 2)
          return {
            status: 429,
            body: { code: 'UPLOAD_RATE_EXCEEDED', message: 'Too many uploads', requestId: 'r-429' },
            headers: {
              'retry-after': '1',
              'x-ratelimit-limit': '20',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1),
            },
          };
        return base(req);
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
        expect(uploads('createImageAsset') - before.asset).toBe(3);
        expect(w.puts.size - before.puts).toBe(3);
        expect(calls).toBe(4);
        // Nothing was withdrawn: a rate wait is never a failure.
        expect((job(jobId).result as { withdrawn?: unknown }).withdrawn).toBeUndefined();
      } finally {
        w.overrides.set(re, base);
        retry.maxShortWaitMs = short;
      }
    },
  );
});
