import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type JsonFetcher, SafeFetchError, createSafeJsonFetcher } from '../../src/auth/safe-fetch.js';
import {
  Browser,
  type TestBridge,
  authorizeAndApprove,
  authorizeUrl,
  mcpPost,
  pkcePair,
  reachConsent,
  startBridge,
  tokenRequest,
} from './helpers.js';

/**
 * Requirement 4 (Client ID Metadata Documents): a real HTTPS document server on loopback with a
 * throwaway certificate, reached through the production SSRF-safe fetcher. Only the DNS answer
 * and the trust store are test seams; loopback is allowed for the test host explicitly.
 */

let dir: string;
let cert: string;
let docServer: Server;
let port: number;
const hits = new Map<string, number>();

const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';

function cimdUrl(path: string): string {
  return `https://cimd.test:${port}${path}`;
}

function claudeCodeDoc(clientId: string) {
  return {
    client_id: clientId,
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-cimd-'));
  // Throwaway self-signed certificate, generated per run; never committed.
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
      '/CN=cimd.test',
      '-addext',
      'subjectAltName=DNS:cimd.test',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  docServer = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const json = (body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    switch (path) {
      case '/cached':
        return json(claudeCodeDoc(cimdUrl('/cached')), { 'cache-control': 'max-age=3600' });
      case '/nostore':
        return json(claudeCodeDoc(cimdUrl('/nostore')), { 'cache-control': 'no-store' });
      case '/mismatch':
        return json(claudeCodeDoc(cimdUrl('/somewhere-else')));
      case '/secret':
        return json({ ...claudeCodeDoc(cimdUrl('/secret')), client_secret: 'nope' });
      case '/confidential':
        return json({
          ...claudeCodeDoc(cimdUrl('/confidential')),
          token_endpoint_auth_method: 'client_secret_basic',
        });
      case '/evil-redirects':
        return json({
          ...claudeCodeDoc(cimdUrl('/evil-redirects')),
          redirect_uris: ['https://evil.example/cb'],
        });
      case '/hosted':
        return json({
          ...claudeCodeDoc(cimdUrl('/hosted')),
          client_name: 'Claude <script>alert(1)</script>',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        });
      case '/redirect':
        res.writeHead(302, { location: '/cached' });
        return res.end();
      case '/html':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html></html>');
      case '/big':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ...claudeCodeDoc(cimdUrl('/big')), padding: 'x'.repeat(100_000) }));
      case '/not-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{not json');
      case '/slow':
        return; // never answers
      case '/404':
        res.writeHead(404);
        return res.end();
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((r) => docServer.listen(0, '127.0.0.1', () => r()));
  port = (docServer.address() as AddressInfo).port;
});

