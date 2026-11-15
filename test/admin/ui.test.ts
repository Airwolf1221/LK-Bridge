import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../auth/helpers.js';
import { startAdminStack, type AdminStack } from './helpers.js';

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack();
});
afterAll(() => stack.close());

const anon = (path: string, init: RequestInit = {}) =>
  fetch(stack.base + path, { redirect: 'manual', ...init });
const signedIn = (path: string, init: RequestInit = {}) =>
  fetch(stack.base + path, {
    redirect: 'manual',
    ...init,
    headers: { cookie: stack.cookie, ...init.headers },
  });

describe('/ui without a session', () => {
  it('sends the browser to the owner sign-in page and remembers where it was going', async () => {
    for (const path of ['/ui', '/ui/', '/ui/jobs', '/ui/errors?fp=abc%7Cdef', '/ui/assets/app.js']) {
      const res = await anon(path);
      expect(res.status, path).toBe(303);
      const loc = new URL(res.headers.get('location')!, 'https://x.invalid');
      expect(loc.pathname).toBe('/oauth/login');
      expect(loc.searchParams.get('return_to')).toBe(path === '/ui/' ? '/ui/' : path);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('serves no dashboard bytes to a stranger, and API callers get JSON 401 instead of a redirect', async () => {
    const res = await anon('/ui/jobs');
    expect(await res.text()).not.toContain('<div id="root">');
    const api = await anon('/api/admin/overview');
    expect(api.status).toBe(401);
    expect(api.headers.get('content-type')).toMatch(/json/);
  });

  it('comes back to the page after sign-in', async () => {
    const browser = new Browser(stack.bridge);
    const first = await browser.request(`${browser.base}/ui/proposals?x=1`);
    expect(first.status).toBe(303);
    const loginUrl = new URL(first.headers.get('location')!, browser.base);
    const returnTo = loginUrl.searchParams.get('return_to')!;
    expect(returnTo).toBe('/ui/proposals?x=1');
    const done = await browser.login(returnTo);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/ui/proposals?x=1');
    const page = await browser.request(`${browser.base}${returnTo}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    // The same session works against the admin API.
    const session = await browser.request(`${browser.base}/api/admin/session`);
    expect(session.status).toBe(200);
  });

  it('does not take a return_to outside the dashboard and the authorize endpoint', async () => {
    const browser = new Browser(stack.bridge);
    const done = await browser.login('https://evil.example/ui');
    // No redirect anywhere: the sign-in page just says you are signed in.
    expect(done.status).toBe(200);
    expect(done.headers.get('location')).toBeNull();
  });
});

describe('/ui with a session', () => {
  it('serves the app shell with strict security headers', async () => {
    const res = await signedIn('/ui');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    // v2 D3 (ADR 0041): the only outside sources are LegendKeeper's asset hosts (v2 E5.2: assets and assets2), for
    // images only (Staging thumbnails).
    expect(csp).toContain(
      "img-src 'self' data: https://assets.legendkeeper.com https://assets2.legendkeeper.com;",
    );
    expect(
      csp.replace(' https://assets.legendkeeper.com https://assets2.legendkeeper.com;', ';'),
    ).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('puts the same headers on assets and on redirects', async () => {
    for (const res of [await signedIn('/ui/assets/app.js'), await anon('/ui/jobs')]) {
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('serves hashed assets with their type and long caching, and answers HEAD', async () => {
    const res = await signedIn('/ui/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect((await signedIn('/ui/assets/app.js', { method: 'HEAD' })).status).toBe(200);
  });

  it('falls back to the app for client-side routes, and 404s a missing file', async () => {
    for (const path of ['/ui/jobs', '/ui/jobs/job_123', '/ui/settings/']) {
      const res = await signedIn(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
    expect((await signedIn('/ui/assets/missing.js')).status).toBe(404);
    expect((await signedIn('/ui/favicon.ico')).status).toBe(404);
  });

  it('cannot be walked out of its directory', async () => {
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(stack.base);
        // `request` with a raw path: the client does not normalise dots.
        const req = request(
          { host: u.hostname, port: u.port, path, headers: { cookie: stack.cookie } },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    for (const p of [
      '/ui/../package.json',
      '/ui/%2e%2e/package.json',
      '/ui/..%2f..%2fpackage.json',
      '/ui/assets/..%5c..%5cpackage.json',
      '/ui/%00',
    ]) {
      const r = await raw(p);
      expect(r.body, p).not.toContain('"lk-bridge"');
      expect(r.body, p).not.toContain('"scripts"');
    }
  });
});

describe('a bridge whose dashboard has not been built', () => {
  it('says so instead of failing obscurely', async () => {
    const bare = await startAdminStack({ withUi: false });
    try {
      const res = await fetch(`${bare.base}/ui`, { headers: { cookie: bare.cookie } });
      expect(res.status).toBe(503);
      expect(await res.text()).toMatch(/not been built/);
      // The API is unaffected.
      expect((await bare.get('/api/admin/overview')).status).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe('sign-in pages and real browsers', () => {
  it('use Referrer-Policy same-origin, because a browser sends "Origin: null" for form POSTs under no-referrer', async () => {
    // Found in Chromium: under `no-referrer` the sign-in, consent and sign-out forms were refused by their own Origin
    // check. `same-origin` still sends nothing to other sites. The dashboard itself keeps `no-referrer` (it uses fetch).
    const res = await anon('/oauth/login');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(await res.text()).toContain('<meta name="referrer" content="same-origin">');
  });
});
