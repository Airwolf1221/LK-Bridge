/**
 * RV1-2: "A received file is consumed once (received → consumed)" (ADR 0041, threat review: Replay). The slot is only
 * consumed AFTER the conversion, the destination plan and the job submission (src/mcp/tools/images.ts uploadBytes:
 * `if (slot) await svc.slots.consume(slot)` after `svc.startUpload`), and consume's `false` is ignored. Two
 * `upload_image` calls with the same upload_id that arrive together both read the slot as `received`, and both upload.
 * With `deduplicate: false` (each with its own operation_id, as the tool asks) nothing else stops the second copy.
 */
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, imagesWorld, type ImagesWorld } from '../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function post(world: ImagesWorld, path: string, body: Buffer, token: string) {
  const url = new URL(path, world.stack.base);
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          authorization: `Upload ${token}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('RV1-2: one upload_id, two upload_image calls at once', () => {
  it('uploads the received file once; the other call is told the upload_id was used', async () => {
    w = await imagesWorld();
    const file = fixture('alpha.png');
    const c = await w.stack.connect();
    const p = await w.stack.call(c, 'prepare_image_upload', {
      project: 'test',
      sha256: sha(file),
      byte_length: file.length,
      content_type: 'image/png',
      name: 'portrait.png',
    });
    const id = String(p.body.upload_id);
    expect(await post(w, `/uploads/${id}`, file, String(p.body.capability))).toBe(201);

    const call = (op: string) =>
      w!.stack.call(c, 'upload_image', {
        project: 'test',
        upload_id: id,
        destination: { folder: 'Characters' },
        deduplicate: false,
        operation_id: op,
      });
    const [a, b] = await Promise.all([call('rv1-a'), call('rv1-b')]);

    const assetsMade = w.lkUploads.filter((u) => (u as { op: string }).op === 'createImageAsset').length;
    const codes = [a, b].map((r) => (r.body.error as { code?: string } | undefined)?.code ?? 'ok').sort();
    expect({ assetsMade, codes }).toEqual({ assetsMade: 1, codes: ['UPLOAD_ID_USED', 'ok'] });
  });
});
