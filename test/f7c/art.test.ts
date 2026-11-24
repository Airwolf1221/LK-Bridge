/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method -- parsed JSON tool results; the test world's `call` */
/**
 * v3 F7c (ADR 0075, Z4, Z9, Z10): the art tools take archive entries, against the mock LegendKeeper (nothing live):
 * by a staged entry; by a held entry (the job waits, `waiting_staging`, then runs); a refused entry left out (the others
 * go ahead), and an entry discarded while its job waits (only that image withdrawn); one archive feeding several calls
 * and one call drawing from two archives; one archive across three outfits; an entry from one folder placed under a
 * different outfit. Z9: list-only, only the used entries converted, the same zip twice, failures and retries, the
 * conversion limit. Z10: the owner's example layout, folders and outfit hints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImageError } from '../../src/images/convert.js';
import type { ConvertedImage } from '../../src/images/convert.js';
import { ownersWorld, PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { approve } from '../packs/world.js';
import { chatgptFile, drain, row, until, uploadZip } from './helpers.js';
import { REI_LAYOUT, reiZip, tinyImage, zip } from './zip.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const CHAR = 'Nadira al-Khalid';
const svc = () => w.stack.runtime.images;
const archives = () => svc().archives;
const art = (args: Record<string, unknown>) =>
  w.call('arkona_add_character_art', { character: CHAR, project: 'test', ...args });
const ref = (id: string, entry: string, label: string) => ({
  archive: { id, entry },
  label,
  interpretation: `What ${label} establishes.`,
});
const pngs = async (names: readonly string[]) =>
  zip(await Promise.all(names.map(async (name) => ({ name, data: await tinyImage('png') }))));
const asset = (name: string) => w.assets.byName(name)[0];
const status = (archiveId: string, path: string) =>
  archives()
    .store.entries(archiveId)
    .find((e) => e.path === path)!.status;

/** Approves without waiting for the job to finish (it may wait for its entries). */
async function approveOnly(proposalId: string): Promise<string> {
  const policy = w.stack.runtime.policy;
  if (policy.proposals.get(proposalId)!.requiresCanonicalApproval)
    await policy.commands.approveAsCanon('owner', proposalId);
  else await policy.commands.approve('owner', proposalId);
  let jobId: string | null = null;
  await until(() => (jobId = w.stack.runtime.policy.proposals.get(proposalId)?.jobId ?? null) !== null);
  return jobId!;
}
const job = (id: string) => w.stack.runtime.engine.queries.getJob(PROJECT, id)!;

