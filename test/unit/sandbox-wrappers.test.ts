/**
 * OPS2 hotfix: the sandbox wrappers find a project's key exactly as the running bridge does, so they keep working after
 * `env-sync.sh --retire-imported-keys` has commented the env file's key lines out.
 *
 * Every wrapper (deploy/markdown-roundtrip.sh, spike-v2.sh, soak-sandbox.sh, sandbox-test.sh) is run end to end on a
 * fake server (test/unit/sandbox-wrapper-fixture.ts): the bridge's database with keys in the encrypted store, env files
 * in each state, and a fake LegendKeeper inside each Node process that logs only a hash of the bearer token it was sent.
 * For each: the key comes from the store with no env key present; the env file's key is used when nothing is stored;
 * a key in neither place, and a project that is not a sandbox, are refused before any request; no key and no master key
 * is ever exported to a process or printed (stdout and stderr are scanned for every secret). Then one end-to-end dry
 * run of the round trip in the retired-keys state.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_SECRETS,
  MASTER_KEY,
  OLD_TEST_KEY,
  OTHER_MASTER_KEY,
  SCRATCH_KEY,
  TEST_KEY,
  WRAPPERS,
  createFakeServer,
  retiredEnv,
  sha256,
  type FakeServer,
  type Wrapper,
} from './sandbox-wrapper-fixture.js';

let srv: FakeServer;
beforeAll(() => {
  srv = createFakeServer('lkb-sandbox-wrappers-');
});
afterAll(() => srv.close());

function expectNoSecret(text: string): void {
  for (const s of ALL_SECRETS) expect(text).not.toContain(s);
}

/** What the "private Node" was given: never a key or master key variable; always the env file's path and DB_PATH. */
function expectOnlyPathsExported(): void {
  const logged = readFileSync(srv.nodeLog, 'utf8');
  expect(logged).toContain('LKB_ENV_FILE=');
  expect(logged).toContain('DB_PATH=');
  expect(logged).not.toMatch(/LK_PROJECT_[A-Z0-9_]+_API_KEY=|LK_API_KEY=|SECRETS_MASTER_KEY/);
  expectNoSecret(logged);
}

const tsxScript = (w: Wrapper) => w !== 'sandbox-test.sh';
const wrappers = Object.keys(WRAPPERS) as Wrapper[];

describe.each(wrappers)('deploy/%s', (wrapper) => {
  it('uses the key from the encrypted store when the env file has none (keys retired), never one from the caller', () => {
    const env = srv.envFile(`${wrapper}-retired.env`, retiredEnv(srv.dbPath));
    // A stale key and master key in the caller's own environment must not stand in for the bridge's.
    const r = srv.run(wrapper, env, ['--project', 'test'], {
      extraEnv: { LK_PROJECT_TEST_API_KEY: OLD_TEST_KEY, SECRETS_MASTER_KEY: OTHER_MASTER_KEY },
    });
    // The fake LegendKeeper refuses the key, so the script stops after its first call; that call carried the key.
    expect(r.status).not.toBe(0);
    const seen = srv.tokensSeen();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([sha256(TEST_KEY)]));
    if (tsxScript(wrapper)) expect(r.out).toContain("using its key from the bridge's encrypted store");
    expectNoSecret(r.out);
    expectOnlyPathsExported();
  }, 120_000);

  it('falls back to the env file’s key when nothing is stored for the project', () => {
    const env = srv.envFile(`${wrapper}-fallback.env`, [
      ...retiredEnv(srv.dbPath),
      'LK_PROJECTS=scratch',
      `LK_PROJECT_SCRATCH_API_KEY=${SCRATCH_KEY}`,
    ]);
    const r = srv.run(wrapper, env, ['--project', 'scratch']);
    expect(r.status).not.toBe(0);
    expect(new Set(srv.tokensSeen())).toEqual(new Set([sha256(SCRATCH_KEY)]));
    if (tsxScript(wrapper)) expect(r.out).toContain('so using LK_PROJECT_SCRATCH_API_KEY');
    expectNoSecret(r.out);
    expectOnlyPathsExported();
  }, 120_000);

  it('refuses a project with a key in neither place, naming the dashboard’s Projects page, before any request', () => {
    const env = srv.envFile(`${wrapper}-none.env`, retiredEnv(srv.dbPath));
    const r = srv.run(wrapper, env, ['--project', 'scratch']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Project "scratch" has no key/);
    expect(r.out).toMatch(/dashboard's Projects page/);
    expect(srv.tokensSeen()).toEqual([]);
    expectNoSecret(r.out);
  }, 120_000);

  it('still refuses a project that is not marked as a sandbox, before any request', () => {
    const env = srv.envFile(`${wrapper}-arkona.env`, retiredEnv(srv.dbPath));
    const r = srv.run(wrapper, env, ['--project', 'arkona']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/not marked as a sandbox/);
    expect(srv.tokensSeen()).toEqual([]);
    expectNoSecret(r.out);
  }, 120_000);
});

