-- v3 F7 (ADR 0070; the owner-approved design LK-Bridge-F7-guided-art-design.md, G3): each character's outfits, for the
-- placement of outfit art (G2) and the art layout audit (G7).
--
-- A character is its asset folder (Characters / … / <Character>), by id: a rename keeps it. An outfit has a name, its
-- aliases (the owner's, on the dashboard), its pieces (asset ids) and its folder (Wardrobe / <Outfit>; null while it
-- has one piece, which is loose in Wardrobe). Matching compares names and aliases with case and spacing normalised
-- (`name_key`, `alias_key`).
CREATE TABLE art_outfits (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  character_folder_id  TEXT NOT NULL,
  character_name       TEXT NOT NULL,
  name                 TEXT NOT NULL,
  name_key             TEXT NOT NULL,
  folder_id            TEXT,
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (project_id, character_folder_id, name_key)
);
CREATE INDEX art_outfits_character ON art_outfits (project_id, character_folder_id);

CREATE TABLE art_outfit_aliases (
  outfit_id  TEXT NOT NULL REFERENCES art_outfits (id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  alias_key  TEXT NOT NULL,
  by         TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (outfit_id, alias_key)
);

CREATE TABLE art_outfit_pieces (
  outfit_id  TEXT NOT NULL REFERENCES art_outfits (id) ON DELETE CASCADE,
  asset_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (outfit_id, asset_id)
);
CREATE INDEX art_outfit_pieces_asset ON art_outfit_pieces (asset_id);

-- A seeding (an owner action on the dashboard): what the bridge read live from one character's folders, for the owner
-- to review before it is saved (`pending` → `saved` or `discarded`). Anything ambiguous is listed, never guessed.
CREATE TABLE art_outfit_seeds (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  character_folder_id  TEXT NOT NULL,
  character_name       TEXT NOT NULL,
  result               TEXT NOT NULL,              -- JSON: { outfits, ambiguous, read }
  state                TEXT NOT NULL CHECK (state IN ('pending', 'saved', 'discarded')),
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  decided_by           TEXT,
  decided_at           INTEGER
);
CREATE INDEX art_outfit_seeds_character ON art_outfit_seeds (project_id, character_folder_id, created_at);
