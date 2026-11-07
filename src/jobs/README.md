# `src/jobs`: job engine, writers, locks, guards and the write journal

Everything that talks to LegendKeeper runs as a persisted step, through the governor (`src/lk`), with writer slots,
locks, data-loss guards and the write journal (PLAN §4, §6). Chunks 3 and 5 import from `src/jobs/index.ts` only. The
interface below is meant to stay stable; change it only with a note in `docs/CHANGELOG.md`. Design choices the plan
left open are recorded in [ADR 0010](../../docs/adr/0010-job-engine-verification-and-holds.md).

## Quick start

```ts
import { jobsSettingsFrom, lkSettingsFrom, loadConfig } from '../config/index.js';
import { runMigrations } from '../db/migrate.js';
import { openDatabase } from '../db/open.js';
import { createLkClient } from '../lk/index.js';
import { createJobEngine } from '../jobs/index.js';

const config = loadConfig();
const db = openDatabase(config.server.dbPath);
runMigrations(db); // applies 0200_jobs_init.sql
const engine = createJobEngine({
  db,
  lk: createLkClient(lkSettingsFrom(config)),
  settings: jobsSettingsFrom(config),
});

const r = await engine.run(
  'getDocumentBlocks',
  { path: { resourceId, documentId } },
  { origin: { kind: 'mcp', client: 'claude', tool: 'lk_api_read' } },
);
// { status: 'succeeded', jobId: null, result, requestIds }
```

`createJobEngine` starts at once (pass `autoStart: false` to call `engine.start()` yourself). `start()` performs the
restart-resume; `await engine.stop()` is the clean shutdown (in-flight calls finish, unfinished jobs stay queued).

## Exported interface

| Export                                                                            | What it is                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createJobEngine({ db, lk, settings, clock?, log?, policyGate?, proposalSink? })` | Builds the engine on a migrated database, an `LkClient` and `JobsSettings` (`jobsSettingsFrom(config)` in `src/config/jobs.ts`). `clock` defaults to the system clock (tests pass chunk 1's `FakeClock`, the same one the `LkClient` uses). `policyGate` / `proposalSink`: see _Principals and policy hooks_.                                                                                                     |
| `engine.run(op, params, opts)`                                                    | One registry operation. `params` is the registry's caller-facing input `{ path?, query?, ifMatch?, body? }`; `opts` is `{ origin, priority? = 'P1', title?, signal?, allowUnsupportedLoss?, confirm? }`. Returns `RunResult` (below). Throws only `JobsError` subclasses.                                                                                                                                         |
| `engine.submit(req)`                                                              | **Async.** Queues a multi-step job and resolves with `{ jobId, status, eta }` at once (or `{ status: 'proposal_captured', proposalId }`). `req` is `{ kind: 'batch_ops', steps: [{ op, params, allowUnsupportedLoss?, confirm? }], onError?: 'stop' \| 'continue', priority? = 'P2', origin, title? }` or `{ kind: 'paginate_all', op, params?, maxItems?, maxPages?, priority?, origin, title? }`.               |
| `engine.wait(jobId, ms)`                                                          | Bounded wait (at most 25 s, `maxWaitMs`) for the job to finish. Resolves with the `JobView` as it stands then (finished or not).                                                                                                                                                                                                                                                                                  |
| `engine.controls`                                                                 | `pauseWrites(by?)`, `resumeWrites(by?)`, `drain()` (resolves when nothing runs), `undrain()`, `setWritersMax(1–8, by?)`, `setReadOnly(true \| false \| null, by?)`, `cancel(jobId)`, `pauseJob(jobId)`, `resumeJob(jobId)`, `retryStep(jobId, stepNo, { force? })`. Each returns the new `ControlsView` or `JobView`.                                                                                             |
| `engine.queries`                                                                  | `listJobs(filter)` (status, origin kind, `principalId`, `profile`, kind, before), `getJob(id)` (with steps and artefacts), `readArtifact(id, { offset, limit })`, `listErrorGroups(filter)`, `listErrors(filter)` (both filter by `principalId`), `resolveErrorGroup(fingerprint)`, `journalLookup(filter)`, `listBudgetSamples(range)`, `runtimeSettings()`, and in-memory `writers()`, `locks()`, `controls()`. |
| `createJobQueries(db)`                                                            | The database half of `engine.queries`, for code that has only the `db`.                                                                                                                                                                                                                                                                                                                                           |
| `engine.events.on(name, cb)`                                                      | Typed events for the SSE stream; returns an unsubscribe function. `job` (`{ type: 'created' \| 'updated', job }`), `step` (`{ jobId, principalId, profile, step }`: a step reached a final state), `lock` (`acquired` / `waiting` / `released`), `writers` (`WritersView`), `error` (`ErrorRecordView`), `controls` (`ControlsView`).                                                                             |
| `engine.recordBudgetSample(snapshot?)`                                            | Stores one budget sample (defaults to `lk.governor.snapshot()`). Chunk 6's `budget-sampler` calls it every 10 s.                                                                                                                                                                                                                                                                                                  |
| `engine.pruneJournal()`, `pruneJournal(db, retention)`                            | Journal retention (default 30 days or 2 GB). Chunk 6's `journal-prune` calls it.                                                                                                                                                                                                                                                                                                                                  |
| `journalLookup(db, filter)`                                                       | `{ jobId?, resourceId?, documentId?, targetId?, opId?, principalId?, profile?, since?, until?, limit?, includePreImage? }`, newest first. Backs `bridge_journal_lookup`.                                                                                                                                                                                                                                          |
| Guard helpers                                                                     | `checkSubmitGuards(op, params, options, { readOnly, allowMemberAdmin })`, `cascadeRequested(params)`, `unsupportedBlockIds(tree)`, `unsupportedLoss(current, incoming)`, `assertNoUnsupportedLoss(...)`.                                                                                                                                                                                                          |
| Other helpers                                                                     | `lockKeyFor(op, params)`, `matchesIntent(intended, actual, mode)`, `mintClientId()`, `isClientId()`, `OP_META` / `opMeta(op)` (per-operation verify, reader, journal and guard metadata), `LockManager`, `WriterPool`.                                                                                                                                                                                            |
| Typed errors (`JobsError` and subclasses)                                         | See below.                                                                                                                                                                                                                                                                                                                                                                                                        |

### `RunResult`

```ts
| { status: 'succeeded'; jobId: string | null; result: unknown; requestIds: string[] } // jobId null for reads
| { status: 'queued' | 'waiting_budget'; jobId: string; eta: number | null;
    reason: 'estimate' | 'budget' | 'writes_paused' | 'read_only' }
