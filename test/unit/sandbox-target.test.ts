/**
 * v2 A1: the sandbox settings are retired. The sandbox, soak and spike scripts take `--project <name>` and refuse any
 * project that is not registered in the bridge's database AND marked as a sandbox there, before any request is made
 * (test/sandbox/target.ts). Checked here directly, and by running the two scripts against a project that is not a
 * sandbox: they must refuse (exit code 2) without contacting LegendKeeper.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ProjectStore } from '../../src/projects/index.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { projectFlag, resolveSandboxTarget } from '../sandbox/target.js';

let dir: string;
let dbPath: string;
const KEY = 'test-key-SECRET-0000';
const REAL = 'arkona-key-SECRET-1111';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-target-'));
  dbPath = join(dir, 'bridge.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const store = new ProjectStore(db);
  store.insert({ id: 'lkp_test', name: 'test', displayName: 'Test world', verifiedAt: 1 });
  store.insert({ id: 'lkp_arkona', name: 'arkona', displayName: 'Arkona', verifiedAt: 1 });
  store.setSandbox('lkp_test', true);
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const multi = { LK_PROJECTS: 'arkona,test', LK_PROJECT_TEST_API_KEY: KEY, LK_PROJECT_ARKONA_API_KEY: REAL };

describe('resolveSandboxTarget', () => {
  it('accepts a registered sandbox project with its own key', () => {
    expect(resolveSandboxTarget('test', multi, dbPath)).toEqual({
      name: 'test',
      projectId: 'lkp_test',
      apiKey: KEY,
      keyVariable: 'LK_PROJECT_TEST_API_KEY',
    });
    // The single-project form: LK_API_KEY for the project LK_PROJECT_NAME names (default test).
    expect(resolveSandboxTarget('TEST', { LK_API_KEY: KEY }, dbPath)).toMatchObject({
      projectId: 'lkp_test',
      keyVariable: 'LK_API_KEY',
    });
  });

  it('refuses a project that is not marked as a sandbox, an unknown one, and a missing name', () => {
    expect(() => resolveSandboxTarget('arkona', multi, dbPath)).toThrow(SandboxGuardError);
    expect(() => resolveSandboxTarget('arkona', multi, dbPath)).toThrow(/not marked as a sandbox/);
    expect(() => resolveSandboxTarget('nowhere', multi, dbPath)).toThrow(/not registered/);
    expect(() => resolveSandboxTarget(undefined, multi, dbPath)).toThrow(/--project/);
    expect(() => resolveSandboxTarget('Bad Name', multi, dbPath)).toThrow(/not a project name/);
  });

  it('refuses without the bridge database or without the project’s key, and never prints a key', () => {
    expect(() => resolveSandboxTarget('test', multi, join(dir, 'missing.db'))).toThrow(/no bridge database/);
    let message = '';
    try {
      resolveSandboxTarget('test', { LK_PROJECTS: 'test', LK_PROJECT_ARKONA_API_KEY: REAL }, dbPath);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/LK_PROJECT_TEST_API_KEY is empty/);
    expect(message).not.toContain(REAL);
  });

  it('reads --project NAME and --project=NAME', () => {
    expect(projectFlag(['--writes', '10', '--project', 'test'])).toBe('test');
    expect(projectFlag(['--project=arkona'])).toBe('arkona');
    expect(projectFlag(['--writes', '10'])).toBeUndefined();
  });
});

describe('the scripts refuse a project that is not a sandbox (no request is made)', () => {
  const tsx = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;
  const run = (script: string, args: string[]) =>
    spawnSync(tsx, [new URL(`../../scripts/${script}`, import.meta.url).pathname, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        DB_PATH: dbPath,
        ...multi,
        // Anything that did reach the network would fail here: nothing may get that far.
        LK_BASE_URL: 'http://127.0.0.1:9',
      },
      timeout: 60_000,
    });

  it('soak:sandbox --project arkona', () => {
    const r = run('soak-sandbox.ts', ['--project', 'arkona', '--writes', '8']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not marked as a sandbox/);
    expect(`${r.stdout}${r.stderr}`).not.toContain(REAL);
  }, 60_000);

  it('spike:v2 --project arkona', () => {
    const r = run('spike-v2.ts', ['--project', 'arkona', '--out-dir', join(dir, 'spike')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not marked as a sandbox/);
    expect(`${r.stdout}${r.stderr}`).not.toContain(REAL);
  }, 60_000);

  it('soak:sandbox without --project', () => {
    const r = run('soak-sandbox.ts', ['--writes', '8']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--project/);
  }, 60_000);
});
