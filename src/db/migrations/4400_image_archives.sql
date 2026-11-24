-- v3 F7c (ADR 0075; the owner-approved design LK-Bridge-F7c-art-archives-design.md, Z1 to Z10): image archives (zips)
-- uploaded for staging. Everything here is server-local: nothing reaches LegendKeeper until a placement job runs.
--
-- An archive is identified by its SHA-256 in its project: the same zip uploaded again is the same archive (same id,
-- same entries). Its server copy is a file the bridge names itself (`server_file`, under images/archives/); a path taken
-- from the zip is never written anywhere.
CREATE TABLE image_archives (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  sha256              TEXT NOT NULL,
  bytes               INTEGER NOT NULL,
  file_name           TEXT,                       -- the name it was uploaded under (display only)
  principal_id        TEXT NOT NULL,
  source              TEXT NOT NULL,              -- 'chatgpt_file' | 'upload_id' | 'dashboard'
  workstream          TEXT,
  state               TEXT NOT NULL CHECK (state IN ('open', 'done', 'discarded', 'expired')),
  server_file         TEXT,                       -- null once the server copy is removed
  entry_count         INTEGER NOT NULL,           -- rows (folders and skipped files are not rows)
  skipped             INTEGER NOT NULL DEFAULT 0, -- __MACOSX/, hidden files
  uncompressed_bytes  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  last_activity_at    INTEGER NOT NULL,
  removed_at          INTEGER,
  discarded_by        TEXT,
  UNIQUE (project_id, sha256)
);
CREATE INDEX image_archives_principal ON image_archives (principal_id, last_activity_at);
CREATE INDEX image_archives_state ON image_archives (state);

-- One row per file entry, in archive order (`seq`). Its stable identity is (archive, path, sha256).
--
-- status: listed (read, not converted; counts against nothing) · queued (asked for, waiting for a conversion slot) ·
-- converting · held (waiting for the hour's brake or for space: held_by, expected_at) · staged (staged_id) · refused
-- (never an image to stage: reason) · failed (a conversion failed: reason; retried once automatically, then on request)
-- · duplicate (the same bytes as an earlier entry: duplicate_of) · discarded (the archive was discarded first).
--
-- staged_id is the staged image's id: reserved when an art call names a not-yet-staged entry (its proposal and job
-- name it from the start), and the id the staged image gets.
CREATE TABLE image_archive_entries (
  archive_id        TEXT NOT NULL REFERENCES image_archives (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  project_id        TEXT NOT NULL,
  path              TEXT NOT NULL,                -- the path inside the zip (information only; never written)
  folder            TEXT,                         -- its folder inside the zip (raw), null at the top level
  sha256            TEXT,                         -- null when the entry could not be read
  bytes             INTEGER NOT NULL,             -- uncompressed
  compressed_bytes  INTEGER NOT NULL,
  format            TEXT,
  width             INTEGER,
  height            INTEGER,
  frames            INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('listed', 'queued', 'converting', 'held', 'staged', 'refused',
                                                    'failed', 'duplicate', 'discarded')),
  held_by           TEXT CHECK (held_by IS NULL OR held_by IN ('rate', 'storage')),
  expected_at       INTEGER,
  reason_code       TEXT,
  reason            TEXT,
  duplicate_of      INTEGER,                      -- seq of the first entry with the same bytes
  staged_id         TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,   -- conversion attempts since it was last asked for
  wanted_at         INTEGER,                      -- when a conversion was asked for (queue order with seq)
  links             TEXT,                         -- JSON: placements waiting for its staged image (proposal or job)
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (archive_id, seq)
);
CREATE INDEX image_archive_entries_status ON image_archive_entries (status, wanted_at);
CREATE INDEX image_archive_entries_staged ON image_archive_entries (project_id, staged_id);
