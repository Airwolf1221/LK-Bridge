-- v3 F6c (ADR 0080; design T3 to T5, as amended; the owner's rulings of 26 November 2026): five structural registry
-- types (Territory, Nation, Divine Realm, Culture family, Religion family) and the roles their entries bind.
--
-- 1. `registry_types.taxonomy_kind`: which of the five a type is (null for every other type, the Character type
--    included). One type of each kind per project. Such a type has no root index: its entries are seeded from the
--    owner's approved index classification (F6b), wherever they are in the tree.
-- 2. `taxonomy_entries.short_name`: a Nation entry's short name (`Cantha`), edited on Repository Mappings. Used only to
--    build its subindexes' names (`<Nation> <Role>`); empty: the nation index's display name is used.
-- 3. `registry_roles`: an entry's role bound to ONE index node (a Territory's `Polities`, a Nation's `Institutions`).
--    One node per role per entry, and one role per node. `needs_review` with its reason when the bridge could not be
--    sure; `origin` says who bound it: the seed, "Add missing", the owner, or a job that made the index (`job`: the
--    territory_category_missing fix, create_index's role form, after the job succeeded). A role with no index is simply
--    unbound: no row.
ALTER TABLE registry_types ADD COLUMN taxonomy_kind TEXT
  CHECK (taxonomy_kind IS NULL OR taxonomy_kind IN ('territory', 'nation', 'divine_realm', 'culture_family', 'religion_family'));
CREATE UNIQUE INDEX registry_types_taxonomy_kind ON registry_types (project_id, taxonomy_kind)
  WHERE taxonomy_kind IS NOT NULL;

ALTER TABLE taxonomy_entries ADD COLUMN short_name TEXT;

CREATE TABLE registry_roles (
  project_id  TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  role        TEXT NOT NULL,                    -- the role's name as the pack gives it (Polities, Institutions)
  node_id     TEXT NOT NULL,                    -- the index it is bound to
  status      TEXT NOT NULL CHECK (status IN ('ok', 'needs_review')),
  reason      TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL CHECK (origin IN ('seed', 'add_missing', 'owner', 'job')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, entry_id, role),
  FOREIGN KEY (project_id, entry_id) REFERENCES taxonomy_entries (project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX registry_roles_node ON registry_roles (project_id, node_id);
