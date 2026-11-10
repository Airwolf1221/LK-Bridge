-- v2 C2c (ADR 0035): the page lifecycle. Authoritative `[BSRC]`, Working `[BWRK]` under `[INDEX] Working`, and Archived
-- `[BARC]` under `[INDEX] Archived`.
--
-- 1. The repository tree knows the two new kinds. SQLite cannot change a CHECK constraint in place, so `tree_nodes` is
--    rebuilt with its two child tables (which cascade from it), exactly as they were apart from the wider CHECK, as
--    migration 0600 rebuilt the jobs tables: the children are copied first, dropped before their parent, and every
--    table renamed back. Nothing is re-read: the stored nodes keep their kinds until the tree service sees the new
--    classification version (src/tree/classify.ts) and re-derives every kind and display name from the raw names.
CREATE TABLE tree_nodes_new (
  project_id         TEXT NOT NULL REFERENCES projects (id),
  id                 TEXT NOT NULL,
  raw_name           TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('root', 'index', 'bsrc', 'bwrk', 'barc', 'unclassified')),
  parent_id          TEXT,
  rank               TEXT,
  depth              INTEGER NOT NULL,
  path_ids           TEXT NOT NULL,
  path_names         TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '[]',
  aliases            TEXT NOT NULL DEFAULT '[]',
  documents          TEXT NOT NULL DEFAULT '[]',
  is_hidden          INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  is_locked          INTEGER CHECK (is_locked IS NULL OR is_locked IN (0, 1)),
  reference_type     TEXT,
  scope              TEXT,
  index_scope        TEXT,
  canonical_name     TEXT,
  properties_found   INTEGER CHECK (properties_found IS NULL OR properties_found IN (0, 1)),
  sidebar            TEXT,
  template_id        TEXT,
  template_recorded_at INTEGER,
  struct_observed_at INTEGER NOT NULL,
  props_observed_at  INTEGER,
  props_pass         TEXT,
  last_read_at       INTEGER NOT NULL,
  last_read_by       TEXT NOT NULL CHECK (last_read_by IN ('build', 'write', 'sweep', 'check')),
  stale              INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  stale_reason       TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
INSERT INTO tree_nodes_new (project_id, id, raw_name, display_name, kind, parent_id, rank, depth, path_ids, path_names,
  tags, aliases, documents, is_hidden, is_locked, reference_type, scope, index_scope, canonical_name, properties_found,
  sidebar, template_id, template_recorded_at, struct_observed_at, props_observed_at, props_pass, last_read_at,
  last_read_by, stale, stale_reason, created_at, updated_at)
SELECT project_id, id, raw_name, display_name, kind, parent_id, rank, depth, path_ids, path_names, tags, aliases,
  documents, is_hidden, is_locked, reference_type, scope, index_scope, canonical_name, properties_found, sidebar,
  template_id, template_recorded_at, struct_observed_at, props_observed_at, props_pass, last_read_at, last_read_by,
  stale, stale_reason, created_at, updated_at
FROM tree_nodes;

CREATE TABLE tree_names_new (
  project_id TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  field      TEXT NOT NULL CHECK (field IN ('raw', 'display', 'alias', 'canonical')),
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  FOREIGN KEY (project_id, node_id) REFERENCES tree_nodes_new (project_id, id) ON DELETE CASCADE
);
INSERT INTO tree_names_new (project_id, node_id, field, name, name_key)
SELECT project_id, node_id, field, name, name_key FROM tree_names ORDER BY rowid;

CREATE TABLE tree_node_links_new (
  project_id TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  link       TEXT NOT NULL,
  target     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, node_id, link, target),
  FOREIGN KEY (project_id, node_id) REFERENCES tree_nodes_new (project_id, id) ON DELETE CASCADE
);
INSERT INTO tree_node_links_new (project_id, node_id, link, target, detail, created_at)
SELECT project_id, node_id, link, target, detail, created_at FROM tree_node_links;

DROP TABLE tree_names;
DROP TABLE tree_node_links;
DROP TABLE tree_nodes;
ALTER TABLE tree_nodes_new RENAME TO tree_nodes;
ALTER TABLE tree_names_new RENAME TO tree_names;
ALTER TABLE tree_node_links_new RENAME TO tree_node_links;
CREATE INDEX tree_nodes_children ON tree_nodes (project_id, parent_id, rank);
CREATE INDEX tree_nodes_kind ON tree_nodes (project_id, kind);
CREATE INDEX tree_nodes_stale ON tree_nodes (project_id) WHERE stale = 1;
CREATE INDEX tree_names_key ON tree_names (project_id, name_key);
CREATE INDEX tree_names_name ON tree_names (project_id, name);
CREATE INDEX tree_names_node ON tree_names (project_id, node_id);

