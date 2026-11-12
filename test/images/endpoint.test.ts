/**
 * The single-use binary endpoint over real HTTP, in process (v2 D3, ADR 0041): prepare_image_upload, then
 * `POST /uploads/<upload_id>`, then upload_image with the upload_id. Every refusal of the threat review is exercised.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function prepare(world: ImagesWorld, file: Buffer, o: Record<string, unknown> = {}, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, 'prepare_image_upload', {
    project: 'test',
    sha256: sha(file),
    byte_length: file.length,
    content_type: 'image/png',
    name: 'portrait.png',
    ...o,
  });
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** A raw POST to the bridge (node:http, so a body can be sent slowly or cut short). */
function post(
  world: ImagesWorld,
  path: string,
  o: {
    body?: Buffer;
    headers?: Record<string, string>;
    chunks?: { data: Buffer; delayMs: number }[];
    lengthHeader?: number;
  } = {},
): Promise<Answer> {
  const url = new URL(path, world.stack.base);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          ...(o.lengthHeader !== undefined
            ? { 'content-length': String(o.lengthHeader) }
            : o.body
              ? { 'content-length': String(o.body.length) }
              : {}),
          ...o.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = { text };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (o.chunks) {
      void (async () => {
        for (const c of o.chunks!) {
          await new Promise((r) => setTimeout(r, c.delayMs));
          if (req.destroyed) return;
          req.write(c.data);
        }
        req.end();
      })();
    } else {
      if (o.body) req.write(o.body);
      req.end();
    }
  });
}

const auth = (token: string) => ({ authorization: `Upload ${token}` });

