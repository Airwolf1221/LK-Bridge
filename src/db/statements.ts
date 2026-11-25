/**
 * v3 F6a.1 (ADR 0076 amendment 1): prepared statements reused, per connection.
 *
 * `db.prepare(sql)` compiles a new SQLite statement each call. Its native memory (several kilobytes) is freed only when
 * V8 collects the JavaScript wrapper AND runs its weak callback, which happens on a later turn of the event loop. A
 * synchronous loop that prepares thousands of statements (the repository tree's status is read with five of them on
 * every query) therefore holds every one of them until it yields: on 24 November 2026 that grew the bridge by about
 * 116 MB per Reference Types report build, and a bulk accept that rebuilt the report per row never yielded at all.
 *
 * `prepared(db, sql)` returns the same statement for the same SQL on the same connection. Bounded (least recently used
 * first out), so SQL built at run time cannot grow it without limit. Use it for fixed SQL on hot paths only, and never
 * with `.iterate()`, `.pluck()`, `.raw()`, `.expand()` or `.safeIntegers()`: a cached statement is shared, and those
 * change its mode or hold it busy.
 */
import type Database from 'better-sqlite3';
import type { Db } from './open.js';

type Statement = Database.Statement<unknown[], unknown>;

const MAX = 256;
const caches = new WeakMap<Db, Map<string, Statement>>();

export function prepared(db: Db, sql: string): Statement {
  let c = caches.get(db);
  if (!c) {
    c = new Map();
    caches.set(db, c);
  }
  const hit = c.get(sql);
  if (hit) {
    // Most recently used last.
    c.delete(sql);
    c.set(sql, hit);
    return hit;
  }
  const s = db.prepare(sql);
  c.set(sql, s);
  if (c.size > MAX) c.delete(c.keys().next().value!);
  return s;
}

/** How many statements are cached for a connection (tests). */
export function preparedCount(db: Db): number {
  return caches.get(db)?.size ?? 0;
}
