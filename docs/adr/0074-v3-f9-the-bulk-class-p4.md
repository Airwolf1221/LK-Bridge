# ADR 0074: v3 F9: the bulk class P4: whole-repository passes in their own class, with their own floor, behind routine maintenance

- Status: **Proposed** (v3 F9, 24 November 2026). Built and tested against the mock LegendKeeper and the governor's
  fake clock only; nothing in this session touched a live system (no LegendKeeper, no bridge connector, no dashboard,
  no sandbox run). The sandbox check is opt-in and the owner runs it. Where the brief was silent the choice is marked
  **chosen**.
- Design: agreed with the owner in chat, 24 November 2026.
- The problem: every maintenance request ran in one class, P3. The nightly full snapshot (00:30) and the passes that
  follow it read the whole repository; routine upkeep (change snapshots' follow-ups, re-reads after a bridge write,
  automation, block-id upkeep) shared the class, its 50% floor and its turn-taking, so a snapshot's thousands of reads
  sat ahead of small routine jobs, and maintenance crawled until 2 to 3 am. The owner had been raising the P3 floor by
  hand to keep the night in check.
- Amends: PLAN §5.2 (the class table; amendment 11), `src/lk/README.md` (admission), the Budgets and Maintenance pages.
- No migration: job rows stay P0 to P3 (decision 1).

## Decision 1: a fifth class, P4 (bulk), a request class only

`PriorityClass` (`src/config/lk.ts`) is `P0`…`P4`; `PRIORITY_CLASSES` lists P4 after P3; the governor has P4 lanes,
its queue depth is in every snapshot (`queues.P4`), and `estimate` takes it.

P4 is a class of **requests**, never of jobs (**chosen**): the jobs tables' `CHECK (priority IN ('P0','P1','P2','P3'))`
stays, and the job engine's `PriorityClass` (`src/jobs/types.ts`) is P0 to P3; the governor's full set is
`GovernorPriorityClass`. Every bulk caller reads through `internalRead`, which takes P4, and a pass's own job record
(a finished build's) stays P3. `internalRead` gains `lane`: a fair-share lane for a read that names no job (a full run is
`snapshot:<run id>`, the link sweep `link-sweep`; the tree and asset passes already used their pass id).

Every P4 call is **patient** in the governor (`isPatient`): a long queue wait is waited, never a `BudgetWaitError` from
the queue, whether or not the caller set `patient`. A 429 with a long Retry-After still surfaces `BudgetWaitError`, which
every bulk reader already sleeps out.

## Decision 2: its own floor, RESERVE_FLOOR_BULK, and the order

`RESERVE_FLOOR_BULK`, a fraction, default **0.7**: bulk may use at most 30% of each tier. In the settings registry
(group "Governor and budgets", `applies: now`, legacy `reserveFloors`, so it is stored with the other three under
`dash.reserve_floors`), `.env.example` and `deploy/env.template` (both commented out: unset is the default behaviour).

The order is **interactive ≤ job ≤ maintenance ≤ bulk**, checked where the floors are checked: at config load
(`loadConfig`), in `Governor.setReserveFloors` (which takes P4, optional), in the Budgets page's Reserve floors action
(`PUT /budgets/reserve-floors`, `actions.setReserveFloors`) and in its F8 Settings entry.

The owner-raised P3 floor: when no explicit bulk value is set (neither saved in the dashboard nor in the environment),
the bulk floor is `max(0.7, maintenance)` (`effectiveBulkFloor`, `src/config/floors.ts`), so a P3 floor raised to 0.8
gives bulk 0.8, and a start never fails on it. An explicit bulk value below the maintenance floor is refused when it is
saved, with a message naming both ("The bulk floor (55%) is below the maintenance floor (60%) …"); at load the
environment's is a `ConfigError` naming both variables. Saving a maintenance floor above an explicit environment bulk
floor is refused the same way. **Chosen**: a stored dashboard trio without `bulk` (every value saved before F9) combined
with an environment bulk floor below its maintenance floor is lifted to the maintenance floor at start (`withBulk`),
never a start-up failure; it can only arise across the two sources.

The Budgets page's Reserve floors card shows the fourth field, "Bulk (P4)", and sends it only when it is set or the owner
changes it, so an unchanged default keeps following the maintenance floor; the Settings page shows the bulk value as it
runs while it is derived.

## Decision 3: scheduling (`pumpOnce`)

