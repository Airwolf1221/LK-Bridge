/**
 * CR2 images, attacks F1 to F4 (ADR 0055 decision B5: the image revert's re-stage).
 *
 * - F1: two reverts of one placement at once (a double click, two tabs). `RevertService.eligibility` reads
 *   `job_reverts` (src/review/revert.ts) and the row is only inserted after the live reads, the file copy and the
 *   submit, so both pass: two revert jobs, two re-stages and TWO deletions of the same asset. Safe: the second is
 *   refused (REVERT_RUNNING) and the placed asset is deleted once (v3 F12, ADR 0081: by one job, not a proposal).
 * - F2: the asset host now serves a different file for the placed asset: the copy must be refused (IMAGE_NOT_SAVED),
 *   nothing staged, nothing written, nothing proposed.
 * - F3: the placed asset's URL (as LegendKeeper answers getAsset) is not on an asset host, or redirects to a private
 *   address: refused, and the bridge never asks that host.
 * - F4: the revert of a placement never writes to LegendKeeper's staging folder; its only write is the placed asset's
 *   deletion (v3 F12: one job after the revert job, its bytes kept first).
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const writesSince = (world: ImagesWorld, n: number) =>
  world.stack.mock.calls.slice(n).filter((c) => c.method !== 'GET' && c.method !== 'HEAD');

async function placeOne(world: ImagesWorld) {
  const c = await world.stack.connect();
  const call = (args: Record<string, unknown>) =>
    world.stack.call(c, 'upload_image', { project: 'test', ...args });
  const staged = await call({
    data_base64: fixture('alpha.png').toString('base64'),
    name: 'Draft',
    stage: true,
    destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
  });
  expect(staged.body.status, staged.text).toBe('staged');
  const stagedId = String(staged.body.staged_id);
  const placed = await call({ staged_id: stagedId });
  expect(placed.body.status, placed.text).toBe('placed');
  const row = world.stack.runtime.images.staged(PROJECT, stagedId)!;
  await world.stack.runtime.engine.wait(PROJECT, row.placementJobId!, 25_000);
  return { stagedId, assetId: row.assetId!, jobId: row.placementJobId! };
}

/** The placed asset's deletions sent to LegendKeeper since call `n`. */
const deletions = (world: ImagesWorld, assetId: string, n = 0) =>
  writesSince(world, n).filter((c) => c.method === 'DELETE' && c.path.includes(`/assets/${assetId}`));
/** The deletion jobs the revert's follow-ups started for the asset (from the `job.revert` audit). */
const deletionJobs = (world: ImagesWorld, jobId: string) =>
  world.stack.runtime.policy.store
    .listAudit({ action: 'job.revert', limit: 50 })
    .filter((x) => x.target === jobId && (x.after as { outcome?: string } | null)?.outcome === 'images')
    .flatMap((x) => (x.after as { images?: { deletionJobId: string | null }[] }).images ?? [])
    .map((im) => im.deletionJobId)
    .filter((id): id is string => typeof id === 'string');

describe('F1: two reverts of one image placement at once', () => {
  it('the second is refused (REVERT_RUNNING); ONE revert job and ONE deletion of the placed asset', async () => {
    w = await imagesWorld();
    const { assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    const before = w.stack.mock.calls.length;
    const [r1, r2] = await Promise.all([
      rt.reverts.revert('owner', PROJECT, jobId),
      rt.reverts.revert('owner', PROJECT, jobId),
    ]);
    const statuses = [r1, r2].map((r) => (r.status === 'refused' ? r.code : r.status));
    for (const r of [r1, r2])
      if (r.status === 'submitted') await rt.engine.wait(PROJECT, r.revertJobId, 25_000);
    // Let the follow-ups (re-stage, the deletion job) run.
    for (let i = 0; i < 200 && deletionJobs(w, jobId).length === 0; i++) await sleep(20);
    for (const id of deletionJobs(w, jobId)) await rt.engine.wait(PROJECT, id, 25_000);
    await sleep(100); // a second follow-up, if any, would have started by now
    const rows = w.stack.db
      .prepare('SELECT revert_job_id, state FROM job_reverts WHERE job_id = ?')
      .all(jobId) as { revert_job_id: string; state: string }[];
    const detail = JSON.stringify({
      statuses,
      rows,
      deletionJobs: deletionJobs(w, jobId),
      deletions: deletions(w, assetId, before).length,
    });
    expect(statuses.sort(), detail).toEqual(['REVERT_RUNNING', 'submitted']);
    expect(rows, detail).toHaveLength(1);
    expect(deletionJobs(w, jobId), detail).toHaveLength(1);
    expect(deletions(w, assetId, before), detail).toHaveLength(1);
  });
});

describe('F2: the placed asset now serves another file', () => {
  it('refused (IMAGE_NOT_SAVED): nothing staged, written or proposed; the record is untouched', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    const other = fixture('already.webp');
    w.served.set(assetId, other);
    const before = w.stack.mock.calls.length;
    const pending = rt.policy.proposals.list({ project: PROJECT, state: 'pending' }).length;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r).toMatchObject({ status: 'refused', code: 'IMAGE_NOT_SAVED' });
    expect(writesSince(w, before)).toEqual([]);
    expect(rt.policy.proposals.list({ project: PROJECT, state: 'pending' })).toHaveLength(pending);
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: false, assetId });
    expect(await rt.images.stagedBytes.has(sha(other)), 'the other file was not kept').toBe(false);
  });
});

