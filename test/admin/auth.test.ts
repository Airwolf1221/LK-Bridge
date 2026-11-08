/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- parsed JSON replies and mock data in tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullFlow } from '../auth/helpers.js';
import { startAdminStack, type AdminStack } from './helpers.js';

let stack: AdminStack;
let oauthAccess: string;
let patToken: string;

beforeAll(async () => {
  stack = await startAdminStack();
  oauthAccess = (await fullFlow(stack.bridge)).access;
  const profile = stack.policy.commands.listProfiles('owner')[0]!;
  patToken = stack.services.pats.create({ name: 'a pat', profileId: profile.id }).token;
});
afterAll(() => stack.close());

/** A concrete path for a route template; values only need to be well-formed, nothing runs before the guard. */
const concrete = (url: string) =>
  url.replace(':stepNo', '0').replace(':artifactId', 'art_x').replace(':id', 'x').replace(/\/$/, '');

describe('which routes exist', () => {
  it('registers the documented admin API (and the check below covers every one of them)', () => {
    const urls = stack.routes.map((r) => `${r.method} ${r.url}`);
    for (const expected of [
      'GET /api/admin/overview',
      'GET /api/admin/jobs',
      'POST /api/admin/jobs/:id/cancel',
      'POST /api/admin/jobs/:id/steps/:stepNo/retry',
      'GET /api/admin/errors',
      'POST /api/admin/errors/resolve',
      'GET /api/admin/budgets',
      'PUT /api/admin/budgets/reserve-floors',
      'GET /api/admin/writers',
      'PUT /api/admin/writers/max',
      'POST /api/admin/writes/pause',
      'POST /api/admin/writes/drain',
      'GET /api/admin/journal',
      'GET /api/admin/proposals',
      'POST /api/admin/proposals/bulk',
      'GET /api/admin/clients',
      'POST /api/admin/clients/pats',
      'GET /api/admin/settings',
      'GET /api/admin/stream',
    ]) {
      expect(urls, expected).toContain(expected);
    }
    expect(stack.routes.filter((r) => r.url.startsWith('/api/admin')).length).toBeGreaterThan(40);
  });
});

