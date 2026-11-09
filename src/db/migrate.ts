import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, type Db } from './open.js';

/**
 * Minimal migration runner shared by every chunk.
 *
 * - Migrations are plain `.sql` files named `NNNN_slug.sql` (four digits, lowercase slug) in
 *   `src/db/migrations/` (copied to `dist/db/migrations/` by `npm run build`).
 * - Each file runs once, inside a transaction, and is recorded in `schema_migrations` with a
 *   SHA-256 checksum. Applied migrations are immutable: a changed checksum aborts start-up.
 * - Files are applied in version order, and any file not yet applied is applied, even if a higher
 *   version already ran. Chunks reserve version ranges (auth uses 0100-0199) so their files can
 *   land in any order.
 */

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Values a migration may need from outside the database (v2 A1). They are put in a temporary table,
 * `temp.migration_context (key, value)`, for the migrations to read; nothing is stored. `legacy_project_id` and
 * `legacy_project_name` let migration 0600 assign the rows of a single-project database to that project.
 */
export type MigrationContext = Readonly<Record<string, string | null | undefined>>;

export interface MigrationOptions {
  readonly context?: MigrationContext;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const seen = new Map<string, string>();
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_PATTERN.exec(file);
    if (!m) throw new MigrationError(`Migration file name must look like 0001_slug.sql: ${file}`);
    const [, version, name] = m as unknown as [string, string, string];
    const clash = seen.get(version);
    if (clash) throw new MigrationError(`Two migrations share version ${version}: ${clash} and ${file}`);
    seen.set(version, file);
    const sql = readFileSync(join(dir, file), 'utf8');
    migrations.push({
      version,
      name,
      file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/** `-- hint: …` lines of a migration: added to its error message if it fails. */
function hintOf(sql: string): string {
  return [...sql.matchAll(/^--\s*hint:\s*(.+)$/gm)].map((m) => m[1]!.trim()).join(' ');
}

export function runMigrations(
  db: Db,
  dir: string = defaultMigrationsDir(),
  options: MigrationOptions = {},
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
    version: string;
    checksum: string;
  }[];
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  const done: string[] = [];
  const already: string[] = [];
  db.exec('CREATE TEMP TABLE IF NOT EXISTS migration_context (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('DELETE FROM temp.migration_context');
  const put = db.prepare('INSERT INTO temp.migration_context (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(options.context ?? {})) put.run(k, v ?? null);
  try {
    for (const m of loadMigrations(dir)) applyOne(db, m, applied, record, done, already);
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.migration_context');
  }
  return { applied: done, alreadyApplied: already };
}

function applyOne(
  db: Db,
  m: Migration,
  applied: ReadonlyMap<string, string>,
  record: { run(...args: unknown[]): unknown },
  done: string[],
  already: string[],
): void {
  const prior = applied.get(m.version);
  if (prior !== undefined) {
    if (prior !== m.checksum) {
      throw new MigrationError(
        `Migration ${m.file} changed after it was applied. Add a new migration instead of editing it.`,
      );
    }
    already.push(m.file);
    return;
  }
  try {
    db.transaction(() => {
      db.exec(m.sql);
      // Foreign keys are enforced row by row, but a migration that rebuilds tables is checked as a whole too: any
      // dangling reference rolls the migration back.
      const dangling = db.pragma('foreign_key_check') as unknown[];
      if (dangling.length > 0) {
        throw new MigrationError(`left ${dangling.length} row(s) with a dangling foreign key`);
      }
      record.run(m.version, m.name, m.checksum, new Date().toISOString());
    })();
  } catch (e) {
    const hint = hintOf(m.sql);
    throw new MigrationError(
      `Migration ${m.file} failed and was rolled back: ${e instanceof Error ? e.message : String(e)}` +
        (hint ? `. ${hint}` : ''),
    );
  }
  done.push(m.file);
}

/**
 * The context the bridge's own migrations need, from the environment: the single-project form's LK_PROJECT_ID and
 * LK_PROJECT_NAME (v2 A1, migration 0600). Neither is a secret.
 */
export function migrationContextFromEnv(env: NodeJS.ProcessEnv = process.env): MigrationContext {
  return {
    legacy_project_id: env.LK_PROJECT_ID?.trim() || null,
    legacy_project_name: env.LK_PROJECT_NAME?.trim().toLowerCase() || null,
  };
}

/** The bridge's env file on the server (deploy/env.template; `LKB_ENV_FILE` overrides it, as in deploy/lib.sh). */
export const DEFAULT_ENV_FILE = '/etc/lk-bridge/lk-bridge.env';

/**
 * Reads the values of `names` from an env file the way systemd and deploy/lib.sh's `env_file_get` do: `NAME=value`
 * lines, the last one wins, surrounding whitespace and one pair of matching quotes are removed. Only the names asked
 * for are returned (never a key: callers ask for non-secret names only), and nothing is printed. A missing or
 * unreadable file gives `{}`.
 */
export function readEnvFileValues(path: string, names: readonly string[]): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || !names.includes(m[1]!)) continue;
    let v = m[2]!.trim();
    const q = /^'(.*)'$/.exec(v) ?? /^"(.*)"$/.exec(v);
    if (q) v = q[1]!;
    out[m[1]!] = v;
  }
  return out;
}

/**
 * The context of `npm run db:migrate` (v2 A1): LK_PROJECT_ID and LK_PROJECT_NAME from the environment, or, when the
 * environment has no LK_PROJECT_ID, from the bridge's env file. The deploy script passes both since this release; a
 * deploy script installed before it passes DB_PATH only, and migration 0600 would otherwise refuse a database with
 * data. `source` names where the id came from (never a value).
 */
export function cliMigrationContext(env: NodeJS.ProcessEnv = process.env): {
  readonly context: MigrationContext;
  readonly source: 'environment' | 'env file' | 'none';
} {
  const fromEnv = migrationContextFromEnv(env);
  if (fromEnv.legacy_project_id) return { context: fromEnv, source: 'environment' };
  const file = readEnvFileValues(env.LKB_ENV_FILE ?? DEFAULT_ENV_FILE, ['LK_PROJECT_ID', 'LK_PROJECT_NAME']);
  const fromFile = migrationContextFromEnv(file);
  if (fromFile.legacy_project_id) return { context: fromFile, source: 'env file' };
  return { context: fromEnv, source: 'none' };
}

/** `npm run db:migrate`: applies pending migrations to DB_PATH (default ./data/bridge.db). */
function main(): void {
  const path = process.env.DB_PATH ?? './data/bridge.db';
  const db = openDatabase(path);
  try {
    const { context, source } = cliMigrationContext();
    const result = runMigrations(db, defaultMigrationsDir(), { context });
    if (source === 'env file' && result.applied.length > 0) {
      process.stdout.write(`LK_PROJECT_ID was read from ${process.env.LKB_ENV_FILE ?? DEFAULT_ENV_FILE}.\n`);
    }
    process.stdout.write(
      result.applied.length > 0
        ? `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}\n`
        : 'Database is up to date.\n',
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
