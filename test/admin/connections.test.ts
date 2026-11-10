/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON replies and mock data in tests */
/**
 * Hotfix (ADR 0033), through the real bridge and its admin API: removing revoked and expired connections (credentials
 * deleted, tombstone and audit in one transaction, an active connection refused), bulk and automatic removal, stale
 * connections, and history that still names a removed connection (the admin API and `bridge_journal_lookup`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../../src/auth/crypto.js';
import type { ClientRecord } from '../../src/auth/store.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { LkModel } from '../jobs/lk-model.js';
import { systemClock } from '../../src/lk/index.js';
import { PROJECT, startAdminStack, type AdminStack } from './helpers.js';

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});
let failCreates = false;
const respond = (req: MockRequest): MockResponse | undefined => {
  if (failCreates && req.method === 'POST' && /\/resources\/?$/.test(req.path)) {
    return {
      status: 400,
      body: { message: 'Not allowed', code: 'VALIDATION_ERROR', requestId: 'req-x', errors: [] },
    };
  }
  return model.respond(req);
};

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ respond });
});
afterAll(() => stack.close());

const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
const auth = () => stack.services.store;
const count = (sql: string, ...args: unknown[]) => (stack.db.prepare(sql).get(...args) as { n: number }).n;
let seq = 0;

function profile(label: string, scope: 'read' | 'propose' | 'write' = 'read') {
  return (
    stack.policy.store.getProfileByLabel(label) ??
    stack.policy.commands.createProfile('owner', { label, kind: 'other', scope })
  );
}

function client(clientId: string, name = 'ChatGPT'): void {
  const c: ClientRecord = {
    clientId,
    kind: 'dcr',
    clientName: name,
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    tokenEndpointAuthMethod: 'none',
    clientSecretHash: null,
    scope: 'mcp',
    metadata: {},
    createdAt: nowSec(),
    updatedAt: nowSec(),
    metadataExpiresAt: null,
    lastUsedAt: null,
  };
  auth().saveClient(c);
}

/** A grant with a refresh token, an access token and the code that made it, in the given state. */
function grant(o: {
  clientId?: string;
  name?: string;
  profileId: string;
  createdAgoDays?: number;
  revokedAgoDays?: number;
  expiredAgoDays?: number;
  usedAgoDays?: number;
}): string {
  const clientId = o.clientId ?? `client_${++seq}`;
  if (!auth().getClient(clientId)) client(clientId, o.name);
  const id = `grant_${++seq}-${Math.random().toString(16).slice(2, 8)}`;
  const created = nowSec() - (o.createdAgoDays ?? 1) * DAY;
  const expiresAt = o.expiredAgoDays !== undefined ? nowSec() - o.expiredAgoDays * DAY : created + 90 * DAY;
  auth().insertFamily({
    familyId: id,
    clientId,
    scope: 'mcp',
    resource: 'https://lk.example.test/mcp',
    createdAt: created,
    expiresAt,
    profileId: o.profileId,
  });
  auth().insertRefresh({
    tokenHash: hashSecret(`rt-${id}`),
    familyId: id,
    clientId,
    scope: 'mcp',
    createdAt: created,
    expiresAt,
  });
  auth().insertAccess({
    jti: `jti-${id}`,
    familyId: id,
    clientId,
    scope: 'mcp',
    audience: 'https://lk.example.test/mcp',
    createdAt: created,
    expiresAt: created + 3600,
  });
  auth().insertCode({
    codeHash: hashSecret(`code-${id}`),
    clientId,
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    redirectUriProvided: true,
    codeChallenge: 'x'.repeat(43),
    scope: 'mcp',
    resource: 'https://lk.example.test/mcp',
    createdAt: created,
    expiresAt: created + 60,
    profileId: o.profileId,
  });
  auth().linkCodeToFamily(hashSecret(`code-${id}`), id);
  if (o.usedAgoDays !== undefined) auth().touchFamily(id, nowSec() - o.usedAgoDays * DAY);
  if (o.revokedAgoDays !== undefined)
    auth().revokeFamily(id, 'revoked_by_owner', nowSec() - o.revokedAgoDays * DAY);
  return id;
}

function pat(o: { profileId: string; name?: string; expiresInDays?: number }) {
  const created = stack.services.pats.create({
    name: o.name ?? `pat-${++seq}`,
    profileId: o.profileId,
    ...(o.expiresInDays !== undefined ? { expiresInDays: o.expiresInDays } : {}),
  });
  return created.pat.id;
}

