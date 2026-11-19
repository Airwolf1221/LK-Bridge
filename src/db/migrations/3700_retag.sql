-- v3 F3f (ADR 0060): the retag audit, the separately approved apply, the owner's classifications and resumable
-- reconciliation, from the Controlled Native Tagging Standard's "Classification and Manual Implementation Procedure".
--
-- 1. Resume (ADR 0058, decision 3) learns a fifth kind of job, a retag apply batch. SQLite cannot change a CHECK
--    constraint in place, so `job_stops` is rebuilt with every row copied as it is (as 3600 did). Nothing references it.
CREATE TABLE job_stops_f3f (
  project_id          TEXT NOT NULL,
  job_id              TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('package', 'rename', 'recreate', 'split', 'retag')),
  last_verified_step  INTEGER NOT NULL,
  stopped_step        INTEGER,
  stopped_label       TEXT,
  reason              TEXT,
  status              TEXT NOT NULL CHECK (status IN ('failed', 'cancelled')),
  stopped_at          INTEGER NOT NULL,
  resumes             INTEGER NOT NULL DEFAULT 0,
  last_resumed_at     INTEGER,
  last_resumed_by     TEXT,
  PRIMARY KEY (project_id, job_id)
);
INSERT INTO job_stops_f3f (project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status,
    stopped_at, resumes, last_resumed_at, last_resumed_by)
  SELECT project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status, stopped_at, resumes,
    last_resumed_at, last_resumed_by FROM job_stops;
DROP TABLE job_stops;
ALTER TABLE job_stops_f3f RENAME TO job_stops;

-- 2. A pack tool's own record of a page it made (the retag's first evidence of a primary category): the page, the tool,
--    the type and role, and the primary and specialist tags its grammar gave it. Recorded when the package is captured
--    (its page ids are minted then); it counts only for a page the snapshots hold (a page left out was never made).
CREATE TABLE pack_page_records (
  project_id   TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  pack_id      TEXT NOT NULL,
  tool         TEXT NOT NULL,
  type         TEXT NOT NULL,
  role         TEXT NOT NULL,
  primary_tag  TEXT NOT NULL,
  specialist   TEXT,
  proposal_id  TEXT,
  job_id       TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id)
);

-- 3. The owner's confirmed classifications (C): set on the dashboard (re-authenticated, audited `retag.classify`), used
--    by every later audit of the page. Agents never write here; their suggestions are kept apart (4).
CREATE TABLE retag_classifications (
  project_id   TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  page_name    TEXT NOT NULL,
  primary_tag  TEXT NOT NULL,
  specialist   TEXT,
  reason       TEXT NOT NULL,
  by           TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id)
);

-- 4. An agent's suggested classification for a hold, with its reason: shown to the owner beside the hold, never used.
CREATE TABLE retag_suggestions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  primary_tag  TEXT NOT NULL,
  specialist   TEXT,
  reason       TEXT NOT NULL,
  by           TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX retag_suggestions_page ON retag_suggestions (project_id, page_id, at);

-- 5. Named reconciliation runs: a stored record across batches of what was audited, proposed, applied, held and
--    conflicted, and what remains. A completed run is never current truth: a page whose inputs changed in the snapshots
--    since is marked stale and audited again.
CREATE TABLE retag_reconciliations (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL,                     -- JSON: { all } | { under } | { pages }
  state        TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX retag_reconciliations_name ON retag_reconciliations (project_id, name);

-- 6. Audit runs (every one kept while its reconciliation or a batch names it; the latest per scope otherwise).
CREATE TABLE retag_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  pack_id            TEXT NOT NULL,
  policy             TEXT NOT NULL,               -- JSON: { packId, version, label, sources, digest }
  scope              TEXT NOT NULL,               -- JSON
  source             TEXT NOT NULL,               -- JSON: the snapshots used, live reads
  counts             TEXT NOT NULL,               -- JSON: by disposition, lifecycle-only, excluded
  reconciliation_id  TEXT,
  actor              TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX retag_runs_project ON retag_runs (project_id, created_at);

CREATE TABLE retag_run_pages (
  run_id        TEXT NOT NULL REFERENCES retag_runs (id) ON DELETE CASCADE,
  page_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('grammar', 'lifecycle', 'excluded')),
  disposition   TEXT CHECK (disposition IN ('compliant', 'correction', 'hold', 'exception')),
  verdict       TEXT NOT NULL,                    -- JSON: the engine's verdict (arrays, rationale, holds, inputs)
  inputs_hash   TEXT NOT NULL,
  PRIMARY KEY (run_id, page_id)
);
CREATE INDEX retag_run_pages_disposition ON retag_run_pages (run_id, disposition);

-- 7. Apply batches: one proposal of at most `retag.batchSize` pages from one audit run, each page an item; the job's
--    disposition per page once it has run (applied, already_compliant, held, conflicted, inaccessible).
CREATE TABLE retag_batches (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  reconciliation_id  TEXT,
  proposal_id        TEXT,
  job_id             TEXT,
  pages              TEXT NOT NULL,               -- JSON: [{ pageId, name, current, proposed }]
  state              TEXT NOT NULL CHECK (state IN ('proposed', 'running', 'done', 'stopped', 'rejected')),
  dispositions       TEXT,                        -- JSON: { pageId: { outcome, reason, verified } }
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX retag_batches_proposal ON retag_batches (proposal_id);
CREATE INDEX retag_batches_job ON retag_batches (project_id, job_id);

-- 8. A reconciliation's pages: the latest audit verdict, the latest apply outcome, and whether the snapshots show its
--    inputs changed since (stale: audited again before anything else is proposed for it).
CREATE TABLE retag_reconciliation_pages (
  reconciliation_id  TEXT NOT NULL REFERENCES retag_reconciliations (id) ON DELETE CASCADE,
  page_id            TEXT NOT NULL,
  name               TEXT NOT NULL,
  disposition        TEXT,
  outcome            TEXT CHECK (outcome IN ('applied', 'already_compliant', 'held', 'conflicted', 'inaccessible')),
  stale              INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  inputs_hash        TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  batch_id           TEXT,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (reconciliation_id, page_id)
);
