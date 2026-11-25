# ADR 0074: v3 F9: the bulk class P4: whole-repository passes in their own class, with their own floor, behind routine maintenance

- Status: **Proposed** (v3 F9, 24 November 2026). Built and tested against the mock LegendKeeper and the governor's
  fake clock only; nothing in this session touched a live system (no LegendKeeper, no bridge connector, no dashboard,
  no sandbox run). The sandbox check is opt-in and the owner runs it. Where the brief was silent the choice is marked
  **chosen**.
- Design: agreed with the owner in chat, 24 November 2026. Reviewed by the owner: approved with one change, the full
  snapshot's first claim within P4 (decision 3), made before merge. The owner confirmed the 05:30 job is the block-id
  sweep (decision 6).
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
- **The full snapshot has first claim within P4** (the owner's review). Its reads carry `firstClaim`
  (`ExecuteRequest.firstClaim`, through `internalRead` and the client); a lane whose head has it is looked at before
  the class's other lanes (`claimOrder`), so when a full-snapshot request is ready it goes before the link sweep, the
  tree check and the asset check. Those take turns among themselves (the round-robin every class has), and take what
  the snapshot is not ready for (between its sequential reads). Bulk as a whole still stays within
  `RESERVE_FLOOR_BULK`, and P3 still goes before all of P4: first claim orders lanes within a class, never across
  classes or past a floor.

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
  hour. With the snapshot's first claim: the snapshot finished at **03:48**, the asset check at 04:40, the link sweep
  at 05:42, the tree check at 05:47 (before first claim, with all four taking turns: the snapshot at 05:47, the link
  sweep 04:42, the tree check 05:41, the asset check 04:36). The four bulk passes share one 30% share, and agents'
  traffic counts against it. The snapshot does not take the whole share: it reads one request at a time, and the units
  that free between its reads go to the other passes.
- For comparison, RV4's night (everything at P3, heavier agents, test/e4/rv4-budget-night.test.ts) had the snapshot
  finish after 225 minutes with routine work in the same queue.

## Consequences

- Routine maintenance is no longer behind the night's bulk passes; the bulk passes take longer (the snapshot about
  three and a quarter hours on an Arkona night with light agent use, the last pass about five and a quarter), and the
  downstream jobs now wait for the snapshot and its audit (the block-id sweep and the automation run at 05:30 and 06:30
  find it finished, on these figures). To finish sooner, lower
  `RESERVE_FLOOR_BULK` (0.6 gives bulk 40%); it must stay at least the maintenance floor.
- The owner can **reset the P3 floor to its default (0.5)** once this is deployed: the bulk floor now keeps the night in
  check. While the P3 floor stays raised and no bulk floor is set, the bulk floor follows it up.
- Under heavy agent traffic (a quarter or more of key-hour on its own), bulk stalls while agents work, and routine P3
  work can still meet its own 50% floor: agents first, by design (PLAN §5.2).

## Tests

`test/unit/governor-bulk.test.ts` (P4 waits for P1/P2; P3 before P4; P4 when P3 is idle or not ready; the floor; no
starvation under a P3 trickle; turn-taking; patience; queue depth and footer; `setReserveFloors` order; the
snapshot's first claim: with all four bulk passes queued it finishes first, within the floor, with routine work still
first, and without first claim it finishes last), the floors at
load (`test/unit/config.test.ts`), set and save (`test/admin/actions.test.ts`, `test/admin/config-settings.test.ts`), the
registry (`test/unit/config-registry.test.ts`), the callers (`test/f9/snapshot-classes`, `pass-classes`,
`link-sweep-class`, `classification`), the chain (`test/f9/night-chain`), the night (`test/f9/night-p4`), the UI
(`test/ui/pages`, `test/ui/snapshots`), `bridge_budget` (`test/tools/e2e`), and the sandbox check on the mock
(`test/sandbox-mock/bulk-f9`).

