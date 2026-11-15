/**
 * RV1-1: an I/O error on the binary endpoint's temporary file (disk full, quota, EIO, too many open files) is an
 * 'error' event on a WriteStream nobody listens to. Node turns that into an uncaught exception, which in production
 * (no uncaughtException handler in src/server.ts) kills the bridge mid-job. The request itself leaves its slot
 * 'receiving' and its `.part` file behind (the minute sweep skips `.part` files), and answers with the raw errno text.
 *
 * The fault is injected with a mocked `createWriteStream` whose writes fail with ENOSPC, only for upload-tmp files.
 */
import { createHash } from 'node:crypto';
import type * as fs from 'node:fs';
import { readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, imagesWorld, type ImagesWorld } from '../images/world.js';

const fault = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    createWriteStream: ((path: string, opts?: Parameters<typeof actual.createWriteStream>[1]) => {
      const s = actual.createWriteStream(path, opts);
      if (fault.on && String(path).includes('upload-tmp')) {
        s._write = (_chunk, _enc, cb) =>
          cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      }
      return s;
    }) as typeof actual.createWriteStream,
  };
});

let w: ImagesWorld | undefined;
afterEach(async () => {
  fault.on = false;
  await w?.close();
  w = undefined;
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function post(world: ImagesWorld, path: string, body: Buffer, headers: Record<string, string>) {
  const url = new URL(path, world.stack.base);
  return new Promise<{ status: number; text: string }>((resolve) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', (e) => resolve({ status: 0, text: e.message }));
    req.end(body);
  });
}

describe('RV1-1: a write error on the upload temporary file', () => {
  it('is handled: no uncaught exception, the slot is spent, no .part file is left, a generic 5xx answer', async () => {
    w = await imagesWorld({ images: { idleTimeoutMs: 1000, bodyTimeoutMs: 3000 } });
    const file = fixture('alpha.png');
    const c = await w.stack.connect();
    const p = await w.stack.call(c, 'prepare_image_upload', {
      project: 'test',
      sha256: sha(file),
      byte_length: file.length,
      content_type: 'image/png',
      name: 'portrait.png',
    });
    expect(p.isError, JSON.stringify(p.body)).toBe(false);
    const id = String(p.body.upload_id);

    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    fault.on = true;
    let r: { status: number; text: string };
    try {
      r = await post(w, `/uploads/${id}`, file, { authorization: `Upload ${String(p.body.capability)}` });
      await new Promise((res) => setTimeout(res, 200));
    } finally {
      fault.on = false;
      process.removeListener('uncaughtException', onUncaught);
    }

    // The bridge process would have died here: an 'error' event on a stream with no listener.
    expect.soft(uncaught.map((e) => String(e))).toEqual([]);
    // The request is answered as a server-side failure, without the errno text or a server path.
    expect.soft(r.status, r.text).toBeGreaterThanOrEqual(500);
    expect.soft(r.text).not.toMatch(/ENOSPC|upload-tmp/);
    // The slot is spent like any other refusal, and nothing is left in the temporary directory.
    expect.soft(w.stack.runtime.images.store.slot(id)!.state).toBe('expired');
    expect(readdirSync(join(w.dataDir, 'upload-tmp'))).toEqual([]);
  });
});
