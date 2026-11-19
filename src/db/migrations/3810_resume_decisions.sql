-- CR-2026-11-R3: two of the owner's decisions on Resume (ADR 0061 part B).
--
-- 1. R3-54 (decision 3, the owner's (b)): who asked a job to stop. 'owner' (the dashboard), 'system' (the bridge
--    itself), or the principal id of the agent that cancelled its own job (bridge_job_cancel, or its request ended). An
--    agent resumes a cancelled job only when it cancelled it itself; NULL (a cancel recorded before this migration)
--    counts as not the agent's.
ALTER TABLE jobs ADD COLUMN cancelled_by TEXT;

-- 2. R3-55 (decision 4, the owner's (b)): an agent's Resume judges the safety rails again on the steps left; when a
--    rail now covers one, the rest is proposed instead of run. The proposal that holds a job's rest, so the job is not
--    resumed again while it stands.
ALTER TABLE job_stops ADD COLUMN continued_as TEXT;
