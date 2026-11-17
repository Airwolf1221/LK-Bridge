/**
 * CR2 images, attacks C1 to C6 (path traversal in server staging): ids, names, hashes, `../`, absolute paths, NUL, very
 * long names, encoded separators and SQL in every place an outside value meets the image directory: the content store
 * (`ByteStore`, src/images/kept.ts), the binary endpoint's slots (src/images/slots.ts, src/images/http.ts), the MCP
 * tool's `upload_id` and `staged_id`, the dashboard's Staging routes (src/admin/routes/staging.ts), and asset names.
 *
 * The safe behaviour: refused or not found; nothing read, written or removed outside the bridge's image directory.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../../src/admin/guard.js';
import { ByteStore } from '../../../src/images/kept.js';
import { PROJECT, PUBLIC_URL } from '../../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld;
beforeAll(async () => {
  w = await imagesWorld();
});
afterAll(async () => w.close());

const EVIL = [
  '../../../../etc/passwd',
  '..%2f..%2fetc%2fpasswd',
  '/etc/passwd',
  'img_../../../../etc/passwd',
  'upl_../../../../../../../tmp',
  `img_${'A'.repeat(5000)}`,
  'img_abc\u0000def',
  "img_x' OR '1'='1",
  '..\\..\\windows\\win.ini',
];

async function call(args: Record<string, unknown>) {
  const c = await w.stack.connect();
  return w.stack.call(c, 'upload_image', { project: 'test', ...args });
}
const code = (r: { body: Record<string, unknown> }) => (r.body.error as { code?: string } | undefined)?.code;

function owner() {
  const s = w.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${w.stack.base}/api/admin${path}`, {
      method,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(method !== 'GET' ? { 'x-csrf-token': csrf, 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
  };
}

/** Every file under the image directory, relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

describe('C1: the content store takes nothing but a SHA-256', () => {
  it('has / get / remove refuse traversal, absolute paths, NUL and long names', async () => {
    const dir = join(w.dataDir, 'c1-store');
    const store = new ByteStore(dir);
    // A file outside the store that a traversal would reach.
    mkdirSync(join(w.dataDir, 'outside'), { recursive: true });
    writeFileSync(join(w.dataDir, 'outside', 'victim'), 'victim');
    for (const bad of [
      ...EVIL,
      '../outside/victim',
      `${'a'.repeat(64)}/../../outside/victim`,
      'A'.repeat(64),
    ]) {
      expect(await store.has(bad), bad).toBe(false);
      expect(await store.get(bad), bad).toBeNull();
      await expect(store.remove(bad), bad).rejects.toThrow(/not a SHA-256/);
    }
    expect(readdirSync(join(w.dataDir, 'outside'))).toEqual(['victim']);
  });
});

describe('C2: the MCP tool’s upload_id and staged_id', () => {
  it.each(EVIL)('%s is unknown, never a path', async (bad) => {
    const u = await call({ upload_id: bad.slice(0, 64), destination: { folder: 'Characters / Humans' } });
    expect(code(u), u.text).toMatch(/^UPLOAD_ID_UNKNOWN$|^INVALID_ARGUMENTS$/);
    const s = await call({ staged_id: bad.slice(0, 64), destination: { folder: 'Characters / Humans' } });
    expect(code(s) ?? (s.isError ? 'INVALID_ARGUMENTS' : 'ok'), s.text).toMatch(
      /^STAGED_NOT_FOUND$|^INVALID_ARGUMENTS$/,
    );
  });
});

describe('C3: the binary endpoint', () => {
  it.each(EVIL)('POST /uploads/%s gets the one generic refusal', async (bad) => {
    const res = await fetch(`${w.stack.base}/uploads/${encodeURIComponent(bad)}`, {
      method: 'POST',
      headers: { authorization: `Upload ${'A'.repeat(43)}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(fixture('alpha.png')),
    });
    expect([403, 404, 414]).toContain(res.status);
    expect(await res.text()).not.toContain('root:');
  });
});

describe('C4: the dashboard’s Staging routes', () => {
  it('a traversal id never serves a file, places or discards anything', async () => {
    const req = owner();
    for (const bad of EVIL) {
      const g = await req('GET', `/staging/${encodeURIComponent(bad)}/image?project=test`);
      expect([400, 404, 414], `${bad.slice(0, 40)}: ${g.status}`).toContain(g.status);
      expect(g.type).not.toContain('image');
      const p = await req('POST', `/staging/${encodeURIComponent(bad)}/place?project=test`, {
        destination: { folder: 'Characters / Humans' },
      });
      expect([400, 404, 414], `${bad.slice(0, 40)}: ${p.status}`).toContain(p.status);
      const d = await req('POST', `/staging/${encodeURIComponent(bad)}/discard?project=test`, {
        confirm: true,
      });
      expect([400, 404, 414], `${bad.slice(0, 40)}: ${d.status}`).toContain(d.status);
    }
  });

  it('a record whose stored hash were a path still serves nothing (defence in depth)', async () => {
    const r = await call({
      data_base64: fixture('already.webp').toString('base64'),
      name: 'Tamper',
      stage: true,
    });
    const id = String(r.body.staged_id);
    w.stack.db
      .prepare('UPDATE image_uploads SET server_sha256 = ? WHERE id = ?')
      .run('../../../../../../etc/passwd', id);
    expect(await w.stack.runtime.images.stagedImage(PROJECT, id)).toBeNull();
    const g = await owner()('GET', `/staging/${id}/image?project=test`);
    expect(g.status).toBe(404);
    expect(g.text).not.toContain('root:');
  });
});

describe('C5: names never become paths', () => {
  it('an image named with ../, an absolute path, NUL and 200 characters is stored under its hash only', async () => {
    const before = new Set(filesUnder(w.dataDir));
    for (const [i, name] of [
      '../../../../tmp/pwned.png',
      '/etc/cron.d/pwned',
      'nul\u0000byte',
      `${'n'.repeat(199)}`,
      '..',
    ].entries()) {
      const img = i % 2 === 0 ? fixture('alpha.png') : fixture('already.webp');
      const r = await call({
        data_base64: img.toString('base64'),
        name,
        stage: true,
        deduplicate: false,
        operation_id: `c5-${i}`,
      });
      expect(r.isError, r.text).toBe(false);
    }
    const added = filesUnder(w.dataDir).filter((f) => !before.has(f));
    for (const f of added) expect(f, f).toMatch(/^staged\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });
});
