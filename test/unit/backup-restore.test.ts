/**
 * Chunk 8 (review item 16): the backup and the restore procedure, run for real against a SQLite database in WAL mode
 * that is still open (as the bridge's is when the nightly backup runs). Needs the sqlite3 and gzip commands (the server
 * has them; skipped with a reason where they are not installed).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';

const deployDir = new URL('../../deploy/', import.meta.url).pathname;
const have = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const tools = have('sqlite3') && have('gzip');

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function sh(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync('bash', [join(deployDir, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!tools)('backup.sh and restore.sh (chunk 8)', () => {
  it('backs up a live WAL database, and restores it after moving the old files aside', () => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-restore-'));
    const dbPath = join(dir, 'bridge.db');
    const backups = join(dir, 'backups');
    // A stopped service, as far as restore.sh can tell.
    const stopped = join(dir, 'systemctl-stopped');
    writeFileSync(stopped, '#!/usr/bin/env bash\nexit 3\n');
    chmodSync(stopped, 0o755);
    const running = join(dir, 'systemctl-running');
    writeFileSync(running, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(running, 0o755);
    const env = { DB_PATH: dbPath, BACKUP_DIR: backups, LKB_ENV_FILE: join(dir, 'none.env') };

    // The bridge's database, open, with rows still in the WAL.
    const db = openDatabase(dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO write_journal (at, op_id, risk, target_kind, bytes) VALUES (1, 'createResource', 'safe', 'resource', 0)`,
    ).run();
    db.prepare(`INSERT INTO runtime_settings (key, value, updated_at) VALUES ('k', '"before"', 1)`).run();
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const b = sh('backup.sh', ['nightly'], env);
    expect(b.status, b.err).toBe(0);
    const [file] = readdirSync(backups).filter((f) => f.endsWith('.db.gz'));
    expect(file).toMatch(/^nightly-\d{8}T\d{6}Z\.db\.gz$/);
    expect(statSync(join(backups, file!)).mode & 0o777).toBe(0o600);

    // Changes after the backup are what a restore gives up.
    db.prepare(`UPDATE runtime_settings SET value = '"after"' WHERE key = 'k'`).run();

    // Refused while the service runs; nothing is touched.
    const refused = sh('restore.sh', [join(backups, file!)], { ...env, LKB_SYSTEMCTL: running });
    expect(refused.status).not.toBe(0);
    expect(refused.err).toMatch(/is running/);
    expect(existsSync(dbPath)).toBe(true);

    // The service stops (the database is closed), then the restore.
    db.close();
    const r = sh('restore.sh', [join(backups, file!)], { ...env, LKB_SYSTEMCTL: stopped });
    expect(r.status, r.err).toBe(0);
    const aside = readdirSync(dir).find((f) => f.startsWith('restore-aside-'));
    expect(aside).toBeDefined();
    expect(readdirSync(join(dir, aside!))).toContain('bridge.db');
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    // The restored database is whole, has every migration, and holds the state at backup time.
    const restored = openDatabase(dbPath);
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(runMigrations(restored).applied).toEqual([]);
      expect(restored.prepare(`SELECT value FROM runtime_settings WHERE key = 'k'`).get()).toEqual({
        value: '"before"',
      });
      expect(restored.prepare('SELECT COUNT(*) AS n FROM write_journal').get()).toEqual({ n: 1 });
    } finally {
      restored.close();
    }
  });

  it('refuses a damaged or foreign backup without touching the database', () => {
    dir = mkdtempSync(join(tmpdir(), 'lkb-restore-'));
    const dbPath = join(dir, 'bridge.db');
    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();
    const stopped = join(dir, 'systemctl-stopped');
    writeFileSync(stopped, '#!/usr/bin/env bash\nexit 3\n');
    chmodSync(stopped, 0o755);
    const env = { DB_PATH: dbPath, LKB_SYSTEMCTL: stopped, LKB_ENV_FILE: join(dir, 'none.env') };
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database');
    const foreign = join(dir, 'foreign.db');
    spawnSync('sqlite3', [foreign, 'CREATE TABLE t (x);']);
    for (const bad of [junk, foreign]) {
      const r = sh('restore.sh', [bad], env);
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/Nothing was changed/);
    }
    expect(readdirSync(dir).some((f) => f.startsWith('restore-aside-'))).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('.restore-'))).toBe(false);
  });
});
