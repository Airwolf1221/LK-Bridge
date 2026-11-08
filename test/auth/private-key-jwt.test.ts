import { execFileSync } from 'node:child_process';
import { type KeyObject, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JWK, SignJWT, exportJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CimdError, validateCimdDocument } from '../../src/auth/cimd.js';
import {
  CLIENT_ASSERTION_TYPE,
  JWKS_USER_AGENT,
  createJwksFetcher,
} from '../../src/auth/client-assertion.js';
import { JwksShapeError, keyFitsAlg, parseJwks } from '../../src/auth/jwks.js';
import { parseOutboundPortAllowlist } from '../../src/auth/ports.js';
import type { JsonFetcher } from '../../src/auth/safe-fetch.js';
import {
  Browser,
  type TestBridge,
  authorizeUrl,
  consentDefaults,
  decide,
  formBody,
  logEvents,
  mcpPost,
  pkcePair,
  reachConsent,
  registerPublicClient,
  startBridge,
  tokenRequest,
} from './helpers.js';
import {
  CHATGPT_CIMD,
  CHATGPT_DOC,
  CHATGPT_REDIRECT,
  chatgptDoc,
} from './fixtures/chatgpt-client-metadata.js';
import {
  CLAUDE_AI_CIMD,
  CLAUDE_AI_DOC,
  CLAUDE_CODE_CIMD,
  CLAUDE_CODE_DOC,
} from './fixtures/claude-client-metadata.js';

/**
 * private_key_jwt client authentication (RFC 7523; ADR 0021), as ChatGPT's custom connector uses it. ChatGPT's real
 * client metadata document is served (by a stub, at its real client_id) with its `jwks_uri` pointing at a local HTTPS
 * key-set server with a throwaway certificate, on a port allowed exactly as OUTBOUND_EXTRA_PORTS_ALLOWLIST would. The
 * key set is fetched by the production fetcher; only DNS, the trust store and the loopback address are test seams.
 * Key pairs are generated per run and never committed.
 */

let dir: string;
let cert: string;
let jwksServer: Server;
let port: number;
const fetches: { path: string; userAgent: string | undefined; accept: string | undefined }[] = [];
const fetchCount = (path: string) => fetches.filter((f) => f.path === path).length;

type Pair = { privateKey: KeyObject; publicKey: KeyObject };
let rsaA: Pair;
let rsaB: Pair;
let rsaImpostor: Pair;
let ec: Pair;
const publicJwk = async (pair: Pair, kid: string): Promise<JWK> => ({
  ...(await exportJWK(pair.publicKey)),
  kid,
});

/** Key sets the server publishes, by path. `rotating` changes during a test. */
const sets = new Map<string, () => unknown>();
let rotating: JWK[] = [];

const jwksUrl = (path: string) => `https://jwks.test:${port}${path}`;
const MAIN_JWKS = '/oauth/jwks.json';

/** The CIMD client ids used here (all on chatgpt.com, served by the stub), and their key-set paths. */
const CLIENTS = {
  chatgpt: { id: CHATGPT_CIMD, jwks: MAIN_JWKS },
  noAlg: { id: 'https://chatgpt.com/oauth/client-no-alg.json', jwks: MAIN_JWKS },
  rotating: { id: 'https://chatgpt.com/oauth/client-rotating.json', jwks: '/rotating/jwks.json' },
  noStore: { id: 'https://chatgpt.com/oauth/client-no-store.json', jwks: '/no-store/jwks.json' },
  html: { id: 'https://chatgpt.com/oauth/client-html.json', jwks: '/html/jwks.json' },
  challenge: { id: 'https://chatgpt.com/oauth/client-challenge.json', jwks: '/challenge/jwks.json' },
  htmlAsJson: { id: 'https://chatgpt.com/oauth/client-html-as-json.json', jwks: '/html-as-json/jwks.json' },
} as const;
const INLINE_CLIENT = 'https://chatgpt.com/oauth/client-inline.json';
let inlineJwks: { keys: JWK[] };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-pkjwt-'));
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
      '/CN=jwks.test',
      '-addext',
      'subjectAltName=DNS:jwks.test',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  rsaA = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsaB = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsaImpostor = generateKeyPairSync('rsa', { modulusLength: 2048 });
  ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const main = { keys: [await publicJwk(rsaA, 'rsa-a'), await publicJwk(ec, 'ec-1')] };
  inlineJwks = { keys: [await publicJwk(ec, 'ec-inline')] };
  rotating = [await publicJwk(rsaA, 'rsa-a')];
  sets.set(MAIN_JWKS, () => main);
  sets.set('/rotating/jwks.json', () => ({ keys: rotating }));

  jwksServer = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    fetches.push({ path, userAgent: req.headers['user-agent'], accept: req.headers.accept });
    if (path === '/no-store/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/jwk-set+json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ keys: rotating }));
    }
    const set = sets.get(path);
    if (set) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
      return res.end(JSON.stringify(set()));
    }
    const page =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking…</body></html>';
    if (path === '/html/jwks.json') {
      res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      return res.end(page);
    }
    if (path === '/challenge/jwks.json') {
      res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8' });
      return res.end(page);
    }
    if (path === '/html-as-json/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(page);
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', () => r()));
  port = (jwksServer.address() as AddressInfo).port;
});

