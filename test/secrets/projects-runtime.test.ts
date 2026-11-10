/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- parsed JSON replies */
/**
 * OPS2: projects managed on the dashboard, at runtime, without a restart. A project is added by pasting its key (checked
 * with LegendKeeper first, confirmed, then stored encrypted and served by a new governor at once); a key is replaced only
 * by another key of the SAME LegendKeeper project, atomically, keeping the project's governor; a project is removed
 * (archived, its key deleted) only when nothing is pending, after "pause and drain". Governor isolation holds
 * throughout: one project's calls never reach another's LegendKeeper project.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addProject, startManaged, type Managed } from './helpers.js';

let m: Managed;
let writer: Client;
let proposer: Client;

beforeAll(async () => {
  // alpha is in the env file (as on the live server today); gamma and delta exist in LegendKeeper only.
  m = await startManaged({
    lk: [{ name: 'alpha' }, { name: 'gamma' }, { name: 'delta' }],
    envProjects: ['alpha'],
  });
  writer = await m.connect('ops2-writer', 'write');
  proposer = await m.connect('ops2-proposer', 'propose');
});
afterAll(() => m?.close());

const project = async (name: string) =>
  ((await m.admin.get('/projects')).json.projects as any[]).find((p) => p.name === name);

describe('adding a project', () => {
  it('needs a fresh re-authentication, even when signed in', async () => {
    const r = await m.admin.post('/projects/check', { name: 'gamma', apiKey: m.projects.gamma!.keys[0] });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('REAUTH_REQUIRED');
    expect(m.projects.gamma!.used).toEqual([]); // nothing was asked of LegendKeeper
  });

  it('checks the key first and shows the project name, id and role; nothing is stored until confirmed', async () => {
    expect((await m.reauth()).status).toBe(200);
    const key = m.projects.gamma!.keys[0]!;
    const check = await m.admin.post('/projects/check', { name: 'Gamma', apiKey: `  ${key}\n` });
    expect(check.status, check.text).toBe(200);
    expect(check.json).toMatchObject({
      kind: 'add',
      name: 'gamma',
      lkProjectId: 'lkp_gamma',
      lkProjectName: 'Project gamma',
      role: 'ADMIN',
      keyHint: key.slice(-4),
    });
    expect(check.text).not.toContain(key);
    expect(await project('gamma')).toBeUndefined();
    expect(m.stack.db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE scope = 'lkp_gamma'").get()).toEqual({
      n: 0,
    });
    const before = m.stack.runtime.projects.clients().length;
    const confirm = await m.admin.post('/projects/confirm', { checkId: check.json.checkId, confirm: true });
    expect(confirm.status, confirm.text).toBe(200);
    expect(confirm.text).not.toContain(key);
    expect(confirm.json.project).toMatchObject({ name: 'gamma', status: 'active', keySource: 'store' });
    // Served at once, by a governor of its own: no restart.
    const clients = m.stack.runtime.projects.clients();
    expect(clients.length).toBe(before + 1);
    const g = clients.find((c) => c.name === 'gamma')!.client.governor;
    const a = clients.find((c) => c.name === 'alpha')!.client.governor;
    expect(g).not.toBe(a);
    const p = await project('gamma');
    expect(p).toMatchObject({
      keyHint: key.slice(-4),
      keySource: 'store',
      keyVariable: null,
      archived: false,
    });
    // A confirmation is used once.
    const again = await m.admin.post('/projects/confirm', { checkId: check.json.checkId, confirm: true });
    expect(again.status).toBe(404);
    expect(m.stack.audit('project.add')[0]).toMatchObject({ target: 'gamma' });
    expect(JSON.stringify(m.stack.audit())).not.toContain(key);
  });

  it('the new project is usable by agents at once, and its calls reach only its own LegendKeeper project', async () => {
    const usedA = m.projects.alpha!.used.length;
    const list = await m.call(writer, 'list_projects');
    expect(list.text).toMatch(/gamma/);
    const read = await m.call(writer, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'gamma_root' } },
      project: 'gamma',
    });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toMatch(/gamma root/);
    const cross = await m.call(writer, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'gamma_root' } },
      project: 'alpha',
    });
    expect(cross.isError).toBe(true); // alpha's LegendKeeper project has no such resource
    expect(m.projects.alpha!.used.length).toBe(usedA + 1);
    expect(m.projects.delta!.used).toEqual([]);
    // gamma's governor counted gamma's calls only.
    const snap = (n: string) =>
      m.stack.runtime.projects
        .clients()
        .find((c) => c.name === n)!
        .client.governor.snapshot();
    expect(snap('gamma').tiers['key-min'].used).toBeGreaterThan(0);
  });

  it('refuses a refused key, a key of a project already served, a taken or invalid name, and a malformed key', async () => {
    expect((await m.reauth()).status).toBe(200);
    const refused = await m.admin.post('/projects/check', { name: 'zeta', apiKey: m.refusedKey });
    expect(refused.status).toBe(422);
    expect(refused.json.error.code).toBe('KEY_REFUSED');
    expect(refused.text).not.toContain(m.refusedKey);
    const served = await m.admin.post('/projects/check', {
      name: 'other',
      apiKey: m.projects.alpha!.keys[0],
    });
    expect(served.status).toBe(200); // the key is fine; adding it under another name is not
    const conf = await m.admin.post('/projects/confirm', { checkId: served.json.checkId, confirm: true });
    expect(conf.status).toBe(409);
    expect(conf.json.error.code).toBe('ALREADY_SERVED');
    const taken = await m.admin.post('/projects/check', { name: 'alpha', apiKey: m.projects.delta!.keys[0] });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe('NAME_TAKEN');
    const bad = await m.admin.post('/projects/check', { name: '9 lives', apiKey: m.projects.delta!.keys[0] });
    const badConfirm = await m.admin.post('/projects/confirm', { checkId: bad.json.checkId, confirm: true });
    expect(badConfirm.json.error.code).toBe('INVALID_NAME');
    const spaced = await m.admin.post('/projects/check', {
      name: 'zeta',
      apiKey: 'not a key "ZQXJKV" spaces 123',
    });
    expect(spaced.status).toBe(400);
    expect(spaced.json.error.code).toBe('INVALID_KEY_FORMAT');
    expect(spaced.text).not.toContain('ZQXJKV');
    expect(await project('delta')).toBeUndefined();
  });

  it('a check made in one session cannot be confirmed from another', async () => {
    expect((await m.reauth()).status).toBe(200);
    const check = await m.admin.post('/projects/check', { name: 'delta', apiKey: m.projects.delta!.keys[0] });
    expect(check.status).toBe(200);
    const other = m.stack.services.owner.createSession('127.0.0.1', 'other');
    m.stack.services.store.setReauth(m.stack.services.sessionHash(other), m.stack.services.now());
    const csrf = m.stack.services.owner.csrfToken(other, 'admin');
    const r = await m.stack.post(
      '/api/admin/projects/confirm',
      { checkId: check.json.checkId, confirm: true },
      { cookie: `${m.stack.services.owner.sessionCookie}=${other}`, csrf },
    );
    expect(r.status).toBe(404);
    expect(await project('delta')).toBeUndefined();
  });
});

describe('replacing a key', () => {
  it('refuses a key of ANOTHER LegendKeeper project, changing nothing', async () => {
    expect((await m.reauth()).status).toBe(200);
    const row = () =>
      m.stack.db.prepare("SELECT nonce, ciphertext FROM secrets WHERE scope = 'lkp_gamma'").get() as object;
    const before = row();
    const client = m.stack.runtime.projects.client('lkp_gamma');
    const r = await m.admin.post('/projects/gamma/key/check', { apiKey: m.projects.delta!.keys[0] });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('KEY_WRONG_PROJECT');
    expect(r.text).not.toContain(m.projects.delta!.keys[0]);
    expect(row()).toEqual(before);
    expect(m.stack.runtime.projects.client('lkp_gamma')).toBe(client);
  });

  it('swaps atomically to another key of the same project, keeps the governor, and reminds the owner to revoke', async () => {
    expect((await m.reauth()).status).toBe(200);
    const oldKey = m.projects.gamma!.keys[0]!;
    const newKey = m.addKey('gamma');
    const governor = m.stack.runtime.projects.client('lkp_gamma')!.governor;
    const check = await m.admin.post('/projects/gamma/key/check', { apiKey: newKey });
    expect(check.status, check.text).toBe(200);
    expect(check.json).toMatchObject({
      kind: 'replace',
      lkProjectId: 'lkp_gamma',
      keyHint: newKey.slice(-4),
    });
    const confirm = await m.admin.post('/projects/confirm', { checkId: check.json.checkId, confirm: true });
    expect(confirm.status, confirm.text).toBe(200);
    expect(confirm.json.reminder).toMatch(new RegExp(`revoke the old key \\(ending ${oldKey.slice(-4)}\\)`));
    expect(confirm.text).not.toContain(newKey);
    expect(confirm.text).not.toContain(oldKey);
    const client = m.stack.runtime.projects.client('lkp_gamma')!;
    expect(client.governor).toBe(governor);
    const used = m.projects.gamma!.used.length;
    const read = await m.call(writer, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'gamma_root' } },
      project: 'gamma',
    });
    expect(read.isError, read.text).toBe(false);
    expect(m.projects.gamma!.used.slice(used)).toEqual([newKey]);
    expect((await project('gamma')).keyHint).toBe(newKey.slice(-4));
    const audit = m.stack.audit('project.replace_key')[0]!;
    expect(audit.before).toEqual({ keyHint: oldKey.slice(-4) });
    expect(audit.after).toMatchObject({ keyHint: newKey.slice(-4) });
  });
});

describe('removing a project', () => {
  it('is refused while a proposal is open; pause and drain stops new work; then it is archived, key deleted', async () => {
    const p = await m.call(proposer, 'lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'gamma_root' }, body: { name: 'renamed' } },
      project: 'gamma',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect((await project('gamma')).pending).toEqual({ jobs: 0, proposals: 1 });

    expect((await m.reauth()).status).toBe(200);
    const busy = await m.admin.post('/projects/gamma/remove', { confirm: true });
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe('PROJECT_BUSY');
    expect(busy.json.error.pending).toEqual({ jobs: 0, proposals: 1 });

    // Pause and drain: no new work for gamma (reads and writes), the other projects carry on.
    const drain = await m.admin.put('/projects/gamma/draining', { value: true });
    expect(drain.status, drain.text).toBe(200);
    expect(drain.json.project.draining).toBe(true);
    const refused = await m.call(writer, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'gamma_root' } },
      project: 'gamma',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/draining before its removal/);
    const alphaOk = await m.call(writer, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'alpha_root' } },
      project: 'alpha',
    });
    expect(alphaOk.isError, alphaOk.text).toBe(false);

    // The owner decides the open proposal, then removal goes through.
    const rej = await m.admin.post(`/proposals/${p.body.proposalId}/reject?project=gamma`, {
      reason: 'removing',
    });
    expect(rej.status, rej.text).toBe(200);
    expect((await m.reauth()).status).toBe(200);
    const governor = m.stack.runtime.projects.client('lkp_gamma')!.governor;
    const removed = await m.admin.post('/projects/gamma/remove', { confirm: true });
    expect(removed.status, removed.text).toBe(200);
    expect(removed.json.project).toMatchObject({ name: 'gamma', status: 'archived', readOnly: true });
    expect(m.stack.db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE scope = 'lkp_gamma'").get()).toEqual({
      n: 0,
    });
    expect(m.stack.runtime.projects.clients().some((c) => c.name === 'gamma')).toBe(false);
    expect(() => governor.snapshot()).not.toThrow(); // closed, its counts saved
    // Agents can no longer use it; its history stays readable on the dashboard.
    const gone = await m.call(writer, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'gamma_root' } },
      project: 'gamma',
    });
    expect(gone.isError).toBe(true);
    const history = await m.admin.get('/jobs?project=gamma&view=history');
    expect(history.status, history.text).toBe(200);
    const ro = await m.admin.put('/projects/gamma/read-only', { value: false, confirm: true });
    expect(ro.status).toBe(409);
    expect(ro.json.error.code).toBe('PROJECT_ARCHIVED');
    expect(m.stack.audit('project.remove')[0]).toMatchObject({ target: 'gamma' });
  });

  it('removal needs a fresh re-authentication', async () => {
    m.stack.db
      .prepare('UPDATE auth_owner_sessions SET reauth_at = NULL WHERE session_hash = ?')
      .run(m.stack.services.sessionHash(m.stack.sessionToken));
    const r = await m.admin.post('/projects/alpha/remove', { confirm: true });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('REAUTH_REQUIRED');
  });

  it('a removed project comes back only under its old name, with a key of the same LegendKeeper project', async () => {
    const key = m.projects.gamma!.keys[1]!;
    const other = await addProject(m, 'gamma_two', key);
    expect(other.confirm.status).toBe(409);
    expect(other.confirm.json.error.code).toBe('RESTORE_UNDER_NAME');
    const back = await addProject(m, 'gamma', key);
    expect(back.confirm.status, back.confirm.text).toBe(200);
    expect(back.confirm.json.project).toMatchObject({ name: 'gamma', status: 'active' });
    // Its history is its own again.
    expect((await m.admin.get('/jobs?project=gamma&view=history')).status).toBe(200);
  });
});

describe('removing a project with a job in flight', () => {
  it('is refused while a job runs, and allowed once it has finished', async () => {
    const added = await addProject(m, 'delta', m.projects.delta!.keys[0]!);
    expect(added.confirm.status, added.confirm.text).toBe(200);
    const release = m.stack.hold((method, url) => method === 'POST' && url.includes('/resources'));
    const pending = m.call(writer, 'lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: 'Made in delta' } },
      project: 'delta',
    });
    const deadline = Date.now() + 4000;
    while (((await project('delta')).pending as { jobs: number }).jobs === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await project('delta')).pending.jobs).toBe(1);
    expect((await m.reauth()).status).toBe(200);
    const busy = await m.admin.post('/projects/delta/remove', { confirm: true });
    expect(busy.status).toBe(409);
    expect(busy.json.error.pending).toEqual({ jobs: 1, proposals: 0 });
    // Draining lets the running job finish.
    expect((await m.admin.put('/projects/delta/draining', { value: true })).status).toBe(200);
    release();
    const done = await pending;
    expect(done.isError, done.text).toBe(false);
    const removed = await m.admin.post('/projects/delta/remove', { confirm: true });
    expect(removed.status, removed.text).toBe(200);
    expect(m.projects.delta!.model).toBeDefined();
  });
});
