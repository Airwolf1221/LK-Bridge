/**
 * v3 F3a (ADR 0050): the Packs page's admin API. The Arkona pack is listed as stored (no request); its governance is read
 * on request; approving a version and saving the token maps each need a fresh re-authentication and are audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { startAdminStack, type AdminStack } from './helpers.js';

let s: AdminStack;
let version = 1;
beforeAll(async () => {
  // LegendKeeper as far as the pack needs it: three governance documents, each with a version.
  s = await startAdminStack({
    respond: (req: MockRequest): MockResponse | undefined => {
      const m = /\/resources\/govroot1\/docs\/(gov[a-z]+)\/blocks\/?$/.exec(req.path);
      if (req.method === 'GET' && m)
        return { status: 200, body: { id: m[1], version: `v${m[1] === 'govtags' ? version : 1}`, schema: 1, text: '', blocks: [] } };
      return undefined;
    },
  });
  await s.runtime.ready;
  s.runtime.packs.ensureSeeded();
  s.runtime.packs.store.setGovernance('arkona', [
    { key: 'character-architecture', project: 'test', resourceId: 'govroot1', documentId: 'govarch', name: 'Character Architecture' },
    { key: 'source-formatting', project: 'test', resourceId: 'govroot1', documentId: 'govform', name: 'Source Formatting' },
    { key: 'tagging-standard', project: 'test', resourceId: 'govroot1', documentId: 'govtags', name: 'Controlled Native Tagging Standard', label: 'v1.8' },
  ]);
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
    .run(Math.floor(Date.now() / 1000) - 301, s.services.sessionHash(s.sessionToken));

describe('the Packs page API', () => {
  it('lists the pack as stored: rules, governance sources, attachments, tools, versions', async () => {
    const r = await s.get('/api/admin/packs');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const p = r.json.packs[0];
    expect(p).toMatchObject({ id: 'arkona', name: 'Arkona', prefix: 'arkona_', version: 1, approved: null });
    expect(p.tools).toEqual(['arkona_create_character']);
    expect(p.rules.tags.culture['Draconic (True Dragons)']).toBe('Draconic');
    expect(p.governance.map((g: { name: string }) => g.name)).toEqual([
      'Character Architecture',
      'Source Formatting',
      'Controlled Native Tagging Standard',
    ]);
    expect(p.attachments.map((a: { projectName: string }) => a.projectName)).toEqual(['test']);
    expect(p.versions[0]).toMatchObject({ version: 1, reason: 'seed' });
  });

  it('reads the governance on request: not approved yet', async () => {
    const r = await s.get('/api/admin/packs/arkona/governance');
    expect(r.status).toBe(200);
    expect(r.json.governance.state).toBe('unapproved');
    expect(r.json.governance.sources.map((x: { current: string }) => x.current)).toEqual(['v1', 'v1', 'v1']);
  });

  it('approving needs a fresh re-authentication; then it records the versions, audited', async () => {
    expire();
    const refused = await s.post('/api/admin/packs/arkona/approve', { confirm: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    expect(s.audit('pack.approve')).toEqual([]);
    reauth();
    const noConfirm = await s.post('/api/admin/packs/arkona/approve', {});
    expect(noConfirm.status).toBe(400);
    const ok = await s.post('/api/admin/packs/arkona/approve', { confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.governance.state).toBe('current');
    expect(ok.json.pack.approved).toMatchObject({ version: 1, by: 'owner' });
    const row = s.audit('pack.approve')[0]!;
    expect(row).toMatchObject({ actor: 'owner', target: 'arkona' });
    expect(JSON.stringify(row.after)).toContain('tagging-standard');
  });

  it('a changed source shows as drift; approving again settles it (re-approval, audited)', async () => {
    version = 2;
    const r = await s.get('/api/admin/packs/arkona/governance');
    expect(r.json.governance.state).toBe('changed');
    const list = await s.get('/api/admin/packs');
    expect(list.json.packs[0].drift.changed.map((c: { key: string }) => c.key)).toEqual(['tagging-standard']);
    reauth();
    const again = await s.post('/api/admin/packs/arkona/approve', { confirm: true });
    expect(again.status).toBe(200);
    expect(again.json.governance.state).toBe('current');
    expect(s.audit('pack.approve')).toHaveLength(2);
  });

  it('saving the token maps needs re-authentication, makes a new version (audited) that waits for approval', async () => {
    expire();
    const refused = await s.put('/api/admin/packs/arkona/tokens', { race: { Starborn: 'Starborn' }, confirm: true });
    expect(refused.status).toBe(403);
    reauth();
    const bad = await s.put('/api/admin/packs/arkona/tokens', { culture: { Foo: 'None' }, confirm: true });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_TOKEN');
    const race = { ...s.runtime.packs.get('arkona')!.rules.tags.race, Starborn: 'Starborn' };
    const ok = await s.put('/api/admin/packs/arkona/tokens', { race, confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.pack.version).toBe(2);
    expect(ok.json.pack.rules.tags.race.Starborn).toBe('Starborn');
    expect(s.audit('pack.set_tokens')[0]).toMatchObject({ actor: 'owner', target: 'arkona' });
    const g = await s.get('/api/admin/packs/arkona/governance');
    expect(g.json.governance.state).toBe('rules_changed');
  });

  it('an unknown pack is 404', async () => {
    const r = await s.get('/api/admin/packs/nosuch/governance');
    expect(r.status).toBe(404);
  });
});
