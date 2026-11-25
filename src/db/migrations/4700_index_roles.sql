-- v3 F6b (ADR 0079): the index role. An index is `[INDEX] ` (about one subject, role `subject`) or, new in F6b,
-- `[NAV] ` (one that only groups or routes, role `nav`). Both keep kind `index` (the CHECK below is unchanged), so every
-- site that means "an index, not a source" treats them alike; the few that must tell them apart read the role.
--
-- The role is always derived from the raw name's prefix, so a rename that keeps the prefix keeps it. Filled here from
-- the stored names; a `[NAV] ` name stored before this migration was classified `unclassified`, and the tree's
-- classification version (`kinds-3`) re-classifies those once on its next query, with no reads.
ALTER TABLE tree_nodes ADD COLUMN index_role TEXT CHECK (index_role IS NULL OR index_role IN ('nav', 'subject'));

UPDATE tree_nodes SET index_role = 'subject' WHERE kind = 'index' AND substr(raw_name, 1, 8) = '[INDEX] ';
