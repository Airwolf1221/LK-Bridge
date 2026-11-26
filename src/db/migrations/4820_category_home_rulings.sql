-- v3 F6c (ADR 0080; design T4, check category_home_mismatch): the owner's "keep it here" for a source whose primary
-- category tag is not allowed in its current home. As F5a's "Keep this tag here" (migration 4100): a ruling for one page,
-- tied to its state when made (a SHA-256 of its tags, in order, and its parent). While both are unchanged the finding is
-- silent; once either changes the ruling has lapsed and the check reports the page again. Owner only, audited
-- (`audits.keep_home`).
CREATE TABLE category_home_rulings (
  project_id  TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  page_name   TEXT NOT NULL,
  state_hash  TEXT NOT NULL,                    -- sha256 of { tags, parentId }
  parent_id   TEXT,
  tags        TEXT NOT NULL,                    -- JSON: the tags the ruling was made on
  reason      TEXT NOT NULL,
  by          TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id)
);
