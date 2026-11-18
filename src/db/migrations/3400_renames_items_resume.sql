-- v3 F3d (renames), ADR 0058 (the owner-approved design docs/design/F3d-renames.md): `arkona_rename`, selective
-- approval of a proposal made of items, and resuming a package that stopped part-way.
--
-- 1. Selective approval (the design's section 2, decision D5). A proposal made of ITEMS (a package's pages, a rename's
--    edits) keeps them, each with its diff and dependencies; the steps name their items. When the owner approves a
--    selection, the proposal records exactly what was approved and what was left out (the job runs only the approved
--    set), and "propose these again" records the new proposal it made of the items left out.
ALTER TABLE proposals ADD COLUMN items TEXT;              -- JSON: the items (src/jobs/items.ts `PlanItem`), or NULL
ALTER TABLE proposals ADD COLUMN approved_items TEXT;     -- JSON: the item ids approved (NULL: not decided, or whole)
ALTER TABLE proposals ADD COLUMN omitted_items TEXT;      -- JSON: the item ids left out
ALTER TABLE proposals ADD COLUMN reproposed_as TEXT;      -- the proposal made of the items left out, when there is one
ALTER TABLE proposals ADD COLUMN reproposal_of TEXT;      -- the proposal whose left-out items this one proposes again

-- 2. Resume (the design's section 3, decision D6). A job that can be resumed (a package, a rename, a recreate) and has
--    stopped part-way records where: its last VERIFIED step (every step up to it succeeded, and none of them was read
--    back different from its plan), the step it stopped at, and why. Each resume is counted and audited (`job.resume`).
CREATE TABLE job_stops (
  project_id          TEXT NOT NULL,
  job_id              TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('package', 'rename', 'recreate')),
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

-- 3. Renames (the design's section 1). One row per rename proposed: the subject, its old and new names, the proposal and
--    the job, and, once the job has ended, what the full-text index still holds of the old name on current pages that
--    the rename did not change (offered as a follow-up rename of those occurrences).
CREATE TABLE pack_renames (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  pack_id       TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,                           -- character | owner | culture | race
  old_name      TEXT NOT NULL,
  new_name      TEXT NOT NULL,
  proposal_id   TEXT,
  job_id        TEXT,
  state         TEXT NOT NULL CHECK (state IN ('proposed', 'running', 'done', 'stopped', 'closed')),
  -- JSON: the token change a culture or race rename brings ({ map, from, to, version? }), or NULL.
  token         TEXT,
  -- JSON: the old name's occurrences the full-text index still holds on current pages after the job (or NULL).
  leftovers     TEXT,
  leftovers_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX pack_renames_subject ON pack_renames (project_id, subject_id, created_at);
CREATE INDEX pack_renames_proposal ON pack_renames (proposal_id);
CREATE INDEX pack_renames_job ON pack_renames (job_id);
