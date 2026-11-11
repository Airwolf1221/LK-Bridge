-- C2d (ADR 0037; ADR 0036 decision 7): whole-set lifecycle changes, and the status tags as a canon rule.
-- (1750, not 1700: session D1 runs alongside and may take 1700; the runner applies any file not yet applied.)
--
-- 1. The set record: one row per whole-set change (archive_page, unarchive_page, move_to_working or promote_page with
--    `subtree: true`), never pruned. Written by the change's own job (`bridge.record` begin_set / complete_set); a job
--    that stops leaves it `incomplete`, and calling the same tool again on the set's root resumes it (a new job is added
--    to `jobs`). `pages` is the set as captured (every page with its parent, name, kind and role); `target` what each page
--    moves to; `summary` the set summary the proposal showed.
CREATE TABLE lifecycle_sets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          TEXT NOT NULL REFERENCES projects (id),
  root_id             TEXT NOT NULL,
  root_name           TEXT NOT NULL,
  action              TEXT NOT NULL CHECK (action IN ('archive', 'unarchive', 'move_to_working', 'promote')),
  date                TEXT NOT NULL,
  principal_id        TEXT NOT NULL,
  approver            TEXT,
  job_id              TEXT,
  jobs                TEXT NOT NULL DEFAULT '[]',
  proposal_id         TEXT,
  state               TEXT NOT NULL CHECK (state IN ('incomplete', 'complete')),
  previous_state      TEXT NOT NULL CHECK (previous_state IN ('authoritative', 'working', 'archived', 'unknown')),
  previous_parent_id  TEXT,
  previous_rank       TEXT,
  pages               TEXT NOT NULL,             -- JSON: [{ id, parentId, name, kind, role }], the set as captured
  target              TEXT NOT NULL,             -- JSON: { parentId, state, pages: { <id>: LifecycleTarget } }
  summary             TEXT,                      -- JSON: the set summary
  detail              TEXT,                      -- JSON: flags for the owner
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX lifecycle_sets_root ON lifecycle_sets (project_id, root_id, id DESC);
CREATE INDEX lifecycle_sets_recent ON lifecycle_sets (project_id, id DESC);

-- 2. Each page of a set gets its own lifecycle record too, linked to the set's.
ALTER TABLE lifecycle_records ADD COLUMN set_id INTEGER;
CREATE INDEX lifecycle_records_set ON lifecycle_records (project_id, set_id);

-- 3. ADR 0036 decision 7 (the owner's, 11 November 2026): the status tags are guarded, as a per-project canon rule.
--    Projects using the default rules get it from the defaults; a project whose own rules are stored gets it added once
--    (as migrations 1500 and 1600 added theirs).
UPDATE projects
   SET settings = json_insert(settings, '$.canonicalRules[#]',
         json('{"id":"status-tags","kind":"statusTags","note":"The status tags (CANON, Working, Archived, as the lifecycle settings name them) are added or removed only by the lifecycle tools and by creates according to their status; any other route is refused. Every other tag stays free."}'))
 WHERE json_valid(settings)
   AND json_type(settings, '$.canonicalRules') = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(projects.settings, '$.canonicalRules') r
                    WHERE json_extract(r.value, '$.kind') = 'statusTags');
