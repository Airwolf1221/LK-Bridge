import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/auth/crypto.js';
import { JWT_BEARER_GRANT } from './fixtures/claude-client-metadata.js';
import {
  Browser,
  PUBLIC_URL,
  type TestBridge,
  authorizeAndApprove,
  logEvents,
  pkcePair,
  registerClient,
  startBridge,
  tokenRequest,
} from './helpers.js';

/** Requirement 4 (Dynamic Client Registration, RFC 7591) and requirement 7 (/register takes JSON). */

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge({ authOverrides: { registrationLimit: { limit: 40, windowMs: 3600_000 } } });
});
afterAll(() => bridge.close());

const CB = 'https://claude.ai/api/mcp/auth_callback';

describe('dynamic client registration', () => {
  it('registers a public client and returns the registered metadata', async () => {
    const res = await registerClient(bridge, {
      client_name: 'Claude',
      redirect_uris: [CB, 'https://claude.com/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp offline_access unknown',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [CB, 'https://claude.com/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp offline_access',
    });
    expect(body.client_id_issued_at).toBeTypeOf('number');
    expect(body.client_secret).toBeUndefined();
  });

  it('defaults to client_secret_basic (RFC 7591) and shows the secret once, storing only its hash', async () => {
    const res = await registerClient(bridge, { redirect_uris: [CB] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string | number>;
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(String(body.client_secret)).toMatch(/^lkb_cs_/);
    expect(body.client_secret_expires_at).toBe(0);
    const stored = bridge.services.store.getClient(String(body.client_id));
    expect(stored?.clientSecretHash).toBe(hashSecret(String(body.client_secret)));
    expect(JSON.stringify(stored)).not.toContain(String(body.client_secret));
  });

  it('authenticates a confidential client with Basic or post, and refuses a wrong secret with 401', async () => {
    const res = await registerClient(bridge, {
      redirect_uris: [CB],
      token_endpoint_auth_method: 'client_secret_post',
    });
    const reg = (await res.json()) as { client_id: string; client_secret: string };
    const exchange = async (auth: 'basic' | 'post' | 'wrong') => {
      const { verifier, challenge } = pkcePair();
      const cb = await authorizeAndApprove(new Browser(bridge), {
        clientId: reg.client_id,
        redirectUri: CB,
        challenge,
        method: 'S256',
      });
      const params = {
        grant_type: 'authorization_code',
        code: cb.searchParams.get('code') ?? undefined,
        redirect_uri: CB,
        code_verifier: verifier,
      };
      if (auth === 'basic') {
        const basic = Buffer.from(
          `${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`,
        ).toString('base64');
        return tokenRequest(bridge, params, { authorization: `Basic ${basic}` });
      }
      return tokenRequest(bridge, {
        ...params,
        client_id: reg.client_id,
        client_secret: auth === 'post' ? reg.client_secret : 'lkb_cs_wrong',
      });
    };
    expect((await exchange('post')).res.status).toBe(200);
    expect((await exchange('basic')).res.status).toBe(200);
    const wrong = await exchange('wrong');
    expect(wrong.res.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    const missing = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: 'x',
      client_id: reg.client_id,
    });
    expect(missing.res.status).toBe(401);
    const badBasic = await tokenRequest(
      bridge,
      { grant_type: 'refresh_token', refresh_token: 'x' },
      { authorization: 'Basic Zm9vOmJhcg==' },
    );
    expect(badBasic.res.status).toBe(401);
    expect(badBasic.res.headers.get('www-authenticate')).toBe('Basic realm="lk-bridge"');
  });

  it.each([
    [['https://evil.example/callback']],
    [['http://claude.ai/api/mcp/auth_callback']],
    [[CB, 'https://evil.example/callback']],
    [['http://localhost:3000/oauth/callback']],
    [['https://localhost/callback']],
    [[]],
    ['not-an-array'],
  ])('refuses redirect_uris %j with invalid_redirect_uri', async (uris) => {
    const res = await registerClient(bridge, { redirect_uris: uris, token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it.each([
    [{ token_endpoint_auth_method: 'private_key_jwt' }],
    [{ token_endpoint_auth_method: 'client_secret_jwt' }],
    [{ grant_types: ['client_credentials'] }],
    [{ grant_types: ['refresh_token'] }],
    [{ grant_types: ['refresh_token', JWT_BEARER_GRANT] }],
    [{ grant_types: [] }],
    [{ response_types: ['token'] }],
    [{ client_name: 'x'.repeat(201) }],
  ])('refuses %j with invalid_client_metadata', async (patch) => {
    const res = await registerClient(bridge, { redirect_uris: [CB], ...patch });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
  });

  it('registers only the supported grants a client asks for, as claude.ai does with the JWT bearer grant', async () => {
    // claude.ai's "Register automatically" asks for the same grants its metadata document lists.
    const res = await registerClient(bridge, {
      client_name: 'Claude',
      redirect_uris: [CB],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token', JWT_BEARER_GRANT],
      response_types: ['code'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; grant_types: string[] };
    // RFC 7591 §3.2.1: the response carries the values actually registered.
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(bridge.services.store.getClient(body.client_id)?.grantTypes).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(logEvents(bridge, 'client.grant_types_ignored')).toContainEqual(
      expect.objectContaining({
        level: 30,
        client_id: body.client_id,
        kind: 'dcr',
        ignored_grant_types: JWT_BEARER_GRANT,
        grant_types: 'authorization_code refresh_token',
      }),
    );

    // The registered client completes the flow and refreshes.
    const { verifier, challenge } = pkcePair();
    const cb = await authorizeAndApprove(new Browser(bridge), {
      clientId: body.client_id,
      redirectUri: CB,
      challenge,
      method: 'S256',
      scope: 'mcp offline_access',
    });
    const t = await tokenRequest(bridge, {
      grant_type: 'authorization_code',
      code: cb.searchParams.get('code') ?? undefined,
      redirect_uri: CB,
      code_verifier: verifier,
      client_id: body.client_id,
    });
    expect(t.res.status).toBe(200);
    const r = await tokenRequest(bridge, {
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token as string,
      client_id: body.client_id,
    });
    expect(r.res.status).toBe(200);
    // The ignored grant is never issued: the token endpoint still refuses it.
    const jwt = await tokenRequest(bridge, {
      grant_type: JWT_BEARER_GRANT,
      assertion: 'eyJhbGciOiJub25lIn0.e30.',
      client_id: body.client_id,
    });
    expect(jwt.res.status).toBe(400);
    expect(jwt.body.error).toBe('unsupported_grant_type');
  });

  it('logs the refused field and value with every refused registration', async () => {
    const res = await registerClient(bridge, {
      client_name: 'Needs logging',
      redirect_uris: [CB],
      token_endpoint_auth_method: 'none',
      grant_types: ['refresh_token', JWT_BEARER_GRANT],
    });
    expect(res.status).toBe(400);
    expect(logEvents(bridge, 'client.registration_rejected')).toContainEqual(
      expect.objectContaining({
        level: 40,
        error: 'invalid_client_metadata',
        field: 'grant_types',
        value: `["refresh_token","${JWT_BEARER_GRANT}"]`,
        reason: 'grant_types must include authorization_code',
        client_name: 'Needs logging',
      }),
    );
    const method = await registerClient(bridge, {
      client_name: 'Needs logging',
      redirect_uris: [CB],
      token_endpoint_auth_method: 'private_key_jwt',
    });
    expect(method.status).toBe(400);
    expect(logEvents(bridge, 'client.registration_rejected')).toContainEqual(
      expect.objectContaining({ field: 'token_endpoint_auth_method', value: 'private_key_jwt' }),
    );
    const malformed = await registerClient(bridge, {
      client_name: 'Needs logging',
      redirect_uris: [CB],
      grant_types: 'authorization_code',
      client_secret: 'never-logged',
    });
    expect(malformed.status).toBe(400);
    expect(logEvents(bridge, 'client.registration_rejected')).toContainEqual(
      expect.objectContaining({ field: 'grant_types', value: 'authorization_code' }),
    );
    expect(bridge.logs.join('')).not.toContain('never-logged');
  });

  it('takes JSON only', async () => {
    for (const [type, body] of [
      ['application/x-www-form-urlencoded', `redirect_uris=${encodeURIComponent(CB)}`],
      ['text/plain', JSON.stringify({ redirect_uris: [CB] })],
      ['application/json', '[]'],
    ] as const) {
      const res = await bridge.fetch(`${PUBLIC_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      });
      expect(res.status, type).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
    }
  });

  it('strips control characters from the client name', async () => {
    const res = await registerClient(bridge, {
      redirect_uris: [CB],
      token_endpoint_auth_method: 'none',
      client_name: 'Cla\u0000ude\u001b[31m',
    });
    expect(((await res.json()) as { client_name: string }).client_name).toBe('Claude[31m');
  });

  it('rate-limits registrations per address', async () => {
    const limited = await startBridge({
      authOverrides: { registrationLimit: { limit: 2, windowMs: 3600_000 } },
    });
    try {
      const body = { redirect_uris: [CB], token_endpoint_auth_method: 'none' };
      expect((await registerClient(limited, body)).status).toBe(201);
      expect((await registerClient(limited, body)).status).toBe(201);
      const third = await registerClient(limited, body);
      expect(third.status).toBe(429);
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it('keeps DCR registrations indefinitely: a client registered long ago still completes a flow', async () => {
    // ChatGPT registers once per connection and reuses the client; nothing may expire it.
    const res = await registerClient(bridge, {
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      token_endpoint_auth_method: 'none',
    });
    const { client_id } = (await res.json()) as { client_id: string };
    const fiveYears = 5 * 365 * 86400;
    bridge.clock.advance(fiveYears);
    try {
      bridge.services.prune();
      expect(bridge.services.store.getClient(client_id)).toBeDefined();
      const { verifier, challenge } = pkcePair();
      const cb = await authorizeAndApprove(new Browser(bridge), {
        clientId: client_id,
        redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        challenge,
        method: 'S256',
      });
      const t = await tokenRequest(bridge, {
        grant_type: 'authorization_code',
        code: cb.searchParams.get('code') ?? undefined,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        code_verifier: verifier,
        client_id,
      });
      expect(t.res.status).toBe(200);
      // And after the grant itself has long expired and been pruned, the client is still there.
      bridge.clock.advance(fiveYears);
      bridge.services.prune();
      expect(bridge.services.store.getClient(client_id)).toBeDefined();
    } finally {
      bridge.clock.advance(-2 * fiveYears);
    }
  });

  it('removes a client only on explicit deletion', async () => {
    const res = await registerClient(bridge, { redirect_uris: [CB], token_endpoint_auth_method: 'none' });
    const { client_id } = (await res.json()) as { client_id: string };
    expect(bridge.services.store.deleteClient(client_id)).toBe(true);
    expect(bridge.services.store.getClient(client_id)).toBeUndefined();
  });
});