describe('every admin route accepts only the owner session', () => {
  const rejected = (reply: { status: number; json: any }) => {
    expect(reply.status).toBe(401);
    expect(reply.json).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  };

  it('rejects requests with no credentials, with JSON and no bearer challenge', async () => {
    for (const r of stack.routes.filter((r) => r.url.startsWith('/api/admin'))) {
      const reply = await stack.call(r.method, concrete(r.url), { cookie: null, csrf: null, origin: null });
      rejected(reply);
      expect(reply.headers.get('www-authenticate'), `${r.method} ${r.url}`).toBeNull();
      expect(reply.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects an OAuth access token that is valid at /mcp', async () => {
    // The token really works at /mcp...
    const mcp = await stack.bridge.fetch(stack.bridge.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${oauthAccess}`,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(mcp.status).not.toBe(401);
    // ...and does nothing on any admin route, with or without CSRF and Origin.
    for (const r of stack.routes.filter((r) => r.url.startsWith('/api/admin'))) {
      rejected(
        await stack.call(r.method, concrete(r.url), {
          cookie: null,
          authorization: `Bearer ${oauthAccess}`,
        }),
      );
    }
  });

  it('rejects a personal access token that is valid at /mcp', async () => {
    const mcp = await stack.bridge.fetch(stack.bridge.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${patToken}`,
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(mcp.status).not.toBe(401);
    for (const r of stack.routes.filter((r) => r.url.startsWith('/api/admin'))) {
      rejected(
        await stack.call(r.method, concrete(r.url), { cookie: null, authorization: `Bearer ${patToken}` }),
      );
    }
  });

  it('does not let a bearer token stand in beside a bad cookie either', async () => {
    rejected(
      await stack.get('/api/admin/overview', {
        cookie: 'lkb_session=nonsense',
        authorization: `Bearer ${patToken}`,
      }),
    );
    rejected(
      await stack.get('/api/admin/overview', {
        cookie: `${stack.services.owner.sessionCookie}=${'a'.repeat(43)}`,
      }),
    );
  });

  it('rejects a signed-out session', async () => {
    const token = stack.services.owner.createSession('127.0.0.1', 'vitest');
    const cookie = `${stack.services.owner.sessionCookie}=${token}`;
    expect((await stack.get('/api/admin/overview', { cookie })).status).toBe(200);
    stack.services.owner.logout(token, '127.0.0.1');
    rejected(await stack.get('/api/admin/overview', { cookie }));
  });

  it('refuses requests a browser marks as coming from another site, reads included (chunk 8, F-08)', async () => {
    for (const site of ['cross-site', 'same-site']) {
      for (const [method, path] of [
        ['GET', '/api/admin/overview?refresh=true'],
        ['GET', '/api/admin/session'],
        ['POST', '/api/admin/writes/pause'],
      ] as const) {
        const r = await stack.call(method, path, { headers: { 'sec-fetch-site': site } });
        expect(r.status, `${method} ${path} ${site}`).toBe(403);
        expect(r.json.error.code).toBe('CROSS_SITE');
      }
    }
    expect(stack.runtime.engine.queries.controls().writesPaused).toBe(false);
    // The dashboard's own requests, an address typed into the bar, and clients that send no such header still work.
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
      expect((await stack.call('GET', '/api/admin/session', { headers })).status).toBe(200);
    }
  });

  it('serves the owner session', async () => {
    const r = await stack.get('/api/admin/session');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ authenticated: true, username: 'owner', csrfToken: stack.csrf });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('state-changing routes need Origin and a CSRF token', () => {
  const mutating = () => stack.routes.filter((r) => r.url.startsWith('/api/admin') && r.method !== 'GET');

  it('covers a sensible number of state-changing routes', () => {
    expect(mutating().length).toBeGreaterThanOrEqual(25);
  });

  it('refuses a missing CSRF token', async () => {
    for (const r of mutating()) {
      const reply = await stack.call(r.method, concrete(r.url), { csrf: null });
      expect(reply.status, `${r.method} ${r.url}`).toBe(403);
      expect(reply.json.error.code).toBe('BAD_CSRF');
    }
  });

  it('refuses a wrong CSRF token, including one from another session or purpose', async () => {
    const other = stack.services.owner.createSession('127.0.0.1', 'vitest');
    const tokens = [
      'wrong',
      stack.csrf.slice(0, -2) + 'xx',
      stack.services.owner.csrfToken(other, 'admin'),
      stack.services.owner.csrfToken(stack.sessionToken, 'logout'),
    ];
    for (const t of tokens) {
      for (const r of mutating()) {
        const reply = await stack.call(r.method, concrete(r.url), { csrf: t });
        expect(reply.status, `${r.method} ${r.url}`).toBe(403);
        expect(reply.json.error.code).toBe('BAD_CSRF');
      }
    }
  });

  it('refuses a foreign or missing Origin', async () => {
    for (const origin of [
      'https://evil.example',
      'http://lk.example.test',
      `${'https://lk.example.test'}.evil.example`,
      null,
    ]) {
      for (const r of mutating()) {
        const reply = await stack.call(r.method, concrete(r.url), { origin });
        expect(reply.status, `${r.method} ${r.url} origin=${String(origin)}`).toBe(403);
        expect(reply.json.error.code).toBe('BAD_ORIGIN');
      }
    }
  });

  it('does nothing when refused: no audit row is written', async () => {
    const before = stack.audit().length;
    await stack.post('/api/admin/writes/pause', {}, { csrf: null });
    await stack.post('/api/admin/writes/pause', {}, { origin: 'https://evil.example' });
    expect(stack.audit().length).toBe(before);
    expect(stack.runtime.engine.queries.controls().writesPaused).toBe(false);
  });

  it('accepts the right pair', async () => {
    const r = await stack.post('/api/admin/writes/pause');
    expect(r.status).toBe(200);
    expect((await stack.post('/api/admin/writes/resume')).status).toBe(200);
  });

  it('does not need CSRF for reads (they change nothing), but still needs the session', async () => {
    expect((await stack.get('/api/admin/overview', { csrf: null, origin: null })).status).toBe(200);
  });
});

describe('error shape', () => {
  it('answers unknown admin paths with a JSON 404 behind the same guard', async () => {
    const r = await stack.get('/api/admin/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('NOT_FOUND');
    expect((await stack.get('/api/admin/nope', { cookie: null })).status).toBe(401);
  });

  it('rejects bad input with a 400 that names the field and no stack', async () => {
    const r = await stack.put('/api/admin/writers/max', { value: 'many' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('INVALID_INPUT');
    expect(r.text).not.toMatch(/\bat \w+.*\.ts/);
  });
});
