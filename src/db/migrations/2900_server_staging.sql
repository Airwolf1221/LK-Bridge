-- v3 F2 (ADR 0049 decisions 10 and 11): unapproved images wait on the bridge's server, not in LegendKeeper, and folders
-- are found or created when a job runs.
--
-- 1. A staged image's bytes are kept on the bridge's server (images/staged/, content-addressed by the WebP's SHA-256),
--    not uploaded: `server_sha256` names them. `expiry_warned_at`: when the dashboard first warned that it is past
--    IMAGE_STAGING_MAX_DAYS (it is removed a week after). `legacy_asset_id`: the hidden asset an image staged before F2
--    had in LegendKeeper's staging folder, once migrate-staging has copied its bytes here (its deletion is proposed).
ALTER TABLE image_uploads ADD COLUMN server_sha256 TEXT;
ALTER TABLE image_uploads ADD COLUMN expiry_warned_at INTEGER;
ALTER TABLE image_uploads ADD COLUMN legacy_asset_id TEXT;

-- 2. `npm run images -- migrate-staging --project <name>` asks the running bridge (which holds the project's key) to
--    move the old LegendKeeper staging folder's images to server staging. The command writes a request; the bridge's
--    image sweep runs it within a minute and writes the result, which the command prints. Nothing is deleted without a
--    proposal.
CREATE TABLE image_staging_migrations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  state        TEXT NOT NULL CHECK (state IN ('requested', 'running', 'done', 'failed')),
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  finished_at  INTEGER,
  proposal_id  TEXT,
  result       TEXT
);
CREATE INDEX image_staging_migrations_state ON image_staging_migrations (state, id);
