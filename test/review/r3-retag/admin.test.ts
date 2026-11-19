/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies */
/**
 * R3-RETAG (pass 3): "owner classification needs re-authentication and agents can't set it" (ADR 0060
 * decision 4), through the dashboard's API (`POST /api/admin/tagging/classify` and `/unclassify`): an agent's
 * bearer token (a PAT and a real OAuth access token, both valid at /mcp), a foreign or missing Origin, a missing
 * CSRF token, a cross-site request, and a stale re-authentication. The harness is the real bridge
 * (test/admin/helpers.ts) against the mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullFlow } from '../../auth/helpers.js';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import { startAdminStack, type AdminStack } from '../../admin/helpers.js';

let s: AdminStack;
let pat: string;
let oauth: string;
let projectId: string;
beforeAll(async () => {
  s = await startAdminStack({
    respond: (req: MockRequest): MockResponse | undefined => {
      const m = /\/resources\/govroot1\/docs\/(gov[a-z]+)\/blocks\/?$/.exec(req.path);
      if (req.method === 'GET' && m)
        return { status: 200, body: { id: m[1], version: 'v1', schema: 1, text: '', blocks: [] } };
      return undefined;
    },
  });
  await s.runtime.ready;
  s.runtime.packs.ensureSeeded();
  s.runtime.packs.store.setGovernance(
    'arkona',
    ['character-architecture', 'source-formatting', 'tagging-standard'].map((key) => ({
      key,
      project: 'test',
      resourceId: 'govroot1',
      documentId: `gov${key.replace(/-/g, '').slice(0, 8)}`,
      name: key,
    })),
  );
  reauthAt(0);
  const ok = await s.post('/api/admin/packs/arkona/approve', { confirm: true });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  // An agent's credentials: a PAT of a write-scope profile, and an OAuth access token from a real flow.
  const profile = s.policy.commands.createProfile('owner', {
    label: 'r3-agent',
    kind: 'other',
    scope: 'write',
  });
  pat = s.services.pats.create({ name: 'r3 agent', profileId: profile.id }).token;
  oauth = (await fullFlow(s.bridge)).access;
  projectId = String((await s.get('/api/admin/tagging')).json.project.id);
});
afterAll(async () => {
  await s?.close();
});

/** The owner's re-authentication, `ago` seconds old. */
const reauthAt = (ago: number) =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(Math.floor(Date.now() / 1000) - ago, s.services.sessionHash(s.sessionToken));

const BODY = {
  pageId: 'r3adm001',
  primary: 'Culture',
  specialist: null,
  reason: 'the owner checked the page',
  confirm: true,
};
const classified = () => s.runtime.retag.store.classification(projectId, 'r3adm001');

describe('the classification route', () => {
  it('RT-90: an agent’s bearer token (PAT or OAuth, valid at /mcp) never classifies', async () => {
    reauthAt(0);
    for (const token of [pat, oauth]) {
      const bare = await s.post('/api/admin/tagging/classify', BODY, {
        cookie: null,
        csrf: null,
        authorization: `Bearer ${token}`,
      });
      expect(bare.status).toBe(401);
      const withCsrf = await s.post('/api/admin/tagging/classify', BODY, {
        cookie: null,
        authorization: `Bearer ${token}`,
      });
      expect(withCsrf.status).toBe(401);
    }
    expect(classified()).toBeNull();
  });

  it('RT-91: a foreign or missing Origin, a missing CSRF token, or a cross-site request is refused', async () => {
    reauthAt(0);
    const foreign = await s.post('/api/admin/tagging/classify', BODY, { origin: 'https://evil.example' });
    expect(foreign.json.error.code).toBe('BAD_ORIGIN');
    const none = await s.post('/api/admin/tagging/classify', BODY, { origin: null });
    expect(none.json.error.code).toBe('BAD_ORIGIN');
    const noCsrf = await s.post('/api/admin/tagging/classify', BODY, { csrf: null });
    expect(noCsrf.json.error.code).toBe('BAD_CSRF');
    const wrongCsrf = await s.post('/api/admin/tagging/classify', BODY, { csrf: 'x'.repeat(43) });
    expect(wrongCsrf.json.error.code).toBe('BAD_CSRF');
    const cross = await s.post('/api/admin/tagging/classify', BODY, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.json.error.code).toBe('CROSS_SITE');
    expect(classified()).toBeNull();
  });

  it('RT-92: a stale re-authentication (5 minutes and 1 second) is refused; a fresh one is accepted', async () => {
    reauthAt(301);
    const stale = await s.post('/api/admin/tagging/classify', BODY);
    expect(stale.status).toBe(403);
    expect(stale.json.error.code).toBe('REAUTH_REQUIRED');
    expect(classified()).toBeNull();
    reauthAt(0);
    const ok = await s.post('/api/admin/tagging/classify', BODY);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(classified()).toMatchObject({ primary: 'Culture', by: 'owner' });
    // Withdrawing it: the same rules.
    reauthAt(301);
    expect(
      (await s.post('/api/admin/tagging/unclassify', { pageId: 'r3adm001', confirm: true })).status,
    ).toBe(403);
    expect(classified()).not.toBeNull();
  });

  it('RT-93: a re-authentication of ANOTHER owner session does not count for this one', async () => {
    reauthAt(301);
    // Every other session of the owner re-authenticated now (as if the owner confirmed on another device).
    s.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash <> ?')
      .run(Math.floor(Date.now() / 1000), s.services.sessionHash(s.sessionToken));
    const r = await s.post('/api/admin/tagging/classify', { ...BODY, primary: 'Polity' });
    expect(r.status).toBe(403);
    expect(classified()).toMatchObject({ primary: 'Culture' });
  });
});