- P4 is skipped while P1 or P2 has queued work, exactly as P3 is.
- P4 is **not** skipped because P3 has queued work. P3's lanes are scanned first, so a ready P3 request always goes
  first; P4 dispatches only when no P3 request is ready. A P3 call waiting for its tier or the write gap does not hold
  bulk up, so a trickle of routine work never starves a bulk pass.
- The floors apply as before: P4 uses a tier only down to its own floor (against the tier's whole count), so bulk never
  eats the headroom between its 70% and P3's 50%.
- Within P4, lanes take turns (the round-robin every class has).

## Decision 4: every P3 caller classified

Split by request, not by job. **Bulk (P4)**:

| Caller                                                                           | Where                                                                                                                      | Why                                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The full snapshot: every page, the library, the templates, their image downloads | `src/snapshots/service.ts` `runPages` (`FULL_SNAPSHOT_PRIORITY`)                                                           | Whole repository and whole library, nightly                                                                         |
| The repository tree build's and nightly check's read of every node               | `src/tree/service.ts` `readPhase` (`passPriority(kind, 'read')`)                                                           | One getResource per page of the repository                                                                          |
| The asset tree's build, regular refresh (every 6 h) and nightly check            | `src/assets/service.ts` `walkFolder`, `verifyMissing`, `estimate` (`ASSET_PASS_PRIORITY`); `src/maintenance/asset-jobs.ts` | Each walks every folder of the library (**chosen** for the refresh: it is the same whole-library walk as the check) |
| The link sweep                                                                   | `src/lifecycle/index.ts` (`LINK_SWEEP_PRIORITY`)                                                                           | Reads every page's sidebar and page documents                                                                       |
| The build estimates                                                              | `tree/service.ts` and `assets/service.ts` `estimate`                                                                       | Estimated at the class the reads go at                                                                              |

**Routine (stays P3)**:

| Caller                                                             | Where                                                                          | Why                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Every tree listing (build, sweep, check) and the root check        | `tree/service.ts` `listPhase`, `reconcilePhase` (`passPriority(kind, 'list')`) | About one request per 100 resources: the "find what changed" read                                                   |
| The hourly tree sweep's reads                                      | `tree/service.ts` `readPhase` (sweep)                                          | New and stale nodes only (**chosen**: a small pass, kept routine so the tree stays current beside the night's bulk) |
| Re-reads after a bridge write (tree and asset tree), their retries | `tree/service.ts`, `assets/service.ts` `processPending`                        | Per page, after the bridge's own writes                                                                             |
| The AI REPOSITORY root suggestion                                  | `tree/service.ts` `findRoot`                                                   | One listing                                                                                                         |
| A pass's job record                                                | `tree/service.ts`, `assets/service.ts` `recordPassJob`                         | A job row (P0 to P3)                                                                                                |
| Automation: governance reads, fixes, proposals, its budget check   | `src/automation/service.ts`                                                    | Per finding, re-checked live                                                                                        |
| Automation's retag batch                                           | `src/packs/retag/service.ts` `submitApply`                                     | Per batch                                                                                                           |
| Block-id upkeep (dry run, reads, writes, budget check)             | `src/blockids/service.ts`                                                      | At most N documents a run                                                                                           |
| Chronology on demand and its weekly check                          | `src/chronology/index.ts`                                                      | About 15 requests plus one per 100 events                                                                           |
| A maintenance job's own engine calls and run records               | `src/maintenance/scheduler.ts`                                                 | Jobs (P0 to P3)                                                                                                     |
| The restore rehearsal's jobs                                       | `src/snapshots/rehearsal.ts`                                                   | Owner-started jobs in a sandbox project (its own governor), job rows                                                |
| The Markdown round trip script                                     | `scripts/markdown-roundtrip-core.ts`                                           | A read-only owner script, not maintenance                                                                           |

Change snapshots run at their job's class (P1 or P2), as before; they never were P3. The maintenance job view gains
`budgetClass` (P4 for `snapshot-full`, `tree-check`, `link-sweep`, `asset-refresh`, `asset-check`), shown in the
Maintenance page's class column.

A guard (`test/f9/classification.test.ts`) reads the source: each routine caller still asks for P3 (by file and
function), each bulk file uses its P4 constant, and a new `'P3'` in a file classified as bulk fails until it is
classified here.

## Decision 5: visible

