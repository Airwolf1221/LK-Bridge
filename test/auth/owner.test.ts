import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.js';
import { totp } from '../../src/auth/totp.js';
import {
  Browser,
  PUBLIC_URL,
  authorizeUrl,
  hiddenField,
  pkcePair,
  reachConsent,
  registerPublicClient,
  startBridge,
} from './helpers.js';

/** Requirement 11: owner login, sessions, TOTP, CSRF, rate limiting, consent screen. */

const CB = 'https://claude.ai/api/mcp/auth_callback';

describe('owner login', () => {
  it('sets a secure, HttpOnly, SameSite session cookie with the __Host- prefix', async () => {
    const bridge = await startBridge();
    try {
      const browser = new Browser(bridge);
      const page = await browser.request(`${PUBLIC_URL}/oauth/login`);
      const loginCookie = page.headers.getSetCookie().find((c) => c.startsWith('__Host-lkb_login='));
      expect(loginCookie).toMatch(/HttpOnly/);
      const res = await browser.login();
      expect(res.status).toBe(200);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-lkb_session='));
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; SameSite=Lax/);
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).not.toMatch(/Domain=/i);
      // The session id is stored only as a hash.
      const value = browser.cookies.get('__Host-lkb_session') as string;
      const rows = bridge.db.prepare('SELECT * FROM auth_owner_sessions').all();
      expect(JSON.stringify(rows)).not.toContain(value);
    } finally {
      await bridge.close();
    }
  });

  it('refuses wrong credentials with a generic message and rate-limits by address', async () => {
    const bridge = await startBridge({
      authOverrides: {
        loginLimits: { perIp: { limit: 3, windowMs: 60_000 }, global: { limit: 100, windowMs: 60_000 } },
      },
    });
    try {
      const browser = new Browser(bridge);
      for (const overrides of [{ password: 'wrong' }, { username: 'admin' }, { password: '' }]) {
        const res = await browser.login('', overrides);
        expect(res.status).toBe(401);
        expect(await res.text()).toContain('Those details were not recognised.');
      }
      // Fourth attempt is refused even with the right password.
      const limited = await browser.login();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      bridge.clock.advance(61);
      expect((await browser.login()).status).toBe(200);
      const events = bridge.logs.join('');
      expect(events).toContain('"event":"login.failed"');
      expect(events).toContain('"event":"login.rate_limited"');
      expect(events).not.toContain(bridge.password);
    } finally {
      await bridge.close();
    }
  });

  it('applies a global limit across addresses', async () => {
    const bridge = await startBridge({
      authOverrides: {
        loginLimits: { perIp: { limit: 100, windowMs: 60_000 }, global: { limit: 2, windowMs: 60_000 } },
      },
    });
    try {
      const browser = new Browser(bridge);
      await browser.login('', { password: 'x' });
      await browser.login('', { password: 'y' });
      expect((await browser.login()).status).toBe(429);
    } finally {
      await bridge.close();
    }
  });

  it('requires a TOTP code when configured, and refuses its replay', async () => {
    const bridge = await startBridge({ totp: true });
    try {
      const secret = bridge.totpSecret as string;
      const html = await (await new Browser(bridge).request(`${PUBLIC_URL}/oauth/login`)).text();
      expect(html).toContain('name="totp"');
      const browser = new Browser(bridge);
      expect((await browser.login('', {})).status).toBe(401); // no code
      expect(
        (
          await browser.login('', {
            totp: '000000' === totp(secret, bridge.clock.now()) ? '111111' : '000000',
          })
        ).status,
      ).toBe(401);
      const code = totp(secret, bridge.clock.now());
      expect((await browser.login('', { totp: code })).status).toBe(200);
      expect((await new Browser(bridge).login('', { totp: code })).status).toBe(401); // replay
      expect(bridge.logs.join('')).not.toContain(`"${code}"`);
    } finally {
      await bridge.close();
    }
  });

  it('protects the login form with CSRF and Origin checks', async () => {
    const bridge = await startBridge();
    try {
      const browser = new Browser(bridge);
      const html = await (await browser.request(`${PUBLIC_URL}/oauth/login`)).text();
      const csrf = hiddenField(html, 'csrf_token');
      const noToken = await browser.post(`${PUBLIC_URL}/oauth/login`, {
        username: 'owner',
        password: bridge.password,
      });
      expect(noToken.status).toBe(403);
      const foreign = await browser.post(
        `${PUBLIC_URL}/oauth/login`,
        { csrf_token: csrf, username: 'owner', password: bridge.password },
        { origin: 'https://evil.example' },
      );
      expect(foreign.status).toBe(403);
      const otherBrowser = new Browser(bridge);
      const stolen = await otherBrowser.post(`${PUBLIC_URL}/oauth/login`, {
        csrf_token: csrf,
        username: 'owner',
        password: bridge.password,
      });
      expect(stolen.status).toBe(403); // the token is bound to the first browser's cookie
    } finally {
      await bridge.close();
    }
  });

  it('does not redirect to arbitrary return_to targets after login', async () => {
    const bridge = await startBridge();
    try {
      const res = await new Browser(bridge).login('https://evil.example/');
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it('expires sessions, and logs out with a CSRF-protected POST', async () => {
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
      expect((await browser.request(url)).status).toBe(200);
      const session = browser.cookies.get('__Host-lkb_session') as string;
      const bad = await browser.post(`${PUBLIC_URL}/oauth/logout`, { csrf_token: 'nope' });
      expect(bad.status).toBe(403);
      const ok = await browser.post(`${PUBLIC_URL}/oauth/logout`, {
        csrf_token: bridge.services.owner.csrfToken(session, 'logout'),
      });
      expect(ok.status).toBe(200);
      browser.cookies.set('__Host-lkb_session', session); // replaying the cookie does not help
      expect((await browser.request(url)).status).toBe(302);

      const again = new Browser(bridge);
      await again.login();
      bridge.clock.advance(12 * 3600 + 1);
      expect((await again.request(url)).status).toBe(302);
    } finally {
      await bridge.close();
    }
  });
});

