-- v2 A1: several LegendKeeper projects in one bridge (docs/PLAN-v2.md 4.1, ADR 0023).
--
-- 1. A `projects` table: the registry of LegendKeeper projects this bridge serves. Its id IS the LegendKeeper project
--    id (discovered from each key at start-up and checked on every start). Keys never live here: they stay in the
--    env file.
-- 2. Every table that holds LegendKeeper-related data gains a required `project_id`. Child tables (steps, artefacts,
--    artefact items, journal targets, proposal operations, mapping rules and field maps) reference their parent by
--    (parent id, project id), so a child can never belong to another project than its parent.
-- 3. Existing rows all belong to the project the bridge served before this release. Its id is supplied by the
--    migration runner as context `legacy_project_id` (LK_PROJECT_ID, the single-project form), with its name as
--    `legacy_project_name` (LK_PROJECT_NAME, default `test`). A database that already holds data and has no such id
--    is refused below, before anything changes.
-- 4. `bridge_instance`: the row naming the one process allowed to serve this database (ADR 0023).
--
-- How the tables are rebuilt. A required column with a foreign key cannot be added by ALTER TABLE, so each table is
-- copied into a new one. Foreign keys are enforced during migrations, and dropping a parent table would cascade-delete
-- its children's rows, so each family is copied first and then dropped CHILD FIRST (no child is left to cascade into),
-- and the new tables are renamed into place (SQLite rewrites the references). AUTOINCREMENT sequences are carried over,
-- so journal, error and run ids are never reused. Row ids and every value are copied unchanged.
--
-- hint: This migration assigns every existing row to the project the bridge served before multi-project support, and needs that project's LegendKeeper id. Run it with LK_PROJECT_ID (and LK_PROJECT_NAME if the project is not called "test") set, as the single-project env form does; see docs/runbook-deploy.md, "Moving to several projects (v2 A1)".

CREATE TEMP TABLE IF NOT EXISTS migration_context (key TEXT PRIMARY KEY, value TEXT);

-- Refuse (CHECK constraint) when the database already holds project data but no legacy project id was given.
CREATE TEMP TABLE m0600_guard (refused INTEGER NOT NULL CHECK (refused = 0));
INSERT INTO m0600_guard (refused)
SELECT CASE
  WHEN (SELECT NULLIF(value, '') FROM temp.migration_context WHERE key = 'legacy_project_id') IS NULL
   AND (EXISTS (SELECT 1 FROM jobs) OR EXISTS (SELECT 1 FROM errors) OR EXISTS (SELECT 1 FROM budget_samples)
     OR EXISTS (SELECT 1 FROM write_journal) OR EXISTS (SELECT 1 FROM proposals)
     OR EXISTS (SELECT 1 FROM governor_counters) OR EXISTS (SELECT 1 FROM maintenance_runs)
     OR EXISTS (SELECT 1 FROM mapping_sets))
  THEN 1 ELSE 0 END;
DROP TABLE temp.m0600_guard;

CREATE TEMP TABLE m0600_legacy AS
SELECT (SELECT NULLIF(value, '') FROM temp.migration_context WHERE key = 'legacy_project_id') AS id,
       COALESCE((SELECT NULLIF(value, '') FROM temp.migration_context WHERE key = 'legacy_project_name'), 'test') AS name,
       CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms;

-- ------------------------------------------------------------------------------------------------ the registry

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,                -- the LegendKeeper project id
  name          TEXT NOT NULL UNIQUE             -- the bridge's name for it (LK_PROJECTS), lowercase
                CHECK (length(name) BETWEEN 1 AND 32 AND name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_]*'),
  display_name  TEXT,                            -- LegendKeeper's own name, refreshed at each verified start
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_sandbox    INTEGER NOT NULL DEFAULT 0 CHECK (is_sandbox IN (0, 1)),
  read_only     INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  settings      TEXT NOT NULL DEFAULT '{}',      -- JSON, typed by src/projects/settings.ts
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  verified_at   INTEGER                          -- last start at which a key proved it belongs to this project
);
CREATE UNIQUE INDEX projects_one_default ON projects (is_default) WHERE is_default = 1;

INSERT INTO projects (id, name, display_name, is_default, is_sandbox, read_only, settings, created_at, updated_at)
SELECT id, name, NULL, 1, 0, 0, '{}', now_ms, now_ms FROM temp.m0600_legacy WHERE id IS NOT NULL;

