-- v2 D1 (ADR 0038): the calendar engine and chronology sync. Numbered 1800 so that C2d, running alongside, can take 1700.
--
-- 1. The calendar definitions the bridge last read, per project and calendar (calendar_date answers from them without a
--    LegendKeeper call; the write tools read the calendar again before each plan).
CREATE TABLE chronology_calendars (
  project_id  TEXT NOT NULL REFERENCES projects (id),
  calendar_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     TEXT,
  definition  TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, calendar_id)
);

-- 2. One row per chronology change (create, update or delete of an event), written by the change's own job: `begin`
--    when it starts (incomplete) and `complete` at its end. A change that stopped part-way is resumed by the same
--    request (only what is left; never replayed) and keeps its row; the owner can mark one resolved on the dashboard.
CREATE TABLE chronology_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  tool         TEXT NOT NULL,
  request_key  TEXT NOT NULL,
  ages         TEXT NOT NULL DEFAULT '[]',
  summary      TEXT NOT NULL,
  target       TEXT NOT NULL,
  observed     TEXT,
  state        TEXT NOT NULL CHECK (state IN ('incomplete', 'complete', 'resolved')),
  job_id       TEXT,
  jobs         TEXT NOT NULL DEFAULT '[]',
  principal_id TEXT NOT NULL,
  approver     TEXT,
  proposal_id  TEXT,
  detail       TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX chronology_records_state ON chronology_records (project_id, state, id);
CREATE INDEX chronology_records_job ON chronology_records (project_id, job_id);

-- 3. Which table row and which timeline event are one chronology event (the bridge's own creations, whose short
--    timeline name differs from the row's full description). Older rows are matched by date and text.
CREATE TABLE chronology_links (
  project_id           TEXT NOT NULL REFERENCES projects (id),
  table_document_id    TEXT NOT NULL,
  row_id               TEXT NOT NULL,
  timeline_document_id TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  age                  TEXT NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (project_id, table_document_id, row_id)
);
CREATE INDEX chronology_links_event ON chronology_links (project_id, timeline_document_id, event_id);

-- 4. The chronology check's runs (the maintenance job and the dashboard's button): findings only, never repairs.
CREATE TABLE chronology_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  trigger     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  requests    INTEGER NOT NULL DEFAULT 0,
  summary     TEXT,
  findings    TEXT NOT NULL DEFAULT '[]',
  ages        TEXT NOT NULL DEFAULT '[]',
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX chronology_checks_project ON chronology_checks (project_id, id);
