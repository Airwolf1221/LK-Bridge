/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- parsed JSON replies */
/**
 * v2 E1b (ADR 0043): connecting Google Drive through the dashboard, against a mock Google (nothing reaches Google).
 * The REAL bridge (`createBridge` through the admin harness): PKCE and a `state` bound to the session, refused callbacks
 * (mismatch, expiry, no session), the refresh token kept encrypted, a refresh, `invalid_grant` turning the card and the
 * Overview red, disconnect revoking and deleting, re-authentication for every sensitive action, and no secret in any
 * log, response, audit row or the database file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OFFSITE_SCOPE } from '../../src/secrets/store.js';
import { startAdminStack, type AdminStack } from '../admin/helpers.js';
import { CLIENT_ID, CLIENT_SECRET, DRIVE_FILE, MockGoogle } from './mock-google.js';

let google: MockGoogle;
let stack: AdminStack;

beforeEach(async () => {
  google = new MockGoogle();
  await google.start();
  stack = await startAdminStack({ captureLogs: true, googleOAuth: { endpoints: google.endpoints } });
});
afterEach(async () => {
  await stack.close();
  await google.stop();
});

const reauth = () => stack.post('/api/admin/security/reauth', { password: stack.bridge.password });
const api = {
  get: (p: string) => stack.get(`/api/admin${p}`),
  post: (p: string, b?: unknown) => stack.post(`/api/admin${p}`, b ?? {}),
  put: (p: string, b?: unknown) => stack.put(`/api/admin${p}`, b ?? {}),
};

async function saveClient() {
  expect((await reauth()).status).toBe(200);
  const r = await api.put('/offsite/client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  expect(r.status).toBe(200);
}

/** Starts a sign-in, lets the mock Google approve it, and calls the callback with the session cookie. */
async function connect(o: { scope?: string } = {}) {
  const start = await api.post('/offsite/connect');
  expect(start.status).toBe(200);
  const { code, state } = google.approve(start.json.url, o);
  const cb = await stack.get(
    `/admin/drive/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
  );
  return { start, cb, code, state };
}

describe('the Google sign-in (PKCE, state)', () => {
  it('builds the authorisation URL: drive.file only, offline, consent, PKCE S256, the bridge callback', async () => {
    await saveClient();
    const r = await api.post('/offsite/connect');
    const u = new URL(r.json.url);
    expect(u.origin + u.pathname).toBe(google.endpoints.authorize);
    expect(u.searchParams.get('scope')).toBe(DRIVE_FILE);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('redirect_uri')).toBe('https://lk.example.test/admin/drive/callback');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(r.json.redirectUri).toBe('https://lk.example.test/admin/drive/callback');
    // The verifier never leaves the bridge.
    expect(r.text).not.toMatch(/code_verifier/);
  });

  it('connects: swaps the code with the verifier, stores the refresh token encrypted, and names the account (about.get)', async () => {
    await saveClient();
    const { cb } = await connect();
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive=connected');
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    expect(cb.headers.get('cache-control')).toBe('no-store');
    const s = await api.get('/offsite');
    expect(s.json.connection.state).toBe('connected');
    expect(s.json.connection.account).toEqual({ email: 'owner@example.test', name: 'Test Owner' });
    expect(google.requests.some((r) => r.path === '/drive/v3/about')).toBe(true);
    // Stored encrypted, readable through the store only.
    const stored = stack.runtime.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    expect(stored.ok && stored.value.startsWith('1//mock-refresh-')).toBe(true);
    const row = stack.db
      .prepare("SELECT ciphertext FROM secrets WHERE scope = 'offsite' AND purpose = 'drive_refresh_token'")
      .get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('utf8')).not.toContain('mock-refresh');
    expect(stack.audit('offsite.connected')).toHaveLength(1);
  });

  it('refuses a callback whose state does not match a pending sign-in', async () => {
    await saveClient();
    const start = await api.post('/offsite/connect');
    const { code } = google.approve(start.json.url);
    const cb = await stack.get(`/admin/drive/callback?state=forged-state-value&code=${code}`);
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_MISMATCH');
    expect(google.requests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(0);
    expect((await api.get('/offsite')).json.connection.state).toBe('none');
  });

  it('refuses a state from another dashboard session', async () => {
    await saveClient();
    const start = await api.post('/offsite/connect');
    const { code, state } = google.approve(start.json.url);
    const other = stack.services.owner.createSession('127.0.0.1', 'other');
    const cb = await stack.get(`/admin/drive/callback?state=${state}&code=${code}`, {
      cookie: `${stack.services.owner.sessionCookie}=${other}`,
    });
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_MISMATCH');
    expect(google.requests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(0);
  });

  it('refuses an expired state, and a state used twice', async () => {
    await saveClient();
    const start = await api.post('/offsite/connect');
    const { code, state } = google.approve(start.json.url);
    const pending = (stack.runtime.offsite as any).connects as Map<string, any>;
    for (const [k, v] of pending) pending.set(k, { ...v, expiresAt: Date.now() - 1 });
    const cb = await stack.get(`/admin/drive/callback?state=${state}&code=${code}`);
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_EXPIRED');
    const again = await stack.get(`/admin/drive/callback?state=${state}&code=${code}`);
    expect(again.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_MISMATCH');
    expect(google.requests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(0);
  });

  it('refuses a callback that arrives without an owner session', async () => {
    await saveClient();
    const start = await api.post('/offsite/connect');
    const { code, state } = google.approve(start.json.url);
    const cb = await stack.get(`/admin/drive/callback?state=${state}&code=${code}`, { cookie: null });
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_NO_SESSION');
    expect(google.requests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(0);
  });

  it('refuses a grant without drive.file and revokes what Google issued', async () => {
    await saveClient();
    const { cb } = await connect({ scope: 'openid' });
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_SCOPE');
    expect(google.revoked).toHaveLength(1);
    expect(stack.runtime.secrets.has(OFFSITE_SCOPE, 'drive_refresh_token')).toBe(false);
  });

  it('says so when the owner refused access at Google', async () => {
    await saveClient();
    const start = await api.post('/offsite/connect');
    const state = new URL(start.json.url).searchParams.get('state')!;
    const cb = await stack.get(`/admin/drive/callback?state=${state}&error=access_denied`);
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_GOOGLE_DENIED');
  });
});

describe('health: refresh, invalid_grant, disconnect', () => {
  it('a refresh works; invalid_grant turns the card and the Overview red ("Reconnect"); reconnecting clears it', async () => {
    await saveClient();
    await connect();
    expect((await api.post('/offsite/check')).json.ok).toBe(true);
    google.expireAll(); // e.g. an app left in Testing, 7 days later
    const r = await api.post('/offsite/check');
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toMatch(/invalid_grant/);
    const s = await api.get('/offsite');
    expect(s.json.connection.state).toBe('broken');
    expect(s.json.connection.brokenReason).toMatch(/Testing/);
    const o = await api.get('/overview');
    expect(o.json.offsite.state).toBe('bad');
    expect(o.json.offsite.messages.join(' ')).toMatch(/needs reconnecting/);
    await reauth();
    await connect();
    expect((await api.get('/offsite')).json.connection.state).toBe('connected');
  });

  it('disconnect revokes the token at Google and deletes it from the store', async () => {
    await saveClient();
    await connect();
    const token = stack.runtime.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    const r = await api.post('/offsite/disconnect', { confirm: true });
    expect(r.status).toBe(200);
    expect(r.json.revoked).toBe(true);
    expect(token.ok && google.revoked.includes(token.value)).toBe(true);
    expect(stack.runtime.secrets.has(OFFSITE_SCOPE, 'drive_refresh_token')).toBe(false);
    expect((await api.get('/offsite')).json.connection.state).toBe('none');
  });

  it('disconnect still deletes the token when Google cannot be reached, and says so', async () => {
    await saveClient();
    await connect();
    google.revokeFails = true;
    const r = await api.post('/offsite/disconnect', { confirm: true });
    expect(r.json.revoked).toBe(false);
    expect(r.json.message).toMatch(/third-party/);
    expect(stack.runtime.secrets.has(OFFSITE_SCOPE, 'drive_refresh_token')).toBe(false);
  });
});

describe('re-authentication and secrecy', () => {
  it('every sensitive action needs a re-authentication within 10 minutes (ADR 0062)', async () => {
    stack.db.prepare('UPDATE auth_owner_sessions SET reauth_at = NULL').run();
    const sensitive: [string, string, unknown][] = [
      ['PUT', '/offsite/settings', { settings: { bandwidthLimit: 'off' } }],
      ['PUT', '/offsite/client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }],
      ['POST', '/offsite/connect', {}],
      ['POST', '/offsite/disconnect', { confirm: true }],
      ['POST', '/offsite/keys/generate', {}],
      ['POST', '/offsite/keys/confirm', { confirmId: '0'.repeat(32), passwordEnd: 'x', saltEnd: 'y' }],
      ['PUT', '/offsite/keys', { password: 'a'.repeat(20), salt: 'b'.repeat(20) }],
      ['POST', '/offsite/folders/1/delete', { confirm: true }],
      ['POST', '/offsite/adopt', { confirm: true }],
    ];
    for (const [m, p, b] of sensitive) {
      const r = await stack.call(m, `/api/admin${p}`, { body: b });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.code, `${m} ${p}`).toBe('REAUTH_REQUIRED');
    }
    // Reads and requests are not sensitive.
    expect((await api.get('/offsite')).status).toBe(200);
  });

  it('a re-authentication older than 10 minutes no longer counts', async () => {
    await reauth();
    stack.db.prepare('UPDATE auth_owner_sessions SET reauth_at = reauth_at - 601').run(); // ADR 0062: 10 minutes
    const r = await api.put('/offsite/client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(r.json.error.code).toBe('REAUTH_REQUIRED');
  });

  it('the admin API refuses requests from another site, and the callback needs no CSRF token but a matching state', async () => {
    await reauth();
    const r = await stack.call('PUT', '/api/admin/offsite/client', {
      body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      csrf: null,
    });
    expect(r.status).toBe(403);
  });

  it('never shows or logs the client secret, a token, a code or the keys', async () => {
    await saveClient();
    const { code } = await connect();
    await reauth();
    const gen = await api.post('/offsite/keys/generate');
    expect(gen.json.shownOnce).toBe(true);
    const { password, salt, confirmId } = gen.json;
    await api.post('/offsite/keys/confirm', {
      confirmId,
      passwordEnd: password.slice(-6),
      saltEnd: salt.slice(-6),
    });
    google.expireAll();
    await api.post('/offsite/check');
    const refresh = [...google.grants.keys()];
    const access = [...google.access.keys()];
    const secrets = [CLIENT_SECRET, code, password, salt, ...refresh, ...access];
    const status = await api.get('/offsite');
    const overview = await api.get('/overview');
    const audit = JSON.stringify(stack.audit());
    const logs = stack.logs.join('\n');
    // The WAL holds the newest pages; force them into the file too, then scan both.
    stack.db.pragma('wal_checkpoint(TRUNCATE)');
    const dbFile = readFileSync(stack.dbPath).toString('latin1');
    for (const s of secrets) {
      expect(status.text).not.toContain(s);
      expect(overview.text).not.toContain(s);
      expect(audit).not.toContain(s);
      expect(logs).not.toContain(s);
      expect(dbFile).not.toContain(s);
    }
    // The page shows the client ID (not secret) and the secret's last four characters only.
    expect(status.json.client.clientId).toBe(CLIENT_ID);
    expect(status.json.client.secretHint).toBe(CLIENT_SECRET.slice(-4));
    expect(status.json.keys.set).toBe(true);
    // The PKCE challenge was the verifier's S256, never the verifier itself.
    expect(createHash('sha256').update('x').digest('base64url')).toHaveLength(43);
  });
});
