/**
 * v2 E1a follow-up (ADR 0042): migration 2100 removes what the daily changed-pages pass left (its memory table, its two
 * project settings, its job) and lets an unchanged full-snapshot schedule be worked out again from the new default.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';

describe('migration 2100', () => {
  it('drops snapshot_seen, the two settings and the snapshot-daily job; resets the default full-snapshot schedule only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm2100-'));
    for (const m of loadMigrations().filter((x) => x.version < '2100'))
      writeFileSync(join(dir, m.file), m.sql);
    const db = openDatabase(':memory:');
    runMigrations(db, dir, { context: {} });
    const project = db.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at, settings) VALUES (?, ?, 0, 0, ?)',
    );
    project.run(
      'p1',
      'withpass',
      JSON.stringify({
        snapshotDailyPass: true,
        snapshotDailyPassDocuments: true,
        imageStagingFolder: 'Mine',
      }),
    );
    project.run('p2', 'plain', JSON.stringify({ useEtagVersions: false }));
    project.run('p3', 'notjson', 'not json');
    db.prepare(
      'INSERT INTO snapshot_seen (project_id, page_id, updated_at, seen_at) VALUES (?, ?, ?, 0)',
    ).run('p1', 'pg', 'x');
    const job = db.prepare(
      'INSERT INTO maintenance_jobs (id, enabled, schedule, next_run_at, updated_at) VALUES (?, ?, ?, ?, 0)',
    );
    job.run('snapshot-daily', 1, null, 123);
    job.run('snapshot-full', 1, null, 456); // the default schedule: its next run was worked out from the old default
    job.run('snapshot-prune', 1, null, 789); // another job: untouched
    db.prepare(
      'INSERT INTO maintenance_runs (project_id, job_id, trigger, started_at, finished_at, outcome, duration_ms) VALUES (?, ?, ?, 0, 0, ?, 0)',
    ).run('p1', 'snapshot-daily', 'schedule', 'skipped');

    runMigrations(db, undefined, { context: {} });

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'snapshot_seen'").all()).toEqual([]);
    const settings = (id: string) =>
      (db.prepare('SELECT settings FROM projects WHERE id = ?').get(id) as { settings: string }).settings;
    expect(JSON.parse(settings('p1'))).toEqual({ imageStagingFolder: 'Mine' });
    expect(JSON.parse(settings('p2'))).toEqual({ useEtagVersions: false });
    expect(settings('p3')).toBe('not json');
    expect(db.prepare("SELECT id FROM maintenance_jobs WHERE id = 'snapshot-daily'").all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM maintenance_runs WHERE job_id = 'snapshot-daily'").all()).toEqual([]);
    const next = (id: string) =>
      (
        db.prepare('SELECT next_run_at AS n FROM maintenance_jobs WHERE id = ?').get(id) as {
          n: number | null;
        }
      ).n;
    expect(next('snapshot-full')).toBeNull();
    expect(next('snapshot-prune')).toBe(789);
  });

  it('keeps a full-snapshot schedule the owner changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm2100b-'));
    for (const m of loadMigrations().filter((x) => x.version < '2100'))
      writeFileSync(join(dir, m.file), m.sql);
    const db = openDatabase(':memory:');
    runMigrations(db, dir, { context: {} });
    db.prepare(
      "INSERT INTO maintenance_jobs (id, enabled, schedule, next_run_at, updated_at) VALUES ('snapshot-full', 1, ?, 456, 0)",
    ).run(JSON.stringify({ kind: 'weekly', day: 'sat', time: '23:45' }));
    runMigrations(db, undefined, { context: {} });
    const row = db
      .prepare("SELECT next_run_at AS n FROM maintenance_jobs WHERE id = 'snapshot-full'")
      .get() as {
      n: number;
    };
    expect(row.n).toBe(456);
  });
});
