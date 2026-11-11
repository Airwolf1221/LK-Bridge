# Maintenance jobs (chunk 6)

A registry of scheduled housekeeping jobs, a scheduler that keeps its state in SQLite, and the Maintenance Jobs page
(PLAN §8 page 6). Code: `src/maintenance/`, routes in `src/admin/routes/maintenance.ts`, page in
`ui/src/pages/maintenance.tsx`, migration `src/db/migrations/0400_maintenance_mappings.sql`. Tests: `test/maintenance/`,
`test/ui/maintenance.test.tsx`. Interpretation choices are in [ADR 0016](adr/0016-maintenance-and-mappings-choices.md).

## The registry

Each job has an id, name, description, a default schedule, an enabled flag, an _implemented_ flag, and (kept in SQLite)
its last run (time, outcome, duration, engine job id) and next run. The schedule is either **a fixed interval**
(10 seconds to 31 days) or **a daily time on the Europe/London clock**.

| Job                      | Default schedule        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `budget-sampler`         | every 10 seconds        | Stores one budget snapshot (`engine.recordBudgetSample`) for the Request Budgets sparklines. Replaces chunk 5's interim sampler.                                                                                                                                                                                                                                                                                                     |
| `journal-prune`          | daily at 03:30 (London) | `engine.pruneJournal()` with the configured retention (30 days or 2 GB by default; Settings page).                                                                                                                                                                                                                                                                                                                                   |
| `proposal-expiry`        | every 5 minutes         | `ProposalService.expireDue()`. The service's own timer is switched off (see below). The interval follows `POLICY_EXPIRY_SWEEP_SECONDS`.                                                                                                                                                                                                                                                                                              |
| `proposal-prune`         | daily at 03:45 (London) | `ProposalService.pruneFinished()` (v1.0.1): deletes `executed`, `rejected`, `expired` and `failed` proposals that finished more than `POLICY_PROPOSAL_RETENTION_DAYS` (90) days ago, with their operations and stored before-state. See below.                                                                                                                                                                                       |
| `connection-removal`     | daily at 04:00 (London) | Hotfix, [ADR 0033](adr/0033-removing-connections-replace-on-reconnect-and-operation-discovery.md): removes revoked and expired connections (grants and PATs) dead for `connections.auto_remove_days` (default 30, 0 = never) days, counted from `revoked_at`, or `expires_at` if never revoked; deletes their credentials, keeps a tombstone, audited `connection.remove` by `system`. A job record only when something was removed. |
| `sqlite-optimise`        | weekly (every 7 days)   | `PRAGMA optimize` and a passive WAL checkpoint.                                                                                                                                                                                                                                                                                                                                                                                      |
| `tree-sweep`             | hourly                  | v2 A2, per project: the repository tree's structural sweep ([tree.md](tree.md)). Skips a project whose tree is not configured or not built, or whose sweep is switched off.                                                                                                                                                                                                                                                          |
| `tree-check`             | daily at 02:30 (London) | v2 A2, per project: the repository tree's daily consistency check, every page's properties included ([tree.md](tree.md)).                                                                                                                                                                                                                                                                                                            |
| `asset-refresh`          | every 6 hours           | v2 A4, per project: the asset tree's regular refresh, a paced walk of every folder ([assets.md](assets.md)). Skips a project whose asset tree is not built, or whose refresh is switched off (`assetRefreshEnabled`); a manual run goes ahead.                                                                                                                                                                                       |
| `asset-check`            | daily at 02:50 (London) | v2 A4, per project: the asset tree's nightly check, the same walk plus an audit of the cached folder paths ([assets.md](assets.md)). Runs even when the refresh is switched off.                                                                                                                                                                                                                                                     |
| `link-sweep`             | daily at 01:15 (London) | v2 C2c, per project: the link index's paced refresh, for the related pages `archive_page` and `move_to_working` report ([below](#link-sweep-v2-c2c)). Skips a project whose tree is not built.                                                                                                                                                                                                                                       |
| `chronology-check`       | weekly                  | v2 D1, per project: the chronology check, findings only ([below](#chronology-check-v2-d1)). Skips a project whose chronology is not confirmed.                                                                                                                                                                                                                                                                                       |
| `assign-block-ids-sweep` | not implemented         | Placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `orphan-and-link-audit`  | not implemented         | Placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tag-audit`              | not implemented         | Placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                         |

**v2 A2.** Chunk 6's `tree-snapshot` placeholder became the real `tree-sweep` and `tree-check` jobs (migration 0700
removes its old rows). Both are per project, call LegendKeeper at P3 through the tree service's governed reads (the
engine's `internalRead`; a long budget wait is waited out), and are **background** jobs: a full pass takes minutes, so
their scheduled runs go alongside the other jobs instead of holding up the scheduler (the 10-second sampler keeps
sampling during a nightly check). A run that decided not to work (tree not configured, not built, sweep switched off,
a pass already running) is recorded as **skipped** with the reason, and is not recorded as a job.

**Projects (v2 A1).** Each job has a _scope_. A **bridge-wide** job runs once for the whole bridge: the first five implemented
jobs are bridge-wide (`budget-sampler` stores one snapshot per project, from each project's own governor;
`journal-prune`, `proposal-expiry`, `proposal-prune` and `sqlite-optimise` cover every project's rows). Their runs are
recorded with project `*` and are **not** engine jobs (an engine job belongs to one project). A **per-project** job (the
later LegendKeeper jobs) runs once for each project served now, through that project's governor, and each run is
recorded with its project. The Maintenance page is bridge-wide.

A **placeholder** is registered so the page is complete, but it cannot be enabled, run or rescheduled: the toggle is
disabled and says "Not implemented yet", and the API answers `409 NOT_IMPLEMENTED`. Its real logic is a later chunk's work.
A placeholder found enabled in the database is switched off at start-up.

## How the scheduler behaves

- **Persistence.** Enabled flags, edited schedules, last runs and next runs are in `maintenance_jobs`; run history
  (the last 50 per job, `MAINTENANCE_HISTORY_RUNS`) is in `maintenance_runs`. A new install enables the implemented
  jobs, with their next run one interval (or the next daily time) away. A job a release adds (such as `proposal-prune`
  in v1.0.1) is registered the same way on an existing install, at its first start after the upgrade.
- **No backlog.** A next run is always computed from _now_, never from a missed slot. After a restart a job that is
  overdue runs **once** (trigger `catch-up`); 25,920 missed 10-second slots are one run. Changing a schedule or enabling
  a job also counts from now.
- **A run the process died in** is recorded as `interrupted` at the next start and is not repeated.
- **Daily times and the British clocks change.** 03:30 is 03:30 GMT in winter and 03:30 BST in summer, so across the
  change the gap between runs is 23 hours (spring) or 25 hours (autumn). A time that does not exist on the spring day
  (01:00 to 01:59) runs at the same reading after the gap (02:30 BST for 01:30); a time that happens twice on the autumn
  day runs at the first. The tests pin all of these (`test/maintenance/schedule.test.ts`, `scheduler.test.ts`).
- **Priority P3, `system` principal.** Whatever a job does with LegendKeeper goes through `engine.run` at priority
  **P3**, with the `system` principal and an origin `{ kind: 'maintenance', client: 'maintenance', tool: <job id>,
detail: <name> }`, so the governor's P3 floor (default: keep 50% of each tier) applies and the policy gate treats it
  as internal work. A job that calls LegendKeeper (`usesLk`) also waits while P1 or P2 work is queued (looking again
  after `MAINTENANCE_DEFER_SECONDS`, 15 s); that wait is not recorded as a skip. The five bridge-wide jobs touch only
  the bridge's own database, so they are not held back (the sampler would otherwise leave gaps in the sparklines
  exactly when the budget is busiest).
- **Skipped, and the skip recorded.** A job that **writes to LegendKeeper** (`writes`) is skipped, with the reason on
  its last run and in its history, while read-only mode is on or writes are paused, and while the bridge is draining.
  None of the implemented jobs writes to LegendKeeper (the tree jobs only read) (`journal-prune`, `proposal-prune` and `sqlite-optimise` write only the bridge's
  own database, so they keep running under read-only mode); the rule is exercised by a test job and applies to
  `assign-block-ids-sweep` when it is built.
- **Runs are jobs** (per-project jobs only, since v2 A1). A per-project run is recorded as an engine job in its project
  (origin `maintenance`, priority P3, visible on the Jobs page and linked from the last-run column) when its record
  policy says so. Bridge-wide runs (the five bridge-wide jobs) are in the run history only; the tree jobs' runs are jobs of their
  project when they failed or (the check, always) did their work. Every run, recorded as a job
  or not, is in the run history.
- **One timer.** The scheduler arms a single timer for the earliest due job, on the engine's clock. Due jobs run one
  after another, except **background** jobs (v2 A2: `tree-sweep`, `tree-check`), whose runs go alongside (v2 A4 added `asset-refresh` and `asset-check`, also background).

## `proposal-prune` (v1.0.1)

Review finding F-16: finished proposals, and the before-state captured for their diffs (up to 4 MiB each), used to stay
for ever.

- **What goes:** proposals in `executed`, `rejected`, `expired` or `failed` whose finishing time (`finished_at`, else
  `decided_at`, else `updated_at`) is more than `POLICY_PROPOSAL_RETENTION_DAYS` ago (default **90**, 1 to 3,650), with
  their operation rows (`proposal_ops`: params, pre-state, fingerprints), deleted in batches of 500.
- **What never goes:** `pending`, `approved`, `executing` and `conflicted` proposals, however old (a conflicted proposal
  stays until the owner looks at it).
- **What stays:** the job that executed a proposal (its origin keeps `proposal:<id>` as text), its journal entries
  (`approvedBy` included), its errors, and the audit rows that name the proposal. No foreign key points at `proposals`
  except its own operations, so nothing else is touched.
- **Recorded:** every run is a P3 job on the Jobs page; when anything was deleted, one audit row (`system`,
  `proposal.pruned`, the count and the cut-off).
- **Schedule:** daily at 03:45 London time, a quarter of an hour after `journal-prune` (03:30) and before the nightly
  backup (04:15). After a prune the owner's proposal list and an agent's `bridge_proposal_status` answer for that id as
  for any unknown id.

## `chronology-check` (v2 D1)

The chronology check (ADR 0038; PLAN-v2 4.9 and 4.12): **findings only, never a repair**. Per project whose chronology
the owner has confirmed (others are skipped, saying why), it reads the calendar and the Main table once, then each age's
table and its timeline's events (one request per 100 events): about 18 requests on the test world, at priority **P3**,
waiting while agents' P1 or P2 work is queued. It reports table rows without an event and events without a row, and a
row and an event that disagree about the date or shape (`date_mismatch`: its own finding, not two unpaired ones). A row
and an event are paired (ADR 0039) by the bridge's link, by the same date with the event's name the row's description,
by the same date alone when they are the only two on it (the timeline's short name differs from the table's description
by design, so wording alone is not a finding), and, failing those, by the same event with a different date. Dates are
compared as minutes, never as text, so the thousands separator in a year (LegendKeeper's `AA 1988119`, the tables'
`AA 1,988,119`) is never a finding. It also reports rows out of calendar order, wrong KCY values
and cells written differently from the confirmed style, Main counts that differ from the tables, event links that do
not point at their age's table, and dates the engine cannot read. Default **weekly** (an interval: change it on the
Maintenance page); a **background** job. The findings are on the dashboard's **Chronology** page, which can also run
it at once (P2), with **Propose a fix** for a row without an event and for a date mismatch (one `sync_timeline_event`
proposal each, for the owner to approve; the check itself still never repairs). Runs are kept in `chronology_checks`
(migration 1800); a run cut off by a restart is closed as failed by the next.

## `link-sweep` (v2 C2c)

The **link index** (`link_index`, migration 1600; ADR 0035) records which page links to which: a link collection on
a page's sidebar (`kind: collection`, with the collection's title) and a mention in a page document's text (`kind:
mention`, with the document). `archive_page` and `move_to_working` read it to list the pages related to the page they
change ([tools.md](tools.md#the-page-lifecycle-v2-c2c)).

- **Kept up to date from the bridge's own writes.** A write observer on the engine updates the index after every
  successful write the bridge makes (`set_facts`, `write_page`, the creates, the low-level tools, the lifecycle tools):
  a collection written replaces that collection's links, a document written replaces its mentions (a partial block
  write that might remove a mention costs one read of the document), a deleted page or document takes its links away.
  It never holds a write up, and a failure to follow one is logged, not raised.
- **Refreshed by the sweep**, for what changed in the LegendKeeper app: a walk of every page and index of the
  project's repository tree, in id order: one `getResource` per page (its sidebar's collections and its documents),
  then one `getDocumentBlocks` per page document (mentions). Links the pass did not see again are removed at the end.
- **Paced, and gives way to agents.** Every read is at priority **P3**, so the governor's P3 floor keeps half of each
  tier for agents; before each page the sweep waits (up to a minute) while P1 or P2 work is queued for the project; a
  budget wait is waited out, not failed. It is a **background** job: its run goes alongside the other jobs.
- **Resumable.** Progress is stored after every page (`link_sweeps`: the cursor, pages, documents, requests, links);
  a run that stops (a restart, an error) leaves the pass running, and the next run continues after the last page done.
  A pass is never restarted from the start while one is running.
- **Freshness.** Results say `link index as of <the last complete sweep's start> (the last complete sweep), with the
bridge's own writes since`, or that no sweep has finished yet. The dashboard's **Archive and lifecycle** page shows
  the same, and a sweep in progress.
- **Schedule.** Daily at 01:15 London time (a quiet hour, before the tree's nightly check at 02:30), editable on the
  Maintenance Jobs page like any job; switch it off there to rely on the bridge's own writes alone. Every run is a P3
  job of its project (record: always).

**Cost.** About one read per page and index, plus one per page document: on the 1,452-resource test world roughly
2,500 to 2,900 reads a pass; on Arkona (about 3,500 pages) roughly 6,500 to 7,000. No writes. With the default limits
and P3 floor (P3 may use half of each tier: 150 of the 300 reads a minute, 3,000 of the 6,000 an hour), a pass on an
idle test world takes about 20 minutes; on Arkona the hourly half is the limit, so a pass takes about 2¼ to 2½ hours
and shares the P3 half with the tree's nightly check at 02:30 (both continue where they are; agents' work always goes
first). The daily tier (60,000) is not a concern.

## Owner commands

`src/maintenance/commands.ts`, on the owner command layer pattern of chunk 2b (`actor: 'owner'` first, audited, a
`policy` event each, not reachable from MCP): `enable`, `disable`, `setSchedule` (`null` restores the default),
`runNow`. Audit actions: `maintenance.enable`, `.disable`, `.set_schedule`, `.run_now`.

## Admin API (owner session, Origin and CSRF as everywhere)

| Route                                                | Does                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/maintenance`                         | The registry with status, schedule, last and next run; `schedulerEnabled`.                                              |
| `GET /api/admin/maintenance/:id`                     | One job and its recent runs.                                                                                            |
| `POST /api/admin/maintenance/:id/enable` / `disable` | Toggle. `409 NOT_IMPLEMENTED` for a placeholder.                                                                        |
| `PUT /api/admin/maintenance/:id/schedule`            | `{ schedule: { kind: 'interval', everySeconds } \| { kind: 'daily', time: 'HH:MM' } \| null }`. `400 INVALID_SCHEDULE`. |
| `POST /api/admin/maintenance/:id/run`                | Starts a run and answers `202` at once. `409 ALREADY_RUNNING`.                                                          |

## Settings

| Variable                    | Default | Meaning                                                                                                                                       |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAINTENANCE_ENABLED`       | true    | `false`: the scheduler never runs anything by itself (the page and Run now still work). The proposal service then keeps its own expiry timer. |
| `MAINTENANCE_DEFER_SECONDS` | 15      | How soon a job that calls LegendKeeper looks again when P1 or P2 work is queued.                                                              |
| `MAINTENANCE_HISTORY_RUNS`  | 50      | Run records kept per job.                                                                                                                     |

`proposal-prune` reads its retention from the policy settings: `POLICY_PROPOSAL_RETENTION_DAYS` (default 90; 1 to
3,650), see [policy.md](policy.md#settings).

`ADMIN_BUDGET_SAMPLE_SECONDS` (chunk 5) is gone: edit the `budget-sampler` schedule on the page instead.

## Adding a job (later chunks)

Add a `MaintenanceJobDef` to `builtinJobs` (`src/maintenance/jobs.ts`), set `implemented: true`, give it a `run`, and say
whether it `writes` and `usesLk`. Reach LegendKeeper only through `ctx.run(op, params)`: it is P3 and governed. Never call
`lk` directly from a job. A job that runs for minutes sets `background: true`; a run may return `skipped: true` with its
reason. (The tree jobs reach LegendKeeper through the tree service, which reads through the engine at P3 too.)
