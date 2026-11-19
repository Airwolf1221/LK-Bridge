/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * ADR 0062 (the owner's request after CR-2026-11-R3): the dashboard's session lasts 30 days from its last use, in an
 * HttpOnly, Secure, SameSite=Strict cookie, and is kept on the server (it survives a restart and can be revoked); "Sign
 * out everywhere" ends them all; sensitive actions need a step-up (the authenticator code within the last ten minutes, or
 * the password when no authenticator is set up), approving a proposal of a guarded kind among them; and the three pages
 * reached from another site (the OAuth consent page, Google Drive's return, a link to the dashboard) bounce once so the
 * Strict cookie comes with them. Mocks only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { totp } from '../../src/auth/totp.js';
import { PROJECT, startAdminStack, type AdminStack } from '../admin/helpers.js';
import {
  Browser,
  PUBLIC_URL,
  authorizeUrl,
  pkcePair,
  registerPublicClient,
  startBridge,
  throwawaySecret,
} from './helpers.js';

const CB = 'https://claude.ai/api/mcp/auth_callback';
const DAY = 86_400;

describe('a sliding 30-day session (ADR 0062 decision 1)', () => {
  it('each use moves the end 30 days on (at most once a minute); used every 29 days it lives on; 30 days unused, it ends', async () => {
    const bridge = await startBridge();
    try {
      const clientId = await registerPublicClient(bridge);
      const url = authorizeUrl({
        clientId,
        redirectUri: CB,
        challenge: pkcePair().challenge,
        method: 'S256',
      });
      const browser = new Browser(bridge);
      await browser.login();
      const row = () =>
        bridge.db.prepare('SELECT expires_at, last_seen_at FROM auth_owner_sessions').get() as {
          expires_at: number;
          last_seen_at: number;
        };
      const signedIn = bridge.clock.now();
      expect(row().expires_at).toBe(signedIn + 30 * DAY);
      // Within the minute: nothing written.
      bridge.clock.advance(30);
      expect((await browser.request(url)).status).toBe(200);
      expect(row()).toEqual({ expires_at: signedIn + 30 * DAY, last_seen_at: signedIn });
      for (let i = 1; i <= 3; i++) {
        bridge.clock.advance(29 * DAY);
        const page = await browser.request(url);
        expect(page.status, `after ${i * 29} days`).toBe(200);
        expect(row().expires_at).toBe(bridge.clock.now() + 30 * DAY);
        // The consent page is a use too: its cookie is renewed with it.
        expect(page.headers.getSetCookie().find((c) => c.startsWith('__Host-lkb_session='))).toMatch(
          /; Max-Age=2592000/,
        );
      }
      // 87 days after signing in it still holds; 30 days without a use, it has ended.
      bridge.clock.advance(30 * DAY + 1);
      expect((await browser.request(url)).status).toBe(302);
    } finally {
      await bridge.close();
    }
  });

  it('the live stream’s periodic check does not count as a use: an idle open dashboard does not keep it alive', async () => {
    const bridge = await startBridge();
    try {
      const browser = new Browser(bridge);
      await browser.login();
      const token = browser.cookies.get('__Host-lkb_session')!;
      const ends = () =>
        (bridge.db.prepare('SELECT expires_at FROM auth_owner_sessions').get() as { expires_at: number })
          .expires_at;
      const end = ends();
      bridge.clock.advance(2 * DAY);
      expect(bridge.services.owner.isLive(token)).toBe(true);
      expect(ends()).toBe(end);
      bridge.clock.advance(28 * DAY + 1);
      expect(bridge.services.owner.isLive(token)).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('an explicit, lower AUTH_SESSION_TTL_SECONDS still wins (the env file’s, as before)', async () => {
    const bridge = await startBridge({ env: { AUTH_SESSION_TTL_SECONDS: '3600' } });
    try {
      const clientId = await registerPublicClient(bridge);
      const url = authorizeUrl({
        clientId,
        redirectUri: CB,
        challenge: pkcePair().challenge,
        method: 'S256',
      });
      const browser = new Browser(bridge);
      const res = await browser.login();
      expect(res.headers.getSetCookie().find((c) => c.startsWith('__Host-lkb_session='))).toMatch(
        /Max-Age=3600/,
      );
      bridge.clock.advance(3000);
      expect((await browser.request(url)).status).toBe(200); // used: an hour on from now
      bridge.clock.advance(3000);
      expect((await browser.request(url)).status).toBe(200);
      bridge.clock.advance(3601);
      expect((await browser.request(url)).status).toBe(302);
    } finally {
      await bridge.close();
    }
  });
});

describe('sessions kept on the server (ADR 0062 decision 3)', () => {
  it('a session survives a restart of the bridge; its token is stored only as a hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-sessions-'));
    const dbPath = join(dir, 'bridge.db');
    const env = { SESSION_SECRET: throwawaySecret(), JWT_SIGNING_KEY: throwawaySecret() };
    try {
      const first = await startBridge({ dbPath, env });
      const browser = new Browser(first);
      await browser.login();
      const clientId = await registerPublicClient(first);
      const token = browser.cookies.get('__Host-lkb_session')!;
      const stored = JSON.stringify(first.db.prepare('SELECT * FROM auth_owner_sessions').all());
      expect(stored).not.toContain(token);
      await first.close();

      const second = await startBridge({ dbPath, env });
      try {
        const again = new Browser(second);
        again.cookies.set('__Host-lkb_session', token);
        const url = authorizeUrl({
          clientId,
          redirectUri: CB,
          challenge: pkcePair().challenge,
          method: 'S256',
        });
        expect((await again.request(url)).status).toBe(200); // still signed in: the consent page, not the sign-in
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------- the dashboard's side

let s: AdminStack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const nowS = () => Math.floor(Date.now() / 1000);
const sessionRow = (stack: AdminStack) =>
  stack.db
    .prepare('SELECT expires_at, last_seen_at, reauth_at FROM auth_owner_sessions WHERE session_hash = ?')
    .get(stack.services.sessionHash(stack.sessionToken)) as {
    expires_at: number;
    last_seen_at: number;
    reauth_at: number | null;
  };
const setReauth = (stack: AdminStack, at: number | null) =>
  stack.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(at, stack.services.sessionHash(stack.sessionToken));
const sessionCookieOf = (stack: AdminStack, headers: Headers) =>
  headers.getSetCookie().find((c) => c.startsWith(`${stack.services.owner.sessionCookie}=`));

describe('the cookie (ADR 0062 decision 2)', () => {
  it('a use of the dashboard (its API or its pages) renews the cookie: HttpOnly, Secure, SameSite=Strict, 30 days', async () => {
    s = await startAdminStack();
    const stack = s;
    const hash = stack.services.sessionHash(stack.sessionToken);
    const usedAgo = (seconds: number) =>
      stack.db
        .prepare('UPDATE auth_owner_sessions SET last_seen_at = ?, expires_at = ? WHERE session_hash = ?')
        .run(nowS() - seconds, nowS() - seconds + 30 * DAY, hash);

    usedAgo(DAY);
    const api = await stack.get('/api/admin/session');
    expect(api.status).toBe(200);
    const cookie = sessionCookieOf(stack, api.headers);
    expect(cookie).toBeDefined();
    for (const part of [/; Max-Age=2592000/, /; HttpOnly/, /; Secure/, /; SameSite=Strict/, /; Path=\//])
      expect(cookie).toMatch(part);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie!.startsWith('__Host-')).toBe(true);
    expect(sessionRow(stack).expires_at).toBeGreaterThanOrEqual(nowS() + 30 * DAY - 2);

    // Within the minute: no write, no cookie.
    expect(sessionCookieOf(stack, (await stack.get('/api/admin/session')).headers)).toBeUndefined();

    // The pages too.
    usedAgo(2 * DAY);
    const page = await stack.get('/ui');
    expect(page.status).toBe(200);
    expect(sessionCookieOf(stack, page.headers)).toMatch(/; Max-Age=2592000/);
  });
});

describe('Sign out everywhere (ADR 0062 decision 4)', () => {
  it('ends every owner session, this one included; needs no step-up but the CSRF token and a confirm; audited', async () => {
    s = await startAdminStack();
    const stack = s;
    const phone = stack.services.owner.createSession('127.0.0.1', 'phone');
    setReauth(stack, null); // signed in, not stepped up: still allowed (it only takes access away)
    expect((await stack.get('/api/admin/security')).json.sessions).toMatchObject({ active: 2 });

    expect(
      (await stack.post('/api/admin/security/sessions/revoke-all', { confirm: true }, { csrf: null })).status,
    ).toBe(403);
    expect(
      (
        await stack.post(
          '/api/admin/security/sessions/revoke-all',
          { confirm: true },
          { origin: 'https://evil.example', headers: { 'sec-fetch-site': 'cross-site' } },
        )
      ).status,
    ).toBe(403);
    expect((await stack.post('/api/admin/security/sessions/revoke-all', {})).status).toBe(400);
    expect((await stack.get('/api/admin/session')).status).toBe(200); // nothing ended yet

    const r = await stack.post('/api/admin/security/sessions/revoke-all', { confirm: true });
    expect(r.status, r.text).toBe(200);
    expect(r.json.revoked).toBe(2);
    expect(sessionCookieOf(stack, r.headers)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await stack.get('/api/admin/session')).status).toBe(401);
    const phoneCookie = `${stack.services.owner.sessionCookie}=${phone}`;
    expect((await stack.get('/api/admin/session', { cookie: phoneCookie })).status).toBe(401);
    expect(stack.audit('owner.sessions_revoked')[0]).toMatchObject({ actor: 'owner' });
    expect(stack.services.owner.activeSessions()).toBe(0);
  });
});

describe('the step-up (ADR 0062 decision 5)', () => {
  it('without an authenticator: the password; with one: its code or a recovery code, never the password alone', async () => {
    s = await startAdminStack();
    const stack = s;
    const reauth = (body: Record<string, string>) => stack.post('/api/admin/security/reauth', body);
    setReauth(stack, null);

    // No authenticator: the password.
    expect((await reauth({ password: 'not-the-password' })).json.error.code).toBe('REAUTH_FAILED');
    const byPassword = await reauth({ password: stack.bridge.password });
    expect(byPassword.status, byPassword.text).toBe(200);
    expect(byPassword.json.until).toBeGreaterThan(Date.now() + 590_000);
    expect(byPassword.json.until).toBeLessThanOrEqual(Date.now() + 601_000);

    // The authenticator is set up (itself a sensitive change, so within the step-up).
    const enrol = await stack.post('/api/admin/security/totp/enrol', {});
    expect(enrol.status, enrol.text).toBe(200);
    const secret = enrol.json.secret as string;
    const confirmed = await stack.post('/api/admin/security/totp/confirm', {
      code: totp(secret, nowS() - 30),
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    const recovery = (confirmed.json.recoveryCodes as string[])[0]!;

    setReauth(stack, null);
    const passwordAlone = await reauth({ password: stack.bridge.password });
    expect(passwordAlone.status).toBe(401);
    expect(passwordAlone.json.error.code).toBe('REAUTH_FAILED');
    const code = totp(secret, nowS());
    expect((await reauth({ totp: code })).status).toBe(200);
    setReauth(stack, null);
    expect((await reauth({ totp: code })).json.error.code).toBe('REAUTH_FAILED'); // a code is good once
    expect((await reauth({ totp: recovery })).status).toBe(200);
    setReauth(stack, null);
    expect((await reauth({ totp: recovery })).json.error.code).toBe('REAUTH_FAILED'); // a recovery code too
    expect((await stack.get('/api/admin/session')).json.totpEnabled).toBe(true);
  });

  it('lasts ten minutes', async () => {
    s = await startAdminStack();
    const stack = s;
    const contact = (value: string) =>
      stack.put('/api/admin/settings/contact-email', { value, confirm: true });
    setReauth(stack, nowS() - 590);
    expect((await contact('owner@example.test')).status).toBe(200);
    setReauth(stack, nowS() - 601);
    const late = await contact('owner2@example.test');
    expect(late.status).toBe(403);
    expect(late.json.error.code).toBe('REAUTH_REQUIRED');
    expect(late.json.error.message).toMatch(/10 minutes/);
  });

  it('settings, keys and scopes need it; the brakes (pause writes, revoke a connection, a job’s cancel) do not', async () => {
    s = await startAdminStack();
    const stack = s;
    await stack.runtime.ready;
    setReauth(stack, null);
    const profile = stack.policy.commands.createProfile('owner', {
      label: 'r3 brakes',
      kind: 'other',
      scope: 'read',
    });
    const conn = stack.services.pats.create({ name: 'r3 brakes', profileId: profile.id });
    const needs: [string, string, unknown][] = [
      ['PUT', '/settings/read-only', { value: true }],
      ['PUT', '/settings/tier-limits', { value: null, confirm: true }],
      ['PUT', '/budgets/reserve-floors', { reset: true, confirm: true }],
      ['PUT', '/writers/max', { value: 2, confirm: true }],
      ['POST', '/maintenance/snapshot-full/enable', {}],
      ['PUT', '/maintenance/snapshot-full/schedule', { schedule: null }],
      ['PUT', '/tool-calls/retention', { days: 30 }],
      ['PUT', '/clients/settings/stale-after-days', { days: 30 }],
      ['PUT', `/clients/profiles/${profile.id}/scope`, { scope: 'propose' }],
      ['PUT', `/clients/profiles/${profile.id}/low-level-tools`, { show: true }],
      ['POST', '/clients/pats', { name: 'r3 key', profileId: profile.id }],
    ];
    for (const [method, path, body] of needs) {
      const r = await stack.call(method, `/api/admin${path}`, { body });
      expect(r.status, `${method} ${path}: ${r.text}`).toBe(403);
      expect(r.json.error.code, `${method} ${path}`).toBe('REAUTH_REQUIRED');
    }
    expect(stack.policy.store.getProfile(profile.id)?.scope).toBe('read');
    const brakes: [string, string, unknown][] = [
      ['POST', '/writes/pause', {}],
      ['POST', '/writes/resume', {}],
      ['POST', `/clients/connections/${conn.pat.id}/revoke`, {}],
    ];
    for (const [method, path, body] of brakes) {
      const r = await stack.call(method, `/api/admin${path}`, { body });
      expect(r.status, `${method} ${path}: ${r.text}`).toBe(200);
    }
  });
});

describe('approving a proposal of a guarded kind (ADR 0062 decision 5: the rails)', () => {
  /** A pending proposal of `steps`, captured as a bridge tool captures one. */
  async function proposal(stack: AdminStack, tag: string, steps: unknown[]): Promise<string> {
    const r = (await stack.runtime.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      title: `r3 ${tag}`,
      origin: { kind: 'ui', client: 'r3', tool: 'r3_sessions' },
      onError: 'stop',
      internal: true,
      forceProposal: true,
      steps,
      proposal: { summary: `r3 ${tag}` },
    } as never)) as { proposalId?: string };
    expect(r.proposalId, JSON.stringify(r)).toBeTruthy();
    return r.proposalId!;
  }
  const creates = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      op: 'createResource',
      params: { body: { name: `${tag} ${i}` } },
    }));

  it('a delete, or more than 10 pages, needs the step-up; two new pages do not; rejecting never does', async () => {
    s = await startAdminStack();
    const stack = s;
    await stack.runtime.ready;
    const state = (id: string) => stack.runtime.policy.proposals.get(id)!.state;
    const plain = await proposal(stack, 'plain', creates('r3 plain', 2));
    const deletes = await proposal(stack, 'delete', [
      { op: 'deleteResource', params: { path: { resourceId: 'r3gone00001' } } },
    ]);
    const bulk = await proposal(stack, 'bulk', creates('r3 bulk', 11));
    const rejected = await proposal(stack, 'reject', [
      { op: 'deleteResource', params: { path: { resourceId: 'r3gone00002' } } },
    ]);
    setReauth(stack, null);

    for (const id of [deletes, bulk]) {
      const r = await stack.post(`/api/admin/proposals/${id}/approve`, {});
      expect(r.status, r.text).toBe(403);
      expect(r.json.error.code).toBe('REAUTH_REQUIRED');
    }
    // "Approve selected" of several: one guarded among them is enough to ask.
    const together = await stack.post('/api/admin/proposals/bulk', {
      action: 'approve',
      ids: [plain, deletes],
    });
    expect(together.status, together.text).toBe(403);
    expect([state(plain), state(deletes), state(bulk)]).toEqual(['pending', 'pending', 'pending']);

    const r1 = await stack.post(`/api/admin/proposals/${rejected}/reject`, {});
    expect(r1.status, r1.text).toBe(200);
    const r2 = await stack.post(`/api/admin/proposals/${plain}/approve`, {});
    expect(r2.status, r2.text).toBe(200);
    expect(state(plain)).not.toBe('pending');

    setReauth(stack, nowS());
    for (const id of [deletes, bulk]) {
      const r = await stack.post(`/api/admin/proposals/${id}/approve`, {});
      expect(r.status, r.text).toBe(200);
      expect(state(id)).not.toBe('pending');
    }
  });
});

describe('the three pages reached from another site bounce once (ADR 0062 decision 2)', () => {
  const crossSite = { cookie: null, origin: null, headers: { 'sec-fetch-site': 'cross-site' } } as const;
  const target = (html: string) =>
    /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');

  it('the consent page, Google’s return and a link to the dashboard: a page of the bridge that opens them again', async () => {
    s = await startAdminStack();
    const stack = s;
    const query = '?response_type=code&client_id=abc&state=x%20y';
    for (const path of [
      `/oauth/authorize${query}`,
      `/admin/drive/callback?state=s1&code=c1`,
      '/ui/jobs?view=history',
    ]) {
      const r = await stack.call('GET', path, crossSite);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(r.headers.get('cache-control'), path).toMatch(/no-store/);
      expect(r.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(r.text, path).not.toMatch(/<script/i);
      expect(target(r.text), path).toBe(path);
    }
  });

  it('never loops, and never sends anywhere but the bridge', async () => {
    s = await startAdminStack();
    const stack = s;
    // The bounced navigation is same-origin: answered as before (no session: the sign-in page).
    const again = await stack.call('GET', '/ui/jobs', {
      cookie: null,
      origin: null,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toMatch(/^\/oauth\/login\?return_to=/);
    // A browser that still called the second navigation cross-site: the bounce's marker (Lax, 30 seconds) stops a loop.
    const first = await stack.call('GET', '/ui/jobs', crossSite);
    const mark = first.headers.getSetCookie().find((c) => c.startsWith('__Host-lkb_bounced='));
    expect(mark).toBeDefined();
    for (const part of [/; Max-Age=30/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/, /; Path=\//])
      expect(mark).toMatch(part);
    const looped = await stack.call('GET', '/ui/jobs', {
      ...crossSite,
      cookie: mark!.split(';')[0]!,
    });
    expect(looped.status).toBe(303); // answered as without the bounce: the sign-in page, not a second bounce
    // With the session cookie (a browser that sent it after all), no bounce: the page.
    const signedIn = await stack.call('GET', '/ui/jobs', {
      origin: null,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.text).not.toMatch(/http-equiv="refresh"/);
    // Odd paths stay paths of the bridge: under /ui, never a protocol-relative address.
    for (const odd of ['/ui/..%2F..%2Fevil', '/ui//evil.example/x', '/ui/%2F%2Fevil.example']) {
      const r = await stack.call('GET', odd, crossSite);
      const to = target(r.text) ?? '';
      expect(to.startsWith('/ui/') && !to.startsWith('//'), `${odd} → ${to}`).toBe(true);
    }
    // A POST is never bounced (the consent form posts same-origin, with its CSRF token).
    const post = await stack.call('POST', '/oauth/authorize', {
      cookie: null,
      origin: PUBLIC_URL,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(post.text).not.toMatch(/http-equiv="refresh"/);
  });
});
