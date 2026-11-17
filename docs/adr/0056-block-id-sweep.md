# ADR 0056: The block-id sweep, an approved narrow automation

- Status: **Proposed** (v3 F3.5, 17 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper and fixtures. The owner's decisions are quoted from the F3.5 brief; the choices this session made where
  the brief left room are marked **chosen**; departures from the brief are listed at the end with their reasons.
- Replaces: the `assign-block-ids-sweep` placeholder of chunk 6 (PLAN §8 page 6, [ADR 0016](0016-maintenance-and-mappings-choices.md)).
- Builds on: [ADR 0042](0042-snapshots-restore-rehearsal.md) (the snapshots the candidates come from),
  [ADR 0046](0046-e4-owner-decisions.md) decision 1 (`planBlockwise`, which refuses legacy pages),
  [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 1 (`lastMajorRevision: "skip"`),
  [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (the snapshot overlay, and the A2 line) and
  [ADR 0055](0055-write-scope-review-revert-rails.md) (the Review page and the rails, which do not apply here).
- Migration: `3300_block_id_sweep.sql` (the sandbox verdicts, the sweep's settings and stop, its per-document record).
- Numbered 0056: the next free number when this session started; R2 (the independent review, running at the same time)
  may take one too.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script. The new sandbox check (F) is written and type-checked, not run.

## Context

Legacy LegendKeeper documents have blocks without ids, or with an id used twice. The bridge refuses block-by-block writes
to them (`planBlockwise`: "a legacy page: `assignBlockIds` first"), so `write_page`'s block-by-block path, Revert and the
appraisal's fixes cannot work on them, and their blocks cannot be echoed, moved or reverted. LegendKeeper's
`assignBlockIds` gives a page document's blocks ids; it is idempotent and, per the spec, "reads never assign ids".

Arkona's governance (Repository Automation) says automations are read-only by default, and that "a separately approved
narrow automation action must identify exact scope, prerequisites, transformations, verification, concurrency rules and
stop conditions." The sweep is built as exactly that: the six points below are its approved-automation statement, shown
word for word on the job's Maintenance card (`src/blockids/statement.ts`), so that enabling the job is the owner's
informed approval.

## The approved-automation statement (as it appears on the card)

1. **Scope.** Page documents only (never maps, timelines or boards) of pages inside AI REPOSITORY, in each project the bridge serves. A document is a candidate when the latest snapshot shows a block without an id, or an id used more than once (the rule block-by-block writes refuse on). Finding the candidates costs no request.
2. **Prerequisites.** The project is not read-only, writes are not paused and the bridge is not draining. The sandbox check (assign-block-ids) has a recorded PASS for this bridge version, or the owner has set the override, which needs re-authentication and is audited. The job cannot be enabled without one or the other.
3. **Transformation.** One assignBlockIds call per document. Nothing else: no text, structure, sidebar or tag change, and Last Major Revision is never set.
4. **Verification.** Before the call, the whole document is read and journalled as its pre-image. After it, the document is read again and compared with the pre-image, block ids aside: block kinds, order, nesting, text runs and marks, every field and the number of unsupported blocks must be identical, every block must have an id, and no id may appear twice. Anything else is a verification failure.
5. **Concurrency.** Each document is its own engine job at P3, run by the system principal (origin maintenance), holding the page lock. Inside the lock the document must still be exactly the version the pre-image was read at (LegendKeeper takes no If-Match on this call, so the bridge compares the version itself); if it has moved, the document is skipped and retried next run, never forced, and one that has meanwhile gained ids is skipped. At most N documents a run (default 20, set below); a run stops early when the P3 budget says wait.
6. **Stop conditions.** A verification failure stops the whole sweep: the job disables itself and records the document, the differences and the journal entry, shown here in red with the entry to restore from. A run also stops on a governor refusal, read-only mode, a writes pause or the bridge draining, and when a write’s outcome is not known (that document is checked first next run).

## Decisions

1. **A job of the maintenance registry, off by default.** `assign-block-ids-sweep` (`src/maintenance/jobs.ts`) is
   per project, writes (so the scheduler's rule skips it, recorded, under read-only mode, a writes pause or draining),
   calls LegendKeeper at P3, runs in the background, and is recorded on the Jobs page every run. **Default schedule:**
   daily at 05:30 London, after the night's full snapshot (00:30) and the checks that follow it (**chosen**: the brief
   says "nightly, after the snapshot"; the snapshot of Arkona takes an hour or more at P3, so the sweep starts well after
   it, and reads its candidates from the newest overlay whatever the time).
2. **Candidates from the snapshots, at no API cost** (`src/blockids/candidates.ts`). The appraisal's snapshot overlay
   (ADR 0054: the newest full snapshot plus the change snapshots since) is brought up to date and every `page` document
   of every page inside the AI REPOSITORY (not the root itself) is read from the snapshot store. A candidate has a block
   without an id or an id used twice, walking `children` as `planBlockwise` does; a test pins the two rules together.
   Maps, timelines and boards are never read. The scan is cached until the overlay changes. Documents the sweep did (or
   found clean, or gone) after the snapshot that shows them are left out until a newer snapshot shows them again.
3. **One job per document, three steps** (`src/blockids/service.ts`). Before it, the sweep reads the document at P3
   (the pre-image); a document that has meanwhile gained ids is recorded `already` and costs no job. Otherwise one
   `batch_ops` job, `internal`, P3, the system principal, origin `{ kind: 'maintenance', tool: 'assign-block-ids-sweep' }`,
   holding the page lock and the document lock, `lastMajorRevision: "skip"`:
   - `bridge.expect`, document checker `blockids.expect`: inside the lock the document must be exactly the version (and
     content hash) the pre-image was read at, else a conflict and nothing is sent; its result keeps the pre-image for the
     verify step;
   - `assignBlockIds`, its journal entry's pre-image the whole document (`{ version, blocks }`) through
     `journalPreImage`, which the check has just confirmed unchanged;
   - `bridge.verify`, target `checked`, checker `blockids.verify`: the document read back and compared with the
     pre-image by `verifyAssigned` (`src/blockids/detect.ts`): every block's `id` and read-only `version` taken out at
     every depth, the rest compared canonically (kinds, order, nesting, runs and marks, every field), the `unsupported`
     blocks counted, every block with an id, no id twice. The checker records the outcome in `block_id_sweep_docs` itself,
     so a job that finishes after its run has stopped (it waited for budget) is still judged.
4. **Concurrency and limits.** A moved document (the check's conflict) is recorded `moved` and retried next run, never
   forced. At most N documents a run (`block_id_sweep_state.max_per_run`, default 20, 1 to 500, set on the card,
   audited `blockids.max_per_run`). Before each document the run stops early when the project is read-only, writes are
   paused, the bridge is draining, or the governor's estimate of one document at P3 (4 reads, 1 write) would have to
   wait on any tier (`timeMs > 0`). A job that goes to `waiting_budget` stops the run; it finishes by itself.
5. **Stop conditions.** A verification failure records the stop (project, page, document, job, journal entry, the first
   20 differences; audited `blockids.stopped` by `system`), marks the document `failed`, and disables the job (the
   maintenance layer's `onStop` hook; audited `maintenance.disable` by `system`). The run is recorded `failed`. The card
   shows the stop in red with the journal entry to restore from (and the night's snapshot, which holds it too). While the
   stop is unacknowledged every run is skipped; the owner's enabling the job again acknowledges it (audited
   `blockids.stop_acknowledged`) and it stays on the card, no longer red. A run also stops (not disabled) on a refused
   job (read-only, draining), a cancelled job, and a write whose outcome is not known: that document is recorded
   `unverified` and checked first next run, against its journalled pre-image (unchanged: the write never landed, so it is
   done normally; identical but for ids: done; anything else: a verification failure). **Chosen:** a verify step that
   could not read the document back is "not known", not a failure; it stops the run without disabling the job.
6. **The canon guard's exception, explicit and narrow** (`src/blockids/guard.ts`, the first line of
   `CanonicalGuard.entry`). `assignBlockIds` changes no content, so the sweep passes on Authoritative pages. Only when the
   principal is `system`, the origin is `maintenance` with tool `assign-block-ids-sweep`, there is no approval, and the
   request holds nothing but `assignBlockIds` and the bridge's own check and verify steps. Today neither the canon guard
   nor the lifecycle guard treats `assignBlockIds` at all (it is not a sidebar write, a delete or a create; the link
   index lists it as a partial block write only to follow its mentions, `src/lifecycle/index.ts`), so the exception
   changes no outcome today: it makes the decision explicit, so that a later guard rule on block writes cannot stop the
   sweep by accident, nor let anything else through. An agent's `assignBlockIds` through `lk_api_write` keeps today's
   treatment (the gate and the rails decide; a canon change beside it is a canonical proposal).
7. **Not a revision, not an agent's write.** Last Major Revision is never set (`skip`; tested: no `bridge.lmr` step, the
   row unchanged). The jobs are the system principal's, so they never reach the Review page (ADR 0055 decision A) and
   the rails do not apply; they show on the Jobs page with origin `maintenance`.
8. **Prerequisite 2.** A job definition may now say why it cannot be enabled (`MaintenanceJobDef.canEnable`, refused as
   `409 PREREQUISITE_MISSING`); the sweep's is "no sandbox PASS for this bridge version and no override". The sandbox
   check (F) records its verdict (PASS, NOTED or FAIL) in `block_id_sandbox_checks` with the bridge version
   (package.json); only a PASS for the running version counts, so each release is checked again (**chosen**). The
   override (`block_id_sweep_state.override_at`) is set on the card with re-authentication (`REAUTH_REQUIRED` without
   it) and audited `blockids.override`; clearing it needs no re-authentication (it only takes a risk away). A run
   without either is skipped, saying why.
9. **The dry run** (`POST /api/admin/maintenance/assign-block-ids-sweep/dry-run`) lists what the next run would do in
   the selected project (the documents in order, unverified ones first, with their counts), the candidates and those
   still to do, and the estimated cost at P3 (about 4 reads and 1 write a document, the governor's estimate of the time).
   It reads only the snapshot store: no LegendKeeper request, nothing written.
10. **The A2 line** (`src/appraisal/rules.ts`, `owner.ts`): a page whose body is legacy gets `block_ids_pending`, optional
    polish, evidence "Potential Maintenance Issue", follow-up `none`: "waiting for the block-id sweep".

## The sandbox check (F)

`test/sandbox/assign-block-ids.test.ts`, opt-in (`… sandbox-test.sh --project test -- assign-block-ids`). It writes a
throwaway page with blocks sent without ids and reads it back. If LegendKeeper gave them ids on the write (the API may
not be able to make a legacy document), the verdict is **NOTED**, with what to do: make a page in the app's oldest editor
form, or name an existing legacy page in a disposable copy with `LKB_BLOCKIDS_DOCUMENT=<resourceId>/<documentId>`. With
a legacy document it confirms (1) every block gets a unique id, (2) the content is unchanged, `unsupported` blocks
included, (3) the version moves, (4) a second call changes nothing; then deletes the throwaway page and records the
verdict in the bridge's database (`DB_PATH`). Written, not run.

## Departures from the brief, with reasons

- **If-Match.** The brief asks for "If-Match taken from the pre-image read". LegendKeeper's `assignBlockIds` takes no
  `If-Match` (the spec lists no such header; the registry marks it unversioned), so none can be sent. The bridge does its
  own compare-and-swap instead, as it does for `updateProperty`: inside the document's lock the document is read again and
  must be exactly the version (and content) of the pre-image read, or nothing is sent. The window left is between that
  read and the call (milliseconds), against edits made in the LegendKeeper app; the verification after the call catches
  any change to content there, and stops the sweep.
- **Duplicate ids.** The spec says `assignBlockIds` "assigns a stable id to every block that lacks one"; it does not say
  what it does to an id used twice. The verification requires no id twice afterwards, as the brief says, so if
  LegendKeeper leaves duplicates the first such document stops the sweep (safe, and visible on the card). The mock
  renews the second of two equal ids; the sandbox check records what LegendKeeper really does.
- **The page lock.** Each job holds the page (resource) lock and the document lock: the engine requires a job-level lock
  to cover every write, and `assignBlockIds` takes the document's.
- **The "N" setting** is stored in the bridge's database (set on the card) rather than an environment variable, like the
  other per-job settings of the Maintenance page.

## Consequences

- Once a document has ids, `write_page`'s block-by-block path, Revert and the appraisal's fixes work on it.
- The sweep's cost is small and bounded: at most N documents a night, about 4 reads and 1 write each at P3.
- A new job with prerequisites can use `canEnable` and `onEnabled`; nothing else in the registry changed.
- `PLACEHOLDER_IDS` is empty: the framework still takes a placeholder, but none is registered.
