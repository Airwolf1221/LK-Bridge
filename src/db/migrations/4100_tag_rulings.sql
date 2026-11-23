-- v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H2): the owner's two actions on a retag
-- exception, and agents' suggestions of them.
--
-- 1. "Keep this tag here": a ruling for one page, tied to the page's tag array when it was made (a SHA-256 of the
--    array, in order). While the array is unchanged, the audit keeps the tag like an Approved Supplementary Tag on that
--    page alone; once it changes, the ruling has lapsed and the audit shows the exception again. Owner only (audited
--    `retag.keep_here`), with its date and the owner principal.
CREATE TABLE retag_tag_rulings (
  project_id  TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  tag         TEXT NOT NULL,
  page_name   TEXT NOT NULL,
  tags_hash   TEXT NOT NULL,
  tags        TEXT NOT NULL,                  -- JSON: the array the ruling was made on
  reason      TEXT NOT NULL,
  by          TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id, tag)
);

-- 2. An agent's suggestion of either action, with its reason: shown to the owner beside the exception, never acted on.
--    One per page, tag and principal (the newer replaces the older).
CREATE TABLE retag_ruling_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  tag         TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('keep_here', 'allow_everywhere')),
  reason      TEXT NOT NULL,
  by          TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX retag_ruling_suggestions_page ON retag_ruling_suggestions (project_id, page_id, at);

-- 3. "Allow this tag everywhere": the owner's edit of the Tagging Standard's Approved Supplementary Tags (a job of the
--    bridge's, journalled and revertible), with what the sentence read before and after.
CREATE TABLE retag_supplementary_edits (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  page_id     TEXT,                           -- the exception it was taken from, when one
  job_id      TEXT,
  before_text TEXT NOT NULL,
  after_text  TEXT NOT NULL,
  by          TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX retag_supplementary_edits_project ON retag_supplementary_edits (project_id, at);
