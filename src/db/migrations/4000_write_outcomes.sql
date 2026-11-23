-- v3 F5a (ADR 0067; the owner-approved design docs/design/F5-orchestration.md, H10): unknown write outcomes are always
-- reconciled.
--
-- 1. The write journal learns a fifth outcome, `superseded`: the outcome of a write was unknown, and later writes to
--    the same target were applied, so whether it applied can no longer be told, and no longer matters. SQLite cannot
--    change a CHECK constraint in place, so the journal (and its targets, whose foreign key names it) is rebuilt as
--    migration 0600 rebuilt it: every row, id and sequence kept, the indexes made again.
CREATE TABLE write_journal_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  at           INTEGER NOT NULL,
  job_id       TEXT,
  step_no      INTEGER,
  op_id        TEXT NOT NULL,
  principal_id TEXT NOT NULL DEFAULT 'system',
  profile      TEXT NOT NULL DEFAULT 'system',
  approved_by  TEXT,
  risk         TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  target_id    TEXT,
  resource_id  TEXT,
  document_id  TEXT,
  version      TEXT,
  params       TEXT,
  pre_image    TEXT,
  bytes        INTEGER NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'pending'
               CHECK (outcome IN ('pending', 'applied', 'not_applied', 'unknown', 'superseded')),
  operation    TEXT,
  UNIQUE (id, project_id)
);
INSERT INTO write_journal_new (id, project_id, at, job_id, step_no, op_id, principal_id, profile, approved_by, risk,
  target_kind, target_id, resource_id, document_id, version, params, pre_image, bytes, outcome, operation)
SELECT id, project_id, at, job_id, step_no, op_id, principal_id, profile, approved_by, risk,
  target_kind, target_id, resource_id, document_id, version, params, pre_image, bytes, outcome, operation
FROM write_journal ORDER BY id;

CREATE TABLE write_journal_targets_new (
  target_id  TEXT NOT NULL,
  journal_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (target_id, journal_id),
  FOREIGN KEY (journal_id, project_id) REFERENCES write_journal_new (id, project_id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO write_journal_targets_new (target_id, journal_id, project_id)
SELECT target_id, journal_id, project_id FROM write_journal_targets;

-- The new journal continues from the old one's sequence, so no id is ever reused (ids are paging cursors).
INSERT INTO sqlite_sequence (name, seq)
SELECT 'write_journal_new', 0
WHERE EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'write_journal')
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'write_journal_new');
UPDATE sqlite_sequence
SET seq = MAX(COALESCE(seq, 0), COALESCE((SELECT o.seq FROM sqlite_sequence o WHERE o.name = 'write_journal'), 0))
WHERE name = 'write_journal_new';

DROP TABLE write_journal_targets;
DROP TABLE write_journal;
ALTER TABLE write_journal_new RENAME TO write_journal;
ALTER TABLE write_journal_targets_new RENAME TO write_journal_targets;

CREATE INDEX write_journal_at ON write_journal (at);
CREATE INDEX write_journal_job ON write_journal (job_id);
CREATE INDEX write_journal_project ON write_journal (project_id, id);
CREATE INDEX write_journal_resource ON write_journal (project_id, resource_id, id);
CREATE INDEX write_journal_document ON write_journal (project_id, document_id, id);
CREATE INDEX write_journal_principal ON write_journal (project_id, principal_id, id);
CREATE INDEX write_journal_profile ON write_journal (project_id, profile, id);
CREATE INDEX write_journal_target ON write_journal (project_id, target_id, id);
CREATE INDEX write_journal_op ON write_journal (project_id, op_id, id);
-- New: the reconciler's sweep finds the unknown entries without a scan.
CREATE INDEX write_journal_outcome ON write_journal (outcome, id);
CREATE INDEX write_journal_targets_entry ON write_journal_targets (journal_id);
CREATE INDEX write_journal_targets_project ON write_journal_targets (project_id, target_id);

-- 2. The reconciliation of each write whose outcome was unknown: its state (`pending` while the bridge reads the target
--    back, with back-off, for about five minutes; `settled` once an answer is found; `unresolved` when none could be,
--    which the audits' `writes` category shows the owner), the answer, the attempts, and what was compared.
CREATE TABLE write_reconciliations (
  journal_id   INTEGER PRIMARY KEY REFERENCES write_journal (id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'settled', 'unresolved')),
  outcome      TEXT CHECK (outcome IS NULL OR outcome IN ('applied', 'not_applied', 'superseded', 'unknown')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL,
  next_at      INTEGER,
  settled_at   INTEGER,
  settled_by   TEXT,                           -- 'bridge' (read back), 'job' (the job's own recovery), 'start-up'
  reason       TEXT,
  evidence     TEXT                            -- JSON: what was read and compared, the later entries
);
CREATE INDEX write_reconciliations_state ON write_reconciliations (project_id, state, journal_id);