| { status: 'proposal_captured'; proposalId: string } // the policy gate asked for approval; nothing was queued
```

- A single read runs inline and is not recorded as a job. A single write runs inline and is recorded as a one-step
  `single_op` job (UI and journal).
- When `lk.governor.estimate` predicts more than 20 s (`inlineMaxEstimateMs`), the call is queued instead and the
  agent polls or calls `engine.wait`. A write accepted while writes are paused comes back `queued` with `eta: null`.
- An inline write that meets a long budget wait comes back `waiting_budget`: the job resumes on its own; do not
  re-submit it. An inline read throws `BudgetExhaustedError { tier, retryAtMs }` instead.

### Typed errors

All have `code`, `message`, and `jobId` / `stepNo` when a job recorded the work; `toJSON()` is safe to show.

| Class                              | `code`                     | When                                                                                                                                          |
| ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnknownOperationError`            | `UNKNOWN_OPERATION`        | Not one of the 89 operations                                                                                                                  |
| `InvalidParamsError`               | `INVALID_PARAMS`           | Params fail the registry's schema (`issues[]` with paths); nothing is queued                                                                  |
| `PolicyDeniedError`                | `POLICY_DENIED`            | The policy gate denied it (or proposed it with no proposal sink); `opId`, `reason`, `principalId`, `stepIndex` for batches; nothing is queued |
| `ReadOnlyError`                    | `READ_ONLY`                | A write while read-only mode is on (refused before it is queued)                                                                              |
| `MemberAdminDisabledError`         | `MEMBER_ADMIN_DISABLED`    | `inviteMember`, `removeMember`, `revokeInvite` without `LK_ALLOW_MEMBER_ADMIN=true`                                                           |
| `CascadeConfirmationRequiredError` | `CASCADE_CONFIRM_REQUIRED` | `deleteResource` with `cascade=true` but no `confirm: "cascade"`                                                                              |
| `DrainingError`                    | `DRAINING`                 | A new job (or inline write) while draining                                                                                                    |
| `UnsupportedBlockLossError`        | `UNSUPPORTED_BLOCK_LOSS`   | A replace would delete `unsupported` blocks; `blockIds` lists them                                                                            |
| `VersionConflictError`             | `VERSION_CONFLICT`         | 412, or a caller version older than LK's; `sentVersion`, `currentVersion`. Never retried.                                                     |
| `UncertainOutcomeError`            | `UNCERTAIN_OUTCOME`        | A write may have applied and that cannot be established; the step is `uncertain`                                                              |
| `LkOperationError`                 | `LK_ERROR`                 | LK (or the governor) failed the call; `lk` is the `BridgeLkError` (`status`, `lkCode`, …)                                                     |
| `BudgetExhaustedError`             | `BUDGET_EXHAUSTED`         | Inline reads only: `tier`, `retryAtMs`                                                                                                        |
| `JobNotFoundError`                 | `JOB_NOT_FOUND`            | Controls and `wait` on an unknown job                                                                                                         |
| `InvalidControlError`              | `INVALID_CONTROL`          | E.g. retrying a step that has not failed                                                                                                      |
| `CancelledError`                   | `CANCELLED`                | An inline write whose job was cancelled before it ran                                                                                         |

