# ADR 0032: set_facts, the protected canonical facts, and the proposal groundwork for multi-page operations

Status: Accepted (v2 session C2a, 10 November 2026). Implements the Facts row of PLAN-v2 section 5, section 9's line on
link collections, 10.2 (high-level proposals, ids minted at proposal time, the page-level summary, the verify step),
10.3 as refined by the owner (protected canonical facts), 10.4 (nothing inferred) and 10.6 (the bridge's own
compare-and-swap) on C1's engine hooks (ADR 0031), A2's tree, A3's registry and resolver and B1's converter (unchanged).
Migration 1300 is this session's. No decision in PLAN.md or PLAN-v2.md is changed; the choices below fill the gaps.

## Context

`set_facts` changes several properties of one page in several LegendKeeper writes, while C1's `write_page` is one
write. LegendKeeper's If-Match is not an atomic compare-and-swap (PLAN-v2 10.6), only row writes take If-Match at all
(`updateProperty`, the only way to change a link collection, takes none), a row removal answers `204` without a version,
and its spec gives no version on a sidebar property (`listProperties`, `getProperty`), only on `listPropertyRows` and
row writes. Canon must never change without the owner's explicit canonical approval, by any route, including the
low-level tools and work that was approved for something else. C2b will build multi-page tools on the same groundwork.

## Decisions

1. **One job, holding the page's lock throughout.** A batch may name a job-level lock (`BatchSubmit.holdLock`, bridge
   code only). The engine takes it before the first step and keeps it until the job stops (finished, or parked for
   budget, held, paused or cancelled, when it is released and taken again on resume). Every write step must take that
   same lock or none (checked at submit), so the deadlock argument of chunk 2 still holds: a slot holder never waits for
   a lock, and a job holds at most one lock across its steps.
2. **The bridge's own steps** (`bridge.expect`, `bridge.verify`; src/jobs/internal-steps.ts), allowed only when bridge
   code submits with `internal: true` (never `lk_api_batch`). Both only read; the policy gate sees them as reads, and an
   approval token covers them like any step. They live in the engine, not in the facts code, so C2b's tools use them.