describe('F3: the placed asset’s URL is not on an asset host', () => {
  it('a URL on another host is refused without asking it; a redirect to a private address too', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    // LegendKeeper answers getAsset with a URL the bridge does not download from (the storage host of the PUT).
    const before = w.puts.size;
    w.assets.assets.get(assetId)!.url = `https://storage.test:${w.port}/put/stolen`;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r).toMatchObject({ status: 'refused', code: 'IMAGE_NOT_SAVED' });
    expect(w.puts.size).toBe(before);
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: false, assetId });
    // An asset-host URL that redirects to the cloud metadata address.
    w.assets.assets.get(assetId)!.url = `https://assets.test:${w.port}/f/meta`;
    w.files.set('meta', { status: 302, location: 'https://169.254.169.254/latest/meta-data/' });
    const r2 = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r2).toMatchObject({ status: 'refused', code: 'IMAGE_NOT_SAVED' });
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: false, assetId });
  });
});

describe('F4: nothing written to the staging folder; the placed asset deleted by one job after the revert', () => {
  it('a placement whose record says it came from a folder named like the staging folder is not moved back there', async () => {
    w = await imagesWorld();
    const { stagedId, assetId, jobId } = await placeOne(w);
    const rt = w.stack.runtime;
    const before = w.stack.mock.calls.length;
    const r = await rt.reverts.revert('owner', PROJECT, jobId);
    expect(r.status).toBe('submitted');
    if (r.status !== 'submitted') return;
    await rt.engine.wait(PROJECT, r.revertJobId, 25_000);
    for (let i = 0; i < 200 && deletionJobs(w, jobId).length === 0; i++) await sleep(20);
    for (const id of deletionJobs(w, jobId)) await rt.engine.wait(PROJECT, id, 25_000);
    // The one write: the placed asset's deletion. Nothing moved, hidden or put into a staging folder.
    const world = w;
    expect(writesSince(world, before).filter((c) => !deletions(world, assetId, before).includes(c))).toEqual(
      [],
    );
    expect(deletions(w, assetId, before)).toHaveLength(1);
    expect(w.assets.assets.has(assetId)).toBe(false);
    expect(
      [...w.assets.assets.values()].filter((a) => a.type === 'FOLDER' && a.name === 'LK-Bridge staging'),
    ).toEqual([]);
    expect(rt.images.staged(PROJECT, stagedId)).toMatchObject({ staged: true, assetId: null });
  });
});

describe('F5: the staging folder as the asset tree does not (yet) know it', () => {
  it.each([
    ['the asset tree has refreshed since the folder was made (control)', true],
    ['the folder is newer than the asset tree’s last pass', false],
  ])(
    '%s: a revert of a move OUT of “LK-Bridge staging” never moves the asset back into it',
    async (_what, refreshed) => {
      w = await imagesWorld();
      const rt = w.stack.runtime;
      // The old staging folder with a hidden image in it, made in the app (or before the asset tree's last pass).
      const staging = w.assets.folder('LK-Bridge staging');
      const hidden = w.assets.image('Leftover draft', staging, { isHidden: true });
      const target = w.assets.at('Characters', 'Humans');
      if (refreshed) await rt.assets.refresh(PROJECT, 'test');
      // An agent at scope write moves it out and unhides it (a raw write: no staged record behind it).
      const c = await w.stack.connect();
      const moved = await w.stack.call(c, 'lk_api_write', {
        project: 'test',
        operationId: 'updateAsset',
        params: { path: { assetId: hidden }, body: { folderId: target, isHidden: false } },
      });
      expect(moved.isError, moved.text).toBe(false);
      const jobId = String(moved.body.jobId ?? (moved.body.job as { id?: string } | undefined)?.id ?? '');
      expect(jobId, moved.text).not.toBe('');
      await rt.engine.wait(PROJECT, jobId, 20_000);
      expect(w.assets.assets.get(hidden)!.folderId).toBe(target);
      // The owner reverts that job.
      const r = await rt.reverts.revert('owner', PROJECT, jobId);
      if (r.status === 'submitted') await rt.engine.wait(PROJECT, r.revertJobId, 25_000);
      // Safe: refused (or left alone): nothing is put back into the staging folder.
      const now = w.assets.assets.get(hidden)!;
      expect(
        { folder: now.folderId === staging ? 'LK-Bridge staging' : 'elsewhere', hidden: now.isHidden },
        JSON.stringify(r).slice(0, 600),
      ).toMatchObject({ folder: 'elsewhere' });
    },
  );
});
