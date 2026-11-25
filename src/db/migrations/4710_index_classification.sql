-- v3 F6b (ADR 0079; design T12 step 1): the owner's decisions on the index classification report. One per index page
-- (its LegendKeeper id): `approve` (the role the report proposed, kept with the rule that proposed it), `change` (the
-- owner's own role, nav or subject, with the subject's kind for a subject index when given), or `undecided` (left for
-- later, on purpose). A decision is the owner's approval, as F6a's are: no pack version each. Deciding again replaces it.
-- The migration proposals (T12 step 2: the `index_prefix` and `index_tags` audit codes) read only approved rows.
CREATE TABLE index_role_decisions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  page_name   TEXT NOT NULL,                    -- the raw name when decided
  action      TEXT NOT NULL CHECK (action IN ('approve', 'change', 'undecided')),
  role        TEXT CHECK (role IS NULL OR role IN ('nav', 'subject')),
  subject     TEXT CHECK (subject IS NULL OR subject IN ('character', 'polity', 'culture', 'religion', 'place', 'story')),
  proposed    TEXT,                             -- the report's proposal when decided (nav, subject, undecided)
  rule        TEXT,                             -- the rule that proposed it
  via         TEXT NOT NULL CHECK (via IN ('approve', 'change', 'undecided', 'bulk')),
  reason      TEXT NOT NULL DEFAULT '',
  by          TEXT NOT NULL,
  at          INTEGER NOT NULL,
  UNIQUE (project_id, page_id),
  CHECK ((action = 'undecided') = (role IS NULL))
);
CREATE INDEX index_role_decisions_project ON index_role_decisions (project_id, at);
