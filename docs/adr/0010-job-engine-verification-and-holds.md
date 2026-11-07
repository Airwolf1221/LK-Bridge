# ADR 0010: Job engine verification, `uncertain` steps and write holds

Status: Accepted (chunk 2, 7 November 2026). Records how chunk 2 reads PLAN §4–§6 where it leaves room; no PLAN decision is changed.

## Context

PLAN §5.3 and §6.1 say a step left `running` by a restart is "re-examined (verify-then-resume)" and that idempotency keys plus client-minted ids make re-sending safe. They do not say what happens when neither applies (a POST without a client id after LK's 24-hour key window), how versioned writes are verified, or what a queued write does when writes are paused or read-only mode is switched on after it was accepted.

## Decision

1. **Verify before re-sending, per operation family** (`src/jobs/op-meta.ts`, one entry for each of the 89 operations):
   - creates with a client id: GET by the minted id. `createManyResources` is not atomic (LK's SDK guide: items created
     before a failure remain, and a retry gets `409 DUPLICATE_ID` for them), so after an ambiguous outcome EVERY minted
     id is checked (at most 100 reads through the governor) and only the missing items are re-submitted, under their
     same ids, as a new step that runs next; the step is `uncertain` only if that verification cannot complete;
   - deletes: GET shows the entity gone;
   - updates: re-read and compare with the intended state (structural subset, `src/jobs/compare.ts`); for versioned writes, an unchanged version proves the write did not apply, and a re-send reuses the original `If-Match`, so it can only replay or 412;
   - POSTs with no other evidence: re-send with the original `Idempotency-Key` within the window, otherwise `uncertain`;
   - move, restore and assign-block-ids: re-sending cannot duplicate.
2. **The idempotency window is 23 hours** (`idempotencyWindowMs`), one hour inside LK's 24, measured from the step's first send.
3. **A new step status, `uncertain`**: the bridge could not establish the outcome without risking a duplicate. The job ends `failed` with `uncertain: true`. "Retry step" keeps the key and version (so it is verified again); `force: true` re-runs it as new work once a person has checked LK.
4. **Client ids are minted for every create that accepts one**: the four in PLAN §5.3, plus `createResourceFromTemplate`, `saveResourceAsTemplate` and each item of `createManyResources`. A caller-supplied id is kept if it is well formed.
5. **Holds, not failures**: a write accepted before writes were paused or read-only mode was switched on stays `queued` (with `waitReason.held`) and is never sent until both are lifted. Read-only still refuses new writes before they are queued (PLAN §4 rule 6). Drain is in memory only: a restart comes back accepting work, and jobs that were queued but not started stay queued.
6. **Lock keys** follow the registry's `concurrency`, with resource creates locking the parent (`res:@root` at the root; a `createManyResources` batch locks its one outside parent, or nothing if it has several), and calendar and asset writes locking `cal:{id}` / `asset:{id}`. A step takes its lock before its writer slot and holds one lock at most, so no cycle can form.
7. **Request ids**: the bridge supplies `x-request-id` (`lkb.{jobId}.{stepNo}.{attempt0}.{n}`), so the ids of successful calls are known without reading response headers; failed calls record the id LK returned.

## Questions answered by LK's spec (chunk 2 follow-up)

- **Request ids.** A client-supplied `x-request-id` is echoed when it matches `^[A-Za-z0-9._-]{1,64}$`; the bridge's
  ids (`lkb.{jobId}.{stepNo}.{attempt0}.{n}`, capped at 64 characters) always match, so recording the ids it sent is
  correct for successful calls.
- **Versions on block-level reads.** Every block, row and infobox-property response carries the document's `version`
  (also sent as the `ETag`), so taking `If-Match` from `getBlock`, `listBlockRows`, `listBlockProperties`,
  `getBlockProperty`, `listBlockPropertyRows` and `listPropertyRows` is correct.
- Both will be confirmed against the real API by chunk 3's sandbox script. Wiring the engine into `src/server.ts` is
  assigned to chunk 3.

## Consequences

- No step is ever re-sent on a guess. The cost is an extra read for each step that was in flight at a crash (or that failed in a way that may have applied), and occasionally a person has to look at an `uncertain` step.
- A write held by read-only mode can sit queued indefinitely; the dashboard shows the reason.
- Tests: `test/jobs/crash-resume.test.ts`, `test/jobs/controls.test.ts`, `test/jobs/guards.test.ts`.
