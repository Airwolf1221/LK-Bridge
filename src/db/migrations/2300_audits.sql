-- v2 E2 (ADR 0044): audits. Findings only, read from the snapshots (never from LegendKeeper).
--
-- 1. `audit_config`: one row a project: the owner's rules (a list, edited on the dashboard, audited, re-authentication
--    required), the tag-definition source (a page and one of its documents) and the other audit settings (JSON, validated
--    by src/audits/config.ts).
-- 2. `audit_runs`: one row a run: when, how long, which snapshot it read (the newest complete full snapshot, plus any later
--    change snapshots) and how old that was, and the counts.
-- 3. `audit_findings`: one row a finding, tracked across runs by its fingerprint (code, page, document, block and the
--    check's own key). `first_seen_*` / `last_seen_*` / `resolved_*` say new, still present and gone; `evidence_hash`
--    is what an acknowledgement is tied to.
-- 4. `audit_acks`: the owner's acknowledgements, with a reason. An acknowledgement hides a finding while the same
--    evidence persists (same hash) and lapses when the evidence changes. Kept when a finding goes, so a finding that
--    comes back with the same evidence is still acknowledged.

CREATE TABLE audit_config (
  project_id  TEXT PRIMARY KEY REFERENCES projects (id),
  rules       TEXT,                 -- JSON: the rules (NULL: the seeded defaults apply)
  tag_source  TEXT,                 -- JSON: { pageId, documentId } or NULL
  settings    TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE audit_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects (id),
  trigger            TEXT NOT NULL,                       -- 'snapshot' (after a full snapshot), 'manual', 'schedule'
  state              TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'skipped')),
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  duration_ms        INTEGER,
  snapshot_id        TEXT,                                -- the full snapshot read
  snapshot_taken_at  INTEGER,
  snapshot_age_ms    INTEGER,                             -- the run's start minus the snapshot's time
  change_snapshots   INTEGER NOT NULL DEFAULT 0,          -- later change snapshots laid over it
  newest_snapshot_id TEXT,                                -- the newest snapshot used (full or change)
  stale              INTEGER NOT NULL DEFAULT 0,
  pages              INTEGER NOT NULL DEFAULT 0,
  counts             TEXT,                                -- JSON: findings by category and severity; new, still, gone
  summary            TEXT,
  error              TEXT
);
CREATE INDEX audit_runs_project ON audit_runs (project_id, started_at DESC);

CREATE TABLE audit_findings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects (id),
  fingerprint      TEXT NOT NULL,
  code             TEXT NOT NULL,
  category         TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  page_id          TEXT,
  page_name        TEXT,
  page_path        TEXT,
  document_id      TEXT,
  block_id         TEXT,
  message          TEXT NOT NULL,
  evidence         TEXT NOT NULL,                         -- JSON: what was expected and what was found
  evidence_hash    TEXT NOT NULL,
  source           TEXT NOT NULL,                         -- JSON: { kind, snapshotId, takenAt, ageMs, … }
  fix              TEXT,                                  -- JSON: the proposed fix's arguments, or NULL
  state            TEXT NOT NULL CHECK (state IN ('open', 'gone')),
  first_seen_run   TEXT NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  last_seen_run    TEXT NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  resolved_run     TEXT,
  resolved_at      INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX audit_findings_state ON audit_findings (project_id, state, category, severity);
CREATE INDEX audit_findings_page ON audit_findings (project_id, page_id);
CREATE INDEX audit_findings_run ON audit_findings (project_id, last_seen_run);

CREATE TABLE audit_acks (
  project_id     TEXT NOT NULL REFERENCES projects (id),
  fingerprint    TEXT NOT NULL,
  evidence_hash  TEXT NOT NULL,
  reason         TEXT NOT NULL,
  acked_by       TEXT NOT NULL,
  acked_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
) WITHOUT ROWID;

-- 5. The two audit placeholders of chunk 6 (`orphan-and-link-audit`, `tag-audit`) became the real `audit-run` job (as
--    migration 0700 did for `tree-snapshot`): their rows go.
DELETE FROM maintenance_runs WHERE job_id IN ('orphan-and-link-audit', 'tag-audit');
DELETE FROM maintenance_jobs WHERE id IN ('orphan-and-link-audit', 'tag-audit');
