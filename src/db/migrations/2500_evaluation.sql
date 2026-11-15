-- v2 E3 (ADR 0045): two additions to the tool-call log, both for the owner's Tool calls page only.
--
-- 1. `tool_calls.no_base_version`: 1 when the call was a `write_page` or `set_facts` that edits existing content without
--    the version it rests on (`baseVersion` / `baseFactsVersion`), so the page can filter and badge such calls cheaply.
--    Decided when the call is recorded, from the NAMES of the arguments (the log keeps no values); src/toolcalls/flag.ts
--    holds the definition. Rows written before this migration read 0.
--
-- 2. The Evaluation helper (docs/reviews/scenarios.json, src/evaluation): the owner runs the scripted scenarios in an
--    assistant, presses Start and Done around each, and the bridge attributes the tool calls of THAT assistant's
--    connections made between the two. A run keeps its own compact copy of what was seen (the tool sequence, the error
--    codes, the auto-grade hint), so it survives the log's pruning; the window (the call ids it spans and the
--    connections) is stored so the rows can be looked at again while they are kept. Nothing here is readable by an
--    agent tool.

ALTER TABLE tool_calls ADD COLUMN no_base_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tool_calls_no_base ON tool_calls (id) WHERE no_base_version = 1;

CREATE TABLE evaluation_runs (
  id             TEXT PRIMARY KEY,                    -- evr_…
  created_at     INTEGER NOT NULL,                    -- ms
  assistant      TEXT NOT NULL CHECK (assistant IN ('chatgpt', 'claude')),
  scenario_set   TEXT NOT NULL CHECK (scenario_set IN ('core', 'all')),
  bridge_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('in_progress', 'finished')),
  finished_at    INTEGER,
  -- JSON: connections the owner picked for the whole run (null: chosen by the classifier at each Start)
  principal_ids  TEXT
);
CREATE INDEX evaluation_runs_created ON evaluation_runs (created_at);

CREATE TABLE evaluation_results (
  run_id         TEXT NOT NULL REFERENCES evaluation_runs (id) ON DELETE CASCADE,
  scenario_id    INTEGER NOT NULL,
  title          TEXT NOT NULL,                       -- the short title when the run was made
  state          TEXT NOT NULL CHECK (state IN ('pending', 'recording', 'done')),
  started_at     INTEGER,
  finished_at    INTEGER,
  -- The window: the calls with an id above `start_call_id` and up to `end_call_id`, made by `principal_ids`.
  start_call_id  INTEGER,
  end_call_id    INTEGER,
  principal_ids  TEXT NOT NULL DEFAULT '[]',          -- JSON array of grant_… / pat_… ids
  connection_mode TEXT NOT NULL DEFAULT 'auto' CHECK (connection_mode IN ('auto', 'manual')),
  calls          TEXT NOT NULL DEFAULT '[]',          -- JSON: [{ tool, outcome, code?, live?, noBaseVersion? }] in order
  auto_grade     TEXT,                                -- JSON: the hint (src/evaluation/grade.ts); null until Done
  owner_grade    TEXT CHECK (owner_grade IN ('right', 'partly', 'wrong')),
  note           TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, scenario_id)
);