-- One process per database (and so per project): ADR 0023.
CREATE TABLE bridge_instance (
  slot         INTEGER PRIMARY KEY CHECK (slot = 1),
  instance_id  TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  hostname     TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------------------------------------ jobs family

CREATE TABLE jobs_new (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id),
  kind             TEXT NOT NULL CHECK (kind IN ('single_op', 'batch_ops', 'paginate_all', 'upload_image')),
  title            TEXT NOT NULL,
  origin           TEXT NOT NULL,
  origin_kind      TEXT NOT NULL,
  principal_id     TEXT NOT NULL DEFAULT 'system',
  profile          TEXT NOT NULL DEFAULT 'system',
  approved_by      TEXT,
  priority         TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_budget', 'waiting_lock',
                                                    'paused', 'succeeded', 'failed', 'cancelled')),
  on_error         TEXT NOT NULL DEFAULT 'stop' CHECK (on_error IN ('stop', 'continue')),
  steps_total      INTEGER NOT NULL DEFAULT 0,
  steps_done       INTEGER NOT NULL DEFAULT 0,
  steps_failed     INTEGER NOT NULL DEFAULT 0,
  current_step     INTEGER,
  resume_at        INTEGER,
  wait_reason      TEXT,
  pause_requested  INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  uncertain        INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1)),
  last_error       TEXT,
  result           TEXT,
  options          TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  UNIQUE (id, project_id)
);
INSERT INTO jobs_new (id, project_id, kind, title, origin, origin_kind, principal_id, profile, approved_by, priority,
  status, on_error, steps_total, steps_done, steps_failed, current_step, resume_at, wait_reason, pause_requested,
  cancel_requested, uncertain, last_error, result, options, created_at, updated_at, started_at, finished_at)
SELECT id, (SELECT id FROM temp.m0600_legacy), kind, title, origin, origin_kind, principal_id, profile, approved_by,
  priority, status, on_error, steps_total, steps_done, steps_failed, current_step, resume_at, wait_reason,
  pause_requested, cancel_requested, uncertain, last_error, result, options, created_at, updated_at, started_at,
  finished_at
FROM jobs ORDER BY rowid;

CREATE TABLE steps_new (
  job_id             TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  step_no            INTEGER NOT NULL,
  op_id              TEXT NOT NULL,
  op_kind            TEXT NOT NULL CHECK (op_kind IN ('read', 'write', 'upload')),
  params             TEXT,
  params_artifact_id TEXT,
  params_hash        TEXT NOT NULL,
  options            TEXT,
  attempt0           INTEGER NOT NULL DEFAULT 0,
  idempotency_key    TEXT,
  client_ids         TEXT,
  if_match           TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed',
                                                      'uncertain', 'cancelled')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  maybe_sent         INTEGER NOT NULL DEFAULT 0 CHECK (maybe_sent IN (0, 1)),
  request_ids        TEXT NOT NULL DEFAULT '[]',
  result_summary     TEXT,
  result_artifact_id TEXT,
  error              TEXT,
  first_sent_at      INTEGER,
  started_at         INTEGER,
  finished_at        INTEGER,
  PRIMARY KEY (job_id, step_no),
  FOREIGN KEY (job_id, project_id) REFERENCES jobs_new (id, project_id) ON DELETE CASCADE
);
INSERT INTO steps_new (job_id, project_id, step_no, op_id, op_kind, params, params_artifact_id, params_hash, options,
  attempt0, idempotency_key, client_ids, if_match, status, attempts, maybe_sent, request_ids, result_summary,
  result_artifact_id, error, first_sent_at, started_at, finished_at)
SELECT s.job_id, j.project_id, s.step_no, s.op_id, s.op_kind, s.params, s.params_artifact_id, s.params_hash,
  s.options, s.attempt0, s.idempotency_key, s.client_ids, s.if_match, s.status, s.attempts, s.maybe_sent,
  s.request_ids, s.result_summary, s.result_artifact_id, s.error, s.first_sent_at, s.started_at, s.finished_at
FROM steps s JOIN jobs_new j ON j.id = s.job_id ORDER BY s.job_id, s.step_no;

