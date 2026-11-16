-- v3 F3a (ADR 0050): setting packs. A pack is data, never code: its rules (one versioned JSON document: the page types
-- it creates, their templates by role, names, placement, sidebar facts, the closed tag grammar and its token maps, the
-- text rules), the governance sources it was derived from, the projects it is attached to, and each version the owner
-- approved. The bridge's own code holds only the engine and small per-type hooks.
--
-- `version` goes up by one on every change of the rules (a token map edited on the Packs page, a newer seed). A version
-- is usable only once the owner has approved it (`approved`), which also records each governance source's document
-- version at that moment; when a source's current version differs, tag computation fails closed until the owner
-- approves again (`drift` records what was seen).
CREATE TABLE packs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  rules       TEXT NOT NULL,
  version     INTEGER NOT NULL CHECK (version >= 1),
  governance  TEXT NOT NULL,
  approved    TEXT,
  drift       TEXT,
  seed        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The projects a pack is attached to (its tools are listed only while it is attached to a served project, and refused
-- for any other). `templates`: the pack's template roles mapped to this project's template ids (ids differ between
-- projects); `notes`: what could not be worked out when it was attached or last approved.
CREATE TABLE pack_projects (
  pack_id     TEXT NOT NULL REFERENCES packs (id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL,
  templates   TEXT NOT NULL DEFAULT '{}',
  notes       TEXT NOT NULL DEFAULT '[]',
  attached_at INTEGER NOT NULL,
  attached_by TEXT NOT NULL,
  PRIMARY KEY (pack_id, project_id)
);

-- Every version of a pack's rules, kept (the audit trail of what each approval covered).
CREATE TABLE pack_versions (
  pack_id     TEXT NOT NULL REFERENCES packs (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  rules       TEXT NOT NULL,
  governance  TEXT NOT NULL,
  approved    TEXT,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (pack_id, version)
);

-- A package's job reserves its character's name when it runs (inside the job, atomically), so two approved proposals
-- for one new character cannot both create it: the second finds the first's reservation (or its pages) and stops with
-- CHARACTER_EXISTS before any write. A reservation counts while its job is queued, running or waiting.
CREATE TABLE pack_reservations (
  project_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  job_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, key, job_id)
);
CREATE INDEX pack_reservations_key ON pack_reservations (project_id, key);