## Model

**Job** (`jobs`): `kind` (`single_op`, `batch_ops`, `paginate_all`; `upload_image` is reserved for chunk 3), `title`,
`origin` (`{ kind: 'mcp' | 'ui' | 'system' | 'maintenance' | 'test', client?, tool?, detail?, principal?, approvedBy? }`),
`principalId`, `profile` and `approvedBy` (copied into columns for filtering), `priority` P0–P3,
`status` (`queued`, `running`, `waiting_budget`, `waiting_lock`, `paused`, `succeeded`, `failed`, `cancelled`),
progress, `resumeAt`, `waitReason`, `uncertain`, `lastError`, `result`, timestamps.

**Step** (`steps`): op id, params (inline, or a `params` artefact above 64 KB) and their SHA-256, options, the
idempotency key `lkb.{jobId}.{stepNo}.{attempt0}` (POST only; reused on every retry and resume), client ids, the
`If-Match` sent, `status` (`pending`, `running`, `succeeded`, `failed`, `uncertain`, `cancelled`), attempts, request
ids, the result summary (whole results above 4 KB go to a `result` artefact), the error, and the first-send time.

**Artefacts** (`job_artifacts`, `job_artifact_items`): `params`, `result`, and `items` (the pageable list a
`paginate_all` job builds; capped by `settings.paginate`, with `truncated` and a reason when a cap is hit).

## Principals and policy hooks

The engine only defines the hooks. The real gate and sink are in `src/policy` (chunk 2b, [docs/policy.md](../../docs/policy.md));
wire them with `createPolicy(...)` and `policy.attach(engine)`.

- **Principal.** `origin.principal` is `{ principalId, profile, label }`: who the work is done for and the policy
  profile it acts under. Omitted, it is `SYSTEM_PRINCIPAL` (`{ principalId: 'system', profile: 'system', label:
'System' }`), the default for internal and UI-initiated work. `principal_id` and `profile` are stored on jobs, errors
  and journal rows, appear in `JobView`, `ErrorRecordView`, `JournalEntry`, the `step` event and writer slots, and
  filter `listJobs`, `listErrors`, `listErrorGroups` and `journalLookup`.
- **`origin.approvedBy`** (optional): who approved the work (when it runs from an approved proposal). Stored on the job
  and on its journal entries.
- **`PolicyGate`** (`policyGate` option; default `ALLOW_ALL_GATE`): `authorize(principal, opMeta, params, ctx)`
  returns (or resolves to) `{ decision: 'allow' }`, `{ decision: 'deny', reason }` or `{ decision: 'propose' }`.
  `opMeta` is `PolicyOpMeta` (operation id, kind, method, tag, risk, concurrency, versioned, paged and the step
  options); `ctx` is `{ origin, jobKind, stepIndex? }`. The engine calls it at entry of `run` and `submit` for EVERY
  operation, reads included, after params are validated and before any other guard, so nothing is queued or sent
  first. A gate that throws counts as a deny (fail closed).
