-- v2 E3 (ADR 0045): the tool-call log. One row for each tool call an assistant makes, so the owner can see which tools
-- each connection really called without copying transcripts. Owner only (the dashboard's Tool calls page); no agent tool
-- reads it.
--
-- A row holds names and sizes, never values that could be secrets or page content (src/toolcalls/summary.ts decides what
-- is shown: a short allow-list of reference arguments such as `page`, `mode`, `section`; everything else is a name with
-- its size). `principal_id` is the connection's grant or PAT id (named on the page the way the journal names it);
-- `profile` and `scope` are the profile's label and scope AT THE TIME of the call. `budget_requests` / `budget_writes` are
-- how far the projects' hourly request and write counters moved while the call ran (approximate: another call in the same
-- moment counts too).
--
-- Kept for `toolcalls.retention_days` days (a `policy_settings` value, default 7, 0 = do not record), pruned by the log
-- itself. Not a LegendKeeper-data table: a call may name no project (list_projects), so `project` is plain text.

CREATE TABLE tool_calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,                 -- when the call started (ms)
  principal_id     TEXT,                             -- grant_… / pat_…; NULL when no policy layer knew the caller
  profile          TEXT,
  scope            TEXT,
  tool             TEXT NOT NULL,
  project          TEXT,                             -- the project the result named
  args             TEXT NOT NULL DEFAULT '[]',       -- JSON: [{ name, type, size?, value? }]
  outcome          TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'proposal', 'waiting', 'queued')),
  code             TEXT,                             -- the error code, or the status the result carried
  job_id           TEXT,
  proposal_id      TEXT,
  duration_ms      INTEGER NOT NULL,
  budget_requests  INTEGER,
  budget_writes    INTEGER,
  result_chars     INTEGER
);

CREATE INDEX tool_calls_at ON tool_calls (at);
CREATE INDEX tool_calls_tool ON tool_calls (tool, at);
CREATE INDEX tool_calls_principal ON tool_calls (principal_id, at);
