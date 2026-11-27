-- v3 F6d (ADR 0082; design T13 as amended by the owner on 26 November 2026): templated source names.

-- 1. The report: every source in scope with its status, as the newest audit run judged it from the snapshots (free).
--    Replaced whole by each run (one transaction); the dashboard pages it from here. The owner's rulings are laid over
--    it when it is read (a row whose hash matches a ruling reads `kept`).
CREATE TABLE templated_name_rows (
  project_id     TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  ord            INTEGER NOT NULL,              -- the run order: primary category, then name
  raw_name       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  parent_id      TEXT,
  category       TEXT,
  subject        TEXT,
  reference_type TEXT,
  role           TEXT,
  proposed       TEXT,
  status         TEXT NOT NULL,
  reason         TEXT NOT NULL,
  hash           TEXT NOT NULL,                 -- sha256 of [Subject, Reference Type, full name]
  other_id       TEXT,
  other_name     TEXT,
  PRIMARY KEY (project_id, page_id)
);
CREATE INDEX templated_name_rows_order ON templated_name_rows (project_id, ord);
CREATE INDEX templated_name_rows_status ON templated_name_rows (project_id, status, ord);

-- The run the rows came from, and what was left out of scope (counted by reason).
CREATE TABLE templated_name_reports (
  project_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  built_at     INTEGER NOT NULL,
  snapshot_id  TEXT NOT NULL,
  taken_at     INTEGER NOT NULL,
  excluded     TEXT NOT NULL,                   -- JSON: reason → count
  digest       TEXT NOT NULL                    -- sha256 of the rows: an unchanged report is not written again
);

-- 2. The owner's "Keep this name": a ruling for one page, tied to its Subject, Reference Type and full name when made
--    (`hash`). While all three are unchanged the page is `kept` (no finding, no rename); once one changes the ruling has
--    lapsed and the page is judged again. Owner only, audited (`templatednames.keep`, `templatednames.undo`).
CREATE TABLE templated_name_rulings (
  project_id     TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  page_name      TEXT NOT NULL,
  subject        TEXT,
  reference_type TEXT,
  hash           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  by             TEXT NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (project_id, page_id)
);
