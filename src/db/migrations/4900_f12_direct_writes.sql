-- v3 F12 (ADR 0081): agents write directly at scope `write`; the Review page is the safety net; the proposal system holds
-- only what the owner's automation codes at Propose (and a connection at scope `propose`) produce.

-- 1. The safety rails are gone (ADR 0055 decision C retired): the per-profile switches with them.
ALTER TABLE agent_profiles DROP COLUMN write_rails;

-- 2. A restore runs as a job when the owner confirms it on the dashboard, or an agent at scope `write` asks for it: the
--    record follows the job (`job_id`, and the content stage's `follow_up_job_id`) instead of a proposal, and is
--    `running` until that job ends. The table is rebuilt for the new state (SQLite cannot change a CHECK in place).
CREATE TABLE snapshot_restores_f12 (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects (id),
  page_id                TEXT NOT NULL,
  page_name              TEXT NOT NULL,
  snapshot_id            TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  mode                   TEXT,
  document_id            TEXT,
  proposal_id            TEXT,
  job_id                 TEXT,
  state                  TEXT NOT NULL CHECK (state IN ('proposed', 'running', 'executed', 'failed', 'closed')),
  follow_up              TEXT,
  follow_up_proposal_id  TEXT,
  follow_up_job_id       TEXT,
  requested_by           TEXT NOT NULL,
  summary                TEXT NOT NULL,
  plan                   TEXT NOT NULL DEFAULT '{}',
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
INSERT INTO snapshot_restores_f12 (id, project_id, page_id, page_name, snapshot_id, scope, mode, document_id,
  proposal_id, state, follow_up, follow_up_proposal_id, requested_by, summary, plan, created_at, updated_at)
  SELECT id, project_id, page_id, page_name, snapshot_id, scope, mode, document_id, proposal_id, state, follow_up,
    follow_up_proposal_id, requested_by, summary, plan, created_at, updated_at
  FROM snapshot_restores;
DROP TABLE snapshot_restores;
ALTER TABLE snapshot_restores_f12 RENAME TO snapshot_restores;
CREATE INDEX snapshot_restores_proposal ON snapshot_restores (proposal_id);
CREATE INDEX snapshot_restores_job ON snapshot_restores (project_id, job_id);
CREATE INDEX snapshot_restores_page ON snapshot_restores (project_id, page_id, created_at);

-- 3. The owner's consistency pick, confirmed in its dialog, runs its edits at once: the pick records its job.
ALTER TABLE consistency_picks ADD COLUMN job_id TEXT;
CREATE INDEX consistency_picks_job ON consistency_picks (project_id, job_id);

-- 4. D3: the restorable copy the bridge keeps before an agent's delete of a page (with its subtree, for a cascade) or a
--    document: the pages as read just before (a change snapshot, `snapshot_id`), parents before children, and what it
--    cost. Revert finds the copy here; the snapshot pruner keeps a snapshot a copy names for DELETE_COPY_RETENTION_DAYS.
CREATE TABLE delete_copies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  step_no      INTEGER NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('deleteResource', 'deleteDocument')),
  resource_id  TEXT NOT NULL,
  document_id  TEXT,
  snapshot_id  TEXT NOT NULL,
  pages        TEXT NOT NULL,                   -- JSON [{ id, name, parentId, rank }], the root first
  reads        INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  UNIQUE (job_id, step_no)
);
CREATE INDEX delete_copies_snapshot ON delete_copies (snapshot_id);
CREATE INDEX delete_copies_project ON delete_copies (project_id, at);
