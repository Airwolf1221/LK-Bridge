-- v3 F6c (ADR 0080; design T5, the owner's rulings of 26 November 2026): the owner's decisions on the Nation Subindexes
-- report. One per nation child index (its LegendKeeper id):
--
-- - `accept`: the role and the unified name as the report proposed (`<Nation> <Role>`; `via` `accept_all` when "Accept
--   all matched" took it with the other matched rows);
-- - `map`: the owner's role for a child no rule matched (`via` `map_all` when "for every page with this name" applied it);
-- - `specialist`: a specialist subindex, its name kept, no role, exempt from the checks;
-- - `not_subindex`: not a nation subindex; left alone.
--
-- A decision is the owner's approval, as F6a's and F6b's are: no pack version each. Deciding again replaces it; an undo
-- removes it until a rename carrying its id has been applied (the write journal says so). The owner's mappings (by the
-- child's exact display name) also feed F6b's classifier, so the two reports agree.
CREATE TABLE nation_subindex_decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  page_id       TEXT NOT NULL,
  nation_id     TEXT NOT NULL,                  -- the nation index the child was under when decided
  page_name     TEXT NOT NULL,                  -- the raw name when decided
  action        TEXT NOT NULL CHECK (action IN ('accept', 'map', 'specialist', 'not_subindex')),
  role          TEXT,                           -- accept and map only
  proposed_name TEXT,                           -- the unified display name when decided (accept and map)
  via           TEXT NOT NULL CHECK (via IN ('accept', 'accept_all', 'map', 'map_all', 'specialist', 'not_subindex')),
  reason        TEXT NOT NULL DEFAULT '',
  by            TEXT NOT NULL,
  at            INTEGER NOT NULL,
  UNIQUE (project_id, page_id),
  CHECK ((action IN ('accept', 'map')) = (role IS NOT NULL))
);
CREATE INDEX nation_subindex_decisions_project ON nation_subindex_decisions (project_id, at);
