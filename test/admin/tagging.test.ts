/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON replies */
/**
 * v3 F3f (ADR 0060): the Tagging page's admin API. The owner's classification of a page needs a fresh
 * re-authentication, takes the closed list only, and is audited (`retag.classify`); withdrawing it likewise. Agents
 * have no route to it (their tool only suggests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { startAdminStack, type AdminStack } from './helpers.js';

let s: AdminStack;
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
  reauth();
  const ok = await s.post('/api/admin/packs/arkona/approve', { confirm: true });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
});
afterAll(async () => {
  await s?.close();
});

const reauth = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(Math.floor(Date.now() / 1000), s.services.sessionHash(s.sessionToken));
const expire = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(null, s.services.sessionHash(s.sessionToken)); // ADR 0081: no step-up at all (these routes ask for none)

describe('the Tagging page API', () => {
  it('shows the policy (the approved version and its digest) and the closed list', async () => {
    const r = await s.get('/api/admin/tagging');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.unavailable).toBeNull();
    expect(r.json.policy).toMatchObject({ packId: 'arkona', version: 1 });
    expect(r.json.policy.digest).toMatch(/^[0-9a-f]{64}$/);
    const primaries = r.json.closedList.map((c: { primary: string }) => c.primary);
    expect(primaries).toEqual(expect.arrayContaining(['Character', 'Polity', 'Culture', 'Species']));
    expect(r.json.closedList.find((c: { primary: string }) => c.primary === 'Culture').specialists).toEqual([
      'Language',
      'Naming',
    ]);
  });

  it('the owner’s classification needs no fresh code (ADR 0081), takes the closed list only, and is audited', async () => {
    const body = {
      pageId: 'rttwo001',
      primary: 'Culture',
      specialist: 'Language',
      reason: 'the Scope names a language community',
      confirm: true,
    };
    expire();
    expect(s.audit('retag.classify')).toEqual([]);
    const notListed = await s.post('/api/admin/tagging/classify', { ...body, primary: 'Guild' });
    expect(notListed.status).toBe(400);
    expect(notListed.json.error.code).toBe('NOT_ON_CLOSED_LIST');
    const wrongSpecialist = await s.post('/api/admin/tagging/classify', {
      ...body,
      specialist: 'Government',
    });
    expect(wrongSpecialist.json.error.code).toBe('NOT_ON_CLOSED_LIST');
    const ok = await s.post('/api/admin/tagging/classify', body);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.classification).toMatchObject({
      pageId: 'rttwo001',
      primary: 'Culture',
      specialist: 'Language',
      by: 'owner',
    });
    const row = s.audit('retag.classify')[0]!;
    expect(row).toMatchObject({ actor: 'owner', target: 'rttwo001' });
    expect(JSON.stringify(row.after)).toContain('Language');
    const list = await s.get('/api/admin/tagging');
    expect(list.json.classifications).toHaveLength(1);
  });

  it('withdrawing a classification needs no fresh code either, and is audited', async () => {
    expire();
    const ok = await s.post('/api/admin/tagging/unclassify', { pageId: 'rttwo001', confirm: true });
    expect(ok.json.removed).toBe(true);
    expect(s.audit('retag.unclassify')).toHaveLength(1);
  });

  it('agents cannot set a classification: only the owner actor is accepted by the service', () => {
    expect(() =>
      s.runtime.retag.classify('agent', 'test', {
        pageId: 'rttwo001',
        pageName: 'x',
        primary: 'Culture',
        specialist: null,
        reason: 'x',
      }),
    ).toThrow(/Only the owner/);
  });

  it('the Packs page takes the Excluded Routine Tags: a new version (audited) waiting for approval', async () => {
    reauth();
    const r = await s.put('/api/admin/packs/arkona/tokens', {
      excludedRoutineTags: ['Imported', ' imported ', 'Draft'],
      confirm: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.pack.rules.retag.excludedRoutineTags).toEqual(['Imported', 'Draft']);
    expect(r.json.pack.approved.version).toBeLessThan(r.json.pack.version);
    const row = s.audit('pack.set_tokens').at(-1)!;
    expect(row.after).toMatchObject({ excludedRoutineTags: ['Imported', 'Draft'] });
  });
});
