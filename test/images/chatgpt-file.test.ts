/**
 * v3 F2 (ADR 0049 decision 12): `upload_image`'s fifth source, `file`: a ChatGPT conversation attachment, as ChatGPT
 * fills it in (`{ download_url, file_id, mime_type?, file_name? }`; OpenAI Apps SDK, "Define file inputs"). The tool's
 * descriptor carries `_meta["openai/fileParams"]: ["file"]`. The bridge downloads the file during the call through the
 * guarded transport of the `url` source (https, public addresses, the port allow-list, pinned DNS, the size capped while
 * streaming, a timeout, at most 3 redirects each re-checked), at every scope; the magic bytes decide what it is. The
 * download_url is a capability: never logged, stored, journalled or returned. Against a mock file server only.
 */
import { Writable } from 'node:stream';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { fixture, imagesWorld, type ImagesWorld } from './world.js';

let w: ImagesWorld | undefined;
let logs: string[] = [];
afterEach(async () => {
  await w?.close();
  w = undefined;
  logs = [];
});

const sink = () =>
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });

async function world(o: Parameters<typeof imagesWorld>[0] = {}) {
  w = await imagesWorld({ logStream: sink(), ...o });
  return w;
}
const fileUrl = (name: string, host = 'assets.test') => `https://${host}:${w!.port}/f/${name}`;
async function call(args: Record<string, unknown>, token?: string) {
  const c: Client = await w!.stack.connect(token);
  return w!.stack.call(c, 'upload_image', { project: 'test', ...args });
}
const file = (name: string, extra: Record<string, unknown> = {}) => ({
  download_url: fileUrl(name),
  file_id: `file-${name}`,
  ...extra,
});
const code = (r: { body: Record<string, unknown> }) => (r.body.error as { code?: string } | undefined)?.code;

