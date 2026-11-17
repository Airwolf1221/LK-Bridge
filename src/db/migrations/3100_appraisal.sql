-- v3 F3c (ADR 0054): the Arkona pack's appraisal tools and the full-text search. Everything here is the bridge's OWN
-- data, derived from the snapshot store (never from LegendKeeper), and can be rebuilt from it at any time: the overlay of
-- the newest full snapshot (a partial one too, its missing pieces listed) and the change snapshots since, laid over as the
-- audits lay them (ADR 0044), materialised so the
-- appraisal tools and the `search` tool's full-text index answer without reading every snapshot piece again.
--
-- Nothing here is written to LegendKeeper, and no report is kept anywhere but here (Repository Automation: reports
-- belong in the response unless persistence is explicitly authorised; the bridge keeps the latest run of each tool for
-- comparison, as the audits keep theirs).

-- One row per project: which snapshots the overlay holds, and how big and how fresh it is.
CREATE TABLE appraisal_index_state (
  project_id          TEXT PRIMARY KEY,
  base_snapshot_id    TEXT NOT NULL,              -- the newest complete full snapshot it was built from
  base_taken_at       INTEGER NOT NULL,
  newest_snapshot_id  TEXT NOT NULL,              -- the newest snapshot laid over it (the base, or the last change)
  newest_taken_at     INTEGER NOT NULL,
  changes             INTEGER NOT NULL DEFAULT 0, -- change snapshots laid over the base
  root_id             TEXT,
  library_sha         TEXT,                       -- the asset library piece (the base's, or a later change's)
  pages               INTEGER NOT NULL DEFAULT 0,
  units               INTEGER NOT NULL DEFAULT 0, -- full-text rows
  refs                INTEGER NOT NULL DEFAULT 0,
  unreadable          INTEGER NOT NULL DEFAULT 0, -- pieces the store could not give
  built_at            INTEGER NOT NULL,
  build_ms            INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  last_update_ms      INTEGER,
  size_bytes          INTEGER,                    -- the appraisal tables' size on disk (every project), when measured
  notes               TEXT NOT NULL DEFAULT '[]'
);

-- The change snapshots laid over the base (a late one with an older time than one applied makes the overlay rebuild).
CREATE TABLE appraisal_index_applied (
  project_id  TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  taken_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, snapshot_id)
);

-- Every page the overlay holds: its place in the snapshot's tree and the hashes of its pieces in the store.
CREATE TABLE appraisal_index_pages (
  project_id          TEXT NOT NULL,
  page_id             TEXT NOT NULL,
  parent_id           TEXT,
  rank                TEXT,
  name                TEXT NOT NULL,              -- as stored, prefix included
  resource_sha        TEXT,
  sidebar_sha         TEXT,
  documents           TEXT NOT NULL DEFAULT '[]', -- JSON: [{ id, type, name, sha256 }] in the snapshot's order
  source_snapshot_id  TEXT NOT NULL,              -- the snapshot that supplied its newest piece
  source_taken_at     INTEGER NOT NULL,
  unreadable          TEXT NOT NULL DEFAULT '[]', -- JSON: pieces the store could not give
  PRIMARY KEY (project_id, page_id)
);
CREATE INDEX appraisal_index_pages_parent ON appraisal_index_pages (project_id, parent_id);

-- The project's templates, from the base full snapshot (ADR 0044 decision 5): their sidebars for the template checks.
CREATE TABLE appraisal_index_templates (
  project_id   TEXT NOT NULL,
  template_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  sidebar_sha  TEXT,
  PRIMARY KEY (project_id, template_id)
);

-- The full-text index: one row per unit of text (a page's name, an alias, a sidebar fact's value, a block of text, a
-- table row), with where it is (page, document, block) and the section path of the headings above it.
CREATE VIRTUAL TABLE appraisal_fts USING fts5(
  text,
  project_id UNINDEXED,
  page_id UNINDEXED,
  document_id UNINDEXED,
  block_id UNINDEXED,
  unit UNINDEXED,
  field UNINDEXED,
  section UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Which full-text rows belong to which page, so a page laid over by a change snapshot is re-indexed alone.
CREATE TABLE appraisal_fts_rows (
  project_id  TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  fts_rowid   INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id, fts_rowid)
);

-- Every reference one page makes to another: mentions (in the sidebar or the documents) and collection items.
CREATE TABLE appraisal_refs (
  project_id     TEXT NOT NULL,
  from_page      TEXT NOT NULL,
  from_document  TEXT,                            -- null: the sidebar
  from_block     TEXT,
  section        TEXT,                            -- the heading path, or the sidebar property
  via            TEXT NOT NULL CHECK (via IN ('mention', 'collection')),
  property       TEXT,                            -- the sidebar property or collection's title
  row_key        TEXT,                            -- a sidebar mention's row key
  to_page        TEXT NOT NULL,
  to_document    TEXT,
  label          TEXT,                            -- the text a mention displays
  context        TEXT                             -- the unit's text, clipped
);
CREATE INDEX appraisal_refs_to ON appraisal_refs (project_id, to_page);
CREATE INDEX appraisal_refs_from ON appraisal_refs (project_id, from_page);

-- Every image a page shows: image blocks (with the label heading above and whether interpretation text follows), and
-- other images (a banner, a map image) by their URL alone.
CREATE TABLE appraisal_images (
  project_id      TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  document_id     TEXT,
  block_id        TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('block', 'other')),
  url             TEXT NOT NULL,
  url_path        TEXT NOT NULL,                  -- the URL's path: the same asset on assets and assets2
  label           TEXT,
  interpretation  INTEGER NOT NULL DEFAULT 0 CHECK (interpretation IN (0, 1)),
  section         TEXT
);
CREATE INDEX appraisal_images_page ON appraisal_images (project_id, page_id);
CREATE INDEX appraisal_images_path ON appraisal_images (project_id, url_path);

-- The latest run of each appraisal tool, per project and scope (a page, a branch, everything), with its report.
CREATE TABLE appraisal_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  scope_key    TEXT NOT NULL,
  scope        TEXT NOT NULL,                     -- JSON: what was asked
  actor        TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  source       TEXT NOT NULL,                     -- JSON: the snapshots read and how old they were
  counts       TEXT NOT NULL,                     -- JSON
  compared     TEXT,                              -- JSON: against the run it replaced (new, still, gone)
  report       TEXT NOT NULL                      -- JSON
);
CREATE UNIQUE INDEX appraisal_runs_scope ON appraisal_runs (project_id, tool, scope_key);
CREATE INDEX appraisal_runs_time ON appraisal_runs (project_id, finished_at);

-- Each finding of a stored run, by its id (a fingerprint: the same finding has the same id in every run).
CREATE TABLE appraisal_findings (
  project_id  TEXT NOT NULL,
  run_id      TEXT NOT NULL REFERENCES appraisal_runs (id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  tool        TEXT NOT NULL,
  check_id    TEXT NOT NULL,
  page_id     TEXT,
  finding     TEXT NOT NULL,                      -- JSON
  PRIMARY KEY (project_id, run_id, id)
);
CREATE INDEX appraisal_findings_id ON appraisal_findings (project_id, id);
