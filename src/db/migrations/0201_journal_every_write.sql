-- Chunk 8 (required change A): every successful write is journalled, not only destructive ones, so the journal grows
-- much faster. Lookups page newest-first by id, so the filter indexes are keyed on (column, id): a filtered page is an
-- index range scan with no sort. `write_journal_at` stays for pruning by age and for turning `since` into an id bound.
DROP INDEX IF EXISTS write_journal_resource;
DROP INDEX IF EXISTS write_journal_document;
DROP INDEX IF EXISTS write_journal_principal;
CREATE INDEX write_journal_resource ON write_journal (resource_id, id);
CREATE INDEX write_journal_document ON write_journal (document_id, id);
CREATE INDEX write_journal_principal ON write_journal (principal_id, id);
CREATE INDEX write_journal_profile ON write_journal (profile, id);
CREATE INDEX write_journal_target ON write_journal (target_id, id);
CREATE INDEX write_journal_op ON write_journal (op_id, id);

-- Writes that touch several entities at once (createManyResources creates up to 100 resources) list every target here,
-- so a lookup by target id finds them. Rows go with their journal entry (pruning cascades).
CREATE TABLE write_journal_targets (
  target_id  TEXT NOT NULL,
  journal_id INTEGER NOT NULL REFERENCES write_journal (id) ON DELETE CASCADE,
  PRIMARY KEY (target_id, journal_id)
) WITHOUT ROWID;
CREATE INDEX write_journal_targets_entry ON write_journal_targets (journal_id);
