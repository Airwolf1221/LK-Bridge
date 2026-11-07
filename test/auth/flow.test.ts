import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFRESH_PREFIX } from '../../src/auth/tokens.js';
import {
  Browser,
  PUBLIC_URL,
  type TestBridge,
  authorizeAndApprove,
  authorizeUrl,
  decide,
  fullFlow,
  mcpPost,
  parseChallenge,
  pkcePair,
  reachConsent,
  registerClient,
  registerPublicClient,
  rpcResult,
  startBridge,
  tokenRequest,
} from './helpers.js';

/**
 * The scripted OAuth client, end to end against a running bridge: requirements 4 (DCR), 5, 6,
 * 7, 8, 9 and 16, positive and negative. The CIMD variants are in cimd.test.ts.
 */

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const secrets: string[] = [];
let bridge: TestBridge;

beforeAll(async () => {
  bridge = await startBridge();
  secrets.push(bridge.password);
});
afterAll(async () => {
  await bridge.close();
});

/** Records every secret a test sees, so the final test can check none reached the logs. */
function remember<T extends Record<string, unknown>>(body: T): T {
  for (const key of ['access_token', 'refresh_token', 'client_secret', 'code']) {
    const v = body[key];
    if (typeof v === 'string') secrets.push(v);
  }
  return body;
}

