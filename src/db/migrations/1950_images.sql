-- v2 D3 (ADR 0041): the image pipeline. Numbered 1950 so that D2, built alongside, can take 1900.
--
-- 1. Every image the bridge converted and uploaded (or is uploading), per project. The id is also the `staged_id` of a
--    staged image. The original's and the stored WebP's hashes, sizes, dimensions, frames and the conversion mode are
--    kept for every upload; `original_sha256` is the per-project deduplication key.
CREATE TABLE image_uploads (
  project_id       TEXT NOT NULL REFERENCES projects (id),
  id               TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('uploading', 'uploaded', 'failed', 'discarded')),
  job_id           TEXT,
  asset_id         TEXT,
  name             TEXT NOT NULL,
  description      TEXT,
  folder_id        TEXT,
  folder_path      TEXT,
  -- Staged: hidden in the staging folder and not yet placed. `intended` is the destination given when staging (JSON).
  staged           INTEGER NOT NULL DEFAULT 0,
  intended         TEXT,
  source           TEXT NOT NULL,
  principal_id     TEXT NOT NULL,
  original_format  TEXT NOT NULL,
  original_sha256  TEXT NOT NULL,
  original_bytes   INTEGER NOT NULL,
  orientation      INTEGER,
  webp_sha256      TEXT NOT NULL,
  webp_bytes       INTEGER NOT NULL,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  frames           INTEGER NOT NULL,
  has_alpha        INTEGER NOT NULL,
  conversion_mode  TEXT NOT NULL CHECK (conversion_mode IN ('converted', 'webp_passthrough')),
  quality          INTEGER,
  convert_ms       INTEGER,
  -- Null: not checked yet; 1: the stored file's SHA-256 equals the uploaded bytes'; 0: it does not, or no download.
  stored_verified  INTEGER,
  stored_sha256    TEXT,
  verify_reason    TEXT,
  error            TEXT,
  placed_at        INTEGER,
  placed_by        TEXT,
  placement_job_id TEXT,
  placement_proposal_id TEXT,
  discard_job_id   TEXT,
  discarded_at     INTEGER,
  discarded_by     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX image_uploads_original ON image_uploads (project_id, original_sha256);
CREATE INDEX image_uploads_asset ON image_uploads (project_id, asset_id);
CREATE INDEX image_uploads_staged ON image_uploads (project_id, staged, created_at);

-- 2. The single-use binary endpoint's uploads (`prepare_image_upload`, then `POST /uploads/<id>`). The capability is
--    stored only as its SHA-256; it is bound to the id, the project, the principal, the file's hash, length and type,
--    expires 5 minutes after it was issued and is used once. A received file waits at most 15 minutes for upload_image.
CREATE TABLE image_upload_slots (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects (id),
  principal_id    TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  byte_length     INTEGER NOT NULL,
  content_type    TEXT NOT NULL,
  name            TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('prepared', 'receiving', 'received', 'consumed', 'expired')),
  token_expires_at INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  file_name       TEXT,
  received_at     INTEGER,
  consumed_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX image_upload_slots_expiry ON image_upload_slots (state, expires_at);

-- 3. The bytes kept before an asset is deleted (the CR-2026-11 open item): content-addressed files in the bridge's
--    private directory, one row per file, and one row per deleted asset that refers to one (from its journal pre-image).
CREATE TABLE asset_kept_bytes (
  sha256       TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  content_type TEXT,
  stored_at    INTEGER NOT NULL,
  last_kept_at INTEGER NOT NULL
);
CREATE TABLE asset_kept_refs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  asset_id     TEXT NOT NULL,
  name         TEXT,
  folder_id    TEXT,
  sha256       TEXT NOT NULL REFERENCES asset_kept_bytes (sha256),
  job_id       TEXT,
  step_no      INTEGER,
  kept_at      INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX asset_kept_refs_asset ON asset_kept_refs (project_id, asset_id);
CREATE INDEX asset_kept_refs_expiry ON asset_kept_refs (expires_at);

-- 4. The owner's permission to delete an asset whose bytes cannot be kept (dashboard, re-authenticated, one use).
CREATE TABLE asset_delete_overrides (
  project_id TEXT NOT NULL REFERENCES projects (id),
  asset_id   TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  PRIMARY KEY (project_id, asset_id)
);
