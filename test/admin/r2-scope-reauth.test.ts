/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11-R2 (R2-50) and ADR 0062 (accepted with the owner's rule, 19 November 2026: tightening is one click,
 * loosening asks): a change that lets an agent's connection do more needs the owner's step-up within the last ten
 * minutes: raising a profile's scope or the default scope, moving a connection to a higher scope or to a profile at
 * scope `write` (whose rails may be weaker), and any new personal access token (a key). Lowering a scope and moving a
 * connection down stay one click. A project's settings ask too, except switching ChatGPT's file source off. Nothing
 * changes without it.
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
const setReauth = (at: number) =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(at, s.services.sessionHash(s.sessionToken));
const expire = () => setReauth(now() - 601); // older than the 10-minute step-up
const reauth = () => setReauth(now());
const profile = (label: string, scope: 'read' | 'propose' | 'write') =>
  s.policy.commands.createProfile('owner', { label, kind: 'other', scope });

describe('the step-up for every change that lets a connection do more (R2-50, ADR 0062)', () => {
  it('raising a profile’s scope needs it; lowering does not', async () => {
    const p = profile('r2 raise', 'propose');
    expire();
    const refused = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, {
      scope: 'write',
      confirmRaise: true,
    });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('propose');
    const lowered = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, { scope: 'read' });
    expect(lowered.status, lowered.text).toBe(200);
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('read');
    reauth();
    const raised = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, {
      scope: 'write',
      confirmRaise: true,
    });
    expect(raised.status, raised.text).toBe(200);
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('write');
  });

  it('raising the default scope needs it; lowering does not', async () => {
    const before = s.policy.commands.getDefaultScope('owner');
    expire();
    const refused = await s.put('/api/admin/clients/default-scope', { scope: 'write', confirmRaise: true });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    expect(s.policy.commands.getDefaultScope('owner')).toBe(before);
    reauth();
    expect(
      (await s.put('/api/admin/clients/default-scope', { scope: 'write', confirmRaise: true })).status,
    ).toBe(200);
    expire();
    expect((await s.put('/api/admin/clients/default-scope', { scope: 'read' })).status).toBe(200);
    expect(s.policy.commands.getDefaultScope('owner')).toBe('read');
  });

  it('moving a connection to a higher scope or to a write profile needs it; moving it down does not', async () => {
    const low = profile('r2 move low', 'read');
    const writer = profile('r2 move writer', 'write');
    const writer2 = profile('r2 move writer 2', 'write');
    const conn = s.services.pats.create({ name: 'r2 mover', profileId: low.id });
    expire();
    const up = await s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, { profileId: writer.id });
    expect(up.status, up.text).toBe(403);
    expect(up.json.error.code).toBe('REAUTH_REQUIRED');
    expect(s.policy.store.lookupPrincipal(conn.pat.id)?.scope).toBe('read');
    reauth();
    expect(
      (await s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, { profileId: writer.id })).status,
    ).toBe(200);
    expire();
    // Between two profiles at scope write the rails may differ: still the step-up.
    const sideways = await s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, {
      profileId: writer2.id,
    });
    expect(sideways.status, sideways.text).toBe(403);
    // Down to scope read: a tightening, one click.
    const down = await s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, { profileId: low.id });
    expect(down.status, down.text).toBe(200);
    expect(s.policy.store.lookupPrincipal(conn.pat.id)?.scope).toBe('read');
  });

  it('a personal access token (a key) needs it at any scope; the refusal holds no token', async () => {
    const writer = profile('r2 pat writer', 'write');
    const reader = profile('r2 pat reader', 'read');
    expire();
    for (const profileId of [writer.id, reader.id]) {
      const refused = await s.post('/api/admin/clients/pats', { name: 'r2 token', profileId });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
      expect(refused.text).not.toMatch(/lkb_pat_/);
    }
    reauth();
    for (const profileId of [writer.id, reader.id])
      expect((await s.post('/api/admin/clients/pats', { name: 'r2 token', profileId })).status).toBe(201);
  });
});

describe('a project’s settings through the generic settings route (ADR 0062)', () => {
  it('the Status of pages agents create (R2-51) and an ordinary setting both need it; nothing saves without it', async () => {
    await until(() => s.runtime.projects.activeIds().length === 1);
    const project = s.runtime.projects.defaultProject();
    expire();
    for (const [key, value] of [
      ['agentDefaultStatus', 'Authoritative'],
      ['treeSweepEnabled', false],
    ] as const) {
      const refused = await s.put(`/api/admin/projects/${project.name}/settings`, { key, value });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    }
    const settings = s.runtime.projects.find(project.name)?.settings;
    expect(settings?.agentDefaultStatus).toBeUndefined();
    expect(settings?.treeSweepEnabled).toBeUndefined();
    reauth();
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
  });

  // ADR 0057 decision 7, kept by ADR 0062's rule: switching ChatGPT's file source on lets an agent make the bridge
  // download more, so it needs the step-up; switching it off (a tightening) stays one click. Every change is audited.
  it('fileSourceEnabled: off is one click; on (or back to the default) needs the step-up; audited', async () => {
    const project = s.runtime.projects.defaultProject();
    const audits = () =>
      s.policy.store
        .listAudit({ action: 'project.set_setting' })
        .filter((a) => JSON.stringify(a).includes('fileSourceEnabled')).length;
    const before = audits();
    expire();
    const off = await s.put(`/api/admin/projects/${project.name}/settings`, {
      key: 'fileSourceEnabled',
      value: false,
    });
    expect(off.status, off.text).toBe(200);
    expect(s.runtime.projects.find(project.name)?.settings.fileSourceEnabled).toBe(false);
    for (const value of [true, null]) {
      const refused = await s.put(`/api/admin/projects/${project.name}/settings`, {
        key: 'fileSourceEnabled',
        value,
      });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    }
    expect(s.runtime.projects.find(project.name)?.settings.fileSourceEnabled).toBe(false);
    reauth();
    const on = await s.put(`/api/admin/projects/${project.name}/settings`, {
      key: 'fileSourceEnabled',
      value: true,
    });
    expect(on.status, on.text).toBe(200);
    expect(s.runtime.projects.find(project.name)?.settings.fileSourceEnabled).toBe(true);
    expect(audits()).toBe(before + 2);
  });
});