afterAll(async () => {
  docServer.closeAllConnections();
  await new Promise<void>((r) => docServer.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const toLoopback = (host: string) =>
  Promise.resolve(host.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 }] : []);

/** The production fetcher, with the test host's DNS answer and CA, and loopback allowed for it. */
function testFetcher(timeoutMs = 400): JsonFetcher {
  return createSafeJsonFetcher({
    timeoutMs,
    maxBytes: 8192,
    resolve: toLoopback,
    ca: cert,
    allowAddress: (a) => a === '127.0.0.1',
  });
}

describe('CIMD end to end', () => {
  let bridge: TestBridge;
  beforeAll(async () => {
    bridge = await startBridge({ authOverrides: { fetchJson: testFetcher() } });
  });
  afterAll(() => bridge.close());

  it('authorises a client identified by its metadata URL, with loopback redirects on any port', async () => {
    const clientId = cimdUrl('/cached');
    const redirectUri = 'http://localhost:51234/callback';
    const browser = new Browser(bridge);
    const { verifier, challenge } = pkcePair();
    const page = await reachConsent(
      browser,
      authorizeUrl({
        clientId,
        redirectUri,
        challenge,
        method: 'S256',
        scope: 'mcp offline_access',
        resource: bridge.mcpUrl,
      }),
    );
    if (page instanceof Response) throw new Error(`no consent: ${page.status} ${await page.text()}`);
    // The consent page names the host that serves the document, then the self-asserted name.
    expect(page.html).toContain('<p class="host">cimd.test</p>');
    expect(page.html).toContain('It calls itself “Claude Code”');
    expect(page.html).toContain('<p class="host">localhost (this computer)</p>');
    expect(page.html).toContain('only accepts sign-ins on your own computer');
    const res = await browser.post(`${bridge.publicUrl}/oauth/consent`, {
      request_id: page.requestId,
      csrf_token: page.csrf,
      decision: 'approve',
    });
    const cb = new URL(res.headers.get('location') as string);
    expect(cb.origin).toBe('http://localhost:51234');

    // Public client: no secret at the token endpoint.
    const t = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') ?? undefined,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      resource: bridge.mcpUrl,
    });
    expect(t.res.status).toBe(200);
    expect((await mcpPost(bridge, t.body.access_token as string)).status).toBe(200);
    const r = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token as string,
      client_id: clientId,
    });
    expect(r.res.status).toBe(200);
    // A secret is refused for a public client.
    const withSecret = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: r.body.refresh_token as string,
      client_id: clientId,
      client_secret: 'x',
    });
    expect(withSecret.res.status).toBe(401);
    expect(withSecret.body.error).toBe('invalid_client');
  });

  it('caches the document per Cache-Control and re-fetches once it is stale', async () => {
    const clientId = cimdUrl('/cached');
    const before = hits.get('/cached') ?? 0;
    const browser = new Browser(bridge);
    await authorizeAndApprove(browser, {
      clientId,
      redirectUri: 'http://127.0.0.1:1/callback',
      challenge: pkcePair().challenge,
      method: 'S256',
    });
    expect(hits.get('/cached') ?? 0).toBe(before); // still fresh from the first test
    bridge.clock.advance(3601);
    try {
      await authorizeAndApprove(browser, {
        clientId,
        redirectUri: 'http://127.0.0.1:2/callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      });
      expect(hits.get('/cached')).toBe(before + 1);
    } finally {
      bridge.clock.advance(-3601);
    }
  });

  it('re-fetches a no-store document on every authorization', async () => {
    const clientId = cimdUrl('/nostore');
    const browser = new Browser(bridge);
    await browser.login(); // so each authorization is exactly one request
    for (let i = 1; i <= 2; i++) {
      await authorizeAndApprove(browser, {
        clientId,
        redirectUri: 'http://127.0.0.1:3/callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      });
      expect(hits.get('/nostore')).toBe(i);
    }
  });

  it.each([
    ['/mismatch', /does not match/],
    ['/secret', /secret/],
    ['/confidential', /none/],
    ['/evil-redirects', /redirect URI/],
    ['/redirect', /could not be fetched/],
    ['/html', /could not be fetched/],
    ['/big', /could not be fetched/],
    ['/not-json', /could not be fetched/],
    ['/404', /could not be fetched/],
  ])('refuses %s with an error page and no redirect', async (path, message) => {
    const res = await new Browser(bridge).request(
      authorizeUrl({
        clientId: cimdUrl(path),
        redirectUri: 'http://127.0.0.1:4/callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toMatch(message);
  });

  it('gives up on a slow document server quickly, well inside the 10-second budget', async () => {
    const t0 = performance.now();
    const res = await new Browser(bridge).request(
      authorizeUrl({
        clientId: cimdUrl('/slow'),
        redirectUri: 'http://127.0.0.1:4/callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    const ms = performance.now() - t0;
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/No complete response/);
    expect(ms).toBeLessThan(2000);
  });

  it('refuses a redirect URI the document does not list, and escapes the self-asserted name', async () => {
    const clientId = cimdUrl('/hosted');
    const wrong = await new Browser(bridge).request(
      authorizeUrl({
        clientId,
        redirectUri: 'http://127.0.0.1:4/callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    expect(wrong.status).toBe(400);
    const page = await reachConsent(
      new Browser(bridge),
      authorizeUrl({
        clientId,
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    if (page instanceof Response) throw new Error('expected consent');
    expect(page.html).not.toContain('<script>');
    expect(page.html).toContain('&#60;script&#62;');
    expect(page.html).not.toContain('only accepts sign-ins on your own computer');
  });

  it('refuses malformed client_id URLs before fetching anything', async () => {
    const before = [...hits.values()].reduce((a, b) => a + b, 0);
    for (const clientId of [
      `https://cimd.test:${port}/a/../cached`,
      `https://cimd.test:${port}/cached#x`,
      `https://cimd.test:${port}/`,
    ]) {
      const res = await new Browser(bridge).request(
        authorizeUrl({
          clientId,
          redirectUri: 'http://127.0.0.1:4/callback',
          challenge: pkcePair().challenge,
          method: 'S256',
        }),
      );
      expect(res.status, clientId).toBe(400);
    }
    expect([...hits.values()].reduce((a, b) => a + b, 0)).toBe(before);
  });
});

describe('Claude Code’s published client_id', () => {
  it('connects with https://claude.ai/oauth/claude-code-client-metadata and an ephemeral loopback port', async () => {
    let fetched = 0;
    const stub: JsonFetcher = (url) => {
      fetched++;
      expect(url).toBe(CLAUDE_CODE_CIMD);
      return Promise.resolve({
        body: claudeCodeDoc(CLAUDE_CODE_CIMD),
        headers: { 'cache-control': 'max-age=300' },
      });
    };
    const bridge = await startBridge({ authOverrides: { fetchJson: stub } });
    try {
      const redirectUri = 'http://localhost:3118/callback';
      const { verifier, challenge } = pkcePair();
      const cb = await authorizeAndApprove(new Browser(bridge), {
        clientId: CLAUDE_CODE_CIMD,
        redirectUri,
        challenge,
        method: 'S256',
        scope: 'mcp offline_access',
        resource: bridge.mcpUrl,
      });
      const t = await tokenRequest(bridge, {
        grant_type: 'authorization_code',
        code: cb.searchParams.get('code') ?? undefined,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: CLAUDE_CODE_CIMD,
        resource: bridge.mcpUrl,
      });
      expect(t.res.status).toBe(200);
      expect(t.body.refresh_token).toBeTypeOf('string');
      expect((await mcpPost(bridge, t.body.access_token as string)).status).toBe(200);
      expect(fetched).toBe(1);
    } finally {
      await bridge.close();
    }
  });
});

describe('SSRF protection in the metadata fetcher', () => {
  const production = (resolve?: (h: string) => Promise<{ address: string; family: number }[]>) =>
    createSafeJsonFetcher({ timeoutMs: 400, maxBytes: 8192, ca: cert, ...(resolve ? { resolve } : {}) });

  const reason = async (fetcher: JsonFetcher, url: string) => {
    try {
      await fetcher(url);
      return 'ok';
    } catch (e) {
      return e instanceof SafeFetchError ? e.reason : `other: ${(e as Error).message}`;
    }
  };

  it('refuses hosts that resolve to loopback, private, link-local or CGNAT addresses', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.10',
      '169.254.169.254',
      '100.64.1.1',
      '::1',
      'fd00::1',
    ]) {
      const f = production(() => Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]));
      expect(await reason(f, cimdUrl('/cached')), address).toBe('blocked_address');
    }
  });

  it('refuses a host with any non-public address among public ones', async () => {
    const f = production(() =>
      Promise.resolve([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    );
    expect(await reason(f, cimdUrl('/cached'))).toBe('blocked_address');
  });

  it('refuses IP-literal URLs for non-public addresses, and real DNS for localhost', async () => {
    const f = production();
    expect(await reason(f, `https://127.0.0.1:${port}/cached`)).toBe('blocked_address');
    expect(await reason(f, `https://[::1]:${port}/cached`)).toBe('blocked_address');
    expect(await reason(f, 'https://169.254.169.254/latest/meta-data')).toBe('blocked_address');
    expect(await reason(f, `https://localhost:${port}/cached`)).toBe('blocked_address');
    expect(await reason(f, 'http://example.com/x')).toBe('invalid_url');
  });

  it('enforces the timeout, size cap, redirect ban and content type', async () => {
    const f = testFetcher(300);
    const t0 = performance.now();
    expect(await reason(f, cimdUrl('/slow'))).toBe('timeout');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(await reason(f, cimdUrl('/big'))).toBe('too_large');
    expect(await reason(f, cimdUrl('/redirect'))).toBe('redirect');
    expect(await reason(f, cimdUrl('/html'))).toBe('bad_content_type');
    expect(await reason(f, cimdUrl('/not-json'))).toBe('invalid_json');
    expect(await reason(f, cimdUrl('/404'))).toBe('bad_status');
    expect(await reason(f, cimdUrl('/cached'))).toBe('ok');
  });

  it('verifies TLS: an untrusted certificate is refused', async () => {
    const f = createSafeJsonFetcher({
      timeoutMs: 400,
      maxBytes: 8192,
      resolve: toLoopback,
      allowAddress: (a) => a === '127.0.0.1',
    });
    expect(await reason(f, cimdUrl('/cached'))).toBe('network');
  });
});
