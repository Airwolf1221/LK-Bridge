/**
 * RV3-4: restoring a deleted image sends the stored bytes through D3's upload converter (src/snapshots/image-restore.ts
 * `d.images.convert(old.bytes)`), so a PNG or JPEG comes back as a lossy WebP (quality 90, metadata and colour profile
 * dropped), not the image the snapshot holds; and one over UPLOAD_MAX_BYTES (10 MiB) cannot be restored at all. The
 * rehearsal, by contrast, uploads the stored bytes as they are and compares them by SHA-256.
 */
import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const call = (name: string, args: Record<string, unknown>) =>
  w!.stack.call(c, name, { project: 'test', ...args });

async function approve(r: ToolCall) {
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  const id = String(r.body.proposalId);
  const pol = w!.stack.runtime.policy;
  await pol.commands.approve('owner', id);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol.proposals.get(id)!.state);
    i++
  )
    await new Promise((res) => setTimeout(res, 20));
  return pol.proposals.get(id)!.state;
}

it('RV3-4: a restored PNG image comes back byte for byte (the snapshot store’s bytes), not re-encoded', async () => {
  w = await snapshotsWorld();
  c = await w.stack.connect();
  // A PNG in the library (uploaded in the app: LegendKeeper keeps what it is given).
  const png = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 120, b: 10, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const id = w.addImage('Heraldry', S.folderA, png, 'imgpng01');
  const snap = (await w.stack.runtime.snapshots.full(PROJECT, 'manual')).snapshotId!;
  const del = await call('lk_api_write', { operationId: 'deleteAsset', params: { path: { assetId: id } } });
  expect(del.isError, JSON.stringify(del.body)).toBe(false);
  const r = await call('restore_snapshot', { snapshot: snap, scope: 'image', asset: id });
  expect(r.body.status, JSON.stringify(r.body)).toBe('proposal_captured');
  expect(await approve(r)).toBe('executed');
  // v3 F3c (ADR 0051): the new asset exists only once approved (uploaded from the bridge's server into its folder).
  const [made] = w.assets.byName('Heraldry', S.folderA);
  const newId = made!.id;
  expect(newId).not.toBe(id);
  const restored = w.served.get(newId)!;
  // Safe: the same bytes as the snapshot stored (a backup brings back the original, not a lossy copy).
  expect(
    createHash('sha256').update(restored).digest('hex'),
    `restored as ${restored.subarray(0, 4).toString('latin1')}…${restored.subarray(8, 12).toString('latin1')} (${restored.length} bytes; the PNG was ${png.length})`,
  ).toBe(createHash('sha256').update(png).digest('hex'));
});
