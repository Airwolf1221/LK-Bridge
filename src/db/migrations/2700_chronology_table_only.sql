-- v2 E6 "Chronology II" (ADR 0048): the rows of an age table the owner never wants on the timeline ("table-only").
-- One mark per row, by its block id, with the row's three cells as they were when it was marked. The mark hides the row
-- from the chronology check only while those cells are unchanged, as an audit acknowledgement does: if the row changes,
-- it comes back. Set and cleared on the dashboard's Chronology page, audited `chronology.table_only`. No data changes.
CREATE TABLE chronology_table_only (
  project_id        TEXT NOT NULL REFERENCES projects (id),
  table_document_id TEXT NOT NULL,
  row_id            TEXT NOT NULL,
  age               TEXT NOT NULL,
  texts_hash        TEXT NOT NULL,
  texts             TEXT NOT NULL,
  reason            TEXT,
  marked_by         TEXT NOT NULL,
  marked_at         INTEGER NOT NULL,
  PRIMARY KEY (project_id, table_document_id, row_id)
);
