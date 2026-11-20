-- v3 F4b (ADR 0064; the owner-approved design docs/design/F4b-consistency-and-as-of.md): the consistency check and
-- "as of a date".
--
-- 1. The facts index: the dated life events (births, deaths, attested bounds) and identity facts the pack's phrasings
--    read from the appraisal's overlay (its full-text units: sidebar facts and page text) and the chronology's tables
--    (from the snapshots). Kept current page by page from the change snapshots, like the other F3c indexes; rebuilt
--    when the pack's phrasings, the characters' names, the calendar or the chronology's settings change.
CREATE TABLE consistency_index_state (
  project_id          TEXT PRIMARY KEY,
  key                 TEXT NOT NULL,          -- what the facts were read with (phrasings, names, calendar, chronology)
  base_snapshot_id    TEXT NOT NULL,          -- the overlay's base full snapshot when built
  pages               INTEGER NOT NULL,
  facts               INTEGER NOT NULL,
  built_at            INTEGER NOT NULL,
  build_ms            INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  last_update_ms      INTEGER
);

-- Each page as the facts were last read from it: its pieces' stamp, its subject and its continuity.
CREATE TABLE consistency_pages (
  project_id       TEXT NOT NULL,
  page_id          TEXT NOT NULL,
  stamp            TEXT NOT NULL,
  subject          TEXT,                       -- the page's Subject fact (or its name's subject part)
  continuity_type  TEXT,
  continuity       TEXT,
  PRIMARY KEY (project_id, page_id)
);

-- Each fact read: who it is about (by a name, never a pronoun), what it says, where, and its date's span and precision.
CREATE TABLE consistency_facts (
  project_id    TEXT NOT NULL,
  page_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('birth', 'death', 'attested', 'identity')),
  field         TEXT,                          -- an identity fact's field (`Race / Species`)
  source        TEXT NOT NULL CHECK (source IN ('temporalScope', 'lifeState', 'prose', 'chronology', 'sidebar')),
  pattern       TEXT NOT NULL,                 -- the pack phrasing that read it (`birth.scope`), or `identity`
  subject_key   TEXT NOT NULL,                 -- the name it is about, normalised (or the page's subject)
  subject_text  TEXT NOT NULL,
  matched_as    TEXT NOT NULL,                 -- `page` (the page's own subject), `name`, `given`, `mention`
  value_text    TEXT NOT NULL,                 -- the date (or value) exactly as written
  gap           INTEGER NOT NULL DEFAULT 0 CHECK (gap IN (0, 1)),
  start_min     INTEGER,                       -- the span on the calendar (LegendKeeper minutes), margin excluded
  end_min       INTEGER,
  precision     TEXT,                          -- day, month, year
  shape         TEXT,                          -- day, month, year, range
  approximate   INTEGER NOT NULL DEFAULT 0 CHECK (approximate IN (0, 1)),
  open_start    INTEGER NOT NULL DEFAULT 0 CHECK (open_start IN (0, 1)),
  open_end      INTEGER NOT NULL DEFAULT 0 CHECK (open_end IN (0, 1)),
  unreadable    TEXT,                          -- why the date could not be read (never guessed)
  document_id   TEXT,
  block_id      TEXT,                          -- the block, the sidebar row, or the chronology row
  section       TEXT,
  excerpt       TEXT NOT NULL,
  mentions      TEXT NOT NULL DEFAULT '[]',    -- JSON: the pages the sentence or row mentions
  PRIMARY KEY (project_id, page_id, seq)
);
CREATE INDEX consistency_facts_subject ON consistency_facts (project_id, subject_key);

-- 2. Agents' suggestions on a finding (design D6): shown to the owner, never applied.
CREATE TABLE consistency_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  finding_id    TEXT NOT NULL,                 -- the consistency finding's stable id (`cf_…`)
  value         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX consistency_suggestions_finding ON consistency_suggestions (project_id, finding_id);

-- 3. The owner's picks (design D6): the value chosen, and the one proposal made of it.
CREATE TABLE consistency_picks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  finding_id        TEXT NOT NULL,
  audit_finding_id  INTEGER,
  value             TEXT NOT NULL,
  side              TEXT,                      -- the side picked (`identity`, a restatement's key), or null (typed)
  picked_by         TEXT NOT NULL,
  picked_at         INTEGER NOT NULL,
  proposal_id       TEXT,
  items             TEXT NOT NULL DEFAULT '[]' -- JSON: one per page edited
);
CREATE INDEX consistency_picks_finding ON consistency_picks (project_id, finding_id);
CREATE INDEX consistency_picks_proposal ON consistency_picks (proposal_id);
