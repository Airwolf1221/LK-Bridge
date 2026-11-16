/**
 * v2 E5.5 (backlog 16): the measured per-write duration estimates use, read from `steps`: the median wall time of the
 * project's last 200 succeeded write steps (registry writes and uploads), cached for a minute.
 */
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { medianWriteStepMs, writeDurationSource } from '../../src/jobs/durations.js';

function db(): Db {
  const d = openDatabase(':memory:');
  runMigrations(d);
  d.pragma('foreign_keys = OFF'); // steps without their jobs: only `steps` is read
  return d;
}

let seq = 0;
function step(
  d: Db,
  o: {
    project?: string;
    kind?: 'read' | 'write' | 'upload';
    status?: string;
    start: number;
    ms: number | null;
  },
) {
  d.prepare(
    `INSERT INTO steps (job_id, project_id, step_no, op_id, op_kind, params_hash, status, started_at, finished_at)
     VALUES (?, ?, 1, 'createResource', ?, 'h', ?, ?, ?)`,
  ).run(
    `job_${++seq}`,
    o.project ?? 'p1',
    o.kind ?? 'write',
    o.status ?? 'succeeded',
    o.start,
    o.ms === null ? null : o.start + o.ms,
  );
}

describe('the measured per-write duration', () => {
  it('is the median wall time of the last succeeded write and upload steps of that project only', () => {
    const d = db();
    expect(medianWriteStepMs(d, 'p1')).toBeNull();
    const t = 1_000_000;
    [900, 1200, 1500, 1100, 30_000].forEach((ms, i) => step(d, { start: t + i * 60_000, ms }));
    step(d, { kind: 'upload', start: t + 400_000, ms: 1300 });
    // Not counted: reads, failures, unfinished steps, another project.
    step(d, { kind: 'read', start: t + 500_000, ms: 50 });
    step(d, { status: 'failed', start: t + 500_000, ms: 90_000 });
    step(d, { status: 'running', start: t + 500_000, ms: null });
    step(d, { project: 'p2', start: t + 500_000, ms: 10 });
    // 900, 1100, 1200, 1300, 1500, 30000: the long wait does not drag it up.
    expect(medianWriteStepMs(d, 'p1')).toEqual({ ms: 1250, samples: 6 });
    // The newest N only.
    expect(medianWriteStepMs(d, 'p1', 3)).toEqual({ ms: 1300, samples: 3 }); // 1100, 30000, 1300
  });

  it('is read at most once a minute, and a database error reads as nothing measured', () => {
    const d = db();
    let now = 5_000_000;
    const source = writeDurationSource(d, 'p1', () => now);
    expect(source()).toBeNull();
    step(d, { start: now, ms: 2000 });
    expect(source()).toBeNull(); // cached
    now += 60_000;
    expect(source()).toEqual({ ms: 2000, samples: 1 });
    d.close();
    now += 60_000;
    expect(source()).toBeNull();
  });
});
