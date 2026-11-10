-- v2 A2: the repository tree (docs/PLAN-v2.md 4.2, docs/tree.md, ADR 0025).
--
-- The bridge's own model of each project's AI REPOSITORY: one row per resource under the project's root (the root
-- included, kind 'root'). Resources outside the root are never stored. Every row carries `project_id`; child tables
-- reference their node by (project_id, id), so nothing can cross projects.
--
-- Nodes are UPDATED IN PLACE by every pass (build, sweep, check) and by the updates after the bridge's own writes,
-- never deleted and re-inserted for a refresh, so later sessions can hang their own rows on (project_id, id): A3 adds
-- type and taxonomy links (`tree_node_links`), C2 records the template a page was created from (`template_id`).
--
-- Concurrency (ADR 0025): every observation carries the time it was made (`struct_observed_at` for the structure a
-- listing shows, `props_observed_at` for what only getResource shows). An observation never replaces one made later,
-- so a sweep or check that listed at time T never undoes an update the bridge's own write made after T. Removals
-- leave a tombstone with their observation time for the same reason.

CREATE TABLE tree_state (
  project_id     TEXT PRIMARY KEY REFERENCES projects (id),
  root_id        TEXT,                          -- the root the stored nodes belong to (null: nothing built)
  built_at       INTEGER,                       -- when the first build of this root completed
  confirmed_at   INTEGER,                       -- snapshot time T of the last pass that completed
  confirmed_by   TEXT CHECK (confirmed_by IS NULL OR confirmed_by IN ('build', 'sweep', 'check')),
  suggestion     TEXT,                          -- JSON: the last AI REPOSITORY root suggestion
  catalogue_key  TEXT,                          -- the property and row names the catalogue fields were derived with
  updated_at     INTEGER NOT NULL
);

CREATE TABLE tree_nodes (
  project_id         TEXT NOT NULL REFERENCES projects (id),
  id                 TEXT NOT NULL,             -- the LegendKeeper resource id
  raw_name           TEXT NOT NULL,
  display_name       TEXT NOT NULL,             -- the name without its "[INDEX] " or "[BSRC] " prefix
  kind               TEXT NOT NULL CHECK (kind IN ('root', 'index', 'bsrc', 'unclassified')),
  parent_id          TEXT,                      -- null only for the root
  rank               TEXT,
  depth              INTEGER NOT NULL,          -- 0 for the root
  path_ids           TEXT NOT NULL,             -- JSON: ids from the root to this node, both included
  path_names         TEXT NOT NULL,             -- JSON: their display names (cached)
  tags               TEXT NOT NULL DEFAULT '[]',
  aliases            TEXT NOT NULL DEFAULT '[]',
  documents          TEXT NOT NULL DEFAULT '[]',-- JSON: [{ id, name, type }]
  is_hidden          INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  is_locked          INTEGER CHECK (is_locked IS NULL OR is_locked IN (0, 1)), -- null until getResource
  reference_type     TEXT,                      -- the catalogue fields, from the key-value property (PROPERTIES)
  scope              TEXT,
  index_scope        TEXT,
  canonical_name     TEXT,
  properties_found   INTEGER CHECK (properties_found IS NULL OR properties_found IN (0, 1)),
  sidebar            TEXT,                      -- JSON summary of the sidebar properties (null until read)
  template_id        TEXT,                      -- C2: the template the bridge created this page from
  template_recorded_at INTEGER,
  struct_observed_at INTEGER NOT NULL,
  props_observed_at  INTEGER,
  props_pass         TEXT,                      -- the pass that last read its properties (resumable passes)
  last_read_at       INTEGER NOT NULL,
  last_read_by       TEXT NOT NULL CHECK (last_read_by IN ('build', 'write', 'sweep', 'check')),
  stale              INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  stale_reason       TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX tree_nodes_children ON tree_nodes (project_id, parent_id, rank);
CREATE INDEX tree_nodes_kind ON tree_nodes (project_id, kind);
CREATE INDEX tree_nodes_stale ON tree_nodes (project_id) WHERE stale = 1;

-- Every name a node answers to, for exact-name lookups (A3 builds name resolution on these): the raw name, the
-- display name, each alias and the Canonical Display Name. `name_key` is the case-folded form.
CREATE TABLE tree_names (
  project_id TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  field      TEXT NOT NULL CHECK (field IN ('raw', 'display', 'alias', 'canonical')),
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  FOREIGN KEY (project_id, node_id) REFERENCES tree_nodes (project_id, id) ON DELETE CASCADE
);
CREATE INDEX tree_names_key ON tree_names (project_id, name_key);
CREATE INDEX tree_names_name ON tree_names (project_id, name);
CREATE INDEX tree_names_node ON tree_names (project_id, node_id);

-- Links from a node to bridge-side records (A3: `type`, `taxonomy`; later sessions their own kinds).
CREATE TABLE tree_node_links (
  project_id TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  link       TEXT NOT NULL,
  target     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, node_id, link, target),
  FOREIGN KEY (project_id, node_id) REFERENCES tree_nodes (project_id, id) ON DELETE CASCADE
);

