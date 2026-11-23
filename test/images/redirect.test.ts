/**
 * v2 E5.2 (ADR 0041, ADR 0046 decision 11): an asset download follows LegendKeeper's redirect from `assets` to `assets2`
 * and nowhere else. Each hop is checked like the first (https, no credentials, an asset host; the transport's address,
 * port and pinned-DNS guards on its own request), goes through the governor, and carries no credential. The API client
 * and the upload PUT still refuse every redirect.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseOutboundPortAllowlist } from '../../src/auth/ports.js';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { AssetDownloadError, downloadAsset, MAX_ASSET_REDIRECTS } from '../../src/images/download.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { createUploadTransport } from '../../src/mcp/tools/upload-http.js';
import { SafeFetchError, createSafeJsonFetcher } from '../../src/auth/safe-fetch.js';

const HOSTS = ['assets.test', 'assets2.test'];
const FILE = Buffer.from('RIFF\0\0\0\0WEBPVP8 the final bytes');

interface Seen {
  readonly host: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, unknown>;
}

let server: Server;
let port = 0;
let ca = '';
const seen: Seen[] = [];
/** `host path` → what to answer. */
let routes = new Map<string, { status: number; location?: string; body?: Buffer }>();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-redirect-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=assets.test',
      '-addext',
      'subjectAltName=DNS:assets.test,DNS:assets2.test,DNS:elsewhere.test,DNS:storage.test',
    ],
    { stdio: 'ignore' },
  );
  const key = readFileSync(join(dir, 'key.pem'));
  ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  server = createServer({ key, cert: ca }, (req, res) => {
    req.resume();
    req.on('end', () => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const path = req.url ?? '';
      seen.push({ host, path, method: req.method ?? '', headers: { ...req.headers } });
      const r = routes.get(`${host} ${path}`);
      if (!r) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      const headers: Record<string, string | number> = { 'content-length': r.body?.length ?? 0 };
      if (r.location !== undefined) headers.location = r.location;
      if (r.body) headers['content-type'] = 'image/webp';
      res.writeHead(r.status, headers);
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
  routes = new Map();
});

const at = (host: string, path: string) => `https://${host}:${port}${path}`;
const lkSeen: string[] = [];

/** A project client whose transport is the production one: the API host to a stub, everything else guarded. */
function client(): LkClient {
  const guard = {
    resolve: (h: string) =>
      Promise.resolve(h.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 as const }] : []),
    ca,
    allowAddress: (a: string) => a === '127.0.0.1',
    allowedPorts: parseOutboundPortAllowlist(
      ['assets.test', 'assets2.test', 'elsewhere.test', 'storage.test'].map((h) => `${h}:${port}`).join(','),
    ),
  };
  return createLkClient({
    apiKey: 'test-key-not-real',
    projectId: 'proj_test',
    baseUrl: 'http://mock-lk.test',
    governor: defaultGovernorSettings(),
    transport: createUploadTransport({
      ...guard,
      lkOrigin: 'http://mock-lk.test',
      assetHosts: HOSTS,
      lk: (input) => {
        lkSeen.push(input instanceof Request ? input.url : input.toString());
        // The API answers a redirect: the governor must refuse it, not follow it.
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: at('assets2.test', '/elsewhere') } }),
        );
      },
    }),
  });
}

