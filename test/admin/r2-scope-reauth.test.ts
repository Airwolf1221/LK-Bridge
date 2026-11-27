/**
 * CR-2026-11-R2 (R2-50), ADR 0062, narrowed by ADR 0081 (the owner, 26 November 2026: "A code at sign-in is enough"): a
 * change to what a connection may do needs a fresh authenticator code on this session, within the window
 * (`AUTH_STEP_UP_WINDOW_SECONDS`, 12 hours): a profile's scope or the default scope changed (raised or lowered: it is
 * its connections' scope), a connection moved to another profile (any way), a connection revoked, and any new personal
 * access token (a key). Nothing changes without it. A project's settings need none (ADR 0062 had asked for every one
 * but ChatGPT's file source switched off).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, until, type AdminStack } from './helpers.js';

let s: AdminStack;
beforeAll(async () => {
  s = await startAdminStack();
});
afterAll(async () => {
  await s?.close();
});

const now = () => Math.floor(Date.now() / 1000);
const setReauth = (at: number | null) =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(at, s.services.sessionHash(s.sessionToken));
/** No step-up on the session. */
const expire = () => setReauth(null);
const reauth = () => setReauth(now());
const profile = (label: string, scope: 'read' | 'propose' | 'write') =>
  s.policy.commands.createProfile('owner', { label, kind: 'other', scope });
const asked = (r: { status: number; json?: { error?: { code?: string } } }) =>
  r.status === 403 && r.json?.error?.code === 'REAUTH_REQUIRED';

describe('the step-up for every change to what a connection may do (R2-50, ADR 0081)', () => {
  it('a profile’s scope changed, raised or lowered, needs it', async () => {
    const p = profile('r2 raise', 'propose');
    expire();
    const raise = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, {
      scope: 'write',
      confirmRaise: true,
    });
    const lower = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, { scope: 'read' });
    expect([asked(raise), asked(lower)], `${raise.text} ${lower.text}`).toEqual([true, true]);
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('propose');
    reauth();
    const raised = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, {
      scope: 'write',
      confirmRaise: true,
    });
    expect(raised.status, raised.text).toBe(200);
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('write');
    const lowered = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, { scope: 'read' });
    expect(lowered.status, lowered.text).toBe(200);
  });

  it('the default scope changed, raised or lowered, needs it', async () => {
    const before = s.policy.commands.getDefaultScope('owner');
    expire();
    const raise = await s.put('/api/admin/clients/default-scope', { scope: 'write', confirmRaise: true });
    expect(asked(raise), raise.text).toBe(true);
    expect(s.policy.commands.getDefaultScope('owner')).toBe(before);
    reauth();
    expect(
      (await s.put('/api/admin/clients/default-scope', { scope: 'write', confirmRaise: true })).status,
    ).toBe(200);
    expire();
    expect(asked(await s.put('/api/admin/clients/default-scope', { scope: 'read' }))).toBe(true);
    expect(s.policy.commands.getDefaultScope('owner')).toBe('write');
    reauth();
    expect((await s.put('/api/admin/clients/default-scope', { scope: 'read' })).status).toBe(200);
    expect(s.policy.commands.getDefaultScope('owner')).toBe('read');
  });

  it('moving a connection to another profile needs it, up, sideways or down; so does revoking it', async () => {
    const low = profile('r2 move low', 'read');
    const writer = profile('r2 move writer', 'write');
    const writer2 = profile('r2 move writer 2', 'write');
    const conn = s.services.pats.create({ name: 'r2 mover', profileId: low.id });
    const move = (profileId: string) =>
      s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, { profileId });
    expire();
    expect(asked(await move(writer.id))).toBe(true);
    expect(s.policy.store.lookupPrincipal(conn.pat.id)?.scope).toBe('read');
    reauth();
    expect((await move(writer.id)).status).toBe(200);
    expire();
    expect([asked(await move(writer2.id)), asked(await move(low.id))]).toEqual([true, true]);
    expect(s.policy.store.lookupPrincipal(conn.pat.id)?.scope).toBe('write');
    const revoke = await s.post(`/api/admin/clients/connections/${conn.pat.id}/revoke`, {});
    expect(asked(revoke), revoke.text).toBe(true);
    reauth();
    expect((await move(low.id)).status).toBe(200);
    expect((await s.post(`/api/admin/clients/connections/${conn.pat.id}/revoke`, {})).status).toBe(200);
  });

  it('a personal access token (a key) needs it at any scope; the refusal holds no token', async () => {
    const writer = profile('r2 pat writer', 'write');
    const reader = profile('r2 pat reader', 'read');
    expire();
    for (const profileId of [writer.id, reader.id]) {
      const refused = await s.post('/api/admin/clients/pats', { name: 'r2 token', profileId });
      expect(asked(refused), refused.text).toBe(true);
      expect(refused.text).not.toMatch(/lkb_pat_/);
    }
    reauth();
    for (const profileId of [writer.id, reader.id])
      expect((await s.post('/api/admin/clients/pats', { name: 'r2 token', profileId })).status).toBe(201);
  });
});

describe('a project’s settings through the generic settings route (ADR 0081: no step-up)', () => {
  it('the Status of pages agents create (R2-51) and an ordinary setting save without one', async () => {
    await until(() => s.runtime.projects.activeIds().length === 1);
    const project = s.runtime.projects.defaultProject();
    expire();
    const saved = await s.put(`/api/admin/projects/${project.name}/settings`, {
      key: 'agentDefaultStatus',
      value: 'Draft',
    });
    expect(saved.status, saved.text).toBe(200);
    const ordinary = await s.put(`/api/admin/projects/${project.name}/settings`, {
      key: 'treeSweepEnabled',
      value: false,
    });
    expect(ordinary.status, ordinary.text).toBe(200);
    expect(s.runtime.projects.find(project.name)?.settings).toMatchObject({
      agentDefaultStatus: 'Draft',
      treeSweepEnabled: false,
    });
  });

  it('fileSourceEnabled: off, on and back to the default, each one click; audited', async () => {
    const project = s.runtime.projects.defaultProject();
    const audits = () =>
      s.policy.store
        .listAudit({ action: 'project.set_setting' })
        .filter((a) => JSON.stringify(a).includes('fileSourceEnabled')).length;
    const before = audits();
    expire();
    for (const value of [false, true, null]) {
      const r = await s.put(`/api/admin/projects/${project.name}/settings`, {
        key: 'fileSourceEnabled',
        value,
      });
      expect(r.status, r.text).toBe(200);
    }
    expect(audits()).toBe(before + 3);
  });
});