describe('the key rules the bridge follows (through deploy/markdown-roundtrip.sh)', () => {
  it('the stored key wins over a different key still in the env file', () => {
    const env = srv.envFile('wins.env', [
      `DB_PATH=${srv.dbPath}`,
      `SECRETS_MASTER_KEY=${MASTER_KEY}`,
      'LK_PROJECTS=test',
      `LK_PROJECT_TEST_API_KEY=${OLD_TEST_KEY}`,
    ]);
    const r = srv.run('markdown-roundtrip.sh', env, ['--project', 'test']);
    expect(new Set(srv.tokensSeen())).toEqual(new Set([sha256(TEST_KEY)]));
    expectNoSecret(r.out);
  }, 120_000);

  it('a stored key that cannot be opened (wrong master key) is refused; the env file’s key is not used instead', () => {
    const env = srv.envFile('wrong-master.env', [
      `DB_PATH=${srv.dbPath}`,
      `SECRETS_MASTER_KEY=${OTHER_MASTER_KEY}`,
      'LK_PROJECTS=test',
      `LK_PROJECT_TEST_API_KEY=${OLD_TEST_KEY}`,
    ]);
    const r = srv.run('markdown-roundtrip.sh', env, ['--project', 'test']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/encrypted store, which cannot be read here/);
    expect(r.out).toMatch(/LK_PROJECT_TEST_API_KEY from .* is not used instead/);
    expect(srv.tokensSeen()).toEqual([]);
    expectNoSecret(r.out);
  }, 120_000);

  it('refuses a project removed on the dashboard', () => {
    const env = srv.envFile('gone.env', [
      ...retiredEnv(srv.dbPath),
      'LK_PROJECT_GONE_API_KEY=gone-key-SECRET-0000',
    ]);
    const r = srv.run('markdown-roundtrip.sh', env, ['--project', 'gone']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/removed on the dashboard/);
    expect(r.out).not.toContain('gone-key-SECRET-0000');
    expect(srv.tokensSeen()).toEqual([]);
  }, 120_000);

  it('says how to run it when the env file cannot be read (not as the service user)', () => {
    const r = srv.run('markdown-roundtrip.sh', join(srv.dir, 'no-such.env'), ['--project', 'test']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Cannot read .*no-such\.env: run this as the service user/);
  });
});

describe('end-to-end dry run: the Markdown round trip after the keys were retired', () => {
  it('reads every page with the stored key, passes, writes its report, and prints no secret', () => {
    const env = srv.envFile('e2e.env', retiredEnv(srv.dbPath));
    const r = srv.run('markdown-roundtrip.sh', env, ['--project', 'test'], { mode: 'world' });
    expect(r.out).toContain("using its key from the bridge's encrypted store");
    expect(r.out).toContain('Pages checked: 2; passed: 2; failed: 0');
    expect(r.status).toBe(0);
    // Every request was a read, and every one carried the key from the store.
    const calls = readFileSync(srv.fetchLog, 'utf8').split('\n').filter(Boolean);
    // listProjects twice (the runtime's key check, then the script's own "is this the registered project" guard),
    // one listing page, one read per page.
    expect(calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'GET /api/v3/projects/',
      'GET /api/v3/projects/',
      'GET /api/v3/projects/lkp_test/resources/',
      'GET /api/v3/projects/lkp_test/resources/rootres1/docs/d0000001/blocks/',
      'GET /api/v3/projects/lkp_test/resources/page0001/docs/d0000002/blocks/',
    ]);
    expect(new Set(srv.tokensSeen())).toEqual(new Set([sha256(TEST_KEY)]));
    // The report is in the data directory, and holds no secret either.
    const reports = readdirSync(join(srv.dataDir, 'roundtrip')).filter((f) => f.endsWith('.md'));
    expect(reports).toHaveLength(1);
    expectNoSecret(readFileSync(join(srv.dataDir, 'roundtrip', reports[0]!), 'utf8'));
    expectNoSecret(r.out);
    expectOnlyPathsExported();
  }, 120_000);
});
