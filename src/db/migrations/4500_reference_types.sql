-- v3 F6a (ADR 0076; design T2): the owner's decisions on the Reference Type values in use, and each publication of the
-- vocabulary to governance. The decisions are the owner's approval (like F5a's exception rulings): no pack version each.
--
-- 1. One decision per value and primary category (a value used in two categories is two rows: the suggestion is made
--    within the page's category). `map`: the value becomes `target` (accepted from the suggestion, or chosen; a new
--    canonical value is added to the category's vocabulary with its role word, `target_new`); `reject`: left as it is
--    and never suggested again; `specialist`: an approved additional type (T13's Specialist exemption), for exactly
--    `pages` or (null) any page in the category. Undone (deleted) only before it was applied: a fix used the mapping
--    (`applied_count`), or the vocabulary holding it was published (`published_at`).
CREATE TABLE reference_type_decisions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  value          TEXT NOT NULL,
  value_key      TEXT NOT NULL,                 -- the value exactly (the decision is about this spelling)
  category       TEXT NOT NULL,                 -- the primary category ('' when the pages have none)
  action         TEXT NOT NULL CHECK (action IN ('map', 'reject', 'specialist')),
  target         TEXT,                          -- map: the canonical value
  target_new     INTEGER NOT NULL DEFAULT 0,    -- map: 1 when the owner typed a new canonical value
  role           TEXT,                          -- the new canonical value's role word
  pages          TEXT,                          -- specialist: JSON [{ id, name }], or NULL for any page in the category
  via            TEXT NOT NULL CHECK (via IN ('accept', 'edit', 'reject', 'specialist', 'bulk')),
  suggestion     TEXT,                          -- the report's suggestion when the decision was made
  reason         TEXT NOT NULL DEFAULT '',
  by             TEXT NOT NULL,
  at             INTEGER NOT NULL,
  published_at   INTEGER,
  applied_count  INTEGER NOT NULL DEFAULT 0,
  applied_at     INTEGER,
  UNIQUE (project_id, value_key, category)
);
CREATE INDEX reference_type_decisions_project ON reference_type_decisions (project_id, at);

-- 2. Each "Publish vocabulary": the section's text, the job writing it, and the decisions it carried (marked published
--    once the job has succeeded).
CREATE TABLE reference_type_publications (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  job_id         TEXT,
  replaced       INTEGER NOT NULL,              -- 1: the section was there and was replaced in place
  text           TEXT NOT NULL,                 -- the section's lines, joined by newlines
  decisions      TEXT NOT NULL,                 -- JSON: the decision ids it carried
  state          TEXT NOT NULL CHECK (state IN ('submitted', 'succeeded', 'failed')),
  by             TEXT NOT NULL,
  at             INTEGER NOT NULL
);
CREATE INDEX reference_type_publications_project ON reference_type_publications (project_id, at);
