/**
 * CR2 images, attacks A1 to A7 (SSRF through the guarded transport of src/mcp/tools/upload-http.ts, which every outside
 * download goes through: `upload_image`'s `url` and `file.download_url`, the signed-URL PUT, and `downloadAsset`'s asset
 * hosts). Against local https servers only: 127.0.0.1 plays an internal service, and 127.0.0.2 plays a PUBLIC host (the
 * test seam `allowAddress` admits exactly that address, as the image world admits 127.0.0.1). Nothing here leaves the
 * machine: every refused address is refused before a connection, and every allowed one is a loopback test server.
 *
 * The safe behaviour in every case: refused, and the internal server never sees a request.
 */
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOutboundPortAllowlist } from '../../../src/auth/ports.js';
import {
  checkTargetUrl,
  createUploadTransport,
  fetchImage,
  UploadHttpError,
  type GuardOptions,
} from '../../../src/mcp/tools/upload-http.js';
import { BridgeLkError } from '../../../src/lk/index.js';
import { certificate, fixture } from '../../images/world.js';

const PNG = fixture('alpha.png');
let port = 0;
const internalHits: string[] = [];
const publicHits: string[] = [];
let internal: Server;
let publicHost: Server;

beforeAll(async () => {
  const { key, cert } = certificate();
  internal = createServer({ key, cert }, (req, res) => {
    internalHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
  port = (internal.address() as AddressInfo).port;
  publicHost = createServer({ key, cert }, (req, res) => {
    publicHits.push(`${req.method} ${req.url}`);
    const u = req.url ?? '';
    if (u.startsWith('/go?to=')) {
      res.writeHead(302, { location: decodeURIComponent(u.slice(7)) }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  });
  // The same port on another loopback address, so one allow-list entry covers both.
  await new Promise<void>((r) => publicHost.listen(port, '127.0.0.2', r));
});
afterAll(async () => {
  for (const s of [internal, publicHost]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** The guard as the bridge builds it, with a scripted DNS: each lookup of a name takes the next answer. */
function guard(answers: Record<string, string[][]>): GuardOptions & { lookups: string[] } {
  const lookups: string[] = [];
  const at = new Map<string, number>();
  return {
    lookups,
    resolve: (host) => {
      lookups.push(host);
      const list = answers[host] ?? [];
      const i = at.get(host) ?? 0;
      at.set(host, i + 1);
      const pick = list[Math.min(i, list.length - 1)] ?? [];
      return Promise.resolve(pick.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    },
    ca: certificate().cert,
    allowAddress: (a) => a === '127.0.0.2',
    allowedPorts: parseOutboundPortAllowlist(`assets.test:${port},storage.test:${port}`),
  };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'fetched';
  } catch (e) {
    if (e instanceof UploadHttpError) return e.reason;
    if (e instanceof BridgeLkError) return e.code ?? 'bridge_error';
    return `other:${(e as Error).message}`;
  }
};

describe('A1: literal addresses in every spelling', () => {
  const literals = [
    'https://127.0.0.1/x',
    'https://127.1/x',
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://0x7f.0.0.1/x',
    'https://0177.0.0.1/x',
    'https://017700000001/x',
    'https://127.0.0.1./x',
    'https://１２７．０．０．１/x',
    'https://127.0.0.1%2e/x',
    'https://0/x',
    'https://0.0.0.0/x',
    'https://10.0.0.1/x',
    'https://100.64.0.1/x',
    'https://100.100.100.200/x', // Alibaba metadata (CGNAT range)
    'https://169.254.169.254/latest/meta-data/',
    'https://2852039166/latest/meta-data/',
    'https://0251.0376.0251.0376/latest/meta-data/',
    'https://172.16.0.1/x',
    'https://192.168.1.1/x',
    'https://192.0.0.192/x', // Oracle metadata
    'https://198.18.0.1/x',
    'https://224.0.0.1/x',
    'https://255.255.255.255/x',
    'https://[::1]/x',
    'https://[::]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[0:0:0:0:0:ffff:169.254.169.254]/x',
    'https://[::127.0.0.1]/x',
    'https://[64:ff9b::127.0.0.1]/x',
    'https://[64:ff9b:1::a9fe:a9fe]/x',
    'https://[fc00::1]/x',
    'https://[fd00:ec2::254]/x', // AWS IPv6 metadata
    'https://[fe80::1]/x',
    'https://[fec0::1]/x',
    'https://[ff02::1]/x',
    'https://[2002:7f00:1::1]/x', // 6to4 of 127.0.0.1
    'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x', // Teredo
    'https://[100::1]/x',
  ];
  it.each(literals)('%s is refused before any DNS lookup or connection', (u) => {
    const g = guard({});
    let reason = 'accepted';
    try {
      checkTargetUrl(u, { ...g, allowAddress: () => false });
    } catch (e) {
      reason = e instanceof UploadHttpError ? e.reason : 'other';
    }
    expect(reason).toBe('blocked_address');
    expect(g.lookups).toEqual([]);
  });

  it('non-https schemes, URL credentials and other ports are refused', () => {
    for (const [u, want] of [
      ['http://example.org/x', 'invalid_url'],
      ['ftp://example.org/x', 'invalid_url'],
      ['file:///etc/passwd', 'invalid_url'],
      ['data:image/png;base64,AAAA', 'invalid_url'],
      ['gopher://127.0.0.1:6379/_INFO', 'invalid_url'],
      ['https://user:pass@example.org/x', 'invalid_url'],
      ['https://user@example.org/x', 'invalid_url'],
      ['https://example.org:8443/x', 'blocked_port'],
      ['https://example.org:80/x', 'blocked_port'],
      ['https://example.org:22/x', 'blocked_port'],
    ] as const) {
      let reason = 'accepted';
      try {
        checkTargetUrl(u, {});
      } catch (e) {
        reason = e instanceof UploadHttpError ? e.reason : 'other';
      }
      expect(reason, u).toBe(want);
    }
  });
});

describe('A2: DNS answers (the address checked is the address connected)', () => {
  it.each([
    [['127.0.0.1']],
    [['127.0.0.2', '127.0.0.1']], // one good, one bad
    [['::ffff:127.0.0.1']],
    [['::ffff:7f00:1']],
    [['64:ff9b::7f00:1']],
    [['0.0.0.0']],
    [['169.254.169.254']],
    [['::1']],
    [['fe80::1%lo']],
    [[]],
  ])('answer %j: refused, nothing reaches the internal service', async (answer) => {
    const before = internalHits.length;
    const g = guard({ 'assets.test': [answer] });
    const r = await reasonOf(
      fetchImage(`https://assets.test:${port}/img`, { ...g, maxBytes: 1e6, timeoutMs: 5000 }),
    );
    expect(['blocked_address', 'dns']).toContain(r);
    expect(internalHits.length).toBe(before);
  });

  it('DNS rebinding across a redirect: the second hop re-resolves to the internal address and is refused', async () => {
    const before = internalHits.length;
    const pubBefore = publicHits.length;
    // First lookup: the "public" address; every later lookup of the same name: the internal one.
    const g = guard({ 'assets.test': [['127.0.0.2'], ['127.0.0.1']] });
    const target = encodeURIComponent(`https://assets.test:${port}/img`);
    const r = await reasonOf(
      fetchImage(`https://assets.test:${port}/go?to=${target}`, { ...g, maxBytes: 1e6, timeoutMs: 5000 }),
    );
    expect(publicHits.length).toBe(pubBefore + 1);
    expect(r).toBe('blocked_address');
    expect(internalHits.length).toBe(before);
  });

  it('the signed PUT: the early check sees a public answer, the connection gets the internal one: refused', async () => {
    const before = internalHits.length;
    const g = guard({ 'storage.test': [['127.0.0.2'], ['127.0.0.1']] });
    // The early, advisory check (assertPublicTarget) is what the PUT step runs first; it uses the first answer.
    const { assertPublicTarget } = await import('../../../src/mcp/tools/upload-http.js');
    await assertPublicTarget(`https://storage.test:${port}/put/k1`, g);
    const transport = createUploadTransport({
      ...g,
      lkOrigin: 'https://lk.invalid',
      lk: () => Promise.reject(new Error('not the LK host')),
      assetHosts: ['assets.test'],
      timeoutMs: 5000,
    });
    const r = await reasonOf(
      transport(`https://storage.test:${port}/put/k1`, { method: 'PUT', body: new Uint8Array(PNG) }),
    );
    expect(r).toBe('UPLOAD_TARGET_REFUSED');
    expect(internalHits.length).toBe(before);
  });

  it('an asset-host GET whose name now resolves to the internal address is refused', async () => {
    const before = internalHits.length;
    const g = guard({ 'assets.test': [['127.0.0.1']] });
    const transport = createUploadTransport({
      ...g,
      lkOrigin: 'https://lk.invalid',
      lk: () => Promise.reject(new Error('not the LK host')),
      assetHosts: ['assets.test'],
      timeoutMs: 5000,
    });
    const r = await reasonOf(transport(`https://assets.test:${port}/a/x.webp`, { method: 'GET' }));
    expect(r).toBe('UPLOAD_TARGET_REFUSED');
    expect(internalHits.length).toBe(before);
  });
});

describe('A3: redirects (each hop checked like the first)', () => {
  const hop = (to: string) => `https://assets.test:${port}/go?to=${encodeURIComponent(to)}`;
  it.each([
    ['to a private literal', 'https://127.0.0.1/img', 'blocked_address'],
    ['to the metadata address (decimal)', 'https://2852039166/latest/meta-data/', 'blocked_address'],
    ['to IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/img', 'blocked_address'],
    ['to http', 'http://assets.test/img', 'invalid_url'],
    ['to file:', 'file:///etc/passwd', 'invalid_url'],
    ['to credentials', 'https://u:p@assets.test/img', 'invalid_url'],
    ['to another port', 'https://assets.test:6379/img', 'blocked_port'],
    ['to a non-URL', 'https://[::1', 'redirect'],
  ])('%s is refused', async (_what, to, want) => {
    const before = internalHits.length;
    const g = guard({ 'assets.test': [['127.0.0.2']] });
    const r = await reasonOf(fetchImage(hop(to), { ...g, maxBytes: 1e6, timeoutMs: 5000 }));
    expect(r).toBe(want);
    expect(internalHits.length).toBe(before);
  });

  it('four redirects are refused (at most three are followed)', async () => {
    const g = guard({ 'assets.test': [['127.0.0.2']] });
    let url = `https://assets.test:${port}/img`;
    for (let i = 0; i < 4; i++) url = hop(url);
    expect(await reasonOf(fetchImage(url, { ...g, maxBytes: 1e6, timeoutMs: 5000 }))).toBe('redirect');
    let three = `https://assets.test:${port}/img`;
    for (let i = 0; i < 3; i++) three = hop(three);
    expect(await reasonOf(fetchImage(three, { ...g, maxBytes: 1e6, timeoutMs: 5000 }))).toBe('fetched');
  });
});