3. **The compare-and-swap inside the lock** is `bridge.expect`, the job's first step: every property the plan changes is
   read again and compared with the state the plan was built on (rows by id, key and value in order; items by id, page
   and document in order; the filter whole; a property's version where both reads give one of the same kind). Any
   difference is a `StateConflictError` (a `VERSION_CONFLICT`) and the job stops before any write. **Versions are
   compared only between reads of the same kind**: the If-Match token for row writes is the one `listPropertyRows`
   gives, whatever `listProperties` may carry, so content is the authoritative comparison.
4. **Chained versions.** Each row write takes its If-Match from the write before it (`ifMatchFrom`, bound just before
   the step runs and stored with it; the first from the check). A write with nothing to chain from (after a removal) or
   a write LegendKeeper does not version (`updateProperty`) carries `expectCurrent`: the engine reads the target inside
   the lock and compares it with the planned state before sending (rows by key and value in order, since a row the same
   job just created has an id the plan could not know; a collection whole). Order: changes, additions (anchored to rows
   that stay), removals, then collections.
5. **Placement in template order** uses `createPropertyRow`'s `after` / `before` on rows that exist before any addition
   (several new facts with one anchor are sent in the order that leaves them in template order). The template is the
   tree's recorded one (C2b records it) or the page's Reference Type mapped through A3's registry to a type and role
   (a character type's `core` / `compact`); nothing is inferred from names (10.4). Its keys are cached a day
   (`template_fact_keys`).
6. **Collections** change with ONE `updateProperty` with the full items list (LegendKeeper has no item-level
   operations): kept items exactly as read (`id`, `rank`, page, document), new ones appended without id or rank, and the
   filter never sent, so it is kept (section 9). Removal matches every item of a page, or one document when it is named.
7. **Values** are plain text by default (exactly as given); inline Markdown only as `{ "markdown": "…" }`, so a value
   with an asterisk or brackets is never read as Markdown by accident. The Markdown is converted by B1 unchanged (a
   one-block page whose paragraph's runs are taken); `[[Name]]` resolves through A3 inside the AI REPOSITORY.
8. **The generic verify step** (`bridge.verify`) reads back each target (`sidebar`, `blocks`, `resource`) and compares it
   with the plan; the engine gathers every step's `verification` on the job (`result.verification`, `verified`), a
   mismatch is an error row (`VERIFY_MISMATCH`), the proposal keeps it too (`proposals.verification`), and nothing is
   retried. C1's in-step verify is unchanged and gathered the same way.
9. **The tree** re-reads a page once per job: set_facts' writes carry `deferTreeReread`, their pending rows stay owed,
   and the job's end flushes them (one `getResource`); a job that never ends is caught by the retry loop.
10. **The journal** gets an entry per write as always, each with the high-level operation; the first row write keeps
    the key-value property as the plan saw it as its pre-image (`journalPreImage`; the check confirmed it), and
    `updateProperty` keeps its own.
11. **The protected canonical facts are a write guard in the engine, not a tool's check** (src/facts/canonical.ts,
    src/jobs/write-guard.ts). At entry (every `run` / `submit`), the request's sidebar writes are simulated in order on
    the sidebar as it is now and judged by `assessFactChange` (the shared pure function); a protected change becomes a
    proposal flagged `requiresCanonicalApproval` whatever the scope, is refused for approved work without a canonical
    token (so a forged or stale expansion writes nothing) and for the system principal. Inside the lock it is checked
    again on what is there now. `createResourceFromTemplate` is judged as a new page with the template's facts. Rules
    are per-project configuration (`canonicalRules`, defaults seeded), an invalid list falls back to the defaults, and
    a sidebar that cannot be read counts as protected.
12. **"Approve and accept as canon"** is the only approval of a canonical proposal: a separate owner command and route
    (`{ confirm: true }`), audited as `proposal.approve_as_canon`, recording `canonicalApprovedBy` and the time, and
    minting the only token kind (`canonical`) the guard accepts for a protected change. The ordinary approval and bulk
    approval refuse such a proposal; "accept as canon" refuses one that is not canonical.
13. **Proposals hold a list of high-level operations** (`proposals.operations`), each naming its page and `pageParts`,
    plus the expansion and its job shape (`job_options`: the held lock, internal steps). **Ids are minted at capture**:
    a planner mints the ids it cross-references (a child under a new index, a link to a new page) when it plans, which
    for a proposal is capture time, and capture mints any still missing; approval submits exactly the stored params,
    which the token's hashes cover. Every proposal gets a **page-level summary** at capture (`page_summary`).
14. **Settings** (project settings): `factsPropertyName` (default `PROPERTIES`), `canonicalRules`, `agentDefaultStatus`
    (default `Working`, for C2b). Templates carry no fact defaults (the owner confirmed), so nothing is inherited.

## Consequences

- A typical `set_facts` (two facts changed) costs 4 reads and 2 writes: the plan's `listProperties`, the check's
  `listPropertyRows`, the verify read and the tree's one re-read. Each link collection changed adds 2 reads and 1
  write; the first use of a template's order 1 read (then cached a day). A dry run is 1 read; a proposal adds a read per
  property to capture it.
- A `set_facts` that stops after some writes (a failure that is not a conflict) reports `WRITTEN_IN_PART` with the
  writes made; nothing is retried, and the journal holds each write. A conflict found by the check writes nothing.
- Low-level property writes cost the guard's extra `listProperties` at entry (once per request) and, only when a write
  touches a protected fact inside the lock, one more read there.
- **Open for the owner:** deleting or restoring a page whose facts are protected (`deleteResource`, `restoreResource`)
  changes no fact and is not guarded; whether it should need canonical approval is the owner's decision. The guard can
  be extended to it without changing its contract.
- **Rows are compared in rank order, by id** (hotfix, 10 November 2026). LegendKeeper's endpoints return the same
  key-value rows in different orders: `listProperties`, `getProperty` and `getResource` in stored order,
  `listPropertyRows` sorted by `rank` (code-unit string order). Decision 3's "rows by id, key and value in order",
  implemented position by position across the plan's `listProperties` and the check's `listPropertyRows`, made every
  set_facts on a page with a row ever inserted mid-list a permanent `VERSION_CONFLICT`. Every reader now puts rows in
  rank order (ties by id; a planned new row keeps its place by its anchor) and compares them by id: a row on one side
  only is added or removed, a changed rank is a reorder (still a conflict), a planned new row is matched by key and must
  stand where the plan put it (between the anchor and its rank-sorted neighbour, where LegendKeeper ranks it); position
  is only the fallback for rows with no id. The in-lock content hash (decision 4), the verify step (decision 8), the
  canonical guard's model (decision 11) and the proposal capture's fingerprint use the same order. The mock
  LegendKeeper returns the endpoints' different orders, with a fixture of a real page's ranks, so this cannot pass
  unnoticed again.
- **To verify on the test world** (E4 or the owner): whether `listProperties` and `getProperty` carry a version (the
  bridge records one when present and compares it only with the same kind of read), and that `createPropertyRow` and
  `updatePropertyRow` answer with the new version in the body (the bridge falls back to a read and a content check when
  they do not).
- **Settled by D1.1 ([ADR 0039](0039-date-styles-timeline-repair-and-etag-versions.md), 11 November 2026):** the owner's
  sandbox run (B12) showed that `createPropertyRow` and `updatePropertyRow` answer **no version in the body** but send an
  `ETag` header (a delete answering 204 sends one too: B13, D25). Decision 4's chain now takes the body's version when
  there is one, else the ETag (unquoted), behind the project setting `useEtagVersions` (default on), so a chained row
  write no longer needs the in-lock read of the property; with neither, the read-and-compare fallback stands. Changing
  two facts costs 4 reads and 2 writes with it (6 reads without); the Consequences' figures above are the ones with it.
- **Bulk "accept as canon"** (owner, 11 November 2026). Decision 12 stands: there is still exactly one kind of canonical
  approval, and it is still per proposal. The bulk action is `approveAsCanon` called for each id, one at a time and in
  order (each approval re-reads its targets, so an earlier one may change a later one's), with the single route's
  `confirm: true`, the same 100-id cap, and the owner's session, CSRF and same-site checks. Nothing about the token or the
  guard changes: each proposal mints its own canonical token, and the guard runs again at its execution, so a target
  changed after capture ends conflicted. Each accepted proposal has its own `proposal.approve_as_canon` row, with
  `canonicalApprovedBy` and `bulk: true` in its details. The two kinds of approval stay distinct: an ordinary proposal
  is refused in the canon action (`NOT_CANONICAL`, "ordinary proposal; use Approve"), and a canonical one in the ordinary
  bulk Approve is reported as skipped, never as a failure. Bulk reject, which needs no canon decision, already takes
  canonical proposals (tested). The dashboard's confirmation lists each proposal's summary line, canonical reasons and
  related-pages count, needs a ticked acknowledgement, and sends only the ids it showed.
