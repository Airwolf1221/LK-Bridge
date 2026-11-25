-- The 25 November 2026 Snapshots freeze (ADR 0042 amendment 2): the Snapshots page's page list and a page's history
-- come from an index kept current as each snapshot is written, never from an aggregate over every snapshot's pieces.
--
-- Before this, `GET /snapshots/pages` grouped every piece row of the project by page, and named each page with a
-- correlated subquery SQLite answered from `snapshot_pieces_name`: every page scanned every settings and sidebar row of
-- the project (pages × rows; 71 s at the retention's steady state on the mock, 62–67 s live on Arkona, the event loop
-- held for all of it).

-- 1. Page → the snapshots that hold it, one row each: its time, the snapshot's kind, the page's pieces and their bytes,
--    the name it had (from its settings, sidebar or deletion piece; NULL when that snapshot holds none of them) and its
--    state (`present` with a settings piece, `deleted` with a deletion; NULL when the snapshot holds neither).
CREATE TABLE snapshot_page_snapshots (
  project_id   TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  taken_at     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  pieces       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  name         TEXT,
  state        TEXT CHECK (state IN ('present', 'deleted')),
  PRIMARY KEY (project_id, page_id, snapshot_id)
);
CREATE INDEX snapshot_page_snapshots_at ON snapshot_page_snapshots (project_id, page_id, taken_at DESC, snapshot_id DESC);
CREATE INDEX snapshot_page_snapshots_snapshot ON snapshot_page_snapshots (snapshot_id);

-- 2. One row per page any snapshot holds: its latest name (and the same lower-cased, for "name contains"), whether its
--    latest state is a deletion, its branch (the first index below the AI REPOSITORY root), how many snapshots hold it
--    and their bytes, and its newest snapshot. Paged newest first by (last_at, page_id).
CREATE TABLE snapshot_pages (
  project_id        TEXT NOT NULL,
  page_id           TEXT NOT NULL,
  name              TEXT,
  name_key          TEXT NOT NULL DEFAULT '',
  deleted           INTEGER NOT NULL DEFAULT 0,
  branch_id         TEXT,
  branch_name       TEXT,
  snapshots         INTEGER NOT NULL DEFAULT 0,
  bytes             INTEGER NOT NULL DEFAULT 0,
  first_at          INTEGER NOT NULL,
  last_at           INTEGER NOT NULL,
  last_snapshot_id  TEXT,
  PRIMARY KEY (project_id, page_id)
);
CREATE INDEX snapshot_pages_recent ON snapshot_pages (project_id, last_at DESC, page_id DESC);
CREATE INDEX snapshot_pages_branch ON snapshot_pages (project_id, branch_id, last_at DESC, page_id DESC);

-- 3. The store's logical totals per project, kept with the index: every piece row's bytes (`referenced`), and each
--    distinct hash once (`unique_bytes`, `unique_count`), counted through `snapshot_hash_refs`.
CREATE TABLE snapshot_hash_refs (
  project_id  TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  refs        INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha256)
);
CREATE TABLE snapshot_totals (
  project_id    TEXT PRIMARY KEY,
  referenced    INTEGER NOT NULL DEFAULT 0,
  unique_bytes  INTEGER NOT NULL DEFAULT 0,
  unique_count  INTEGER NOT NULL DEFAULT 0
);

-- 4. A partial snapshot's missing pieces (page, piece, reference, reason), recorded when it is indexed instead of read
--    from its gzipped manifest on every list.
CREATE TABLE snapshot_missing (
  snapshot_id  TEXT NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  page_id      TEXT,
  page_name    TEXT,
  piece        TEXT NOT NULL,
  ref          TEXT,
  reason       TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, seq)
);
CREATE INDEX snapshot_missing_page ON snapshot_missing (snapshot_id, page_id);

-- 5. Which snapshots the index holds: `paged` once its pages are in (1) to (3), `missing_listed` once its missing pieces
--    are in (4) (or it has none). Snapshots indexed before this migration are 0 and 0: the backfill (a background job
--    that yields between chunks, at the bulk class's place) brings them in, newest first.
ALTER TABLE snapshots ADD COLUMN paged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshots ADD COLUMN missing_listed INTEGER NOT NULL DEFAULT 0;
UPDATE snapshots SET missing_listed = 1 WHERE missing = 0;
CREATE INDEX snapshots_unpaged ON snapshots (paged, taken_at);