afterAll(async () => {
  jwksServer.closeAllConnections();
  await new Promise<void>((r) => jwksServer.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** The production key-set fetcher, with the test host's DNS answer and CA, loopback allowed, and its port listed. */
const jwksFetcher = (): JsonFetcher =>
  createJwksFetcher({
    timeoutMs: 1000,
    resolve: (h) => Promise.resolve(h === 'jwks.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
    ca: cert,
    allowAddress: (a) => a === '127.0.0.1',
    allowedPorts: parseOutboundPortAllowlist(`jwks.test:${port}`),
  });

/** Client metadata documents: ChatGPT's real one (key set moved to the local server), variants, and Claude's. */
const cimdStub: JsonFetcher = (url) => {
  const headers = { 'cache-control': 'max-age=600' };
  const known = Object.values(CLIENTS).find((c) => c.id === url);
  if (known) {
    const doc = chatgptDoc(known.id, jwksUrl(known.jwks));
    if (known.id === CLIENTS.noAlg.id) delete doc.token_endpoint_auth_signing_alg;
    return Promise.resolve({ body: doc, headers });
  }
  if (url === INLINE_CLIENT) {
    const doc: Record<string, unknown> = chatgptDoc(INLINE_CLIENT, 'unused');
    delete doc.jwks_uri;
    return Promise.resolve({
      body: { ...doc, jwks: inlineJwks, token_endpoint_auth_signing_alg: 'ES256' },
      headers,
    });
  }
  if (url === CLAUDE_AI_CIMD) return Promise.resolve({ body: structuredClone(CLAUDE_AI_DOC), headers });
  if (url === CLAUDE_CODE_CIMD) return Promise.resolve({ body: structuredClone(CLAUDE_CODE_DOC), headers });
  return Promise.reject(new Error(`unexpected CIMD fetch ${url}`));
};

const bridgeWithKeys = (dbPath?: string) =>
  startBridge({
    authOverrides: { fetchJson: cimdStub, fetchJwks: jwksFetcher() },
    ...(dbPath ? { dbPath } : {}),
  });

// ---------------------------------------------------------------------------------------------------------------------
// Assertions

/** Every assertion this file makes, so the log scan can check none of them was ever logged. */
const issued: string[] = [];
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

interface AssertionOptions {
  readonly clientId?: string;
  readonly key?: KeyObject | Uint8Array;
  /** null: no kid header. */
  readonly kid?: string | null;
  readonly alg?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly omit?: readonly string[];
}

async function makeAssertion(b: TestBridge, o: AssertionOptions = {}): Promise<string> {
  const now = b.clock.now();
  const clientId = o.clientId ?? CHATGPT_CIMD;
  const claims: Record<string, unknown> = {
    iss: clientId,
    sub: clientId,
    aud: `${b.publicUrl}/oauth/token`,
    iat: now,
    exp: now + 120,
    jti: randomUUID(),
    ...o.claims,
  };
  for (const k of o.omit ?? []) delete claims[k];
  const header = { alg: o.alg ?? 'RS256', typ: 'JWT', ...(o.kid === null ? {} : { kid: o.kid ?? 'rsa-a' }) };
  const jwt =
    header.alg === 'none'
      ? `${b64(header)}.${b64(claims)}.`
      : await new SignJWT(claims).setProtectedHeader(header).sign(o.key ?? rsaA.privateKey);
  issued.push(jwt);
  return jwt;
}

/**
 * A token request whose grant can never succeed (an unknown refresh token): client authentication runs first, so
 * 401 invalid_client means the assertion was refused and 400 invalid_grant means it was accepted.
 */
async function probe(
  b: TestBridge,
  assertion: string | undefined,
  extra: Readonly<Record<string, string | undefined>> = {},
  clientId: string | undefined = CHATGPT_CIMD,
) {
  return tokenRequest(b, {
    grant_type: 'refresh_token',
    refresh_token: 'lkb_rt_not-a-real-token',
    client_id: clientId,
    ...(assertion !== undefined
      ? { client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }
      : {}),
    ...extra,
  });
}

function lastRejection(b: TestBridge): Record<string, unknown> | undefined {
  return logEvents(b, 'client.assertion_rejected').at(-1);
}

function expectRefused(
  b: TestBridge,
  r: Awaited<ReturnType<typeof probe>>,
  reason: string,
  fields: Record<string, unknown> = {},
) {
  expect(r.res.status, JSON.stringify(r.body)).toBe(401);
  expect(r.body.error).toBe('invalid_client');
  expect(lastRejection(b)).toMatchObject({ level: 40, reason, ...fields });
}

function expectAccepted(r: Awaited<ReturnType<typeof probe>>) {
  expect(r.res.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.error).toBe('invalid_grant');
}

/** Authorisation through sign-in and consent; checks RFC 9207 `iss` and returns the code. */
async function authorise(
  b: TestBridge,
  clientId: string,
  redirectUri = CHATGPT_REDIRECT,
  browser = new Browser(b),
): Promise<{ code: string; verifier: string; html: string }> {
  const { verifier, challenge } = pkcePair();
  const page = await reachConsent(
    browser,
    authorizeUrl(
      {
        clientId,
        redirectUri,
        challenge,
        method: 'S256',
        state: 'st-1',
        scope: 'mcp offline_access',
        resource: b.mcpUrl,
      },
      b.publicUrl,
    ),
  );
  if (page instanceof Response) throw new Error(`no consent page: ${page.status} ${await page.text()}`);
  const { location } = await decide(browser, page, 'approve');
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get('iss')).toBe(b.config.issuer);
  expect(location.searchParams.get('state')).toBe('st-1');
  return { code: location.searchParams.get('code') as string, verifier, html: page.html };
}

// ---------------------------------------------------------------------------------------------------------------------

describe('authorization-server metadata', () => {
  it('advertises private_key_jwt after "none", with asymmetric signing algorithms only', async () => {
    const b = await bridgeWithKeys();
    try {
      for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
        const m = (await (await b.fetch(`${b.publicUrl}${path}`)).json()) as Record<string, string[]>;
        for (const field of [
          'token_endpoint_auth_methods_supported',
          'revocation_endpoint_auth_methods_supported',
        ]) {
          expect(m[field]?.[0], field).toBe('none'); // Claude selects CIMD only when "none" is advertised
          expect(m[field]).toContain('private_key_jwt');
        }
        for (const field of [
          'token_endpoint_auth_signing_alg_values_supported',
          'revocation_endpoint_auth_signing_alg_values_supported',
        ]) {
          expect(m[field]).toEqual(expect.arrayContaining(['RS256', 'PS256', 'ES256']));
          expect(m[field]).not.toContain('none');
          expect(m[field]?.some((a) => /^HS/i.test(a))).toBe(false);
        }
      }
    } finally {
      await b.close();
    }
  });
});

describe('ChatGPT’s client metadata document (private_key_jwt, RS256, jwks_uri)', () => {
  it('is accepted as it really is, with the method and algorithm it names', () => {
    const m = validateCimdDocument(CHATGPT_CIMD, structuredClone(CHATGPT_DOC), []);
    expect(m.tokenEndpointAuthMethod).toBe('private_key_jwt');
    expect(m.jwksUri).toBe('https://chatgpt.com/oauth/jwks.json');
    expect(m.signingAlg).toBe('RS256');
    expect(m.redirectUris).toEqual([CHATGPT_REDIRECT]);
    expect(m.grantTypes).toEqual(['authorization_code', 'refresh_token']);
  });

  it('refuses unusable key configurations, naming the field', () => {
    const refusal = (patch: Record<string, unknown>, remove: readonly string[] = []) => {
      const doc: Record<string, unknown> = { ...structuredClone(CHATGPT_DOC), ...patch };
      for (const k of remove) delete doc[k];
      try {
        validateCimdDocument(CHATGPT_CIMD, doc, []);
      } catch (e) {
        if (e instanceof CimdError) return { message: e.message, field: e.field, value: e.value };
        throw e;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal({}, ['jwks_uri'])).toMatchObject({ field: 'jwks_uri', message: /no jwks_uri or jwks/ });
    expect(refusal({ jwks_uri: 'http://chatgpt.com/oauth/jwks.json' })).toMatchObject({
      field: 'jwks_uri',
      message: /https/,
    });
    expect(refusal({ jwks_uri: 'https://u:p@chatgpt.com/jwks' })).toMatchObject({ field: 'jwks_uri' });
    expect(refusal({ jwks: { keys: [] } })).toMatchObject({ field: 'jwks_uri', message: /both/ });
    expect(
      refusal({ jwks: { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', d: 'secret' }] } }, ['jwks_uri']),
    ).toMatchObject({ field: 'jwks', message: /private key material/ });
    expect(refusal({ jwks: { keys: [{ kty: 'oct', k: 'c2VjcmV0' }] } }, ['jwks_uri'])).toMatchObject({
      field: 'jwks',
      message: /no usable public/,
    });
    for (const alg of ['none', 'HS256', 'HS512', 'EdDSA', 'rs256']) {
      expect(refusal({ token_endpoint_auth_signing_alg: alg }), alg).toMatchObject({
        field: 'token_endpoint_auth_signing_alg',
        value: alg,
      });
    }
    for (const method of ['client_secret_jwt', 'client_secret_basic', 'tls_client_auth']) {
      expect(refusal({ token_endpoint_auth_method: method }), method).toMatchObject({
        field: 'token_endpoint_auth_method',
        value: method,
        message: 'client metadata document must use token_endpoint_auth_method "none" or "private_key_jwt"',
      });
    }
  });

  it('checks key sets and key fitness', async () => {
    expect(() => parseJwks([])).toThrow(JwksShapeError);
    expect(() => parseJwks({ keys: 'x' })).toThrow(/"keys" array/);
    expect(() => parseJwks({ keys: new Array(21).fill({ kty: 'EC' }) })).toThrow(/more than 20/);
    expect(() => parseJwks({ keys: [{ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' }] })).toThrow(
      /private/,
    );
    const rsa = await publicJwk(rsaA, 'r');
    const p256 = await publicJwk(ec, 'e');
    const [r, e] = parseJwks({
      keys: [rsa, p256, { kty: 'oct', k: 'eA' }, { kty: 'OKP', crv: 'Ed25519', x: 'a' }],
    });
    expect([r?.kid, e?.kid]).toEqual(['r', 'e']);
    if (!r || !e) throw new Error('keys');
    expect(keyFitsAlg(r, 'RS256')).toBe(true);
    expect(keyFitsAlg(r, 'PS512')).toBe(true);
    expect(keyFitsAlg(r, 'ES256')).toBe(false);
    expect(keyFitsAlg(e, 'ES256')).toBe(true);
    expect(keyFitsAlg(e, 'ES384')).toBe(false);
    expect(keyFitsAlg({ ...r, alg: 'RS256' }, 'PS256')).toBe(false);
    expect(keyFitsAlg({ ...r, use: 'enc' }, 'RS256')).toBe(false);
    expect(keyFitsAlg({ ...r, key_ops: ['sign'] }, 'RS256')).toBe(false);
    expect(keyFitsAlg({ ...r, key_ops: ['verify'] }, 'RS256')).toBe(true);
  });
});

describe('ChatGPT end to end with private_key_jwt', () => {
  let b: TestBridge;
  beforeAll(async () => {
    b = await bridgeWithKeys();
  });
  afterAll(() => b.close());

  it('authorises, exchanges the code, refreshes and revokes, each with a fresh assertion', async () => {
    const browser = new Browser(b);
    const { code, verifier, html } = await authorise(b, CHATGPT_CIMD, CHATGPT_REDIRECT, browser);
    // The consent page names chatgpt.com, and suggests a new `chatgpt` profile at the default scope.
    expect(html).toContain('<p class="host">chatgpt.com</p>');
    expect(html).toContain('It calls itself “ChatGPT”');
    expect(consentDefaults(html)).toMatchObject({
      profile: 'new',
      new_label: 'chatgpt',
      new_kind: 'chatgpt',
      scope: 'read',
    });
    expect(logEvents(b, 'client.metadata_fetched')).toContainEqual(
      expect.objectContaining({
        client_id: CHATGPT_CIMD,
        auth_method: 'private_key_jwt',
        jwks_uri: jwksUrl(MAIN_JWKS),
        signing_alg: 'RS256',
      }),
    );
    expect(b.services.store.getClient(CHATGPT_CIMD)?.tokenEndpointAuthMethod).toBe('private_key_jwt');
    expect(fetchCount(MAIN_JWKS)).toBe(0); // the key set is fetched only when an assertion arrives

    const t = await tokenRequest(b, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      client_id: CHATGPT_CIMD,
      resource: b.mcpUrl,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(t.res.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.scope).toBe('mcp offline_access');
    expect((await mcpPost(b, t.body.access_token as string)).status).toBe(200);

    // The key set was fetched once, with the bridge's own User-Agent and a key-set Accept header.
    expect(fetchCount(MAIN_JWKS)).toBe(1);
    const f = fetches.find((x) => x.path === MAIN_JWKS);
    expect(f?.userAgent).toBe(JWKS_USER_AGENT);
    expect(f?.userAgent).toMatch(/^LK-Bridge\/\d+\.\d+\.\d+ \(OAuth client key fetcher\)$/);
    expect(f?.accept).toContain('application/jwk-set+json');
    expect(logEvents(b, 'client.jwks_fetched')).toContainEqual(
      expect.objectContaining({ client_id: CHATGPT_CIMD, keys: 2, kids: 'rsa-a ec-1', cache_seconds: 300 }),
    );
    expect(logEvents(b, 'client.assertion_accepted')).toContainEqual(
      expect.objectContaining({
        client_id: CHATGPT_CIMD,
        endpoint: 'token',
        alg: 'RS256',
        kid: 'rsa-a',
        key_source: 'jwks_uri',
      }),
    );

    // Refresh, with a fresh assertion (the cached key set is used).
    const r = await tokenRequest(b, {
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token as string,
      client_id: CHATGPT_CIMD,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(fetchCount(MAIN_JWKS)).toBe(1);

    // Revocation needs the assertion too.
    const revoke = (params: Record<string, string | undefined>) =>
      b.fetch(`${b.publicUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody({ token: r.body.refresh_token as string, client_id: CHATGPT_CIMD, ...params }),
      });
    const unauthenticated = await revoke({});
    expect(unauthenticated.status).toBe(401);
    expect(((await unauthenticated.json()) as { error: string }).error).toBe('invalid_client');
    expect(lastRejection(b)).toMatchObject({ endpoint: 'revocation', reason: 'no_assertion' });
    const revoked = await revoke({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(revoked.status).toBe(200);
    expect(logEvents(b, 'token.revoked')).toContainEqual(
      expect.objectContaining({ client_id: CHATGPT_CIMD }),
    );
    const after = await tokenRequest(b, {
      grant_type: 'refresh_token',
      refresh_token: r.body.refresh_token as string,
      client_id: CHATGPT_CIMD,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(after.res.status).toBe(400);
    expect(after.body.error).toBe('invalid_grant');

    // A second connection preselects the existing chatgpt profile at its current scope.
    const again = await authorise(b, CHATGPT_CIMD, CHATGPT_REDIRECT, browser);
    expect(consentDefaults(again.html)).toMatchObject({ scope: 'read' });
    expect(consentDefaults(again.html).profile).not.toBe('new');
  });

  it('refuses a token request without an assertion, saying so in one log line, and leaves the code usable', async () => {
    const { code, verifier } = await authorise(b, CHATGPT_CIMD);
    const exchange = (extra: Record<string, string | undefined>) =>
      tokenRequest(b, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CHATGPT_REDIRECT,
        code_verifier: verifier,
        client_id: CHATGPT_CIMD,
        resource: b.mcpUrl,
        ...extra,
      });
    const bare = await exchange({});
    expect(bare.res.status).toBe(401);
    expect(bare.body.error).toBe('invalid_client');
    const line = lastRejection(b);
    expect(line).toMatchObject({
      level: 40,
      component: 'auth',
      event: 'client.assertion_rejected',
      client_id: CHATGPT_CIMD,
      endpoint: 'token',
      auth_method: 'private_key_jwt',
      reason: 'no_assertion',
      sent: 'client_id only',
    });
    expect(line?.detail).toMatch(
      /registered for private_key_jwt .* must send client_assertion; it sent client_id only/,
    );
    // The code was not spent by the refused request.
    const ok = await exchange({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('does not let the non-standard token_endpoint_auth_methods_supported field select "none"', async () => {
    // ChatGPT's document lists ["none", "private_key_jwt"] there; only token_endpoint_auth_method counts.
    expect(CHATGPT_DOC.token_endpoint_auth_methods_supported).toContain('none');
    expectRefused(b, await probe(b, undefined), 'no_assertion');
    expectRefused(b, await probe(b, undefined, { client_secret: 'anything' }), 'no_assertion', {
      sent: 'a client_secret',
    });
    expectRefused(
      b,
      await probe(b, undefined, { client_assertion_type: CLIENT_ASSERTION_TYPE }),
      'no_assertion',
      {
        sent: 'client_assertion_type without client_assertion',
      },
    );
  });

  it('accepts the issuer, or the token endpoint written in another case or with a slash, as aud', async () => {
    expectAccepted(await probe(b, await makeAssertion(b, { claims: { aud: b.config.issuer } })));
    expectAccepted(
      await probe(
        b,
        await makeAssertion(b, {
          claims: { aud: ['https://elsewhere.example', 'https://LK.EXAMPLE.TEST/oauth/token/'] },
        }),
      ),
    );
  });

  it('identifies the client from the assertion when client_id is left out', async () => {
    expectAccepted(await probe(b, await makeAssertion(b), {}, undefined));
  });

  it('allows 60 seconds of clock skew on exp, and exp up to 5 minutes (plus skew) ahead', async () => {
    const now = b.clock.now();
    expectAccepted(await probe(b, await makeAssertion(b, { claims: { exp: now - 50, iat: now - 100 } })));
    expectAccepted(await probe(b, await makeAssertion(b, { claims: { exp: now + 355 } })));
    expectAccepted(await probe(b, await makeAssertion(b, { claims: { iat: now + 50, nbf: now + 50 } })));
    expectAccepted(await probe(b, await makeAssertion(b, { omit: ['iat'] })));
  });

  it.each([
    ['a wrong signature (another key under the same kid)', { key: 'impostor' }, 'bad_signature'],
    ['an algorithm other than the declared RS256 (PS256, same key)', { alg: 'PS256' }, 'wrong_alg'],
    [
      'an algorithm other than the declared RS256 (ES256, EC key)',
      { alg: 'ES256', key: 'ec', kid: 'ec-1' },
      'wrong_alg',
    ],
    ['alg "none"', { alg: 'none' }, 'alg_not_allowed'],
    ['HS256', { alg: 'HS256', key: 'hmac' }, 'alg_not_allowed'],
    ['a wrong iss', { claims: { iss: 'https://evil.example/client.json' } }, 'wrong_iss'],
    ['a wrong sub', { claims: { sub: 'someone-else' } }, 'wrong_sub'],
    ['a wrong aud (the MCP URL)', { claims: { aud: 'https://lk.example.test/mcp' } }, 'wrong_aud'],
    ['a wrong aud (another server)', { claims: { aud: 'https://auth.openai.com/oauth/token' } }, 'wrong_aud'],
    ['no aud', { omit: ['aud'] }, 'wrong_aud'],
    ['an expired exp', { claims: { exp: 'past' } }, 'expired'],
    ['an exp too far in the future', { claims: { exp: 'far' } }, 'exp_too_far'],
    ['no exp', { omit: ['exp'] }, 'no_exp'],
    ['an nbf in the future', { claims: { nbf: 'future' } }, 'not_yet_valid'],
    ['an iat in the future', { claims: { iat: 'future' } }, 'iat_in_future'],
    ['no jti', { omit: ['jti'] }, 'no_jti'],
    ['a kid absent from the key set', { kid: 'nope' }, 'unknown_kid'],
  ] as const)('refuses an assertion with %s', async (_name, spec, reason) => {
    const now = b.clock.now();
    const times: Record<string, number> = { past: now - 61, far: now + 361, future: now + 61 };
    const claims = Object.fromEntries(
      Object.entries((spec as { claims?: Record<string, unknown> }).claims ?? {}).map(([k, v]) => [
        k,
        typeof v === 'string' && v in times ? times[v] : v,
      ]),
    );
    if (claims.exp !== undefined && claims.exp === times.past) claims.iat = now - 120;
    const keyName = (spec as { key?: string }).key;
    const key =
      keyName === 'impostor'
        ? rsaImpostor.privateKey
        : keyName === 'ec'
          ? ec.privateKey
          : keyName === 'hmac'
            ? new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!!')
            : undefined;
    const assertion = await makeAssertion(b, {
      ...(key ? { key } : {}),
      ...('alg' in spec ? { alg: spec.alg } : {}),
      ...('kid' in spec ? { kid: spec.kid } : {}),
      ...('omit' in spec ? { omit: spec.omit } : {}),
      claims,
    });
    expectRefused(b, await probe(b, assertion), reason, { client_id: CHATGPT_CIMD, endpoint: 'token' });
  });

  it('refuses a replayed jti, and a garbled or wrongly typed assertion', async () => {
    const once = await makeAssertion(b);
    expectAccepted(await probe(b, once));
    expectRefused(b, await probe(b, once), 'replayed_jti');
    expectRefused(b, await probe(b, 'not.a.jwt'), 'malformed_assertion');
    expectRefused(b, await probe(b, 'eyJhbGciOiJSUzI1NiJ9'), 'malformed_assertion');
    expectRefused(
      b,
      await probe(b, undefined, {
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:saml2-bearer',
        client_assertion: await makeAssertion(b),
      }),
      'wrong_assertion_type',
    );
    expectRefused(
      b,
      await probe(b, await makeAssertion(b), { client_secret: 'also-a-secret' }),
      'secret_not_allowed',
    );
  });

  it('refuses the assertion on the refresh grant too, and never logs an assertion', async () => {
    const { code, verifier } = await authorise(b, CHATGPT_CIMD);
    const t = await tokenRequest(b, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      client_id: CHATGPT_CIMD,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(t.res.status).toBe(200);
    const refresh = (extra: Record<string, string>) =>
      tokenRequest(b, {
        grant_type: 'refresh_token',
        refresh_token: t.body.refresh_token as string,
        client_id: CHATGPT_CIMD,
        ...extra,
      });
    const bare = await refresh({});
    expect(bare.res.status).toBe(401);
    expect(lastRejection(b)).toMatchObject({ reason: 'no_assertion' });
    const expired = await refresh({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b, {
        claims: { exp: b.clock.now() - 120, iat: b.clock.now() - 200 },
      }),
    });
    expect(expired.res.status).toBe(401);
    expect(lastRejection(b)).toMatchObject({ reason: 'expired' });
    // The refresh token survives refused attempts.
    const ok = await refresh({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b),
    });
    expect(ok.res.status, JSON.stringify(ok.body)).toBe(200);

    const all = b.logs.join('\n');
    for (const a of issued) {
      expect(all).not.toContain(a);
      expect(all).not.toContain(a.split('.')[2] || '(unsigned)');
    }
  });
});

describe('a client without a declared algorithm, and inline keys', () => {
  let b: TestBridge;
  beforeAll(async () => {
    b = await bridgeWithKeys();
    for (const id of [CLIENTS.noAlg.id, INLINE_CLIENT]) {
      const page = await reachConsent(
        new Browser(b),
        authorizeUrl(
          { clientId: id, redirectUri: CHATGPT_REDIRECT, challenge: pkcePair().challenge, method: 'S256' },
          b.publicUrl,
        ),
      );
      expect(page, id).not.toBeInstanceOf(Response);
    }
  });
  afterAll(() => b.close());

  it('accepts any supported asymmetric algorithm that fits the key, and still never none or HS256', async () => {
    const id = CLIENTS.noAlg.id;
    expectAccepted(await probe(b, await makeAssertion(b, { clientId: id }), {}, id));
    expectAccepted(await probe(b, await makeAssertion(b, { clientId: id, alg: 'PS256' }), {}, id));
    expectAccepted(
      await probe(
        b,
        await makeAssertion(b, { clientId: id, alg: 'ES256', key: ec.privateKey, kid: 'ec-1' }),
        {},
        id,
      ),
    );
    // No kid: every fitting key is tried.
    expectAccepted(await probe(b, await makeAssertion(b, { clientId: id, kid: null }), {}, id));
    expectRefused(
      b,
      await probe(b, await makeAssertion(b, { clientId: id, alg: 'none' }), {}, id),
      'alg_not_allowed',
    );
    expectRefused(
      b,
      await probe(
        b,
        await makeAssertion(b, { clientId: id, alg: 'HS256', key: new TextEncoder().encode('x'.repeat(32)) }),
        {},
        id,
      ),
      'alg_not_allowed',
    );
    // The EC key under an RSA algorithm, or the RSA key's kid under ES256: no key fits.
    expectRefused(
      b,
      await probe(b, await makeAssertion(b, { clientId: id, kid: 'ec-1' }), {}, id),
      'no_matching_key',
    );
    expectRefused(
      b,
      await probe(
        b,
        await makeAssertion(b, { clientId: id, alg: 'ES256', key: ec.privateKey, kid: 'rsa-a' }),
        {},
        id,
      ),
      'no_matching_key',
    );
  });

  it('uses an inline jwks without fetching, and refuses an unknown kid there at once', async () => {
    const before = fetches.length;
    const sign = (kid: string) =>
      makeAssertion(b, { clientId: INLINE_CLIENT, alg: 'ES256', key: ec.privateKey, kid });
    expectAccepted(await probe(b, await sign('ec-inline'), {}, INLINE_CLIENT));
    expect(logEvents(b, 'client.assertion_accepted').at(-1)).toMatchObject({ key_source: 'jwks' });
    expectRefused(b, await probe(b, await sign('other'), {}, INLINE_CLIENT), 'unknown_kid', {
      refetched: 'no',
    });
    expectRefused(
      b,
      await probe(b, await makeAssertion(b, { clientId: INLINE_CLIENT }), {}, INLINE_CLIENT),
      'wrong_alg',
    );
    expect(fetches.length).toBe(before);
  });
});

describe('key rotation: an unknown kid refetches the key set once, rate-limited', () => {
  it('finds a newly published key, and refetches for an unknown kid at most once a minute', async () => {
    const b = await bridgeWithKeys();
    const id = CLIENTS.rotating.id;
    const path = CLIENTS.rotating.jwks;
    try {
      await reachConsent(
        new Browser(b),
        authorizeUrl(
          { clientId: id, redirectUri: CHATGPT_REDIRECT, challenge: pkcePair().challenge, method: 'S256' },
          b.publicUrl,
        ),
      );
      rotating = [await publicJwk(rsaA, 'rsa-a')];
      const start = fetchCount(path);
      expectAccepted(await probe(b, await makeAssertion(b, { clientId: id }), {}, id));
      expect(fetchCount(path)).toBe(start + 1);

      // The client rotates to a new key the cached set does not have yet.
      rotating = [await publicJwk(rsaA, 'rsa-a'), await publicJwk(rsaB, 'rsa-b')];
      b.clock.advance(61);
      expectAccepted(
        await probe(b, await makeAssertion(b, { clientId: id, key: rsaB.privateKey, kid: 'rsa-b' }), {}, id),
      );
      expect(fetchCount(path)).toBe(start + 2);
      expect(logEvents(b, 'client.jwks_fetched').at(-1)).toMatchObject({ kids: 'rsa-a rsa-b' });

      // An unknown kid straight after: no refetch (rate-limited), refused.
      expectRefused(
        b,
        await probe(b, await makeAssertion(b, { clientId: id, kid: 'rsa-z' }), {}, id),
        'unknown_kid',
        {
          refetched: 'rate_limited',
          known_kids: 'rsa-a rsa-b',
        },
      );
      expect(fetchCount(path)).toBe(start + 2);
      // A minute later: one refetch, still unknown, refused.
      b.clock.advance(61);
      expectRefused(
        b,
        await probe(b, await makeAssertion(b, { clientId: id, kid: 'rsa-z' }), {}, id),
        'unknown_kid',
        {
          refetched: 'yes',
        },
      );
      expect(fetchCount(path)).toBe(start + 3);
    } finally {
      await b.close();
    }
  });
});

describe('key-set caching', () => {
  it('keeps even a no-store key set for 30 seconds, so token requests cannot drive a fetch each', async () => {
    const b = await bridgeWithKeys();
    const { id, jwks: path } = CLIENTS.noStore;
    try {
      await reachConsent(
        new Browser(b),
        authorizeUrl(
          { clientId: id, redirectUri: CHATGPT_REDIRECT, challenge: pkcePair().challenge, method: 'S256' },
          b.publicUrl,
        ),
      );
      rotating = [await publicJwk(rsaA, 'rsa-a')];
      const start = fetchCount(path);
      for (let i = 0; i < 3; i++)
        expectAccepted(await probe(b, await makeAssertion(b, { clientId: id }), {}, id));
      expect(fetchCount(path)).toBe(start + 1);
      expect(logEvents(b, 'client.jwks_fetched').at(-1)).toMatchObject({ client_id: id, cache_seconds: 30 });
      b.clock.advance(31);
      expectAccepted(await probe(b, await makeAssertion(b, { clientId: id }), {}, id));
      expect(fetchCount(path)).toBe(start + 2);
    } finally {
      await b.close();
    }
  });
});

describe('a key-set endpoint that does not answer with JSON', () => {
  let b: TestBridge;
  beforeAll(async () => {
    b = await bridgeWithKeys();
    for (const c of [CLIENTS.html, CLIENTS.challenge, CLIENTS.htmlAsJson]) {
      await reachConsent(
        new Browser(b),
        authorizeUrl(
          { clientId: c.id, redirectUri: CHATGPT_REDIRECT, challenge: pkcePair().challenge, method: 'S256' },
          b.publicUrl,
        ),
      );
    }
  });
  afterAll(() => b.close());

  it.each([
    ['an HTML page (200 text/html)', CLIENTS.html, 'bad_content_type', /got text\/html/],
    ['an HTML challenge (403)', CLIENTS.challenge, 'bad_status', /got 403/],
    ['HTML labelled application/json', CLIENTS.htmlAsJson, 'invalid_json', /not valid JSON/],
  ])('fails clearly on %s, and backs off before fetching again', async (_name, c, fetchReason, detail) => {
    const before = fetchCount(c.jwks);
    const r = await probe(b, await makeAssertion(b, { clientId: c.id }), {}, c.id);
    expectRefused(b, r, 'jwks_fetch_failed', {
      client_id: c.id,
      fetch_reason: fetchReason,
      jwks_uri: jwksUrl(c.jwks),
    });
    expect(lastRejection(b)?.detail).toMatch(detail);
    expect(fetchCount(c.jwks)).toBe(before + 1);
    // Straight after, the same failure without another fetch.
    expectRefused(
      b,
      await probe(b, await makeAssertion(b, { clientId: c.id }), {}, c.id),
      'jwks_fetch_failed',
      {
        backoff: true,
      },
    );
    expect(fetchCount(c.jwks)).toBe(before + 1);
  });
});

describe('the jti record survives a restart', () => {
  it('refuses an assertion replayed to a restarted bridge on the same database, and prunes expired jtis', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lkb-pkjwt-db-'));
    const dbPath = join(tmp, 'bridge.db');
    try {
      const first = await bridgeWithKeys(dbPath);
      const { code, verifier } = await authorise(first, CHATGPT_CIMD);
      const assertion = await makeAssertion(first);
      const t = await tokenRequest(first, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CHATGPT_REDIRECT,
        code_verifier: verifier,
        client_id: CHATGPT_CIMD,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: assertion,
      });
      expect(t.res.status).toBe(200);
      await first.close();

      const second = await bridgeWithKeys(dbPath);
      try {
        expectRefused(second, await probe(second, assertion), 'replayed_jti');
        const count = () =>
          (second.db.prepare('SELECT COUNT(*) AS n FROM auth_client_assertion_jtis').get() as { n: number })
            .n;
        expectAccepted(await probe(second, await makeAssertion(second)));
        expect(count()).toBe(2);
        // Once past exp plus the skew allowance, the record is pruned.
        second.clock.advance(120 + 61);
        second.services.prune();
        expect(count()).toBe(0);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Claude’s clients keep working with "none"', () => {
  let b: TestBridge;
  beforeAll(async () => {
    b = await bridgeWithKeys();
  });
  afterAll(() => b.close());

  it.each([
    ['claude.ai (its real document)', CLAUDE_AI_CIMD, 'https://claude.ai/api/mcp/auth_callback'],
    ['Claude Code (its real document)', CLAUDE_CODE_CIMD, 'http://localhost:40123/callback'],
  ])('%s: authorise, exchange, refresh, and no method switching', async (_name, clientId, redirectUri) => {
    const before = fetches.length;
    const { code, verifier } = await authorise(b, clientId, redirectUri);
    const t = await tokenRequest(b, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      resource: b.mcpUrl,
    });
    expect(t.res.status, JSON.stringify(t.body)).toBe(200);
    expect((await mcpPost(b, t.body.access_token as string)).status).toBe(200);
    const r = await tokenRequest(b, {
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token as string,
      client_id: clientId,
    });
    expect(r.res.status).toBe(200);
    expect(b.services.store.getClient(clientId)?.tokenEndpointAuthMethod).toBe('none');
    // A "none" client may not switch to an assertion, even a well-formed one.
    const switched = await tokenRequest(b, {
      grant_type: 'refresh_token',
      refresh_token: r.body.refresh_token as string,
      client_id: clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await makeAssertion(b, { clientId }),
    });
    expect(switched.res.status).toBe(401);
    expect(switched.body.error).toBe('invalid_client');
    expect(lastRejection(b)).toMatchObject({
      client_id: clientId,
      auth_method: 'none',
      reason: 'assertion_not_allowed',
    });
    // And the refused attempt did not spend the refresh token.
    const still = await tokenRequest(b, {
      grant_type: 'refresh_token',
      refresh_token: r.body.refresh_token as string,
      client_id: clientId,
    });
    expect(still.res.status).toBe(200);
    expect(fetches.length).toBe(before); // no key set is ever fetched for a "none" client
  });

  it('a "none" DCR client cannot send an assertion either', async () => {
    const clientId = await registerPublicClient(b);
    expectRefused(
      b,
      await probe(b, await makeAssertion(b, { clientId }), {}, clientId),
      'assertion_not_allowed',
    );
  });
});