-- 2. The lifecycle record: a permanent table, NEVER pruned, one row per lifecycle change (archive_page,
--    unarchive_page, move_to_working, promote_page). A row is written by the change's own job when it starts
--    (`incomplete`) and marked `complete` by its last step; a job that stops part-way leaves it `incomplete`, and calling
--    the same tool again on the page resumes from it. unarchive_page and promote_page read it; the dashboard shows it.
CREATE TABLE lifecycle_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          TEXT NOT NULL REFERENCES projects (id),
  page_id             TEXT NOT NULL,
  page_name           TEXT NOT NULL,                -- the page's name when the change was planned
  action              TEXT NOT NULL CHECK (action IN ('archive', 'unarchive', 'move_to_working', 'promote')),
  date                TEXT NOT NULL,                -- the ISO date written into the note and the facts
  principal_id        TEXT NOT NULL,
  approver            TEXT,
  job_id              TEXT,                         -- the job working on it now (the last one, after a resume)
  jobs                TEXT NOT NULL DEFAULT '[]',   -- JSON: every job that worked on it, in order
  proposal_id         TEXT,
  state               TEXT NOT NULL CHECK (state IN ('incomplete', 'complete')),
  previous_state      TEXT NOT NULL CHECK (previous_state IN ('authoritative', 'working', 'archived', 'unknown')),
  previous_parent_id  TEXT,
  previous_rank       TEXT,
  previous_name       TEXT NOT NULL,
  previous_prefix     TEXT NOT NULL,
  previous_facts      TEXT NOT NULL,                -- JSON: field → value (null: no row), for the five lifecycle facts
  tags_removed        TEXT NOT NULL DEFAULT '[]',   -- JSON
  tags_added          TEXT NOT NULL DEFAULT '[]',   -- JSON
  note_block_id       TEXT,                         -- archiving: the inserted note's block id
  note_content        TEXT,                         -- archiving: the note block exactly as inserted (JSON)
  target              TEXT NOT NULL,                -- JSON: the state the change aims at (name, parent, facts, tags)
  detail              TEXT,                         -- JSON: flags for the owner (note kept, Scope edited, related pages)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX lifecycle_records_page ON lifecycle_records (project_id, page_id, id DESC);
CREATE INDEX lifecycle_records_recent ON lifecycle_records (project_id, id DESC);

-- 3. The link index (Part 4): which page links to which, so archive_page and move_to_working can list the pages that
--    depend on or relate to a page without reading 1,500 sidebars and documents. A row per link: from a page's link
--    collection (`collection`, `via` its title) or from a mention in one of its documents (`mention`, `via` the document
--    id). Kept up to date from the bridge's own writes as they happen, and refreshed by the paced `link-sweep`.
CREATE TABLE link_index (
  project_id     TEXT NOT NULL REFERENCES projects (id),
  from_id        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('collection', 'mention')),
  via            TEXT NOT NULL,                     -- the collection's title, or the document's id
  to_id          TEXT NOT NULL,
  via_name       TEXT,                              -- the document's name (mentions)
  seen_at        INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('write', 'sweep')),
  PRIMARY KEY (project_id, from_id, kind, via, to_id)
) WITHOUT ROWID;
CREATE INDEX link_index_to ON link_index (project_id, to_id);

-- The link sweep's passes: resumable (pages in id order; `cursor` is the last page done), at most one running.
CREATE TABLE link_sweeps (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects (id),
  status         TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  cursor         TEXT,
  pages_total    INTEGER,
  pages_done     INTEGER NOT NULL DEFAULT 0,
  documents_read INTEGER NOT NULL DEFAULT 0,
  requests       INTEGER NOT NULL DEFAULT 0,
  links          INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE INDEX link_sweeps_project ON link_sweeps (project_id, started_at DESC);
CREATE UNIQUE INDEX link_sweeps_one_running ON link_sweeps (project_id) WHERE status = 'running';

-- 4. The two recommended canon rules (not yet decided by the owner; each can be switched off on the dashboard).
--    Projects using the default rules get them from the defaults; a project whose own rules are stored gets each added
--    once, unless it already has a rule of that kind (as migration 1500 added the delete rule).
UPDATE projects
   SET settings = json_insert(settings, '$.canonicalRules[#]',
         json('{"id":"delete-archived","kind":"deleteKind","kinds":["barc"],"note":"Deleting a [BARC] (Archived) page, or a subtree holding one, needs canonical approval: the archive is provenance. Recommended; switch it off here if not wanted."}'))
 WHERE json_valid(settings)
   AND json_type(settings, '$.canonicalRules') = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(projects.settings, '$.canonicalRules') r
                    WHERE json_extract(r.value, '$.kind') = 'deleteKind');
UPDATE projects
   SET settings = json_insert(settings, '$.canonicalRules[#]',
         json('{"id":"delete-document-authoritative","key":"Status","kind":"deleteDocument","values":["Authoritative"],"documentTypes":["map","time","board"],"note":"Deleting a map, timeline or board of a page whose Status is Authoritative needs canonical approval: it removes canonical content. Recommended; switch it off here if not wanted."}'))
 WHERE json_valid(settings)
   AND json_type(settings, '$.canonicalRules') = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(projects.settings, '$.canonicalRules') r
                    WHERE json_extract(r.value, '$.kind') = 'deleteDocument');
