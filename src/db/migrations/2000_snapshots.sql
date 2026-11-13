-- v2 E1a (ADR 0042): snapshots, restore and the rehearsal.
--
-- The snapshot store itself is on disk (SNAPSHOT_DIR, default `snapshots/` next to the database): content-addressed
-- objects and one manifest file per complete snapshot. The manifests are the truth; these tables are the bridge's
-- index of them (rebuilt from the manifest files when a row is missing), its run state, and its findings. Everything
-- here is copied by the nightly database backup (deploy/backup.sh) like every other table.

-- 1. One row per snapshot whose manifest is written (`complete`), or written with pieces missing (`partial`). A verify
--    that finds a missing or corrupt piece marks every snapshot that uses it `partial` (never silently "fine").
CREATE TABLE snapshots (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (id),
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'change', 'daily')),
  state         TEXT NOT NULL CHECK (state IN ('complete', 'partial')),
  taken_at      INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  pages         INTEGER NOT NULL,
  pieces        INTEGER NOT NULL,
  -- Bytes of the pieces it refers to (uncompressed), and what it added to the store (compressed, on disk).
  logical_bytes INTEGER NOT NULL DEFAULT 0,
  new_objects   INTEGER NOT NULL DEFAULT 0,
  new_bytes     INTEGER NOT NULL DEFAULT 0,
  reads         INTEGER NOT NULL DEFAULT 0,
  downloads     INTEGER NOT NULL DEFAULT 0,
  missing       INTEGER NOT NULL DEFAULT 0,
  -- The manifest's path inside the store (`manifests/<project>/<id>.json.gz`).
  path          TEXT NOT NULL,
  -- What made it: a change snapshot's job, tool and principal; a full or daily snapshot's run.
  trigger       TEXT NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL DEFAULT '',
  damaged       TEXT
);
CREATE INDEX snapshots_project ON snapshots (project_id, taken_at);
CREATE INDEX snapshots_kind ON snapshots (project_id, kind, taken_at);

-- 2. Every piece a snapshot refers to, one row each: the per-page history, and the references the garbage collector
--    keeps. `piece` is `resource`, `sidebar`, `document`, `image` (a page's image, `ref` its URL), `library` (the asset
--    library), `asset` (one library image, `ref` its asset id) or `deleted` (the page was deleted; no hash).
CREATE TABLE snapshot_pieces (
  snapshot_id  TEXT NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  piece        TEXT NOT NULL,
  ref          TEXT NOT NULL DEFAULT '',
  doc_type     TEXT,
  name         TEXT,
  sha256       TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  taken_at     INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, page_id, piece, ref)
);
CREATE INDEX snapshot_pieces_page ON snapshot_pieces (project_id, page_id, piece, ref, taken_at);
CREATE INDEX snapshot_pieces_sha ON snapshot_pieces (sha256);
-- An image's bytes by its URL (a page's `image` pieces by `ref`, the library's `asset` pieces by `name`).
CREATE INDEX snapshot_pieces_ref ON snapshot_pieces (project_id, piece, ref);
CREATE INDEX snapshot_pieces_name ON snapshot_pieces (project_id, piece, name);

-- 3. A full snapshot or a daily pass in progress, and its pages: what is done is kept, so an interrupted run continues
--    where it stopped. A manifest is written only when the run completes.
CREATE TABLE snapshot_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  kind         TEXT NOT NULL CHECK (kind IN ('full', 'daily')),
  state        TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'refused', 'stopped')),
  trigger      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  root_id      TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  reads        INTEGER NOT NULL DEFAULT 0,
  downloads    INTEGER NOT NULL DEFAULT 0,
  new_objects  INTEGER NOT NULL DEFAULT 0,
  new_bytes    INTEGER NOT NULL DEFAULT 0,
  estimate     TEXT,
  error        TEXT,
  snapshot_id  TEXT,
  library      TEXT
);
CREATE INDEX snapshot_runs_project ON snapshot_runs (project_id, state, started_at);
CREATE TABLE snapshot_run_pages (
  run_id   TEXT NOT NULL REFERENCES snapshot_runs (id) ON DELETE CASCADE,
  page_id  TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  state    TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  entry    TEXT,
  PRIMARY KEY (run_id, page_id)
);
CREATE INDEX snapshot_run_pages_seq ON snapshot_run_pages (run_id, state, seq);

-- 4. Change snapshots owed after the bridge's own writes: written while the write's job runs (so a crash loses none),
--    taken when the job ends, and removed once its change snapshot is written.
CREATE TABLE snapshot_owed (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  job_id      TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  piece       TEXT NOT NULL,
  ref         TEXT NOT NULL DEFAULT '',
  op_id       TEXT NOT NULL,
  tool        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX snapshot_owed_job ON snapshot_owed (project_id, job_id);

-- 5. Verify findings: a stored piece that is missing or does not hash to its name. Resolved when a later verify finds
--    it whole again (the same content was stored again by a later snapshot).
CREATE TABLE snapshot_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256       TEXT NOT NULL,
  problem      TEXT NOT NULL CHECK (problem IN ('missing', 'corrupt', 'manifest')),
  detail       TEXT,
  snapshots    TEXT NOT NULL DEFAULT '[]',
  found_at     INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX snapshot_findings_open ON snapshot_findings (resolved_at, sha256);

-- 6. The daily changed-pages pass: each page's `updatedAt` as last seen by a snapshot (full or daily).
CREATE TABLE snapshot_seen (
  project_id  TEXT NOT NULL REFERENCES projects (id),
  page_id     TEXT NOT NULL,
  updated_at  TEXT,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id)
);

-- 7. Notices for the dashboard (a full snapshot refused for disk space, a change snapshot skipped), newest first.
CREATE TABLE snapshot_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT,
  level       TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX snapshot_notices_at ON snapshot_notices (at);

-- 8. Rehearsals: a snapshot restored into a throwaway root of another (sandbox) project and compared.
CREATE TABLE snapshot_rehearsals (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects (id),
  source_project_id  TEXT NOT NULL,
  snapshot_id        TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('sampled', 'full')),
  state              TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'stopped')),
  keep               INTEGER NOT NULL DEFAULT 0,
  root_id            TEXT,
  root_name          TEXT,
  root_state         TEXT NOT NULL DEFAULT 'none' CHECK (root_state IN ('none', 'kept', 'deleted', 'delete_failed')),
  started_by         TEXT NOT NULL,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  estimate           TEXT,
  plan               TEXT,
  progress           TEXT NOT NULL DEFAULT '{}',
  result             TEXT,
  error              TEXT
);
CREATE INDEX snapshot_rehearsals_at ON snapshot_rehearsals (started_at);

-- 9. Restores proposed (always proposals): what each restores, its proposal and job, and the second proposal that brings
--    an undeleted page's content back once the undelete has run.
CREATE TABLE snapshot_restores (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects (id),
  page_id                TEXT NOT NULL,
  page_name              TEXT NOT NULL,
  snapshot_id            TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  mode                   TEXT,
  document_id            TEXT,
  proposal_id            TEXT,
  state                  TEXT NOT NULL CHECK (state IN ('proposed', 'executed', 'failed', 'closed')),
  follow_up              TEXT,
  follow_up_proposal_id  TEXT,
  requested_by           TEXT NOT NULL,
  summary                TEXT NOT NULL,
  plan                   TEXT NOT NULL DEFAULT '{}',
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX snapshot_restores_proposal ON snapshot_restores (proposal_id);
CREATE INDEX snapshot_restores_page ON snapshot_restores (project_id, page_id, created_at);
