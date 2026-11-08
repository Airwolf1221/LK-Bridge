import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonFetcher } from '../../src/auth/safe-fetch.js';
import {
  Browser,
  INIT_BODY,
  MCP_HEADERS,
  type TestBridge,
  authorizeUrl,
  decide,
  mcpPost,
  parseChallenge,
  pkcePair,
  reachConsent,
  registerClient,
  rpcResult,
  startBridge,
  tokenRequest,
} from './helpers.js';

/**
 * ChatGPT as a client (follow-up items A, B, C and F; ADR 0008). These scripted flows follow
 * ChatGPT's documented connector behaviour: discovery from the 401, Dynamic Client Registration
 * or a Client ID Metadata Document, PKCE S256, `resource` on both the authorization and the token
 * request, a public client (`token_endpoint_auth_method: none`), the chatgpt.com callbacks, and
 * RFC 9207 `iss` on every authorization response. ChatGPT's real metadata document uses
 * `private_key_jwt` instead; that flow is in private-key-jwt.test.ts (ADR 0021).
 *
 * ChatGPT may also ask for `openid` and `email`. The bridge does not advertise them and ignores
 * them when requested.
 */

const LEGACY_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CONNECTOR_CALLBACK = 'https://chatgpt.com/connector/oauth/a1B2-c3_D4';
/** Hypothetical metadata URL for ChatGPT's client; the real one is recorded in the live check. */
const CHATGPT_CIMD = 'https://chatgpt.com/oauth/client-metadata.example.json';

let bridge: TestBridge;
let fetchedCimd = 0;

