/**
 * v3 F7c (ADR 0075): helpers for the archive tests: a zip handed to `upload_image_archive` as ChatGPT hands a file (the
 * test world's file host), rows by entry, and waiting for the archive worker.
 */
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { ImagesWorld } from '../images/world.js';

type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  isError: boolean;
}>;

/** Serves `bytes` as a ChatGPT file and returns the `file` argument. */
export function chatgptFile(w: ImagesWorld, bytes: Buffer, fileName = 'art.zip'): Record<string, unknown> {
  const name = randomUUID();
  w.files.set(name, { status: 200, type: 'application/zip', body: bytes });
  return {
    download_url: `https://assets.test:${w.port}/f/${name}`,
    file_id: `file-${name}`,
    file_name: fileName,
  };
}

/** Uploads a zip through `upload_image_archive` (as ChatGPT would). */
export async function uploadZip(
  w: ImagesWorld,
  call: Call,
  bytes: Buffer,
  more: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<Call>>> {
  return call('upload_image_archive', { file: chatgptFile(w, bytes), project: 'test', ...more });
}

/** The row of an entry (by base name) in an answer's rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed JSON row
export function row(body: { rows?: Record<string, unknown>[] }, entry: string): Record<string, any> {
  const r = (body.rows ?? []).find((x) => x.entry === entry || x.path === entry);
  if (!r) throw new Error(`no row ${entry} in ${JSON.stringify((body.rows ?? []).map((x) => x.path))}`);
  return r as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Runs the archive worker until it has nothing more it can stage now. */
export async function drain(w: ImagesWorld): Promise<void> {
  const a = w.stack.runtime.images.archives;
  for (let i = 0; i < 50; i++) {
    const n = await a.work();
    if (n === 0 && !a.store.waiting().some((e) => e.status === 'queued' || e.status === 'converting')) return;
  }
}

/** Waits until `check` holds (polling), or throws. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

/** A raw POST of `body` to the binary endpoint with a capability (node:http). */
export function postUpload(
  w: ImagesWorld,
  uploadId: string,
  body: Buffer,
  capability: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`/uploads/${uploadId}`, w.stack.base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          authorization: `Upload ${capability}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let b: Record<string, unknown> = {};
          try {
            b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body: b });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** prepare_image_upload for a zip, then its POST: returns the upload id, ready for upload_image_archive. */
export async function binaryZip(
  w: ImagesWorld,
  call: Call,
  bytes: Buffer,
  name = 'art.zip',
): Promise<string> {
  const p = await call('prepare_image_upload', {
    project: 'test',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byte_length: bytes.length,
    content_type: 'application/zip',
    name,
  });
  if (p.isError) throw new Error(p.text);
  const r = await postUpload(w, String(p.body.upload_id), bytes, String(p.body.capability));
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  return String(p.body.upload_id);
}
