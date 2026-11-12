import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Opens the bridge database with the pragmas every chunk relies on: WAL journalling, foreign keys
 * enforced, and a busy timeout so a short write lock never surfaces as an error.
 * `:memory:` is accepted for tests.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/**
 * The absolute path of the file a database was actually opened from, or null for an in-memory or temporary one. Read from
 * SQLite itself (`PRAGMA database_list`), so it is the database the handle really is, whatever configuration said.
 */
export function databaseFile(db: Db): string | null {
  const rows = db.pragma('database_list') as { name: string; file: string }[];
  const main = rows.find((r) => r.name === 'main');
  return main && main.file !== '' ? main.file : null;
}
