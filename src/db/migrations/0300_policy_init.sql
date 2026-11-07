-- Chunk 2b: per-connection identity (profiles), permission scopes, proposals and the audit log.
-- Times are Unix milliseconds (as in chunk 2), except where a column copies an auth time (seconds).
-- Earlier migrations are never edited: auth tables gain a profile_id column here.

-- A policy profile. Every OAuth grant and personal access token belongs to exactly one; the scope is
-- evaluated live on every call, so changing it applies at once to every existing connection.
CREATE TABLE agent_profiles (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind       TEXT NOT NULL CHECK (kind IN ('claude', 'chatgpt', 'claude-code', 'other')),
  scope      TEXT NOT NULL CHECK (scope IN ('read', 'propose', 'write')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Small key/value settings owned by the policy layer (default_scope for new connections).
CREATE TABLE policy_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                        -- JSON
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Grants (OAuth token families), the codes that create them, and PATs point at a profile.
ALTER TABLE auth_codes ADD COLUMN profile_id TEXT;
ALTER TABLE auth_token_families ADD COLUMN profile_id TEXT REFERENCES agent_profiles (id);
ALTER TABLE auth_pats ADD COLUMN profile_id TEXT REFERENCES agent_profiles (id);
CREATE INDEX auth_token_families_profile ON auth_token_families (profile_id);
CREATE INDEX auth_pats_profile ON auth_pats (profile_id);

-- Grants and PATs from before this chunk move to a `legacy` profile at scope `read`.
INSERT INTO agent_profiles (id, label, kind, scope, created_at, updated_at)
SELECT 'prof_legacy', 'legacy', 'other', 'read',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM auth_token_families) OR EXISTS (SELECT 1 FROM auth_pats);
UPDATE auth_token_families SET profile_id = 'prof_legacy' WHERE profile_id IS NULL;
UPDATE auth_pats SET profile_id = 'prof_legacy' WHERE profile_id IS NULL;

-- A proposal: write work an agent at scope `propose` asked for, held for the owner's decision.
CREATE TABLE proposals (
  id              TEXT PRIMARY KEY,
  principal_id    TEXT NOT NULL,                  -- grant or PAT id of the proposer
  principal_label TEXT NOT NULL,
  profile         TEXT NOT NULL,                  -- the proposer's profile label at capture time
  origin          TEXT NOT NULL,                  -- JSON: the engine origin of the request
  job_kind        TEXT NOT NULL CHECK (job_kind IN ('single_op', 'batch_ops')),
  title           TEXT NOT NULL,
  priority        TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  on_error        TEXT NOT NULL DEFAULT 'stop' CHECK (on_error IN ('stop', 'continue')),
  summary         TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'conflicted', 'expired',
                                                 'executing', 'executed', 'failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  decided_at      INTEGER,
  decided_by      TEXT,                           -- 'owner' (approve or reject) or 'system' (expiry)
  reject_reason   TEXT,                           -- readable by the proposing agent
  job_id          TEXT,                           -- the batch_ops job that executed it
  conflict        TEXT,                           -- JSON: which operation changed since capture
  error           TEXT,                           -- JSON: why it failed
  finished_at     INTEGER
);
CREATE INDEX proposals_state ON proposals (state, created_at);
CREATE INDEX proposals_principal ON proposals (principal_id, created_at);
CREATE INDEX proposals_job ON proposals (job_id);

-- The ordered operations of a proposal, with the pre-state captured when it was proposed.
CREATE TABLE proposal_ops (
  proposal_id         TEXT NOT NULL REFERENCES proposals (id) ON DELETE CASCADE,
  idx                 INTEGER NOT NULL,           -- from 0, in submission order
  op_id               TEXT NOT NULL,
  op_kind             TEXT NOT NULL,
  params              TEXT NOT NULL,              -- JSON, as the agent sent them (validated)
  params_hash         TEXT NOT NULL,
  options             TEXT,                       -- JSON: allowUnsupportedLoss, confirm
  target              TEXT,                       -- JSON: { op, path } of the read that shows the target
  target_exists       INTEGER CHECK (target_exists IN (0, 1)),
  version             TEXT,                       -- LK version of the target when captured
  fingerprint         TEXT,                       -- SHA-256 of the target's captured state
  pre_state           TEXT,                       -- JSON (capped), for the diff
  pre_state_truncated INTEGER NOT NULL DEFAULT 0 CHECK (pre_state_truncated IN (0, 1)),
  PRIMARY KEY (proposal_id, idx)
);

-- Every owner command and policy change.
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                           -- 'owner' or 'system'
  action TEXT NOT NULL,
  target TEXT,
  before TEXT,                                    -- JSON
  after  TEXT                                     -- JSON
);
CREATE INDEX audit_log_at ON audit_log (at);
