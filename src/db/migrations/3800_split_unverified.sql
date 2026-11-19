-- CR-2026-11-R3 (R3-67): a split whose phase 1 ran to its end but whose job's verification found differences is
-- `unverified` (never `verified`, and nothing is retired): the split takes "verified" from its job's verification only.
-- SQLite cannot change a CHECK constraint in place, so `pack_splits` is rebuilt with every row copied as it is (as 3600
-- and 3700 did for `job_stops`). Nothing references it.
CREATE TABLE pack_splits_r3 (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  pack_id               TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  source_name           TEXT NOT NULL,
  retire                INTEGER NOT NULL DEFAULT 0 CHECK (retire IN (0, 1)),
  proposal_id           TEXT,
  job_id                TEXT,
  state                 TEXT NOT NULL CHECK (state IN ('proposed', 'running', 'verified', 'unverified', 'stopped',
                                                       'retiring', 'retired', 'reverted', 'closed')),
  -- JSON: the destinations as planned ({ key, kind, item, page, isNew, sections }), the items, the new pages, and the
  -- source's upgrade to its Character Core when the split makes one (R3-66).
  plan                  TEXT NOT NULL,
  -- Phase 2: the archive proposal the bridge made, or why there is none (JSON { proposalId?, reason? }).
  phase2                TEXT,
  -- A revert of phase 1: the revert job and the proposal deleting the pages it made (JSON).
  revert                TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
INSERT INTO pack_splits_r3 (id, project_id, pack_id, source_id, source_name, retire, proposal_id, job_id, state, plan,
    phase2, revert, created_at, updated_at)
  SELECT id, project_id, pack_id, source_id, source_name, retire, proposal_id, job_id, state, plan, phase2, revert,
    created_at, updated_at FROM pack_splits;
DROP TABLE pack_splits;
ALTER TABLE pack_splits_r3 RENAME TO pack_splits;
CREATE INDEX pack_splits_source ON pack_splits (project_id, source_id, created_at);
CREATE INDEX pack_splits_proposal ON pack_splits (proposal_id);
CREATE INDEX pack_splits_job ON pack_splits (job_id);
