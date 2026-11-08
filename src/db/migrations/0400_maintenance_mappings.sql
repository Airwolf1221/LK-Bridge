-- Chunk 6: maintenance-job scheduler state and the Repository Mappings data model.
-- Times are Unix milliseconds. Earlier migrations are never edited.

-- One row per registered maintenance job that has ever been touched by the scheduler or the owner. The registry
-- itself (names, descriptions, defaults) lives in code; this table holds what must survive a restart.
CREATE TABLE maintenance_jobs (
  id               TEXT PRIMARY KEY,
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  schedule         TEXT,                          -- JSON override of the default schedule; NULL = the default
  next_run_at      INTEGER,                       -- NULL while disabled
  running_since    INTEGER,                       -- set while a run is in flight; a leftover value means a crash
  last_run_at      INTEGER,
  last_outcome     TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('succeeded', 'failed', 'skipped', 'interrupted')),
  last_duration_ms INTEGER,
  last_job_id      TEXT,                          -- the engine job that recorded the run, when one was recorded
  last_detail      TEXT,
  updated_at       INTEGER NOT NULL
);

-- History of runs (the last few per job are kept), including skips and the reason.
CREATE TABLE maintenance_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  trigger     TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'catch-up')),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'skipped', 'interrupted')),
  duration_ms INTEGER NOT NULL,
  engine_job_id TEXT,
  detail      TEXT
);
CREATE INDEX maintenance_runs_job ON maintenance_runs (job_id, id DESC);

-- ------------------------------------------------------------------------------------------ repository mappings

-- A mapping set (for example "Baisheng taxonomy"). At most one is active.
CREATE TABLE mapping_sets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX mapping_sets_one_active ON mapping_sets (active) WHERE active = 1;

-- Type rules: a selector (LK subtree, template or tag) maps to a semantic type. Higher priority wins an overlap.
CREATE TABLE mapping_type_rules (
  id            TEXT PRIMARY KEY,
  set_id        TEXT NOT NULL REFERENCES mapping_sets (id) ON DELETE CASCADE,
  selector_kind TEXT NOT NULL CHECK (selector_kind IN ('subtree', 'template', 'tag')),
  selector_id   TEXT NOT NULL,                     -- resource id, template id, or tag name
  descendants   INTEGER NOT NULL DEFAULT 1 CHECK (descendants IN (0, 1)),  -- subtree only
  semantic_type TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX mapping_type_rules_set ON mapping_type_rules (set_id);

-- Field maps: per semantic type, a semantic field name maps to a location on the page.
CREATE TABLE mapping_field_maps (
  id             TEXT PRIMARY KEY,
  set_id         TEXT NOT NULL REFERENCES mapping_sets (id) ON DELETE CASCADE,
  semantic_type  TEXT NOT NULL,
  field_name     TEXT NOT NULL,
  location_kind  TEXT NOT NULL CHECK (location_kind IN ('sidebar_property', 'infobox_row', 'block')),
  property_title TEXT,                             -- sidebar_property
  infobox_title  TEXT,                             -- infobox_row
  row_key        TEXT,                             -- infobox_row
  heading_text   TEXT,                             -- block (by heading)
  block_id       TEXT,                             -- block (by id)
  expected_kind  TEXT NOT NULL CHECK (expected_kind IN ('text', 'number', 'resource_link', 'list', 'date', 'boolean', 'image', 'other')),
  notes          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (set_id, semantic_type, field_name)
);
CREATE INDEX mapping_field_maps_set ON mapping_field_maps (set_id);
