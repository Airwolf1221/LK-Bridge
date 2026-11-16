# `src/lk`: LegendKeeper client and Rate Governor

Everything that talks to LegendKeeper lives here, and every request goes through **a governor** (PLAN §5, ADR 0003).
Since v2 A1 there is **one governor per project**: each project has its own key, so its own key tiers and project tier
(ADR 0023). `src/projects/registry.ts` builds one `LkClient` per configured project; nothing else creates clients. Chunks 2 and 3 import from `src/lk/index.ts` only. The interface below is meant to stay
stable; change it only with a note in `docs/CHANGELOG.md`.

## Quick start

```ts
import { loadConfig } from '../config/index.js';
import { lkSettingsFor } from '../config/lk.js';
import { createLkClient, BudgetWaitError } from '../lk/index.js';

// One client per project: its key, and the LegendKeeper id that key proved (the registry does this for the bridge).
const config = loadConfig();
const lk = createLkClient(lkSettingsFor(config, { apiKey: config.lk.projects[0]!.apiKey, projectId }));

// Registry-aware: kind and tier costs come from the operation registry.
const doc = await lk.call({
  operationId: 'getDocument',
  priority: 'P1',
  run: (sdk, signal) => sdk.documents.get({ projectId: lk.projectId, resourceId, documentId }, { signal }),
});

lk.budgetFooter('test'); // 'budget (test): writes 0/120·min 0/3,000·h | all 1/300·min ...'
```

## Exported interface