describe('TRUST_PROXY: the login limit keys on the real client address', () => {
  const limits = { perIp: { limit: 2, windowMs: 60_000 }, global: { limit: 100, windowMs: 60_000 } };
  const from = (bridge: Awaited<ReturnType<typeof startBridge>>, xff: string) => {
    const b = new Browser(bridge);
    b.headers['x-forwarded-for'] = xff;
    return b;
  };

  it('uses X-Forwarded-For from the trusted local proxy (the default)', async () => {
    const bridge = await startBridge({ authOverrides: { loginLimits: limits } });
    try {
      const attacker = from(bridge, '203.0.113.5');
      await attacker.login('', { password: 'wrong' });
      await attacker.login('', { password: 'wrong' });
      expect((await attacker.login()).status).toBe(429);
      // Another real client behind the same proxy is not affected.
      expect((await from(bridge, '203.0.113.6').login()).status).toBe(200);
      // A forged left-most entry does not help: the proxy-appended address is used.
      expect((await from(bridge, '198.51.100.1, 203.0.113.5').login()).status).toBe(429);
      const failures = bridge.logs
        .map((l) => JSON.parse(l) as { event?: string; ip?: string })
        .filter((l) => l.event === 'login.failed');
      expect(failures.map((l) => l.ip)).toEqual(['203.0.113.5', '203.0.113.5']);
    } finally {
      await bridge.close();
    }
  });

  it.each([
    ['none', 'TRUST_PROXY=none'],
    ['10.9.8.7', 'a proxy address that is not the peer'],
  ])('ignores X-Forwarded-For with TRUST_PROXY=%s (%s)', async (trust) => {
    const bridge = await startBridge({ env: { TRUST_PROXY: trust }, authOverrides: { loginLimits: limits } });
    try {
      await from(bridge, '203.0.113.5').login('', { password: 'wrong' });
      await from(bridge, '203.0.113.6').login('', { password: 'wrong' });
      // Both failures were counted against the socket address, so a third "client" is limited.
      expect((await from(bridge, '203.0.113.7').login()).status).toBe(429);
      const ips = bridge.logs
        .map((l) => JSON.parse(l) as { event?: string; ip?: string })
        .filter((l) => l.event === 'login.failed')
        .map((l) => l.ip);
      expect(ips).toEqual(['127.0.0.1', '127.0.0.1']);
    } finally {
      await bridge.close();
    }
  });
});