CREATE TABLE job_artifacts_new (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  step_no          INTEGER,
  kind             TEXT NOT NULL CHECK (kind IN ('params', 'result', 'items')),
  data             TEXT,
  item_count       INTEGER NOT NULL DEFAULT 0,
  bytes            INTEGER NOT NULL DEFAULT 0,
  truncated        INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  truncated_reason TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (id, project_id),
  FOREIGN KEY (job_id, project_id) REFERENCES jobs_new (id, project_id) ON DELETE CASCADE
);
INSERT INTO job_artifacts_new (id, job_id, project_id, step_no, kind, data, item_count, bytes, truncated,
  truncated_reason, created_at, updated_at)
SELECT a.id, a.job_id, j.project_id, a.step_no, a.kind, a.data, a.item_count, a.bytes, a.truncated,
  a.truncated_reason, a.created_at, a.updated_at
FROM job_artifacts a JOIN jobs_new j ON j.id = a.job_id ORDER BY a.rowid;

CREATE TABLE job_artifact_items_new (
  artifact_id TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (artifact_id, idx),
  FOREIGN KEY (artifact_id, project_id) REFERENCES job_artifacts_new (id, project_id) ON DELETE CASCADE
);
INSERT INTO job_artifact_items_new (artifact_id, project_id, idx, data)
SELECT i.artifact_id, a.project_id, i.idx, i.data
FROM job_artifact_items i JOIN job_artifacts_new a ON a.id = i.artifact_id ORDER BY i.artifact_id, i.idx;

-- Child first: nothing is left to cascade into when a parent goes.
DROP TABLE job_artifact_items;
DROP TABLE job_artifacts;
DROP TABLE steps;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE steps_new RENAME TO steps;
ALTER TABLE job_artifacts_new RENAME TO job_artifacts;
ALTER TABLE job_artifact_items_new RENAME TO job_artifact_items;

CREATE INDEX jobs_status ON jobs (status, priority, created_at);
CREATE INDEX jobs_created ON jobs (created_at);
CREATE INDEX jobs_principal ON jobs (principal_id, created_at);
CREATE INDEX jobs_project_created ON jobs (project_id, created_at);
CREATE INDEX jobs_project_status ON jobs (project_id, status, created_at);
CREATE INDEX steps_project ON steps (project_id);
CREATE INDEX job_artifacts_job ON job_artifacts (job_id);
CREATE INDEX job_artifacts_project ON job_artifacts (project_id);
CREATE INDEX job_artifact_items_project ON job_artifact_items (project_id);

-- ------------------------------------------------------------------------------------------------ errors

CREATE TABLE errors_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL REFERENCES projects (id),
  at             INTEGER NOT NULL,
  op_id          TEXT NOT NULL,
  job_id         TEXT,
  step_no        INTEGER,
  principal_id   TEXT NOT NULL DEFAULT 'system',
  profile        TEXT NOT NULL DEFAULT 'system',
  http_status    INTEGER,
  code           TEXT,
  message        TEXT NOT NULL,
  issues         TEXT NOT NULL DEFAULT '[]',
  path           TEXT NOT NULL DEFAULT '',
  request_id     TEXT,
  retryable      INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  classification TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  detail         TEXT,
  resolved_at    INTEGER
);
INSERT INTO errors_new (id, project_id, at, op_id, job_id, step_no, principal_id, profile, http_status, code, message,
  issues, path, request_id, retryable, classification, fingerprint, detail, resolved_at)
SELECT id, (SELECT id FROM temp.m0600_legacy), at, op_id, job_id, step_no, principal_id, profile, http_status, code,
  message, issues, path, request_id, retryable, classification, fingerprint, detail, resolved_at
FROM errors ORDER BY id;

-- ------------------------------------------------------------------------------------------------ budget samples

CREATE TABLE budget_samples_new (
  project_id TEXT NOT NULL REFERENCES projects (id),
  at         INTEGER NOT NULL,
  data       TEXT NOT NULL
);
INSERT INTO budget_samples_new (project_id, at, data)
SELECT (SELECT id FROM temp.m0600_legacy), at, data FROM budget_samples ORDER BY rowid;

-- ------------------------------------------------------------------------------------------------ write journal

