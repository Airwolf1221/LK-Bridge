/**
 * CR2 images, attacks B10 and B11 (exhausting the disk through server staging).
 *
 * - B10 (clean-up failures): `dropStaged` (src/images/service.ts) first writes the record as discarded with no server
 *   file (`serverSha256: null`), then removes the file. When the removal fails (EIO, EBUSY, EACCES: simulated here by
 *   the store's `remove` throwing once), no record names the file any more and nothing ever looks for it again: no sweep
 *   walks images/staged/ for files no record uses. `settleServerPlacement` drops the copy the same way (`void remove()`).
 *   Safe: the file is removed later (the record keeps naming it until it is gone, or a sweep collects unnamed files).
 * - B11 (many stagings): IMAGE_UPLOAD_RATE_PER_PRINCIPAL limits `prepare_image_upload` and the binary endpoint, but
 *   `upload_image { data_base64 | file | url, stage: true }` stages without any per-connection limit; only the disk floor
 *   (IMAGE_STAGING_MIN_FREE_GB) stops it, and then it stops everyone's staging, the owner's included.
 *   Safe: one connection cannot stage more than its hourly allowance.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_PRINCIPAL } from '../../../src/jobs/index.js';
import { PROJECT } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function call(world: ImagesWorld, args: Record<string, unknown>, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}

describe('B10: a staged file whose removal failed once', () => {
  it('is removed later (a sweep or the next try), not left on disk with no record naming it', async () => {
    w = await imagesWorld();
    const svc = w.stack.runtime.images;
    const r = await call(w, {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'Leaky',
      stage: true,
    });
    const row = svc.store.upload(PROJECT, String(r.body.staged_id))!;
    const sha = row.serverSha256!;
    const file = join(svc.stagedBytes.dir, sha.slice(0, 2), sha);
    expect(existsSync(file)).toBe(true);
    // The disk refuses the removal once (EIO).
    const real = svc.stagedBytes.remove.bind(svc.stagedBytes);
    let failed = false;
    (svc.stagedBytes as { remove(s: string): Promise<void> }).remove = async (s: string) => {
      if (!failed) {
        failed = true;
        throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
      }
      return real(s);
    };
    await svc
      .discard({
        projectId: PROJECT,
        row,
        origin: { kind: 'ui', tool: 'staging.discard', principal: SYSTEM_PRINCIPAL },
        by: 'owner',
      })
      .catch(() => undefined);
    expect(failed).toBe(true);
    // Every clean-up the bridge runs on its own: the minute sweep, the hourly expiry, a start-up.
    await svc.sweep();
    await svc.expireKept();
    await svc.expireStaged([PROJECT]);
    svc.stop();
    svc.start();
    const named = svc.store.serverShaInUse(sha);
    expect({ fileOnDisk: existsSync(file), aRecordNamesIt: named }).toEqual({
      fileOnDisk: false,
      aRecordNamesIt: false,
    });
  });
});

describe('B11: one connection, unlimited stagings', () => {
  it('a connection stages no more images than IMAGE_UPLOAD_RATE_PER_PRINCIPAL allows in an hour', async () => {
    w = await imagesWorld({ images: { ratePerPrincipalPerHour: 3 } });
    const { token } = w.stack.newToken('busy-agent', 'write');
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const png = await sharp({
        create: { width: 16, height: 16, channels: 3, background: { r: i * 40, g: 10, b: 200 - i * 30 } },
      })
        .png()
        .toBuffer();
      const r = await call(w, { data_base64: png.toString('base64'), name: `Spam ${i}`, stage: true }, token);
      outcomes.push((r.body.error as { code?: string } | undefined)?.code ?? String(r.body.status));
    }
    // The binary endpoint's own allowance is 3 an hour for this connection; staging through base64 has none.
    expect(outcomes.filter((o) => o === 'staged').length, outcomes.join(', ')).toBeLessThanOrEqual(3);
  });
});
