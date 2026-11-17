/**
 * CR2 images, attacks D1 to D3 (secrets): a ChatGPT file's `download_url` is a capability ("never logged, stored,
 * journalled or returned", ADR 0049 decision 11), and so is a signed `url` an agent passes (an S3 or GCS link). The
 * existing test (test/images/chatgpt-file.test.ts) checks the happy path and four tables. Here every FAILURE path
 * (expired, server error, refused redirect whose Location carries its own secret, oversize, not an image, unknown host,
 * credentials in the URL, another port, a link too long for the schema, a non-URL), the propose path, and the `url`
 * source, with EVERY table of the database, every log line (trace level), and every answer searched.
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld;
const logs: string[] = [];
const answers: string[] = [];
const secrets: string[] = [];
const secret = (tag: string) => {
  const s = `CAPSECRET${tag}x${Math.random().toString(36).slice(2, 10)}`;
  secrets.push(s);
  return s;
};

beforeAll(async () => {
  w = await imagesWorld({
    logStream: new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(chunk.toString('utf8'));
        done();
      },
    }),
  });
  w.files.set('ok', { status: 200, type: 'application/octet-stream', body: fixture('alpha.png') });
  w.files.set('ok2', { status: 200, type: 'image/webp', body: fixture('already.webp') });
  w.files.set('expired', { status: 403 });
  w.files.set('broken', { status: 500 });
  w.files.set('big', { status: 200, body: Buffer.alloc(11 * 1024 * 1024, 7) });
  w.files.set('html', { status: 200, type: 'text/html', body: Buffer.from('<html>not an image</html>') });
  w.web.set('signed.png', { type: 'image/png', body: fixture('orientation-6.jpg') });
});
afterAll(async () => w.close());

async function call(args: Record<string, unknown>, token?: string) {
  const c = await w.stack.connect(token);
  try {
    const r = await w.stack.call(c, 'upload_image', { project: 'test', ...args });
    answers.push(r.text);
    return r;
  } catch (e) {
    answers.push(String((e as Error).message));
    return null;
  }
}
const f = (name: string, tag: string, host = 'assets.test') =>
  `https://${host}:${w.port}/f/${name}?X-Goog-Signature=${secret(tag)}`;

describe('D1: download_url on every failure path', () => {
  it('each call fails or succeeds as expected', async () => {
    const codes: Record<string, unknown> = {};
    const run = async (label: string, download_url: string, extra: Record<string, unknown> = {}) => {
      const r = await call({
        file: { download_url, file_id: `file-${label}` },
        name: label,
        stage: true,
        ...extra,
      });
      codes[label] = (r?.body.error as { code?: string } | undefined)?.code ?? r?.body.status ?? 'thrown';
    };
    await run('expired', f('expired', 'expired'));
    await run('broken', f('broken', 'broken'));
    // A redirect whose Location carries a secret of its own, to a private address.
    w.files.set('hop', { status: 302, location: `https://10.0.0.7/blob?sig=${secret('location')}` });
    await run('hop', f('hop', 'hop'));
    await run('big', f('big', 'big'));
    await run('html', f('html', 'html'));
    await run('dns', `https://nowhere.invalid/f/x?sig=${secret('dns')}`);
    await run('creds', `https://user:${secret('creds')}@assets.test:${w.port}/f/ok`);
    await run('port', `https://assets.test:4444/f/ok?sig=${secret('port')}`);
    await run('nonurl', `not a url ${secret('nonurl')}`);
    await run('toolong', `${f('ok', 'toolong')}&pad=${'x'.repeat(8300)}`);
    expect(codes).toMatchObject({
      expired: 'FILE_URL_EXPIRED',
      broken: 'UPLOAD_URL_FAILED',
      hop: 'UPLOAD_URL_REFUSED',
      big: 'UPLOAD_TOO_LARGE',
      html: 'UPLOAD_NOT_AN_IMAGE',
      dns: 'UPLOAD_URL_FAILED',
      creds: 'UPLOAD_URL_REFUSED',
      port: 'UPLOAD_URL_REFUSED',
      nonurl: 'UPLOAD_URL_REFUSED',
    });
  });

  it('the propose path (staged at once, the placement a proposal) and a successful direct upload', async () => {
    const { token } = w.stack.newToken('chatgpt-propose', 'propose');
    const p = await call(
      {
        file: { download_url: f('ok', 'propose'), file_id: 'file-propose', file_name: 'Prop.png' },
        destination: { folder: 'Characters / Humans' },
      },
      token,
    );
    expect(p?.body.status, p?.text).toBe('proposal_captured');
    const d = await call({
      file: { download_url: f('ok2', 'direct'), file_id: 'file-direct', file_name: 'Direct.webp' },
      destination: { folder: 'Characters / Dwarves' },
    });
    expect(d?.body.status, d?.text).toBe('uploaded');
  });
});

describe('D2: a signed url source', () => {
  it('is fetched and uploaded', async () => {
    const r = await call({
      url: `https://assets.test:${w.port}/img/signed.png?X-Amz-Signature=${secret('url')}`,
      name: 'Signed',
      destination: { folder: 'Characters / Elves' },
    });
    expect(r?.body.status, r?.text).toBe('uploaded');
  });
});

describe('D3: no secret anywhere', () => {
  it('in no answer, no log line and no row of any table', () => {
    const db = w.stack.db;
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    const found: string[] = [];
    const check = (where: string, text: string) => {
      for (const s of secrets) if (text.includes(s)) found.push(`${where}: ${s.slice(9, 20)}`);
      // A capability split by escaping (JSON or URL encoding) is still a leak.
      for (const s of secrets)
        if (text.includes(encodeURIComponent(s)) && !text.includes(s)) found.push(`${where} (encoded)`);
    };
    for (const t of tables) {
      let rows: unknown[];
      try {
        rows = db.prepare(`SELECT * FROM "${t}"`).all();
      } catch {
        continue;
      }
      check(
        `table ${t}`,
        JSON.stringify(rows, (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString('latin1') : v)),
      );
    }
    check('logs', logs.join('\n'));
    check('answers', answers.join('\n'));
    expect(secrets.length).toBeGreaterThanOrEqual(13);
    expect(logs.length, 'the log sink caught the calls').toBeGreaterThan(10);
    expect(found).toEqual([]);
  });
});
