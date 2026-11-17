-- v3 F3.5 (ADR 0056): the block-id sweep (`assign-block-ids-sweep`), a narrow, explicitly approved automation that gives
-- legacy page documents block ids, one `assignBlockIds` per document. Three things are stored:
--
-- 1. The sandbox check's verdicts (test/sandbox/assign-block-ids.test.ts records them in the bridge's database). The job
--    can be enabled only with a PASS recorded for the running bridge version, or the owner's override (below).
CREATE TABLE block_id_sandbox_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bridge_version  TEXT NOT NULL,
  -- The sandbox project's name, as the bridge registers it.
  project         TEXT NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN ('PASS', 'NOTED', 'FAIL')),
  detail          TEXT,
  at              INTEGER NOT NULL
);
CREATE INDEX block_id_sandbox_checks_version ON block_id_sandbox_checks (bridge_version, verdict, at);

-- 2. The sweep's own settings and state (one row): the most documents a run does, the owner's override of the sandbox
--    check (set and cleared with re-authentication, audited), and the stop a verification failure left (shown in red on
--    the Maintenance page until the owner enables the job again, which acknowledges it).
CREATE TABLE block_id_sweep_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  max_per_run       INTEGER NOT NULL DEFAULT 20 CHECK (max_per_run BETWEEN 1 AND 500),
  override_at       INTEGER,
  override_by       TEXT,
  -- JSON: the project, page, document, job, journal entry and the differences found.
  stop_detail       TEXT,
  stopped_at        INTEGER,
  stop_acknowledged_at INTEGER,
  updated_at        INTEGER NOT NULL
);
INSERT INTO block_id_sweep_state (id, max_per_run, updated_at) VALUES (1, 20, 0);

-- 3. What the sweep did to each document it touched, latest first: `done` (ids given and verified), `already` (the live
--    read found it clean), `moved` (an edit since the read: skipped, retried next run), `unverified` (the write's outcome
--    is not known: checked first next run), `failed` (the verification failed: the sweep stopped), `gone`, `error`.
CREATE TABLE block_id_sweep_docs (
  project_id   TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('done', 'already', 'moved', 'unverified', 'failed', 'gone', 'error')),
  job_id       TEXT,
  journal_id   INTEGER,
  assigned     INTEGER,
  detail       TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, document_id)
);
CREATE INDEX block_id_sweep_docs_status ON block_id_sweep_docs (project_id, status, updated_at);
