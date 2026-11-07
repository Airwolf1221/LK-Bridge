import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CimdError,
  cacheLifetimeSeconds,
  validateCimdDocument,
  validateCimdUrl,
} from '../../src/auth/cimd.js';
import { FormBody } from '../../src/auth/form.js';
import { isPublicAddress } from '../../src/auth/ip.js';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
import { SlidingWindowLimiter } from '../../src/auth/rate-limit.js';
import { isAllowedRedirectUri, redirectUriMatches } from '../../src/auth/redirect-uris.js';
import { safeReturnTo } from '../../src/auth/routes/login.js';
import { grantableScopes, parseScope } from '../../src/auth/scopes.js';
import { resolveResource } from '../../src/auth/tokens.js';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../../src/auth/totp.js';
import { canonicaliseResource } from '../../src/auth/url.js';
import { AuthConfigError, loadAuthConfig } from '../../src/config/auth.js';
import { MigrationError, runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ownerCredentials, throwawaySecret } from './helpers.js';

const CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
/** Claude Code's published document, verbatim (fetched 7 November 2026). */
const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_CIMD,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

describe('canonical resource URI (requirement 6)', () => {
  it.each([
    ['https://lk.example.com/mcp', 'https://lk.example.com/mcp'],
    ['HTTPS://LK.Example.COM/mcp', 'https://lk.example.com/mcp'],
    ['https://lk.example.com:443/mcp', 'https://lk.example.com/mcp'],
    ['https://lk.example.com/mcp/', 'https://lk.example.com/mcp'],
    ['https://lk.example.com/mcp#frag', 'https://lk.example.com/mcp'],
    ['https://lk.example.com', 'https://lk.example.com'],
    ['https://lk.example.com/', 'https://lk.example.com'],
    ['http://localhost:80/mcp', 'http://localhost/mcp'],
    ['https://lk.example.com:8443/mcp', 'https://lk.example.com:8443/mcp'],
  ])('%s → %s', (input, expected) => {
    expect(canonicaliseResource(input)).toBe(expected);
  });

  it('keeps path case and rejects non-http(s), credentials and relative input', () => {
    expect(canonicaliseResource('https://lk.example.com/MCP')).toBe('https://lk.example.com/MCP');
    expect(canonicaliseResource('ftp://lk.example.com/mcp')).toBeUndefined();
    expect(canonicaliseResource('https://u:p@lk.example.com/mcp')).toBeUndefined();
    expect(canonicaliseResource('/mcp')).toBeUndefined();
  });

  it('resolves the resource parameter against the canonical MCP URL', async () => {
    const { hash } = await ownerCredentials();
    const config = loadAuthConfig({
      BRIDGE_PUBLIC_URL: 'https://lk.example.com',
      OWNER_PASSWORD_HASH: hash,
      SESSION_SECRET: throwawaySecret(),
      JWT_SIGNING_KEY: throwawaySecret(),
    });
    expect(resolveResource([], config)).toBe('https://lk.example.com/mcp');
    expect(resolveResource(['https://LK.EXAMPLE.com:443/mcp/'], config)).toBe('https://lk.example.com/mcp');
    expect(resolveResource(['https://lk.example.com'], config)).toBe('https://lk.example.com/mcp');
    expect(() => resolveResource(['https://other.example.com/mcp'], config)).toThrow(/invalid_target/);
    expect(() => resolveResource(['https://lk.example.com/other'], config)).toThrow(/invalid_target/);
    expect(() =>
      resolveResource(['https://lk.example.com/mcp', 'https://evil.example/mcp'], config),
    ).toThrow();
  });
});

