/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- rows read back from SQLite and parsed dashboard results */
/**
 * v2 A1, migration 0600 (src/db/migrations/0600_projects.sql) on a v1.0.2 database. The fixture is built from the
 * CURRENT v1.0.2 schema — this repository's own migrations 0100 to 0500, applied to an empty database — and then
 * filled with rows in every table that holds LegendKeeper data, with links between them (steps and artefacts of jobs,
 * journal targets, proposal operations and the job that executed a proposal, mapping rules and field maps). After
 * the upgrade every row belongs to the legacy project, nothing is lost or changed, the links still hold, and ids and
 * AUTOINCREMENT sequences carry on.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cliMigrationContext,
  defaultMigrationsDir,
  migrationContextFromEnv,
  readEnvFileValues,
  runMigrations,
} from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { startTwoProjects } from './helpers.js';

const LEGACY = 'proj_live_legacy';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lkb-m0600-'));
  dirs.push(d);
  return d;
}

/** The v1.0.2 migrations (every one before 0600), copied out of this repository. */
function v1MigrationsDir(): string {
  const dir = tempDir();
  for (const f of readdirSync(defaultMigrationsDir())) {
    if (f.endsWith('.sql') && f < '0600') copyFileSync(join(defaultMigrationsDir(), f), join(dir, f));
  }
  return dir;
}

/** Every table that holds LegendKeeper data, with the primary key that orders its rows. */
const LK_TABLES: Record<string, string> = {
  jobs: 'id',
  steps: 'job_id, step_no',
  job_artifacts: 'id',
  job_artifact_items: 'artifact_id, idx',
  errors: 'id',
  budget_samples: 'at',
  write_journal: 'id',
  write_journal_targets: 'target_id, journal_id',
  proposals: 'id',
  proposal_ops: 'proposal_id, idx',
  governor_counters: 'saved_at',
  maintenance_runs: 'id',
  mapping_sets: 'id',
  mapping_type_rules: 'id',
  mapping_field_maps: 'id',
};
/** Tables that are not per project and must come through untouched. */
const OTHER_TABLES: Record<string, string> = {
  audit_log: 'id',
  maintenance_jobs: 'id',
  runtime_settings: 'key',
  agent_profiles: 'id',
};

const T0 = 1_780_000_000_000;

