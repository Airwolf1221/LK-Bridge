/**
 * A fake server for the sandbox wrappers (deploy/sandbox-test.sh, soak-sandbox.sh, spike-v2.sh,
 * markdown-roundtrip.sh): the bridge's database with registered projects and a key in the encrypted store, env files
 * in the states the owner's server can be in (keys retired into the store by `env-sync.sh --retire-imported-keys`, or
 * still in the file), and a "private Node" that records what it was asked to run and the NAMES of the variables it was
 * given, then runs the real Node with test/unit/fake-lk-fetch.ts preloaded, which answers LegendKeeper itself and logs
 * only a hash of each bearer token. Nothing reaches the network, and no key is written anywhere but the env files and
 * the (encrypted) database.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { ProjectStore } from '../../src/projects/index.js';
import { keyHint, SecretStore } from '../../src/secrets/index.js';

/** Stored in the encrypted store for `test` (and, retired, still in a comment of the env file). */
export const TEST_KEY = 'test-key-SECRET-store-1234';
/** An old key of `test`, replaced on the dashboard: must never be used while the store has the new one. */
export const OLD_TEST_KEY = 'old-test-key-SECRET-5555';
/** `scratch` has nothing stored: its key is only in the env file. */
export const SCRATCH_KEY = 'scratch-key-SECRET-7777';
/** Arkona's key: in the store, and Arkona is not a sandbox. */
export const REAL_KEY = 'arkona-key-SECRET-9999';
export const MASTER_KEY = randomBytes(32).toString('base64');
export const OTHER_MASTER_KEY = randomBytes(32).toString('base64');
export const ALL_SECRETS = [TEST_KEY, OLD_TEST_KEY, SCRATCH_KEY, REAL_KEY, MASTER_KEY, OTHER_MASTER_KEY];

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const WRAPPERS = {
  'markdown-roundtrip.sh': 'roundtrip',
  'spike-v2.sh': 'spike:v2',
  'soak-sandbox.sh': 'soak:sandbox',
  'sandbox-test.sh': 'test:sandbox',
} as const;
export type Wrapper = keyof typeof WRAPPERS;

export interface FakeServer {
  readonly dir: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly nodeLog: string;
  readonly fetchLog: string;
  envFile(name: string, lines: readonly string[]): string;
  run(
    wrapper: Wrapper,
    envPath: string,
    args: readonly string[],
    o?: { readonly mode?: 'refuse' | 'world'; readonly extraEnv?: Record<string, string> },
  ): { status: number | null; out: string };
  /** The bearer-token hashes the fake LegendKeeper saw since the last run. */
  tokensSeen(): string[];
  close(): void;
}

/** The env file after `env-sync.sh --retire-imported-keys`: the key lines and LK_PROJECTS commented out, values kept. */
export function retiredEnv(dbPath: string, masterKey = MASTER_KEY): string[] {
  return [
    `DB_PATH=${dbPath}`,
    `SECRETS_MASTER_KEY=${masterKey}`,
    "# retired by env-sync (20261110T120000Z): every listed project's key is in the bridge's encrypted store; projects are managed on the dashboard.",
    '# LK_PROJECTS=arkona,test',
    'LK_DEFAULT_PROJECT=arkona',
    '# retired by env-sync (20261110T120000Z): the bridge keeps LK_PROJECT_ARKONA_API_KEY in its encrypted store (checked equal), so this file no longer needs it.',
    `# LK_PROJECT_ARKONA_API_KEY=${REAL_KEY}`,
    '# retired by env-sync (20261110T120000Z): the bridge keeps LK_PROJECT_TEST_API_KEY in its encrypted store (checked equal), so this file no longer needs it.',
    `# LK_PROJECT_TEST_API_KEY=${TEST_KEY}`,
  ];
}

export function createFakeServer(prefix: string): FakeServer {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(dir, 'data');
  const dbPath = join(dataDir, 'bridge.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const projects = new ProjectStore(db);
  projects.insert({ id: 'lkp_test', name: 'test', displayName: 'Test world', verifiedAt: 1 });
  projects.insert({ id: 'lkp_scratch', name: 'scratch', displayName: 'Scratch world', verifiedAt: 1 });
  projects.insert({ id: 'lkp_arkona', name: 'arkona', displayName: 'Arkona', verifiedAt: 1 });
  projects.insert({ id: 'lkp_gone', name: 'gone', displayName: 'Gone', verifiedAt: 1 });
  projects.setSandbox('lkp_test', true);
  projects.setSandbox('lkp_scratch', true);
  projects.setSandbox('lkp_gone', true);
  projects.archive('lkp_gone');
  const secrets = new SecretStore(db, { masterKey: MASTER_KEY });
  secrets.write('lkp_test', 'lk_api_key', TEST_KEY, { source: 'dashboard', hint: keyHint(TEST_KEY) });
  secrets.write('lkp_arkona', 'lk_api_key', REAL_KEY, { source: 'env_import', hint: keyHint(REAL_KEY) });
  db.close();

  const nodeLog = join(dir, 'node.log');
  const fetchLog = join(dir, 'fetch.log');
  const preload = new URL('./fake-lk-fetch.ts', import.meta.url).href;
  mkdirSync(join(dir, 'node/bin'), { recursive: true });
  writeFileSync(
    join(dir, 'node/bin/node'),
    [
      '#!/usr/bin/env bash',
      'if [[ "${1:-}" == "--version" ]]; then echo v24.0.0; exit 0; fi',
      `printf '%s\\n' "$*" >> '${nodeLog}'`,
      // Names only: every variable that could carry a key or say where one is.
      `env | grep -oE '^(LK_[A-Z0-9_]+|SECRETS_[A-Z0-9_]+|DB_PATH|LKB_ENV_FILE|LKB_SANDBOX_PROJECT)=' | sort | tr '\\n' ' ' >> '${nodeLog}'`,
      `echo >> '${nodeLog}'`,
      `export NODE_OPTIONS="--import=${preload}"`,
      `exec '${process.execPath}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'node/bin/node'), 0o755);

  return {
    dir,
    dataDir,
    dbPath,
    nodeLog,
    fetchLog,
    envFile(name, lines) {
      const f = join(dir, name);
      writeFileSync(f, `${lines.join('\n')}\n`, { mode: 0o600 });
      return f;
    },
    run(wrapper, envPath, args, o = {}) {
      rmSync(nodeLog, { force: true });
      rmSync(fetchLog, { force: true });
      const r = spawnSync('bash', [new URL(`../../deploy/${wrapper}`, import.meta.url).pathname, ...args], {
        encoding: 'utf8',
        env: {
          PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
          HOME: dir,
          LKB_ENV_FILE: envPath,
          LKB_NODE_DIR: join(dir, 'node'),
          LKB_DATA_DIR: dataDir,
          LKB_TEST_FETCH_LOG: fetchLog,
          LKB_TEST_FETCH_MODE: o.mode ?? 'refuse',
          ...o.extraEnv,
        },
        timeout: 120_000,
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    tokensSeen() {
      if (!existsSync(fetchLog)) return [];
      return readFileSync(fetchLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' ')[2] ?? '');
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
