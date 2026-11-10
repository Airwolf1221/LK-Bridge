-- v2 C1 (ADR 0031): write_page.
--
-- 1. The journal records the HIGH-LEVEL operation of a write next to its params and pre-image (for write_page: the
--    tool, mode, section, a SHA-256 of the Markdown, the version the plan was built on, and whether it was re-planned
--    inside the lock). JSON, NULL for every other write.
ALTER TABLE write_journal ADD COLUMN operation TEXT;

-- 2. A proposal can hold a high-level operation as well as its expansion into steps (PLAN-v2 10.2): for write_page the
--    page, document, mode, section and Markdown, and the page's Markdown before and after, for the dashboard's Markdown
--    diff. JSON, NULL for v1 proposals.
ALTER TABLE proposals ADD COLUMN operation TEXT;

-- 3. The bridge's memory of recent page versions (their Markdown), so that a section edit made from an older read can
--    be checked: the section the agent read (rebuilt from its baseVersion) must equal the section now. Written by
--    read_document and write_page; a few versions per document, for a few days (src/pages/versions.ts).
CREATE TABLE document_versions (
  project_id  TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version     TEXT NOT NULL,
  markdown    TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, document_id, version)
) WITHOUT ROWID;
CREATE INDEX document_versions_seen ON document_versions (seen_at);