describe('the tool descriptor', () => {
  it('tools/list shows _meta["openai/fileParams"] as ["file"], and the file schema has exactly the four properties', async () => {
    await world();
    const c = await w!.stack.connect();
    const tools = (await c.listTools()).tools;
    const t = tools.find((x) => x.name === 'upload_image')!;
    expect(t._meta).toEqual({ 'openai/fileParams': ['file'] });
    const schema = (t.inputSchema.properties as Record<string, Record<string, unknown>>).file!;
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      'download_url',
      'file_id',
      'file_name',
      'mime_type',
    ]);
    expect(schema.required).toEqual(['download_url', 'file_id']);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('the download', () => {
  it('direct scope: downloaded, staged on the server, then placed; the name comes from file_name, extension dropped', async () => {
    await world();
    w!.files.set('portrait', { status: 200, type: 'application/octet-stream', body: fixture('alpha.png') });
    const r = await call({ file: file('portrait', { file_name: 'Portrait of Rhea.PNG' }), stage: true });
    expect(r.body, r.text).toMatchObject({ status: 'staged', onServer: true, name: 'Portrait of Rhea' });
    expect(r.body.file).toEqual({ id: 'file-portrait', host: `assets.test:${w!.port}` });
    const row = w!.stack.runtime.images.staged(PROJECT, String(r.body.staged_id))!;
    expect(row.source).toBe('chatgpt_file');
    const p = await call({ staged_id: row.id, destination: { folder: 'Characters / Humans' } });
    expect(p.body).toMatchObject({ status: 'placed', placementVerified: true });
  });

  it('propose scope: the bytes are fetched and staged at once; only the placement waits for approval', async () => {
    await world();
    w!.files.set('later', { status: 200, type: 'image/png', body: fixture('alpha.png') });
    const { token } = w!.stack.newToken('chatgpt', 'propose');
    const r = await call(
      { file: file('later'), name: 'Later', destination: { folder: 'Characters / Dwarves' } },
      token,
    );
    expect(r.body).toMatchObject({ status: 'proposal_captured', onServer: true });
    expect(w!.fileStats.requests).toHaveLength(1);
    // The link is dead now; approval still places it (the bytes are on the server).
    w!.files.set('later', { status: 403 });
    const id = String(r.body.proposalId);
    await w!.stack.runtime.policy.commands.approve('owner', id);
    const pol = w!.stack.runtime.policy.proposals;
    for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(pol.get(id)!.state); i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(pol.get(id)!.state).toBe('executed');
  });

  it('a redirect to another public host is followed; to a private address it is refused; the fourth is refused', async () => {
    await world();
    w!.files.set('hop', { status: 302, location: fileUrl('blob', 'storage.test') });
    w!.files.set('blob', { status: 200, body: fixture('alpha.png') });
    const ok = await call({ file: file('hop'), name: 'Hopped', stage: true });
    expect(ok.body, ok.text).toMatchObject({ status: 'staged' });
    expect(w!.fileStats.requests.map((x) => x.split(':')[0])).toEqual(['assets.test', 'storage.test']);

    w!.files.set('private', { status: 302, location: 'https://10.0.0.7/f/blob' });
    expect(code(await call({ file: file('private'), name: 'P', stage: true }))).toBe('UPLOAD_URL_REFUSED');

    for (let i = 1; i <= 4; i++) w!.files.set(`r${i}`, { status: 302, location: fileUrl(`r${i + 1}`) });
    w!.files.set('r5', { status: 200, body: fixture('alpha.png') });
    expect(code(await call({ file: file('r1'), name: 'Far', stage: true }))).toBe('UPLOAD_URL_REFUSED');
  });

  it('an http URL, and a private or loopback address, are refused before anything is fetched', async () => {
    await world();
    for (const download_url of [
      `http://assets.test:${w!.port}/f/x`,
      'https://192.168.1.4/f/x',
      'https://127.0.0.2/f/x',
    ]) {
      const r = await call({ file: { download_url, file_id: 'f1' }, name: 'X', stage: true });
      expect(code(r), download_url).toBe('UPLOAD_URL_REFUSED');
    }
    expect(w!.fileStats.requests).toEqual([]);
  });

  it('an oversize file is refused part-way, before the whole body is read', async () => {
    await world({ tools: { upload: { maxBytes: 64 * 1024 } } as never });
    const big = Buffer.concat([fixture('alpha.png'), Buffer.alloc(8 * 1024 * 1024, 7)]);
    w!.files.set('big', { status: 200, body: big });
    const r = await call({ file: file('big'), name: 'Big', stage: true });
    expect(code(r)).toBe('UPLOAD_TOO_LARGE');
    await new Promise((res) => setTimeout(res, 100));
    expect(w!.fileStats.bytesSent).toBeLessThan(big.length);
  });

  it('mime_type is never trusted: the magic bytes decide', async () => {
    await world();
    w!.files.set('fake', {
      status: 200,
      type: 'image/png',
      body: Buffer.from('not an image at all, honest'),
    });
    const r = await call({ file: file('fake', { mime_type: 'image/png' }), name: 'Fake', stage: true });
    expect(code(r)).toBe('UPLOAD_NOT_AN_IMAGE');
  });

  it('a 403 is FILE_URL_EXPIRED, with the hint, and is never retried', async () => {
    await world();
    w!.files.set('gone', { status: 403 });
    const r = await call({ file: file('gone'), name: 'Gone', stage: true });
    expect(code(r)).toBe('FILE_URL_EXPIRED');
    expect((r.body.error as { hint?: string }).hint).toBe(
      'Call upload_image again with the same attachment so ChatGPT issues a fresh link; if that fails, ask the user to attach the image again.',
    );
    expect(w!.fileStats.requests).toHaveLength(1);
  });
});

describe('the request', () => {
  it('file with another source is refused; a missing name is refused', async () => {
    await world();
    const both = await call({
      file: file('x'),
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'B',
    });
    expect(code(both)).toBe('INVALID_REQUEST');
    expect(String((both.body.error as { message: string }).message)).toMatch(/exactly one source/);
    const nameless = await call({ file: file('x'), stage: true });
    expect(code(nameless)).toBe('INVALID_REQUEST');
    expect(String((nameless.body.error as { message: string }).message)).toMatch(/give name/);
    expect(w!.fileStats.requests).toEqual([]);
  });

  it('download_url appears in no log line, result, journal entry or audit row', async () => {
    await world();
    w!.files.set('secret', { status: 200, body: fixture('alpha.png') });
    const url = `${fileUrl('secret')}?sig=capability-token-123`;
    const r = await call({
      file: { download_url: url, file_id: 'file-secret', file_name: 'Secret.png' },
      destination: { folder: 'Characters / Humans' },
    });
    expect(r.body.status, r.text).toBe('uploaded');
    const needle = 'capability-token-123';
    expect(r.text).not.toContain(needle);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(needle);
    const db = w!.stack.db;
    const journal = JSON.stringify(db.prepare('SELECT * FROM write_journal').all());
    const audit = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    const calls = JSON.stringify(db.prepare('SELECT * FROM tool_calls').all());
    const uploads = JSON.stringify(db.prepare('SELECT * FROM image_uploads').all());
    for (const [what, text] of [
      ['journal', journal],
      ['audit', audit],
      ['tool calls', calls],
      ['uploads', uploads],
    ] as const)
      expect(text.includes(needle), what).toBe(false);
  });
});