| Export                                                                           | What it is                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLkClient(config: LkClientConfig): LkClient`                               | Builds the `@legendkeeper/sdk` 4.1 client with `fetch: governor.fetch`, `maxRetries: 0`, `idempotencyKeys: false`. `config` is `LkSettings` (from `lkSettingsFor(config, { apiKey, projectId })` in `src/config/lk.ts`, v2 A1) plus optional `clock`, `transport`, `random`, `governorInstance` and (v1.0.1) `persistence`. |
| `LkClient`                                                                       | `{ sdk, governor, projectId, fetch, call(req), budgetFooter(project?) }` (the footer names the project when given, v2 A1). `call` is `governor.execute` with `kind`/`costs` looked up from the registry (`createManyResources` items are read from `input.body.resources`).                                                 |
| `governor.execute<T>(req): Promise<T>`                                           | The one way to reach LK. See below.                                                                                                                                                                                                                                                                                         |
| `governor.snapshot(): BudgetSnapshot`                                            | Every tier: `used`, `limit` (effective), `configuredLimit`, `remaining`, `windowMs`, `resetAtMs`, `blockedUntilMs`, `inFlight`, `reactiveOnly`, `drift` (observed vs modelled at the last server correction). Plus `queues` per class, `inFlight`, `writeSpacingMs`, `nextWriteAtMs`.                                       |
| `governor.estimate({ reads, writes, createManyItems, priority?, ops? })`         | Projected time, tightest tier (`'pacing'`, or a learned `group:<name>`), whether it fits today, per-tier breakdown. v2 E5.5: `ops`, `perWrite` (below).                                                                                                                                                                     |
| `formatBudgetFooter(snapshot, project?)`                                         | The one-line footer from PLAN §5.4; `budget (<project>): …` when a project name is given (v2 A1).                                                                                                                                                                                                                           |
| `governor.on('sample' \| 'throttled' \| 'budget-wait', cb)`                      | Events for the UI (chunk 5). Returns an unsubscribe function. `sample`: rate headers seen, the tier they matched and the modelled count they replaced. `throttled`: tiers LK refused (429) and until when. `budget-wait`: a call surfaced `BudgetWaitError`.                                                                |
| `BridgeLkError`                                                                  | Every failure: `status`, LK `code` (or a bridge code), `requestId`, `errors[]`, `retryable`, `classification` (`user_fixable` · `conflict` · `auth` · `budget` · `upstream` · `bridge`), `opId`, `ambiguous`, `retryAfterMs`, `attempts`. `toJSON()` is safe to log.                                                        |
| `BudgetWaitError extends BridgeLkError`                                          | `{ tier, retryAtMs }`. The job engine parks the step (`waiting_budget`) until `retryAtMs`; MCP turns it into "budget exhausted, retry at T".                                                                                                                                                                                |
| `idempotencyKeyFor(jobId, stepNo, attempt0?)`                                    | `lkb.{jobId}.{stepNo}.{attempt0}` (PLAN §5.3).                                                                                                                                                                                                                                                                              |
| `defaultTransport`                                                               | The transport under the governor when none is given (the platform `fetch`). Chunk 3 wraps it in a host router so the signed upload URL (another host) goes through an SSRF guard, still inside `execute`.                                                                                                                   |
| `createSqliteCounterStore(db, projectId)`, `GovernorPersistence`, `CounterStore` | v1.0.1: keeps the tiers' recent counts across restarts (below); one row per project since v2 A1. Pass `{ store, intervalMs?, warn? }` as `persistence` to `createLkClient` or `new Governor`; `src/runtime.ts` passes the SQLite store. Additive: every method above is unchanged.                                          |
| `costSpecFor(op, input)`, `FakeClock`, `systemClock`, `Clock`                    | Helpers. Use `FakeClock` in tests: nothing ever really sleeps.                                                                                                                                                                                                                                                              |

### `execute` request

```ts
governor.execute<T>({
  opId: string;                       // registry operationId (or a label for non-registry calls)
  kind: 'read' | 'write' | 'upload';
  costs: { tiers: TierId[]; items?: number };
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  jobId?: string;                     // fair-share key within a class
  idempotencyKey?: string;            // sent on POST, reused on every retry; without it a POST is never retried
  signal?: AbortSignal;               // cancels while queued or in flight
  timeoutMs?: number;                 // this call's per-attempt deadline instead of requestTimeoutMs (the upload PUT)
  verify?: ({ error, signal }) => Promise<{ ok: true; value: T } | { ok: false }>;
  run: (signal: AbortSignal) => Promise<Response | T>;
});
```

Rules for `run`:

- Make **exactly one** LK request, through the SDK from `createLkClient` or `governor.fetch`, and pass `signal`
  on. A second request in the same call throws `ONE_REQUEST_PER_CALL`. So do not use SDK helpers that make
  several requests (`assets.uploadImage`, `page.next()`, `for await` over a page); make each request its own
  `execute` (chunk 3's composite upload and `paginate_all` do this).
- Using the SDK or `governor.fetch` anywhere else throws `GOVERNOR_BYPASS` (wrapped by the SDK in a
  `ConnectionError` whose `cause` is the `BridgeLkError`).
- A versioned write (registry `versioned: true`, not GET) without `If-Match` throws `IF_MATCH_REQUIRED` before
  anything is sent (CLAUDE.md).
- Returning a raw `Response` is allowed (e.g. the signed upload PUT); a non-2xx one throws.

## How it works

**Tiers.** One exact sliding window per tier (`window.ts`): write-min, write-hour, key-min, key-hour, key-day,
project-hour, items-min, items-hour. Limits come from config (`LK_TIER_LIMITS`), defaults are the published
numbers. `upload` has no published numbers, so it has no counter: it is only ever blocked reactively after
`UPLOAD_RATE_EXCEEDED` (Retry-After if given, else 1 s doubling to 120 s).

**Admission.** A call is dispatched when, for every tier it draws on, `used + cost <= limit - reserve(class)`, no
tier is blocked by a 429, the in-flight cap has room, and (for writes) the pacing gap has passed. Units are
counted at dispatch. Reserve floors: P0 0%, P1 10%, P2 25%, P3 50% (`RESERVE_FLOOR_*`). Classes are served in
order; P3 runs only while no P1/P2 call is queued. Within a class, calls are FIFO per `jobId` and round-robin
across job ids (calls without a `jobId` share one lane).

**Pacing.** Writes are at least `WRITE_SPACING_MS` (500 ms) apart. When the trailing-minute write count
projected to an hour exceeds `stretchHourlyWrites` (default: the write-hour limit, 3,000), spacing stretches to
`WRITE_SPACING_STRETCHED_MS` (1.2 s); it relaxes once the projection falls to 80% of the threshold. 1.2 s is
exactly 3,000 writes/hour. Retries are writes too and are paced.

**Server correction.** The governed fetch reads `X-RateLimit-Limit/-Remaining/-Reset` and `Retry-After` on every
response, 429s included. The headers describe only the tightest tier, matched by limit (then window, then
consumption order). That tier's count is snapped to `limit - remaining` plus our other in-flight calls: raised
with units that expire at the server's reset, or lowered by dropping the oldest units. On a 429 the tier is blocked
until Retry-After. Calls LK refuses before counting (400/401/402/403/405 without rate headers) and calls that never
sent a request are refunded.

**Learned operation limits (v2 E5.5, ADR 0047).** A reported limit that matches no documented tier the call draws is
taken as a documented tier's change only when the window its reset implies is that tier's, its count is within 2 (or 5%
of the limit) of ours, and the operation is not in a listed group (the asset routes). Otherwise it becomes a learned
tier of the operation's rate group (`groups.ts`: `assets` for the asset routes, else the operation id), keyed by group
and limit, with its window inferred from the reset. A learned tier paces, snaps and blocks (429) only its group's calls,
and expires once its window has passed twice without being reported (never while blocked or in flight). It lives in
memory only. A header at a documented tier's configured limit clears a limit learned for it. `snapshot().operationTiers`
lists the live ones; the footer adds `blocked <group> <s>s`; the first sighting of a group and limit is logged once
(`GovernorOptions.log`). `estimate` takes `ops` (counts by operation id), so the learned tiers pace only the operations in
their group (`operationTiers`), and its `perWrite` is the time a write is taken to cost: the measured median of the
project's recent write steps (`GovernorOptions.writeDuration`), floored at the spacing.

**Counters across restarts (v1.0.1, review finding F-14).** The windows are in memory, so after a restart the
governor used to believe the last minute, hour and day were empty although LegendKeeper still counts them; only the
tightest tier was corrected, by the first response's headers. With `persistence` set (the bridge always sets it):

- **What is saved:** per tier, its live events grouped into at most about 60 buckets (`max(1 s, window / 60)` each),
  each bucket stamped with the **latest** time in it, plus any 429 block still ahead. Stamping late means a restored unit
  never expires before the real one: the restored model can only over-count, so the governor waits a little longer
  rather than sending too much. In flight and queued calls are not saved.
- **When:** a save is armed for `intervalMs` (default 10 s) after the first change since the last save (a dispatch, a
  refund, a header correction, a 429 block), so an idle governor has no timer; and once more in `close()`, which
  `runtime.shutdown()` calls before the database closes. Stored in table `governor_counters` (migration `0500`), one
  row, as JSON (`{ v: 1, savedAt, tiers: { <tier>: { buckets: [[t, n], …], blockedUntil? } } }`).
- **On start:** the record is validated; buckets older than the tier's current window are dropped, buckets from the
  future (the clock went back) are clamped to now, unknown tiers are ignored, each tier is capped at its configured
  limit, and a 429 block is kept only while it is ahead (at most a day). A missing record restores nothing. An
  unreadable or malformed one restores nothing and logs a warning; a failing save logs a warning and the governor
  carries on. Neither is ever fatal.
- **Effect:** a restart in the middle of heavy writing resumes with the counts LegendKeeper has, so a full write-minute
  makes the next write wait for the minute to pass instead of meeting a 429. The server's headers still win, as before.

**Waits.** A queued call whose earliest admission is more than `maxQueueWaitMs` (30 s) away is rejected with
`BudgetWaitError`. A 429 with Retry-After <= 30 s is waited out on the clock and retried; longer becomes
`BudgetWaitError`.

**Retry matrix** (`retry.ts`, a pure function, PLAN §5.3):

| Situation                                                      | Action                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 429, wait <= 30 s (at most 5 times per call)                   | wait, retry, same idempotency key                                                      |
| 429, longer wait                                               | `BudgetWaitError { tier, retryAtMs }`                                                  |
| 502/503/504, timeout, connection error on GET/PUT/PATCH/DELETE | backoff 250 ms doubling, equal jitter, cap 8 s, 3 retries                              |
| same on POST                                                   | retried only with an `Idempotency-Key`; otherwise fails at once with `ambiguous: true` |
| 409 `IN_PROGRESS`                                              | short backoff (500 ms doubling), same key, 5 retries                                   |
| 412 after an ambiguous earlier attempt                         | `verify`; success if it says the write already applied                                 |
| 404 / 409 `ALREADY_DELETED` after an ambiguous DELETE          | `verify`; default: success (it is gone)                                                |
| 409 `DUPLICATE_ID` after an ambiguous POST                     | `verify`                                                                               |
| 500 `INTERNAL`, every other 4xx                                | never retried                                                                          |

"Ambiguous" means an earlier attempt of the same call ended in a connection error, timeout or 502/503/504 on a
non-GET, so the write may have applied.

**Errors.** `errors.ts` classifies on LK's `code` (the whole closed catalogue is mapped) and falls back to the
status only for codes it does not know. The raw response body is captured on the wire, so codes the SDK does not
know survive.

## Interpretations of the plan

These are readings of PLAN where it leaves room, not changes to its decisions.

- "3 tries" for transient failures = 3 retries after the first attempt (4 attempts).
- The 30 s threshold that turns a long 429 into `BudgetWaitError` also applies to locally predicted queue waits,
  so jobs park instead of holding a queue slot for minutes.
- `estimate` counts `createManyItems` as `ceil(items / 100)` extra write calls on top of `writes`. Its default
  class is P2 (jobs), so floors shrink the usable budget.
- The footer appends ` | blocked <tier> <n>s` only while LK is refusing a tier; otherwise it is exactly the
  PLAN §5.4 format. Tiers with a limit of 10,000 or more are shown in `k`.
- `maxInFlight` (default 16) caps concurrent requests as a safety valve; the writer pool (chunk 2) will be the
  real limit on writes.

## Testing

- `test/unit/governor-*.test.ts`, `lk-*.test.ts`: windows, floors and priorities, fair share, pacing, header
  snapping, every retry-matrix row, error mapping, estimate, footer. All on `FakeClock`.
- `test/unit/governor-persist.test.ts` (v1.0.1): a restart with a full write-minute tier makes the next write wait;
  stale data is dropped tier by tier; a missing, corrupt, foreign or unreadable record starts empty without crashing;
  future times are clamped and totals capped; a 429 block survives; save timing; the SQLite store round trip.
- `test/contract/`: a Fastify mock LK (`mock-lk.ts`) with exact sliding windows, rate headers, idempotency replay
  and scripted faults; a 1,000-call workload (published and tight limits, another key draining the project tier,
  an injected 429) that must never make the mock refuse a request; fault tests through the real SDK over HTTP.
  `drive.ts` moves the fake clock only when real I/O has settled.
