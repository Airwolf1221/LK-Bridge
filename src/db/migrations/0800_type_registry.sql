-- v2 A3: the type registry and taxonomy (docs/PLAN-v2.md 4.3 and 10.2, docs/registry.md, ADR 0026).
--
-- Everything is per project: every row carries `project_id`, child rows reference their parent by (project_id, id),
-- so nothing can cross projects. Nothing here is hard-coded for Arkona: the owner creates the types (or seeds the
-- Character type from the tree), and seeds each type's taxonomy once from the tree.
--
-- Types are stored so they can grow into recipes later (PLAN-v2 10.2): `recipe` is a versioned JSON document (empty
-- in v2), and `pack_id` will name the setting pack a type belongs to.

CREATE TABLE registry_types (
  project_id        TEXT NOT NULL REFERENCES projects (id),
  id                TEXT NOT NULL,
  singular          TEXT NOT NULL,                -- Character
  plural            TEXT NOT NULL,                -- Characters
  singular_key      TEXT NOT NULL,                -- case-folded, for uniqueness and lookups
  plural_key        TEXT NOT NULL,
  root_index_id     TEXT,                         -- a node of the repository tree ([INDEX] Characters)
  index_template_id TEXT,                         -- the template new indexes of this type are made from
  page_templates    TEXT NOT NULL DEFAULT '[]',   -- JSON: [{ role, templateId }] (core, compact, …)
  asset_root_folder TEXT,                         -- Characters
  placement_kind    TEXT NOT NULL CHECK (placement_kind IN ('character', 'generic')),
  placement_config  TEXT NOT NULL DEFAULT '{}',   -- JSON: the rule's settings (section 9's names and values)
  recipe            TEXT NOT NULL DEFAULT '{"version":1}', -- JSON, versioned; empty in v2
  pack_id           TEXT,                         -- later: the setting pack the type belongs to
  status            TEXT NOT NULL CHECK (status IN ('ok', 'needs_review')),
  review            TEXT NOT NULL DEFAULT '[]',   -- JSON: [{ code, message }] why it needs review
  notes             TEXT NOT NULL DEFAULT '',
  taxonomy_seeded_at INTEGER,                     -- set once: the taxonomy is seeded once per type
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE UNIQUE INDEX registry_types_singular ON registry_types (project_id, singular_key);
CREATE UNIQUE INDEX registry_types_plural ON registry_types (project_id, plural_key);

-- The taxonomy: hierarchical categories under a type's root (groups, races, subraces for Characters).
CREATE TABLE taxonomy_entries (
  project_id            TEXT NOT NULL,
  id                    TEXT NOT NULL,
  type_id               TEXT NOT NULL,
  plural                TEXT NOT NULL,            -- the index's display name (Foxians)
  singular              TEXT NOT NULL,            -- Foxian
  singular_source       TEXT NOT NULL CHECK (singular_source IN ('list', 'rule', 'owner')),
  parent_id             TEXT,                     -- another entry of the same type; null: directly under the root
  aliases               TEXT NOT NULL DEFAULT '[]',
  source_node_id        TEXT NOT NULL,            -- the index it was made from
  source_parent_node_id TEXT,                     -- that index's parent when the entry was made (move drift)
  asset_folder          TEXT NOT NULL,            -- defaults to the plural
  status                TEXT NOT NULL CHECK (status IN ('ok', 'needs_review')),
  review                TEXT NOT NULL DEFAULT '[]',
  notes                 TEXT NOT NULL DEFAULT '',
  origin                TEXT NOT NULL CHECK (origin IN ('seed', 'add_missing')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, type_id) REFERENCES registry_types (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, parent_id) REFERENCES taxonomy_entries (project_id, id)
);
CREATE INDEX taxonomy_entries_type ON taxonomy_entries (project_id, type_id);
CREATE UNIQUE INDEX taxonomy_entries_source ON taxonomy_entries (project_id, source_node_id);
CREATE INDEX taxonomy_entries_parent ON taxonomy_entries (project_id, parent_id);

-- Per-project registry state: the last read of the project's templates (listTemplates), for matching and pickers.
CREATE TABLE registry_state (
  project_id        TEXT PRIMARY KEY REFERENCES projects (id),
  templates         TEXT,                         -- JSON: [{ id, name, parentId }]
  templates_read_at INTEGER,
  templates_error   TEXT,
  updated_at        INTEGER NOT NULL
);

-- Taxonomy drift reports: made by the tree's daily check (and on the owner's request). Reported, never fixed.
CREATE TABLE taxonomy_drift_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  at          INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('check', 'owner')),
  pass_id     TEXT,
  tree_status TEXT NOT NULL,
  note        TEXT,
  findings    TEXT NOT NULL,                      -- JSON: [{ code, typeId, … }]
  count       INTEGER NOT NULL
);
CREATE INDEX taxonomy_drift_reports_project ON taxonomy_drift_reports (project_id, id DESC);