const download = (url: string, hosts: readonly string[] = HOSTS) =>
  downloadAsset(client(), url, { hosts, priority: 'P2', opId: 'test.download' });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('an asset download follows a redirect between asset hosts (E5.2)', () => {
  it('a 302 from assets to assets2 downloads; the SHA-256 is of the final bytes; the URL asked for is unchanged', async () => {
    routes.set('assets.test /29086abf.webp', {
      status: 302,
      location: at('assets2.test', '/29086abf.webp'),
    });
    routes.set('assets2.test /29086abf.webp', { status: 200, body: FILE });
    const got = await download(at('assets.test', '/29086abf.webp'));
    expect(got.sha256).toBe(sha(FILE));
    expect(got.bytes.equals(FILE)).toBe(true);
    expect(got.finalUrl).toBe(at('assets2.test', '/29086abf.webp'));
    expect(seen.map((s) => `${s.host} ${s.path}`)).toEqual([
      'assets.test /29086abf.webp',
      'assets2.test /29086abf.webp',
    ]);
  });

  it('v3 F7b (ADR 0071): a download counted as one read costs one read, its redirect hop included; none by default', async () => {
    routes.set('assets.test /counted.webp', { status: 302, location: at('assets2.test', '/counted.webp') });
    routes.set('assets2.test /counted.webp', { status: 200, body: FILE });
    const lk = client();
    const used = () => lk.governor.snapshot().tiers['key-day'].used;
    await downloadAsset(lk, at('assets.test', '/counted.webp'), {
      hosts: HOSTS,
      priority: 'P1',
      opId: 'test.download',
    });
    expect(used()).toBe(0);
    await downloadAsset(lk, at('assets.test', '/counted.webp'), {
      hosts: HOSTS,
      priority: 'P1',
      opId: 'test.download',
      costs: { tiers: ['key-min', 'key-hour', 'key-day', 'project-hour'] },
    });
    expect(used()).toBe(1);
  });

  it('a file served directly has no final URL of its own', async () => {
    routes.set('assets.test /direct.webp', { status: 200, body: FILE });
    const got = await download(at('assets.test', '/direct.webp'));
    expect(got.finalUrl).toBeUndefined();
    expect(got.sha256).toBe(sha(FILE));
  });

  it('every redirect status with a Location is followed (301, 303, 307, 308)', async () => {
    for (const status of [301, 303, 307, 308]) {
      routes.set(`assets.test /s${status}`, { status, location: at('assets2.test', `/s${status}`) });
      routes.set(`assets2.test /s${status}`, { status: 200, body: FILE });
      expect((await download(at('assets.test', `/s${status}`))).sha256).toBe(sha(FILE));
    }
  });

  it('a relative Location is resolved against the URL that answered', async () => {
    routes.set('assets.test /a/one.webp', { status: 302, location: '../b/one.webp' });
    routes.set('assets.test /b/one.webp', { status: 200, body: FILE });
    const got = await download(at('assets.test', '/a/one.webp'));
    expect(got.finalUrl).toBe(at('assets.test', '/b/one.webp'));
    expect(got.sha256).toBe(sha(FILE));
  });

  it('a redirect to a host not on the list is refused, naming the host; nothing is asked of it', async () => {
    routes.set('assets.test /x.webp', { status: 302, location: at('elsewhere.test', '/x.webp') });
    routes.set('elsewhere.test /x.webp', { status: 200, body: FILE });
    const e = await download(at('assets.test', '/x.webp')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AssetDownloadError);
    expect(e).toMatchObject({ reason: 'redirect' });
    expect((e as Error).message).toMatch(/elsewhere\.test, which is not an asset host/);
    expect(seen.map((s) => s.host)).toEqual(['assets.test']);
  });

  it('a redirect to assets2 is refused when assets2 is not in LK_ASSET_HOSTS (a set list is kept as it is)', async () => {
    routes.set('assets.test /y.webp', { status: 302, location: at('assets2.test', '/y.webp') });
    const e = await download(at('assets.test', '/y.webp'), ['assets.test']).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/assets2\.test, which is not an asset host/);
    expect(seen).toHaveLength(1);
  });

  it('an http: Location is refused (and so is one with credentials)', async () => {
    routes.set('assets.test /h.webp', { status: 302, location: `http://assets2.test:${port}/h.webp` });
    const e = await download(at('assets.test', '/h.webp')).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'redirect' });
    expect((e as Error).message).toMatch(/http URL on assets2\.test; only https is followed/);
    routes.set('assets.test /c.webp', {
      status: 302,
      location: `https://user:pw@assets2.test:${port}/c.webp`,
    });
    const e2 = await download(at('assets.test', '/c.webp')).catch((x: unknown) => x);
    expect((e2 as Error).message).toMatch(/credentials/);
    expect(seen.every((s) => s.host === 'assets.test')).toBe(true);
  });

  it('a redirect loop is refused', async () => {
    routes.set('assets.test /l1', { status: 302, location: at('assets2.test', '/l2') });
    routes.set('assets2.test /l2', { status: 302, location: at('assets.test', '/l1') });
    const e = await download(at('assets.test', '/l1')).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'redirect' });
    expect((e as Error).message).toMatch(/loop/);
    expect(seen).toHaveLength(2);
  });

  it(`${MAX_ASSET_REDIRECTS} redirects are followed; the 4th is refused`, async () => {
    // Three redirects, then the file: followed.
    routes = new Map([
      ['assets.test /t1', { status: 302, location: at('assets2.test', '/t2') }],
      ['assets2.test /t2', { status: 302, location: at('assets.test', '/t3') }],
      ['assets.test /t3', { status: 302, location: at('assets2.test', '/t4') }],
      ['assets2.test /t4', { status: 200, body: FILE }],
    ]);
    expect((await download(at('assets.test', '/t1'))).sha256).toBe(sha(FILE));
    expect(seen).toHaveLength(4);
    // Four redirects: refused at the 4th, which is never followed.
    seen.length = 0;
    routes.set('assets.test /f1', { status: 302, location: at('assets2.test', '/f2') });
    routes.set('assets2.test /f2', { status: 302, location: at('assets.test', '/f3') });
    routes.set('assets.test /f3', { status: 302, location: at('assets2.test', '/f4') });
    routes.set('assets2.test /f4', { status: 302, location: at('assets.test', '/f5') });
    routes.set('assets.test /f5', { status: 200, body: FILE });
    const e = await download(at('assets.test', '/f1')).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'redirect' });
    expect((e as Error).message).toMatch(/more than 3 redirects/);
    expect(seen.map((s) => s.path)).toEqual(['/f1', '/f2', '/f3', '/f4']);
  });

  it('a redirect without a Location is refused, and its empty body is never taken for the asset', async () => {
    routes.set('assets.test /n.webp', { status: 302 });
    const e = await download(at('assets.test', '/n.webp')).catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: 'redirect' });
    expect((e as Error).message).toMatch(/HTTP 302 with no Location/);
  });

  it('no Authorization header, cookie or key is sent on any hop', async () => {
    routes.set('assets.test /k.webp', { status: 302, location: at('assets2.test', '/k.webp') });
    routes.set('assets2.test /k.webp', { status: 200, body: FILE });
    await download(at('assets.test', '/k.webp'));
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.headers.cookie).toBeUndefined();
      expect(JSON.stringify(s.headers)).not.toContain('test-key-not-real');
    }
  });

  it('each hop goes through the governor (two hops, two governed requests)', async () => {
    routes.set('assets.test /g.webp', { status: 302, location: at('assets2.test', '/g.webp') });
    routes.set('assets2.test /g.webp', { status: 200, body: FILE });
    const c = client();
    const executed: string[] = [];
    const exec = c.governor.execute.bind(c.governor);
    (c.governor as { execute: typeof exec }).execute = (req) => {
      executed.push(req.opId);
      return exec(req);
    };
    await downloadAsset(c, at('assets.test', '/g.webp'), { hosts: HOSTS, priority: 'P2', opId: 'test.gov' });
    expect(executed).toEqual(['test.gov', 'test.gov']);
  });
});

