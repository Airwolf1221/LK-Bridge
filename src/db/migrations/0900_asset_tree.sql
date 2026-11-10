-- v2 A4: the asset tree (docs/PLAN-v2.md 4.6, docs/assets.md, ADR 0027).
--
-- The bridge's own model of each project's asset library: its folders and the assets in them. LegendKeeper's
-- listAssets returns one folder level at a time, so the model is built by walking every folder. Every row carries
-- `project_id`; assets and child folders reference their folder by (project_id, id), so nothing can cross projects.
--
-- Rows are UPDATED IN PLACE by every pass (build, refresh, check) and by the updates after the bridge's own asset
-- writes, never deleted and re-inserted for a refresh.
--
-- Concurrency (ADR 0027, the same rule as ADR 0025): every observation carries a stamp made just before the read
-- that saw it. An observation never replaces one made later, so a refresh that listed a folder at time T never undoes
-- an update the bridge's own write made after T. Removals leave a tombstone with their stamp for the same reason.

CREATE TABLE asset_state (
  project_id   TEXT PRIMARY KEY REFERENCES projects (id),
  built_at     INTEGER,                         -- when the first build completed
  confirmed_at INTEGER,                         -- the start (stamp) of the last pass that completed
  confirmed_by TEXT CHECK (confirmed_by IS NULL OR confirmed_by IN ('build', 'refresh', 'check')),
  updated_at   INTEGER NOT NULL
);

CREATE TABLE asset_folders (
  project_id   TEXT NOT NULL REFERENCES projects (id),
  id           TEXT NOT NULL,                   -- the LegendKeeper asset id of the FOLDER
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,                   -- case-folded (NFC, lower case), for exact-name lookups
  parent_id    TEXT,                            -- null: directly in the library's root
  depth        INTEGER NOT NULL,                -- 1 for a folder in the root
  path_ids     TEXT NOT NULL,                   -- JSON: ids from the top folder to this one, both included (cached)
  path_names   TEXT NOT NULL,                   -- JSON: their names (cached)
  is_hidden    INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  observed_at  INTEGER NOT NULL,                -- the stamp of the observation this row reflects
  last_read_at INTEGER NOT NULL,
  last_read_by TEXT NOT NULL CHECK (last_read_by IN ('build', 'write', 'refresh', 'check')),
  stale        INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  stale_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES asset_folders (project_id, id)
);
CREATE INDEX asset_folders_parent ON asset_folders (project_id, parent_id, name_key);
CREATE INDEX asset_folders_name ON asset_folders (project_id, name_key);
CREATE INDEX asset_folders_stale ON asset_folders (project_id) WHERE stale = 1;

CREATE TABLE asset_items (
  project_id   TEXT NOT NULL REFERENCES projects (id),
  id           TEXT NOT NULL,                   -- the LegendKeeper asset id (IMAGE, MAP, AUDIO, …; never FOLDER)
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  folder_id    TEXT,                            -- null: directly in the library's root
  type         TEXT NOT NULL,
  url          TEXT,
  width        INTEGER,
  height       INTEGER,
  size         INTEGER,                         -- bytes, when LegendKeeper says (its Asset has no size today)
  sha256       TEXT,                            -- left empty here; E1 fills it when it downloads images for backups
  sha256_at    INTEGER,
  is_hidden    INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  lk_created_at TEXT,
  observed_at  INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL,
  last_read_by TEXT NOT NULL CHECK (last_read_by IN ('build', 'write', 'refresh', 'check')),
  stale        INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  stale_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, folder_id) REFERENCES asset_folders (project_id, id)
);
CREATE INDEX asset_items_folder ON asset_items (project_id, folder_id, name_key);
CREATE INDEX asset_items_name ON asset_items (project_id, name_key);
CREATE INDEX asset_items_stale ON asset_items (project_id) WHERE stale = 1;

