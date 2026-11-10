-- OPS2: secrets managed from the dashboard (ADR 0028, docs/projects.md, docs/auth.md).
--
-- 1. `secrets`: the bridge's encrypted secret store. Each value is sealed with AES-256-GCM under a key derived from
--    SECRETS_MASTER_KEY (env file), with a random 96-bit nonce per value and `scope` + `purpose` as associated data,
--    so a ciphertext copied into another row (another project, another purpose) does not decrypt. `key_id` names the
--    master key a row was sealed with (a one-way fingerprint, never the key), so a wrong master key is told apart from
--    a damaged row. No value is ever stored in plain text; `hint` holds the last four characters of an API key only.
-- 2. `secret_imports`: which env variables have been imported into the store (once each), with a SHA-256 of the value
--    imported (domain-separated; the values are high-entropy keys and Argon2id hashes). Used to import each variable
--    only once, and by `env-sync.sh --retire-imported-keys` to recognise an env value the dashboard has since replaced.
-- 3. `owner_recovery_codes`: the authenticator's single-use recovery codes, as SHA-256 hashes of 100-bit random codes.
-- 4. `auth_owner_sessions.reauth_at`: when the session last re-confirmed the owner's password (and authenticator code);
--    sensitive actions need it within the last 5 minutes.
-- 5. `projects.archived_at`: a project removed on the dashboard is archived, not deleted: its history stays readable.

CREATE TABLE secrets (
  scope       TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 128), -- a LegendKeeper project id, or '*' (the owner)
  purpose     TEXT NOT NULL CHECK (purpose IN ('lk_api_key', 'owner_password_hash', 'owner_totp_secret')),
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

CREATE TABLE secret_imports (
  variable    TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  imported_at INTEGER NOT NULL
);

CREATE TABLE owner_recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);

ALTER TABLE auth_owner_sessions ADD COLUMN reauth_at INTEGER;

ALTER TABLE projects ADD COLUMN archived_at INTEGER;