-- A node removed from the tree (deleted, or moved outside the root), with when that was observed: an older listing
-- must not bring it back.
CREATE TABLE tree_tombstones (
  project_id  TEXT NOT NULL REFERENCES projects (id),
  id          TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

-- Passes: the first build (and rebuilds), structural sweeps and consistency checks. Progress is persisted so a build
-- continues where it stopped after a restart. At most one pass per project is active.
CREATE TABLE tree_passes (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  kind         TEXT NOT NULL CHECK (kind IN ('build', 'sweep', 'check')),
  trigger      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('listing', 'awaiting_confirmation', 'reading', 'succeeded',
                                               'failed', 'cancelled', 'interrupted')),
  root_id      TEXT NOT NULL,
  snapshot_at  INTEGER,                         -- T: when its listing started
  cursor       TEXT,                            -- the next listing page
  pages        INTEGER NOT NULL DEFAULT 0,
  listed       INTEGER NOT NULL DEFAULT 0,      -- resources listed
  subtree      INTEGER,                         -- resources under the root (root included), once known
  to_read      INTEGER,                         -- resources whose properties this pass reads
  read_ok      INTEGER NOT NULL DEFAULT 0,
  read_failed  INTEGER NOT NULL DEFAULT 0,
  requests     INTEGER NOT NULL DEFAULT 0,      -- LegendKeeper requests made
  added        INTEGER NOT NULL DEFAULT 0,
  removed      INTEGER NOT NULL DEFAULT 0,
  corrected    INTEGER NOT NULL DEFAULT 0,      -- nodes whose stored values a sweep or check corrected
  estimate     TEXT,                            -- JSON: the estimate shown before a build
  summary      TEXT,
  error        TEXT,
  job_id       TEXT,                            -- the engine job recording the finished pass
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX tree_passes_project ON tree_passes (project_id, kind, started_at DESC);
CREATE UNIQUE INDEX tree_passes_one_active ON tree_passes (project_id)
  WHERE status IN ('listing', 'awaiting_confirmation', 'reading');

-- A pass's listing (every resource of the project, as listResources shows it), kept while the pass runs.
CREATE TABLE tree_listing (
  pass_id     TEXT NOT NULL REFERENCES tree_passes (id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  parent_id   TEXT,
  rank        TEXT,
  tags        TEXT NOT NULL,
  aliases     TEXT NOT NULL,
  documents   TEXT NOT NULL,
  is_hidden   INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (pass_id, id)
);

-- Re-reads owed after the bridge's own writes. A row is written before the write is sent and removed once the tree
-- has been updated, so a crash in between is caught up at the next start. A failed re-read stays, with its error,
-- and is retried.
CREATE TABLE tree_pending (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  job_id       TEXT,
  step_no      INTEGER,
  op           TEXT NOT NULL,
  resource_ids TEXT NOT NULL,                   -- JSON
  flags        TEXT NOT NULL DEFAULT '{}',      -- JSON: { includeChildren?, cascade? }
  status       TEXT NOT NULL CHECK (status IN ('in_flight', 'retry')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  next_at      INTEGER,
  attempted_at INTEGER,                         -- the observation stamp of the last failed attempt
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX tree_pending_project ON tree_pending (project_id, status);

-- The correction log: what a sweep or a check corrected (old and new values), and re-reads that failed.
CREATE TABLE tree_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects (id),
  at         INTEGER NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('build', 'sweep', 'check', 'write')),
  pass_id    TEXT,
  node_id    TEXT NOT NULL,
  node_name  TEXT,
  change     TEXT NOT NULL CHECK (change IN ('added', 'removed', 'updated', 'reread_failed')),
  field      TEXT,
  old_value  TEXT,                              -- JSON
  new_value  TEXT,                              -- JSON
  detail     TEXT
);
CREATE INDEX tree_log_project ON tree_log (project_id, id DESC);
CREATE INDEX tree_log_pass ON tree_log (pass_id);

-- Chunk 6's `tree-snapshot` placeholder became the real `tree-sweep` and `tree-check` jobs.
DELETE FROM maintenance_runs WHERE job_id = 'tree-snapshot';
DELETE FROM maintenance_jobs WHERE id = 'tree-snapshot';
