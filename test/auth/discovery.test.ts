import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INIT_BODY,
  MCP_HEADERS,
  PUBLIC_URL,
  type TestBridge,
  mcpPost,
  parseChallenge,
  rpcResult,
  startBridge,
} from './helpers.js';

/** Requirements 1, 2, 3, 10 and 13: discovery, the 401 challenge, and the transport's HTTP shape. */

let bridge: TestBridge;
let pat: string;

beforeAll(async () => {
  bridge = await startBridge();
  pat = bridge.services.pats.create({ name: 'discovery tests' }).token;
});
afterAll(() => bridge.close());

const RESOURCE_METADATA = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;

describe('requirement 1: unauthenticated /mcp gets 401 with the resource_metadata challenge', () => {
  it.each(['POST', 'GET', 'DELETE'])('%s /mcp without a token', async (method) => {
    const res = await bridge.fetch(bridge.mcpUrl, {
      method,
      headers: MCP_HEADERS,
      ...(method === 'POST' ? { body: INIT_BODY } : {}),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`);
  });

  it('answers 401 (not 400 or 200) for malformed, unknown, non-Bearer and query-string credentials', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ authorization: 'Basic dXNlcjpwYXNz' }, ''],
      [{ authorization: 'Bearer' }, ''],
      [{ authorization: 'Bearer not a token' }, 'invalid_token'],
      [{ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' }, 'invalid_token'],
      [{ authorization: 'Bearer lkb_pat_unknown' }, 'invalid_token'],
    ];
    for (const [headers, error] of cases) {
      const res = await bridge.fetch(bridge.mcpUrl, {
        method: 'POST',
        headers: { ...MCP_HEADERS, ...headers },
        body: INIT_BODY,
      });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      const c = parseChallenge(res.headers.get('www-authenticate'));
      expect(c.scheme).toBe('Bearer');
      expect(c.params.resource_metadata).toBe(RESOURCE_METADATA);
      if (error) expect(c.params.error).toBe(error);
    }
    // Tokens are never read from the query string or the body.
    const q = await bridge.fetch(`${bridge.mcpUrl}?access_token=${pat}`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: INIT_BODY,
    });
    expect(q.status).toBe(401);
    expect(q.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`);
  });

  it('accepts a valid bearer token and answers 200 with an MCP result', async () => {
    const res = await mcpPost(bridge, pat);
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const msg = await rpcResult(res);
    expect((msg.result as { serverInfo: { name: string } }).serverInfo.name).toBe('lk-bridge');
  });

  it('accepts the Bearer scheme case-insensitively', async () => {
    const res = await mcpPost(bridge, undefined, INIT_BODY, { authorization: `bearer ${pat}` });
    expect(res.status).toBe(200);
  });
});

describe('requirement 10: the MCP URL never redirects', () => {
  it.each([
    ['POST', '/mcp'],
    ['POST', '/mcp/'],
    ['GET', '/mcp'],
    ['GET', '/mcp/'],
    ['DELETE', '/mcp'],
    ['HEAD', '/mcp'],
  ])('%s %s answers without 3xx, with and without a token', async (method, path) => {
    for (const auth of [undefined, pat]) {
      const res = await bridge.fetch(`${PUBLIC_URL}${path}`, {
        method,
        headers: { ...MCP_HEADERS, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        ...(method === 'POST' ? { body: INIT_BODY } : {}),
      });
      expect(res.status < 300 || res.status >= 400, `${method} ${path} → ${res.status}`).toBe(true);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('answers 405 to GET in stateless mode instead of opening a stream', async () => {
    const res = await bridge.fetch(bridge.mcpUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${pat}`, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
  });
});

describe('Origin validation on /mcp (DNS-rebinding protection)', () => {
  it('refuses a foreign browser Origin with 403 and accepts Claude, loopback and same-origin', async () => {
    const bad = await mcpPost(bridge, pat, INIT_BODY, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    for (const origin of ['https://claude.ai', 'https://claude.com', PUBLIC_URL, 'http://localhost:6274']) {
      const ok = await mcpPost(bridge, pat, INIT_BODY, { origin });
      expect(ok.status, origin).toBe(200);
    }
  });
});

describe('requirement 2: protected-resource metadata (RFC 9728)', () => {
  it.each(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])(
    'is served at %s',
    async (path) => {
      const res = await bridge.fetch(`${PUBLIC_URL}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(`${PUBLIC_URL}/mcp`);
      expect(doc.authorization_servers).toEqual([PUBLIC_URL]);
      expect(doc.scopes_supported).toEqual(['mcp']);
      expect(doc.bearer_methods_supported).toEqual(['header']);
    },
  );

  it('uses the exact MCP URL even when BRIDGE_PUBLIC_URL is written with capitals, a port and a slash', async () => {
    const other = await startBridge({ publicUrl: 'https://LK.Example.TEST:443/' });
    try {
      const doc = (await (
        await other.fetch(`${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`)
      ).json()) as {
        resource: string;
      };
      expect(doc.resource).toBe('https://lk.example.test/mcp');
      const res = await other.fetch(other.mcpUrl, { method: 'POST', headers: MCP_HEADERS, body: INIT_BODY });
      expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${RESOURCE_METADATA}"`);
    } finally {
      await other.close();
    }
  });
});

describe('requirement 3: authorization-server metadata (RFC 8414)', () => {
  it.each(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'])(
    'is served at %s with every field Claude checks',
    async (path) => {
      const res = await bridge.fetch(`${PUBLIC_URL}${path}`);
      expect(res.status).toBe(200);
      const m = (await res.json()) as Record<string, unknown>;
      expect(m.issuer).toBe(PUBLIC_URL);
      expect(m.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
      expect(m.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
      expect(m.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
      expect(m.code_challenge_methods_supported).toEqual(['S256']);
      expect(m.client_id_metadata_document_supported).toBe(true);
      expect(m.token_endpoint_auth_methods_supported).toContain('none');
      expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(m.scopes_supported).toContain('offline_access');
      expect(m.response_types_supported).toEqual(['code']);
      expect(m.authorization_response_iss_parameter_supported).toBe(true);
    },
  );

  it('answers CORS preflight on the metadata, token and registration endpoints', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/register']) {
      const res = await bridge.fetch(`${PUBLIC_URL}${path}`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' },
      });
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('every discovery endpoint answers well under 10 seconds', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      const t0 = performance.now();
      await (await bridge.fetch(`${PUBLIC_URL}${path}`)).text();
      expect(performance.now() - t0, path).toBeLessThan(1000);
    }
  });
});