/** Rows in every LK-data table of a v1.0.2 database, linked as the bridge links them. */
function fill(db: Db): void {
  const job = db.prepare(
    `INSERT INTO jobs (id, kind, title, origin, origin_kind, principal_id, profile, approved_by, priority, status,
       steps_total, steps_done, steps_failed, result, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'P1', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  job.run(
    'j1',
    'single_op',
    'Create Kingdom',
    '{"kind":"mcp","tool":"lk_api_write"}',
    'mcp',
    'pat_a',
    'claude',
    null,
    'succeeded',
    1,
    1,
    0,
    '{"id":"r1"}',
    T0,
    T0 + 5,
    T0 + 5,
  );
  job.run(
    'j2',
    'batch_ops',
    'Proposal p1',
    '{"kind":"mcp","tool":"lk_api_batch"}',
    'mcp',
    'pat_b',
    'chatgpt',
    'owner',
    'failed',
    2,
    1,
    1,
    null,
    T0 + 10,
    T0 + 20,
    T0 + 20,
  );
  job.run(
    'j3',
    'paginate_all',
    'All resources',
    '{"kind":"ui"}',
    'ui',
    'owner',
    'owner',
    null,
    'queued',
    0,
    0,
    0,
    null,
    T0 + 30,
    T0 + 30,
    null,
  );
  const step = db.prepare(
    `INSERT INTO steps (job_id, step_no, op_id, op_kind, params, params_hash, status, attempts, request_ids, result_artifact_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  step.run(
    'j1',
    1,
    'createResource',
    'write',
    '{"body":{"name":"Kingdom"}}',
    'h1',
    'succeeded',
    1,
    '["req-1"]',
    'a2',
  );
  step.run(
    'j2',
    1,
    'updateResource',
    'write',
    '{"path":{"resourceId":"r1"}}',
    'h2',
    'succeeded',
    1,
    '["req-2"]',
    null,
  );
  step.run(
    'j2',
    2,
    'deleteResource',
    'write',
    '{"path":{"resourceId":"r2"}}',
    'h3',
    'failed',
    1,
    '["req-3"]',
    null,
  );
  const art = db.prepare(
    `INSERT INTO job_artifacts (id, job_id, step_no, kind, data, item_count, bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  art.run('a1', 'j3', null, 'items', null, 2, 40, T0 + 30, T0 + 31);
  art.run('a2', 'j1', 1, 'result', '{"id":"r1","name":"Kingdom"}', 0, 28, T0 + 5, T0 + 5);
  const item = db.prepare('INSERT INTO job_artifact_items (artifact_id, idx, data) VALUES (?, ?, ?)');
  item.run('a1', 0, '{"id":"r1"}');
  item.run('a1', 1, '{"id":"r2"}');
  const err = db.prepare(
    `INSERT INTO errors (at, op_id, job_id, step_no, principal_id, profile, http_status, code, message, retryable,
       classification, fingerprint, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  err.run(
    T0 + 20,
    'deleteResource',
    'j2',
    2,
    'pat_b',
    'chatgpt',
    404,
    'NOT_FOUND',
    'gone',
    0,
    'user_fixable',
    'deleteResource|NOT_FOUND|',
    '{}',
  );
  err.run(
    T0 + 40,
    'getResource',
    null,
    null,
    'pat_a',
    'claude',
    500,
    'INTERNAL',
    'boom',
    1,
    'transient',
    'getResource|INTERNAL|',
    null,
  );
  err.run(
    T0 + 41,
    'getResource',
    null,
    null,
    'pat_a',
    'claude',
    500,
    'INTERNAL',
    'boom',
    1,
    'transient',
    'getResource|INTERNAL|',
    null,
  );
  // A deleted row leaves the sequence ahead of MAX(id): the upgrade must not reuse id 3.
  db.prepare('DELETE FROM errors WHERE id = 3').run();
  const sample = db.prepare('INSERT INTO budget_samples (at, data) VALUES (?, ?)');
  sample.run(T0, '{"key-min":{"used":3}}');
  sample.run(T0 + 300_000, '{"key-min":{"used":9}}');
  const jr = db.prepare(
    `INSERT INTO write_journal (at, job_id, step_no, op_id, principal_id, profile, approved_by, risk, target_kind,
       target_id, resource_id, document_id, version, params, pre_image, bytes, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  jr.run(
    T0 + 5,
    'j1',
    1,
    'createResource',
    'pat_a',
    'claude',
    null,
    'create',
    'resource',
    'r1',
    'r1',
    null,
    null,
    '{}',
    null,
    2,
    'applied',
  );
  jr.run(
    T0 + 15,
    'j2',
    1,
    'updateResource',
    'pat_b',
    'chatgpt',
    'owner',
    'update',
    'resource',
    'r1',
    'r1',
    null,
    'v3',
    '{}',
    '{"name":"Old"}',
    14,
    'applied',
  );
  const target = db.prepare('INSERT INTO write_journal_targets (target_id, journal_id) VALUES (?, ?)');
  target.run('r1', 1);
  target.run('r1', 2);
  const prop = db.prepare(
    `INSERT INTO proposals (id, principal_id, principal_label, profile, origin, job_kind, title, priority, summary,
       state, created_at, updated_at, expires_at, decided_at, decided_by, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'P1', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  prop.run(
    'p1',
    'pat_b',
    'ChatGPT',
    'chatgpt',
    '{"kind":"mcp"}',
    'batch_ops',
    'Rename and delete',
    'two writes',
    'failed',
    T0 + 1,
    T0 + 20,
    T0 + 86_400_000,
    T0 + 9,
    'owner',
    'j2',
  );
  prop.run(
    'p2',
    'pat_b',
    'ChatGPT',
    'chatgpt',
    '{"kind":"mcp"}',
    'single_op',
    'Rename',
    'one write',
    'pending',
    T0 + 50,
    T0 + 50,
    T0 + 86_400_000,
    null,
    null,
    null,
  );
  const op = db.prepare(
    'INSERT INTO proposal_ops (proposal_id, idx, op_id, op_kind, params, params_hash, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  op.run('p1', 0, 'updateResource', 'write', '{}', 'h2', 'v2');
  op.run('p1', 1, 'deleteResource', 'write', '{}', 'h3', null);
  op.run('p2', 0, 'updateResource', 'write', '{}', 'h4', 'v3');
  db.prepare("INSERT INTO governor_counters (key, saved_at, data) VALUES ('lk', ?, ?)").run(
    T0 + 60,
    '{"v":1,"tiers":{}}',
  );
  const run = db.prepare(
    `INSERT INTO maintenance_runs (job_id, trigger, started_at, finished_at, outcome, duration_ms, engine_job_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  run.run('budget-sampler', 'schedule', T0, T0 + 3, 'succeeded', 3, null, 'sampled');
  run.run('journal-prune', 'manual', T0 + 100, T0 + 140, 'succeeded', 40, 'j1', 'pruned 0');
  db.prepare(
    `INSERT INTO mapping_sets (id, name, description, active, notes, created_at, updated_at)
     VALUES ('ms1', 'Baisheng taxonomy', 'main', 1, '', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO mapping_type_rules (id, set_id, selector_kind, selector_id, semantic_type, created_at, updated_at)
     VALUES ('mr1', 'ms1', 'subtree', 'r1', 'Character', ?, ?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO mapping_field_maps (id, set_id, semantic_type, field_name, location_kind, property_title, expected_kind,
       created_at, updated_at)
     VALUES ('mf1', 'ms1', 'Character', 'born', 'sidebar_property', 'Born', 'date', ?, ?)`,
  ).run(T0, T0);
  // Data that is not per project.
  db.prepare(
    "INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES ('readOnly', 'false', ?, 'owner')",
  ).run(T0);
}

type Rows = Record<string, Record<string, unknown>[]>;
function snapshot(db: Db, tables: Record<string, string>): Rows {
  const out: Rows = {};
  for (const [t, order] of Object.entries(tables)) {
    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as Record<string, unknown>[];
  }
  return out;
}
const without = (rows: Record<string, unknown>[], col: string) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== col)));

function v1Database(): { db: Db; path: string } {
  const path = join(tempDir(), 'bridge.db');
  const db = openDatabase(path);
  runMigrations(db, v1MigrationsDir());
  fill(db);
  return { db, path };
}

describe('migration 0600 on a v1.0.2 database', () => {
  it('the fixture really is v1.0.2: the current schema up to 0500, with rows in every LK-data table', () => {
    const { db } = v1Database();
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]
    ).map((r) => r.version);
    expect(versions.at(-1)).toBe('0500');
    expect(versions).not.toContain('0600');
    for (const t of Object.keys(LK_TABLES)) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBeGreaterThan(0);
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols, t).not.toContain('project_id');
    }
    db.close();
  });

  it('assigns every row to the legacy project; nothing is lost or changed; links and sequences hold', () => {
    const { db } = v1Database();
    const before = snapshot(db, LK_TABLES);
    const beforeOther = snapshot(db, OTHER_TABLES);
    const seqBefore = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();

    const result = runMigrations(db, undefined, {
      context: migrationContextFromEnv({ LK_PROJECT_ID: LEGACY, LK_PROJECT_NAME: 'Test' }),
    });
    expect(result.applied).toEqual([
      '0600_projects.sql',
      '0700_repository_tree.sql',
      '0800_type_registry.sql',
      '0900_asset_tree.sql',
    ]);

    // The registry holds the legacy project, as the default.
    expect(
      db.prepare('SELECT id, name, is_default, is_sandbox, read_only, settings FROM projects').all(),
    ).toEqual([{ id: LEGACY, name: 'test', is_default: 1, is_sandbox: 0, read_only: 0, settings: '{}' }]);

    const after = snapshot(db, { ...LK_TABLES, governor_counters: 'project_id' });
    for (const [t, rows] of Object.entries(before)) {
      const now = after[t]!;
      // Every row kept, every one now in the legacy project (the column is required).
      expect(now.length, t).toBe(rows.length);
      for (const r of now) expect(r.project_id, t).toBe(LEGACY);
      const notNull = (
        db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[]
      ).find((c) => c.name === 'project_id');
      expect(notNull?.notnull, t).toBe(1);
      // Every other value unchanged (governor_counters' old key 'lk' became the project id).
      if (t === 'governor_counters') {
        expect(without(now, 'project_id'), t).toEqual(without(rows, 'key'));
      } else {
        expect(without(now, 'project_id'), t).toEqual(rows);
      }
    }
    // Tables that are not per project are untouched.
    expect(snapshot(db, OTHER_TABLES)).toEqual(beforeOther);

    // Links and integrity.
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    // AUTOINCREMENT sequences carried over: no id is reused.
    expect(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).toEqual(seqBefore);
    const next = db
      .prepare(
        `INSERT INTO errors (project_id, at, op_id, message, retryable, classification, fingerprint)
         VALUES (?, 1, 'x', 'm', 0, 'c', 'f') RETURNING id`,
      )
      .get(LEGACY) as { id: number };
    expect(next.id).toBe(4);

    // A child can never belong to another project than its parent.
    db.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_other', 'other', 0, 0)",
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO steps (job_id, project_id, step_no, op_id, op_kind, params_hash, status)
           VALUES ('j1', 'proj_other', 9, 'getResource', 'read', 'h', 'pending')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    // Deleting a job still cascades to its own steps and artefacts.
    db.prepare("DELETE FROM jobs WHERE id = 'j3'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_artifact_items WHERE artifact_id = 'a1'").get()).toEqual(
      { n: 0 },
    );
    db.close();
  });

  it('is refused, changing nothing, when the database holds data and no legacy project id is given', () => {
    const { db } = v1Database();
    const before = snapshot(db, LK_TABLES);
    expect(() => runMigrations(db)).toThrow(/0600[\s\S]*LK_PROJECT_ID/);
    expect(
      (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map(
        (r) => r.version,
      ),
    ).not.toContain('0600');
    expect(snapshot(db, LK_TABLES)).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").all()).toEqual([]);
    db.close();
  });

  it('an empty v1.0.2 database upgrades without a legacy id (the projects are registered at start-up)', () => {
    const db = openDatabase(join(tempDir(), 'bridge.db'));
    runMigrations(db, v1MigrationsDir());
    expect(runMigrations(db).applied).toEqual([
      '0600_projects.sql',
      '0700_repository_tree.sql',
      '0800_type_registry.sql',
      '0900_asset_tree.sql',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
    db.close();
  });

  it('the upgraded database boots in the single-project env form, and its old jobs, journal and proposals show', async () => {
    const { db, path } = v1Database();
    runMigrations(db, undefined, { context: migrationContextFromEnv({ LK_PROJECT_ID: LEGACY }) });
    db.close();
    const t = await startTwoProjects({
      reportedIds: { alpha: LEGACY },
      env: {
        LK_PROJECTS: '',
        LK_PROJECT_ALPHA_API_KEY: '',
        LK_PROJECT_BETA_API_KEY: '',
        LK_DEFAULT_PROJECT: '',
        LK_API_KEY: 'mock-key-alpha-not-real',
        LK_PROJECT_ID: LEGACY,
      },
      stack: { dbPath: path },
    });
    try {
      expect(t.stack.runtime.projects.list().map((p) => [p.name, p.id, p.status])).toEqual([
        ['test', LEGACY, 'active'],
      ]);
      const jobs = await t.admin.get('/jobs');
      expect(jobs.json.jobs.map((j: { id: string }) => j.id).sort()).toEqual(['j1', 'j2', 'j3']);
      const journal = await t.admin.get('/journal?project=test');
      expect(journal.json.entries).toHaveLength(2);
      const proposals = await t.admin.get(`/proposals?project=${LEGACY}`);
      expect(proposals.json.proposals.map((p: { id: string }) => p.id).sort()).toEqual(['p1', 'p2']);
      const mappings = await t.admin.get('/mappings');
      expect(mappings.json.sets.map((s: { name: string }) => s.name)).toEqual(['Baisheng taxonomy']);
    } finally {
      await t.close();
    }
  });

  it('the context names the legacy project from LK_PROJECT_NAME (lowercased), default "test"', () => {
    expect(migrationContextFromEnv({ LK_PROJECT_ID: 'p', LK_PROJECT_NAME: 'Arkona' })).toEqual({
      legacy_project_id: 'p',
      legacy_project_name: 'arkona',
    });
    expect(migrationContextFromEnv({ LK_PROJECT_ID: 'p' }).legacy_project_name ?? 'test').toBe('test');
  });
});

describe('npm run db:migrate finds the legacy project id', () => {
  // A deploy script installed before this release runs the migration with DB_PATH only (`env -i`): the id must then
  // come from the bridge's env file, or migration 0600 would refuse and the deploy would stop.
  const file = join(tempDir(), 'lk-bridge.env');
  writeFileSync(
    file,
    [
      '# a comment',
      'LK_API_KEY=key-not-real',
      'LK_PROJECT_ID=proj_old',
      "LK_PROJECT_ID='proj_from_file'",
      ' LK_PROJECT_NAME="Campaign" ',
      'NOT_ASKED=1',
    ].join('\n'),
  );

  it('reads only the names asked for, the last line winning, quotes removed', () => {
    expect(readEnvFileValues(file, ['LK_PROJECT_ID', 'LK_PROJECT_NAME'])).toEqual({
      LK_PROJECT_ID: 'proj_from_file',
      LK_PROJECT_NAME: 'Campaign',
    });
    expect(readEnvFileValues(join(tempDir(), 'missing.env'), ['LK_PROJECT_ID'])).toEqual({});
  });

  it('prefers the environment, falls back to the env file, and says which (never a value)', () => {
    expect(cliMigrationContext({ LK_PROJECT_ID: 'proj_env', LKB_ENV_FILE: file })).toEqual({
      context: { legacy_project_id: 'proj_env', legacy_project_name: null },
      source: 'environment',
    });
    expect(cliMigrationContext({ LKB_ENV_FILE: file })).toEqual({
      context: { legacy_project_id: 'proj_from_file', legacy_project_name: 'campaign' },
      source: 'env file',
    });
    expect(cliMigrationContext({ LKB_ENV_FILE: join(tempDir(), 'missing.env') }).source).toBe('none');
  });

  it('with the env-file context, a v1.0.2 database with data upgrades', () => {
    const { db } = v1Database();
    const { context } = cliMigrationContext({ LKB_ENV_FILE: file });
    expect(runMigrations(db, undefined, { context }).applied).toEqual([
      '0600_projects.sql',
      '0700_repository_tree.sql',
      '0800_type_registry.sql',
      '0900_asset_tree.sql',
    ]);
    expect(db.prepare('SELECT id, name FROM projects').all()).toEqual([
      { id: 'proj_from_file', name: 'campaign' },
    ]);
    db.close();
  });
});