The sandbox step (opt-in, the owner's): `deploy/sandbox-test.sh --project test -- bulk-f9` (test/sandbox/README.md).

## Amendment 1 (25 November 2026): the daily tier has floors of its own

- Status: **Proposed** (25 November 2026). Built and tested against the mock LegendKeeper and the governor's fake clock
  only; nothing touched a live system. Where the brief was silent the choice is marked **chosen**.
- Amends: decision 2 (one fraction for every tier), decision 5 (what the bridge shows), PLAN §5.2 (amendment 20),
  `src/lk/README.md` (admission), the Budgets, Overview and Snapshots pages, `bridge_budget`, a job's status.

### The evidence (live, 25 November 2026, 23:15)

The full snapshot stopped at 66%. The dashboard read "Waiting for budget: interactive 0 · jobs 0 · maintenance 0 · bulk
2 · dashboard 0", the bridge otherwise idle. `bridge_budget` for Arkona: key-min 2 / 300, key-hour 22 / 6,000, key-day
18,009 / 60,000 (resets in 1,195 s), project-hour 22 / 12,000; queues P0 to P3 empty, P4 2.

### The cause

Decision 2 gave `RESERVE_FLOOR_BULK` (0.7) to **every** tier, the daily one included. 30% of 60,000 is 18,000: a busy
day of the owner's own and agents' work reached 18,009, so P4 was barred for the rest of the day while the hourly tiers
were almost empty. The chronology check (P3) was waiting, correctly, for the snapshot (F9's chain), not for budget. The
same trap waited for P3 at `RESERVE_FLOOR_MAINTENANCE` (0.5 of the day, 30,000). A design error in F9's handoff, not an
implementation error: it gave one fraction for all tiers, and the night simulation started from an empty day.

### Decision A1: two rows of floors

- The four floors (`RESERVE_FLOOR_INTERACTIVE`, `_JOB`, `_MAINTENANCE`, `_BULK`) keep applying to the **minute and
  hour** tiers, as before, with every rule of decision 2 (the bulk floor's derivation from a raised P3 floor included).
- The **daily** tier has its own: `RESERVE_DAY_FLOOR_INTERACTIVE`, `_JOB`, `_MAINTENANCE`, `_BULK`, fractions, defaults
  **0.02, 0.05, 0.10, 0.15**. Their only purpose is to keep a reserve of the day for the owner's interactive work, so
  they are small: bulk may use the day until 85% of it is spent, leaving 9,000 requests; maintenance until 90%; a job
  until 95%; an agent's call until 98%. P0 (the dashboard) is 0 on both rows.
- The defaults are the brief's (**kept**): the code suggests nothing better. The minute and hour floors already pace
  bulk at 30% of each hour (1,800 an hour, about 14,400 over a night's eight hours), so the day's floor is a stop, not a
  pace; 15% keeps the 9,000 the owner asked for. A 5% gap between bulk (15%) and maintenance (10%) is 3,000 requests:
  enough for a night's routine work (about 1,300 requests in simulation C below) after bulk has stopped.
- The same order, interactive ≤ job ≤ maintenance ≤ bulk, checked on its own row at load (`loadConfig`: a
  `ConfigError` naming the pair, "RESERVE_DAY_FLOOR_\*: The day floor for bulk (5%) is below the day floor for
  maintenance (10%) …"), in `Governor.setDayReserveFloors`, in the Budgets page's day action
  (`PUT /budgets/reserve-day-floors`, `actions.setDayReserveFloors`) and in its F8 Settings entries. No rule ties the two
  rows together (**chosen**: a day floor above an hourly one is odd but harmless).
- Stored by the dashboard as all four together under `dash.reserve_day_floors` (a new legacy id, `dayReserveFloors`,
  **chosen** as the minute-and-hour floors are stored under `dash.reserve_floors`), applied at once to every project's
  governor and at every start (`applyStoredSettings`). Registered in F8's registry, group "Governor and budgets",
  `applies: now`, with descriptions written for the owner; in `.env.example` and `deploy/env.template`, commented out.
- `GovernorSettings.dayReserveFloors` beside `reserveFloors`; `floorFor(settings, class, windowMs)` is the one place
  that picks the row, used by admission (`readyAt`), the "can never fit" check (`validate`), learned tiers and
  `estimate` (whose `fitsToday` and `dayRemaining` now use the day floor).

### Decision A2: which row each tier falls under

By the tier's window (`floorRowOf`: longer than an hour is the day row).

| Tier                                                   | Window               | Row                                                                       |
| ------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------- |
| `write-min`, `key-min`, `items-min` (createMany items) | 1 minute             | minute and hour                                                           |
| `write-hour`, `key-hour`, `project-hour`, `items-hour` | 1 hour               | minute and hour                                                           |
| `key-day`                                              | 1 day                | day                                                                       |
| A learned operation tier (ADR 0047)                    | as inferred          | by its window: a minute or an hour on the first row, a day on the day row |
| `upload`                                               | none (reactive only) | neither: it has no counter, only a 429's block                            |

### Decision A3: the bridge says which tier is blocking

- The governor says what holds each class with queued work (`waitOf`, `waits()`, and `BudgetSnapshot.waits`): the cause
  (`tier`, `refused` by a 429, `pacing`, `agents` queued ahead of P3 and P4, `in-flight`), the tier, its row, the class's
  floor on it, the tier's count and limit, when it frees, and a sentence: "bulk waiting: the daily tier is at 30.0% and
  bulk may use it up to 30% (frees in 20 min)" (`src/lk/governor/wait-text.ts`). The head that may go soonest decides.
- A `BudgetWaitError` carries the same (`wait`); a job parked `waiting_budget` keeps it in its `waitReason` (`cause`,
  `row`, `floor`, `freesAt`, `text`), so `bridge_job_status` shows it; an agent's refused call (`BUDGET_EXHAUSTED`)
  carries `waiting`.
- Shown: the Budgets page's **Waiting for budget** card and the Overview's budget line (a sentence per waiting class,
  live from the stream), `bridge_budget` (`waiting`, with `freesInSeconds`), the Snapshots page's **Runs and schedules**
  card (what holds bulk now, for a running full snapshot).
- The governor emits `class-wait` whenever a class's cause or tier changes (only while someone listens). A full
  snapshot listens while it runs: when the daily tier's floor holds it, the service **logs one warning a run** ("the
  full snapshot is held by the daily tier's floor: …", with the run, tier, floor and when it frees) and the card says
  "The full snapshot is held by the daily tier's floor (since 23:15): …", or afterwards "The last full snapshot was held
  … from … to …" (in memory, **chosen**: a restart forgets it, as the run itself resumes). Once a run: at its floor the
  hold comes and goes request by request as the rolling day frees a unit at a time.

### Decision A4: a held bulk pass loses nothing

- **Confirmed** (as F9 expected): every P4 call is patient, so a full snapshot held by a floor is not parked or
  restarted: its next read waits in the governor's queue and is sent the moment the tier frees; the run goes on from the
  page it reached, each page read once. Tested on the fake clock (a pass at the day floor, rolling and fixed) and on
  the mock (a run held mid-way, then freed: the same requests as a run never held). A run stopped by a restart was
  already resumed from its pending pages (ADR 0042); unchanged.
- **The day's window.** LegendKeeper publishes "1 day" and nothing more. The governor models every tier as a sliding
  window (a unit counts for 24 hours after it was spent), which is safe whichever LegendKeeper uses, and snaps its count
  to LegendKeeper's headers, back-dating the units to LegendKeeper's reset. So:
  - if LegendKeeper's day resets on a **fixed boundary**, a pass held shortly before the reset frees at the reset and
    loses nothing (the snapped units all leave at the reset; tested);
  - if the window is **rolling**, a pass held at its floor frees only as the units spent 24 hours earlier leave: at the
    pace the day was spent, so after a day of steady work about as fast as that work came. Held at 85% after a very
    heavy day (simulation C), the night's passes wait for the morning's units to leave and finish by late morning.
  - The live reading ("resets in 1,195 s" at 23:15) does not tell the two apart: the bridge shows the next unit's expiry
    when LegendKeeper's last header was another tier's. The headers will tell once LegendKeeper reports key-day as the
    tightest tier; nothing in the bridge depends on which it is.

### Measurements (fake clock, published limits, the night of decision 3's measurements)

`test/f9/night-heavy-day.test.ts`: F9's night (`test/f9/night-p4.test.ts`: the snapshot at 00:30 with first claim, the
link sweep 01:15, the tree check 02:30, the asset check 02:50, routine P3 work every 5 minutes, light agent traffic)
after a day of P1 work spread evenly from 08:00 to 23:00, the day a rolling window.

- **A: the day at 18,500 by 23:00, the new defaults.** Never held by the day (at most 29,152 of 60,000 at any bulk
  dispatch). The full snapshot finished at **03:48** (198 minutes), the asset check 04:40, the link sweep 05:42, the
  tree check 05:47: exactly the quiet night's figures, as the day's 18,500 is far below 85%. Routine P3: 624 requests,
  **0 budget waits**, 0 ms dispatch delay.
- **B: the same day under the floors before this amendment** (70% of every tier for bulk, the day included). Held at
  once ("bulk waiting: the daily tier is at 30.8% and bulk may use it up to 30% (frees in 7 h 55 min)"); by noon the
  next day the full snapshot had read **0 of 3,400**: the night's agents keep the rolling day above 18,000 as the
  morning's units leave. This is the live case.
- **C: a very heavy day, 45,000 by 23:00, the new defaults.** Bulk is held at 85% ("bulk waiting: the daily tier is at
  85.0% and bulk may use it up to 85% …") and **never takes the day past it** (at most 51,000 at any bulk dispatch). The
  snapshot finished at 09:37, the asset check 10:32, the link sweep 11:36, the tree check 11:44, once the day's first
  units had left the window. Routine P3 waited 7 times (at most 13 minutes), each on its own day floor (the day at
  54,000 or more), which the night's agents reached after bulk had stopped: bulk never took P3's room. (To keep P3 free
  of waits even on such a day, lower `RESERVE_DAY_FLOOR_MAINTENANCE`, to 0.05 say.)

### Consequences

- A busy day no longer stops the night's passes: they stop at 85% of the day, not at 30%. The 05:30 block-id sweep and
  06:30 automation run (decision 6) find the snapshot finished on an ordinary heavy day, as on a quiet one.
- Every "waiting for budget" now says which tier and floor, and when it frees; the owner need not read the tiers.
- The owner can leave `RESERVE_FLOOR_BULK` at 0.7: it now paces each minute and hour only.

### Tests (amendment 1)

`test/f9/day-floors.test.ts` (the tier-to-row mapping and defaults; the day floors on the day only and the minute and
hour floors on theirs only; the order in `setDayReserveFloors`; the live case at 18,009 before and after; P4 stops at
85%, P3 and agents still go; the P3 equivalent at 30,001 and at 90%; the waiting reason for an hourly wait, for agents'
work, for the write gap and for a 429; `class-wait` on each change; a held pass goes on from where it was, rolling and
fixed), `test/f9/day-floors-surfaces.test.ts` (a parked job's status; `bridge_budget`; `GET /budgets` and `/overview`;
the day row on `/budgets` and `PUT /budgets/reserve-day-floors`: saved, refused out of order, reset, applied at a start;
the four Settings entries, set and refused at save), `test/f9/snapshot-day-hold.test.ts` (a full snapshot held mid-run
and freed, on the mock: the card, one warning, complete, no read twice; once a run however often the hold comes and
goes), `test/f9/night-heavy-day.test.ts` (the measurements), `test/unit/config.test.ts` (the day floors at load),
`test/unit/config-registry.test.ts` (the registry's frozen defaults and ranges), and
`test/unit/governor-estimate-footer.test.ts` (estimates at the day floor).
