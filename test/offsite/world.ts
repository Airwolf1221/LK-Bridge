/**
 * v2 E1b test world: a migrated bridge database with the off-site copy set up (client, refresh token, keys) in the
 * encrypted store, a small snapshot store laid out as ADR 0042 fixes it (objects, a manifest naming them, STORE.json),
 * nightly database copies, a mock Google, and the fake rclone acting on a local "Drive" directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { OffsiteDb } from '../../src/offsite/db.js';
import { OffsiteRunner, type RunnerOptions } from '../../src/offsite/runner.js';
import { OFFSITE_SCOPE, SecretStore } from '../../src/secrets/store.js';
import { CLIENT_ID, CLIENT_SECRET, MockGoogle } from './mock-google.js';

export const FAKE_RCLONE = new URL('./fake-rclone.mjs', import.meta.url).pathname;
export const PASSWORD = 'TESTCRYPTPASSWORD-0123456789abcdef';
export const SALT = 'TESTCRYPTSALT-fedcba9876543210';
export const PUBLIC_URL = 'https://lk.example.test';
export const FOLDER = 'LK-Bridge backups/lk.example.test/copy-1';

export interface RcloneCall {
  argv: string[];
  cmd: string;
  config: string | null;
  configExists: boolean | null;
  configMode: string | null;
  drive: { type: string; scope: string; client_id: string } | null;
  crypt: Record<string, string> | null;
  envNames: string[];
}

export interface World {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: Db;
  readonly secrets: SecretStore;
  readonly store: OffsiteDb;
  readonly snapshotDir: string;
  readonly backupDir: string;
  readonly requestDir: string;
  readonly drive: string;
  readonly tmpRoot: string;
  readonly google: MockGoogle;
  readonly masterKey: string;
  readonly objects: string[];
  /** The crypt root on the fake Drive (the folder of generation 1). */
  readonly remote: string;
  env: Record<string, string>;
  runner(o?: Partial<RunnerOptions>): OffsiteRunner;
  calls(): RcloneCall[];
  clearCalls(): void;
  /** Adds an object to the local store (and returns its hash). */
  addObject(content: string): string;
  /** Writes a manifest naming `shas`, dated `ageMs` ago. */
  addManifest(id: string, shas: readonly string[], ageMs?: number): string;
  close(): Promise<void>;
}

export function sha256(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

export function bridgeDbCopy(path: string): void {
  const raw = `${path}.raw`;
  const d = new Database(raw);
  d.exec(
    "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('2200');",
  );
  d.close();
  writeFileSync(path, gzipSync(readFileSync(raw)), { mode: 0o600 });
  rmSync(raw);
}

export async function makeWorld(o: { configured?: boolean } = {}): Promise<World> {
  chmodSync(FAKE_RCLONE, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'lkb-offsite-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const dbPath = join(data, 'bridge.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const masterKey = randomBytes(32).toString('base64');
  const secrets = new SecretStore(db, { masterKey });
  const store = new OffsiteDb(db);
  const google = new MockGoogle();
  await google.start();
  const snapshotDir = join(data, 'snapshots');
  const backupDir = join(data, 'backups');
  const drive = join(dir, 'drive');
  const tmpRoot = join(dir, 'tmp');
  for (const d of [
    join(snapshotDir, 'objects'),
    join(snapshotDir, 'manifests', 'proj_test'),
    backupDir,
    drive,
    tmpRoot,
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(snapshotDir, 'STORE.json'), '{"format":"lk-bridge-snapshot-store","version":1}\n');
  const objects: string[] = [];
  const addObject = (content: string): string => {
    const sha = sha256(content);
    const p = join(snapshotDir, 'objects', sha.slice(0, 2), `${sha}.gz`);
    mkdirSync(join(snapshotDir, 'objects', sha.slice(0, 2)), { recursive: true });
    writeFileSync(p, gzipSync(Buffer.from(content)), { mode: 0o600 });
    const past = new Date(Date.now() - 120_000);
    utimesSync(p, past, past);
    objects.push(sha);
    return sha;
  };
  const addManifest = (id: string, shas: readonly string[], ageMs = 120_000): string => {
    const m = {
      format: 'lk-bridge-snapshot',
      version: 1,
      id,
      project: { id: 'proj_test', name: 'test' },
      kind: 'full',
      takenAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      rootId: null,
      complete: true,
      trigger: {},
      pages: shas.map((s, i) => ({
        id: `page${i}abc`,
        name: `Page ${i}`,
        resource: { sha256: s, size: 10 },
      })),
      library: null,
      counts: {
        pages: shas.length,
        pieces: shas.length,
        reads: 0,
        downloads: 0,
        newObjects: 0,
        newBytes: 0,
        logicalBytes: 0,
        missing: 0,
      },
    };
    const p = join(snapshotDir, 'manifests', 'proj_test', `${id}.json.gz`);
    writeFileSync(p, gzipSync(JSON.stringify(m)), { mode: 0o600 });
    const past = new Date(Date.now() - ageMs);
    utimesSync(p, past, past);
    return p;
  };
  const shas = [addObject('{"piece":"one"}'), addObject('{"piece":"two"}'), addObject('{"piece":"three"}')];
  addManifest('20261112T003000Z-full-a1b2c3', shas);
  bridgeDbCopy(join(backupDir, 'nightly-20261112T041500Z.db.gz'));
  bridgeDbCopy(join(backupDir, 'nightly-20261113T041500Z.db.gz'));
  if (o.configured !== false) {
    secrets.write(OFFSITE_SCOPE, 'drive_client_id', CLIENT_ID, { source: 'dashboard' });
    secrets.write(OFFSITE_SCOPE, 'drive_client_secret', CLIENT_SECRET, { source: 'dashboard' });
    secrets.write(OFFSITE_SCOPE, 'drive_refresh_token', google.grant(), { source: 'dashboard' });
    secrets.write(OFFSITE_SCOPE, 'drive_crypt_password', PASSWORD, { source: 'dashboard' });
    secrets.write(OFFSITE_SCOPE, 'drive_crypt_salt', SALT, { source: 'dashboard' });
    store.setConnected({ email: 'owner@example.test', name: 'Test Owner' });
    store.setKeys('generated');
  }
  const log = join(dir, 'rclone.log');
  const world: World = {
    dir,
    dbPath,
    db,
    secrets,
    store,
    snapshotDir,
    backupDir,
    requestDir: join(data, 'offsite', 'requests'),
    drive,
    tmpRoot,
    google,
    masterKey,
    objects,
    remote: join(drive, FOLDER),
    env: { FAKE_RCLONE_DRIVE: drive, FAKE_RCLONE_LOG: log },
    runner(over = {}) {
      return new OffsiteRunner({
        db,
        secrets,
        dbPath,
        snapshotDir,
        backupDir,
        requestDir: join(data, 'offsite', 'requests'),
        publicUrl: PUBLIC_URL,
        rcloneBin: FAKE_RCLONE,
        rcloneEnv: world.env,
        google: { endpoints: google.endpoints },
        tmpRoot,
        log: () => undefined,
        // v2 E4: the database copy each run takes (deploy/backup.sh offsite in production) is a no-op here unless a
        // test passes its own.
        takeDatabaseCopy: () => Promise.resolve('database copy skipped (test)'),
        ...over,
      });
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RcloneCall);
    },
    clearCalls() {
      rmSync(log, { force: true });
    },
    addObject,
    addManifest,
    async close() {
      db.close();
      await google.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}