-- Something removed from the model (deleted, or inside a deleted folder), with when that was observed: an older
-- listing must not bring it back.
CREATE TABLE asset_tombstones (
  project_id  TEXT NOT NULL REFERENCES projects (id),
  id          TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

-- Passes: the first build (and rebuilds), the regular refresh and the nightly check. Progress is persisted so a build
-- continues where it stopped after a restart. At most one pass per project is active.
CREATE TABLE asset_passes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (id),
  kind          TEXT NOT NULL CHECK (kind IN ('build', 'refresh', 'check')),
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('preparing', 'awaiting_confirmation', 'walking', 'succeeded',
                                                'failed', 'cancelled', 'interrupted')),
  snapshot_at   INTEGER,                        -- the stamp at which the pass started
  folders_found INTEGER NOT NULL DEFAULT 0,     -- folders known to the walk (the root level included)
  folders_done  INTEGER NOT NULL DEFAULT 0,     -- folders whose listing is complete
  folders_failed INTEGER NOT NULL DEFAULT 0,    -- folders whose listing could not be read
  listed        INTEGER NOT NULL DEFAULT 0,     -- items (folders and assets) listed
  pages         INTEGER NOT NULL DEFAULT 0,     -- listing pages read
  requests      INTEGER NOT NULL DEFAULT 0,     -- LegendKeeper requests made
  verified      INTEGER NOT NULL DEFAULT 0,     -- getAsset reads confirming something a listing did not show
  added         INTEGER NOT NULL DEFAULT 0,
  removed       INTEGER NOT NULL DEFAULT 0,
  corrected     INTEGER NOT NULL DEFAULT 0,     -- rows whose stored values a refresh or check corrected
  estimate      TEXT,                           -- JSON: the estimate shown before a build walks past the root level
  summary       TEXT,
  error         TEXT,
  job_id        TEXT,                           -- the engine job recording the finished build
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX asset_passes_project ON asset_passes (project_id, kind, started_at DESC);
CREATE UNIQUE INDEX asset_passes_one_active ON asset_passes (project_id)
  WHERE status IN ('preparing', 'awaiting_confirmation', 'walking');

-- A pass's walk: the folders to list (breadth first), each with the cursor of its listing. '' is the library's root.
-- `stamp` is the observation stamp taken when the folder's listing started: what its items are observed at.
CREATE TABLE asset_walk (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id    TEXT NOT NULL REFERENCES asset_passes (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  cursor     TEXT,
  pages      INTEGER NOT NULL DEFAULT 0,
  stamp      INTEGER,
  UNIQUE (pass_id, folder_id)
);
CREATE INDEX asset_walk_pending ON asset_walk (pass_id, status, seq);

-- The items of a folder listing that is in progress (kept until the whole folder has been read, then applied at once).
CREATE TABLE asset_listing (
  pass_id       TEXT NOT NULL REFERENCES asset_passes (id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL,
  folder_id     TEXT NOT NULL,                  -- '' for the root
  id            TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  url           TEXT,
  width         INTEGER,
  height        INTEGER,
  size          INTEGER,
  is_hidden     INTEGER NOT NULL,
  lk_created_at TEXT,
  PRIMARY KEY (pass_id, folder_id, id)
);

-- Re-reads owed after the bridge's own asset writes. A row is written before the write is sent and removed once the
-- model has been updated, so a crash in between is caught up at the next start. A failed re-read stays, with its
-- error, and is retried.
CREATE TABLE asset_pending (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  job_id       TEXT,
  step_no      INTEGER,
  op           TEXT NOT NULL,
  asset_ids    TEXT NOT NULL,                   -- JSON
  flags        TEXT NOT NULL DEFAULT '{}',      -- JSON: { parentId?: string | null } (where a create put its result)
  status       TEXT NOT NULL CHECK (status IN ('in_flight', 'retry')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  next_at      INTEGER,
  attempted_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX asset_pending_project ON asset_pending (project_id, status);

-- The correction log: what a refresh or a check corrected (old and new values), and re-reads that failed.
CREATE TABLE asset_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects (id),
  at         INTEGER NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('build', 'refresh', 'check', 'write')),
  pass_id    TEXT,
  item_id    TEXT NOT NULL,
  item_name  TEXT,
  item_kind  TEXT NOT NULL CHECK (item_kind IN ('folder', 'asset')),
  change     TEXT NOT NULL CHECK (change IN ('added', 'removed', 'updated', 'reread_failed')),
  field      TEXT,
  old_value  TEXT,                              -- JSON
  new_value  TEXT,                              -- JSON
  detail     TEXT
);
CREATE INDEX asset_log_project ON asset_log (project_id, id DESC);
CREATE INDEX asset_log_pass ON asset_log (pass_id);
