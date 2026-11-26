/**
 * CR2 images, attack F6 (snapshot image restore, ADR 0051 decision 3; RV3-4's "the snapshot store's bytes, exactly").
 *
 * `restoreImage` (src/snapshots/image-restore.ts) looks for a staged record of the same ORIGINAL first
 * (`findDuplicate(projectId, old.sha)`) and, when one waits on the server, places THAT record instead of staging the
 * snapshot's bytes. A record an agent staged through `upload_image` holds the converted WebP, not the original: the
 * restore then uploads the agent's re-encoded file (declared with the original's content type), the stored-file check
 * passes (it compares with that record's own hash), and the agent's staged image is consumed by the owner's restore.
 *
 * Safe: the restored asset's bytes are the snapshot's bytes, whatever is staged.
 */
import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

/** v3 F12 (ADR 0081): at scope write the restore runs directly as one job; it ends, then the asset is back. */
async function restoredAs(r: ToolCall, name: string, folder: string) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('written');
  const job = await w!.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000);
  expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  for (let i = 0; i < 400 && w!.assets.byName(name, folder).length === 0; i++)
    await new Promise((res) => setTimeout(res, 20));
  return w!.assets.byName(name, folder);
}

it('F6: a deleted PNG restored while an agent has the same original staged comes back byte for byte', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  const png = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const id = w.addImage('Heraldry', S.folderA, png, 'imgpng02');
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  const del = await call('lk_api_write', { operationId: 'deleteAsset', params: { path: { assetId: id } } });
  expect(del.isError, JSON.stringify(del.body)).toBe(false);
  // An agent stages the same original (as anyone re-uploading that art would): WebP on the bridge's server.
  const staged = await call('upload_image', {
    data_base64: png.toString('base64'),
    name: 'Re-upload',
    stage: true,
  });
  expect(staged.body.status, staged.text).toBe('staged');
  const agentRow = w.stack.runtime.images.store.upload(PROJECT, String(staged.body.staged_id))!;
  expect(agentRow.webp.sha256).not.toBe(sha(png)); // converted
  const r = await call('restore_snapshot', { snapshot: snap, scope: 'image', asset: id });
  const [made] = await restoredAs(r, 'Heraldry', S.folderA);
  expect(made, 'the restored asset').toBeDefined();
  const restored = w.served.get(made!.id)!;
  const after = w.stack.runtime.images.store.upload(PROJECT, agentRow.id)!;
  expect(
    sha(restored),
    `restored ${restored.length} bytes starting ${restored.subarray(8, 12).toString('latin1')}; the agent's record is now ${JSON.stringify({ staged: after.staged, assetId: after.assetId })}`,
  ).toBe(sha(png));
});