- **Batches**: every step is evaluated up front. Any deny denies the whole batch (`stepIndex` says which step); else any
  propose turns the whole batch into one proposal.
- **Deny**: `PolicyDeniedError` is thrown and recorded in the errors table with classification `policy` (and the
  principal); nothing is queued.
- **Propose**: the engine calls the `ProposalSink` (`proposalSink` option): `capture(principal, ops, meta)` with
  `ops` = `[{ op, params, allowUnsupportedLoss?, confirm? }]` and `meta` = `{ kind, title, origin, priority, onError?,
paginate? }`, and returns `{ status: 'proposal_captured', proposalId }`. Client ids are not minted for a proposal; they
  are minted when the approved work is submitted. The default sink, `DENY_PROPOSALS_SINK`, treats propose as deny.
- A sink may return `summary` with the proposal id; it is passed through in `ProposalCaptured`. A sink that refuses
  with a `JobsError` (a guard, invalid params, a failed read) keeps that error; other failures become `BRIDGE_ERROR`.
- **`origin.approval`** (opaque): proof of the owner's approval, minted only by `src/policy`. The engine never reads
  it; it reaches the gate in `ctx.origin` and is stored with the job's origin (it serialises to `{ proposalId }`).
  The real gate refuses `approvedBy` without a valid approval, so approved work runs only through the owner's
  approval of a proposal.
- Events `policy` (owner commands and policy changes) and `proposal` (captured, state changes) are emitted on
  `engine.events` by `src/policy` once attached.

## How a step runs

1. **Entry**: params are validated against the registry schema, then the policy gate decides (above), then the guards
   (`checkSubmitGuards`): read-only, member admin (registry `risk: admin`), cascade confirmation.