describe('Z9: list first, convert when used', () => {
  it('a list-only upload converts nothing and counts against no limit', async () => {
    const before = svc().stagingRoom().used;
    const r = await uploadZip(w, w.call, await pngs(['a.png', 'b.png', 'c.png']));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.rows.map((x: { status: string }) => x.status)).toEqual(['listed', 'listed', 'listed']);
    for (const x of r.body.rows) expect(x.sha256).toMatch(/^[0-9a-f]{64}$/);
    await drain(w);
    expect(svc().stagingRoom().used).toBe(before);
    expect(r.body.guidance.join(' ')).toMatch(/look at the images/i);
    expect(r.body.limits.holding.setting).toBe('IMAGE_STAGED_MAX_BYTES');
    expect(r.body.limits.processing.setting).toBe('IMAGE_CONVERT_CONCURRENCY');
    expect(r.body.limits.brake.setting).toBe('IMAGE_UPLOAD_RATE_PER_PRINCIPAL');
  });

  it('the same zip uploaded twice is the same archive and entries; nothing is staged twice', async () => {
    const bytes = await pngs(['x1.png', 'x2.png']);
    const a = await uploadZip(w, w.call, bytes, { stageAll: true });
    await drain(w);
    const staged = svc().listStaged(PROJECT).length;
    const b = await uploadZip(w, w.call, bytes, { stageAll: true });
    expect(b.isError, b.text).toBe(false);
    expect(b.body.archive_id).toBe(a.body.archive_id);
    expect(b.body.repeat).toBe(true);
    expect(row(b.body, 'x1.png').staged_id).toBe(archives().store.entries(a.body.archive_id)[0]!.stagedId);
    await drain(w);
    expect(svc().listStaged(PROJECT).length).toBe(staged);
  });

  it('an entry whose bytes are already staged reuses that staged image', async () => {
    const img = await tinyImage('png');
    const first = await uploadZip(w, w.call, zip([{ name: 'one.png', data: img }]), { stageAll: true });
    await drain(w);
    const id = archives().store.entries(first.body.archive_id)[0]!.stagedId;
    const second = await uploadZip(
      w,
      w.call,
      zip([
        { name: 'again.png', data: img },
        { name: 'z.txt', data: Buffer.from('x') },
      ]),
    );
    expect(row(second.body, 'again.png')).toMatchObject({ status: 'staged', staged_id: id });
  });

  it('operation_id works: a repeat gives the first answer', async () => {
    // The same attachment twice (ChatGPT gives it the same file_id; its link may change).
    const file = chatgptFile(w, await pngs(['op.png']));
    const args = { file, operation_id: 'f7c-op-1', project: 'test' };
    const a = await w.call('upload_image_archive', args);
    const b = await w.call('upload_image_archive', args);
    expect(b.isError, b.text).toBe(false);
    expect(b.body.archive_id).toBe(a.body.archive_id);
    expect(b.body.repeated).toBe(true);
  });

  it('an entry that fails is kept apart: one automatic retry, then a manual retry; nothing staged is redone', async () => {
    const r = await uploadZip(w, w.call, await pngs(['ok1.png', 'bad.png', 'ok2.png']));
    const bad = archives()
      .store.entries(r.body.archive_id)
      .find((e) => e.path === 'bad.png')!;
    const original = svc().convert.bind(svc());
    let failures = 0;
    svc().convert = async (bytes: Uint8Array): Promise<ConvertedImage> => {
      const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
      if (sha === bad.sha256 && failures < 2) {
        failures++;
        throw new ImageError('IMAGE_CONVERT_TIMEOUT', 'the conversion took too long');
      }
      return original(bytes);
    };
    try {
      archives().request(r.body.archive_id, 'all');
      await drain(w);
      expect(failures).toBe(2); // the first try and the one automatic retry
      expect(status(r.body.archive_id, 'bad.png')).toBe('failed');
      expect(status(r.body.archive_id, 'ok1.png')).toBe('staged');
      expect(status(r.body.archive_id, 'ok2.png')).toBe('staged');
      const okIds = archives()
        .store.entries(r.body.archive_id)
        .filter((e) => e.status === 'staged')
        .map((e) => e.stagedId);
      const s = await w.call('bridge_archive_status', { archive_id: r.body.archive_id, project: 'test' });
      expect(row(s.body, 'bad.png').reason).toMatch(/^IMAGE_CONVERT_TIMEOUT/);
      const retried = await w.call('bridge_archive_status', {
        archive_id: r.body.archive_id,
        retry: ['bad.png', 'ok1.png'],
        project: 'test',
      });
      expect(retried.body.retried).toEqual([
        { entry: 'bad.png', outcome: 'queued' },
        { entry: 'ok1.png', outcome: 'not_failed', status: 'staged' },
      ]);
      await drain(w);
      expect(status(r.body.archive_id, 'bad.png')).toBe('staged');
      expect(
        archives()
          .store.entries(r.body.archive_id)
          .filter((e) => e.path !== 'bad.png')
          .map((e) => e.stagedId),
      ).toEqual(okIds);
    } finally {
      svc().convert = original;
    }
  });

  it('conversions never exceed IMAGE_CONVERT_CONCURRENCY (no second pool)', async () => {
    const r = await uploadZip(w, w.call, await pngs(Array.from({ length: 12 }, (_, i) => `c${i}.png`)), {
      stageAll: true,
    });
    let max = 0;
    const timer = setInterval(() => (max = Math.max(max, svc().queue.load.running)), 1);
    try {
      await drain(w);
    } finally {
      clearInterval(timer);
    }
    expect(
      archives()
        .store.entries(r.body.archive_id)
        .every((e) => e.status === 'staged'),
    ).toBe(true);
    expect(max).toBeLessThanOrEqual(svc().settings.images.convertConcurrency);
  });
});

