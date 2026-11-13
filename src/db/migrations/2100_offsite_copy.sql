-- v2 E1b (ADR 0043): the encrypted off-site copy to Google Drive.
--
-- 1. `secrets` gains five purposes, all under the scope 'offsite': the Google OAuth client (id and secret), the refresh
--    token, and rclone crypt's password and salt (password2). SQLite cannot change a CHECK constraint in place, so the
--    table is rebuilt with every row copied as it is (the ciphertexts' associated data are scope and purpose, which do
--    not change, so every value still opens). Nothing references `secrets`.
-- 2. `offsite_state`: one row. The connection (the Google account shown on the dashboard, never a token), when the keys
--    were set, the settings (JSON, validated by src/offsite/settings.ts), and the current Drive folder generation.
-- 3. `offsite_folders`: one row per Drive folder the copy has used. A new folder (generation) is started when the keys or
--    the folder change after a copy exists there; the old one is kept until the owner deletes it from the dashboard.
-- 4. `offsite_runs`: every run of the separate runner (lk-bridge-offsite.service) and what it found: start, end, bytes,
--    files, errors, rclone's exit code. The bridge only reads these; the runner writes them.
-- 5. `offsite_findings`: what a verify run (or a copy's checks) found missing or damaged on Drive.

CREATE TABLE secrets_e1b (
  scope       TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 128),
  purpose     TEXT NOT NULL CHECK (purpose IN ('lk_api_key', 'owner_password_hash', 'owner_totp_secret',
                                               'drive_client_id', 'drive_client_secret', 'drive_refresh_token',
                                               'drive_crypt_password', 'drive_crypt_salt')),
  key_id      TEXT NOT NULL CHECK (length(key_id) = 16),
  nonce       BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext  BLOB NOT NULL,
  tag         BLOB NOT NULL CHECK (length(tag) = 16),
  hint        TEXT CHECK (hint IS NULL OR length(hint) <= 4),
  source      TEXT NOT NULL CHECK (source IN ('env_import', 'dashboard')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, purpose)
) WITHOUT ROWID;

INSERT INTO secrets_e1b (scope, purpose, key_id, nonce, ciphertext, tag, hint, source, created_at, updated_at)
  SELECT scope, purpose, key_id, nonce, ciphertext, tag, hint, source, created_at, updated_at FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_e1b RENAME TO secrets;

CREATE TABLE offsite_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  -- 'none' (never connected, or disconnected), 'connected', 'broken' (Google refused the refresh token).
  connection         TEXT NOT NULL DEFAULT 'none' CHECK (connection IN ('none', 'connected', 'broken')),
  account_email      TEXT,
  account_name       TEXT,
  connected_at       INTEGER,
  broken_at          INTEGER,
  broken_reason      TEXT,
  token_checked_at   INTEGER,
  client_saved_at    INTEGER,
  keys_set_at        INTEGER,
  keys_source        TEXT CHECK (keys_source IS NULL OR keys_source IN ('generated', 'entered')),
  generation         INTEGER NOT NULL DEFAULT 1,
  settings_json      TEXT NOT NULL DEFAULT '{}',
  updated_at         INTEGER NOT NULL
);
INSERT INTO offsite_state (id, updated_at) VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE offsite_folders (
  generation          INTEGER PRIMARY KEY,
  -- The Drive path of the folder (not encrypted: rclone crypt encrypts what is inside it), e.g.
  -- 'LK-Bridge backups/lk.example.org/copy-1'.
  path                TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1000),
  created_at          INTEGER NOT NULL,
  first_copy_at       INTEGER,
  last_good_copy_at   INTEGER,
  -- Set when the owner confirmed that a folder already holding a copy this database did not make is to be used
  -- (after a disaster recovery from a fresh database).
  adopted_at          INTEGER,
  retired_at          INTEGER,
  retired_reason      TEXT,
  delete_requested_at INTEGER,
  deleted_at          INTEGER
);

CREATE TABLE offsite_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('copy', 'verify', 'delete_folder', 'restore')),
  trigger         TEXT NOT NULL CHECK (trigger IN ('schedule', 'request', 'after_full', 'cli')),
  generation      INTEGER,
  folder          TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  state           TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'interrupted', 'refused')),
  bytes           INTEGER,
  files           INTEGER,
  errors          INTEGER,
  exit_code       INTEGER,
  rclone_version  TEXT,
  message         TEXT,
  -- JSON: the steps (each rclone command's name, exit code and counts), a verify's counts. Never a token or a key.
  detail_json     TEXT,
  pid             INTEGER
);
CREATE INDEX offsite_runs_kind ON offsite_runs (kind, started_at DESC);

CREATE TABLE offsite_findings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES offsite_runs (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('missing', 'corrupt', 'manifest_unreadable', 'database_bad',
                                          'database_missing', 'store_missing')),
  path      TEXT,
  detail    TEXT
);
CREATE INDEX offsite_findings_run ON offsite_findings (run_id);
