-- v2 C2a (ADR 0032): set_facts, the protected canonical facts, and the proposal groundwork for multi-page operations.
--
-- 1. A proposal holds a LIST of high-level operations (PLAN-v2 10.2), not only C1's single `operation`: JSON array,
--    NULL for proposals made before this migration (the dashboard then falls back to `operation`).
ALTER TABLE proposals ADD COLUMN operations TEXT;

-- 2. The page-level summary of a proposal: its operations grouped by the page they affect, in plain labels, made at
--    capture (names as they were then). JSON array of { resourceId, page, parts, label }.
ALTER TABLE proposals ADD COLUMN page_summary TEXT;

-- 3. Protected canonical facts (PLAN-v2 10.3 as refined): a proposal whose expansion makes a protected change can only
--    be approved with "Approve and accept as canon", a separate audited action that records who accepted it as canon.
ALTER TABLE proposals ADD COLUMN requires_canonical INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposals ADD COLUMN canonical_changes TEXT;
ALTER TABLE proposals ADD COLUMN canonical_approved_by TEXT;
ALTER TABLE proposals ADD COLUMN canonical_approved_at INTEGER;

-- 4. How the approved work is submitted, besides its steps: the job-level lock a multi-step write holds for its whole
--    run, and whether the expansion contains the bridge's own check and verify steps. JSON, NULL for plain batches.
ALTER TABLE proposals ADD COLUMN job_options TEXT;

-- 5. What the generic verify step found once the approved job ran (copied from the job when it finishes).
ALTER TABLE proposals ADD COLUMN verification TEXT;

-- 6. The keys of each template's key-value property, in order (set_facts places new template facts in this order).
--    A cache: read on demand, refreshed when older than a day; losing it costs one read per template.
CREATE TABLE template_fact_keys (
  project_id     TEXT NOT NULL,
  template_id    TEXT NOT NULL,
  property_title TEXT NOT NULL,
  keys           TEXT NOT NULL,
  found          INTEGER NOT NULL,
  read_at        INTEGER NOT NULL,
  PRIMARY KEY (project_id, template_id)
) WITHOUT ROWID;