describe('Z4: the art tools take archive entries', () => {
  it('a staged entry is used exactly like its staged_id; one archive feeds two calls', async () => {
    const r = await uploadZip(w, w.call, await pngs(['p1.png', 'p2.png', 'p3.png']), { stageAll: true });
    await drain(w);
    const a = await art({
      images: [ref(r.body.archive_id, 'p1.png', 'Primary Reference - Archive Portrait')],
    });
    expect(a.body.status, a.text).toBe('proposal_captured');
    const done = await approve(w, String(a.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(asset(`${CHAR} - Primary Reference - Archive Portrait`)).toBeDefined();
    const b = await art({
      outfit: 'Archive Robe',
      images: [
        ref(r.body.archive_id, 'p2.png', 'Outfit Reference - Front'),
        ref(r.body.archive_id, 'p3.png', 'Outfit Reference - Back'),
      ],
    });
    expect(b.body.status, b.text).toBe('proposal_captured');
    expect((await approve(w, String(b.body.proposalId))).job?.status).toBe('succeeded');
    expect(asset(`${CHAR} - Archive Robe - Outfit Reference - Front`)).toBeDefined();
    // The staged images were placed: the entries' images are no longer staged.
    for (const e of archives().store.entries(r.body.archive_id))
      expect(svc().store.upload(PROJECT, e.stagedId!)!.staged).toBe(false);
  });

  it('a held entry: planned from its header, the job waits (waiting_staging), then runs once it is staged', async () => {
    const settings = svc().settings.images as { stagedMaxBytes: number };
    const cap = settings.stagedMaxBytes;
    settings.stagedMaxBytes = svc().stagingRoom().used; // no room at all
    try {
      const r = await uploadZip(w, w.call, await pngs(['held1.png', 'held2.png']));
      const a = await art({
        images: [
          ref(r.body.archive_id, 'held1.png', 'Primary Reference - Held One'),
          ref(r.body.archive_id, 'held2.png', 'Primary Reference - Held Two'),
        ],
      });
      expect(a.body.status, a.text).toBe('proposal_captured');
      expect(JSON.stringify(a.body)).toMatch(/waiting_staging/);
      await drain(w);
      expect(status(r.body.archive_id, 'held1.png')).toBe('held');
      // Held entries are pinned while the proposal waits: the expiry passes them by.
      expect(archives().referenced(r.body.archive_id)).toBe(true);
      const jobId = await approveOnly(String(a.body.proposalId));
      await until(() => job(jobId).waitReason?.held === 'waiting_staging');
      expect(job(jobId).status).toBe('queued');
      expect(String(job(jobId).waitReason?.message)).toMatch(/staging space/);
      const st = await w.call('bridge_job_status', { jobId, project: 'test' });
      expect(st.text).toMatch(/waiting_staging/);
      // Space frees: the worker stages both, and the job runs.
      settings.stagedMaxBytes = cap;
      archives().kick();
      await until(() => ['succeeded', 'failed'].includes(job(jobId).status), 20_000);
      expect(job(jobId).status, JSON.stringify(job(jobId).lastError)).toBe('succeeded');
      expect(asset(`${CHAR} - Primary Reference - Held One`)).toBeDefined();
      expect(asset(`${CHAR} - Primary Reference - Held Two`)).toBeDefined();
      const e = archives().store.entries(r.body.archive_id)[0]!;
      expect(svc().store.upload(PROJECT, e.stagedId!)!.placementJobId).toBe(jobId);
    } finally {
      settings.stagedMaxBytes = cap;
    }
  });

  it('a refused entry is left out with its reason; the other images go ahead', async () => {
    const r = await uploadZip(
      w,
      w.call,
      zip([
        { name: 'good.png', data: await tinyImage('png') },
        { name: 'readme.png', data: Buffer.from('not an image') },
      ]),
      { stageAll: true },
    );
    await drain(w);
    const a = await art({
      images: [
        ref(r.body.archive_id, 'good.png', 'Primary Reference - Good One'),
        ref(r.body.archive_id, 'readme.png', 'Primary Reference - Readme'),
      ],
    });
    expect(a.body.status, a.text).toBe('proposal_captured');
    expect(JSON.stringify(a.body)).toMatch(/ARCHIVE_ENTRY_REFUSED/);
    expect((await approve(w, String(a.body.proposalId))).job?.status).toBe('succeeded');
    expect(asset(`${CHAR} - Primary Reference - Good One`)).toBeDefined();
    expect(asset(`${CHAR} - Primary Reference - Readme`)).toBeUndefined();
  });

  it('an entry discarded while its job waits: only that image is withdrawn, the others placed', async () => {
    const staged = await uploadZip(w, w.call, await pngs(['keep.png']), { stageAll: true });
    await drain(w);
    const settings = svc().settings.images as { stagedMaxBytes: number };
    const cap = settings.stagedMaxBytes;
    settings.stagedMaxBytes = svc().stagingRoom().used;
    try {
      const held = await uploadZip(w, w.call, await pngs(['gone.png']));
      const a = await art({
        images: [
          ref(staged.body.archive_id, 'keep.png', 'Primary Reference - Kept'),
          ref(held.body.archive_id, 'gone.png', 'Primary Reference - Withdrawn'),
        ],
      });
      expect(a.body.status, a.text).toBe('proposal_captured');
      const jobId = await approveOnly(String(a.body.proposalId));
      await until(() => job(jobId).waitReason?.held === 'waiting_staging');
      await archives().discard(held.body.archive_id, 'owner');
      await until(() => ['succeeded', 'failed'].includes(job(jobId).status), 20_000);
      expect(job(jobId).status, JSON.stringify(job(jobId).lastError)).toBe('succeeded');
      expect(asset(`${CHAR} - Primary Reference - Kept`)).toBeDefined();
      expect(asset(`${CHAR} - Primary Reference - Withdrawn`)).toBeUndefined();
      const steps = w.stack.runtime.engine.stepResults(PROJECT, jobId) ?? [];
      expect(JSON.stringify(steps)).toMatch(/withdrawn/);
      // The Art page shows the kept image and nothing of the withdrawn one.
      const page = [...w.repo.res.values()].find(
        (x) => x.deletedAt === null && x.name === `[BSRC] ${CHAR} - Character Art`,
      )!;
      const main = w.repo.liveDocs(w.repo.res.get(page.id)!).find((d) => d.name === 'Main')!;
      const text = JSON.stringify(w.repo.blocks.get(main.id)!.blocks);
      expect(text).toContain('Primary Reference - Kept');
      expect(text).not.toContain('Primary Reference - Withdrawn');
    } finally {
      settings.stagedMaxBytes = cap;
    }
  });

  it('one outfit assembled from entries of two archives', async () => {
    const a1 = await uploadZip(w, w.call, await pngs(['Gala/front.png']), { stageAll: true });
    const a2 = await uploadZip(w, w.call, await pngs(['more/back.png', 'more/side.png']));
    await drain(w);
    const p = await art({
      outfit: 'Gala Gown',
      images: [
        ref(a1.body.archive_id, 'front.png', 'Outfit Reference - Gala Front'),
        ref(a2.body.archive_id, 'back.png', 'Outfit Reference - Gala Back'),
        ref(a2.body.archive_id, 'more/side.png', 'Outfit Reference - Gala Side'),
      ],
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const rec = w.stack.runtime.outfits
      .forCharacter(PROJECT, w.assets.byName(CHAR).find((x) => x.type === 'FOLDER')!.id)
      .find((o) => o.name === 'Gala Gown')!;
    expect(rec.pieces).toHaveLength(3);
  });

  it('one archive across three outfits, and an entry from one folder placed under a different outfit', async () => {
    const r = await uploadZip(
      w,
      w.call,
      await pngs([
        'Wedding Dress/w1.png',
        'Wedding Dress/w2.png',
        'Imperial Regalia/r1.png',
        'Lingerie/l1.png',
      ]),
    );
    expect(row(r.body, 'w1.png').suggestedOutfit).toBe('Wedding Dress');
    const calls: [string, string[]][] = [
      ['Bridal Silk', ['w1.png']],
      // w2 sits in "Wedding Dress/" but the agent decides it belongs to the regalia: the folder is only a suggestion.
      ['Court Regalia', ['r1.png', 'w2.png']],
      ['Night Lace', ['l1.png']],
    ];
    for (const [outfit, entries] of calls) {
      const p = await art({
        outfit,
        images: entries.map((e, i) => ref(r.body.archive_id, e, `Outfit Reference - ${outfit} ${i + 1}`)),
      });
      expect(p.body.status, p.text).toBe('proposal_captured');
      const jobId = await approveOnly(String(p.body.proposalId));
      await until(() => ['succeeded', 'failed'].includes(job(jobId).status), 20_000);
      expect(job(jobId).status, JSON.stringify(job(jobId).lastError)).toBe('succeeded');
    }
    expect(asset(`${CHAR} - Court Regalia - Outfit Reference - Court Regalia 2`)).toBeDefined();
    expect(asset(`${CHAR} - Night Lace - Outfit Reference - Night Lace 1`)).toBeDefined();
  });
});

describe('Z10: folder layout as hints', () => {
  it('the owner’s example layout: rows carry folder and suggestedOutfit; top-level rows have neither guess', async () => {
    const r = await uploadZip(w, w.call, await reiZip());
    expect(r.isError, r.text).toBe(false);
    const total = Object.values(REI_LAYOUT).reduce((n, x) => n + x.length, 0);
    expect(r.body.entries).toBe(total);
    expect(r.body.rows.filter((x: { folder: string | null }) => x.folder === null)).toHaveLength(13);
    expect(row(r.body, 'Rei - Portrait.webp')).toMatchObject({ folder: null, suggestedOutfit: null });
    expect(row(r.body, 'Rei - Portrait.webp')).not.toHaveProperty('outfitMatch');
    expect(row(r.body, 'Rei - Consort-Maid 1.webp')).toMatchObject({
      folder: 'Consort-Maid',
      suggestedOutfit: 'Consort Maid',
      format: 'webp',
    });
    expect(row(r.body, 'Rei - Lingerie.webp')).toMatchObject({
      folder: 'Lingerie',
      suggestedOutfit: 'Lingerie',
    });
    const counts: Record<string, number> = {};
    for (const x of r.body.rows as { folder: string | null }[])
      if (x.folder) counts[x.folder] = (counts[x.folder] ?? 0) + 1;
    expect(counts).toEqual({ 'Consort-Maid': 11, 'Imperial Regalia': 10, Lingerie: 3, 'Wedding Dress': 9 });
  });

  it('with character: each folder is exact, near (with candidates) or new; a character that does not resolve is reported', async () => {
    const folder = w.assets.byName(CHAR).find((x) => x.type === 'FOLDER')!;
    const outfits = w.stack.runtime.outfits;
    for (const name of ['Lingerie', 'Supreme Imperial Regalia'])
      outfits.recordPlacement({
        projectId: PROJECT,
        characterFolderId: folder.id,
        characterName: CHAR,
        outfit: name,
        folderId: null,
        pieces: [],
        by: 'owner',
      });
    const r = await uploadZip(w, w.call, await reiZip(), { character: CHAR });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.character).toMatchObject({ resolved: true, name: CHAR });
    expect(row(r.body, 'Rei - Lingerie 1.webp')).toMatchObject({ outfitMatch: 'exact', outfit: 'Lingerie' });
    const near = row(r.body, 'Rei - Imperial Regalia 1.webp');
    expect(near.outfitMatch).toBe('near');
    expect(near.candidates.map((c: { name: string }) => c.name)).toContain('Supreme Imperial Regalia');
    expect(row(r.body, 'Rei - Wedding Dress 1.webp').outfitMatch).toBe('new');
    expect(row(r.body, 'Rei - Portrait.webp')).not.toHaveProperty('outfitMatch');
    const none = await uploadZip(w, w.call, await reiZip(), { character: 'Nobody At All' });
    expect(none.isError, none.text).toBe(false);
    expect(none.body.character).toMatchObject({ resolved: false, given: 'Nobody At All' });
  });

  it('bridge_archive_status without archive_id lists this connection’s recent archives', async () => {
    const s = await w.call('bridge_archive_status', { project: 'test' });
    expect(s.isError, s.text).toBe(false);
    expect(s.body.archives.length).toBeGreaterThan(0);
    expect(s.body.archives[0]).not.toHaveProperty('rows');
  });
});