describe('the claude.ai-equivalent flow (DCR, PKCE, resource, refresh rotation)', () => {
  it('discovers, registers, authorises, exchanges, calls a tool, refreshes and calls again', async () => {
    // 1. Unauthenticated call → 401 → follow resource_metadata.
    const first = await mcpPost(bridge, undefined);
    expect(first.status).toBe(401);
    const challenge = parseChallenge(first.headers.get('www-authenticate'));
    const prm = (await (await bridge.fetch(challenge.params.resource_metadata as string)).json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(prm.resource).toBe(bridge.mcpUrl);
    const issuer = prm.authorization_servers[0] as string;
    const asm = (await (
      await bridge.fetch(`${issuer}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, string>;
    expect(asm.issuer).toBe(issuer);

    // 2. Dynamic client registration, as Claude does it (public client).
    const t0 = performance.now();
    const reg = await registerClient(bridge, {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as Record<string, unknown>;
    expect(client.client_id).toMatch(/^lkb_c_/);
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe('none');
    const clientId = client.client_id as string;

    // 3. Authorization request with PKCE S256, resource, the scopes Claude would request.
    const browser = new Browser(bridge);
    const { verifier, challenge: codeChallenge } = pkcePair();
    const scope = [...prm.scopes_supported, 'offline_access'].join(' ');
    const consent = await reachConsent(
      browser,
      authorizeUrl({
        clientId,
        redirectUri: CLAUDE_CALLBACK,
        challenge: codeChallenge,
        method: 'S256',
        state: 'state-123',
        scope,
        resource: prm.resource,
      }),
    );
    if (consent instanceof Response) throw new Error(`no consent page: ${consent.status}`);
    expect(consent.html).toContain('Claude');
    expect(consent.html).toContain('<p class="host">claude.ai</p>');
    const { location } = await decide(browser, consent, 'approve');
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('iss')).toBe(PUBLIC_URL);
    const code = location.searchParams.get('code') as string;
    secrets.push(code);

    // 4. Token exchange, form-encoded.
    const exchanged = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
      resource: prm.resource,
    });
    expect(exchanged.ms).toBeLessThan(1000);
    expect(exchanged.res.status).toBe(200);
    expect(exchanged.res.headers.get('cache-control')).toBe('no-store');
    const tokens = remember(exchanged.body);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('mcp offline_access');
    expect(String(tokens.refresh_token)).toMatch(new RegExp(`^${REFRESH_PREFIX}`));

    // The access token's audience is the canonical MCP URL.
    const [, payload] = String(tokens.access_token).split('.');
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims.aud).toBe('https://lk.example.test/mcp');
    expect(claims.iss).toBe(PUBLIC_URL);
    expect(claims.client_id).toBe(clientId);

    // 5. Use it.
    const init = await mcpPost(bridge, tokens.access_token as string);
    expect(init.status).toBe(200);
    const call = await mcpPost(
      bridge,
      tokens.access_token as string,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'bridge_info', arguments: {} },
      }),
      { 'mcp-protocol-version': '2025-06-18' },
    );
    expect(call.status).toBe(200);
    const result = (await rpcResult(call)).result as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      bridge: 'LK-Bridge',
      caller: { kind: 'oauth', clientId },
    });

    // 6. Refresh rotates the refresh token and invalidates the old one.
    const refreshed = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
      resource: prm.resource,
    });
    expect(refreshed.ms).toBeLessThan(1000);
    expect(refreshed.res.status).toBe(200);
    const next = remember(refreshed.body);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await mcpPost(bridge, next.access_token as string)).status).toBe(200);

    // Outside the 10-second grace window, the old refresh token is dead.
    bridge.clock.advance(11);
    const again = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token as string,
      client_id: clientId,
    });
    expect(again.res.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    // Reuse of a rotated token revokes the whole grant: the newest tokens stop working too.
    const afterReuse = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token as string,
      client_id: clientId,
    });
    expect(afterReuse.body.error).toBe('invalid_grant');
    const revoked = await mcpPost(bridge, next.access_token as string);
    expect(revoked.status).toBe(401);
    expect(parseChallenge(revoked.headers.get('www-authenticate')).params.error).toBe('invalid_token');
  });
});

describe('requirement 9: loopback redirects on any port (Claude Code)', () => {
  it('accepts http://127.0.0.1/callback and http://localhost/callback on any port', async () => {
    const clientId = await registerPublicClient(bridge, [
      'http://localhost/callback',
      'http://127.0.0.1/callback',
    ]);
    for (const redirectUri of [
      'http://localhost:3118/callback',
      'http://127.0.0.1:49152/callback',
      'http://localhost/callback',
    ]) {
      const { verifier, challenge } = pkcePair();
      const browser = new Browser(bridge);
      const cb = await authorizeAndApprove(browser, { clientId, redirectUri, challenge, method: 'S256' });
      expect(`${cb.origin}${cb.pathname}`).toBe(new URL(redirectUri).origin + '/callback');
      const { res, body } = await tokenRequest(bridge, {
        grant_type: 'authorization_code',
        code: cb.searchParams.get('code') ?? undefined,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: clientId,
      });
      remember(body);
      expect(res.status, redirectUri).toBe(200);
    }
  });

  it('shows the redirect hostname and the loopback-only warning on the consent page', async () => {
    const clientId = await registerPublicClient(bridge, ['http://127.0.0.1/callback']);
    const browser = new Browser(bridge);
    expect((await browser.login()).status).toBe(200);
    const res = await browser.request(
      authorizeUrl({
        clientId,
        redirectUri: 'http://127.0.0.1:5555/callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<p class="host">127.0.0.1 (this computer)</p>');
    expect(html).toContain('only accepts sign-ins on your own computer');
    // The form may post to the bridge and its final redirect may go to that origin, nowhere else.
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1:5555;");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // A hosted (claude.ai) client gets no loopback warning.
    const hosted = await registerPublicClient(bridge, [CLAUDE_CALLBACK]);
    const page = await browser.request(
      authorizeUrl({
        clientId: hosted,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    const hostedHtml = await page.text();
    expect(hostedHtml).toContain('<p class="host">claude.ai</p>');
    expect(hostedHtml).not.toContain('only accepts sign-ins on your own computer');
    expect(hostedHtml).toContain('has not been verified');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai;");
  });

  it('refuses a different path or host on loopback, without redirecting', async () => {
    const clientId = await registerPublicClient(bridge, ['http://127.0.0.1/callback']);
    for (const redirectUri of [
      'http://127.0.0.1:5555/other',
      'http://localhost:5555/callback',
      'http://127.0.0.1:5555/callback/',
    ]) {
      const res = await new Browser(bridge).request(
        authorizeUrl({ clientId, redirectUri, challenge: pkcePair().challenge, method: 'S256' }),
      );
      expect(res.status, redirectUri).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('Invalid redirect');
    }
  });
});

describe('requirement 5: PKCE S256 is mandatory', () => {
  let clientId: string;
  beforeAll(async () => {
    clientId = await registerPublicClient(bridge);
  });

  const errorRedirect = async (params: Parameters<typeof authorizeUrl>[0]) => {
    const browser = new Browser(bridge);
    const res = await browser.request(authorizeUrl(params));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(loc.searchParams.get('iss')).toBe(PUBLIC_URL);
    return loc;
  };

  it('refuses a request with no code_challenge', async () => {
    const loc = await errorRedirect({ clientId, redirectUri: CLAUDE_CALLBACK, state: 's1' });
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('error_description')).toMatch(/code_challenge/);
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('refuses the plain method and a missing method (which defaults to plain)', async () => {
    const { challenge } = pkcePair();
    for (const method of ['plain', undefined, 's256']) {
      const loc = await errorRedirect({
        clientId,
        redirectUri: CLAUDE_CALLBACK,
        challenge,
        ...(method ? { method } : {}),
      });
      expect(loc.searchParams.get('error')).toBe('invalid_request');
    }
  });

  it('refuses a malformed challenge', async () => {
    const loc = await errorRedirect({
      clientId,
      redirectUri: CLAUDE_CALLBACK,
      challenge: 'short',
      method: 'S256',
    });
    expect(loc.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a token request with a wrong or missing code_verifier, and burns the code', async () => {
    const { verifier, challenge } = pkcePair();
    const browser = new Browser(bridge);
    const cb = await authorizeAndApprove(browser, {
      clientId,
      redirectUri: CLAUDE_CALLBACK,
      challenge,
      method: 'S256',
    });
    const code = cb.searchParams.get('code') as string;
    const missing = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
    });
    expect(missing.body.error).toBe('invalid_request');
    const wrong = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: pkcePair().verifier,
    });
    expect(wrong.body.error).toBe('invalid_grant');
    const right = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(right.body.error).toBe('invalid_grant'); // the failed attempt spent the code
  });
});

describe('requirement 6: the resource parameter and canonical audience', () => {
  let clientId: string;
  beforeAll(async () => {
    clientId = await registerPublicClient(bridge);
  });

  it('accepts non-canonical spellings of the MCP URL and issues the canonical audience', async () => {
    const { verifier, challenge } = pkcePair();
    const browser = new Browser(bridge);
    const cb = await authorizeAndApprove(browser, {
      clientId,
      redirectUri: CLAUDE_CALLBACK,
      challenge,
      method: 'S256',
      resource: 'HTTPS://LK.EXAMPLE.TEST:443/mcp/',
    });
    const { body } = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') ?? undefined,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
      resource: 'https://lk.example.test/mcp#ignored',
    });
    remember(body);
    const [, payload] = String(body.access_token).split('.');
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as { aud: string };
    expect(claims.aud).toBe('https://lk.example.test/mcp');
    expect((await mcpPost(bridge, body.access_token as string)).status).toBe(200);
  });

  it('refuses another resource at the authorization endpoint with invalid_target', async () => {
    const res = await new Browser(bridge).request(
      authorizeUrl({
        clientId,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkcePair().challenge,
        method: 'S256',
        resource: 'https://other.example/mcp',
      }),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses a token request whose resource differs from the authorization request', async () => {
    const { verifier, challenge } = pkcePair();
    const cb = await authorizeAndApprove(new Browser(bridge), {
      clientId,
      redirectUri: CLAUDE_CALLBACK,
      challenge,
      method: 'S256',
      resource: bridge.mcpUrl,
    });
    const { body } = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') ?? undefined,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
      resource: 'https://other.example/mcp',
    });
    expect(body.error).toBe('invalid_target');
  });

  it('refuses a token minted for a different audience', async () => {
    const other = await startBridge({ publicUrl: 'https://other.example.test' });
    try {
      const foreign = await fullFlow(other);
      remember({ access_token: foreign.access, refresh_token: foreign.refresh });
      const res = await mcpPost(bridge, foreign.access);
      expect(res.status).toBe(401);
      expect(parseChallenge(res.headers.get('www-authenticate')).params.error).toBe('invalid_token');
    } finally {
      await other.close();
    }
  });
});

describe('requirement 7: the token endpoint takes form-encoded bodies only', () => {
  it('refuses JSON and other media types with an OAuth error, not a 415', async () => {
    const clientId = await registerPublicClient(bridge);
    for (const [type, body] of [
      [
        'application/json',
        JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'x' }),
      ],
      ['text/plain', 'grant_type=refresh_token'],
    ] as const) {
      const res = await bridge.fetch(`${PUBLIC_URL}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      });
      expect(res.status, type).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    }
  });

  it('accepts a charset parameter on the form content type', async () => {
    const res = await bridge.fetch(`${PUBLIC_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'grant_type=refresh_token&client_id=lkb_c_unknown&refresh_token=x',
    });
    expect(res.status).toBe(401); // parsed fine; the client is unknown
  });

  it('refuses repeated parameters and unknown grant types', async () => {
    const dup = await tokenRequest(bridge, { grant_type: ['refresh_token', 'refresh_token'] });
    expect(dup.body.error).toBe('invalid_request');
    const unknown = await tokenRequest(bridge, { grant_type: 'client_credentials', client_id: 'x' });
    expect(unknown.body.error).toBe('unsupported_grant_type');
    const missing = await tokenRequest(bridge, { client_id: 'x' });
    expect(missing.body.error).toBe('invalid_request');
  });

  it('serves the legacy /token, /authorize and /register aliases (2025-03-26 clients)', async () => {
    const reg = await bridge.fetch(`${PUBLIC_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    expect(reg.status).toBe(201);
    const tok = await bridge.fetch(`${PUBLIC_URL}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&client_id=lkb_c_unknown&refresh_token=x',
    });
    expect(tok.status).toBe(401);
    const auth = await new Browser(bridge).request(`${PUBLIC_URL}/authorize?client_id=lkb_c_unknown`);
    expect(auth.status).toBe(400);
  });
});

describe('requirement 8: refresh errors and client errors', () => {
  it('returns invalid_grant for an unknown, expired or other-client refresh token', async () => {
    const a = await fullFlow(bridge);
    remember({ access_token: a.access, refresh_token: a.refresh });
    const bad = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: 'lkb_rt_nope',
      client_id: a.clientId,
    });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');

    const other = await registerPublicClient(bridge);
    const stolen = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh,
      client_id: other,
    });
    expect(stolen.body.error).toBe('invalid_grant');

    const b = await fullFlow(bridge);
    remember({ access_token: b.access, refresh_token: b.refresh });
    bridge.clock.advance(31 * 86400);
    try {
      const expired = await tokenRequest(bridge, {
        grant_type: 'refresh_token',
        refresh_token: b.refresh,
        client_id: b.clientId,
      });
      expect(expired.body.error).toBe('invalid_grant');
      // The access token has expired too.
      expect((await mcpPost(bridge, b.access)).status).toBe(401);
    } finally {
      bridge.clock.advance(-31 * 86400);
    }
  });

  it('refuses a refresh that widens the scope, and allows narrowing', async () => {
    const a = await fullFlow(bridge, { scope: 'mcp' });
    remember({ access_token: a.access, refresh_token: a.refresh });
    const wider = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh,
      client_id: a.clientId,
      scope: 'mcp offline_access',
    });
    expect(wider.body.error).toBe('invalid_scope');
    const same = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh,
      client_id: a.clientId,
      scope: 'mcp',
    });
    expect(same.res.status).toBe(200);
    remember(same.body);
  });

  it('returns 401 invalid_client for an unknown or deleted DCR client, so Claude re-registers', async () => {
    const a = await fullFlow(bridge);
    remember({ access_token: a.access, refresh_token: a.refresh });
    expect(bridge.services.store.deleteClient(a.clientId)).toBe(true);
    const res = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh,
      client_id: a.clientId,
    });
    expect(res.res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    // Deleting the client removed its grants: the access token is no longer accepted.
    expect((await mcpPost(bridge, a.access)).status).toBe(401);
    const none = await tokenRequest(bridge, { grant_type: 'refresh_token', refresh_token: a.refresh });
    expect(none.res.status).toBe(401);
    expect(none.body.error).toBe('invalid_client');
  });

  it('rejects a reused authorization code and revokes the tokens issued from it', async () => {
    const clientId = await registerPublicClient(bridge);
    const { verifier, challenge } = pkcePair();
    const cb = await authorizeAndApprove(new Browser(bridge), {
      clientId,
      redirectUri: CLAUDE_CALLBACK,
      challenge,
      method: 'S256',
    });
    const params = {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') ?? undefined,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
    };
    const first = await tokenRequest(bridge, params);
    expect(first.res.status).toBe(200);
    remember(first.body);
    const second = await tokenRequest(bridge, params);
    expect(second.body.error).toBe('invalid_grant');
    expect((await mcpPost(bridge, first.body.access_token as string)).status).toBe(401);
  });

  it('rejects an expired code, a redirect_uri mismatch, and a code from another client', async () => {
    const clientId = await registerPublicClient(bridge, [
      CLAUDE_CALLBACK,
      'https://claude.com/api/mcp/auth_callback',
    ]);
    const otherClient = await registerPublicClient(bridge);
    const fresh = async () => {
      const { verifier, challenge } = pkcePair();
      const cb = await authorizeAndApprove(new Browser(bridge), {
        clientId,
        redirectUri: CLAUDE_CALLBACK,
        challenge,
        method: 'S256',
      });
      return { code: cb.searchParams.get('code') as string, verifier };
    };
    const mismatch = await fresh();
    const r1 = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: mismatch.code,
      redirect_uri: 'https://claude.com/api/mcp/auth_callback',
      code_verifier: mismatch.verifier,
      client_id: clientId,
    });
    expect(r1.body.error).toBe('invalid_grant');
    const omitted = await fresh();
    const r2 = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: omitted.code,
      code_verifier: omitted.verifier,
      client_id: clientId,
    });
    expect(r2.body.error).toBe('invalid_grant');
    const foreign = await fresh();
    const r3 = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: foreign.code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: foreign.verifier,
      client_id: otherClient,
    });
    expect(r3.body.error).toBe('invalid_grant');
    const late = await fresh();
    bridge.clock.advance(301);
    try {
      const r4 = await tokenRequest(bridge, {
        grant_type: 'authorization_code',
        code: late.code,
        redirect_uri: CLAUDE_CALLBACK,
        code_verifier: late.verifier,
        client_id: clientId,
      });
      expect(r4.body.error).toBe('invalid_grant');
    } finally {
      bridge.clock.advance(-301);
    }
  });

  it('revokes a grant through the RFC 7009 endpoint', async () => {
    const a = await fullFlow(bridge);
    remember({ access_token: a.access, refresh_token: a.refresh });
    const res = await bridge.fetch(`${PUBLIC_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: a.refresh, client_id: a.clientId }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await mcpPost(bridge, a.access)).status).toBe(401);
    const refresh = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh,
      client_id: a.clientId,
    });
    expect(refresh.body.error).toBe('invalid_grant');
    // Revoking an access token on its own.
    const b = await fullFlow(bridge);
    remember({ access_token: b.access, refresh_token: b.refresh });
    await bridge.fetch(`${PUBLIC_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: b.access, client_id: b.clientId }).toString(),
    });
    expect((await mcpPost(bridge, b.access)).status).toBe(401);
  });
});

describe('authorization endpoint request handling', () => {
  it('never redirects for an unknown client or an unregistered redirect URI', async () => {
    const clientId = await registerPublicClient(bridge);
    const cases = [
      authorizeUrl({
        clientId: 'lkb_c_unknown',
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
      authorizeUrl({
        clientId,
        redirectUri: 'https://evil.example/cb',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
      authorizeUrl({
        clientId,
        redirectUri: 'https://claude.com/api/mcp/auth_callback',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
      `${PUBLIC_URL}/oauth/authorize?response_type=code`,
      `${PUBLIC_URL}/oauth/authorize?client_id=${clientId}&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}`,
    ];
    for (const url of cases) {
      const res = await new Browser(bridge).request(url);
      expect(res.status, url).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });

  it('uses the only registered redirect URI when none is given', async () => {
    const clientId = await registerPublicClient(bridge);
    const { verifier, challenge } = pkcePair();
    const cb = await authorizeAndApprove(new Browser(bridge), { clientId, challenge, method: 'S256' });
    expect(`${cb.origin}${cb.pathname}`).toBe(CLAUDE_CALLBACK);
    const { res, body } = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') ?? undefined,
      code_verifier: verifier,
      client_id: clientId,
    });
    remember(body);
    expect(res.status).toBe(200);
  });

  it('reports bad parameters to the client with state and iss', async () => {
    const clientId = await registerPublicClient(bridge);
    const { challenge } = pkcePair();
    const cases: [Parameters<typeof authorizeUrl>[0], string][] = [
      [
        { clientId, redirectUri: CLAUDE_CALLBACK, challenge, method: 'S256', responseType: 'token' },
        'unsupported_response_type',
      ],
      [
        { clientId, redirectUri: CLAUDE_CALLBACK, challenge, method: 'S256', scope: 'mcp "x"' },
        'invalid_scope',
      ],
      [
        {
          clientId,
          redirectUri: CLAUDE_CALLBACK,
          challenge,
          method: 'S256',
          extra: { request_uri: 'urn:x' },
        },
        'request_uri_not_supported',
      ],
      [
        {
          clientId,
          redirectUri: CLAUDE_CALLBACK,
          challenge,
          method: 'S256',
          extra: { response_mode: 'fragment' },
        },
        'invalid_request',
      ],
    ];
    for (const [params, error] of cases) {
      const res = await new Browser(bridge).request(authorizeUrl({ ...params, state: 'xyz' }));
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.searchParams.get('error'), error).toBe(error);
      expect(loc.searchParams.get('state')).toBe('xyz');
      expect(loc.searchParams.get('iss')).toBe(PUBLIC_URL);
    }
  });

  it('returns access_denied when the owner denies', async () => {
    const clientId = await registerPublicClient(bridge);
    const browser = new Browser(bridge);
    const page = await reachConsent(
      browser,
      authorizeUrl({
        clientId,
        redirectUri: CLAUDE_CALLBACK,
        challenge: pkcePair().challenge,
        method: 'S256',
        state: 'd',
      }),
    );
    if (page instanceof Response) throw new Error('expected consent');
    const { location } = await decide(browser, page, 'deny');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('d');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('ignores unknown scopes and always grants mcp', async () => {
    const a = await fullFlow(bridge, { scope: 'openid profile' });
    remember({ access_token: a.access, refresh_token: a.refresh });
    expect(a.scope).toBe('mcp');
  });
});

describe('requirement 16: auth events are logged without secrets', () => {
  it('logged the flow events', () => {
    const events = bridge.logs
      .map((l) => JSON.parse(l) as { event?: string })
      .map((l) => l.event)
      .filter(Boolean);
    for (const e of [
      'client.registered',
      'consent.shown',
      'consent.granted',
      'consent.denied',
      'token.issued',
      'token.refreshed',
      'token.reuse_detected',
      'token.revoked',
      'token.rejected',
      'login.succeeded',
      'mcp.rejected',
      'authorize.rejected',
    ]) {
      expect(events, e).toContain(e);
    }
  });

  it('never wrote a token, code, client secret or password to the log', () => {
    const all = bridge.logs.join('\n');
    expect(secrets.length).toBeGreaterThan(20);
    for (const s of secrets) expect(all.includes(s), `secret leaked: ${s.slice(0, 12)}…`).toBe(false);
    expect(all).not.toMatch(/lkb_(rt|ac|pat|cs)_[A-Za-z0-9_-]{20,}/);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/);
    expect(all).not.toMatch(/code_verifier|code_challenge=|[?&]code=/);
  });
});