describe('redirect URI policy (requirement 9)', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'http://localhost/callback',
    'http://localhost:3118/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:65535/callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/abc123',
    'https://chatgpt.com/connector/oauth/A-b_C-9',
  ])('allows %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it.each([
    'https://claude.ai/api/mcp/auth_callback/',
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai/api/mcp/auth_callback#f',
    'http://claude.ai/api/mcp/auth_callback',
    'https://evil.example/api/mcp/auth_callback',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'https://localhost/callback',
    'http://localhost:3118/callback/',
    'http://localhost:3118/other',
    'http://localhost.evil.example/callback',
    'http://[::1]/callback',
    'http://user@localhost/callback',
    'http://127.0.0.2/callback',
    'http://LOCALHOST/callback',
    'javascript:alert(1)',
    'https://chatgpt.com/connector_platform_oauth_redirect/',
    'http://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/a/b',
    'https://chatgpt.com/connector/oauth/a?x=1',
    'https://chatgpt.com/connector/oauth/a.b',
    'https://chatgpt.com/connector/oauth/a%2Fb',
    'https://chatgptXcom/connector/oauth/a',
    'https://chatgpt.com.evil.example/connector/oauth/a',
    'https://evil.example/https://chatgpt.com/connector/oauth/a',
    'https://chat.openai.com/connector_platform_oauth_redirect',
  ])('refuses %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });

  it('matches loopback URIs with any port but nothing else', () => {
    expect(redirectUriMatches('http://localhost:5000/callback', 'http://localhost/callback')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1:5000/callback', 'http://127.0.0.1:4000/callback')).toBe(true);
    expect(redirectUriMatches('http://localhost:5000/callback', 'http://127.0.0.1/callback')).toBe(false);
    expect(redirectUriMatches('http://localhost:5000/cb', 'http://localhost/callback')).toBe(false);
    expect(
      redirectUriMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ),
    ).toBe(false);
  });

  it('honours extra exact URIs from configuration', () => {
    const extra = ['http://localhost:6274/oauth/callback'];
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback', extra)).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:9999/oauth/callback', extra)).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/other', extra)).toBe(false);
  });
});

describe('SSRF address policy (requirement 4)', () => {
  it.each(['8.8.8.8', '1.1.1.1', '160.79.104.10', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'treats %s as public',
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.18.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    'not-an-ip',
  ])('refuses %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe('Client ID Metadata Document rules (requirement 4)', () => {
  it('accepts Claude Code’s published document', () => {
    const m = validateCimdDocument(CLAUDE_CODE_CIMD, CLAUDE_CODE_DOC, []);
    expect(m.clientName).toBe('Claude Code');
    expect(m.redirectUris).toEqual(['http://localhost/callback', 'http://127.0.0.1/callback']);
    expect(m.tokenEndpointAuthMethod).toBe('none');
  });

  it.each([
    'http://claude.ai/oauth/meta',
    'https://claude.ai',
    'https://claude.ai/',
    'https://claude.ai/oauth/meta#x',
    'https://claude.ai/oauth/meta?x=1',
    'https://user:pw@claude.ai/oauth/meta',
    'https://claude.ai/oauth/../meta',
    'https://claude.ai/./meta',
    'https://claude.ai/oauth/%2e%2e/meta',
  ])('refuses client_id URL %s', (url) => {
    expect(() => validateCimdUrl(url)).toThrow(CimdError);
  });

  it('requires client_id to equal the URL exactly', () => {
    expect(() =>
      validateCimdDocument(CLAUDE_CODE_CIMD, { ...CLAUDE_CODE_DOC, client_id: `${CLAUDE_CODE_CIMD}/` }, []),
    ).toThrow(/does not match/);
    expect(() =>
      validateCimdDocument(CLAUDE_CODE_CIMD.replace('claude.ai', 'Claude.ai'), CLAUDE_CODE_DOC, []),
    ).toThrow(/does not match/);
  });

  it('rejects secrets, confidential auth methods, bad grants and unusable redirect URIs', () => {
    const bad = (patch: Record<string, unknown>) => () =>
      validateCimdDocument(CLAUDE_CODE_CIMD, { ...CLAUDE_CODE_DOC, ...patch }, []);
    expect(bad({ client_secret: 'x' })).toThrow(/secret/);
    expect(bad({ token_endpoint_auth_method: 'client_secret_basic' })).toThrow(/none/);
    expect(bad({ token_endpoint_auth_method: 'private_key_jwt' })).toThrow(/none/);
    expect(bad({ grant_types: ['client_credentials'] })).toThrow();
    expect(bad({ grant_types: ['authorization_code', 'implicit'] })).toThrow();
    expect(bad({ response_types: ['token'] })).toThrow();
    expect(bad({ redirect_uris: ['https://evil.example/cb'] })).toThrow(/redirect/);
    expect(bad({ redirect_uris: [] })).toThrow();
    expect(() => validateCimdDocument(CLAUDE_CODE_CIMD, [], [])).toThrow();
    expect(() => validateCimdDocument(CLAUDE_CODE_CIMD, 'x', [])).toThrow();
  });

  it('keeps only the redirect URIs the bridge allows', () => {
    const m = validateCimdDocument(
      CLAUDE_CODE_CIMD,
      { ...CLAUDE_CODE_DOC, redirect_uris: ['https://evil.example/cb', 'http://localhost/callback'] },
      [],
    );
    expect(m.redirectUris).toEqual(['http://localhost/callback']);
  });

  it('derives cache lifetimes from HTTP headers', () => {
    const d = { defaultSeconds: 600, maxSeconds: 86400 };
    const now = Date.parse('2026-11-07T00:00:00Z');
    expect(cacheLifetimeSeconds({ 'cache-control': 'max-age=3600' }, d, now)).toBe(3600);
    expect(cacheLifetimeSeconds({ 'cache-control': 'public, max-age=120', age: '20' }, d, now)).toBe(100);
    expect(cacheLifetimeSeconds({ 'cache-control': 'max-age=999999999' }, d, now)).toBe(86400);
    expect(cacheLifetimeSeconds({ 'cache-control': 'no-store' }, d, now)).toBe(0);
    expect(cacheLifetimeSeconds({ 'cache-control': 'no-cache, max-age=600' }, d, now)).toBe(0);
    expect(
      cacheLifetimeSeconds(
        { expires: 'Sat, 07 Nov 2026 00:10:00 GMT', date: 'Sat, 07 Nov 2026 00:00:00 GMT' },
        d,
        now,
      ),
    ).toBe(600);
    expect(cacheLifetimeSeconds({ expires: 'garbage' }, d, now)).toBe(0);
    expect(cacheLifetimeSeconds({}, d, now)).toBe(600);
  });
});

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA1 secret "12345678901234567890"; 6-digit values are the last 6 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%i → %s', (t, code) => {
    expect(hotp(base32Decode(secret), Math.floor(t / 30))).toBe(code);
    expect(verifyTotp(secret, code, t)).toBe(Math.floor(t / 30));
  });

  it('allows one step of skew and refuses others', () => {
    expect(verifyTotp(secret, '287082', 59 + 30)).toBeDefined();
    expect(verifyTotp(secret, '287082', 59 + 90)).toBeUndefined();
    expect(verifyTotp(secret, '28708', 59)).toBeUndefined();
    expect(verifyTotp(secret, 'abcdef', 59)).toBeUndefined();
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });
});

