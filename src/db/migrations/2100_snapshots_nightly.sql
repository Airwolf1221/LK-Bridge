-- v2 E1a follow-up (ADR 0042, decisions 4 and 9; 13 November 2026): the owner's sandbox run showed that LegendKeeper's
-- `updatedAt` does not move when content changes, so the daily changed-pages pass cannot work and is gone. The full
-- snapshot is nightly instead.

-- 1. The pass's memory (each page's `updatedAt` as last seen) has no reader any more.
DROP TABLE IF EXISTS snapshot_seen;

-- 2. Its two project settings (stored in the projects' settings JSON; the schema is loose, so this is tidying only).
UPDATE projects
   SET settings = json_remove(settings, '$.snapshotDailyPass', '$.snapshotDailyPassDocuments')
 WHERE json_valid(settings)
   AND (json_extract(settings, '$.snapshotDailyPass') IS NOT NULL
        OR json_extract(settings, '$.snapshotDailyPassDocuments') IS NOT NULL);

-- 3. Its maintenance job: the row (and its history) goes with it.
DELETE FROM maintenance_jobs WHERE id = 'snapshot-daily';
DELETE FROM maintenance_runs WHERE job_id = 'snapshot-daily';

-- 4. The full snapshot's default schedule changes from Sunday 00:30 to every night at 00:30 (London time). A project that
--    never changed the schedule had its next run worked out from the old default: let it be worked out again.
UPDATE maintenance_jobs
   SET next_run_at = NULL
 WHERE id = 'snapshot-full' AND schedule IS NULL AND enabled = 1;
