/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), the bounce pages (ADR 0062 decision 2; `src/admin/bounce.ts`): the consent page
 * (`/oauth/authorize`, and its alias `/authorize`), Google Drive's return (`/admin/drive/callback`) and a link to the
 * dashboard (`/ui…`) answer a cross-site navigation that arrives without the SameSite=Strict cookie with a page that
 * opens the same address again, and set the `__Host-lkb_bounced` marker (Lax, 30 seconds).
 *
 * The attempts: an open redirect (crafted paths, `//host`, backslashes, encoded and raw characters, absolute URLs,
 * query strings), HTML or attribute injection into the page, the marker standing in for a session, a planted session
 * cookie (fixation), a cross-site POST or a Drive answer replayed through the bounce, an attacker's Drive answer
 * cancelling the owner's own sign-in, and the page being framed.
 *
 * Where the bounce page is parsed, the browser's own steps are followed: the `content` attribute HTML-unescaped, the
 * "0;url=" prefix taken off, and the rest resolved with the WHATWG URL parser (which, like a browser, drops tabs and
 * newlines and reads `\` as `/`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_URL, startAdminStack, type AdminStack } from '../../admin/helpers.js';
import { Browser } from '../../auth/helpers.js';
import { CLIENT_ID, CLIENT_SECRET, MockGoogle } from '../../offsite/mock-google.js';
import { ownerSession, rawGet } from './helpers.js';

let s: AdminStack | undefined;
let google: MockGoogle | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  await google?.stop();
  google = undefined;
});

const unescapeHtml = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Where a browser goes from the bounce page: the refresh's URL and the link's, resolved against the bridge. */
function destinations(html: string): { refresh: URL | null; link: URL | null } {
  const content = /<meta http-equiv="refresh" content="([^"]*)">/.exec(html)?.[1];
  const href = /<a href="([^"]*)">/.exec(html)?.[1];
  const refreshUrl = content ? unescapeHtml(content).replace(/^\s*0\s*;\s*url\s*=\s*/i, '') : null;
  return {
    refresh: refreshUrl !== null ? new URL(refreshUrl, `${PUBLIC_URL}/ui/x`) : null,
    link: href !== undefined ? new URL(unescapeHtml(href), `${PUBLIC_URL}/ui/x`) : null,
  };
}

const CROSS = { cookie: null, origin: null, headers: { 'sec-fetch-site': 'cross-site' } } as const;

describe('the bounce pages', () => {
  it('SE-34: no crafted address makes the bounce leave the bridge (paths, //host, backslashes, encodings, query strings)', async () => {
    s = await startAdminStack();
    const stack = s;
    const tried = [
      '/ui//evil.example/x',
      '/ui/%2F%2Fevil.example',
      '/ui/%5C%5Cevil.example',
      '/ui/..%2F..%2F%2Fevil.example',
      '/ui/%09/evil.example',
      '/ui?next=//evil.example',
      '/ui?x=https://evil.example/',
      '/oauth/authorize?redirect_uri=https://evil.example/&client_id=//evil.example',
      '/authorize?client_id=x&x=%0d%0aLocation:%20https://evil.example',
      '/admin/drive/callback?state=//evil.example&code=\\\\evil.example',
      '/admin/drive/callback?;url=https://evil.example',
    ];
    const left: string[] = [];
    for (const path of tried) {
      const r = await stack.call('GET', path, CROSS);
      expect(r.status, path).toBe(200);
      const d = destinations(r.text);
      for (const u of [d.refresh, d.link])
        if (!u || u.origin !== PUBLIC_URL) left.push(`${path} → ${u?.href ?? 'none'}`);
    }
    // Raw characters a browser would never send, but a client could: the page still sends nowhere else.
    const raw = [
      '/ui/\t/evil.example',
      '/ui/\\evil.example',
      '/oauth/authorize?a=\t/\\evil.example',
      '/admin/drive/callback?x="><meta http-equiv="refresh" content="0;url=https://evil.example">',
    ];
    let rawSeen = 0;
    for (const url of raw) {
      const r = await rawGet(stack.base, url, { 'Sec-Fetch-Site': 'cross-site' });
      if (r.status !== 200) continue; // refused outright by the HTTP parser: nothing to follow
      rawSeen++;
      const d = destinations(r.body);
      for (const u of [d.refresh, d.link])
        if (!u || u.origin !== PUBLIC_URL) left.push(`${JSON.stringify(url)} → ${u?.href ?? 'none'}`);
    }
    expect(left).toEqual([]);
    expect(rawSeen, 'at least one raw target reached the bounce').toBeGreaterThan(0);
  });

  it('SE-35: nothing from the address is markup in the page (quotes, angle brackets, a second refresh)', async () => {
    s = await startAdminStack();
    const stack = s;
    const urls = [
      `/oauth/authorize?x="><script>alert(1)</script>&y='onmouseover='alert(2)`,
      `/admin/drive/callback?state="><img src=x onerror=alert(1)>&code=1`,
      `/ui/"><svg onload=alert(1)>`,
      `/oauth/authorize?a=&quot;&#34;&apos;`,
    ];
    const skeleton =
      '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta http-equiv="refresh" content="X">' +
      '<meta name="robots" content="noindex"><title>LK-Bridge</title></head>' +
      '<body><p><a href="X">Continue to LK-Bridge</a></p></body></html>';
    let seen = 0;
    for (const url of urls) {
      const r = await rawGet(stack.base, url, { 'Sec-Fetch-Site': 'cross-site' });
      if (r.status !== 200) continue;
      seen++;
      // The two attribute values are the only places the address goes; with them blanked, the page is the skeleton.
      const blanked = r.body
        .replace(/<meta http-equiv="refresh" content="[^"]*">/, '<meta http-equiv="refresh" content="X">')
        .replace(/<a href="[^"]*">/, '<a href="X">');
      expect(blanked, url).toBe(skeleton);
      expect(r.body, url).not.toMatch(/<script|<img|<svg/i);
      // What a browser reads back from the attribute is the address it was sent, nothing more.
      const d = destinations(r.body);
      expect(d.refresh?.origin, url).toBe(PUBLIC_URL);
    }
    expect(seen, 'at least one raw target reached the bounce').toBeGreaterThan(0);
  });

  it('SE-36: the marker is not a session: with it alone, every bounced page is answered as signed out', async () => {
    s = await startAdminStack();
    const stack = s;
    const first = await stack.call('GET', '/ui/jobs', CROSS);
    const mark = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-lkb_bounced='))!
      .split(';')[0]!;
    const withMark = (headers: Record<string, string>) => ({ cookie: mark, origin: null, headers });
    for (const site of ['cross-site', 'same-origin', 'none']) {
      const h = { 'sec-fetch-site': site };
      const ui = await stack.call('GET', '/ui/jobs', withMark(h));
      const auth = await stack.call('GET', '/oauth/authorize?client_id=x&response_type=code', withMark(h));
      const drive = await stack.call('GET', '/admin/drive/callback?state=s&code=c', withMark(h));
      const api = await stack.call('GET', '/api/admin/session', withMark(h));
      expect(
        {
          ui: ui.status,
          uiTo: (ui.headers.get('location') ?? '').startsWith('/oauth/login'),
          auth: auth.status === 302 || auth.status === 400,
          authBounced: /http-equiv="refresh"/.test(auth.text),
          drive: drive.headers.get('location'),
          api: api.status,
        },
        site,
      ).toEqual({
        ui: 303,
        uiTo: true,
        auth: true,
        authBounced: false,
        drive: '/ui/offsite?drive_error=OFFSITE_NO_SESSION',
        api: site === 'cross-site' ? 401 : 401,
      });
    }
  });

  it('SE-37: a planted session cookie is never adopted (fixation): sign-in issues a fresh token, the planted one stays dead', async () => {
    s = await startAdminStack();
    const stack = s;
    const name = stack.services.owner.sessionCookie;
    const planted = 'A'.repeat(43);
    const browser = new Browser(stack.bridge);
    browser.cookies.set(name, planted);
    browser.cookies.set('__Host-lkb_bounced', '1');
    expect((await browser.login()).status).toBe(200);
    const issued = browser.cookies.get(name)!;
    expect(issued).not.toBe(planted);
    expect(stack.services.owner.isLive(planted)).toBe(false);
    expect(stack.services.owner.isLive(issued)).toBe(true);
    // Nor is a cookie without the __Host- prefix read in its place (a sibling host or plain HTTP could set that one).
    const r = await stack.call('GET', '/api/admin/session', { cookie: `lkb_session=${issued}` });
    expect(r.status).toBe(401);
  });

  it('SE-38: a cross-site POST is never bounced into a same-origin one, and changes nothing', async () => {
    s = await startAdminStack();
    const stack = s;
    const before = stack.runtime.engine.queries.controls().writesPaused;
    for (const path of [
      '/oauth/authorize',
      '/oauth/consent',
      '/oauth/logout',
      '/admin/drive/callback',
      '/ui/jobs',
      '/api/admin/writes/pause',
    ]) {
      const r = await stack.call('POST', path, {
        cookie: null,
        origin: 'https://evil.example',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(/http-equiv="refresh"/.test(r.text), path).toBe(false);
      expect(
        r.headers.getSetCookie().some((c) => c.startsWith('__Host-lkb_bounced=')),
        path,
      ).toBe(false);
    }
    expect(stack.runtime.engine.queries.controls().writesPaused).toBe(before);
  });

  it("SE-39: Google's answer: a replay through the bounce connects once; an attacker's answer is refused and leaves the owner's own sign-in working", async () => {
    google = new MockGoogle();
    await google.start();
    s = await startAdminStack({ googleOAuth: { endpoints: google.endpoints } });
    const stack = s;
    const me = ownerSession(stack, PUBLIC_URL, stack.sessionToken);
    expect(
      (
        await me.call('PUT', '/api/admin/offsite/client', {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        })
      ).status,
    ).toBe(200);
    // The owner starts a sign-in; meanwhile an attacker sends the owner's browser to the callback with the attacker's
    // own Google answer (cross-site: bounced, then same-origin with the owner's cookie).
    const start = await me.call('POST', '/api/admin/offsite/connect', {});
    const mine = google.approve(start.json.url as string);
    const attackerStart = await me.call('POST', '/api/admin/offsite/connect', {}); // a second, separate sign-in
    const theirs = google.approve(attackerStart.json.url as string);
    const forged = `/admin/drive/callback?state=forged-${theirs.state.slice(0, 8)}&code=${encodeURIComponent(theirs.code)}`;
    const bounced = await stack.call('GET', forged, CROSS);
    expect(/http-equiv="refresh"/.test(bounced.text)).toBe(true);
    const followed = await stack.call('GET', forged, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(followed.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_MISMATCH');
    // The owner's own answer still works, once; the same answer again (history, a second refresh) is refused.
    const cb = `/admin/drive/callback?state=${encodeURIComponent(mine.state)}&code=${encodeURIComponent(mine.code)}`;
    const first = await stack.call('GET', cb, CROSS); // bounced: nothing used up yet
    expect(/http-equiv="refresh"/.test(first.text)).toBe(true);
    const once = await stack.call('GET', cb, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(once.headers.get('location')).toBe('/ui/offsite?drive=connected');
    const twice = await stack.call('GET', cb, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(twice.headers.get('location')).toBe('/ui/offsite?drive_error=OFFSITE_STATE_MISMATCH');
    expect(google.requests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(1);
  });

  it('SE-40: every bounce page is as protected from framing as the pages it opens (X-Frame-Options or frame-ancestors)', async () => {
    s = await startAdminStack();
    const stack = s;
    const unframed: string[] = [];
    for (const path of ['/ui/jobs', '/oauth/authorize?client_id=x', '/admin/drive/callback?state=s&code=c']) {
      const r = await stack.call('GET', path, CROSS);
      expect(/http-equiv="refresh"/.test(r.text), path).toBe(true);
      const xfo = (r.headers.get('x-frame-options') ?? '').toUpperCase() === 'DENY';
      const fa = /frame-ancestors 'none'/.test(r.headers.get('content-security-policy') ?? '');
      if (!xfo && !fa) unframed.push(path);
    }
    expect(unframed).toEqual([]);
  });
});