describe('consent screen and its POST', () => {
  it('names the client and the scopes, and shows the redirect hostname', async () => {
    const bridge = await startBridge();
    try {
      const clientId = await registerPublicClient(bridge);
      const page = await reachConsent(
        new Browser(bridge),
        authorizeUrl({
          clientId,
          redirectUri: CB,
          challenge: pkcePair().challenge,
          method: 'S256',
          scope: 'mcp offline_access',
        }),
      );
      if (page instanceof Response) throw new Error('expected consent');
      expect(page.html).toContain('<p class="host">Claude</p>');
      expect(page.html).toContain(clientId);
      expect(page.html).toContain('<strong>mcp</strong>');
      expect(page.html).toContain('<strong>offline_access</strong>');
      expect(page.html).toContain('<p class="host">claude.ai</p>');
      expect(page.html).toContain(CB);
      expect(page.html).toContain('Signed in as owner');
    } finally {
      await bridge.close();
    }
  });

  it('refuses a consent POST with a bad CSRF token, a foreign Origin, another session, or a reused request', async () => {
    const bridge = await startBridge();
    try {
      const clientId = await registerPublicClient(bridge);
      const browser = new Browser(bridge);
      const url = authorizeUrl({
        clientId,
        redirectUri: CB,
        challenge: pkcePair().challenge,
        method: 'S256',
      });
      const page = await reachConsent(browser, url);
      if (page instanceof Response) throw new Error('expected consent');
      const post = (b: Browser, form: Record<string, string>, headers: Record<string, string> = {}) =>
        b.post(`${PUBLIC_URL}/oauth/consent`, form, headers);

      expect(
        (await post(browser, { request_id: page.requestId, csrf_token: 'x', decision: 'approve' })).status,
      ).toBe(403);
      expect((await post(browser, { request_id: page.requestId, decision: 'approve' })).status).toBe(403);
      expect(
        (
          await post(
            browser,
            { request_id: page.requestId, csrf_token: page.csrf, decision: 'approve' },
            { origin: 'https://evil.example' },
          )
        ).status,
      ).toBe(403);

      const intruder = new Browser(bridge);
      await intruder.login();
      expect(
        (await post(intruder, { request_id: page.requestId, csrf_token: page.csrf, decision: 'approve' }))
          .status,
      ).toBe(400);
      expect(
        (
          await post(new Browser(bridge), {
            request_id: page.requestId,
            csrf_token: page.csrf,
            decision: 'approve',
          })
        ).status,
      ).toBe(401);

      expect(
        (await post(browser, { request_id: page.requestId, csrf_token: page.csrf, decision: 'maybe' }))
          .status,
      ).toBe(400);
      const ok = await post(browser, {
        request_id: page.requestId,
        csrf_token: page.csrf,
        decision: 'approve',
      });
      expect(ok.status).toBe(303);
      expect(
        (await post(browser, { request_id: page.requestId, csrf_token: page.csrf, decision: 'approve' }))
          .status,
      ).toBe(400);
    } finally {
      await bridge.close();
    }
  });

  it('expires a pending consent after ten minutes', async () => {
    const bridge = await startBridge();
    try {
      const clientId = await registerPublicClient(bridge);
      const browser = new Browser(bridge);
      const page = await reachConsent(
        browser,
        authorizeUrl({ clientId, redirectUri: CB, challenge: pkcePair().challenge, method: 'S256' }),
      );
      if (page instanceof Response) throw new Error('expected consent');
      bridge.clock.advance(601);
      const res = await browser.post(`${PUBLIC_URL}/oauth/consent`, {
        request_id: page.requestId,
        csrf_token: page.csrf,
        decision: 'approve',
      });
      expect(res.status).toBe(400);
    } finally {
      await bridge.close();
    }
  });

  it('honours prompt=none without showing a page', async () => {
    const bridge = await startBridge();
    try {
      const clientId = await registerPublicClient(bridge);
      const url = authorizeUrl({
        clientId,
        redirectUri: CB,
        challenge: pkcePair().challenge,
        method: 'S256',
        extra: { prompt: 'none' },
      });
      const anon = await new Browser(bridge).request(url);
      expect(new URL(anon.headers.get('location') as string).searchParams.get('error')).toBe(
        'login_required',
      );
      const browser = new Browser(bridge);
      await browser.login();
      const signedIn = await browser.request(url);
      expect(new URL(signedIn.headers.get('location') as string).searchParams.get('error')).toBe(
        'consent_required',
      );
    } finally {
      await bridge.close();
    }
  });
});

describe('npm run setup:owner', () => {
  it('prints an Argon2id hash for the password it reads, never the password itself', async () => {
    const password = 'a correct horse battery staple';
    const out = spawnSync('npx', ['tsx', 'src/auth/cli/setup-owner.ts', '--stdin', '--totp'], {
      input: `${password}\n`,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).not.toContain(password);
    const hash = /OWNER_PASSWORD_HASH='([^']+)'/.exec(out.stdout)?.[1];
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(await verifyPassword(hash as string, password)).toBe(true);
    expect(out.stdout).toMatch(/OWNER_TOTP_SECRET='[A-Z2-7]{32}'/);
    expect(out.stdout).toContain('otpauth://totp/');
  }, 60_000);

  it('refuses short passwords', () => {
    const out = spawnSync('npx', ['tsx', 'src/auth/cli/setup-owner.ts', '--stdin', '--no-totp'], {
      input: 'short\n',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/at least 12/);
  }, 60_000);
});
