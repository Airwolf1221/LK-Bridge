/**
 * v2 A1: the sandbox settings are retired. The sandbox, soak and spike scripts take `--project <name>` and refuse any
 * project that is not registered in the bridge's database AND marked as a sandbox there, before any request is made
 * (test/sandbox/target.ts). Checked here directly, and by running the two scripts against a project that is not a
 * sandbox: they must refuse (exit code 2) without contacting LegendKeeper.
 *
 * OPS2 hotfix: the key is found as the bridge finds it: the encrypted store first, the env file's key only when nothing
 * is stored, never the env file's key in place of a stored key that cannot be opened. With LKB_ENV_FILE set (the
 * wrappers), only the names it needs are read from that file. The wrappers end to end: test/unit/sandbox-wrappers.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ProjectStore } from '../../src/projects/index.js';
import { SecretStore, resolveProjectKey } from '../../src/secrets/index.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import {
  keyNames,
  keySourceLine,
  projectFlag,
  resolveReadOnlyTarget,
  resolveSandboxTarget,
} from '../sandbox/target.js';

let dir: string;
let dbPath: string;
const KEY = 'test-key-SECRET-0000';
const REAL = 'arkona-key-SECRET-1111';
const STORED = 'stored-test-key-SECRET-2222';
const MASTER = 'm'.repeat(44);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-target-'));
  dbPath = join(dir, 'bridge.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const store = new ProjectStore(db);
  store.insert({ id: 'lkp_test', name: 'test', displayName: 'Test world', verifiedAt: 1 });
  store.insert({ id: 'lkp_arkona', name: 'arkona', displayName: 'Arkona', verifiedAt: 1 });
  store.setSandbox('lkp_test', true);
  // A second sandbox project whose key the dashboard keeps in the encrypted store, and one removed on the dashboard.
  store.insert({ id: 'lkp_stored', name: 'stored', displayName: 'Stored', verifiedAt: 1 });
  store.setSandbox('lkp_stored', true);
  store.insert({ id: 'lkp_gone', name: 'gone', displayName: 'Gone', verifiedAt: 1 });
  store.setSandbox('lkp_gone', true);
  store.archive('lkp_gone');
  new SecretStore(db, { masterKey: MASTER }).write('lkp_stored', 'lk_api_key', STORED, {
    source: 'dashboard',
  });
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
      keySource: 'env',
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
    expect(message).toMatch(
      /has no key: none is stored in the bridge's encrypted store, and LK_PROJECT_TEST_API_KEY/,
    );
    expect(message).toMatch(/dashboard's Projects page/);
    expect(message).not.toContain(REAL);
  });

  it('uses the key in the encrypted store with no env key (keys retired), and over a different env key', () => {
    const t = resolveSandboxTarget('stored', { SECRETS_MASTER_KEY: MASTER }, dbPath);
    expect(t).toMatchObject({ projectId: 'lkp_stored', apiKey: STORED, keySource: 'store' });
    expect(keySourceLine(t)).toMatch(/encrypted store/);
    expect(keySourceLine(t)).not.toContain(STORED);
    const env = { SECRETS_MASTER_KEY: MASTER, LK_PROJECTS: 'stored', LK_PROJECT_STORED_API_KEY: KEY };
    expect(resolveSandboxTarget('stored', env, dbPath).apiKey).toBe(STORED);
  });

  it('refuses a stored key it cannot open, and never uses the env key instead', () => {
    for (const env of [
      { LK_PROJECT_STORED_API_KEY: KEY }, // no master key
      { SECRETS_MASTER_KEY: 'w'.repeat(44), LK_PROJECT_STORED_API_KEY: KEY }, // the wrong one
    ]) {
      let message = '';
      try {
        resolveSandboxTarget('stored', env, dbPath);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/cannot be read here/);
      expect(message).toMatch(/LK_PROJECT_STORED_API_KEY from the environment is not used instead/);
      for (const s of [KEY, STORED, MASTER]) expect(message).not.toContain(s);
    }
  });

  it('refuses a project removed on the dashboard', () => {
    expect(() => resolveSandboxTarget('gone', { LK_PROJECT_GONE_API_KEY: KEY }, dbPath)).toThrow(
      /removed on the dashboard/,
    );
  });

  it('with LKB_ENV_FILE, reads only the names it needs from that file, never the environment', () => {
    const file = join(dir, 'lk-bridge.env');
    writeFileSync(
      file,
      [
        `SECRETS_MASTER_KEY='${MASTER}'`,
        `# LK_PROJECT_STORED_API_KEY=${KEY}`,
        `LK_PROJECT_TEST_API_KEY="${KEY}"`,
        'OWNER_PASSWORD_HASH=$argon2id$not-read',
      ].join('\n'),
    );
    // The environment's own keys are ignored once the file is named.
    const env = { LKB_ENV_FILE: file, SECRETS_MASTER_KEY: 'w'.repeat(44), LK_PROJECT_TEST_API_KEY: REAL };
    expect(resolveSandboxTarget('stored', env, dbPath)).toMatchObject({ apiKey: STORED, keySource: 'store' });
    expect(resolveSandboxTarget('test', env, dbPath)).toMatchObject({ apiKey: KEY, keySource: 'env' });
    expect(keyNames('test')).toEqual([
      'LK_PROJECTS',
      'LK_PROJECT_NAME',
      'LK_API_KEY',
      'LK_PROJECT_TEST_API_KEY',
      'SECRETS_MASTER_KEY',
      'SECRETS_MASTER_KEY_PREVIOUS',
    ]);
    expect(() => resolveSandboxTarget('test', { LKB_ENV_FILE: join(dir, 'missing.env') }, dbPath)).toThrow(
      /Cannot read the env file .*missing\.env \(ENOENT\)/,
    );
  });

  it('reads --project NAME and --project=NAME', () => {
    expect(projectFlag(['--writes', '10', '--project', 'test'])).toBe('test');
    expect(projectFlag(['--project=arkona'])).toBe('arkona');
    expect(projectFlag(['--writes', '10'])).toBeUndefined();
  });
});

describe('resolveReadOnlyTarget (v2 E5 hotfix: the Markdown round trip only)', () => {
  it('accepts any registered project, sandbox or not, and says which', () => {
    expect(resolveReadOnlyTarget('arkona', multi, dbPath)).toEqual({
      name: 'arkona',
      projectId: 'lkp_arkona',
      apiKey: REAL,
      keySource: 'env',
      keyVariable: 'LK_PROJECT_ARKONA_API_KEY',
      isSandbox: false,
    });
    expect(resolveReadOnlyTarget('test', multi, dbPath)).toMatchObject({
      projectId: 'lkp_test',
      isSandbox: true,
    });
    expect(resolveReadOnlyTarget('stored', { SECRETS_MASTER_KEY: MASTER }, dbPath)).toMatchObject({
      apiKey: STORED,
      keySource: 'store',
      isSandbox: true,
    });
  });

  it('refuses exactly as resolveSandboxTarget does, but for the sandbox mark', () => {
    const message = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxGuardError);
        return (e as Error).message;
      }
      throw new Error('not refused');
    };
    const cases: [string | undefined, NodeJS.ProcessEnv, string][] = [
      ['nowhere', multi, dbPath],
      ['Bad Name', multi, dbPath],
      ['gone', { LK_PROJECT_GONE_API_KEY: KEY }, dbPath],
      ['test', multi, join(dir, 'missing.db')],
      ['test', { LK_PROJECTS: 'test', LK_PROJECT_ARKONA_API_KEY: REAL }, dbPath],
      ['stored', { LK_PROJECT_STORED_API_KEY: KEY }, dbPath],
      ['test', { LKB_ENV_FILE: join(dir, 'missing.env') }, dbPath],
    ];
    for (const [name, env, db] of cases) {
      const ro = message(() => resolveReadOnlyTarget(name, env, db));
      expect(ro).toBe(message(() => resolveSandboxTarget(name, env, db)));
      for (const secret of [KEY, REAL, STORED, MASTER]) expect(ro).not.toContain(secret);
    }
    // A missing name: the same refusal, without asking for a sandbox.
    expect(message(() => resolveReadOnlyTarget(undefined, multi, dbPath))).toMatch(/--project <name>/);
  });

  it('resolveSandboxTarget still refuses a project that is not a sandbox, and returns what it did before', () => {
    expect(() => resolveSandboxTarget('arkona', multi, dbPath)).toThrow(/not marked as a sandbox/);
    expect(Object.keys(resolveSandboxTarget('test', multi, dbPath)).sort()).toEqual([
      'apiKey',
      'keySource',
      'keyVariable',
      'name',
      'projectId',
    ]);
  });

  it('only scripts/markdown-roundtrip.ts uses it; the spike, the soak and every sandbox test keep the sandbox guard', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
    const users = (rel: string) => /\b(resolveReadOnlyTarget|createReadOnlyRuntime)\(/.test(read(rel));
    const scripts = readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.ts'));
    expect(scripts.filter((f) => users(`scripts/${f}`))).toEqual(['markdown-roundtrip.ts']);
    expect(read('scripts/markdown-roundtrip.ts')).not.toMatch(/resolveSandboxTarget|createSoakRuntime\(/);
    for (const f of ['scripts/soak-sandbox.ts', 'scripts/spike-v2.ts']) {
      expect(read(f)).toMatch(/resolveSandboxTarget\(/);
      expect(users(f)).toBe(false);
    }
    const sandboxTests = readdirSync(join(root, 'test/sandbox')).filter((f) => f.endsWith('.test.ts'));
    expect(sandboxTests.length).toBeGreaterThan(5);
    for (const f of sandboxTests) {
      const src = read(`test/sandbox/${f}`);
      expect(users(`test/sandbox/${f}`), f).toBe(false);
      // Each one that reaches a project resolves it with the sandbox guard.
      if (/LKB_SANDBOX_PROJECT|projectName/.test(src)) expect(src, f).toMatch(/resolveSandboxTarget\(/);
    }
  });
});

describe('resolveProjectKey: the bridge’s rule, for the tools beside it', () => {
  it('store first; the env key only when nothing is stored; a database from before OPS2 uses the env key', () => {
    const db = openDatabase(':memory:');
    try {
      // No secrets table at all (before migration 1000): the env file's key, as the bridge did.
      expect(resolveProjectKey(db, 'p1', { envKey: ` ${KEY} ` })).toEqual({
        ok: true,
        apiKey: KEY,
        source: 'env',
      });
      expect(resolveProjectKey(db, 'p1', {})).toEqual({ ok: false, reason: 'missing', detail: null });
      runMigrations(db);
      expect(resolveProjectKey(db, 'p1', { masterKey: MASTER, envKey: KEY })).toMatchObject({
        source: 'env',
      });
      new ProjectStore(db).insert({ id: 'p1', name: 'one', displayName: null, verifiedAt: 1 });
      new SecretStore(db, { masterKey: MASTER }).write('p1', 'lk_api_key', STORED, { source: 'dashboard' });
      expect(resolveProjectKey(db, 'p1', { masterKey: MASTER, envKey: KEY })).toEqual({
        ok: true,
        apiKey: STORED,
        source: 'store',
      });
      const r = resolveProjectKey(db, 'p1', { envKey: KEY });
      expect(r).toMatchObject({ ok: false, reason: 'unreadable' });
      expect(JSON.stringify(r)).not.toContain(KEY);
    } finally {
      db.close();
    }
  });
});

describe('the scripts refuse a project that is not a sandbox (no request is made); the round trip, one not registered', () => {
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

  it('roundtrip refuses a project that is not registered, or was removed, before any request (v2 E5 hotfix)', () => {
    const unknown = run('markdown-roundtrip.ts', ['--project', 'nowhere', '--out-dir', join(dir, 'rt')]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/is not registered/);
    const gone = run('markdown-roundtrip.ts', ['--project', 'gone', '--out-dir', join(dir, 'rt')]);
    expect(gone.status).toBe(2);
    expect(gone.stderr).toMatch(/removed on the dashboard/);
    for (const r of [unknown, gone]) expect(`${r.stdout}${r.stderr}`).not.toContain(REAL);
  }, 60_000);

  it('soak:sandbox without --project', () => {
    const r = run('soak-sandbox.ts', ['--writes', '8']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--project/);
  }, 60_000);
});
