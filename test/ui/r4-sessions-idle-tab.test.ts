/**
 * CR-2026-11 round 4 (sessions), sliding expiry (ADR 0062 decision 1): "The live stream's periodic check does not
 * count as a use, so an idle open tab does not keep a session alive by itself." The attempt: leave a dashboard tab open
 * on a page and touch nothing. The REAL dashboard (`<App>`, in jsdom) runs against the REAL bridge (the admin stack):
 * its requests are forwarded to the bridge with the owner's session cookie, as the browser sends them. The session is
 * first aged to one hour before its end (29 days 23 hours without a use); then only the page's own refresh timer runs
 * (SE-42), or only an agent's job event arrives on the stream (SE-43).
 *
 * The safe behaviour asserted: with no input from the owner, the session's end does not move (it still ends within the
 * hour), and every request the page sends by itself says it is the dashboard's own (`X-LKB-Background: 1`). The control
 * (SE-41) shows that a request the owner makes moves it, as the ADR says. (The lead, CR-2026-11-R4: as first written,
 * SE-42 and SE-43 also asserted that the page sends no request at all; ADR 0062 asks only that such requests do not
 * count as a use, and the live dashboard's refresh without input is pinned elsewhere: `test/ui/live.test.tsx`,
 * `maintenance.test.tsx`, `staging.test.tsx`.)
 *
 * Set-up notes: this file runs in the node environment and installs vitest's own jsdom globals itself, AFTER the bridge
 * has started (under a jsdom docblock Vite rewrites `new URL('./migrations/', import.meta.url)` for a browser and the
 * bridge cannot start). The page modules are imported only once the globals exist. Kept in test/ui (CR-2026-11-R4, the
 * lead) so that the UI tests' TypeScript project, and ESLint's, include it; with no jsdom docblock it runs in node.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { builtinEnvironments } from 'vitest/runtime';
// Types only (erased): the modules themselves are imported once the jsdom globals exist.
import type * as Rtl from '@testing-library/react';
import { PUBLIC_URL, startAdminStack, type AdminStack } from '../admin/helpers.js';
import { DAY, nowS, ownerSession, type Owner } from '../review/r4-sessions/helpers.js';
import type * as UiHelpers from './helpers.js';

let s: AdminStack;
let owner: Owner;
let teardownDom: () => Promise<void> = () => Promise.resolve();
let forwarded: string[] = [];
let ui: typeof UiHelpers;
let rtl: typeof Rtl;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  s = await startAdminStack();
  await s.runtime.ready;
  owner = ownerSession(s, PUBLIC_URL);
  const env = await builtinEnvironments.jsdom.setup(globalThis, {
    jsdom: { url: `${PUBLIC_URL}/ui/maintenance` },
  } as never);
  teardownDom = async () => {
    await env.teardown(globalThis);
  };
  await import('@testing-library/jest-dom/vitest');
  rtl = await import('@testing-library/react');
  ui = await import('./helpers.js');
}, 60_000);
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200)); // the last answers handed to the (unmounted) page first
  await teardownDom();
  await s?.close();
});
afterEach(async () => {
  rtl?.cleanup();
  vi.useRealTimers();
  await drained(); // nothing left to answer into an unmounted page
  vi.unstubAllGlobals();
});

/** The browser: every dashboard request goes to the bridge, with the session cookie a same-origin request carries. */
let inFlight = new Set<Promise<unknown>>();
let answered: string[] = [];
/** The requests forwarded without `X-LKB-Background: 1` (each as its line in `forwarded`, at its index there). */
let unmarked: { readonly index: number; readonly line: string }[] = [];
function forwardToBridge(): void {
  forwarded = [];
  answered = [];
  unmarked = [];
  inFlight = new Set();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.startsWith('http') ? raw.replace(/^https?:\/\/[^/]+/, '') : raw;
    const line = `${(init.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`;
    const own = Object.entries((init.headers ?? {}) as Record<string, string>).some(
      ([k, v]) => k.toLowerCase() === 'x-lkb-background' && v === '1',
    );
    if (!own) unmarked.push({ index: forwarded.length, line });
    forwarded.push(line);
    const headers: Record<string, string> = {
      ...((init.headers ?? {}) as Record<string, string>),
      cookie: owner.cookie,
      'sec-fetch-site': 'same-origin',
    };
    if ((init.method ?? 'GET') !== 'GET') headers.origin = PUBLIC_URL;
    const p = realFetch(`${s.base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    }).then(async (res) => {
      // The body read here, so that "answered" includes it (the page's `res.json()` then settles at once).
      const body = await res.text();
      answered.push(`${line} → ${res.status}`);
      return new Response(body, { status: res.status, headers: res.headers });
    });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  });
}

/** Waits until every forwarded request has been answered by the bridge. */
async function drained(): Promise<void> {
  for (let i = 0; i < 200 && inFlight.size > 0; i++) await Promise.allSettled([...inFlight]);
}

/** The session as if last used 29 days 23 hours ago: it ends in an hour unless it is used. */
function ageSession(): number {
  const ends = nowS() + 3600;
  s.db
    .prepare('UPDATE auth_owner_sessions SET last_seen_at = ?, expires_at = ? WHERE session_hash = ?')
    .run(ends - 30 * DAY, ends, s.services.sessionHash(owner.token));
  return ends;
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe('an idle open tab', () => {
  it('SE-41 (control): a request the owner makes moves the end 30 days on', async () => {
    const ends = ageSession();
    expect((await owner.call('GET', '/api/admin/maintenance')).status).toBe(200);
    expect(owner.row().expires_at).toBeGreaterThan(ends + 29 * DAY);
  });

  it('SE-42: the Maintenance page left open, untouched, does not keep the session alive (its own refresh timer)', async () => {
    forwardToBridge();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    ui.renderApp('/ui/maintenance');
    expect(await rtl.screen.findByRole('heading', { level: 1, name: 'Maintenance Jobs' })).toBeTruthy();
    await rtl.waitFor(() => expect(forwarded).toContain('GET /api/admin/maintenance'));
    await rtl.act(() => settle());
    await drained();
    const ends = ageSession();
    const before = forwarded.length;
    // A quarter of an hour with the tab open and nothing done (no click, no key, no stream event).
    for (let i = 0; i < 60; i++) {
      await rtl.act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      await drained();
    }
    await rtl.act(() => settle());
    await drained();
    const sent = forwarded.slice(before);
    const notMarked = unmarked.filter((u) => u.index >= before).map((u) => u.line);
    expect(
      { endMovedBy: owner.row().expires_at - ends, sentByItselfUnmarked: notMarked },
      `the page sent ${sent.length} requests by itself; answered: ${answered.slice(-2).join(' | ')}`,
    ).toEqual({ endMovedBy: 0, sentByItselfUnmarked: [] });
    expect(sent.length, 'the page refreshed by itself (what the attempt relies on)').toBeGreaterThan(0);
  });

  it("SE-43: an agent's job event on the stream does not keep the owner's idle session alive", async () => {
    forwardToBridge();
    ui.renderApp('/ui/maintenance');
    expect(await rtl.screen.findByRole('heading', { level: 1, name: 'Maintenance Jobs' })).toBeTruthy();
    await ui.openStream();
    await rtl.waitFor(() => expect(forwarded).toContain('GET /api/admin/maintenance'));
    // The first loads (and those the stream's `hello` started) answered; React runs a render's effects when `act` ends.
    await rtl.act(() => settle());
    await drained();
    const ends = ageSession();
    const before = forwarded.length;
    rtl.act(() => {
      ui.lastSource().emit('job', { id: 'job_agent', status: 'running', projectId: 'proj_mock' });
    });
    await rtl.act(() => settle(700)); // the page's debounce (400 ms); the reload's effect runs as `act` ends
    await drained();
    const sent = forwarded.slice(before);
    const notMarked = unmarked.filter((u) => u.index >= before).map((u) => u.line);
    expect(
      { endMovedBy: owner.row().expires_at - ends, sentByItselfUnmarked: notMarked },
      `the page sent ${sent.length} requests by itself; answered: ${answered.slice(-2).join(' | ')}`,
    ).toEqual({ endMovedBy: 0, sentByItselfUnmarked: [] });
    expect(sent.length, 'the page refreshed by itself (what the attempt relies on)').toBeGreaterThan(0);
  });
});
