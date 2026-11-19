/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11-R2 (R2-50), amended by ADR 0062 (the owner's 30-day session): every change of what an agent's connection
 * may do needs the owner's step-up within the last ten minutes. R2-50 asked it of a raise only (a raised scope, a
 * connection moved up or to a profile at scope `write`, a token at scope `write`); the owner's list for ADR 0062 says
 * "scope changes" and "keys", so a lowering, any connection move and every new token need it too. The brakes stay one
 * click: revoking a connection, pausing writes. Nothing changes without it.
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
const expire = () => setReauth(now() - 601); // ADR 0062: older than the 10-minute step-up
const reauth = () => setReauth(now());
const profile = (label: string, scope: 'read' | 'propose' | 'write') =>
  s.policy.commands.createProfile('owner', { label, kind: 'other', scope });

describe('the step-up for every change of what a connection may do (R2-50, ADR 0062)', () => {
  it('a profile’s scope: a raise and a lowering both need it; the same scope again changes nothing', async () => {
    const p = profile('r2 raise', 'propose');
    expire();
    const raise = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, {
      scope: 'write',
      confirmRaise: true,
    });
    expect(raise.status, raise.text).toBe(403);
    expect(raise.json.error.code).toBe('REAUTH_REQUIRED');
    const lower = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, { scope: 'read' });
    expect(lower.status, lower.text).toBe(403);
    expect(lower.json.error.code).toBe('REAUTH_REQUIRED');
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('propose');
    const same = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, { scope: 'propose' });
    expect(same.status, same.text).toBe(200);
    reauth();
    const raised = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, {
      scope: 'write',
      confirmRaise: true,
    });
    expect(raised.status, raised.text).toBe(200);
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('write');
    const lowered = await s.put(`/api/admin/clients/profiles/${p.id}/scope`, { scope: 'read' });
    expect(lowered.status, lowered.text).toBe(200);
    expect(s.policy.store.getProfile(p.id)?.scope).toBe('read');
  });

  it('the default scope: a raise and a lowering both need it', async () => {
    const before = s.policy.commands.getDefaultScope('owner');
    expire();
    for (const body of [{ scope: 'write', confirmRaise: true }, { scope: 'read' }]) {
      if (body.scope === before) continue;
      const r = await s.put('/api/admin/clients/default-scope', body);
      expect(r.status, r.text).toBe(403);
      expect(r.json.error.code).toBe('REAUTH_REQUIRED');
    }
    expect(s.policy.commands.getDefaultScope('owner')).toBe(before);
    reauth();
    expect(
      (await s.put('/api/admin/clients/default-scope', { scope: 'write', confirmRaise: true })).status,
    ).toBe(200);
    expect((await s.put('/api/admin/clients/default-scope', { scope: 'read' })).status).toBe(200);
    expect(s.policy.commands.getDefaultScope('owner')).toBe('read');
  });

  it('moving a connection to another profile needs it, up, sideways or down; revoking it stays one click', async () => {
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
    const moved = await s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, {
      profileId: writer.id,
    });
    expect(moved.status, moved.text).toBe(200);
    expire();
    for (const target of [writer2.id, low.id]) {
      const r = await s.put(`/api/admin/clients/connections/${conn.pat.id}/profile`, { profileId: target });
      expect(r.status, r.text).toBe(403);
    }
    expect(s.policy.store.lookupPrincipal(conn.pat.id)?.scope).toBe('write');
    // The brake: revoking takes access away only, and stays one click.
    const revoked = await s.post(`/api/admin/clients/connections/${conn.pat.id}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
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

describe('a project’s settings through the generic settings route (ADR 0062: every setting)', () => {
  it('the Status of pages agents create and an ordinary setting both need it; nothing saves without it', async () => {
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

  // ADR 0057 decision 7 made switching ChatGPT's file source off one click; under ADR 0062 it is a setting like the
  // others. Every change is still audited.
  it('fileSourceEnabled: off, on and back to the default each need it; audited', async () => {
    const project = s.runtime.projects.defaultProject();
    const audits = () =>
      s.policy.store
        .listAudit({ action: 'project.set_setting' })
        .filter((a) => JSON.stringify(a).includes('fileSourceEnabled')).length;
    const before = audits();
    expire();
    for (const value of [false, true, null]) {
      const refused = await s.put(`/api/admin/projects/${project.name}/settings`, {
        key: 'fileSourceEnabled',
        value,
      });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.json.error.code).toBe('REAUTH_REQUIRED');
    }
    expect(s.runtime.projects.find(project.name)?.settings.fileSourceEnabled).toBeUndefined();
    expect(audits()).toBe(before);
    reauth();
    for (const value of [false, true]) {
      const r = await s.put(`/api/admin/projects/${project.name}/settings`, {
        key: 'fileSourceEnabled',
        value,
      });
      expect(r.status, r.text).toBe(200);
      expect(s.runtime.projects.find(project.name)?.settings.fileSourceEnabled).toBe(value);
    }
    expect(audits()).toBe(before + 2);
  });
});
