/**
 * CR2 images, attack E5 (duplicates under concurrency): "The same original sent again returns the existing asset: never
 * upload a copy" (upload_image's description; `findDuplicate`, src/images/service.ts). The duplicate check reads the
 * records, and the new record is only inserted after awaited I/O (`stageOnServer`: the disk check and the file write;
 * `startUpload`: the snapshot store's copy of the bytes, then `engine.submit`). Two calls with the same image at once
 * (an assistant's parallel tool calls, or a retry while the first is still running) both find nothing.
 *
 * Safe: one asset (or one staged image) for one original; the second call answers `deduplicated: true`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const createdAssets = (world: ImagesWorld) =>
  world.lkUploads.filter((u) => (u as { op: string }).op === 'createImageAsset').length;

describe('E5: the same original, twice at once', () => {
  it('direct upload with a destination: ONE asset', async () => {
    w = await imagesWorld();
    const [c1, c2] = await Promise.all([w.stack.connect(), w.stack.connect()]);
    const args = {
      project: 'test',
      data_base64: fixture('orientation-6.jpg').toString('base64'),
      name: 'Twice at once',
      destination: { folder: 'Characters / Humans' },
    };
    const [a, b] = await Promise.all([
      w.stack.call(c1, 'upload_image', args),
      w.stack.call(c2, 'upload_image', args),
    ]);
    for (const r of [a, b])
      if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    const detail = JSON.stringify({
      a: String(a.body.deduplicated ?? a.body.status),
      b: String(b.body.deduplicated ?? b.body.status),
      assets: createdAssets(w),
    });
    expect(createdAssets(w), detail).toBe(1);
  });

  it('staging: ONE staged image', async () => {
    w = await imagesWorld();
    const [c1, c2] = await Promise.all([w.stack.connect(), w.stack.connect()]);
    const args = {
      project: 'test',
      data_base64: fixture('animated.gif').toString('base64'),
      name: 'Staged twice at once',
      stage: true,
    };
    const [a, b] = await Promise.all([
      w.stack.call(c1, 'upload_image', args),
      w.stack.call(c2, 'upload_image', args),
    ]);
    const ids = new Set([a.body.staged_id, b.body.staged_id]);
    const rows = w.stack.runtime.images.listStaged(PROJECT).filter((r) => r.name === 'Staged twice at once');
    expect({ ids: ids.size, rows: rows.length }, `${a.text}\n${b.text}`).toEqual({ ids: 1, rows: 1 });
  });
});
