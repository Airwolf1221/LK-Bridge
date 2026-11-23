-- v3 F5b (ADR 0068; the owner-approved design docs/design/F5-orchestration.md, H5): automatic actions for audits,
-- switched on one finding code at a time.
--
-- 1. Each code's setting per project: off (the default: no row), propose or apply; changed only by the owner with the
--    step-up. The engine itself only ever lowers a setting (a stop condition switches the code off) or pauses it (three
--    skips in a row for one reason, or a guard catching a change); the owner resumes it.
CREATE TABLE automation_settings (
  project_id          TEXT NOT NULL,
  code                TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('off', 'propose', 'apply')),
  updated_at          INTEGER NOT NULL,
  updated_by          TEXT NOT NULL,
  -- Paused for the owner's review (the setting stays; nothing runs until the owner resumes it).
  paused_at           INTEGER,
  paused_reason       TEXT,
  -- Why the engine last switched it off (a stop condition), shown until the owner changes the setting again.
  stopped_at          INTEGER,
  stopped_reason      TEXT,
  -- The run of skips for one reason (three in a row pause the code).
  skip_reason         TEXT,
  skip_streak         INTEGER NOT NULL DEFAULT 0,
  -- A governance amendment owed (its write failed): tried again before the next run.
  governance_pending  TEXT,
  PRIMARY KEY (project_id, code)
);

-- 2. Every change of a setting, journalled: the principal (the owner, or the bridge for a stop), the date, and the
--    governance write it caused (the job that wrote or amended the code's paragraph).
CREATE TABLE automation_changes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          TEXT NOT NULL,
  code                TEXT NOT NULL,
  from_mode           TEXT NOT NULL,
  to_mode             TEXT NOT NULL,
  principal           TEXT NOT NULL,
  at                  INTEGER NOT NULL,
  reason              TEXT,
  governance_job_id   TEXT,
  governance_state    TEXT NOT NULL CHECK (governance_state IN ('written', 'pending', 'failed', 'none'))
);
CREATE INDEX automation_changes_code ON automation_changes (project_id, code, id);

-- 3. The bridge-wide brake: "Pause all automation" (one click), resumed by the owner with the step-up.
CREATE TABLE automation_global (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  paused              INTEGER NOT NULL DEFAULT 0,
  paused_at           INTEGER,
  paused_by           TEXT
);
INSERT INTO automation_global (id, paused) VALUES (1, 0);

-- 4. Each run (nightly or on demand) and what it did with each finding.
CREATE TABLE automation_runs (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  trigger             TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  state               TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'stopped', 'skipped', 'failed')),
  summary             TEXT,
  stop_reason         TEXT
);
CREATE INDEX automation_runs_project ON automation_runs (project_id, started_at);

CREATE TABLE automation_run_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  code                TEXT NOT NULL,
  page_id             TEXT,
  page_name           TEXT,
  outcome             TEXT NOT NULL CHECK (outcome IN ('applied', 'proposed', 'skipped', 'guarded', 'failed', 'stopped')),
  reason_code         TEXT,
  reason              TEXT,
  job_id              TEXT,
  proposal_id         TEXT,
  at                  INTEGER NOT NULL
);
CREATE INDEX automation_run_items_run ON automation_run_items (run_id, id);
CREATE INDEX automation_run_items_code ON automation_run_items (project_id, code, id);

-- 5. The bridge-managed paragraphs of Repository Automation's "Approved Narrow Automations": one per code, its text
--    exactly as the bridge last wrote it (a paragraph that no longer reads so was edited outside the bridge).
CREATE TABLE automation_paragraphs (
  project_id          TEXT NOT NULL,
  code                TEXT NOT NULL,
  resource_id         TEXT NOT NULL,
  document_id         TEXT NOT NULL,
  block_id            TEXT NOT NULL,
  text                TEXT NOT NULL,
  job_id              TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (project_id, code)
);

-- 6. Each governance write's job: the document before it and as planned after it, so the pack's approval can be carried
--    over the bridge's own write (and over its Revert), and a Revert of the paragraph switches the code off.
CREATE TABLE automation_governance_jobs (
  job_id              TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  code                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('enable', 'amend', 'disable')),
  change_id           INTEGER,
  resource_id         TEXT NOT NULL,
  document_id         TEXT NOT NULL,
  block_id            TEXT NOT NULL,
  before_version      TEXT NOT NULL,
  before_blocks       TEXT NOT NULL,
  planned_blocks      TEXT NOT NULL,
  previous_text       TEXT,
  text                TEXT NOT NULL,
  at                  INTEGER NOT NULL
);