describe('scopes', () => {
  it('always grants mcp, keeps offline_access, ignores unknown scopes', () => {
    expect(grantableScopes(parseScope('mcp offline_access'))).toEqual(['mcp', 'offline_access']);
    expect(grantableScopes(parseScope(undefined))).toEqual(['mcp']);
    expect(grantableScopes(parseScope('openid profile'))).toEqual(['mcp']);
    expect(grantableScopes(parseScope('offline_access'))).toEqual(['mcp', 'offline_access']);
    expect(() => parseScope('mcp "bad"')).toThrow();
  });
});

describe('form bodies', () => {
  it('reports repeated parameters but allows repeatable ones', () => {
    const f = FormBody.parse('a=1&a=2&resource=x&resource=y&b=');
    expect(f.duplicates(['resource'])).toEqual(['a']);
    expect(f.getAll('resource')).toEqual(['x', 'y']);
    expect(f.get('b')).toBeUndefined();
  });
});

describe('login helpers', () => {
  it('limits return_to to same-site authorize and dashboard paths', () => {
    expect(safeReturnTo('/oauth/authorize?client_id=x')).toBe('/oauth/authorize?client_id=x');
    expect(safeReturnTo('/ui')).toBe('/ui');
    expect(safeReturnTo('/ui/jobs')).toBe('/ui/jobs');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/oauth/token',
      '/uix',
      'ui',
    ]) {
      expect(safeReturnTo(bad)).toBeUndefined();
    }
  });

  it('rate-limits with a sliding window', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => t);
    l.hit('a');
    l.hit('a');
    expect(l.retryAfterMs('a')).toBe(1000);
    expect(l.retryAfterMs('b')).toBe(0);
    t = 1001;
    expect(l.retryAfterMs('a')).toBe(0);
  });

  it('hashes owner passwords with Argon2id', async () => {
    const hash = await hashPassword('a long passphrase', { memoryCost: 1024, timeCost: 1, parallelism: 1 });
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(await verifyPassword(hash, 'a long passphrase')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });

  it('verifies a production-cost Argon2id hash well inside the endpoint budget', async () => {
    const hash = await hashPassword('a long passphrase');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    const t0 = performance.now();
    expect(await verifyPassword(hash, 'a long passphrase')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('auth configuration (requirement 15)', () => {
  const base = async () => ({
    BRIDGE_PUBLIC_URL: 'https://lk.example.com',
    OWNER_PASSWORD_HASH: (await ownerCredentials()).hash,
    SESSION_SECRET: throwawaySecret(),
    JWT_SIGNING_KEY: throwawaySecret(),
  });

  it('normalises the public URL and derives the MCP and metadata URLs', async () => {
    const c = loadAuthConfig({ ...(await base()), BRIDGE_PUBLIC_URL: 'https://LK.Example.com:443/' });
    expect(c.publicUrl).toBe('https://lk.example.com');
    expect(c.mcpUrl).toBe('https://lk.example.com/mcp');
    expect(c.resourceMetadataUrl).toBe('https://lk.example.com/.well-known/oauth-protected-resource/mcp');
    expect(c.secureCookies).toBe(true);
    expect(c.owner.username).toBe('owner');
  });

  it.each([
    [{ BRIDGE_PUBLIC_URL: undefined }, /BRIDGE_PUBLIC_URL/],
    [{ BRIDGE_PUBLIC_URL: 'http://lk.example.com' }, /https/],
    [{ BRIDGE_PUBLIC_URL: 'https://lk.example.com/bridge' }, /no path/],
    [{ BRIDGE_PUBLIC_URL: 'https://lk.example.com/?x=1' }, /query/],
    [{ BRIDGE_PUBLIC_URL: 'not a url' }, /absolute URL/],
    [{ OWNER_PASSWORD_HASH: undefined }, /setup:owner/],
    [{ OWNER_PASSWORD_HASH: '$2b$10$abcdefghijklmnopqrstuv' }, /Argon2id/],
    [{ OWNER_PASSWORD_HASH: '$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' }, /Argon2id/],
    [{ SESSION_SECRET: undefined }, /SESSION_SECRET is required/],
    [{ SESSION_SECRET: 'too-short' }, /SESSION_SECRET must be at least 32/],
    [{ JWT_SIGNING_KEY: 'x'.repeat(31) }, /JWT_SIGNING_KEY/],
    [{ OWNER_TOTP_SECRET: 'not base32!' }, /OWNER_TOTP_SECRET/],
    [{ OWNER_TOTP_SECRET: 'JBSWY3DP' }, /OWNER_TOTP_SECRET/],
    [{ OAUTH_EXTRA_REDIRECT_URIS: 'http://evil.example/cb' }, /OAUTH_EXTRA_REDIRECT_URIS/],
    [{ OAUTH_EXTRA_REDIRECT_URIS: 'https://chatgpt.com/connector/oauth/*' }, /wildcard/],
    [{ OAUTH_EXTRA_REDIRECT_URIS: 'https://chatgpt.com/cb#x' }, /fragment/],
    [{ OAUTH_EXTRA_REDIRECT_URIS: 'https://user:pw@chatgpt.com/cb' }, /credentials/],
    [{ OAUTH_EXTRA_REDIRECT_URIS: 'https://ChatGPT.com/cb' }, /exactly as https:\/\/chatgpt\.com\/cb/],
    [{ OAUTH_EXTRA_REDIRECT_URIS: 'not a url' }, /OAUTH_EXTRA_REDIRECT_URIS/],
    [{ TRUST_PROXY: 'true' }, /TRUST_PROXY: trusting every address/],
    [{ TRUST_PROXY: '10.0.0.1/40' }, /TRUST_PROXY/],
    [{ TRUST_PROXY: 'proxy.example' }, /TRUST_PROXY/],
    [{ AUTH_REFRESH_GRACE_SECONDS: '61' }, /AUTH_REFRESH_GRACE_SECONDS/],
    [{ AUTH_MCP_ALLOWED_ORIGINS: 'https://claude.ai/path' }, /AUTH_MCP_ALLOWED_ORIGINS/],
  ])('rejects %o with a clear message', async (patch, message) => {
    const env: Record<string, string | undefined> = { ...(await base()), ...patch };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    expect(() => loadAuthConfig(env)).toThrow(AuthConfigError);
    expect(() => loadAuthConfig(env)).toThrow(message);
  });

  it('parses OAUTH_EXTRA_REDIRECT_URIS, TRUST_PROXY and the grace window', async () => {
    const env = await base();
    const c = loadAuthConfig(env);
    expect(c.extraRedirectUris).toEqual([]);
    expect(c.trustProxy).toEqual(['loopback']);
    expect(c.ttl.refreshGraceSeconds).toBe(10);
    expect(c.mcpAllowedOrigins).toEqual(['https://claude.ai', 'https://claude.com', 'https://chatgpt.com']);
    const d = loadAuthConfig({
      ...env,
      OAUTH_EXTRA_REDIRECT_URIS: ' https://chatgpt.com/aip/g-123/oauth/callback , https://chatgpt.com/other ',
      TRUST_PROXY: '127.0.0.1, 10.0.0.0/8, ::1, uniquelocal',
      AUTH_REFRESH_GRACE_SECONDS: '0',
    });
    expect(d.extraRedirectUris).toEqual([
      'https://chatgpt.com/aip/g-123/oauth/callback',
      'https://chatgpt.com/other',
    ]);
    expect(d.trustProxy).toEqual(['127.0.0.1', '10.0.0.0/8', '::1', 'uniquelocal']);
    expect(d.ttl.refreshGraceSeconds).toBe(0);
    expect(loadAuthConfig({ ...env, TRUST_PROXY: 'none' }).trustProxy).toBe(false);
  });

  it('allows plain http only for loopback, and refuses identical secrets', async () => {
    const env = await base();
    expect(loadAuthConfig({ ...env, BRIDGE_PUBLIC_URL: 'http://127.0.0.1:8787' }).secureCookies).toBe(false);
    expect(() => loadAuthConfig({ ...env, JWT_SIGNING_KEY: env.SESSION_SECRET })).toThrow(/different/);
  });

  it('never echoes secret values in errors', async () => {
    const leaked = 'short-secret-value';
    try {
      loadAuthConfig({
        ...(await base()),
        SESSION_SECRET: leaked,
        OWNER_PASSWORD_HASH: 'plaintext-password',
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(leaked);
      expect((e as Error).message).not.toContain('plaintext-password');
    }
  });
});

describe('migration runner', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('applies the auth migration once and records it', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db).applied).toContain('0100_auth_init.sql');
    expect(runMigrations(db).applied).toEqual([]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'auth_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      'auth_access_tokens',
      'auth_clients',
      'auth_codes',
      'auth_owner_sessions',
      'auth_owner_state',
      'auth_pats',
      'auth_refresh_tokens',
      'auth_token_families',
    ]);
    db.close();
  });

  it('applies in version order, tolerates late lower versions, and refuses edited or misnamed files', () => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-mig-'));
    writeFileSync(join(dir, '0200_b.sql'), 'CREATE TABLE b (x);');
    const db = openDatabase(':memory:');
    expect(runMigrations(db, dir).applied).toEqual(['0200_b.sql']);
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (x);');
    expect(runMigrations(db, dir).applied).toEqual(['0001_a.sql']);
    writeFileSync(join(dir, '0200_b.sql'), 'CREATE TABLE b (x, y);');
    expect(() => runMigrations(db, dir)).toThrow(MigrationError);
    writeFileSync(join(dir, '0200_b.sql'), 'CREATE TABLE b (x);');
    writeFileSync(join(dir, 'bad name.sql'), '');
    expect(() => runMigrations(db, dir)).toThrow(/0001_slug/);
    db.close();
  });

  it('rolls back a failing migration', () => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-mig-'));
    writeFileSync(join(dir, '0001_bad.sql'), 'CREATE TABLE t (x); THIS IS NOT SQL;');
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
    db.close();
  });
});