CREATE TABLE write_journal_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  at           INTEGER NOT NULL,
  job_id       TEXT,
  step_no      INTEGER,
  op_id        TEXT NOT NULL,
  principal_id TEXT NOT NULL DEFAULT 'system',
  profile      TEXT NOT NULL DEFAULT 'system',
  approved_by  TEXT,
  risk         TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  target_id    TEXT,
  resource_id  TEXT,
  document_id  TEXT,
  version      TEXT,
  params       TEXT,
  pre_image    TEXT,
  bytes        INTEGER NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'applied', 'not_applied', 'unknown')),
  UNIQUE (id, project_id)
);
INSERT INTO write_journal_new (id, project_id, at, job_id, step_no, op_id, principal_id, profile, approved_by, risk,
  target_kind, target_id, resource_id, document_id, version, params, pre_image, bytes, outcome)
SELECT id, (SELECT id FROM temp.m0600_legacy), at, job_id, step_no, op_id, principal_id, profile, approved_by, risk,
  target_kind, target_id, resource_id, document_id, version, params, pre_image, bytes, outcome
FROM write_journal ORDER BY id;

CREATE TABLE write_journal_targets_new (
  target_id  TEXT NOT NULL,
  journal_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (target_id, journal_id),
  FOREIGN KEY (journal_id, project_id) REFERENCES write_journal_new (id, project_id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO write_journal_targets_new (target_id, journal_id, project_id)
SELECT t.target_id, t.journal_id, w.project_id
FROM write_journal_targets t JOIN write_journal_new w ON w.id = t.journal_id;

-- ------------------------------------------------------------------------------------------------ proposals

CREATE TABLE proposals_new (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects (id),
  principal_id    TEXT NOT NULL,
  principal_label TEXT NOT NULL,
  profile         TEXT NOT NULL,
  origin          TEXT NOT NULL,
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('single_op', 'batch_ops')),
  title           TEXT NOT NULL,
  priority        TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  on_error        TEXT NOT NULL DEFAULT 'stop' CHECK (on_error IN ('stop', 'continue')),
  summary         TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'conflicted', 'expired',
                                                 'executing', 'executed', 'failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  decided_at      INTEGER,
  decided_by      TEXT,
  reject_reason   TEXT,
  job_id          TEXT,
  conflict        TEXT,
  error           TEXT,
  finished_at     INTEGER,
  UNIQUE (id, project_id)
);
INSERT INTO proposals_new (id, project_id, principal_id, principal_label, profile, origin, job_kind, title, priority,
  on_error, summary, state, created_at, updated_at, expires_at, decided_at, decided_by, reject_reason, job_id,
  conflict, error, finished_at)
SELECT id, (SELECT id FROM temp.m0600_legacy), principal_id, principal_label, profile, origin, job_kind, title,
  priority, on_error, summary, state, created_at, updated_at, expires_at, decided_at, decided_by, reject_reason,
  job_id, conflict, error, finished_at
FROM proposals ORDER BY rowid;

CREATE TABLE proposal_ops_new (
  proposal_id         TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  idx                 INTEGER NOT NULL,
  op_id               TEXT NOT NULL,
  op_kind             TEXT NOT NULL,
  params              TEXT NOT NULL,
  params_hash         TEXT NOT NULL,
  options             TEXT,
  target              TEXT,
  target_exists       INTEGER CHECK (target_exists IN (0, 1)),
  version             TEXT,
  fingerprint         TEXT,
  pre_state           TEXT,
  pre_state_truncated INTEGER NOT NULL DEFAULT 0 CHECK (pre_state_truncated IN (0, 1)),
  PRIMARY KEY (proposal_id, idx),
  FOREIGN KEY (proposal_id, project_id) REFERENCES proposals_new (id, project_id) ON DELETE CASCADE
);
INSERT INTO proposal_ops_new (proposal_id, project_id, idx, op_id, op_kind, params, params_hash, options, target,
  target_exists, version, fingerprint, pre_state, pre_state_truncated)
SELECT o.proposal_id, p.project_id, o.idx, o.op_id, o.op_kind, o.params, o.params_hash, o.options, o.target,
  o.target_exists, o.version, o.fingerprint, o.pre_state, o.pre_state_truncated
FROM proposal_ops o JOIN proposals_new p ON p.id = o.proposal_id ORDER BY o.proposal_id, o.idx;

-- ------------------------------------------------------------------------------------------------ governor counters

-- One row per project's governor. v1.0.1 kept one row under the key 'lk'; it becomes the legacy project's.
CREATE TABLE governor_counters_new (
  project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects (id), -- NOT NULL: a TEXT key may otherwise be NULL
  saved_at   INTEGER NOT NULL,
  data       TEXT NOT NULL
);
INSERT INTO governor_counters_new (project_id, saved_at, data)
SELECT (SELECT id FROM temp.m0600_legacy), saved_at, data FROM governor_counters WHERE key = 'lk';

-- ------------------------------------------------------------------------------------------------ maintenance runs

-- `project_id` is the project a per-project run worked on, or '*' for a bridge-wide run (journal and proposal
-- pruning, the budget sampler, SQLite upkeep), so it has no foreign key. Runs before this release were the one
-- project's.
CREATE TABLE maintenance_runs_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL CHECK (length(project_id) > 0),
  job_id        TEXT NOT NULL,
  trigger       TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'catch-up')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'skipped', 'interrupted')),
  duration_ms   INTEGER NOT NULL,
  engine_job_id TEXT,
  detail        TEXT
);
INSERT INTO maintenance_runs_new (id, project_id, job_id, trigger, started_at, finished_at, outcome, duration_ms,
  engine_job_id, detail)
