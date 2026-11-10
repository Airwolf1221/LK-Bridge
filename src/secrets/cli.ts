/**
 * `npm run secrets -- <status | rotate-master-key | reset-owner --yes> [--env-file FILE]` (OPS2, ADR 0028): the encrypted secret
 * store from the server's shell, as the service user:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run secrets -- status
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run secrets -- rotate-master-key
 *
 * The master keys are read from the env file (default /etc/lk-bridge/lk-bridge.env), the database from DB_PATH.
 * Nothing prints a value: `status` lists what is stored (projects by name, purposes, the last four characters of each
 * key, which master key sealed it).
 *
 * `rotate-master-key` is the second step of a rotation (runbook, "Rotating the master key"): after
 * `env-sync.sh --rotate-master-key` has moved the old key to SECRETS_MASTER_KEY_PREVIOUS and generated a new one, it
 * takes a backup of the database (SQLite's online backup, checked, 0600, in the backups directory), then re-seals every
 * secret with the new key in one transaction. It refuses while the bridge runs (its heartbeat is fresh), and changes
 * nothing if any secret opens with neither key.
 *
 * `reset-owner --yes` is the way back in when the owner's stored credentials cannot be read or are forgotten: it deletes
 * them (and the recovery codes), so sign-in uses OWNER_PASSWORD_HASH from the env file again (audited).
 */
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnvFile } from '../config/check.js';
import { openDatabase, type Db } from '../db/open.js';
import { SecretStore, SecretStoreError } from './store.js';

const DEFAULT_ENV_FILE = '/etc/lk-bridge/lk-bridge.env';

function readEnv(file: string): Record<string, string> {
  return parseEnvFile(readFileSync(file, 'utf8'));
}

/** The bridge is running on this database (its instance row was refreshed in the last minute). */
function bridgeRunning(db: Db, now: number): boolean {
  try {
    const r = db.prepare('SELECT heartbeat_at FROM bridge_instance WHERE slot = 1').get() as
      { heartbeat_at: number } | undefined;
    return r !== undefined && now - r.heartbeat_at < 60_000;
  } catch {
    return false;
  }
}

/** A checked online backup of the database, 0600, beside the nightly ones. Returns its path. */
export async function backupDatabase(
  db: Db,
  dbPath: string,
  label: string,
  now = new Date(),
): Promise<string> {
  const dir = join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const dest = join(dir, `${label}-${stamp}.db`);
  await db.backup(dest);
  chmodSync(dest, 0o600);
  const copy = openDatabase(dest);
  try {
    const r = copy.pragma('integrity_check', { simple: true });
    if (r !== 'ok') throw new Error('the backup failed SQLite’s integrity check');
  } finally {
    copy.close();
  }
  return dest;
}

export async function runSecretsCli(
  argv: readonly string[],
  o: {
    readonly env?: Record<string, string>;
    readonly dbPath?: string;
    readonly out?: (s: string) => void;
  } = {},
): Promise<number> {
  const out = o.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const cmd = argv[0];
  const i = argv.indexOf('--env-file');
  const envFile = i >= 0 ? (argv[i + 1] ?? '') : DEFAULT_ENV_FILE;
  let env: Record<string, string>;
  try {
    env = o.env ?? readEnv(envFile);
  } catch (err) {
    out(`Cannot read the env file ${envFile} (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
    return 2;
  }
  const dbPath = o.dbPath ?? process.env.DB_PATH ?? (env.DB_PATH || './data/bridge.db');
  const db = openDatabase(dbPath);
  try {
    const store = new SecretStore(db, {
      masterKey: env.SECRETS_MASTER_KEY,
      previousMasterKey: env.SECRETS_MASTER_KEY_PREVIOUS,
    });
    const names = new Map(
      (db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[]).map((p) => [
        p.id,
        p.name,
      ]),
    );
    if (cmd === 'status') {
      const s = store.state();
      out(
        `Encrypted secret store: ${s.available ? 'usable' : 'NOT usable'}${s.keyId ? ` (master key id ${s.keyId})` : ''}.`,
      );
      if (s.problem) out(`Problem: ${s.problem}`);
      for (const m of store.list()) {
        const who = m.scope === '*' ? 'owner' : `project ${names.get(m.scope) ?? m.scope}`;
        out(
          `  ${who}: ${m.purpose}${m.hint ? ` (ends ${m.hint})` : ''}, ${m.source === 'env_import' ? 'imported from the env file' : 'set on the dashboard'}, sealed with the ${m.sealedWith === 'current' ? 'current' : m.sealedWith === 'previous' ? 'PREVIOUS' : 'an UNKNOWN'} master key`,
        );
      }
      if (s.underPrevious > 0)
        out(`${s.underPrevious} secret(s) still need: npm run secrets -- rotate-master-key`);
      return s.problem ? 1 : 0;
    }
    if (cmd === 'rotate-master-key') {
      if (bridgeRunning(db, Date.now()) && !argv.includes('--force-while-running')) {
        out(
          'The bridge is running on this database. Stop it first (sudo systemctl stop lk-bridge), then run this again. Nothing was changed.',
        );
        return 1;
      }
      if (!store.available) {
        out(`${store.state().problem ?? 'SECRETS_MASTER_KEY is not usable.'} Nothing was changed.`);
        return 1;
      }
      const backup = await backupDatabase(db, dbPath, 'pre-rotation');
      out(
        `Backup taken first: ${backup} (it is sealed with the previous key; keep SECRETS_MASTER_KEY_PREVIOUS with it).`,
      );
      try {
        const r = store.rotate();
        out(
          `Re-encrypted ${r.resealed} secret(s) with the new master key (${r.alreadyCurrent} already used it). Start the bridge: sudo systemctl start lk-bridge`,
        );
        return 0;
      } catch (e) {
        if (e instanceof SecretStoreError) {
          out(e.message);
          return 1;
        }
        throw e;
      }
    }
    if (cmd === 'reset-owner') {
      // The way back in when the owner's stored credentials cannot be read (SECRETS_MASTER_KEY lost) or are forgotten:
      // the stored password hash, authenticator and recovery codes are deleted, so the env file's OWNER_PASSWORD_HASH
      // (from `npm run setup:owner`) is used again. The service user can read every secret anyway: no new power here.
      if (!argv.includes('--yes')) {
        out(
          'This deletes the owner password, the authenticator and the recovery codes kept in the encrypted store. Sign-in then uses OWNER_PASSWORD_HASH from the env file (run `npm run setup:owner` and put its line there first). Run again with --yes to do it.',
        );
        return 1;
      }
      const removed = db.transaction(() => {
        const n = db.prepare("DELETE FROM secrets WHERE scope = '*'").run().changes;
        db.prepare('DELETE FROM owner_recovery_codes').run();
        db.prepare(
          'INSERT INTO audit_log (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(Date.now(), 'shell', 'owner.credentials_reset', null, null, JSON.stringify({ removed: n }));
        return n;
      })();
      out(
        `Removed ${removed} stored owner credential(s) and the recovery codes. Sign-in now uses OWNER_PASSWORD_HASH from the env file. Restart the bridge: sudo systemctl restart lk-bridge`,
      );
      return 0;
    }
    out('usage: npm run secrets -- status | rotate-master-key | reset-owner --yes [--env-file FILE]');
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSecretsCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // Never the error's message or stack: it could quote a value.
      process.stderr.write('secrets: failed (no value is shown)\n');
      process.exitCode = 2;
    },
  );
}