The budget footer adds `P4:n` while P4 has queued work; `bridge_budget` returns `queues.P4` (and its note names the
class); `bridge_estimate` takes `P4`. The Budgets page shows a "P4 · bulk passes" queue and the fourth floor; the
Overview's budget line adds "bulk n". The snapshot service already counted a run's pages (`done` of `total`); the
Snapshots page's "Runs and schedules" card now says, for a running full snapshot, "Full snapshot running: 300 of 1,500
pages (20%), at P4 (bulk) …". Nothing else on the card changed.

## Decision 6: the downstream schedules chain on the snapshot (B5)

Checked: the **audit** after the full snapshot runs on its completion (`afterFull`, `audits.afterFullSnapshot`): it
chains. The off-site copy request does too. The **05:30 block-id sweep** (its candidates come from the latest snapshot)
and the **06:30 automation run** (it acts on the audit's findings) were clock times only: a longer bulk pass would have
raced them with the night before's data. Fixed (`src/maintenance/chain.ts`): a _scheduled_ or catch-up run of either
waits while its project's full snapshot is under way (`SnapshotService.fullInProgress`: a run not finished, or its
after-snapshot hooks) or its audit is running (`AuditService.isRunning`), looking again every 30 s; after 6 hours it is
skipped with the reason (never run against a half-taken snapshot); a manual run goes at once; a stop ends the wait as a
skip. The summary says how long it waited. (The brief's "05:30 consistency run" is taken to be the block-id sweep, the
05:30 job that uses the snapshot; the off-site verify at 05:30 reads no LegendKeeper and the snapshot store only.)

## Measurements (fake clock, published limits, default floors)

`test/f9/night-p4.test.ts`, Arkona's figures (ADR 0042: about 1,500 pages, 3,400 reads a full snapshot, 2.2 a page):

- **The full snapshot alone at 30%: 77 minutes.** key-hour bounds it: 1,800 reads an hour at 30%, taken in the first
  20 minutes at key-min's 90 a minute, then the rest once the hour's window slides. (At P3's 50% it was about 63.)
- **A whole night** (the snapshot at 00:30, the link sweep at 01:15, the tree check at 02:30, the asset check at 02:50,
  6,800 bulk reads in all, routine P3 work every 5 minutes and light agent traffic of about 10% of key-hour): routine
  P3 work never waited (624 requests, 0 budget waits, 0 ms dispatch delay); bulk stayed within 85 a minute and 1,496 an
  hour; the snapshot finished at **05:47**, the link sweep at 04:42, the tree check at 05:41, the asset check at 04:36.
  The four bulk passes share one 30% share, and agents' traffic counts against it.
- For comparison, RV4's night (everything at P3, heavier agents, test/e4/rv4-budget-night.test.ts) had the snapshot
  finish after 225 minutes with routine work in the same queue.

## Consequences

- Routine maintenance is no longer behind the night's bulk passes; the bulk passes take longer (about four to five hours
  on an Arkona night with light agent use) and the downstream jobs now wait for them. To finish sooner, lower
  `RESERVE_FLOOR_BULK` (0.6 gives bulk 40%); it must stay at least the maintenance floor.
- The owner can **reset the P3 floor to its default (0.5)** once this is deployed: the bulk floor now keeps the night in
  check. While the P3 floor stays raised and no bulk floor is set, the bulk floor follows it up.
- Under heavy agent traffic (a quarter or more of key-hour on its own), bulk stalls while agents work, and routine P3
  work can still meet its own 50% floor: agents first, by design (PLAN §5.2).

## Tests

`test/unit/governor-bulk.test.ts` (P4 waits for P1/P2; P3 before P4; P4 when P3 is idle or not ready; the floor; no
starvation under a P3 trickle; turn-taking; patience; queue depth and footer; `setReserveFloors` order), the floors at
load (`test/unit/config.test.ts`), set and save (`test/admin/actions.test.ts`, `test/admin/config-settings.test.ts`), the
registry (`test/unit/config-registry.test.ts`), the callers (`test/f9/snapshot-classes`, `pass-classes`,
`link-sweep-class`, `classification`), the chain (`test/f9/night-chain`), the night (`test/f9/night-p4`), the UI
(`test/ui/pages`, `test/ui/snapshots`), `bridge_budget` (`test/tools/e2e`), and the sandbox check on the mock
(`test/sandbox-mock/bulk-f9`).

The sandbox step (opt-in, the owner's): `deploy/sandbox-test.sh --project test -- bulk-f9` (test/sandbox/README.md).
