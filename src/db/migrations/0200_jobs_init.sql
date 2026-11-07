-- Chunk 2: job engine, writers, errors, budget samples, write journal and runtime settings (PLAN §6).
-- Times are Unix milliseconds. JSON columns hold compact JSON text.

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('single_op', 'batch_ops', 'paginate_all', 'upload_image')),
  title            TEXT NOT NULL,
  origin           TEXT NOT NULL,                 -- JSON: { kind, client?, tool?, detail? }
  origin_kind      TEXT NOT NULL,                 -- copy of origin.kind, for filtering
  priority         TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_budget', 'waiting_lock',
                                                    'paused', 'succeeded', 'failed', 'cancelled')),
  on_error         TEXT NOT NULL DEFAULT 'stop' CHECK (on_error IN ('stop', 'continue')),
  steps_total      INTEGER NOT NULL DEFAULT 0,
  steps_done       INTEGER NOT NULL DEFAULT 0,
  steps_failed     INTEGER NOT NULL DEFAULT 0,
  current_step     INTEGER,
  resume_at        INTEGER,                       -- waiting_budget: when to resume
  wait_reason      TEXT,                          -- JSON: why it is waiting or held
  pause_requested  INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  uncertain        INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1)),
  last_error       TEXT,                          -- JSON
  result           TEXT,                          -- JSON summary
  options          TEXT,                          -- JSON: kind-specific options (paginate_all)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);
CREATE INDEX jobs_status ON jobs (status, priority, created_at);
CREATE INDEX jobs_created ON jobs (created_at);

CREATE TABLE steps (
  job_id             TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  step_no            INTEGER NOT NULL,
  op_id              TEXT NOT NULL,
  op_kind            TEXT NOT NULL CHECK (op_kind IN ('read', 'write', 'upload')),
  params             TEXT,                        -- JSON; NULL when stored as an artefact
  params_artifact_id TEXT,
  params_hash        TEXT NOT NULL,               -- SHA-256 of the params JSON
  options            TEXT,                        -- JSON: allowUnsupportedLoss, confirm
  attempt0           INTEGER NOT NULL DEFAULT 0,  -- bumped only by an explicit retry of a failed step
  idempotency_key    TEXT,                        -- lkb.{jobId}.{stepNo}.{attempt0}, POST only
  client_ids         TEXT,                        -- JSON array of ids minted before the first send
  if_match           TEXT,                        -- version sent as If-Match
  status             TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed',
                                                      'uncertain', 'cancelled')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  maybe_sent         INTEGER NOT NULL DEFAULT 0 CHECK (maybe_sent IN (0, 1)),
  request_ids        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  result_summary     TEXT,                        -- JSON
  result_artifact_id TEXT,
  error              TEXT,                        -- JSON
  first_sent_at      INTEGER,
  started_at         INTEGER,
  finished_at        INTEGER,
  PRIMARY KEY (job_id, step_no)
);

-- Stored outputs and oversized inputs. `items` rows hold list results (paginate_all) in order, so they page.
CREATE TABLE job_artifacts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  step_no      INTEGER,
  kind         TEXT NOT NULL CHECK (kind IN ('params', 'result', 'items')),
  data         TEXT,                              -- JSON for params/result
  item_count   INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  truncated_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX job_artifacts_job ON job_artifacts (job_id);

CREATE TABLE job_artifact_items (
  artifact_id TEXT NOT NULL REFERENCES job_artifacts (id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (artifact_id, idx)
);

-- Every failed call (PLAN §6.3). Grouped by fingerprint (op + code + path); a group is resolved when every row
-- in it is, so a recurrence after "mark resolved" reopens the group by itself.
CREATE TABLE errors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  op_id          TEXT NOT NULL,
  job_id         TEXT,
  step_no        INTEGER,
  http_status    INTEGER,
  code           TEXT,
  message        TEXT NOT NULL,
  issues         TEXT NOT NULL DEFAULT '[]',      -- JSON errors[] ({ path, message })
  path           TEXT NOT NULL DEFAULT '',        -- first errors[] path, part of the fingerprint
  request_id     TEXT,
  retryable      INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  classification TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  detail         TEXT,                            -- JSON: the full error, safe to show
  resolved_at    INTEGER
);
CREATE INDEX errors_fingerprint ON errors (fingerprint, at);
CREATE INDEX errors_at ON errors (at);
CREATE INDEX errors_job ON errors (job_id);

CREATE TABLE budget_samples (
  at   INTEGER NOT NULL,
  data TEXT NOT NULL                              -- JSON: compact per-tier used/limit/remaining and queues
);
CREATE INDEX budget_samples_at ON budget_samples (at);

-- Pre-images captured before destructive writes (PLAN §6.4). View-only in v1.
CREATE TABLE write_journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  job_id      TEXT,
  step_no     INTEGER,
  op_id       TEXT NOT NULL,
  risk        TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT,
  resource_id TEXT,
  document_id TEXT,
  version     TEXT,
  params      TEXT,                               -- JSON: the write's input (ids, flags), capped
  pre_image   TEXT,                               -- JSON, NULL for id-only entries
  bytes       INTEGER NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'applied', 'not_applied', 'unknown'))
);
CREATE INDEX write_journal_at ON write_journal (at);
CREATE INDEX write_journal_resource ON write_journal (resource_id, at);
CREATE INDEX write_journal_document ON write_journal (document_id, at);
CREATE INDEX write_journal_job ON write_journal (job_id);

CREATE TABLE runtime_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                       -- JSON
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
