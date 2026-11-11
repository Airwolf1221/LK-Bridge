/**
 * C2d (ADR 0037; ADR 0036 decision 7): migration 1750 adds the set record table, links page records to it, and adds the
 * status-tags canon rule once to a project that stores its own rules (a project on the defaults gets it from them).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { canonConfigFrom } from '../../src/facts/rules.js';

describe('migration 1750 (C2d)', () => {
  it('adds lifecycle_sets, lifecycle_records.set_id, and the status-tags rule to stored rule lists only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1750-'));
    for (const m of loadMigrations().filter((x) => x.version < '1750'))
      writeFileSync(join(dir, m.file), m.sql);
    const db = openDatabase(':memory:');
    runMigrations(db, dir, { context: {} });
    const insert = db.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, settings) VALUES (?, ?, 0, 0, ?)',
    );
    insert.run('p1', 'own', JSON.stringify({ canonicalRules: [{ id: 'x', key: 'Status', kind: 'change' }] }));
    insert.run('p2', 'defaults', JSON.stringify({}));
    insert.run(
      'p3',
      'already',
      JSON.stringify({ canonicalRules: [{ id: 'mine', kind: 'statusTags', enabled: false }] }),
    );
    runMigrations(db, undefined, { context: {} });
    const settings = (id: string) =>
      JSON.parse(
        (db.prepare('SELECT settings FROM projects WHERE id = ?').get(id) as { settings: string }).settings,
      ) as {
        canonicalRules?: { id: string; kind: string }[];
      };
    expect(settings('p1').canonicalRules!.map((r) => r.id)).toEqual(['x', 'status-tags']);
    expect(canonConfigFrom(settings('p1')).problem).toBeNull();
    expect(settings('p2').canonicalRules).toBeUndefined();
    expect(canonConfigFrom(settings('p2')).active.some((r) => r.kind === 'statusTags')).toBe(true);
    expect(settings('p3').canonicalRules!.map((r) => r.id)).toEqual(['mine']);
    const cols = (db.prepare('PRAGMA table_info(lifecycle_records)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('set_id');
    const setCols = (db.prepare('PRAGMA table_info(lifecycle_sets)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(setCols).toEqual(
      expect.arrayContaining(['root_id', 'action', 'state', 'pages', 'target', 'previous_parent_id', 'jobs']),
    );
  });
});