const familyRows = (id: string) => ({
  family: count('SELECT COUNT(*) AS n FROM auth_token_families WHERE family_id = ?', id),
  refresh: count('SELECT COUNT(*) AS n FROM auth_refresh_tokens WHERE family_id = ?', id),
  access: count('SELECT COUNT(*) AS n FROM auth_access_tokens WHERE family_id = ?', id),
  codes: count('SELECT COUNT(*) AS n FROM auth_codes WHERE family_id = ?', id),
});
const tombstone = (id: string) =>
  stack.db.prepare('SELECT * FROM removed_connections WHERE id = ?').get(id) as any;
const remove = (id: string) => stack.post(`/api/admin/clients/connections/${id}/remove`);
const revoke = (id: string) => stack.post(`/api/admin/clients/connections/${id}/revoke`);

describe('removing a connection', () => {
  it('refuses an active connection with 409 CONNECTION_ACTIVE, and changes nothing', async () => {
    const p = profile('removal-a');
    const g = grant({ profileId: p.id });
    const r = await remove(g);
    expect(r.status).toBe(409);
    expect(r.json.error?.code ?? r.json.code).toBe('CONNECTION_ACTIVE');
    expect(JSON.stringify(r.json)).toMatch(/Revoke it first/);
    expect(familyRows(g)).toEqual({ family: 1, refresh: 1, access: 1, codes: 1 });
    expect(tombstone(g)).toBeUndefined();
    const patId = pat({ profileId: p.id });
    expect((await remove(patId)).status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM auth_pats WHERE id = ?', patId)).toBe(1);
    expect((await remove('grant_nope')).status).toBe(404);
  });

  it('deletes every token row of the grant and nothing of another grant, leaves auth_clients alone, writes the tombstone and the audit row', async () => {
    const p = profile('removal-b');
    const a = grant({ profileId: p.id, clientId: 'shared_client', name: 'ChatGPT', revokedAgoDays: 2 });
    const b = grant({ profileId: p.id, clientId: 'shared_client', name: 'ChatGPT' }); // same client, still active
    const clientBefore = stack.db
      .prepare('SELECT * FROM auth_clients WHERE client_id = ?')
      .get('shared_client');
    const events = stack.events.filter((e) => e.action === 'connection.remove').length;

    const r = await remove(a);
    expect(r.status).toBe(200);
    expect(familyRows(a)).toEqual({ family: 0, refresh: 0, access: 0, codes: 0 });
    expect(familyRows(b)).toEqual({ family: 1, refresh: 1, access: 1, codes: 1 });
    expect(stack.db.prepare('SELECT * FROM auth_clients WHERE client_id = ?').get('shared_client')).toEqual(
      clientBefore,
    );
    expect(tombstone(a)).toMatchObject({
      id: a,
      type: 'grant',
      label: 'ChatGPT',
      client_id: 'shared_client',
      profile_id: p.id,
      profile_label: 'removal-b',
      removed_by: 'owner',
    });
    expect(tombstone(a).revoked_at).toBeGreaterThan(0);
    const row = stack.audit('connection.remove').find((x) => x.target === a)!;
    expect(row).toMatchObject({
      actor: 'owner',
      before: { id: a, type: 'grant', label: 'ChatGPT', profileLabel: 'removal-b', removedBy: 'owner' },
      after: null,
    });
    expect(stack.events.filter((e) => e.action === 'connection.remove').length).toBe(events + 1);
    // Gone from the dashboard's list.
    const list = (await stack.get('/api/admin/clients')).json;
    expect(list.connections.some((c: any) => c.id === a)).toBe(false);
    expect(list.connections.some((c: any) => c.id === b)).toBe(true);
  });

  it('removes a PAT: the auth_pats row goes, a tombstone and an audit row stay', async () => {
    const p = profile('removal-c');
    const id = pat({ profileId: p.id, name: 'Claude Code (PC)' });
    expect((await revoke(id)).status).toBe(200);
    expect((await remove(id)).status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM auth_pats WHERE id = ?', id)).toBe(0);
    expect(tombstone(id)).toMatchObject({ type: 'pat', label: 'Claude Code (PC)', client_id: null });
    expect(stack.audit('connection.remove').some((x) => x.target === id)).toBe(true);
  });

  it('removes an expired connection that was never revoked', async () => {
    const p = profile('removal-d');
    const g = grant({ profileId: p.id, expiredAgoDays: 1 });
    expect((await remove(g)).status).toBe(200);
    expect(tombstone(g)).toMatchObject({ revoked_at: null });
    expect(tombstone(g).expires_at).toBeGreaterThan(0);
  });

  it('is one transaction: a failure after the deletes leaves everything as it was', async () => {
    const p = profile('removal-e');
    const g = grant({ profileId: p.id, revokedAgoDays: 1 });
    const auditRows = stack.audit('connection.remove').length;
    const spy = vi.spyOn(stack.policy.store, 'audit').mockImplementationOnce(() => {
      throw new Error('forced failure after the credentials were deleted');
    });
    const r = await remove(g);
    spy.mockRestore();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(familyRows(g)).toEqual({ family: 1, refresh: 1, access: 1, codes: 1 });
    expect(tombstone(g)).toBeUndefined();
    expect(stack.audit('connection.remove').length).toBe(auditRows);
    // And it works afterwards.
    expect((await remove(g)).status).toBe(200);
  });
});

describe('bulk and automatic removal', () => {
  it('"remove all revoked and expired" returns the count and leaves active connections', async () => {
    const p = profile('bulk');
    const alive = grant({ profileId: p.id });
    const a = grant({ profileId: p.id, revokedAgoDays: 1 });
    const b = grant({ profileId: p.id, expiredAgoDays: 3 });
    const c = pat({ profileId: p.id });
    await revoke(c);
    const before = (await stack.get('/api/admin/clients')).json.connections.filter(
      (x: any) => !x.active,
    ).length;
    const r = await stack.post('/api/admin/clients/connections/remove-inactive');
    expect(r.status).toBe(200);
    expect(r.json.removed).toBe(before);
    expect(r.json.ids).toEqual(expect.arrayContaining([a, b, c]));
    expect(r.json.ids).not.toContain(alive);
    expect(familyRows(alive).family).toBe(1);
    expect((await stack.post('/api/admin/clients/connections/remove-inactive')).json.removed).toBe(0);
  });

  it('the auto-removal setting: validated, audited, default 30', async () => {
    expect((await stack.get('/api/admin/clients')).json.settings).toEqual({
      autoRemoveDays: 30,
      staleAfterDays: 14,
    });
    expect((await stack.put('/api/admin/clients/settings/auto-remove-days', { days: -1 })).status).toBe(400);
    expect((await stack.put('/api/admin/clients/settings/auto-remove-days', { days: 1.5 })).status).toBe(400);
    const r = await stack.put('/api/admin/clients/settings/auto-remove-days', { days: 10 });
    expect(r.json).toEqual({ autoRemoveDays: 10 });
    expect(stack.audit('policy.set_auto_remove_days')[0]).toMatchObject({
      actor: 'owner',
      before: { days: 30 },
      after: { days: 10 },
    });
    expect(
      stack.db.prepare("SELECT value FROM policy_settings WHERE key = 'connections.auto_remove_days'").get(),
    ).toEqual({
      value: '10',
    });
    await stack.put('/api/admin/clients/settings/auto-remove-days', { days: 30 });
  });

  it('the sweep respects the day count, 0 = never, and counts from expires_at for a connection that expired unrevoked', () => {
    const p = profile('sweep');
    const revoked20 = grant({ profileId: p.id, revokedAgoDays: 20 });
    const revoked40 = grant({ profileId: p.id, revokedAgoDays: 40 });
    const expired20 = grant({ profileId: p.id, expiredAgoDays: 20 });
    const expired40 = grant({ profileId: p.id, expiredAgoDays: 40 });
    // Revoked 5 days ago but expired 50 days ago: the clock starts at the revocation.
    const lateRevoke = grant({ profileId: p.id, createdAgoDays: 100, expiredAgoDays: 50, revokedAgoDays: 5 });
    const alive = grant({ profileId: p.id });
    const sweep = () => stack.policy.connections.sweepInactive();
    const cmd = stack.policy.commands;

    cmd.setAutoRemoveDays('owner', 0); // never
    expect(sweep()).toEqual({ removed: 0, ids: [] });
    expect(familyRows(revoked40).family).toBe(1);

    cmd.setAutoRemoveDays('owner', 30);
    const first = sweep();
    expect(new Set(first.ids)).toEqual(new Set([revoked40, expired40]));
    expect(familyRows(revoked20).family).toBe(1);
    expect(familyRows(expired20).family).toBe(1);
    expect(familyRows(lateRevoke).family).toBe(1);
    expect(familyRows(alive).family).toBe(1);
    expect(tombstone(expired40)).toMatchObject({ removed_by: 'system', revoked_at: null });
    expect(stack.audit('connection.remove').find((x) => x.target === expired40)).toMatchObject({
      actor: 'system',
      after: null,
    });

    cmd.setAutoRemoveDays('owner', 10);
    expect(new Set(sweep().ids)).toEqual(new Set([revoked20, expired20]));
    expect(familyRows(lateRevoke).family).toBe(1); // revoked only 5 days ago
    cmd.setAutoRemoveDays('owner', 30);
  });

  it('the maintenance job "connection-removal" runs the sweep daily', async () => {
    const jobs = stack.runtime.maintenance.scheduler.list();
    const job = jobs.find((j) => j.id === 'connection-removal')!;
    expect(job).toMatchObject({ implemented: true, scheduleText: 'Daily at 04:00 (London time)' });
    const p = profile('sweep-job');
    const g = grant({ profileId: p.id, revokedAgoDays: 45 });
    const { done } = stack.runtime.maintenance.commands.runNow('owner', 'connection-removal') as {
      done: Promise<unknown>;
    };
    expect(JSON.stringify(await done)).toMatch(/Removed 1 revoked or expired connection/);
    expect(familyRows(g).family).toBe(0);
    expect(tombstone(g)).toMatchObject({ removed_by: 'system' });
  });
});

describe('stale connections', () => {
  it('badges an active connection unused for longer than the setting (creation counts if never used); 0 = never', async () => {
    const p = profile('stale-a');
    const fresh = grant({ profileId: p.id, createdAgoDays: 30, usedAgoDays: 1 });
    const stale = grant({ profileId: p.id, createdAgoDays: 30, usedAgoDays: 20 });
    const neverUsed = grant({ profileId: p.id, createdAgoDays: 15 });
    const newcomer = grant({ profileId: p.id, createdAgoDays: 3 });
    const dead = grant({ profileId: p.id, createdAgoDays: 60, revokedAgoDays: 1 });
    const staleOf = async () =>
      new Set(
        (await stack.get('/api/admin/clients')).json.connections
          .filter((c: any) => c.stale)
          .map((c: any) => c.id),
      );
    let s = await staleOf();
    expect(s.has(stale) && s.has(neverUsed)).toBe(true);
    expect(s.has(fresh) || s.has(newcomer) || s.has(dead)).toBe(false); // a revoked one is not "stale"
    expect((await stack.put('/api/admin/clients/settings/stale-after-days', { days: 40 })).json).toEqual({
      staleAfterDays: 40,
    });
    s = await staleOf();
    expect(s.has(stale) || s.has(neverUsed)).toBe(false);
    await stack.put('/api/admin/clients/settings/stale-after-days', { days: 0 });
    expect((await staleOf()).size).toBe(0);
    await stack.put('/api/admin/clients/settings/stale-after-days', { days: 14 });
    expect(stack.audit('policy.set_stale_after_days')[0]).toMatchObject({ after: { days: 14 } });
  });

  it('"Revoke stale" touches only the stale connections of that profile, audited via: stale', async () => {
    const a = profile('stale-b');
    const b = profile('stale-c');
    const staleA = grant({ profileId: a.id, createdAgoDays: 40, usedAgoDays: 30 });
    const freshA = grant({ profileId: a.id, createdAgoDays: 40, usedAgoDays: 1 });
    const staleB = grant({ profileId: b.id, createdAgoDays: 40, usedAgoDays: 30 });
    const r = await stack.post('/api/admin/clients/connections/revoke-stale', { profileId: a.id });
    expect(r.json).toEqual({ revoked: 1, ids: [staleA] });
    expect(auth().getFamily(staleA)!.revokedAt).not.toBeNull();
    expect(auth().getFamily(staleA)!.revokedReason).toBe('revoked_stale');
    expect(auth().getFamily(freshA)!.revokedAt).toBeNull();
    expect(auth().getFamily(staleB)!.revokedAt).toBeNull();
    expect(stack.audit('connection.revoke').find((x) => x.target === staleA)).toMatchObject({
      after: { active: false, via: 'stale' },
    });
    expect(
      (await stack.post('/api/admin/clients/connections/revoke-stale', { profileId: 'prof_nope' })).status,
    ).toBe(404);
  });
});

describe('history still names a removed connection', () => {
  it('a journal entry, a proposal and an error by a removed principal keep their label, with the removed note, in the admin API and bridge_journal_lookup', async () => {
    const writer = profile('hist-write', 'write');
    const proposer = profile('hist-propose', 'propose');
    const wPat = pat({ profileId: writer.id, name: 'ChatGPT' });
    const pPat = pat({ profileId: proposer.id, name: 'Claude' });
    const origin = (id: string) => ({
      kind: 'mcp' as const,
      client: 't',
      tool: 'lk_api_write',
      principal: stack.policy.store.lookupPrincipal(id)!.principal,
    });
    const run = (id: string, op: string, params: object) =>
      stack.runtime.engine.run(op, params, { project: PROJECT, origin: origin(id) });
    expect(
      (await run(wPat, 'updateResource', { path: { resourceId: 'res1' }, body: { name: 'Kingdom 2' } }))
        .status,
    ).toBe('succeeded');
    failCreates = true;
    await run(wPat, 'createResource', { body: { name: 'Nope' } }).catch(() => undefined);
    failCreates = false;
    const captured = await run(pPat, 'updateResource', {
      path: { resourceId: 'res1' },
      body: { name: 'Kingdom 3' },
    });
    expect(captured.status).toBe('proposal_captured');

    const text = async (path: string) => JSON.stringify((await stack.get(path)).json);
    const beforeRemoval = await text('/api/admin/journal');
    expect(beforeRemoval).toContain('"name":"ChatGPT"'); // live: the label

    for (const id of [wPat, pPat]) {
      await revoke(id);
      expect((await remove(id)).status).toBe(200);
    }
    const day = tombstone(wPat).removed_at;
    const when = new Date(day).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Europe/London',
    });
    expect(when).toMatch(/^\d{1,2} \w+ \d{4}$/);

    const journal = (await stack.get('/api/admin/journal')).json;
    const entry = journal.entries.find((e: any) => e.principalId === wPat);
    expect(entry).toBeTruthy();
    expect(journal.principals[wPat]).toMatchObject({ name: `ChatGPT (removed ${when})`, type: 'removed' });

    const proposals = (await stack.get('/api/admin/proposals?group=pending')).json;
    expect(proposals.proposals.find((p: any) => p.principalId === pPat)).toBeTruthy();
    expect(proposals.principals[pPat].name).toBe(`Claude (removed ${when})`);
    const detail = (
      await stack.get(`/api/admin/proposals/${(captured as { proposalId: string }).proposalId}`)
    ).json;
    expect(detail.principals[pPat].name).toBe(`Claude (removed ${when})`);

    const jobs = (await stack.get('/api/admin/jobs')).json;
    expect(jobs.principals[wPat].name).toBe(`ChatGPT (removed ${when})`);

    const groups = (await stack.get('/api/admin/errors')).json.groups;
    const group = groups.find((g: any) => /createResource/.test(g.opId));
    expect(group).toBeTruthy();
    const occ = (
      await stack.get(`/api/admin/errors/group?fingerprint=${encodeURIComponent(group.fingerprint)}`)
    ).json;
    expect(occ.occurrences.some((o: any) => o.principalId === wPat)).toBe(true);
    expect(occ.principals[wPat].name).toBe(`ChatGPT (removed ${when})`);

    // The MCP tool, called by another (live) connection.
    const reader = pat({ profileId: profile('hist-read').id, name: 'Reader' });
    const tool = stack.runtime.tools.find((t) => t.name === 'bridge_journal_lookup')!;
    const out = await tool.handler({ limit: 20 }, {
      caller: undefined,
      signal: new AbortController().signal,
      log: { error() {}, warn() {}, info() {}, debug() {} },
      principal: stack.policy.store.lookupPrincipal(reader)!.principal,
      scope: 'read',
    } as unknown as McpToolContext);
    const body = JSON.parse((out.content[0] as { text: string }).text.split('\n')[0]!);
    const mine = body.entries.find((e: any) => e.principalId === wPat);
    expect(mine).toMatchObject({ principal: `ChatGPT (removed ${when})`, mine: false });
    expect(mine.principal).not.toBe(wPat);
    // Filtering by the removed id still works, because the journal keeps it.
    const filtered = await tool.handler({ principalId: wPat }, {
      caller: undefined,
      signal: new AbortController().signal,
      log: { error() {}, warn() {}, info() {}, debug() {} },
      principal: stack.policy.store.lookupPrincipal(reader)!.principal,
      scope: 'read',
    } as unknown as McpToolContext);
    expect(JSON.parse((filtered.content[0] as { text: string }).text.split('\n')[0]!).count).toBeGreaterThan(
      0,
    );
  });

  it('a principal with no tombstone (removed before this hotfix) reads "Removed connection", never a bare id; system reads "System"', () => {
    const names = stack.policy.store.describePrincipals(['pat_long_gone', 'system', 'grant_never_existed']);
    expect(names.get('pat_long_gone')).toMatchObject({ name: 'Removed connection', type: 'removed' });
    expect(names.get('grant_never_existed')!.name).toBe('Removed connection');
    expect(names.get('system')!.name).toBe('System');
  });
});
