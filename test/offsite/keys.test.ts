/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion -- parsed JSON replies */
/**
 * v2 E1b (ADR 0043): the encryption keys on the dashboard. Generated keys are shown once and saved only after the owner
 * types back their last characters; the owner may enter their own; a change after a copy exists starts a new Drive folder
 * (a fresh full upload), after the owner confirms that, and the old folder is kept until deleted. Also the settings, the
 * requests the dashboard writes for the runner, and the Overview's staleness warning.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OFFSITE_SCOPE } from '../../src/secrets/store.js';
import { startAdminStack, type AdminStack } from '../admin/helpers.js';
import { CLIENT_ID, CLIENT_SECRET, MockGoogle } from './mock-google.js';

let google: MockGoogle;
let stack: AdminStack;
beforeEach(async () => {
  google = new MockGoogle();
  await google.start();
  stack = await startAdminStack({ googleOAuth: { endpoints: google.endpoints } });
  await reauth();
});
afterEach(async () => {
  await stack.close();
  await google.stop();
});

const reauth = () => stack.post('/api/admin/security/reauth', { password: stack.bridge.password });
const api = {
  get: (p: string) => stack.get(`/api/admin${p}`),
  post: (p: string, b?: unknown) => stack.post(`/api/admin${p}`, b ?? {}),
  put: (p: string, b?: unknown) => stack.put(`/api/admin${p}`, b ?? {}),
};
const svc = () => stack.runtime.offsite;

async function generateAndConfirm(ack?: boolean) {
  const g = await api.post('/offsite/keys/generate');
  expect(g.status).toBe(200);
  return api.post('/offsite/keys/confirm', {
    confirmId: g.json.confirmId,
    passwordEnd: g.json.password.slice(-6),
    saltEnd: g.json.salt.slice(-6),
    ...(ack !== undefined ? { acknowledgeNewFolder: ack } : {}),
  });
}

describe('generated keys', () => {
  it('are strong, shown once, and not saved until the owner types back their last characters', async () => {
    const g = await api.post('/offsite/keys/generate');
    expect(g.json.shownOnce).toBe(true);
    expect(g.json.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.json.salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.json.password).not.toBe(g.json.salt);
    expect(g.json.confirmChars).toBe(6);
    expect(stack.runtime.secrets.has(OFFSITE_SCOPE, 'drive_crypt_password')).toBe(false);
    expect((await api.get('/offsite')).json.keys.set).toBe(false);
    // A wrong ending is refused, and nothing is saved.
    const bad = await api.post('/offsite/keys/confirm', {
      confirmId: g.json.confirmId,
      passwordEnd: 'xxxxxx',
      saltEnd: g.json.salt.slice(-6),
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('OFFSITE_CONFIRM_MISMATCH');
    expect(stack.runtime.secrets.has(OFFSITE_SCOPE, 'drive_crypt_password')).toBe(false);
    const ok = await api.post('/offsite/keys/confirm', {
      confirmId: g.json.confirmId,
      passwordEnd: g.json.password.slice(-6),
      saltEnd: g.json.salt.slice(-6),
    });
    expect(ok.status).toBe(200);
    const pw = stack.runtime.secrets.read(OFFSITE_SCOPE, 'drive_crypt_password');
    expect(pw.ok && pw.value).toBe(g.json.password);
    const s = await api.get('/offsite');
    expect(s.json.keys).toMatchObject({ set: true, source: 'generated' });
    expect(s.json.keys.setAt).toBeGreaterThan(0);
    // The page never shows them again.
    expect(s.text).not.toContain(g.json.password);
    expect(s.text).not.toContain(g.json.salt);
    // A confirmation works once.
    const again = await api.post('/offsite/keys/confirm', {
      confirmId: g.json.confirmId,
      passwordEnd: g.json.password.slice(-6),
      saltEnd: g.json.salt.slice(-6),
    });
    expect(again.json.error.code).toBe('OFFSITE_CONFIRM_EXPIRED');
    expect(stack.audit('offsite.keys_set')).toHaveLength(1);
    expect(JSON.stringify(stack.audit())).not.toContain(g.json.password);
  });

  it('are bound to the session that generated them', async () => {
    const g = await api.post('/offsite/keys/generate');
    const other = stack.services.owner.createSession('127.0.0.1', 'other');
    const cookie = `${stack.services.owner.sessionCookie}=${other}`;
    const csrf = stack.services.owner.csrfToken(other, 'admin');
    await stack.post('/api/admin/security/reauth', { password: stack.bridge.password }, { cookie, csrf });
    const r = await stack.post(
      '/api/admin/offsite/keys/confirm',
      { confirmId: g.json.confirmId, passwordEnd: g.json.password.slice(-6), saltEnd: g.json.salt.slice(-6) },
      { cookie, csrf },
    );
    expect(r.json.error.code).toBe('OFFSITE_CONFIRM_EXPIRED');
  });
});

describe('own keys and changing keys', () => {
  it('takes the owner’s own keys (long enough, different)', async () => {
    expect((await api.put('/offsite/keys', { password: 'short', salt: 'alsoshort' })).json.error.code).toBe(
      'OFFSITE_BAD_KEYS',
    );
    expect(
      (await api.put('/offsite/keys', { password: 'x'.repeat(20), salt: 'x'.repeat(20) })).json.error.code,
    ).toBe('OFFSITE_BAD_KEYS');
    const r = await api.put('/offsite/keys', {
      password: 'my own password 1234',
      salt: 'my own salt 98765432',
    });
    expect(r.status).toBe(200);
    expect((await api.get('/offsite')).json.keys.source).toBe('entered');
  });

  it('before any copy, new keys simply replace the old ones in the same folder', async () => {
    await generateAndConfirm();
    const r = await generateAndConfirm();
    expect(r.status).toBe(200);
    expect(r.json.newFolder).toBeNull();
    expect((await api.get('/offsite')).json.folder.path).toBe('LK-Bridge backups/lk.example.test/copy-1');
  });

  it('after a copy exists: says so first, then starts a new folder; the old one is kept until deleted', async () => {
    await generateAndConfirm();
    svc()!.store.markCopied(1, true);
    const g = await api.post('/offsite/keys/generate');
    expect(g.json.newFolder).toBe(true); // the page warns before the owner confirms
    const refused = await api.post('/offsite/keys/confirm', {
      confirmId: g.json.confirmId,
      passwordEnd: g.json.password.slice(-6),
      saltEnd: g.json.salt.slice(-6),
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('OFFSITE_NEW_FOLDER_UNCONFIRMED');
    expect(refused.json.error.message).toMatch(/fresh full upload into a new Drive folder/);
    const ok = await api.post('/offsite/keys/confirm', {
      confirmId: g.json.confirmId,
      passwordEnd: g.json.password.slice(-6),
      saltEnd: g.json.salt.slice(-6),
      acknowledgeNewFolder: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.newFolder.path).toBe('LK-Bridge backups/lk.example.test/copy-2');
    const s = await api.get('/offsite');
    expect(s.json.folder.generation).toBe(2);
    const old = s.json.folders.find((f: { generation: number }) => f.generation === 1);
    expect(old.retiredReason).toBe('the encryption keys changed');
    expect(old.deletedAt).toBeNull();
    // Deleting the old folder is the owner's choice: a request for the runner (re-authenticated).
    const del = await api.post('/offsite/folders/1/delete', { confirm: true });
    expect(del.status).toBe(200);
    const reqs = readdirSync(svc()!.o.requestDir);
    expect(reqs.some((n) => n.startsWith('delete_folder-'))).toBe(true);
    // The current folder cannot be deleted.
    expect((await api.post('/offsite/folders/2/delete', { confirm: true })).status).toBe(409);
  });

  it('changing the folder after a copy exists also starts a new one, after confirmation', async () => {
    await generateAndConfirm();
    svc()!.store.markCopied(1, true);
    const r = await api.put('/offsite/settings', { settings: { folder: 'Backups/elsewhere' } });
    expect(r.json.error.code).toBe('OFFSITE_NEW_FOLDER_UNCONFIRMED');
    const ok = await api.put('/offsite/settings', {
      settings: { folder: 'Backups/elsewhere' },
      acknowledgeNewFolder: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.newFolder.path).toBe('Backups/elsewhere/copy-2');
    expect((await api.put('/offsite/settings', { settings: { folder: '../escape' } })).status).toBe(400);
    expect((await api.put('/offsite/settings', { settings: { bandwidthLimit: '08:00,512k' } })).status).toBe(
      400,
    );
  });
});

describe('settings, requests and the Overview', () => {
  it('keeps the schedule and limits; the runner reads them from the database', async () => {
    const r = await api.put('/offsite/settings', {
      settings: {
        copyTime: '03:10',
        deletedRetentionDays: 45,
        bandwidthLimit: '1M',
        transfers: 2,
        staleAfterDays: 3,
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.settings).toMatchObject({
      copyTime: '03:10',
      deletedRetentionDays: 45,
      bandwidthLimit: '1M',
      transfers: 2,
    });
    const row = stack.db.prepare('SELECT settings_json FROM offsite_state WHERE id = 1').get() as {
      settings_json: string;
    };
    expect(JSON.parse(row.settings_json)).toMatchObject({ copyTime: '03:10' });
    expect((await api.get('/offsite')).json.settings.folder).toBe('LK-Bridge backups/lk.example.test');
  });

  it('"Copy now" and "Verify now" leave requests for the runner, only once the copy is set up', async () => {
    const early = await api.post('/offsite/copy', { confirm: true });
    expect(early.status).toBe(409);
    await api.put('/offsite/client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const start = await api.post('/offsite/connect');
    const { code, state } = google.approve(start.json.url);
    await stack.get(`/admin/drive/callback?state=${state}&code=${code}`);
    await generateAndConfirm();
    expect((await api.post('/offsite/copy', { confirm: true })).status).toBe(200);
    expect((await api.post('/offsite/verify', { confirm: true })).status).toBe(200);
    const s = await api.get('/offsite');
    expect(s.json.pending.map((p: { kind: string }) => p.kind)).toEqual(['copy', 'verify']);
    for (const n of readdirSync(svc()!.o.requestDir)) {
      const text = readFileSync(`${svc()!.o.requestDir}/${n}`, 'utf8');
      expect(text).not.toMatch(/token|secret|password/i);
    }
  });

  it('the Overview: not set up, then red when no good copy is younger than the setting', async () => {
    let o = await api.get('/overview');
    expect(o.json.offsite.state).toBe('not_set_up');
    await api.put('/offsite/client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const start = await api.post('/offsite/connect');
    const { code, state } = google.approve(start.json.url);
    await stack.get(`/admin/drive/callback?state=${state}&code=${code}`);
    await generateAndConfirm();
    svc()!.store.markCopied(1, true);
    o = await api.get('/overview');
    expect(o.json.offsite.state).toBe('ok');
    stack.db.prepare('UPDATE offsite_folders SET last_good_copy_at = ?').run(Date.now() - 3 * 86_400_000);
    o = await api.get('/overview');
    expect(o.json.offsite.state).toBe('bad');
    expect(o.json.offsite.messages.join(' ')).toMatch(/last good copy is \d+ hours old \(more than 2 days\)/);
    // A failed verify is red too.
    const id = svc()!.store.startRun({ kind: 'verify', trigger: 'schedule' });
    svc()!.store.finishRun(id, { state: 'failed', message: '1 problem(s) (1 missing)' });
    stack.db.prepare('UPDATE offsite_folders SET last_good_copy_at = ?').run(Date.now());
    o = await api.get('/overview');
    expect(o.json.offsite.messages.join(' ')).toMatch(/last verify found problems/);
  });
});
