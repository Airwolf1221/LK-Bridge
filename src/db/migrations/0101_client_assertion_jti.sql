-- v1.0.2 hotfix (ADR 0021): private_key_jwt client authentication (RFC 7523). Each client assertion's jti is recorded
-- until the assertion could no longer be accepted (its exp plus the clock-skew allowance), so an assertion cannot be
-- replayed, not even across a restart. Rows are pruned once expired. Times are Unix seconds.
CREATE TABLE auth_client_assertion_jtis (
  client_id  TEXT NOT NULL,
  jti        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, jti)
);
CREATE INDEX auth_client_assertion_jtis_expiry ON auth_client_assertion_jtis (expires_at);