SELECT id, (SELECT id FROM temp.m0600_legacy), job_id, trigger, started_at, finished_at, outcome, duration_ms,
  engine_job_id, detail
FROM maintenance_runs ORDER BY id;

-- ------------------------------------------------------------------------------------------------ mappings

CREATE TABLE mapping_sets_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  name        TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, name),
  UNIQUE (id, project_id)
);
INSERT INTO mapping_sets_new (id, project_id, name, description, active, notes, created_at, updated_at)
SELECT id, (SELECT id FROM temp.m0600_legacy), name, description, active, notes, created_at, updated_at
FROM mapping_sets ORDER BY rowid;

CREATE TABLE mapping_type_rules_new (
  id            TEXT PRIMARY KEY,
  set_id        TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  selector_kind TEXT NOT NULL CHECK (selector_kind IN ('subtree', 'template', 'tag')),
  selector_id   TEXT NOT NULL,
  descendants   INTEGER NOT NULL DEFAULT 1 CHECK (descendants IN (0, 1)),
  semantic_type TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (set_id, project_id) REFERENCES mapping_sets_new (id, project_id) ON DELETE CASCADE
);
INSERT INTO mapping_type_rules_new (id, set_id, project_id, selector_kind, selector_id, descendants, semantic_type,
  priority, notes, created_at, updated_at)
SELECT r.id, r.set_id, s.project_id, r.selector_kind, r.selector_id, r.descendants, r.semantic_type, r.priority,
  r.notes, r.created_at, r.updated_at
FROM mapping_type_rules r JOIN mapping_sets_new s ON s.id = r.set_id ORDER BY r.rowid;

CREATE TABLE mapping_field_maps_new (
  id             TEXT PRIMARY KEY,
  set_id         TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  semantic_type  TEXT NOT NULL,
  field_name     TEXT NOT NULL,
  location_kind  TEXT NOT NULL CHECK (location_kind IN ('sidebar_property', 'infobox_row', 'block')),
  property_title TEXT,
  infobox_title  TEXT,
  row_key        TEXT,
  heading_text   TEXT,
  block_id       TEXT,
  expected_kind  TEXT NOT NULL CHECK (expected_kind IN ('text', 'number', 'resource_link', 'list', 'date', 'boolean', 'image', 'other')),
  notes          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (set_id, semantic_type, field_name),
  FOREIGN KEY (set_id, project_id) REFERENCES mapping_sets_new (id, project_id) ON DELETE CASCADE
);
INSERT INTO mapping_field_maps_new (id, set_id, project_id, semantic_type, field_name, location_kind, property_title,
  infobox_title, row_key, heading_text, block_id, expected_kind, notes, created_at, updated_at)
SELECT f.id, f.set_id, s.project_id, f.semantic_type, f.field_name, f.location_kind, f.property_title,
  f.infobox_title, f.row_key, f.heading_text, f.block_id, f.expected_kind, f.notes, f.created_at, f.updated_at
FROM mapping_field_maps f JOIN mapping_sets_new s ON s.id = f.set_id ORDER BY f.rowid;

-- ------------------------------------------------------------------------------------------------ swap the rest in

