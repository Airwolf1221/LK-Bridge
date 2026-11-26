/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions), further attempts on the session model:
 *
 * - SE-48: the sign-in page's `return_to` as an open redirect (after a successful sign-in, and for a signed-in visit).
 * - SE-49: the bounce answering a cross-site request that is not a navigation (an image, a fetch): it would set the
 *   30-second marker from another site's page, so that the owner's own next link to the bridge is not bounced.
 * - SE-50: `AUTH_SESSION_TTL_SECONDS` outside 5 minutes to 30 days.
 * - SE-51: a job the owner paused (one of ADR 0062 decision 6's brakes) resumed from a session that has not stepped up
 *   (ADR 0066 part B, question 3, had it ask; ADR 0081: it does not).
 * - SE-52: another method or spelling of a route that asks for the step-up (ADR 0081: a credential change).
 *
 * Each asserts the safe behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../../../src/config/auth.js';
import { PROJECT, PUBLIC_URL, startAdminStack, type AdminStack } from '../../admin/helpers.js';
import { Browser, throwawaySecret } from '../../auth/helpers.js';
import { notSteppedUp } from './helpers.js';

let s: AdminStack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe('more of the session model', () => {
  it('SE-48: the sign-in page never redirects off the bridge (return_to)', async () => {
    s = await startAdminStack();
    const stack = s;
    const tries = [
      '//evil.example/ui',
      '/\\evil.example',
      'https://evil.example/ui',
      '/ui@evil.example',
      '/oauth/authorize/../..//evil.example',
      '/ui/../\\evil.example',
      '/ui\t//evil.example',
      '/uix//evil.example',
      '/ui?return=https://evil.example',
    ];
    const off: string[] = [];
    for (const returnTo of tries) {
      const browser = new Browser(stack.bridge);
      const res = await browser.login(returnTo);
      const loc = res.headers.get('location');
      if (loc && new URL(loc, PUBLIC_URL).origin !== PUBLIC_URL) off.push(`${returnTo} → ${loc}`);
      // Signed in now: the sign-in page's own redirect for a signed-in visit.
      const again = await browser.request(
        `${PUBLIC_URL}/oauth/login?${new URLSearchParams({ return_to: returnTo }).toString()}`,
      );
      const loc2 = again.headers.get('location');
      if (loc2 && new URL(loc2, PUBLIC_URL).origin !== PUBLIC_URL)
        off.push(`(signed in) ${returnTo} → ${loc2}`);
    }
    expect(off).toEqual([]);
  });

  it('SE-49: a cross-site image or fetch is not answered with the bounce, and sets no marker', async () => {
    s = await startAdminStack();
    const stack = s;
    const out: Record<string, { bounced: boolean; marker: boolean }> = {};
    for (const [what, headers] of [
      ['image', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
      ['fetch', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
      [
        'iframe',
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      ],
    ] as const) {
      const r = await stack.call('GET', '/ui/jobs', { cookie: null, origin: null, headers });
      out[what] = {
        bounced: /http-equiv="refresh"/.test(r.text),
        marker: r.headers.getSetCookie().some((c) => c.startsWith('__Host-lkb_bounced=')),
      };
    }
    // The navigation the bounce is for (a link clicked on another site) is still bounced.
    const link = await stack.call('GET', '/ui/jobs', {
      cookie: null,
      origin: null,
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(/http-equiv="refresh"/.test(link.text)).toBe(true);
    expect(out).toEqual({
      image: { bounced: false, marker: false },
      fetch: { bounced: false, marker: false },
      iframe: { bounced: false, marker: false },
    });
  });

  it('SE-50: AUTH_SESSION_TTL_SECONDS outside 5 minutes to 30 days is refused at start-up', () => {
    const base = {
      BRIDGE_PUBLIC_URL: PUBLIC_URL,
      OWNER_PASSWORD_HASH: '$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
      SESSION_SECRET: throwawaySecret(),
      JWT_SIGNING_KEY: throwawaySecret(),
    };
    const ok = (v: string) => {
      try {
        return loadAuthConfig({ ...base, AUTH_SESSION_TTL_SECONDS: v }).ttl.sessionSeconds;
      } catch {
        return 'refused';
      }
    };
    expect([ok('299'), ok('300'), ok('2592000'), ok('2592001'), ok('-1'), ok('0')]).toEqual([
      'refused',
      300,
      2592000,
      'refused',
      'refused',
      'refused',
    ]);
  });

  it('SE-52: another method or spelling of a step-up route never reaches its handler without the step-up', async () => {
    s = await startAdminStack();
    const stack = s;
    const owner = notSteppedUp(stack);
    // ADR 0081: the default scope for new connections is a credential change (it asks).
    const before = stack.policy.commands.getDefaultScope('owner');
    const body = { scope: 'write', confirmRaise: true };
    const tries: [string, string, Record<string, string>?][] = [
      ['PATCH', '/api/admin/clients/default-scope'],
      ['POST', '/api/admin/clients/default-scope'],
      ['PUT', '/api/admin/clients/default-scope/'],
      ['PUT', '/api/admin/clients/default-scope?x=1'],
      ['PUT', '/api/admin/clients//default-scope'],
      ['PUT', '/api/admin/clients/Default-Scope'],
      ['PUT', '/api/admin/clients/default-scope%2f'],
      ['POST', '/api/admin/clients/default-scope', { 'x-http-method-override': 'PUT' }],
      ['DELETE', '/api/admin/clients/profiles/r4x/scope'],
    ];
    const reached: string[] = [];
    for (const [method, path, headers] of tries) {
      const r = await owner.call(method, path, body, headers ? { headers } : {});
      const asked = r.status === 403 && r.json?.error?.code === 'REAUTH_REQUIRED';
      const refused = r.status === 404 || r.status === 405 || r.status === 400;
      if (!asked && !refused) reached.push(`${method} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
    }
    expect(reached).toEqual([]);
    expect(stack.policy.commands.getDefaultScope('owner')).toBe(before);
  });

  // ADR 0066 part B, question 3 had resuming a paused job ask for the step-up; ADR 0081 (the owner, 26 November 2026):
  // it does not (a code at sign-in is enough).
  it('SE-51: resuming a job the owner paused (releasing that brake) needs no step-up', async () => {
    s = await startAdminStack();
    const stack = s;
    await stack.runtime.ready;
    const owner = notSteppedUp(stack);
    const release = stack.hold((method) => method !== 'GET'); // the job's first write waits at LegendKeeper
    try {
      const sub = (await stack.runtime.engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        title: 'r4 se51',
        origin: { kind: 'ui', client: 'r4', tool: 'r4_sessions' },
        onError: 'stop',
        steps: [
          { op: 'createResource', params: { body: { name: 'r4 se51 a' } } },
          { op: 'createResource', params: { body: { name: 'r4 se51 b' } } },
        ],
      } as never)) as { jobId?: string };
      expect(sub.jobId).toBeTruthy();
      const paused = await owner.call('POST', `/api/admin/jobs/${sub.jobId}/pause?project=${PROJECT}`, {});
      expect(paused.status, paused.text).toBe(200); // the brake: one click
      const resumed = await owner.call('POST', `/api/admin/jobs/${sub.jobId}/resume?project=${PROJECT}`, {});
      expect({ status: resumed.status, code: resumed.json?.error?.code ?? null }, resumed.text).toEqual({
        status: 200,
        code: null,
      });
    } finally {
      release();
    }
  });
});
