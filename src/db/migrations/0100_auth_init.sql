-- Chunk 4: OAuth 2.1 authorization server, owner login and personal access tokens.
-- Every secret (client secrets, codes, refresh tokens, PATs, session ids) is stored only as a
-- keyed hash. Times are Unix seconds.

-- Registered OAuth clients: DCR registrations and cached Client ID Metadata Documents.
CREATE TABLE auth_clients (
  client_id                  TEXT PRIMARY KEY,
  kind                       TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  client_name                TEXT,
  redirect_uris              TEXT NOT NULL,            -- JSON array
  grant_types                TEXT NOT NULL,            -- JSON array
  response_types             TEXT NOT NULL,            -- JSON array
  token_endpoint_auth_method TEXT NOT NULL,
  client_secret_hash         TEXT,                     -- NULL for public clients
  scope                      TEXT,
  metadata                   TEXT NOT NULL,            -- JSON: the registered metadata as returned
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  metadata_expires_at        INTEGER,                  -- CIMD: when to re-fetch the document
  last_used_at               INTEGER
);

-- A grant: one user approval for one client. Refresh-token rotation stays inside a family, and
-- reuse of a rotated token revokes the whole family.
CREATE TABLE auth_token_families (
  family_id      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES auth_clients (client_id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,                     -- absolute limit for the family
  revoked_at     INTEGER,
  revoked_reason TEXT,
  last_used_at   INTEGER
);
CREATE INDEX auth_token_families_client ON auth_token_families (client_id);

CREATE TABLE auth_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES auth_clients (client_id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  redirect_uri_provided INTEGER NOT NULL CHECK (redirect_uri_provided IN (0, 1)),
  code_challenge        TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  resource              TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  used_at               INTEGER,
  family_id             TEXT                           -- set when exchanged, for reuse revocation
);

CREATE TABLE auth_refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL REFERENCES auth_token_families (family_id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  rotated_at  INTEGER,                                 -- set once exchanged; reuse is detected
  revoked_at  INTEGER
);
CREATE INDEX auth_refresh_tokens_family ON auth_refresh_tokens (family_id);

-- Access tokens are signed JWTs; this table lets them be listed and revoked before expiry.
CREATE TABLE auth_access_tokens (
  jti          TEXT PRIMARY KEY,
  family_id    TEXT REFERENCES auth_token_families (family_id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  audience     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX auth_access_tokens_family ON auth_access_tokens (family_id);

-- Personal access tokens (shown once, stored hashed). Accepted as Bearer tokens at /mcp.
CREATE TABLE auth_pats (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_hint   TEXT NOT NULL,                          -- last four characters, for display
  scope        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  last_used_at INTEGER
);

-- Owner login sessions (dashboard and OAuth consent).
CREATE TABLE auth_owner_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   INTEGER
);

-- Owner credential state that must survive restarts. The password hash itself lives in the
-- environment (OWNER_PASSWORD_HASH), never in the database.
CREATE TABLE auth_owner_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  totp_last_step INTEGER,
  updated_at     INTEGER NOT NULL
);
