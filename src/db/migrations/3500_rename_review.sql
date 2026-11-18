-- v3 F3d amendment (ADR 0058, B and D), 18 November 2026: what a rename lists for the owner to review and never edits.
-- The parts of the old name searched on their own (the old given and family names, each old alias) and the custom
-- mention labels holding the old name, as planned; the report after the job searches the parts again.
ALTER TABLE pack_renames ADD COLUMN review TEXT;  -- JSON: { parts: ReviewPart[], customLabels: ReviewOccurrence[] }, or NULL
