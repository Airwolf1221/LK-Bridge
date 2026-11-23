-- v3 F5c (ADR 0069; the owner-approved design docs/design/F5-orchestration.md, H6 to H8): workstreams, their default
-- label per connection, and `arkona_identity_reconcile`'s records.
--
-- 1. H8: the workstream label an agent gave (or its connection's default), on the job, the proposal and the journal
--    entry. NULL: none. A plain column on each, so a report finds its rows by index, never by parsing JSON.
ALTER TABLE jobs ADD COLUMN workstream TEXT;
CREATE INDEX jobs_workstream ON jobs (project_id, workstream, created_at) WHERE workstream IS NOT NULL;
ALTER TABLE proposals ADD COLUMN workstream TEXT;
CREATE INDEX proposals_workstream ON proposals (project_id, workstream, created_at) WHERE workstream IS NOT NULL;
ALTER TABLE write_journal ADD COLUMN workstream TEXT;
CREATE INDEX write_journal_workstream ON write_journal (project_id, workstream, id) WHERE workstream IS NOT NULL;
-- The tool-call log keeps the label a write tool's result echoed, so a refusal that made no job (FIX_STALE, an unmapped
-- value) is reported with its workstream. A label is the agent's own short text, never page content.
ALTER TABLE tool_calls ADD COLUMN workstream TEXT;
CREATE INDEX tool_calls_workstream ON tool_calls (workstream, at) WHERE workstream IS NOT NULL;

-- 2. H8: `bridge_workstream { set }`: a connection's default label, held on the server and expiring after 12 hours of
--    no use (`last_used_at`). The connection is its principal (the OAuth grant or the personal access token).
CREATE TABLE workstream_defaults (
  principal_id  TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  set_at        INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL
);

-- 3. H6: Resume (ADR 0058) learns a sixth kind of job, an identity reconcile. SQLite cannot change a CHECK constraint in
--    place, so `job_stops` is rebuilt with every row copied as it is (as 3600 and 3700 did). Nothing references it.
CREATE TABLE job_stops_f5c (
  project_id          TEXT NOT NULL,
  job_id              TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('package', 'rename', 'recreate', 'split', 'retag', 'identity')),
  last_verified_step  INTEGER NOT NULL,
  stopped_step        INTEGER,
  stopped_label       TEXT,
  reason              TEXT,
  status              TEXT NOT NULL CHECK (status IN ('failed', 'cancelled')),
  stopped_at          INTEGER NOT NULL,
  resumes             INTEGER NOT NULL DEFAULT 0,
  last_resumed_at     INTEGER,
  last_resumed_by     TEXT,
  continued_as        TEXT,
  PRIMARY KEY (project_id, job_id)
);
INSERT INTO job_stops_f5c (project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status,
    stopped_at, resumes, last_resumed_at, last_resumed_by, continued_as)
  SELECT project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status, stopped_at, resumes,
    last_resumed_at, last_resumed_by, continued_as FROM job_stops;
DROP TABLE job_stops;
ALTER TABLE job_stops_f5c RENAME TO job_stops;

-- 4. H6: one record per `arkona_identity_reconcile` call that was submitted (a job or a proposal): its plan per item
--    (the character, its identity page, the facts and tags planned, the name check, why an item was refused or held),
--    and, once its job ends, each item's outcome and the consistency follow-ups. Free to read back (the report, H8).
CREATE TABLE identity_reconciles (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  workstream   TEXT,
  job_id       TEXT,
  proposal_id  TEXT,
  state        TEXT NOT NULL CHECK (state IN ('proposed', 'running', 'finished', 'rejected')),
  plan         TEXT NOT NULL,                  -- JSON: every item as planned (refused ones included)
  outcome      TEXT,                           -- JSON: every item's outcome, once the job has ended
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX identity_reconciles_job ON identity_reconciles (project_id, job_id);
CREATE INDEX identity_reconciles_proposal ON identity_reconciles (proposal_id);
CREATE INDEX identity_reconciles_workstream ON identity_reconciles (project_id, workstream, created_at);