const cimdStub: JsonFetcher = (url) => {
  fetchedCimd++;
  return Promise.resolve({
    body: {
      client_id: url,
      client_name: 'ChatGPT',
      client_uri: 'https://chatgpt.com',
      redirect_uris: [LEGACY_CALLBACK, CONNECTOR_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    headers: { 'cache-control': 'max-age=600' },
  });
};

beforeAll(async () => {
  bridge = await startBridge({
    env: { OAUTH_EXTRA_REDIRECT_URIS: 'https://chatgpt.com/aip/g-0123456789/oauth/callback' },
    authOverrides: { fetchJson: cimdStub },
  });
});
afterAll(() => bridge.close());

interface Discovery {
  readonly resource: string;
  readonly issuer: string;
  readonly metadata: Record<string, unknown>;
  readonly prmScopes: string[];
}

/** What ChatGPT does first: call /mcp, read the challenge, fetch both metadata documents. */
async function discover(): Promise<Discovery> {
  const res = await bridge.fetch(bridge.mcpUrl, { method: 'POST', headers: MCP_HEADERS, body: INIT_BODY });
  expect(res.status).toBe(401);
  const prmUrl = parseChallenge(res.headers.get('www-authenticate')).params.resource_metadata as string;
  const prm = (await (await bridge.fetch(prmUrl)).json()) as {
    resource: string;
    authorization_servers: string[];
    scopes_supported: string[];
  };
  const issuer = prm.authorization_servers[0] as string;
  const metadata = (await (
    await bridge.fetch(`${issuer}/.well-known/oauth-authorization-server`)
  ).json()) as Record<string, unknown>;
  return { resource: prm.resource, issuer, metadata, prmScopes: prm.scopes_supported };
}

async function connect(
  clientId: string,
  redirectUri: string,
  d: Discovery,
): Promise<{ access: string; refresh: string; scope: string }> {
  const browser = new Browser(bridge);
  const { verifier, challenge } = pkcePair();
  const page = await reachConsent(
    browser,
    authorizeUrl({
      clientId,
      redirectUri,
      challenge,
      method: 'S256',
      state: 'chatgpt-state',
      scope: 'openid email mcp offline_access',
      resource: d.resource,
    }),
  );
  if (page instanceof Response) throw new Error(`no consent page: ${page.status} ${await page.text()}`);
  expect(page.html).toContain('<p class="host">chatgpt.com</p>');
  expect(page.html).not.toContain('only accepts sign-ins on your own computer');
  expect(page.html).not.toContain('<strong>openid</strong>');
  expect(page.html).not.toContain('<strong>email</strong>');
  const { location } = await decide(browser, page, 'approve');
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get('state')).toBe('chatgpt-state');
  expect(location.searchParams.get('iss')).toBe(d.issuer);
  expect(location.searchParams.get('iss')).toBe(d.metadata.issuer);

  const token = await tokenRequest(bridge, {
    grant_type: 'authorization_code',
    code: location.searchParams.get('code') ?? undefined,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: clientId,
    resource: d.resource,
  });
  expect(token.res.status, JSON.stringify(token.body)).toBe(200);
  expect(token.body.scope).toBe('mcp offline_access');
  return {
    access: token.body.access_token as string,
    refresh: token.body.refresh_token as string,
    scope: token.body.scope as string,
  };
}

async function callBridgeInfo(access: string): Promise<Record<string, unknown>> {
  expect((await mcpPost(bridge, access)).status).toBe(200);
  const res = await mcpPost(
    bridge,
    access,
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bridge_info', arguments: {} },
    }),
    { 'mcp-protocol-version': '2025-06-18' },
  );
  const result = (await rpcResult(res)).result as { content: { text: string }[] };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('discovery as ChatGPT sees it', () => {
  it('advertises RFC 9207, S256, public clients, DCR and CIMD, and no openid or email scope', async () => {
    const d = await discover();
    expect(d.metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect(d.metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(d.metadata.token_endpoint_auth_methods_supported).toContain('none');
    expect(d.metadata.registration_endpoint).toBe(`${d.issuer}/oauth/register`);
    expect(d.metadata.client_id_metadata_document_supported).toBe(true);
    for (const scopes of [d.metadata.scopes_supported as string[], d.prmScopes]) {
      expect(scopes).not.toContain('openid');
      expect(scopes).not.toContain('email');
    }
    const oidc = (await (await bridge.fetch(`${d.issuer}/.well-known/openid-configuration`)).json()) as {
      scopes_supported: string[];
      issuer: string;
    };
    expect(oidc.scopes_supported).not.toContain('openid');
    expect(oidc.issuer).toBe(d.issuer);
  });
});

describe('ChatGPT with Dynamic Client Registration', () => {
  it.each([LEGACY_CALLBACK, CONNECTOR_CALLBACK])(
    'registers a public client with %s, connects, calls a tool and refreshes',
    async (redirectUri) => {
      const d = await discover();
      const reg = await registerClient(bridge, {
        client_name: 'ChatGPT',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid email mcp offline_access',
      });
      expect(reg.status).toBe(201);
      const client = (await reg.json()) as { client_id: string; client_secret?: string; scope: string };
      expect(client.client_secret).toBeUndefined();
      expect(client.scope).toBe('mcp offline_access');

      const tokens = await connect(client.client_id, redirectUri, d);
      expect(await callBridgeInfo(tokens.access)).toMatchObject({
        caller: { kind: 'oauth', clientId: client.client_id },
      });

      // Refresh with resource (and the unsupported scopes ChatGPT may resend): ignored, not refused.
      const refreshed = await tokenRequest(bridge, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh,
        client_id: client.client_id,
        resource: d.resource,
        scope: 'openid email mcp offline_access',
      });
      expect(refreshed.res.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.scope).toBe('mcp offline_access');
      expect(refreshed.body.refresh_token).not.toBe(tokens.refresh);
      expect((await mcpPost(bridge, refreshed.body.access_token as string)).status).toBe(200);

      // ChatGPT reuses the registered client for the next connection, much later.
      bridge.clock.advance(400 * 86400);
      try {
        const again = await connect(client.client_id, redirectUri, d);
        expect((await mcpPost(bridge, again.access)).status).toBe(200);
      } finally {
        bridge.clock.advance(-400 * 86400);
      }
    },
  );

  it('accepts an exact extra callback from OAUTH_EXTRA_REDIRECT_URIS and shows its host', async () => {
    const d = await discover();
    const extra = 'https://chatgpt.com/aip/g-0123456789/oauth/callback';
    const reg = await registerClient(bridge, {
      client_name: 'ChatGPT',
      redirect_uris: [extra],
      token_endpoint_auth_method: 'none',
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const tokens = await connect(client_id, extra, d);
    expect((await mcpPost(bridge, tokens.access)).status).toBe(200);
    // Only that exact URI: a sibling path is refused.
    const sibling = await registerClient(bridge, {
      redirect_uris: ['https://chatgpt.com/aip/g-9999999999/oauth/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(sibling.status).toBe(400);
    // The refused URI is logged in full, so the owner can copy it into OAUTH_EXTRA_REDIRECT_URIS.
    const rejected = bridge.logs
      .map((l) => JSON.parse(l) as { event?: string; redirect_uri?: string })
      .filter((l) => l.event === 'client.registration_rejected');
    expect(rejected.map((l) => l.redirect_uri)).toContain(
      'https://chatgpt.com/aip/g-9999999999/oauth/callback',
    );
    const registered = bridge.logs
      .map((l) => JSON.parse(l) as { event?: string; redirect_uris?: string })
      .filter((l) => l.event === 'client.registered');
    expect(registered.map((l) => l.redirect_uris)).toContain(extra);
  });

  it.each([
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/a/b',
    'https://chatgpt.com/connector/oauth/a?x=1',
    'https://chatgpt.com/connector_platform_oauth_redirect/',
    'https://chatgpt.com.evil.example/connector/oauth/abc',
    'http://chatgpt.com/connector_platform_oauth_redirect',
  ])('refuses to register %s', async (uri) => {
    const reg = await registerClient(bridge, { redirect_uris: [uri], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(400);
    expect(((await reg.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });
});

describe('ChatGPT with a Client ID Metadata Document', () => {
  it('connects with an https client_id, no secret, and resource on both requests', async () => {
    const d = await discover();
    const before = fetchedCimd;
    const tokens = await connect(CHATGPT_CIMD, CONNECTOR_CALLBACK, d);
    expect(fetchedCimd).toBe(before + 1);
    expect(await callBridgeInfo(tokens.access)).toMatchObject({
      caller: { kind: 'oauth', clientId: CHATGPT_CIMD },
    });
    const refreshed = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh,
      client_id: CHATGPT_CIMD,
      resource: d.resource,
    });
    expect(refreshed.res.status).toBe(200);
  });

  it('names the document host on the consent page and refuses a callback the document does not list', async () => {
    const browser = new Browser(bridge);
    await browser.login();
    const ok = await browser.request(
      authorizeUrl({
        clientId: CHATGPT_CIMD,
        redirectUri: LEGACY_CALLBACK,
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    const html = await ok.text();
    expect(html).toContain('Application published at</p><p class="host">chatgpt.com</p>');
    expect(html).toContain('It calls itself “ChatGPT”');
    const other = await browser.request(
      authorizeUrl({
        clientId: CHATGPT_CIMD,
        redirectUri: 'https://chatgpt.com/connector/oauth/notListed',
        challenge: pkcePair().challenge,
        method: 'S256',
      }),
    );
    expect(other.status).toBe(400);
    expect(other.headers.get('location')).toBeNull();
  });
});

describe('RFC 9207: iss on every authorization response', () => {
  let clientId: string;
  let issuer: string;
  beforeAll(async () => {
    const reg = await registerClient(bridge, {
      redirect_uris: [CONNECTOR_CALLBACK],
      token_endpoint_auth_method: 'none',
    });
    clientId = ((await reg.json()) as { client_id: string }).client_id;
    issuer = (await discover()).metadata.issuer as string;
  });

  const errorRedirect = async (params: Parameters<typeof authorizeUrl>[0], browser = new Browser(bridge)) => {
    const res = await browser.request(authorizeUrl(params));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(CONNECTOR_CALLBACK);
    return loc;
  };

  it.each([
    ['missing PKCE', { method: undefined, challenge: undefined }, 'invalid_request'],
    ['plain PKCE', { method: 'plain' }, 'invalid_request'],
    ['wrong resource', { resource: 'https://other.example/mcp' }, 'invalid_target'],
    ['response_type token', { responseType: 'token' }, 'unsupported_response_type'],
    ['malformed scope', { scope: 'mcp "x"' }, 'invalid_scope'],
    ['request_uri', { extra: { request_uri: 'urn:example' } }, 'request_uri_not_supported'],
    ['prompt=none, signed out', { extra: { prompt: 'none' } }, 'login_required'],
  ] as const)('on an error redirect (%s)', async (_name, patch, error) => {
    const loc = await errorRedirect({
      clientId,
      redirectUri: CONNECTOR_CALLBACK,
      challenge: pkcePair().challenge,
      method: 'S256',
      state: 'e',
      ...patch,
    } as Parameters<typeof authorizeUrl>[0]);
    expect(loc.searchParams.get('error')).toBe(error);
    expect(loc.searchParams.get('iss')).toBe(issuer);
    expect(loc.searchParams.get('state')).toBe('e');
  });

  it('on consent_required, access_denied and success', async () => {
    const browser = new Browser(bridge);
    await browser.login();
    const consentRequired = await errorRedirect(
      {
        clientId,
        redirectUri: CONNECTOR_CALLBACK,
        challenge: pkcePair().challenge,
        method: 'S256',
        extra: { prompt: 'none' },
      },
      browser,
    );
    expect(consentRequired.searchParams.get('error')).toBe('consent_required');
    expect(consentRequired.searchParams.get('iss')).toBe(issuer);

    for (const decision of ['deny', 'approve'] as const) {
      const page = await reachConsent(
        browser,
        authorizeUrl({
          clientId,
          redirectUri: CONNECTOR_CALLBACK,
          challenge: pkcePair().challenge,
          method: 'S256',
        }),
      );
      if (page instanceof Response) throw new Error('expected consent');
      const { location } = await decide(browser, page, decision);
      expect(location.searchParams.get('iss')).toBe(issuer);
      expect(location.searchParams.get(decision === 'deny' ? 'error' : 'code')).toBeTruthy();
    }
  });
});