describe('everything else still refuses redirects (E5.2)', () => {
  it('the API client: a 302 from LegendKeeper is an error, and is not followed', async () => {
    const c = client();
    lkSeen.length = 0;
    const e = await c
      .call({
        operationId: 'getResource',
        priority: 'P1',
        run: (sdk, signal) => sdk.resources.get({ projectId: c.projectId, resourceId: 'r1' }, { signal }),
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(lkSeen).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('the upload PUT: a 302 from the storage host is an error, and is not followed', async () => {
    routes.set('storage.test /put', { status: 302, location: at('assets2.test', '/put') });
    const c = client();
    const e = await c.governor
      .execute({
        opId: 'test.put',
        kind: 'write',
        costs: { tiers: [] },
        priority: 'P2',
        run: (signal) => c.fetch(at('storage.test', '/put'), { method: 'PUT', body: 'x', signal }),
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/HTTP 302/);
    expect(seen.map((s) => s.host)).toEqual(['storage.test']);
  });

  it('a GET to a host that is not an asset host is refused before it is sent', async () => {
    const c = client();
    const e = await c.governor
      .execute({
        opId: 'test.get',
        kind: 'read',
        costs: { tiers: [] },
        priority: 'P2',
        run: (signal) => c.fetch(at('elsewhere.test', '/x.webp'), { method: 'GET', signal }),
      })
      .catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/refused/i);
    expect(seen).toHaveLength(0);
  });

  it('the guarded JSON fetcher (OAuth client metadata) refuses a redirect', async () => {
    routes.set('assets.test /meta.json', { status: 302, location: at('assets2.test', '/meta.json') });
    const fetcher = createSafeJsonFetcher({
      timeoutMs: 5_000,
      maxBytes: 10_000,
      ca,
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      allowAddress: (a) => a === '127.0.0.1',
      allowedPorts: parseOutboundPortAllowlist(`assets.test:${port}`),
    });
    const e = await fetcher(at('assets.test', '/meta.json')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SafeFetchError);
    expect(e).toMatchObject({ reason: 'redirect' });
    expect(seen).toHaveLength(1);
  });
});
