# ADR 0069: v3 F5c: orchestration: `arkona_identity_reconcile`, `query_facts`, workstreams and their report

- Status: **Proposed** (v3 F5c, 23 November 2026). It builds H6, H7 and H8 of the owner-approved design
  [design/F5-orchestration.md](../design/F5-orchestration.md) (APPROVED as written, 23 November 2026, H1 to H12; the
  copy in the repository is the owner's, unchanged), with the session brief's detail. H1 to H4, H10 and H11 were F5a
  ([ADR 0067](0067-v3-f5a-supplementary-tags-rulings-bulk-actions-and-unknown-outcomes.md)), H5 F5b
  ([ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md)); H9 (geography evidence) is F5d. Every decision is
  implemented and tested against the mock LegendKeeper and fixtures; nothing in this session touched a live system (no
  LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip script). Where the
  design and the brief were silent the choice is marked **chosen**; the points for the owner are in
  [Questions](#questions-for-the-owner).
- Why: ChatGPT's report after several days at write scope. A Menkheti culture split gave it 27 identity changes (Naming
  Culture values such as "Al-Mansur XII → Ancient Menkheti", "Arin al-Jamail → Orzheni", "Azar al-Nafir → Khayali") and
  their tag corrections, done one character at a time by hand. Its request: "one clearly bounded, author-approved
  maintenance objective" performed "as one coherent job", with a dry-run preview, an itemised result, failures isolated,
  and **the approval boundaries not weakened**.
- Builds on [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (the character type's identity fields, the token
  maps), [ADR 0060](0060-v3-f3f-retag-audit-and-apply.md) with ADR 0067 (the retag engine, grammar order, the Approved
  Supplementary Tags), [ADR 0063](0063-v3-f4a-governance-drift-names-and-briefs.md) (`arkona_name_check`),
  [ADR 0064](0064-v3-f4b-consistency-and-as-of.md) (`arkona_consistency`), [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md)
  (items, selective approval, Resume), [ADR 0055](0055-write-scope-review-revert-rails.md),
  [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) and [ADR 0062](0062-dashboard-sessions-and-step-up.md) (write scope,
  rails, step-up), and ADR 0067's H10 (unknown write outcomes).
- Amends: PLAN §6.1 and ADR 0058 decision 3 (a job may isolate its items' failures, decision 4); ADR 0051's rule (an
  identity reconcile's fact writes count as `set_facts`' do, decision 5); PLAN §6.4 and ADR 0045 (the journal and the
  tool-call log record a workstream label, decision 9).
- Migration: `4300_workstreams_identity.sql` (the `workstream` column on jobs, proposals, the write journal and the
  tool-call log; the connections' default labels; `job_stops` learning the kind `identity`; the reconciles' records).
- Pack version: `arkona-2026-11-23-f5c` (the per-tool switch `arkona_identity_reconcile: scope`). It supersedes
  `arkona-2026-11-23-f5b`; the owner approves it on the Packs page. Until then the tool is always a proposal (decision 6).
- Numbered 0069, the next free number.

## H6: `arkona_identity_reconcile`

### Decision 1: the input and what is refused, per item

`{ items: [{ character, facts }] (1 to 100), reconcileTags (default true), dryRun, lastMajorRevision, workstream }`, or
`{ report: reconcileId | jobId }` (the itemised result as it stands, free).

1. **Allowed facts**: the character type's gated identity fields as the pack keys them (Race / Species, Naming Culture,
   Life State, Personal / Given Name, Family / Surname, Temporal Scope), matched without case or spacing.
2. **A rename** (`USE_ARKONA_RENAME`, naming `arkona_rename`): Canonical Display Name, and **chosen**: Subject, and the
   keys an agent might use for the page name (Name, Page Name, Display Name).
3. **Protected and lifecycle facts** (`PROTECTED_FACT`, with the tool for each): Status (the lifecycle tools), Continuity
   Type and Continuity (`set_facts`, always a canonical proposal), Last Major Revision (the bridge's rule; the
   `lastMajorRevision` argument), and **chosen**: Inheritance, Supersedes, Reference Type and Aliases (`set_facts`, or
   `arkona_rename` for a name). Any other key: `NOT_AN_IDENTITY_FACT`.
4. **Values**: a placeholder of the character type (`tbd`, `?`, …) is refused (`PLACEHOLDER_VALUE`). Race / Species must
   be in the race map or the exceptional kinds, Naming Culture in the culture map (`UNMAPPED_VALUE`, "ask the owner; they
   add it on the Packs page"). **Chosen:** a value the pack marks as a deliberate gap (`Unestablished`, `Unknown`,
   `None`) is accepted (it is the pack's own vocabulary); the tags then hold that slot, as the retag engine does.
5. **The identity page**: the Character Core, else the Compact Character Reference, else the identity-owning Character
   Reference (the Reference Types of the character type's identity roles, then the retag rules'
   `identityReferenceTypes`); a page of the set (an [INDEX], a specialist page) goes to its Core through the registry's
   `characterOfPage`; then names, canonical names and aliases. Several characters: `CHARACTER_AMBIGUOUS` with the
   candidates; none: `CHARACTER_NOT_FOUND`. **Chosen:** an Archived identity page, or one in a non-current area, is
   refused (`NOT_CURRENT`: history is never changed); the same character twice in one call is refused the second time
   (`DUPLICATE_CHARACTER`).
6. A refusal refuses **that item only**; the others are planned. Every refusal says why and what to do instead.

### Decision 2: the plan, per item

1. **One fresh read** of each resolved identity page (`getResource`: its tags, its sidebar and its `factsVersion`), all
   in one read job, as `get_resource` reads several. **Chosen:** the read job carries no workstream label (it changes
   nothing; the report is about work).
2. **The facts**: `set_facts`' own planner (`planFacts`), on the live sidebar, the template's order for a fact the page
   lacks. Only the facts given are planned.
3. **The tags** (when `reconcileTags`): the retag engine (`RetagService.verdictFor`, new: the audit's engine on a page as
   it WILL be) over the live tags and the facts with the new values, under the approved policy (grammar order, H3; the
   Approved Supplementary Tags kept, H1; the owner's rulings, H2). A correction is written in the same item; compliant
   writes nothing; a **hold** or an **exception** writes no tags and the item says why (the facts are still written); a
   Working page is `not_applicable` (only the lifecycle grammar applies until it is promoted).
4. **Chosen: the old value's own token is replaced.** The retag engine keeps a tag outside the grammar as the owner's
   exception, so on its own it would keep `Menkheti` beside `Ancient Menkheti`. The reconcile knows that tag: it is the
   token the OLD value of the fact it changes maps to. It drops exactly that tag, and only when the new value maps to a
   different token and the page's other identity slot does not give it too (the Standard's shared race and culture
   token, Otheiralth); the item's `tags.replaced` says so. Nothing is inferred: one mapped token for another. The audit
   engine is unchanged (a stale identity token elsewhere is still an exception there: see the questions).
5. **The name check**: for a Naming Culture, `arkona_name_check`'s culture report (`nameCheck` itself, free), trimmed to
   the culture's token and owners, its members (count and the first ten) and the character's namesakes.
6. **Never inferred**: no culture, race or nationality is suggested; the result carries the name check's rule.
7. An item whose facts are already as given and whose tags are already right is `no_change` (nothing submitted for it).

### Decision 3: the job

ONE `batch_ops` job, one item per character (`char:<n>`, kind `identity_facts`, its diff the facts and tags):

1. When any item writes tags, a shared first step: the tagging policy (`retag.policy`, the governance sources read once):
   changed since the plan, the job stops before any write ("audit again"); Resume runs it again first.
2. Per item: **`identity.page`** (src/packs/identity/checks.ts): a fresh in-job read; gone, renamed, or the sidebar not at
   the plan's `factsVersion` (`FACTS_STALE`) skips **that item only**, nothing of it written. Then `set_facts`' own steps
   (its rows check, the row writes with chained If-Match, its read-back of the sidebar), each write **judged inside its
   lock** (`judgedInLock`: a proposal captures no version of it, so one character changed before approval does not
   conflict the others) with the rebaser **`identity.facts`** (a conflict inside the lock skips the rest of the item,
   never rebased onto a newer sidebar). Then the tag write (`updateResource`, the bridge's own compare-and-swap of name
   and tags) with **`identity.tags`** asked every time inside the lock: the name as planned, the approved policy still
   the plan's digest (else `held:`), the tags still those read (write), already the planned array (nothing sent), or
   anything else (`conflicted:`, never written over). Then **`identity.tagsVerify`**: the exact array in order, and name,
   aliases, parent, place, flags and documents unchanged.
3. **No job-level lock** (**chosen**, as renames since ADR 0058's amendment): each write takes its own page's lock, and
   its in-lock checks are the ones above.
4. **Resumable** (`resumable: { kind: 'identity', isolateItems: true }`, `job_stops` learns the kind).
5. Last Major Revision follows the owner's rule (the engine's planner, per page; `lastMajorRevision` overrides).

### Decision 4: failures isolated per item (the engine, opt-in)

`ResumableShape.isolateItems` (only bridge code sets it; kept with a proposal, so the approved job has it too): a step
that names items and fails (or ends `uncertain`) no longer stops the job. The later steps of its items are recorded
`cancelled` ("its item failed at step N"), every other item carries on, and the job ends `failed`, so Resume (ADR 0058)
runs exactly the steps that did not succeed: the failed write with a fresh idempotency key, an ambiguous one verified
first, the cancelled ones after it; an item that succeeded is never sent again. A failed step that names no item (the
shared policy check) still stops the job. Every other job is unchanged.

### Decision 5: the approval boundaries (unchanged)

The engine's gate judges the job as any write: at scope `propose` it is a proposal; at scope `write` it runs directly
when it writes 10 pages or fewer, and the bulk rail (ADR 0055 decision C, unchanged) makes more ONE proposal whose items
the owner approves in part or whole (ADR 0058's selective approval; left-out characters are `excluded`). The canon guard
and the lifecycle guard judge every write; the tool never sets `lifecycle` or `forceProposal` except from the pack's
switch. ADR 0051's rule counts an identity reconcile's fact writes as it counts `set_facts`' (`src/lmr/index.ts`).

### Decision 6: the pack switch

`arkona_identity_reconcile: scope` in `arkona-2026-11-23-f5c` (follows the agent's scope, as the brief's rails require).
**Chosen:** the switch is read from the stricter of the approved and the waiting version (`strictToolMode`), so until the
owner approves f5c the tool is always a proposal: it fails safe.

### Decision 7: the result

Each item: `done` (facts and tags written and read back, or already so), `partly_done` (facts written and read back,
tags held, skipped or not written, and why), `skipped` (changed since it was read: nothing written, and why), `failed`
(a write failed or its outcome is unknown; the rest of the item not run), `not_run` (the job stopped before it), `refused`
(at planning) or `excluded` (left out by the owner); then a one-line summary and the follow-ups. The tool waits up to 25
seconds; otherwise it answers `queued` with the `reconcileId` for `{ report }`.

**Follow-ups**: when the job ends, `arkona_consistency` runs for each character written (free: the snapshots, which the
job's change snapshot has brought up to date) and its findings (new or still open) are the item's `followUps`.
**Records**: `identity_reconciles` keeps the plan of every submitted call (and of a call whose items were all refused),
the job or proposal, the workstream and, once the job has ended (again, after a Resume), every item's outcome.

## H7: `query_facts`

1. **Selection** (together they narrow): `type` (Reference Type, one or several), `tag` (any; `tagMode: "all"`), `under`
   (a branch: the page and everything below it), `kind` (index, bsrc, bwrk, barc), `lifecycle` (by the appraisal's
   labels: place and prefix), `name` (a substring, without case). **Chosen:** the root and unclassified pages are left
   out unless `kind` asks.
2. **`characters: true`**: every current identity page (decision 1.5's Reference Types; not Archived, not in a
   non-current area), in Main CANON (Continuity Type not the pack's AU value) by default, or an AU's own (`continuity`:
   its Continuity fact). **Chosen:** it needs an approved setting pack with a character type on the project
   (`NO_CHARACTER_TYPE` otherwise); the tool itself is generic.
3. **Fields**: any sidebar fact key (the project's facts property, `PROPERTIES`), and `id`, `name`,
   `canonicalDisplayName`, `referenceType`, `scope`, `tags`, `parent` (its name), `path`, `lastMajorRevision`,
   `factsVersion`. Two columns are always added: `coverage` and `readAt`.
4. **Output**: `columns` once, `rows` as arrays (a list cell is an array), or `format: "csv"` (RFC 4180, a list cell
   joined with "; "). Paged by row: `limit` (default 100, at most 500), `offset`, or `nextCursor` (**chosen**: bound to
   the selection, so a cursor from another query is refused, `CURSOR_INVALID`).
5. **Free**, from the repository tree's stored sidebars (each fact's text). **Coverage per row, never silent**: `ok`;
   `stale` (the tree could not re-read the page, or its read is more than 26 hours old, the tree's own "confirmed"
   window); `missing` (its sidebar was never read: its facts are null); `live`. The answer gives the tree's last
   confirmation and the oldest read among the rows (`age`), and notes for missing and stale rows.
6. **`live: true`** re-reads the rows of the page asked for, one `getResource` each, as ONE job (as `get_resource`); more
   than 10 first answers an estimate (`confirm: true` runs it). **Chosen:** `factsVersion` is filled only by a live read
   (the tree keeps each fact's text, not the sidebar's state its version is computed from), and the note says so.

## H8: workstreams

1. **The label** (at most 80 characters, whitespace collapsed): an optional `workstream` argument on **every tool that
   writes or proposes**, added by the tool list itself (`src/mcp/tools/workstream-arg.ts`), so no write tool can miss it.
   The handler runs inside a frame holding the label in force (an `AsyncLocalStorage`); `mcpOrigin` puts it on the
   engine origin, so the **job** (`jobs.workstream`), its **proposal** (`proposals.workstream`; the approved job keeps
   the proposal's) and each **journal entry** (`write_journal.workstream`, from its job) record it. Every write's result
   echoes the label in force (`workstream`, with `workstreamSource` when it is the default). **Chosen:** a tool called by
   another tool stays in the caller's workstream.
2. **`bridge_workstream { set: label | null }`**: the calling connection's default label (by its principal: the OAuth
   grant or the PAT), held in the bridge's database, expiring after 12 hours without a write that takes it (or a
   `bridge_workstream` call). An argument always wins. **Chosen:** a read-access tool (it writes nothing to
   LegendKeeper).
3. **`bridge_workstream_report { workstream | since | principal | jobIds }`** (the design's `arkona_workstream_report`:
   not Arkona-specific). Read-only and free (the bridge's own tables). The groups are ChatGPT's: **written and
   verified** (every page changed: each write with its version before and after, what it was, the tool and who made it;
   each job's read-back); **accepted but not yet run** (jobs queued, running or waiting; approved proposals not
   executed); **deliberately excluded** (unticked items; items a job skipped, `FACTS_STALE` and "changed meanwhile";
   refusals, `FIX_STALE` among them; refused reconcile items); **awaiting the author's judgement** (pending and
   conflicted proposals; tags held); **residual inconsistencies** (writes whose outcome was unknown, with how each was
   settled; read-backs that differed; failed or cancelled jobs; audit findings still open on the pages touched, the
   consistency findings among them; the reconciles' consistency follow-ups). Then **"still to do"**, drawn only from
   those groups. **Chosen:** a refusal that made no job is found in the tool-call log, which now keeps the label the
   result echoed (`tool_calls.workstream`); with only `since`, the bridge's own work (`system`) is left out; at most 300
   jobs and proposals are read (the rest counted).
4. **The dashboard**: a **Workstreams** page (the Monitoring group): each label of the project with its principals, first
   and last activity and counts (jobs, pages written, proposals, awaiting you, unknown outcomes, failed), each opening
   its report (`GET /api/admin/workstreams`, `GET /api/admin/workstreams/report`). Read-only.

## Costs (measured against the mock, pinned by the tests)

- `arkona_identity_reconcile`: planning, one read per character (the dry run is that alone, plus a template read when
  a fact is new to a page). The job, per character: the in-job read, the rows check, one write per fact changed, the
  facts' read-back, the tag write's in-lock read and its write, the tags' read-back (about 4 reads and 2 writes for one
  fact and the tags), the governance once per job, and Last Major Revision's own steps where the rule sets it.
- `query_facts`: none; `live: true` one read per row of the page.
- `bridge_workstream`, `bridge_workstream_report`: none.

## The sandbox check (written, not run; passing on the mock)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- identity-f5c`
(`test/sandbox/identity-f5c.ts`, I1 to I7; run in the ordinary suite against the mock by
`test/sandbox-mock/identity-f5c.test.ts`). On the test world: a throwaway index and governance page (the pack approved
in the check's TEMPORARY database only); two throwaway characters (Human; Menkheti and Canthan); the dry run (both
planned with their tag arrays, nothing written); the run under a workstream label (both done and verified); both read
back live (facts and tags); `query_facts` over them (free); the workstream report (both written and verified, nothing
waiting); clean-up in its `finally` and the test file's `afterAll`.

## Questions for the owner

1. **Stale identity tokens in the audit.** The reconcile replaces the token of the value it changes (decision 2.4). The
   retag audit still reads any other identity token outside the page's grammar as an owner exception. Should the audit
   treat "an identity token of the maps that the page's facts no longer give" as a deterministic correction too?
2. **Deliberate gaps.** `Unestablished` (and the pack's other never-values) are accepted for Race and Naming Culture
   (decision 1.4), holding the tag slot. Confirm, or refuse them as unmapped.

## Consequences

- The owner approves `arkona-2026-11-23-f5c` on the Packs page; until then `arkona_identity_reconcile` is a proposal at
  every scope.
- Agents run one dry run and one call for a culture split instead of 27 rounds by hand; the owner sees either a direct
  job (10 pages or fewer, at write scope; on the Review page and Revertible) or one proposal approved item by item.
- Agents label a maintenance objective (or set a default once) and report it with `bridge_workstream_report`; the owner
  sees it on the Workstreams page.
- One migration adds four columns and two tables and rebuilds `job_stops` (every row kept).

## Tests

`test/packs/identity-reconcile.test.ts` (the Menkheti world, `test/packs/identity-world.ts`: the preview and the run that
matches it; an unmapped culture, a Canonical Display Name and a protected fact refusing only their items; a hold-type
result; grammar order with Cosmology kept; an [INDEX] to its Core, a Compact Reference; Last Major Revision; a consistency
follow-up; no write outside the sidebars and tags; the rails at 10 and 11 pages and a partial approval; a stale
`factsVersion` skipping only its item; a failed write failing only its item and Resume finishing it, nothing written
twice), `test/tools/query-facts.test.ts` (each selector; characters in Main CANON and an AU; columns and rows, CSV,
paging, the age; stale and missing flagged; `live` with its estimate; no read without `live`),
`test/tools/workstreams.test.ts` (the label on jobs, journal entries and proposals and the approved job; the default and
its expiry; a mixed workstream's report, group by group; free; the dashboard's list), `test/packs/identity-memory.test.ts`
(repeated reconciles, queries and reports back to their baseline), `test/sandbox-mock/identity-f5c.test.ts`, and the
browser test in `test/e2e/dashboard.spec.ts` ("v3 F5c": the Workstreams page and a report).