describe('the binary endpoint', () => {
  it('prepare → POST → upload_image: lands as WebP in the character’s folder, verified; the file is gone after', async () => {
    w = await imagesWorld();
    const file = fixture('orientation-6.jpg');
    const p = await prepare(w, file, { content_type: 'image/jpeg', name: 'Mehrana.JPG' });
    expect(p.isError, JSON.stringify(p.body)).toBe(false);
    const id = String(p.body.upload_id);
    const token = String(p.body.capability);
    expect(id).toMatch(/^upl_/);
    expect(Buffer.from(token, 'base64url').length).toBe(32); // 256 bits
    expect(p.body.endpoint).toMatchObject({ method: 'POST', url: `https://lk.example.test/uploads/${id}` });
    const scripts = p.body.scripts as { python: string; curl: string };
    expect(scripts.python).toContain('hashlib.sha256');
    expect(scripts.python).not.toMatch(/^import (requests|httpx)/m);
    expect(scripts.curl).toContain('--data-binary');
    expect(scripts.curl).toContain(sha(file));
    expect(scripts.python).not.toContain(`?${token}`);
    // The capability is stored only as a hash.
    const slot = w.stack.runtime.images.store.slot(id)!;
    expect(slot.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(slot)).not.toContain(token);

    const r = await post(w, `/uploads/${id}`, { body: file, headers: auth(token) });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ status: 'received', upload_id: id, sha256: sha(file), bytes: file.length });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['set-cookie']).toBeUndefined();

    const c = await w.stack.connect();
    const u = await w.stack.call(c, 'upload_image', {
      project: 'test',
      upload_id: id,
      destination: { for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' } },
    });
    expect(u.isError, JSON.stringify(u.body)).toBe(false);
    expect(u.body).toMatchObject({
      status: 'uploaded',
      name: 'Mehrana',
      storedBytesVerified: true,
      destination: { path: ['Characters', 'Beastkin', 'Qishen', 'Mehrana al-Khalid'], createsFolders: [] },
      image: { originalFormat: 'jpeg', width: 20, height: 30, orientationApplied: 6 },
    });
    expect(w.stack.runtime.images.store.slot(id)!.state).toBe('consumed');
    expect(readdirSync(join(w.dataDir, 'upload-tmp'))).toEqual([]);
    // Used once: a second upload_image with it is refused.
    const again = await w.stack.call(c, 'upload_image', {
      project: 'test',
      upload_id: id,
      destination: { folder: 'Characters' },
    });
    expect((again.body.error as { code: string }).code).toBe('UPLOAD_ID_USED');
  });

  it('refuses a missing, wrong, used or expired capability with ONE generic answer', async () => {
    w = await imagesWorld();
    const file = fixture('alpha.png');
    const p = await prepare(w, file);
    const id = String(p.body.upload_id);
    const token = String(p.body.capability);
    const none = await post(w, `/uploads/${id}`, { body: file });
    const wrong = await post(w, `/uploads/${id}`, { body: file, headers: auth('A'.repeat(43)) });
    const bearer = await post(w, `/uploads/${id}`, {
      body: file,
      headers: { authorization: `Bearer ${token}` },
    });
    const unknown = await post(w, `/uploads/upl_${'A'.repeat(22)}`, { body: file, headers: auth(token) });
    const traversal = await post(w, `/uploads/..%2F..%2Fetc%2Fpasswd`, { body: file, headers: auth(token) });
    // The token in the URL is ignored.
    const inUrl = await post(w, `/uploads/${id}?token=${token}&capability=${token}`, { body: file });
    for (const r of [none, wrong, bearer, unknown, traversal, inUrl]) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        error: 'upload_refused',
        message: 'The upload was refused: no valid upload capability for this upload id.',
      });
    }
    // Still usable once, by its rightful holder.
    expect((await post(w, `/uploads/${id}`, { body: file, headers: auth(token) })).status).toBe(201);
    const reused = await post(w, `/uploads/${id}`, { body: file, headers: auth(token) });
    expect(reused.status).toBe(403);
    expect(reused.body.error).toBe('upload_refused');
    // Expired: 5 minutes after it was issued.
    const p2 = await prepare(w, file, { name: 'later' });
    w.stack.db
      .prepare('UPDATE image_upload_slots SET token_expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, p2.body.upload_id);
    const expired = await post(w, `/uploads/${String(p2.body.upload_id)}`, {
      body: file,
      headers: auth(String(p2.body.capability)),
    });
    expect(expired.status).toBe(403);
    expect(expired.body.error).toBe('upload_refused');
  });

  it('is bound to its project and its connection', async () => {
    w = await imagesWorld();
    const file = fixture('alpha.png');
    const p = await prepare(w, file);
    const id = String(p.body.upload_id);
    expect(
      (await post(w, `/uploads/${id}`, { body: file, headers: auth(String(p.body.capability)) })).status,
    ).toBe(201);
    // Another connection cannot use the received file.
    const other = w.stack.newToken('someone-else', 'write');
    const c = await w.stack.connect(other.token);
    const r = await w.stack.call(c, 'upload_image', {
      project: 'test',
      upload_id: id,
      destination: { folder: 'Characters' },
    });
    expect((r.body.error as { code: string }).code).toBe('UPLOAD_ID_UNKNOWN');
    // Another project: the slot is not there.
    expect(
      w.stack.runtime.images.slots.slotFor(
        id,
        'another-project',
        w.stack.runtime.images.store.slot(id)!.principalId,
      ),
    ).toBeNull();
    void PROJECT;
  });

  it('refuses a wrong hash, a wrong length, a wrong type and an oversized body, and keeps nothing', async () => {
    w = await imagesWorld();
    const file = fixture('alpha.png');
    const tmp = join(w.dataDir, 'upload-tmp');
    // Wrong hash: same length, other bytes.
    let p = await prepare(w, file);
    const other = Buffer.from(file);
    other[file.length - 1] = other[file.length - 1]! ^ 0xff;
    let r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      body: other,
      headers: auth(String(p.body.capability)),
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('hash_mismatch');
    expect(w.stack.runtime.images.store.slot(String(p.body.upload_id))!.state).toBe('expired');
    // Shorter body.
    p = await prepare(w, file, { name: 'b' });
    r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      body: file.subarray(0, 10),
      headers: auth(String(p.body.capability)),
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('too_small');
    // Declared longer than prepared: refused before anything is read.
    p = await prepare(w, file, { name: 'c' });
    r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      body: Buffer.concat([file, Buffer.alloc(100)]),
      headers: auth(String(p.body.capability)),
    });
    expect(r.status).toBe(413);
    // Longer than prepared without a declared length (chunked): reading stops at length + 1.
    p = await prepare(w, file, { name: 'd' });
    r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      chunks: [
        { data: file, delayMs: 0 },
        { data: Buffer.alloc(64 * 1024), delayMs: 10 },
      ],
      headers: { ...auth(String(p.body.capability)), 'transfer-encoding': 'chunked' },
    });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('too_large');
    // A different magic-byte type than declared: a PNG declared as JPEG.
    p = await prepare(w, file, { name: 'e', content_type: 'image/jpeg' });
    r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      body: file,
      headers: auth(String(p.body.capability)),
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('type_mismatch');
    // Text pretending to be an image.
    const text = fixture('not-an-image.png');
    p = await prepare(w, text, { name: 'f' });
    r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      body: text,
      headers: auth(String(p.body.capability)),
    });
    expect(r.status).toBe(422);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('drops a slow body (slow-loris) and keeps nothing', async () => {
    w = await imagesWorld({ images: { idleTimeoutMs: 1000, bodyTimeoutMs: 5000 } });
    const file = fixture('alpha.png');
    const p = await prepare(w, file);
    const r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      chunks: [
        { data: file.subarray(0, 20), delayMs: 0 },
        { data: file.subarray(20), delayMs: 1600 },
      ],
      headers: auth(String(p.body.capability)),
      lengthHeader: file.length,
    }).catch((e: Error) => ({ status: 0, headers: {}, body: { error: e.message } }));
    expect([408, 0]).toContain(r.status);
    expect(w.stack.runtime.images.store.slot(String(p.body.upload_id))!.state).toBe('expired');
    expect(readdirSync(join(w.dataDir, 'upload-tmp'))).toEqual([]);
  });

  it('rate-limits per address and per connection', async () => {
    w = await imagesWorld({ images: { ratePerIpPerHour: 3, ratePerPrincipalPerHour: 2 } });
    const file = fixture('alpha.png');
    // prepare_image_upload: 2 per connection per hour.
    const a = await prepare(w, file, { name: 'a' });
    await prepare(w, file, { name: 'b' });
    const c3 = await prepare(w, file, { name: 'c' });
    expect((c3.body.error as { code: string }).code).toBe('RATE_LIMITED');
    // The endpoint: 3 requests per address per hour, refused ones included.
    const bad = { body: file, headers: auth('B'.repeat(43)) };
    await post(w, `/uploads/${String(a.body.upload_id)}`, bad);
    await post(w, `/uploads/${String(a.body.upload_id)}`, bad);
    await post(w, `/uploads/${String(a.body.upload_id)}`, bad);
    const limited = await post(w, `/uploads/${String(a.body.upload_id)}`, {
      body: file,
      headers: auth(String(a.body.capability)),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('is refused when the connection that prepared it has become read-only', async () => {
    w = await imagesWorld();
    const file = fixture('alpha.png');
    const t = w.stack.newToken('demoted', 'write');
    const p = await prepare(w, file, {}, t.token);
    w.stack.runtime.policy.commands.setScope('owner', t.profileId, 'read');
    const r = await post(w, `/uploads/${String(p.body.upload_id)}`, {
      body: file,
      headers: auth(String(p.body.capability)),
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('upload_refused');
  });

  it('cleans its directory at start and expires unused files after 15 minutes', async () => {
    w = await imagesWorld();
    const svc = w.stack.runtime.images;
    const tmp = join(w.dataDir, 'upload-tmp');
    writeFileSync(join(tmp, 'left-over.bin'), 'junk');
    expect(svc.slots.cleanAtStart()).toBe(1);
    expect(existsSync(join(tmp, 'left-over.bin'))).toBe(false);
    const file = fixture('alpha.png');
    const p = await prepare(w, file);
    const id = String(p.body.upload_id);
    expect(
      (await post(w, `/uploads/${id}`, { body: file, headers: auth(String(p.body.capability)) })).status,
    ).toBe(201);
    expect(readdirSync(tmp)).toHaveLength(1);
    w.stack.db.prepare('UPDATE image_upload_slots SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
    expect(await svc.sweep()).toBe(1);
    expect(readdirSync(tmp)).toEqual([]);
    expect(svc.store.slot(id)!.state).toBe('expired');
    const c = await w.stack.connect();
    const r = await w.stack.call(c, 'upload_image', {
      project: 'test',
      upload_id: id,
      destination: { folder: 'Characters' },
    });
    expect((r.body.error as { code: string }).code).toBe('UPLOAD_EXPIRED');
  });

  it('never logs the capability', async () => {
    w = await imagesWorld();
    const file = fixture('alpha.png');
    const p = await prepare(w, file);
    const token = String(p.body.capability);
    await post(w, `/uploads/${String(p.body.upload_id)}?token=${token}`, {
      body: file,
      headers: auth(token),
    });
    const audit = w.stack.db.prepare('SELECT * FROM audit_log').all();
    expect(JSON.stringify(audit)).not.toContain(token);
    const errors = w.stack.db.prepare('SELECT * FROM errors').all();
    expect(JSON.stringify(errors)).not.toContain(token);
  });
});
