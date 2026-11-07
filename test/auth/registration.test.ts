import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/auth/crypto.js';
import {
  Browser,
  PUBLIC_URL,
  type TestBridge,
  authorizeAndApprove,
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
    [{ grant_types: ['authorization_code', 'implicit'] }],
    [{ response_types: ['token'] }],
    [{ client_name: 'x'.repeat(201) }],
  ])('refuses %j with invalid_client_metadata', async (patch) => {
    const res = await registerClient(bridge, { redirect_uris: [CB], ...patch });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
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

  it('prunes registrations that were never used', async () => {
    const res = await registerClient(bridge, { redirect_uris: [CB], token_endpoint_auth_method: 'none' });
    const { client_id } = (await res.json()) as { client_id: string };
    bridge.clock.advance(2 * 86400);
    try {
      bridge.services.prune();
      expect(bridge.services.store.getClient(client_id)).toBeUndefined();
    } finally {
      bridge.clock.advance(-2 * 86400);
    }
  });
});
