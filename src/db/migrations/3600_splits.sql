-- v3 F3e (ADR 0059; the owner-approved design docs/design/F3e-splits.md): `arkona_split_owner` and its two phases.
--
-- 1. Resume (ADR 0058, decision 3) learns a fourth kind of job, a split's phase 1. SQLite cannot change a CHECK
--    constraint in place, so `job_stops` is rebuilt with every row copied as it is. Nothing references it.
CREATE TABLE job_stops_f3e (
  project_id          TEXT NOT NULL,
  job_id              TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('package', 'rename', 'recreate', 'split')),
  last_verified_step  INTEGER NOT NULL,                  -- 0: none
  stopped_step        INTEGER,                           -- the first step that did not succeed
  stopped_label       TEXT,
  reason              TEXT,
  status              TEXT NOT NULL CHECK (status IN ('failed', 'cancelled')),
  stopped_at          INTEGER NOT NULL,
  resumes             INTEGER NOT NULL DEFAULT 0,
  last_resumed_at     INTEGER,
  last_resumed_by     TEXT,
  PRIMARY KEY (project_id, job_id)
);
INSERT INTO job_stops_f3e (project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status,
    stopped_at, resumes, last_resumed_at, last_resumed_by)
  SELECT project_id, job_id, kind, last_verified_step, stopped_step, stopped_label, reason, status, stopped_at, resumes,
    last_resumed_at, last_resumed_by FROM job_stops;
DROP TABLE job_stops;
ALTER TABLE job_stops_f3e RENAME TO job_stops;

-- 2. Splits (the design's section 2). One row per split proposed: the source, whether it is to be retired, the phase 1
--    proposal and job, and what followed: phase 1's verification, phase 2's archive proposal (D2: made by the bridge
--    once phase 1 has verified, never a delete), or why there is none; a revert of phase 1 and the proposal that deletes
--    the pages it made.
CREATE TABLE pack_splits (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  pack_id               TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  source_name           TEXT NOT NULL,
  retire                INTEGER NOT NULL DEFAULT 0 CHECK (retire IN (0, 1)),
  proposal_id           TEXT,
  job_id                TEXT,
  state                 TEXT NOT NULL CHECK (state IN ('proposed', 'running', 'verified', 'stopped', 'retiring',
                                                       'retired', 'reverted', 'closed')),
  -- JSON: the destinations as planned ({ key, kind, item, page, isNew, sections }), the items, the new pages.
  plan                  TEXT NOT NULL,
  -- Phase 2: the archive proposal the bridge made, or why there is none (JSON { proposalId?, reason? }).
  phase2                TEXT,
  -- A revert of phase 1: the revert job and the proposal deleting the pages it made (JSON).
  revert                TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX pack_splits_source ON pack_splits (project_id, source_id, created_at);
CREATE INDEX pack_splits_proposal ON pack_splits (proposal_id);
CREATE INDEX pack_splits_job ON pack_splits (job_id);
