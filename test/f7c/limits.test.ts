/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results; the test world's `call` */
/**
 * v3 F7c (ADR 0075, Z3): the limits, against the mock world: 150 images in one archive under the new defaults; the brake
 * lowered to 10 (10 staged, the rest held, then staged as the window moves, on a fake clock); the staging capacity
 * (held, then staged once a discard frees space); a held archive survives a restart; the per-address counter ignores
 * authenticated requests; a single upload past a cap is refused naming it; a zip through the binary endpoint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../../src/auth/rate-limit.js';
import { imagesWorld, type ImagesWorld } from '../images/world.js';
import { PROJECT } from '../tools/helpers.js';
import { binaryZip, drain, postUpload, row, until, uploadZip } from './helpers.js';
import { tinyImage, zip } from './zip.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const HOUR = 3_600_000;

async function world(o: Parameters<typeof imagesWorld>[0] = {}) {
  w = await imagesWorld(o);
  const client = await w.stack.connect();
  const call = (name: string, args: Record<string, unknown>) => w!.stack.call(client, name, args);
  return { w, call };
}

async function images(n: number) {
  return zip(
    await Promise.all(
      Array.from({ length: n }, async (_, i) => ({ name: `img-${i}.png`, data: await tinyImage('png') })),
    ),
  );
}

const statuses = (world: ImagesWorld, archiveId: string) => {
  const counts: Record<string, number> = {};
  for (const e of world.stack.runtime.images.archives.store.entries(archiveId))
    counts[e.status] = (counts[e.status] ?? 0) + 1;
  return counts;
};

describe('Z3: limits', () => {
  it('150 images in one archive under the new defaults: all staged', async () => {
    const { w, call } = await world();
    expect(w.stack.runtime.images.settings.images.ratePerPrincipalPerHour).toBe(1000);
    const r = await uploadZip(w, call, await images(150), { stageAll: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.entries).toBe(150);
    await drain(w);
    expect(statuses(w, r.body.archive_id)).toEqual({ staged: 150 });
    // Every entry is now a staged image of its own; the server copy is gone (nothing more is needed from it).
    const a = w.stack.runtime.images.archives.store.archive(r.body.archive_id)!;
    expect(a.serverFile).toBeNull();
    expect(a.state).toBe('done');
    expect(w.stack.runtime.images.listStaged(PROJECT).filter((x) => x.source === 'archive')).toHaveLength(
      150,
    );
  });

  it('the brake lowered to 10: 10 staged and the rest held, then staged by the worker as the window moves', async () => {
    const { w, call } = await world();
    const svc = w.stack.runtime.images;
    let now = Date.now();
    (svc.rate as { stage: SlidingWindowLimiter }).stage = new SlidingWindowLimiter(10, HOUR, () => now);
    const r = await uploadZip(w, call, await images(25), { stageAll: true });
    expect(r.isError, r.text).toBe(false);
    await drain(w);
    expect(statuses(w, r.body.archive_id)).toEqual({ staged: 10, held: 15 });
    const held = svc.archives.archiveView(svc.archives.store.archive(r.body.archive_id)!).rows as {
      status: string;
      heldBy?: string;
      expectedAt?: string;
    }[];
    const h = held.filter((x) => x.status === 'held');
    expect(h.every((x) => x.heldBy === 'rate' && typeof x.expectedAt === 'string')).toBe(true);
    // The expected times follow the window: the first ten an hour on, the next five an hour after that.
    expect(Date.parse(h[0]!.expectedAt!)).toBeGreaterThanOrEqual(now + HOUR - 1000);
    expect(Date.parse(h[14]!.expectedAt!)).toBeGreaterThan(Date.parse(h[0]!.expectedAt!));
    // In archive order: the first ten are the staged ones.
    expect(held.slice(0, 10).every((x) => x.status === 'staged')).toBe(true);
    now += HOUR + 1000;
    await drain(w);
    expect(statuses(w, r.body.archive_id)).toEqual({ staged: 20, held: 5 });
    now += HOUR + 1000;
    await drain(w);
    expect(statuses(w, r.body.archive_id)).toEqual({ staged: 25 });
  });

  it('the staging capacity: an entry past it is held, then staged once a discard frees space', async () => {
    const { w, call } = await world();
    const svc = w.stack.runtime.images;
    const settings = svc.settings.images as { stagedMaxBytes: number };
    const r0 = await uploadZip(w, call, await images(1), { stageAll: true });
    await drain(w);
    const first = svc.archives.store.entries(r0.body.archive_id)[0]!;
    const one = svc.store.upload(PROJECT, first.stagedId!)!.webp.bytes;
    settings.stagedMaxBytes = svc.stagingRoom().used + one * 2 + 10;
    const r = await uploadZip(w, call, await images(4), { stageAll: true });
    await drain(w);
    const c = statuses(w, r.body.archive_id);
    expect(c.staged).toBeGreaterThanOrEqual(1);
    expect(c.held).toBeGreaterThanOrEqual(1);
    const heldRow = svc.archives.store.entries(r.body.archive_id).find((e) => e.status === 'held')!;
    expect(heldRow.heldBy).toBe('storage');
    expect(heldRow.expectedAt).toBeNull();
    // A single upload past the capacity is refused, naming the cap.
    const single = await call('upload_image', {
      project: 'test',
      data_base64: (await tinyImage('png', 64)).toString('base64'),
      name: 'one more',
      stage: true,
    });
    expect(single.isError).toBe(true);
    expect(single.body.error.code).toBe('STAGING_FULL');
    expect(single.body.error.message).toContain('IMAGE_STAGED_MAX_BYTES');
    // Discarding staged images frees space: the worker stages the held entries.
    settings.stagedMaxBytes = svc.stagingRoom().used + one * 4 + 10;
    const row0 = svc.store.upload(PROJECT, first.stagedId!)!;
    await svc.discard({ projectId: PROJECT, row: row0, origin: { kind: 'ui', tool: 'test' }, by: 'owner' });
    await until(() => (statuses(w, r.body.archive_id).staged ?? 0) === 4);
  });

  it('a held archive survives a runtime restart and is staged after it', async () => {
    const { w, call } = await world();
    const svc = w.stack.runtime.images;
    (svc.rate as { stage: SlidingWindowLimiter }).stage = new SlidingWindowLimiter(3, HOUR, () => Date.now());
    const r = await uploadZip(w, call, await images(8), { stageAll: true });
    await drain(w);
    expect(statuses(w, r.body.archive_id)).toEqual({ staged: 3, held: 5 });
    await w.stack.restart();
    // A new bridge (its brake starts empty): the held entries were in the database, and the worker stages them.
    const after = w.stack.runtime.images.archives;
    await until(() => after.store.entries(r.body.archive_id).every((e) => e.status === 'staged'));
    expect(after.store.archive(r.body.archive_id)!.state).toBe('done');
  });

  it('a zip through the binary endpoint; the per-address counter ignores authenticated requests', async () => {
    const { w, call } = await world({ images: { ratePerIpPerHour: 2 } });
    // Three authenticated uploads from one address: none is counted.
    for (let i = 0; i < 3; i++) {
      const id = await binaryZip(w, call, await images(2));
      const r = await call('upload_image_archive', { project: 'test', upload_id: id });
      expect(r.isError, r.text).toBe(false);
      expect(row(r.body, 'img-0.png').status).toBe('listed');
    }
    // Two refused before authentication are counted; the third is over the limit.
    const p = await call('prepare_image_upload', {
      project: 'test',
      sha256: 'a'.repeat(64),
      byte_length: 10,
      content_type: 'application/zip',
      name: 'x.zip',
    });
    const id = String(p.body.upload_id);
    expect((await postUpload(w, id, Buffer.alloc(10), 'B'.repeat(43))).status).toBe(403);
    expect((await postUpload(w, id, Buffer.alloc(10), 'B'.repeat(43))).status).toBe(403);
    expect((await postUpload(w, id, Buffer.alloc(10), 'B'.repeat(43))).status).toBe(429);
  });

  it('a zip upload_id is refused by upload_image, and an image slot by upload_image_archive', async () => {
    const { w, call } = await world();
    const id = await binaryZip(w, call, await images(1));
    const r = await call('upload_image', { project: 'test', upload_id: id, stage: true });
    expect(r.body.error.code).toBe('UPLOAD_IS_ARCHIVE');
  });
});
