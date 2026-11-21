/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), "Sign out everywhere" (ADR 0062 decision 4: every owner session ends, this one
 * included). The attempts: the old cookie used again on every surface the session opens (the admin API, the dashboard's
 * pages, the live stream, the consent page and its form, the sign-in page's redirect, Google Drive's return); an open
 * live stream; a consent page rendered before; a sign-in whose password check was under way; a Google Drive sign-in
 * started before; a session that had expired when the revoke ran, after the clock is set back; a renewal at the same
 * moment as the revoke.
 *
 * The safe behaviour asserted: no session that existed when Sign out everywhere ran opens anything afterwards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_URL, openStream, startAdminStack, type AdminStack } from '../../admin/helpers.js';
import {
  Browser,
  authorizeUrl,
  pkcePair,
  reachConsent,
  registerPublicClient,
  startBridge,
  type ConsentPage,
} from '../../auth/helpers.js';
import { CLIENT_ID, CLIENT_SECRET, MockGoogle } from '../../offsite/mock-google.js';
import { DAY, ownerSession } from './helpers.js';

let s: AdminStack | undefined;
let google: MockGoogle | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  await google?.stop();
  google = undefined;
});

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

describe('Sign out everywhere ends every session that existed', () => {
  it('SE-27: the old cookie opens nothing afterwards (API, pages, stream, consent page, sign-in redirect, Drive return)', async () => {
    s = await startAdminStack();
    const stack = s;
    const browser = new Browser(stack.bridge);
    expect((await browser.login()).status).toBe(200);
    const token = browser.cookies.get(stack.services.owner.sessionCookie)!;
    const old = ownerSession(stack, PUBLIC_URL, token);
    const clientId = await registerPublicClient(stack.bridge, [CLAUDE]);
    const consentUrl = authorizeUrl(
      { clientId, redirectUri: CLAUDE, challenge: pkcePair().challenge, method: 'S256' },
      browser.base,
    );
    expect((await browser.request(consentUrl)).status).toBe(200); // the consent page, signed in

    const revoke = await ownerSession(stack, PUBLIC_URL, stack.sessionToken).call(
      'POST',
      '/api/admin/security/sessions/revoke-all',
      { confirm: true },
    );
    expect(revoke.status, revoke.text).toBe(200);
    const cookie = { cookie: `${stack.services.owner.sessionCookie}=${token}` };
    const seen = {
      api: (await old.call('GET', '/api/admin/session')).status,
      change: (await old.call('POST', '/api/admin/writes/pause', {})).status,
      page: (await stack.call('GET', '/ui/jobs', cookie)).status,
      stream: (await openStream(stack, cookie)).status,
      consent: (await stack.call('GET', new URL(consentUrl).pathname + new URL(consentUrl).search, cookie))
        .status,
      signInRedirect: (await stack.call('GET', '/oauth/login?return_to=%2Fui', cookie)).status,
      drive: (await stack.call('GET', '/admin/drive/callback?state=x&code=y', cookie)).headers.get(
        'location',
      ),
    };
    expect(seen).toEqual({
      api: 401,
      change: 401,
      page: 303, // to the sign-in page
      stream: 401,
      consent: 302, // to the sign-in page
      signInRedirect: 200, // the sign-in form, not a redirect into the dashboard
      drive: '/ui/offsite?drive_error=OFFSITE_NO_SESSION',
    });
  });

  it('SE-28: an open live stream is told `unauthenticated` and ends', async () => {
    s = await startAdminStack();
    const stack = s;
    const other = ownerSession(stack, PUBLIC_URL);
    const stream = await openStream(stack, { cookie: other.cookie });
    expect(stream.status).toBe(200);
    await stream.waitFor((f) => f.event === 'hello');
    expect(
      (
        await ownerSession(stack, PUBLIC_URL, stack.sessionToken).call(
          'POST',
          '/api/admin/security/sessions/revoke-all',
          { confirm: true },
        )
      ).status,
    ).toBe(200);
    const f = await stream.waitFor((x) => x.event === 'unauthenticated', 3000);
    expect(f.data).toMatchObject({ data: { reason: 'session_ended' } });
    await stream.ended;
  });

  it('SE-29: a consent page shown before cannot be approved after (its form and CSRF token are still in the page)', async () => {
    s = await startAdminStack();
    const stack = s;
    const browser = new Browser(stack.bridge);
    expect((await browser.login()).status).toBe(200);
    const clientId = await registerPublicClient(stack.bridge, [CLAUDE]);
    const page = (await reachConsent(
      browser,
      authorizeUrl(
        { clientId, redirectUri: CLAUDE, challenge: pkcePair().challenge, method: 'S256' },
        browser.base,
      ),
    )) as ConsentPage;
    stack.services.owner.revokeAllSessions('127.0.0.1');
    const res = await browser.post(`${browser.base}/oauth/consent`, {
      request_id: page.requestId,
      csrf_token: page.csrf,
      decision: 'approve',
      profile: 'new',
      new_label: 'r4 se29',
      new_kind: 'claude',
      scope: 'read',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(stack.policy.store.getProfileByLabel('r4 se29')).toBeUndefined();
  });

  it('SE-30: a sign-in under way when Sign out everywhere runs is a new sign-in; no earlier session survives', async () => {
    const bridge = await startBridge();
    try {
      const owner = bridge.services.owner;
      const earlier = [owner.createSession('127.0.0.1', 'a'), owner.createSession('127.0.0.1', 'b')];
      const signingIn = owner.login({
        username: 'owner',
        password: bridge.password,
        totp: undefined,
        ip: '198.51.100.9',
        userAgent: 'r4',
      });
      const ended = owner.revokeAllSessions('198.51.100.10'); // while Argon2id checks the password
      const r = await signingIn;
      expect(ended).toBe(2);
      expect(earlier.map((t) => owner.getSession(t) !== undefined)).toEqual([false, false]);
      // The sign-in that was under way needed the password (and code) like any other: it starts a NEW session.
      expect(r.ok && earlier.includes(r.sessionToken)).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('SE-31: a renewal at the moment of the revoke (the once-a-minute slide) does not bring the session back', async () => {
    const bridge = await startBridge();
    try {
      const owner = bridge.services.owner;
      const token = owner.createSession('127.0.0.1', 'r4');
      bridge.clock.advance(120); // due a renewal
      const used = owner.useSession(token); // the guard's read and slide…
      owner.revokeAllSessions('127.0.0.1'); // …and the revoke right after it
      bridge.clock.advance(120);
      expect(used?.renewed).toBe(true);
      expect(owner.getSession(token)).toBeUndefined();
      expect(owner.isLive(token)).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('SE-32: a Google Drive sign-in started before cannot be completed after, even by a new sign-in', async () => {
    google = new MockGoogle();
    await google.start();
    s = await startAdminStack({ googleOAuth: { endpoints: google.endpoints } });
    const stack = s;
    const me = ownerSession(stack, PUBLIC_URL, stack.sessionToken); // stepped up
    expect(
      (
        await me.call('PUT', '/api/admin/offsite/client', {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        })
      ).status,
    ).toBe(200);
    const start = await me.call('POST', '/api/admin/offsite/connect', {});
    expect(start.status, start.text).toBe(200);
    const { code, state } = google.approve(start.json.url as string);
    expect((await me.call('POST', '/api/admin/security/sessions/revoke-all', { confirm: true })).status).toBe(
      200,
    );
    const browser = new Browser(stack.bridge);
    expect((await browser.login()).status).toBe(200);
    const cb = await browser.request(
      `${browser.base}/admin/drive/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
    expect(cb.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_MISMATCH');
    expect(google.requests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(0);
  });

  it('SE-33: a session past its end when the revoke ran stays ended if the clock is then set back', async () => {
    const bridge = await startBridge();
    try {
      const owner = bridge.services.owner;
      const token = owner.createSession('127.0.0.1', 'r4');
      bridge.clock.advance(30 * DAY + 60); // 30 days unused: it has ended
      expect(owner.getSession(token)).toBeUndefined();
      expect(owner.revokeAllSessions('127.0.0.1')).toBe(0); // "Sign out everywhere": 0 sessions
      bridge.clock.advance(-2 * DAY); // the server's clock corrected backwards (NTP step, a restored VM)
      expect(owner.getSession(token), 'the old cookie works again').toBeUndefined();
    } finally {
      await bridge.close();
    }
  });
});
