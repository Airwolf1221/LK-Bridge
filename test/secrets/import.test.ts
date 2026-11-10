/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies in tests */
/**
 * OPS2: the first start after this release, and every start after. Keys and the owner's credentials found in the env
 * file are imported into the encrypted store once (logged and audited by name only); after that the stored value wins
 * over the env file, with a warning on the dashboard. A missing or wrong master key is a clear error for the affected
 * secrets only: the bridge starts, the other projects are served, and the dashboard (or the sign-in page) says what is
 * wrong. And the helper env-sync uses to retire imported env lines (compare), against a real database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { throwawaySecret } from '../auth/helpers.js';
import { Browser } from '../auth/helpers.js';
import { openDatabase } from '../../src/db/open.js';
import { compareEnvWithStore } from '../../src/secrets/env-tool.js';
import { addProject, startManaged, testKey, type Managed } from './helpers.js';

const dirs: string[] = [];
let running: Managed[] = [];
afterEach(async () => {
  for (const m of running.splice(0)) await m.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'lkb-ops2-import-'));
  dirs.push(d);
  return join(d, 'bridge.db');
}

async function boot(o: {
  path: string;
  master: string;
  keys: Record<string, string>;
  extraKeys?: Record<string, string[]>;
  env?: Record<string, string>;
  envProjects?: string[];
  captureLogs?: boolean;
}): Promise<Managed> {
  const m = await startManaged({
    lk: [{ name: 'alpha' }, { name: 'beta' }],
    envProjects: o.envProjects ?? ['alpha', 'beta'],
    keys: o.keys,
    ...(o.extraKeys ? { extraKeys: o.extraKeys } : {}),
    env: { SECRETS_MASTER_KEY: o.master, ...o.env },
    stack: { dbPath: o.path, captureLogs: o.captureLogs ?? false },
  });
  running.push(m);
  return m;
}

async function stop(m: Managed): Promise<void> {
  running = running.filter((x) => x !== m);
  await m.close();
}

const projects = async (m: Managed) => (await m.admin.get('/projects')).json.projects as any[];

describe('the first start imports the env file into the store, once', () => {
  it('imports each key (by name only), serves from the store, and does not import again', async () => {
    const path = dbPath();
    const master = throwawaySecret();
    const keys = { alpha: testKey('alpha'), beta: testKey('beta') };
    const m = await boot({ path, master, keys, captureLogs: true });
    const rows = m.stack.db.prepare('SELECT scope, purpose, source, hint FROM secrets ORDER BY scope').all();
    expect(rows).toEqual([
      { scope: '*', purpose: 'owner_password_hash', source: 'env_import', hint: null },
      { scope: 'lkp_alpha', purpose: 'lk_api_key', source: 'env_import', hint: keys.alpha.slice(-4) },
      { scope: 'lkp_beta', purpose: 'lk_api_key', source: 'env_import', hint: keys.beta.slice(-4) },
    ]);
    const imports = m.stack.db.prepare('SELECT variable FROM secret_imports ORDER BY variable').all();
    expect(imports).toEqual([
      { variable: 'LK_PROJECT_ALPHA_API_KEY' },
      { variable: 'LK_PROJECT_BETA_API_KEY' },
      { variable: 'OWNER_PASSWORD_HASH' },
    ]);
    const logs = m.stack.logs.join('');
    expect(logs).toMatch(/"variable":"LK_PROJECT_ALPHA_API_KEY".*imported from the env file/);
    for (const k of Object.values(keys)) expect(logs).not.toContain(k);
    expect(
      m.stack
        .audit('project.key_import')
        .map((a) => a.target)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    expect(m.stack.audit('owner.credential_import').map((a) => a.target)).toEqual(['OWNER_PASSWORD_HASH']);
    expect((await projects(m)).map((p) => [p.name, p.status, p.keySource])).toEqual([
      ['alpha', 'active', 'store'],
      ['beta', 'active', 'store'],
    ]);
    await stop(m);

    // Second start, same env file: nothing imported again, nothing audited again.
    const again = await boot({ path, master, keys });
    expect(again.stack.audit('project.key_import')).toHaveLength(2);
    expect(again.stack.db.prepare('SELECT COUNT(*) AS n FROM secret_imports').get()).toEqual({ n: 3 });
  });

  it('when the env key and the stored key differ, the stored key wins, with a warning on the dashboard', async () => {
    const path = dbPath();
    const master = throwawaySecret();
    const keys = { alpha: testKey('alpha'), beta: testKey('beta') };
    const first = await boot({ path, master, keys });
    // The owner replaces alpha's key on the dashboard...
    const fresh = first.addKey('alpha');
    expect((await first.reauth()).status).toBe(200);
    const check = await first.admin.post('/projects/alpha/key/check', { apiKey: fresh });
    expect(
      (await first.admin.post('/projects/confirm', { checkId: check.json.checkId, confirm: true })).status,
    ).toBe(200);
    expect((await projects(first)).find((p) => p.name === 'alpha').keyConflict).toMatch(
      /LK_PROJECT_ALPHA_API_KEY in the env file still holds the old key/,
    );
    await stop(first);
    // ...and the env file still holds the old one at the next start.
    const m = await boot({ path, master, keys, extraKeys: { alpha: [fresh] } });
    const alpha = (await projects(m)).find((p) => p.name === 'alpha');
    expect(alpha.keyConflict).toMatch(
      /LK_PROJECT_ALPHA_API_KEY in the env file is not the key in use: the key stored on the dashboard wins/,
    );
    expect(alpha.keyHint).toBe(fresh.slice(-4));
    const o = (await m.admin.get('/overview')).json;
    expect(o.security.warnings.join('\n')).toMatch(
      /alpha: LK_PROJECT_ALPHA_API_KEY in the env file is not the key in use/,
    );
    expect(JSON.stringify(o)).not.toContain(fresh);
    expect(JSON.stringify(o)).not.toContain(keys.alpha);
  });

  it('a project added on the dashboard is served from the store after a restart, with nothing in the env file', async () => {
    const path = dbPath();
    const master = throwawaySecret();
    const keys = { alpha: testKey('alpha'), beta: testKey('beta') };
    const first = await boot({ path, master, keys, envProjects: [] });
    expect((await addProject(first, 'beta', keys.beta)).confirm.status).toBe(200);
    await stop(first);
    const m = await boot({ path, master, keys, envProjects: [] });
    expect((await projects(m)).map((p) => [p.name, p.status, p.keySource, p.keyVariable])).toEqual([
      ['beta', 'active', 'store', null],
    ]);
    const client = await m.connect('reader', 'read');
    const read = await m.call(client, 'lk_api_read', {
      operationId: 'getResource',
      params: { path: { resourceId: 'beta_root' } },
    });
    expect(read.isError, read.text).toBe(false);
  });
});

describe('a missing or wrong master key', () => {
  it('missing: the env keys are used as before (nothing imported), keys cannot be managed, and the dashboard says why', async () => {
    const m = await boot({
      path: dbPath(),
      master: '',
      keys: { alpha: testKey('alpha'), beta: testKey('beta') },
    });
    expect(m.stack.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
    expect((await projects(m)).map((p) => [p.name, p.status, p.keySource])).toEqual([
      ['alpha', 'active', 'env'],
      ['beta', 'active', 'env'],
    ]);
    const o = (await m.admin.get('/overview')).json;
    expect(o.security.storeProblem).toMatch(/SECRETS_MASTER_KEY is not set/);
    expect(o.security.canManageKeys).toBe(false);
    expect((await m.reauth()).status).toBe(200); // the env password still works
    // The check itself needs no store, but nothing can be stored: confirming says why.
    const add = await m.admin.post('/projects/alpha/key/check', { apiKey: m.addKey('alpha') });
    expect(add.status, add.text).toBe(200);
    const c = await m.admin.post('/projects/confirm', { checkId: add.json.checkId, confirm: true });
    expect(c.status).toBe(503);
    expect(c.json.error.code).toBe('STORE_UNAVAILABLE');
    expect(c.json.error.message).toMatch(/SECRETS_MASTER_KEY is not set/);
    const pw = await m.admin.post('/security/password', {
      currentPassword: m.stack.bridge.password,
      newPassword: 'x'.repeat(20),
    });
    expect(pw.status).toBe(503);
    expect(pw.json.error.code).toBe('STORE_UNAVAILABLE');
  });

  it('wrong: the affected projects stop with the reason, sign-in refuses with a clear message, nothing crashes', async () => {
    const path = dbPath();
    const keys = { alpha: testKey('alpha'), beta: testKey('beta') };
    const first = await boot({ path, master: throwawaySecret(), keys });
    await stop(first);
    const m = await boot({ path, master: throwawaySecret(), keys });
    for (const p of await projects(m)) {
      expect(p.status).toBe('stopped');
      expect(p.reason).toMatch(
        /encrypted store, which cannot be read: it was sealed with another master key/,
      );
      expect(p.keySource).toBeNull();
    }
    // The env keys are NOT used instead: they may be old, revoked keys the dashboard replaced.
    expect(m.projects.alpha!.used).toEqual([]);
    const o = (await m.admin.get('/overview')).json;
    expect(o.security.storeProblem).toMatch(/sealed with another master key than SECRETS_MASTER_KEY/);
    // The owner's password was imported too, so sign-in fails closed, saying why (not "wrong password").
    const page = await new Browser(m.stack.bridge).login();
    expect(page.status).toBe(503);
    expect(await page.text()).toMatch(
      /Signing in is not possible right now\. The owner password is kept in the encrypted store, which cannot be read/,
    );
  });
});

describe('the env-sync helper against a real database (compare)', () => {
  it('equal, superseded, differs, not stored and unreadable, by name only', async () => {
    const path = dbPath();
    const master = throwawaySecret();
    const keys = { alpha: testKey('alpha'), beta: testKey('beta') };
    const m = await boot({ path, master, keys });
    const fresh = m.addKey('beta');
    expect((await m.reauth()).status).toBe(200);
    const check = await m.admin.post('/projects/beta/key/check', { apiKey: fresh });
    expect(
      (await m.admin.post('/projects/confirm', { checkId: check.json.checkId, confirm: true })).status,
    ).toBe(200);
    const db = openDatabase(path);
    const env = {
      SECRETS_MASTER_KEY: master,
      LK_PROJECT_ALPHA_API_KEY: keys.alpha,
      LK_PROJECT_BETA_API_KEY: keys.beta,
      LK_PROJECT_GAMMA_API_KEY: testKey('gamma'),
      OWNER_PASSWORD_HASH: 'something-else-entirely',
    };
    expect(compareEnvWithStore(db, env)).toEqual([
      { name: 'LK_PROJECT_ALPHA_API_KEY', verdict: 'equal' },
      { name: 'LK_PROJECT_BETA_API_KEY', verdict: 'superseded' },
      { name: 'LK_PROJECT_GAMMA_API_KEY', verdict: 'not_stored' },
      { name: 'OWNER_PASSWORD_HASH', verdict: 'differs' },
    ]);
    expect(compareEnvWithStore(db, { ...env, SECRETS_MASTER_KEY: throwawaySecret() })[0]).toEqual({
      name: 'LK_PROJECT_ALPHA_API_KEY',
      verdict: 'unreadable',
    });
    db.close();
  });
});
