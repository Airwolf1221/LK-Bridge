/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- parsed JSON replies in tests */
/**
 * v3 F2 (ADR 0049 decision 3): "Make default" on the Projects page. The default is stored in the database (re-
 * authentication, audited), applies at once without a restart, and LK_DEFAULT_PROJECT only overrides it while it is set
 * (the page says so); env-sync's --retire-default-project (test/unit/env-sync.test.ts) removes the line once the stored
 * default agrees.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { runProjectsCommand } from '../../src/projects/cli.js';
import { ProjectStore } from '../../src/projects/store.js';
import { startManaged, type Managed } from './helpers.js';

const projects = async (m: Managed) => (await m.admin.get('/projects')).json;

describe('Make default while the env file names another default', () => {
  let m: Managed;
  beforeAll(async () => {
    m = await startManaged({ lk: [{ name: 'alpha' }, { name: 'gamma' }], envProjects: ['alpha', 'gamma'] });
  });
  afterAll(() => m?.close());

  it('needs no fresh code (ADR 0081), but a confirmation', async () => {
    const r = await m.admin.post('/projects/gamma/default', {});
    expect(r.status).toBe(400);
    expect(r.json.error.code).not.toBe('REAUTH_REQUIRED');
    expect((await projects(m)).storedDefault).toBe('alpha');
  });

  it('stores the default, audited; the env file still overrides it, and the page says so', async () => {
    expect((await m.reauth()).status).toBe(200);
    const r = await m.admin.post('/projects/gamma/default', { confirm: true });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ storedDefault: 'gamma', envOverride: 'alpha', default: 'alpha' });
    const p = await projects(m);
    expect(p).toMatchObject({ default: 'alpha', storedDefault: 'gamma', envOverride: 'alpha' });
    expect(p.overrideNote).toBe(
      'The env file’s LK_DEFAULT_PROJECT=alpha overrides this; remove that line to use the dashboard’s choice.',
    );
    expect(m.stack.audit('project.make_default')[0]).toMatchObject({ target: 'gamma' });
  });

  it('refuses a project that is not there', async () => {
    const r = await m.admin.post('/projects/nosuch/default', { confirm: true });
    expect(r.status).toBe(404);
  });
});

describe('Make default with no LK_DEFAULT_PROJECT (retired): no restart, no override note', () => {
  let m: Managed;
  beforeAll(async () => {
    m = await startManaged({
      lk: [{ name: 'alpha' }, { name: 'gamma' }],
      envProjects: ['alpha', 'gamma'],
      env: { LK_DEFAULT_PROJECT: '' },
    });
  });
  afterAll(() => m?.close());

  it('the first start stores the effective default; Make default moves it at once', async () => {
    let p = await projects(m);
    expect(p).toMatchObject({ default: 'alpha', storedDefault: 'alpha', envOverride: null });
    expect(p.overrideNote).toBeUndefined();
    expect((await m.reauth()).status).toBe(200);
    const r = await m.admin.post('/projects/gamma/default', { confirm: true });
    expect(r.status, r.text).toBe(200);
    p = await projects(m);
    expect(p).toMatchObject({ default: 'gamma', storedDefault: 'gamma', envOverride: null });
    expect(p.projects.find((x: any) => x.name === 'gamma').isDefault).toBe(true);
    expect(p.projects.find((x: any) => x.name === 'alpha').isDefault).toBe(false);
    expect(p.overrideNote).toBeUndefined();
  });
});

describe('npm run projects -- stored-default (for env-sync)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-default-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints the stored default, or nothing', () => {
    const file = join(dir, 'bridge.db');
    const db = openDatabase(file);
    runMigrations(db, defaultMigrationsDir());
    const store = new ProjectStore(db);
    store.insert({ id: 'lkp_a', name: 'alpha', displayName: null, verifiedAt: 1 });
    store.insert({ id: 'lkp_g', name: 'gamma', displayName: null, verifiedAt: 1 });
    const lines: string[] = [];
    runProjectsCommand(['stored-default'], file, (s) => lines.push(s));
    store.setDefault('gamma');
    runProjectsCommand(['stored-default'], file, (s) => lines.push(s));
    db.close();
    expect(lines).toEqual(['stored-default=', 'stored-default=gamma']);
  });
});
