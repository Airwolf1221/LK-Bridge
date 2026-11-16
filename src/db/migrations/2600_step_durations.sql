-- v2 E5.5 (ADR 0047, backlog 16): the governor's estimates use a project's measured per-write duration, the median wall
-- time of its last 200 succeeded write steps (src/jobs/durations.ts). This index lets that read take the newest steps
-- of one project without sorting all of them. No data changes.

CREATE INDEX steps_project_finished ON steps (project_id, finished_at);
