-- v3 F3.4 (ADR 0055): write scope. The agents move from scope `propose` to `write`, so ordinary changes go straight
-- through and the owner reviews them afterwards. Three things are stored for that:
--
-- 1. Safety rails per profile (`agent_profiles.write_rails`, JSON, NULL = the defaults): kinds of change that still
--    become a proposal at scope `write` (deletes, bulk changes over N pages, renames and moves of pages, asset deletes
--    and moves). They can only add proposals, never remove one; canon and lifecycle stay proposals regardless.
ALTER TABLE agent_profiles ADD COLUMN write_rails TEXT;

-- The rail that turned a write into a proposal, in words ("proposed because: bulk change (14 pages > 10)").
ALTER TABLE proposals ADD COLUMN proposed_because TEXT;

-- 2. The review queue: one row per job an agent ran directly at scope `write` (no proposal, no approval), made when the
--    job is created. Listed on the dashboard's Review page once the job has finished and written something, until the
--    owner marks it reviewed (or reverts it). Approved proposals and the bridge's own work never get a row.
CREATE TABLE direct_writes (
  job_id        TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  profile       TEXT NOT NULL,
  tool          TEXT,
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER,
  reviewed_by   TEXT,
  -- How it was reviewed: `review` (one item), `bulk` (Mark all reviewed), `revert` (reverted).
  reviewed_via  TEXT CHECK (reviewed_via IS NULL OR reviewed_via IN ('review', 'bulk', 'revert'))
);
CREATE INDEX direct_writes_queue ON direct_writes (project_id, reviewed_at, created_at);

-- 3. Reverts: the owner's revert of a finished direct-write job, from the journal and the job's own record. One row per
--    revert job (a refused revert stores nothing). A revert is never itself reverted.
CREATE TABLE job_reverts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  revert_job_id  TEXT NOT NULL UNIQUE,
  state          TEXT NOT NULL CHECK (state IN ('submitted', 'succeeded', 'failed', 'cancelled')),
  -- 1 when the owner confirmed a partial revert (some targets were not reverted, each listed with why).
  partial        INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)),
  -- JSON: every target of the job, reverted or not, with what was found.
  targets        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  created_by     TEXT NOT NULL
);
CREATE INDEX job_reverts_job ON job_reverts (job_id, created_at);