-- AUTOINCREMENT sequences: the new tables continue from the old ones, so no id is ever reused (journal paging uses
-- ids as cursors, and errors and runs are linked by id).
INSERT INTO sqlite_sequence (name, seq)
SELECT o.name || '_new', 0 FROM sqlite_sequence o
WHERE o.name IN ('errors', 'write_journal', 'maintenance_runs')
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence n WHERE n.name = o.name || '_new');
UPDATE sqlite_sequence
SET seq = MAX(COALESCE(seq, 0),
              COALESCE((SELECT o.seq FROM sqlite_sequence o
                        WHERE o.name = substr(sqlite_sequence.name, 1, length(sqlite_sequence.name) - 4)), 0))
WHERE name IN ('errors_new', 'write_journal_new', 'maintenance_runs_new');

DROP TABLE errors;
DROP TABLE budget_samples;
DROP TABLE write_journal_targets;
DROP TABLE write_journal;
DROP TABLE proposal_ops;
DROP TABLE proposals;
DROP TABLE governor_counters;
DROP TABLE maintenance_runs;
DROP TABLE mapping_field_maps;
DROP TABLE mapping_type_rules;
DROP TABLE mapping_sets;

ALTER TABLE errors_new RENAME TO errors;
ALTER TABLE budget_samples_new RENAME TO budget_samples;
ALTER TABLE write_journal_new RENAME TO write_journal;
ALTER TABLE write_journal_targets_new RENAME TO write_journal_targets;
ALTER TABLE proposals_new RENAME TO proposals;
ALTER TABLE proposal_ops_new RENAME TO proposal_ops;
ALTER TABLE governor_counters_new RENAME TO governor_counters;
ALTER TABLE maintenance_runs_new RENAME TO maintenance_runs;
ALTER TABLE mapping_sets_new RENAME TO mapping_sets;
ALTER TABLE mapping_type_rules_new RENAME TO mapping_type_rules;
ALTER TABLE mapping_field_maps_new RENAME TO mapping_field_maps;

-- Indexes: the old ones (dropped with their tables), project-first where the queries are per project.
CREATE INDEX errors_at ON errors (at);
CREATE INDEX errors_job ON errors (job_id);
CREATE INDEX errors_project_at ON errors (project_id, at);
CREATE INDEX errors_fingerprint ON errors (project_id, fingerprint, at);
CREATE INDEX errors_principal ON errors (project_id, principal_id, at);

CREATE INDEX budget_samples_at ON budget_samples (at);
CREATE INDEX budget_samples_project ON budget_samples (project_id, at);

CREATE INDEX write_journal_at ON write_journal (at);
CREATE INDEX write_journal_job ON write_journal (job_id);
CREATE INDEX write_journal_project ON write_journal (project_id, id);
CREATE INDEX write_journal_resource ON write_journal (project_id, resource_id, id);
CREATE INDEX write_journal_document ON write_journal (project_id, document_id, id);
CREATE INDEX write_journal_principal ON write_journal (project_id, principal_id, id);
CREATE INDEX write_journal_profile ON write_journal (project_id, profile, id);
CREATE INDEX write_journal_target ON write_journal (project_id, target_id, id);
CREATE INDEX write_journal_op ON write_journal (project_id, op_id, id);
CREATE INDEX write_journal_targets_entry ON write_journal_targets (journal_id);
CREATE INDEX write_journal_targets_project ON write_journal_targets (project_id, target_id);

CREATE INDEX proposals_state ON proposals (state, created_at);
CREATE INDEX proposals_principal ON proposals (principal_id, created_at);
CREATE INDEX proposals_job ON proposals (job_id);
CREATE INDEX proposals_project ON proposals (project_id, state, created_at);
CREATE INDEX proposals_project_principal ON proposals (project_id, principal_id, created_at);
CREATE INDEX proposal_ops_project ON proposal_ops (project_id);

CREATE INDEX maintenance_runs_job ON maintenance_runs (job_id, id DESC);
CREATE INDEX maintenance_runs_project ON maintenance_runs (project_id, job_id, id DESC);

CREATE UNIQUE INDEX mapping_sets_one_active ON mapping_sets (project_id) WHERE active = 1;
CREATE INDEX mapping_type_rules_set ON mapping_type_rules (set_id);
CREATE INDEX mapping_field_maps_set ON mapping_field_maps (set_id);

DROP TABLE temp.m0600_legacy;
