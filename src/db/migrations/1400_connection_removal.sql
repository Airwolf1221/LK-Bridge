-- Hotfix (ADR 0033): removing revoked and expired connections, and replacing a connection when the same application
-- reconnects.
--
-- 1. A tombstone for every connection (an OAuth grant or a personal access token) the owner, or the daily sweep,
--    removes. Removing deletes the credentials (the grant's token family with its refresh tokens, access tokens and
--    codes, or the PAT row), but the journal, proposals, jobs, errors and the audit log keep `principal_id`, so the
--    dashboard and the MCP tools still need to say who it was. They fall back to this table.
--    The times are Unix MILLISECONDS here (the auth tables hold seconds; the conversion is done once, on removal).
CREATE TABLE removed_connections (
  id            TEXT PRIMARY KEY,                 -- the grant (grant_…) or PAT (pat_…) id: the principal id history holds
  type          TEXT NOT NULL CHECK (type IN ('grant', 'pat')),
  label         TEXT NOT NULL,                    -- the OAuth client's name (self-reported) or the PAT's name
  client_id     TEXT,                             -- grants only
  profile_id    TEXT,
  profile_label TEXT,                             -- the profile's label when the connection was removed
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  expires_at    INTEGER,
  removed_at    INTEGER NOT NULL,
  removed_by    TEXT NOT NULL CHECK (removed_by IN ('owner', 'system'))
);
CREATE INDEX removed_connections_removed ON removed_connections (removed_at);

-- 2. The grants (token families) an authorisation code replaces: a JSON array of family ids the owner ticked on the
--    consent page. They are revoked only when the code is exchanged for tokens (never at approval).
ALTER TABLE auth_codes ADD COLUMN replaces TEXT;
