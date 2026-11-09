/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool and dashboard results */
/**
 * v2 A1 start-up checks: every key must authenticate and its project id must match the stored one. A wrong key or a
 * mismatched id stops THAT project only (shown on the Overview, logged, never with a key), and the others carry on.
 * Also: the single-project env form (LK_API_KEY, LK_PROJECT_ID) still boots and works, and a second bridge process is
 * refused for a database another live process serves.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { InstanceGuard, InstanceLockError, ProjectStore } from '../../src/projects/index.js';
import { IDS, KEYS, startTwoProjects, type TwoProjects } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-projects-'));
  dirs.push(dir);
  return join(dir, 'bridge.db');
}
const WRONG_KEY = 'mock-key-wrong-not-real';
const logText = (t: TwoProjects) => t.stack.logs.join('');

describe('a key LegendKeeper refuses stops that project only', () => {
  it('beta is stopped with the reason (never the key); alpha is served; the Overview shows it', async () => {
    const t = await startTwoProjects({
      env: { LK_PROJECT_BETA_API_KEY: WRONG_KEY },
      stack: { captureLogs: true, projectRetryMs: { first: 60_000, max: 60_000 } },
    });
    try {
      const beta = t.stack.runtime.projects.find('beta')!;
      expect(beta.status).toBe('stopped');
      expect(beta.keyValid).toBe(false);
      expect(beta.reason).toMatch(/LK_PROJECT_BETA_API_KEY/);
      expect(t.stack.runtime.projects.find('alpha')!.status).toBe('active');

      const { client } = await t.connect('startup', 'write');
      const ok = await t.call(client, 'lk_api_write', {
        operationId: 'createResource',
        params: { body: { name: 'still works' } },
        project: 'alpha',
      });
      expect(ok.body.status, ok.text).toBe('succeeded');
      const refused = await t.call(client, 'lk_api_write', {
        operationId: 'createResource',
        params: { body: { name: 'nope' } },
        project: 'beta',
      });
      expect(refused.body.error, refused.text).toMatchObject({
        code: 'PROJECT_UNAVAILABLE',
        project: 'beta',
      });
      expect(t.models.beta.resources.size).toBe(2); // only the seeded ones

      const list = await t.call(client, 'list_projects');
      expect(list.body.projects.find((p: { name: string }) => p.name === 'beta')).toMatchObject({
        available: false,
        id: null,
      });

      // The Overview lists every project's status, and shows the stopped one with its reason.
      const overview = await t.admin.get('/overview');
      expect(overview.status, overview.text).toBe(200);
      expect(overview.json.projects.find((p: { name: string }) => p.name === 'beta')).toMatchObject({
        status: 'stopped',
      });
      const betaView = await t.admin.get('/overview?project=beta');
      expect(betaView.status, betaView.text).toBe(200);
      expect(betaView.json.health.note).toMatch(/LK_PROJECT_BETA_API_KEY/);
      const page = await t.admin.get('/projects');
      expect(page.json.projects.find((p: { name: string }) => p.name === 'beta')).toMatchObject({
        keyPresent: true,
        keyValid: false,
        status: 'stopped',
      });

      // Logged, by variable name only: no key ever appears in the logs or the dashboard.
      expect(logText(t)).toMatch(/beta/);
      for (const key of [KEYS.alpha, KEYS.beta, WRONG_KEY]) {
        expect(logText(t)).not.toContain(key);
        expect(overview.text + betaView.text + page.text).not.toContain(key);
      }
    } finally {
      await t.close();
    }
  });
});

describe('a key that now belongs to another project stops that project only', () => {
  it('beta was stored as lkp_beta; its key now answers for lkp_other: beta stops, its data is untouched', async () => {
    const dbPath = tempDb();
    const db = openDatabase(dbPath);
    runMigrations(db);
    new ProjectStore(db, Date.now).insert({ id: IDS.beta, name: 'beta', displayName: 'Beta', verifiedAt: 1 });
    db.close();

    const t = await startTwoProjects({
      reportedIds: { beta: 'lkp_other' },
      stack: { dbPath, captureLogs: true, projectRetryMs: { first: 60_000, max: 60_000 } },
    });
    try {
      const beta = t.stack.runtime.projects.find('beta')!;
      expect(beta.status).toBe('stopped');
      expect(beta.id).toBe(IDS.beta);
      expect(beta.reason).toMatch(/lkp_other/);
      expect(beta.reason).toMatch(/lkp_beta/);
      expect(t.stack.runtime.projects.find('alpha')!.status).toBe('active');
      // Nothing was stored for the other project, and beta's row kept its id.
      expect(t.stack.db.prepare('SELECT id FROM projects ORDER BY name').all()).toEqual([
        { id: IDS.alpha },
        { id: IDS.beta },
      ]);
      const { client } = await t.connect('mismatch', 'write');
      const r = await t.call(client, 'lk_api_read', { operationId: 'listResources', project: 'beta' });
      expect(r.body.error, r.text).toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
      const a = await t.call(client, 'lk_api_read', { operationId: 'listResources', project: 'alpha' });
      expect(a.isError, a.text).toBe(false);
      // Nothing but the start-up check reached beta's key.
      expect(
        t.mocks.beta.calls.every((c) => c.method === 'GET' && /^\/api\/v3\/projects\/?$/.test(c.path)),
      ).toBe(true);
      expect(logText(t)).toMatch(/lkp_other/);
      expect(logText(t)).not.toContain(KEYS.beta);
    } finally {
      await t.close();
    }
  });
});

describe('the single-project env form (backwards compatible)', () => {
  const single = (extra: Record<string, string> = {}) => ({
    LK_PROJECTS: '',
    LK_PROJECT_ALPHA_API_KEY: '',
    LK_PROJECT_BETA_API_KEY: '',
    LK_DEFAULT_PROJECT: '',
    LK_API_KEY: KEYS.alpha,
    LK_PROJECT_ID: IDS.alpha,
    ...extra,
  });

  it('boots as one project named "test" with a start-up warning, and works without `project`', async () => {
    const t = await startTwoProjects({ env: single(), stack: { captureLogs: true } });
    try {
      const config = t.stack.runtime.config;
      expect(config.lk.singleProjectForm).toBe(true);
      expect(config.lk.projects.map((p) => p.name)).toEqual(['test']);
      expect(config.warnings.join('\n')).toMatch(/single-project form/);
      expect(logText(t)).toMatch(/single-project form/);
      expect(logText(t)).not.toContain(KEYS.alpha);

      const { client } = await t.connect('compat', 'write');
      const list = await t.call(client, 'list_projects');
      expect(list.body).toMatchObject({ count: 1, default: 'test', writesNeedProject: false });
      expect(list.body.projects[0]).toMatchObject({ name: 'test', id: IDS.alpha, available: true });
      const w = await t.call(client, 'lk_api_write', {
        operationId: 'createResource',
        params: { body: { name: 'compat write' } },
      });
      expect(w.body.status, w.text).toBe('succeeded');
      expect(w.body.project).toBe('test');
      expect(w.footer).toMatch(/^budget \(test\): /);
      expect([...t.models.alpha.resources.values()].map((r) => r.name)).toContain('compat write');
      const r = await t.call(client, 'lk_api_read', { operationId: 'listResources' });
      expect(r.isError, r.text).toBe(false);
      expect((await t.admin.get('/projects')).json).toMatchObject({
        singleProjectForm: true,
        default: 'test',
      });
    } finally {
      await t.close();
    }
  });

  it('LK_PROJECT_NAME names the one project', async () => {
    const t = await startTwoProjects({ env: single({ LK_PROJECT_NAME: 'Campaign' }) });
    try {
      expect(t.stack.runtime.projects.list().map((p) => [p.name, p.id, p.status])).toEqual([
        ['campaign', IDS.alpha, 'active'],
      ]);
    } finally {
      await t.close();
    }
  });

  it('a key that does not belong to LK_PROJECT_ID stops the project, naming both ids', async () => {
    const t = await startTwoProjects({
      env: single({ LK_PROJECT_ID: 'lkp_wrong' }),
      stack: { projectRetryMs: { first: 60_000, max: 60_000 } },
    });
    try {
      const p = t.stack.runtime.projects.find('test')!;
      expect(p.status).toBe('stopped');
      expect(p.reason).toMatch(/lkp_alpha/);
      expect(p.reason).toMatch(/lkp_wrong/);
      expect(p.reason).toMatch(/LK_PROJECT_ID/);
      expect(t.stack.db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
    } finally {
      await t.close();
    }
  });
});

describe('one bridge process per database', () => {
  it('a second process is refused while the first is alive; the same process may take over its own row', async () => {
    const dbPath = tempDb();
    const db = openDatabase(dbPath);
    runMigrations(db);
    // Another live process on this host (pid 1 always exists) holds the database, with a fresh heartbeat.
    db.prepare(
      `INSERT INTO bridge_instance (slot, instance_id, pid, hostname, started_at, heartbeat_at)
       VALUES (1, 'other', 1, ?, ?, ?)`,
    ).run(hostname(), Date.now(), Date.now());
    db.close();
    await expect(startTwoProjects({ stack: { dbPath } })).rejects.toThrow(InstanceLockError);
    await expect(startTwoProjects({ stack: { dbPath } })).rejects.toThrow(/pid 1 .*ADR 0023/);
  });

  it('the guard: refuses a live holder, takes over a dead or silent one, and releases on shutdown', () => {
    const db = openDatabase(tempDb());
    runMigrations(db);
    let now = 1_000_000;
    const guard = (pid: number, host = 'here', alive = true) =>
      new InstanceGuard({ db, now: () => now, pid, hostname: host, isAlive: () => alive, heartbeatMs: 1e9 });
    const first = guard(100);
    expect(first.acquire().tookOver).toBeNull();
    // Same host, live pid, fresh heartbeat: refused.
    expect(() => guard(200).acquire()).toThrow(InstanceLockError);
    // Another host with a fresh heartbeat: refused too.
    expect(() => guard(300, 'elsewhere').acquire()).toThrow(InstanceLockError);
    // Same host, the holder's pid is gone (a crash, then systemd's restart): taken over at once.
    const after = guard(400, 'here', false);
    expect(after.acquire().tookOver).toMatchObject({ pid: 100 });
    // A holder on another host that stopped beating for a minute is taken over.
    now += 61_000;
    const remote = guard(500, 'elsewhere');
    expect(remote.acquire().tookOver).toMatchObject({ pid: 400 });
    // A clean shutdown frees the database.
    remote.release();
    expect(db.prepare('SELECT COUNT(*) AS n FROM bridge_instance').get()).toEqual({ n: 0 });
    expect(guard(600).acquire().tookOver).toBeNull();
    db.close();
  });
});
