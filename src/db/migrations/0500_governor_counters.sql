-- v1.0.1 (review finding F-14): the governor's recent per-tier counts, saved periodically and on shutdown and restored
-- at start, so a restart does not forget the last minute, hour and day of LegendKeeper usage. One row per governor.
CREATE TABLE governor_counters (
  key      TEXT PRIMARY KEY,
  saved_at INTEGER NOT NULL,
  data     TEXT NOT NULL                          -- JSON: { v, savedAt, tiers: { <tier>: { buckets, blockedUntil } } }
);
