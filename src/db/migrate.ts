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

export function runMigrations(db: Db, dir: string = defaultMigrationsDir()): MigrationResult {
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
  for (const m of loadMigrations(dir)) {
    const prior = applied.get(m.version);
    if (prior !== undefined) {
      if (prior !== m.checksum) {
        throw new MigrationError(
          `Migration ${m.file} changed after it was applied. Add a new migration instead of editing it.`,
        );
      }
      already.push(m.file);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, m.checksum, new Date().toISOString());
    })();
    done.push(m.file);
  }
  return { applied: done, alreadyApplied: already };
}

/** `npm run db:migrate`: applies pending migrations to DB_PATH (default ./data/bridge.db). */
function main(): void {
  const path = process.env.DB_PATH ?? './data/bridge.db';
  const db = openDatabase(path);
  try {
    const result = runMigrations(db);
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
