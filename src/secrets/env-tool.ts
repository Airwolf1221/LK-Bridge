/**
 * `node dist/secrets/env-tool.js --file /etc/lk-bridge/lk-bridge.env <compare | status>` (OPS2, ADR 0028): what
 * `deploy/env-sync.sh` asks the bridge about its encrypted store. env-sync runs it as the service user (who may read
 * the env file and the database), never as root, with an empty environment, exactly like the configuration check.
 *
 * - `compare`: for every env line whose value the store can hold (each LK_PROJECT_<NAME>_API_KEY, OWNER_PASSWORD_HASH,
 *   OWNER_TOTP_SECRET), one line `<verdict> <NAME>`:
 *     `equal`       the store holds exactly this value, and it decrypts: the env line can be retired;
 *     `superseded`  this is the value first imported, which the dashboard has since replaced or removed: it can be
 *                   retired too (the store has the value in use);
 *     `differs`     the store holds another value that this one never was: refused (look before retiring);
 *     `not_stored`  nothing stored for it yet (the bridge imports it at its next start with a master key): refused;
 *     `unreadable`  something is stored but cannot be decrypted here (master key missing or wrong): refused.
 * - `status`: `stored=<n> available=<yes|no>`: how many secrets the database holds, and whether the master key in
 *   the file can be used (env-sync refuses to generate a new master key over a database that already holds secrets).
 *
 * It opens the database read-only and prints names and verdicts only: never a value, a hash or a key id. Exit status: 0
 * when it ran, 2 when it could not (an unreadable file, say), with a fixed message.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { safeEqual } from '../auth/crypto.js';
import { parseEnvFile } from '../config/check.js';
import { readFileSync } from 'node:fs';
import { OWNER_SCOPE, SecretStore, type SecretPurpose } from './store.js';
import type { Db } from '../db/open.js';

export type Verdict = 'equal' | 'superseded' | 'differs' | 'not_stored' | 'unreadable';

const PROJECT_KEY = /^LK_PROJECT_([A-Z0-9_]+)_API_KEY$/;

/** Compares each retire-able env line with the store. Names and verdicts only. */
export function compareEnvWithStore(
  db: Db,
  env: Readonly<Record<string, string>>,
): { readonly name: string; readonly verdict: Verdict }[] {
  const store = new SecretStore(db, {
    masterKey: env.SECRETS_MASTER_KEY,
    previousMasterKey: env.SECRETS_MASTER_KEY_PREVIOUS,
  });
  const projects = hasTable(db, 'projects')
    ? (db.prepare('SELECT id, name, archived_at FROM projects').all() as {
        id: string;
        name: string;
        archived_at: number | null;
      }[])
    : [];
  const out: { name: string; verdict: Verdict }[] = [];
  const judge = (
    name: string,
    value: string,
    scope: string | null,
    purpose: SecretPurpose,
    removed: boolean,
  ) => {
    const stored =
      scope !== null && hasTable(db, 'secrets')
        ? store.read(scope, purpose)
        : { ok: false as const, reason: 'not_stored' as const };
    const imported = hasTable(db, 'secret_imports') && store.wasImportedAs(name, value);
    if (stored.ok) {
      if (safeEqual(stored.value, value)) return out.push({ name, verdict: 'equal' });
      return out.push({ name, verdict: imported ? 'superseded' : 'differs' });
    }
    if (stored.reason !== 'not_stored') return out.push({ name, verdict: 'unreadable' });
    // Nothing stored: removed on the dashboard after it was imported (a project, or the authenticator).
    if (imported && removed) return out.push({ name, verdict: 'superseded' });
    return out.push({ name, verdict: 'not_stored' });
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === '') continue;
    const k = PROJECT_KEY.exec(name);
    if (k) {
      const p = projects.find((x) => x.name === (k[1] ?? '').toLowerCase());
      judge(name, value, p?.id ?? null, 'lk_api_key', p !== undefined && p.archived_at !== null);
    } else if (name === 'OWNER_PASSWORD_HASH') {
      judge(name, value, OWNER_SCOPE, 'owner_password_hash', false);
    } else if (name === 'OWNER_TOTP_SECRET') {
      judge(name, value, OWNER_SCOPE, 'owner_totp_secret', true);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** How many secrets are stored, and whether the env file's master key can be used. */
export function storeStatus(
  db: Db | undefined,
  env: Readonly<Record<string, string>>,
): { readonly stored: number; readonly available: boolean } {
  if (!db || !hasTable(db, 'secrets')) {
    return { stored: 0, available: (env.SECRETS_MASTER_KEY ?? '').trim().length >= 32 };
  }
  const s = new SecretStore(db, {
    masterKey: env.SECRETS_MASTER_KEY,
    previousMasterKey: env.SECRETS_MASTER_KEY_PREVIOUS,
  }).state();
  return { stored: s.stored, available: s.available && s.unreadable.length === 0 };
}

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function main(argv: readonly string[]): number {
  const i = argv.indexOf('--file');
  const file = i >= 0 ? argv[i + 1] : undefined;
  const mode = argv.find((a) => a === 'compare' || a === 'status');
  if (!file || !mode) {
    process.stderr.write('usage: env-tool --file ENV_FILE compare|status\n');
    return 2;
  }
  let env: Record<string, string>;
  try {
    env = parseEnvFile(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `env-tool: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`,
    );
    return 2;
  }
  const dbPath = env.DB_PATH || './data/bridge.db';
  let db: Db | undefined;
  try {
    if (existsSync(dbPath)) db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    process.stderr.write('env-tool: cannot open the database read-only\n');
    return 2;
  }
  try {
    if (mode === 'status') {
      const s = storeStatus(db, env);
      process.stdout.write(`stored=${s.stored} available=${s.available ? 'yes' : 'no'}\n`);
      return 0;
    }
    if (!db) {
      for (const n of Object.keys(env).filter(
        (k) => PROJECT_KEY.test(k) || /^OWNER_(PASSWORD_HASH|TOTP_SECRET)$/.test(k),
      )) {
        if (env[n]) process.stdout.write(`not_stored ${n}\n`);
      }
      return 0;
    }
    for (const r of compareEnvWithStore(db, env)) process.stdout.write(`${r.verdict} ${r.name}\n`);
    return 0;
  } catch {
    // Never the error's message: it could quote its input.
    process.stderr.write('env-tool: failed (no value is shown)\n');
    return 2;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