2. **Client ids** are minted (or a caller's well-formed id kept) and persisted with the step before it is ever sent.
3. **Lock, then writer slot** (writes only). See _Locks_.
4. **One read** (when needed) gives the `If-Match` version, the unsupported-block guard's current tree and the journal
   pre-image together. A caller-supplied version is used as `If-Match`; if the read already shows a newer one, the
   write is refused with `VersionConflictError` without sending.
5. **Journal** entry (pre-image) is written, then the step is marked `running` (with its first-send time), then the
   request is sent through `lk.call` → `governor.execute` with `jobId` (fair round-robin), the idempotency key and
   `verify` hooks for 412 / `DUPLICATE_ID` / `NOT_FOUND` after an ambiguous retry.
6. **Outcome**: success; a typed failure (recorded in `errors`); or `BudgetWaitError`, which parks the job in
   `waiting_budget` until `retryAtMs` (persisted, resumed by a timer, also after a restart).

**Restart-resume.** On start, jobs left `running` or `waiting_lock` are re-queued. A step left `running` (or one that
failed in a way that may have applied) is verified before anything is re-sent, per its family in `OP_META`: creates
with a client id GET by that id; deletes check the entity is gone; updates re-read and compare with the intent (an
unchanged version proves a versioned write did not apply, and a re-send reuses the original `If-Match`); POSTs with no
other evidence are re-sent with their original key within 23 hours, and otherwise marked `uncertain`.

**`createManyResources`** is not atomic (LK's SDK guide): if it fails part-way, the items created before the failure
remain, and a retry gets `409 DUPLICATE_ID` for them. After any ambiguous outcome (a crash while it was in flight, a
failure after it may have reached LK, or `DUPLICATE_ID`), the engine GETs EVERY minted id (at most 100 reads, each
through the governor). All present: the step succeeded. None present: it is sent again. Some present: the step is
marked succeeded with `{ partial: true, missing, continuedInStep }`, and a new `createManyResources` step with only the
missing items, under their same ids and a fresh key, is inserted directly after it so it runs next (later steps move
up one place if none of them has been sent yet; otherwise it is appended). An inline `run` returns every created
resource. The step is `uncertain` only if the verification itself cannot complete.

## Locks

In-process mutexes with FIFO wait queues (`LockManager`). Keys:

| Key                      | Taken by                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `doc:{documentId}`       | registry `concurrency: document` (blocks, rows, infoboxes, boards, lanes, events, features, document content)       |
| `res:{resourceId}`       | registry `concurrency: resource` (update, move, delete, restore, save-as-template, properties, tags, new documents) |
| `res:{parentId}`         | `createResource`, `createResourceFromTemplate`, `createManyResources` (the parent; `res:@root` at the root)         |
| `cal:{id}`, `asset:{id}` | calendar and asset updates and deletes                                                                              |

**Ordering rules** (why deadlock is impossible): a step holds at most one lock, only for its own duration; it takes the
lock _before_ its writer slot, and a slot holder never waits for a lock; waiters are served in arrival order. While a
step waits for a lock its job shows `waiting_lock`.

## Writers

`WriterPool`: `WRITERS_MAX` slots (default 2, 1–8, changed live with `controls.setWritersMax`, persisted in
`runtime_settings`). Only write steps take a slot; reads never do. `queries.writers()` shows each slot (idle, or busy
with job, step, op, lock key, resource and document) and the wait queue.

## Controls

- **Pause all writes** (persisted): in-flight steps finish; no write step starts; reads continue. Held jobs show
  `waitReason.held`.
- **Drain** (in memory): running jobs finish; no new job is accepted or started. Resolves when nothing runs.
- **Read-only override** (persisted; `null` falls back to `LK_READ_ONLY`): new writes are refused; queued ones are held.
- **Cancel**: the in-flight step completes, then the job stops; remaining steps are `cancelled`.
- **Pause / resume a job**: pauses after the in-flight step.
- **Retry a failed step**: a definite failure is re-run with a new key (`attempt0 + 1`); one that may have applied keeps
  its key and is verified again; `force: true` re-runs it as new work.

## Errors

Every failed call is recorded (`errors`): time, op, job and step, HTTP status, LK code, message, `errors[]` (and the
first path), `requestId`, retryable flag and the governor's classification. Step refusals that are not LK errors
(unsupported-block loss, early version conflicts, uncertainty) are recorded too. A 404 from a verify read is an answer
("it is gone"), not an error. Groups: fingerprint `op|code|path`, with count, first and last seen, and `resolved` (true
when every occurrence is resolved; a new occurrence reopens the group).

## Write journal

Before each destructive write (and before `updateResource`, `moveResource`, `updateDocument`, `updateProperty`): the
blocks JSON for document and block replaces and block deletes, the board for board replaces and shape deletes, the
resource / document / property metadata for updates and moves, rows and infobox properties before their deletes, the
calendar before calendar writes, and only the ids for other deletes and member removals. Each entry records the write's
params (capped at 16 KB), the version and an outcome (`pending`, `applied`, `not_applied`, `unknown`). View-only in v1.

## Testing

`test/jobs/` (SQLite in a temp file, chunk 1's `FakeClock` and mock LK with a stateful model plugged in through
`MockLk({ respond })`):

- `crash-resume.test.ts`: the process dies right after LK committed each kind of write (client-id creates, deletes,
  versioned replaces, key-only POSTs, PATCHes); a new engine on the same file finishes with no duplicates. Also the
  23-hour window, an outside edit after the crash, the in-call 412 and `DUPLICATE_ID` verify hooks, and retry.
- `guards.test.ts`: unsupported-block guard (nested, `replaceBlock`, `allowUnsupportedLoss`, journal pre-image),
  cascade, member admin, read-only (with the persisted override), journal capture and pruning.
- `concurrency.test.ts`: same-document writers serialised, different documents in parallel, slot limits, live
  `WRITERS_MAX`, fair locks.
- `batch-recovery.test.ts`: a batch half-created at a crash (every id verified, only the missing items re-sent, in
  order), a batch failing part-way inline, a fully applied batch, and verification that cannot complete.
- `policy.test.ts`: the default gate, principals on jobs, errors and journal rows (filters, events, `approvedBy`),
  deny (single, batch, throwing gate), propose (single and batch) and the default sink.
- `controls.test.ts`, `budget.test.ts`, `jobs.test.ts`, `inline.test.ts`: controls, budget parking across restarts,
  the >20 s queued path, job kinds, artefacts, events, errors, and metadata for all 89 operations.
