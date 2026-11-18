# Identity, scopes and proposals (chunk 2b)

Every connection to `/mcp` acts **for a principal under a profile**, and the profile's **scope** decides what it may do.
The owner sets both, at consent or later in the dashboard. Writes from a connection at scope `propose` become
**proposals** that the owner approves or rejects; nothing is sent to LegendKeeper until then. The design decision that
scopes are evaluated live is [ADR 0012](adr/0012-live-policy-evaluation.md).

Code: `src/policy/` (entry point `src/policy/index.ts`). Tests: `test/policy/`.

## The model

| Term          | What it is                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Principal** | Who a request acts for: an OAuth grant (`grant_…`, one consent for one client) or a personal access token (`pat_…`).                                       |
| **Profile**   | A named policy bundle (`agent_profiles`): `label` (unique), `kind` (`claude`, `chatgpt`, `claude-code`, `other`), `scope` and (v2 B2) `showLowLevelTools`. |
| **Scope**     | `read`, `propose` or `write`. Attached to the profile, never to a token.                                                                                   |
| **Owner**     | The only authority. Chooses profile and scope at consent; changes them, approves and rejects proposals in the dashboard (chunk 5).                         |

- **Identity comes from the server-issued token only.** The bearer token resolves to its grant or PAT; the grant or
  PAT points at its profile. MCP `clientInfo`, a client's registered name and the profile name a caller might claim
  are display labels and never decide anything.
- Every grant and PAT has exactly one profile (`profile_id`, migration `0300_policy_init.sql`). Refresh and access
  tokens inherit the grant's profile. Grants and PATs from before this chunk were moved to a profile named `legacy` at
  scope `read`.
- New profiles get the **default scope for new connections**, `read` unless the owner changes it
  (`setDefaultScope`).
- **Projects (v2 A1).** Profiles and scopes are per connection and apply to every project the bridge serves (ADR
  0023). A proposal belongs to the project its write was for: the agent tools and the dashboard show it in that project
  only, and approving it executes it against that project only. With several projects, a write (direct or proposed)
  must name its project (`REQUIRE_PROJECT_FOR_WRITES`).

## Scopes

| Scope     | Reads | Writes (every non-read operation)                                                                                                                                                                              |
| --------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`    | allow | denied: `PolicyDeniedError` saying the connection is read-only and that the owner can change it                                                                                                                |
| `propose` | allow | captured as a proposal; the agent gets `{ status: 'proposal_captured', proposalId, summary }`                                                                                                                  |
| `write`   | allow | run, within every existing guard (read-only mode, pause, If-Match, unsupported blocks, cascade, etc.); the profile's [safety rails](#write-scope-review-revert-and-safety-rails-v3-f34) keep some for approval |

- Member and invite administration (`inviteMember`, `removeMember`, `revokeInvite`) is refused for every agent, at any
  scope, unless `LK_ALLOW_MEMBER_ADMIN=true`: by the engine's guard (`MEMBER_ADMIN_DISABLED`), after the gate, and at
  proposal capture (so it is never captured).
- **Uploads are not proposable (v1).** At scope `propose`, `lk_upload_image`, and raw `createImageUpload` /
  `createImageAsset` calls through `lk_api_write` or `lk_api_batch`, are refused before anything is sent, with a
  message that uploads need scope `write` and that the owner can raise the profile's scope. (A proposal would have to
  hold the image bytes and a signed URL that expires within minutes.)
- **Staging is allowed at `propose` (v2 D3, [ADR 0041](adr/0041-image-pipeline.md)).** `upload_image` at scope
  `propose` always **stages**: the image is converted, uploaded, verified and hidden in the project's staging folder,
  then its placement (when a destination was given) is the proposal. The gate allows an `upload_image` job only when the
  engine marks it `staging` (hidden, verified, into the staging folder), which only bridge code can set; the two
  refusals above stay. So a `propose` connection can add hidden images to the staging folder, which the owner sees on
  the Staging page and can discard, and nothing else; the proposal holds the staged asset's id and the folders, never
  bytes. Placing a staged image (`staged_id`) at `propose` is an ordinary proposal.
- **Asset deletes keep their bytes (v2 D3).** Every `deleteAsset`, by any route and at any scope, first downloads the
  asset's file into the bridge's kept-bytes store (a folder's: its children's), referenced from the journal's
  pre-image; if that fails the delete is refused (`ASSET_BYTES_NOT_KEPT`) unless the owner allows that one asset on the
  Staging page (re-authenticated). The binary upload endpoint's capabilities (`prepare_image_upload`) are covered in ADR
  0041's threat review: scope `write` or `propose`, read again when the file arrives, rate-limited and audited.
- The `system` principal (internal and dashboard work) is always allowed, except on an MCP origin, where it could only
  mean a tool forgot to pass the caller: denied.
- Unknown, revoked or expired principals are denied, reads included.
- **Live evaluation.** The gate reads the principal's profile and scope from the database on every engine entry
  (cached for at most one second; any change made through the bridge clears the cache at once). Changing a profile's
  scope changes what every existing connection on it can do on its very next call, with no reconnection.
- **Queued work follows too (chunk 8).** Before each new step of a job that acts for an agent, the engine asks the
  gate again (`phase: 'execute'`). If the connection has been revoked, or its scope lowered to `read` or `propose`, that
  step fails with `POLICY_DENIED` (recorded on the Errors page with the job), the rest of the job is cancelled, and the
  job ends `failed`. A step already in flight is finished and verified. Jobs the owner approved (`approvedBy`) and
  internal work are not asked again: the owner's approval wins, as below.

### Tool lists

`tools/list` is built per request: a principal at `read` sees only tools with `access: 'read'`; at `propose` and
`write` it sees every tool (at `propose`, a write tool returns the proposal result). A tool without `access` counts as
`write` unless it is annotated `readOnlyHint: true`. The list is a convenience, not the control: a hidden write tool
called directly by a `read` connection is refused at call time with the read-only message (every tool stays
registered; only `tools/list` is filtered), and the policy gate refuses the write in the engine whatever the tool says
about itself (defence in depth; `test/policy/mcp.test.ts`, `test/tools/policy-e2e.test.ts`).

**Visibility of work.** `bridge_job_status` (with `wait_seconds`; `bridge_job_wait` before v2 E3b), `bridge_job_cancel`, `bridge_result_page` and
`bridge_errors_recent` show only the caller's own jobs, stored results and errors (by principal). Another principal's
job id or handle answers exactly like an unknown one. `bridge_journal_lookup` shows every principal's entries,
read-only, with principal, profile and approver on each, because cross-checking another agent's edits is a
consistency need; job ids appear only on the caller's own entries. `bridge_info` reports the caller's profile and
scope.

Tool handlers get `ctx.principal` (and `ctx.scope`). Every engine-backed tool builds its origin with
`mcpOrigin(ctx, tool)`, which carries the principal and the tool name, never `approvedBy`, and refuses (a
`PolicyDeniedError`) when the request has no principal, so a tool can never fall back to `system`.

## The proposal lifecycle

```
             capture                  approve (CAS)            re-read OK, submitted       job succeeded
 agent ──────────────▶  pending  ─────────────────▶ approved ───────────────────▶ executing ───────────▶ executed
                          │  │                         │                              │
                reject    │  │ expiry (timer)          │ a target changed             │ job failed / cancelled
                          ▼  ▼                         ▼                              ▼
                     rejected expired              conflicted                       failed
                        ▲                              │ ▲
                        └── reject (owner) ────────────┘ └── v2 C1: a page write whose in-lock version check refused it
                                                             (executing → conflicted)
```

**Capture** (the `ProposalSink`, when the gate returns `propose`):

1. Params are validated against the registry schema.
2. The guards that do not write are dry-run: cascade confirmation, member admin, and the unsupported-block guard
   (against the current document).
3. Each operation's target is read through the engine, so through the governor at the caller's priority, and its
   LegendKeeper version, a SHA-256 fingerprint and the pre-state (up to 512 KB, for the diff) are stored. Creates with
   a client id have no target. Nothing but these reads reaches LegendKeeper.
4. The ordered operations are stored as **one** proposal, however many there are. It expires after 14 days
   (`POLICY_PROPOSAL_EXPIRY_DAYS`); a timer (`POLICY_EXPIRY_SWEEP_SECONDS`, default 5 minutes) expires due proposals.
5. **Limits (chunk 8).** A proposal keeps at most 4 MiB of pre-state in all (each operation at most 512 KB, cut by
   bytes); past that an operation keeps its version and fingerprint, which conflict detection uses, but no pre-state
   text, and its diff says it was truncated. One connection may hold at most 50 `pending` proposals; the 51st is refused
   with `POLICY_DENIED` before anything is read, until the owner decides some.

**Approve** (owner only):

1. Refused, leaving the proposal `pending`, while the bridge is read-only, writes are paused or it is draining; and
   for an expired proposal.
2. Compare-and-set `pending → approved`: a double click or a retry cannot approve twice.
3. Every target is read again and compared with the capture (the version where there is one, else the fingerprint).
   Any difference ends `conflicted`, naming the operation; nothing is executed.
4. The operations go to the engine as one `batch_ops` job, stop on error, with the **proposer** as principal,
   `approvedBy: 'owner'` and an internal approval token. A versioned write whose captured version is known, and that no
   earlier operation of the same proposal touches first, is pinned to that version as `If-Match`, so LegendKeeper
   refuses it if the document changed after the re-read. Every guard runs again at execution.
5. The proposal follows its job: `executed`, or `failed` with the job id and progress (a partial failure leaves the
   earlier steps applied, as any stop-on-error batch does; the job and journal show which).

**Approval cannot loop.** The engine asks the gate about every entry, so the proposer's `propose` scope would turn
the approved batch into a new proposal. The proposal service therefore attaches an **approval token** to that one
submission. The gate allows an operation only if the token was minted by `src/policy/approval.ts` (checked by object
identity, so look-alikes are worthless), has not been used or expired, belongs to the same principal, and covers
exactly that step (operation id and params hash, in order) of a proposal that is now `approved`. The owner's explicit
approval wins even if the proposer's scope has since been lowered; member-admin refusal and read-only mode still apply.
`approvedBy`, or a token the gate does not recognise, arriving from anyone else is refused outright. The token minting
function is not exported from `src/policy/index.ts`.

**After a crash.** On start, a proposal left `approved` either reached the engine (its job is found by the origin it
was submitted with, `detail: proposal:<id>`, and the proposal follows it; the engine resumes the job itself) or did
not (it returns to `pending`; nothing was sent; the owner approves again). A proposal left `executing` follows its job.

**High-level operations (v2 C1, [ADR 0031](adr/0031-write-page.md)).** A proposal made by a high-level tool
(`write_page`) also stores the operation itself (`proposals.operation`): page, document, mode, section, the agent's
Markdown, its `baseVersion`, and the page's Markdown before and after. The capture reuses the read the tool planned on
(and refuses one made on another version). `getProposal` adds `operationDetail`, `markdownDiff` (the page before and
after, line by line, keep regions as labelled placeholders, in hunks) and, once the job ran, `execution` (whether the
read after the write matched); lists carry `operation`, briefly. The expansion keeps the step's `verifyAfterWrite` and
`journalOperation` options, never a re-planner: the owner approves exactly what was shown. If the job of such a proposal
fails with `VERSION_CONFLICT` before any step succeeded (the compare-and-swap inside the document's lock caught a change
made after the approval's re-read), the proposal becomes `conflicted` (`executing → conflicted`), not `failed`: nothing
was written. v1 proposals are unchanged.

**Multi-page groundwork (v2 C2a, [ADR 0032](adr/0032-set-facts-and-canon.md)).** A proposal stores a **list** of
high-level operations (`proposals.operations`; C1's single `operation` stays as the first), each naming the page it
affects and, optionally, its `pageParts`. Every client id the expansion needs is **minted at capture** and stored (a
planner mints the ids it cross-references itself; capture mints any still missing, for example a `createResource`
proposed through `lk_api_write`), so a child "under" a new index and a link "to" a new page are fixed in the proposal,
and approval runs with exactly those ids. Every proposal has a **page-level summary** (`page_summary`, made at capture):
its operations grouped by the page they affect, in plain labels such as `Asagiri Miyabi: sidebar, 3 facts changed, 1
link added`; the dashboard shows it first. An expansion may hold the bridge's own steps (`bridge.expect`, the check
inside the lock; `bridge.verify`, the generic verify) and a job-level lock (`job_options`); approval submits it with
both. What the verify step found is kept on the proposal (`verification`) as well as on the job. The check, the
verify step and a proposal's capture compare sidebar rows in LegendKeeper's rank order and by id, never by position:
its endpoints return the same rows in different orders (ADR 0032, Consequences).

**Reject** (owner only) takes an optional reason, which the agent can read. It accepts a `pending` **or a `conflicted`**
proposal, as one compare-and-set from those two states (ADR 0033): a conflicted proposal (the target changed after
capture) used to be stuck for good, because the dashboard told the owner to reject it, `reject` allowed only `pending`,
and `proposal-prune` never deletes `conflicted`. A rejected conflicted proposal keeps its stored `conflict` details, gets
the reason, `decided_by: 'owner'` and `finished_at`, moves to History, and is pruned after the retention like any
rejected proposal; the audit row's `before` records the state it really was in, and the proposer sees `rejected` with the
reason in `bridge_proposal_status`. Any other state is refused: "Proposal … is X; only pending or conflicted proposals can
be rejected". `bulkReject` follows the same rule.

## Protected canonical facts (v2 C2a)

**The rule** (decided by the owner; PLAN-v2 10.3 as refined): canon never changes without the owner's explicit
canonical approval, by any route. It is configuration, per project (Projects page, _Canon_; audited as
`project.set_canonical_rules`), a list of rules seeded with these defaults:

| Rule                                                               | Protected                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `Status` = `Authoritative`                                         | Both directions: setting a page's Status TO Authoritative, or changing it FROM Authoritative to anything else (removing it too). |
| `Continuity Type`                                                  | CHANGING an existing non-empty value (for example CANON ↔ AU). Setting it where it is empty (as on a new page) is allowed.       |
| `Continuity`                                                       | CHANGING an existing non-empty value (for example one AU to another). Setting it where it is empty is allowed.                   |
| Delete: `Status` = `Authoritative` (v2 C2b)                        | DELETING a page whose Status is Authoritative; with a cascade, any page of the subtree that is. Restoring needs no approval.     |
| Delete: kind `[BARC]` (v2 C2c, switchable)                         | DELETING an Archived `[BARC]` page, or a subtree holding one: the archive is provenance (`delete-archived`).                     |
| Delete a document: `Status` = `Authoritative` (v2 C2c, switchable) | DELETING a map, timeline or board of a page whose Status is Authoritative (`delete-document-authoritative`).                     |

Facts are every key-value row of the page's sidebar; keys match without case and with spaces trimmed, `value` rules
match values without case, a `change` rule compares a value's text and the pages it mentions (marks do not count). A
second value added next to an existing one is a change. Since CR-2026-11 keys and values are also compared as a reader
sees them: compatibility forms folded (fullwidth letters), invisible characters removed (zero-width spaces and joiners,
soft hyphens) and Cyrillic or Greek look-alike letters read as the Latin ones, so `Ｓｔａｔｕｓ` or `Authori­tative` is
judged as Status Authoritative; and a **page mention** written into a fact a `value` rule names (Status) is itself a
protected change, because what it shows is the mentioned page's name, which LegendKeeper fills in and which changes
when that page is renamed. Since v2 C2c the Status of pages agents create follows the
page lifecycle (`status: "working"` by default; [below](#the-page-lifecycle-guard-v2-c2c)); the old
`agentDefaultStatus` setting is still accepted by the API but no longer used. Templates carry no fact defaults (the
owner confirmed), so nothing is inherited.

**Switching a rule off** (v2 C2c). Every rule takes `enabled` (default `true`); `false` keeps it in the list, shown on
the dashboard as off, and applies it nowhere. The dashboard's Canon section has a Switch on / Switch off button per
rule, saved like any other edit (confirmed, audited as `project.set_canonical_rules`). The two v2 C2c rules are the
owner's recommendations; migration 1600 added both, on, to every project that stores its own rule list.

**What happens.** A write that would make a protected change becomes a **proposal flagged
`requiresCanonicalApproval`, whatever the caller's scope** (`write` or `propose`), and the agent's result says
`requiresCanonicalApproval: true` with the reason. A `read` connection is refused as before. Writes that touch nothing
protected behave exactly as before. The dashboard shows such a proposal with a banner listing the protected changes;
the only approval is **"Approve and accept as canon"** (`approveAsCanon`, `POST /api/admin/proposals/:id/approve-as-canon`
with `{ confirm: true }`), a separate action audited as `proposal.approve_as_canon` that records `canonicalApprovedBy`
(and when). The ordinary Approve, and bulk approval, are refused for it (`CANONICAL_APPROVAL_REQUIRED`); "accept as
canon" is refused for a proposal that is not canonical (`NOT_CANONICAL`). Reject works as normal, one at a time or in
bulk.

**In bulk** (owner, 11 November 2026). `bulkApproveAsCanon` is `approveAsCanon` for each id, one at a time and in order
(each re-reads its targets, and an earlier one may change a later one's), exactly as `bulkApprove` is `approve`. The two
kinds stay distinct: an ordinary proposal is refused there ("ordinary proposal; use Approve", code `NOT_CANONICAL`) and
stays pending, and a canonical proposal in `bulkApprove` is reported as `skipped: true` (`CANONICAL_APPROVAL_REQUIRED`),
not as a fault. Each accepted proposal is audited on its own as `proposal.approve_as_canon`, with `canonicalApprovedBy`
and `bulk: true`; the guards run again at its execution, so a target changed after capture ends _conflicted_, not
executed. `bulkReject` needs no canon decision and takes canonical proposals as it takes any other. The admin route is
`POST /api/admin/proposals/bulk` with `action: "approve-as-canon"`, `confirm: true` and at most 100 ids.

**Where it is enforced.** In the job engine, on every request and every write, not in each tool (src/facts/canonical.ts,
the engine's write guard, src/jobs/write-guard.ts):

1. **At entry**, once per `run` / `submit`, after the policy gate let every operation through: the request's sidebar
   writes are simulated in order on the page's sidebar as it is now (the tool's own read when it made one, else one
   `listProperties`), and the facts after each write are compared with those before it. A batch is judged as the
   sequence it is, so a protected change made in two harmless-looking steps is caught. A sidebar that cannot be read
   counts as protected (refuse rather than guess). In a batch with `onError: "continue"`, where a step may fail and the
   steps after it still run, each write is also judged on the page as it is now, as if every step before it had failed
   (CR-2026-11, CR-08); a template copy's id is never trusted to be a new page.
2. **At execution of an approved proposal**: the approved batch passes the same entry check. With a canonical approval
   token (minted only by "Approve and accept as canon") it runs; without one, an expansion that carries a protected
   change is refused there, the proposal fails, and **nothing is written** (a forged or stale expansion).
3. **Inside the lock**, before each sidebar write is sent: the check is made again on what is there now (the read the
   engine makes there, or one more read when the write touches a protected fact). A job that does not carry canonical
   approval is refused (`CANONICAL_APPROVAL_REQUIRED`); nothing is sent. Only a row write whose `If-Match` the engine
   chained from the job's own previous write (or its check step) is left to LegendKeeper's version check; since
   CR-2026-11 (CR-08) a version the caller gave is read and judged there like any other write, because it proves nothing
   about what the entry check saw.
4. **The system principal** (the bridge's own work, the dashboard) is refused a protected change too: the bridge never
   makes one on its own.

**Every write path that can reach sidebar facts, and its guard:**

| Path                                                                                                                                                    | Guarded by                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set_facts`                                                                                                                                             | entry (with the plan's own read), execution, inside the lock                                                                                              |
| `lk_api_write` with `createProperty`, `updateProperty` (rows), `deleteProperty`                                                                         | entry, execution, inside the lock                                                                                                                         |
| `lk_api_write` with `createPropertyRow`, `updatePropertyRow` (key or value), `deletePropertyRow`                                                        | entry, execution, inside the lock (a caller's If-Match included, CR-2026-11)                                                                              |
| `lk_api_batch` with any of those, in any order                                                                                                          | entry (the whole sequence), execution, inside the lock                                                                                                    |
| `lk_op_createProperty`, `lk_op_updateProperty`, `lk_op_deleteProperty`, `lk_op_createPropertyRow`, `lk_op_updatePropertyRow`, `lk_op_deletePropertyRow` | entry, execution, inside the lock                                                                                                                         |
| `createResourceFromTemplate` (any tool): it copies the template's properties                                                                            | entry (the template's facts are read and judged as a new page's); with `includeChildren`, every page under the template too, at entry and inside the lock |
| `saveResourceAsTemplate` followed by a copy of it in the same request (CR-2026-11)                                                                      | entry (the copy is judged on the saved page's facts)                                                                                                      |
| C2b's tools (resources, documents, characters)                                                                                                          | the same engine guard, whatever they submit (a new page's facts judged on its template's copy); `assessFactChange` and `assessDelete` for their dry runs  |
| `deleteResource` (any tool, v2 C2b)                                                                                                                     | entry (the page, and with `cascade` its subtree, listed live), execution, inside the lock (the page, and with `cascade` its subtree again, CR-2026-11)    |
| An approved proposal's batch                                                                                                                            | execution (canonical approval token required for a protected change), inside the lock                                                                     |

Operations that cannot write sidebar facts are not checked: `createResource` and `createManyResources` (their bodies
carry no properties), `updateResource` (name, tags, aliases, icon, flags), `saveResourceAsTemplate` (it copies a page
into a template; the page does not change, and a template's facts are judged when a page is made from it), block and
infobox operations (page content, not the sidebar), `restoreResource` (restoring brings back what was approved, and is
how a mistaken delete is undone), and document operations other than a delete (since v2 C2c, deleting a map, timeline
or board of an Authoritative page is guarded by the `delete-document-authoritative` rule, below).

**Deleting protected canon** (decided by the owner on 10 November 2026; ADR 0034). A rule of kind `delete` (the
default: `{ "id": "delete-authoritative", "key": "Status", "kind": "delete", "values": ["Authoritative"] }`) makes a
`deleteResource` whose page holds one of the values (without case) need canonical approval, by the same machinery and
on every path (`delete_resource`, `lk_api_write`, `lk_api_batch`, `lk_op_deleteResource`, an approved proposal):

- **at entry** the page's sidebar is read live; with `cascade` so is every page under it, listed live, level by level
  (CR-2026-11, CR-09: the repository tree may not have seen a page added or moved under it in the app). At most 101
  pages are read; a larger cascade, a sidebar that cannot be read, or a subtree that cannot be listed counts as
  protected. A cascade in a request that also moves, restores or creates pages (which could put a page under it first)
  counts as protected too. The canonical proposal lists every
  protected page (`deleting “Inae Mikumo”, whose Status is Authoritative`);
- **inside the lock** the page itself is read again before the delete is sent, and with `cascade` every page under it is
  listed and read again (CR-2026-11), so a page made Authoritative, or moved under it, since the entry check (in the
  app, or by another job while this one waited) is not deleted without canonical approval. A cascade of N pages costs
  about 4N reads in all (a listing and a sidebar read per page, at entry and in the lock);
- under scope `write` it becomes a canonical proposal, as for a protected fact change; "Approve and accept as canon"
  runs it.

The rule shows in the dashboard's Canon section with the others and is edited there (kind "deleting a page with these
values"); migration 1500 added it once to every project that stores its own rule list. The Status of the pages the
creation tools make (`agentDefaultStatus`, `Working`) is written in the same job as the create; a create that sets
`Authoritative` becomes a canonical proposal (the guard judges a new page's facts on its template's copy).

**Deleting an Archived page, and a document of an Authoritative page** (v2 C2c, ADR 0035; recommended, switchable).
A rule of kind `deleteKind` (`{ "id": "delete-archived", "kind": "deleteKind", "kinds": ["barc"] }`) makes a
`deleteResource` of a page of that kind (from the repository tree; with `cascade`, any page of the subtree) need
canonical approval. A rule of kind `deleteDocument` (`{ "id": "delete-document-authoritative", "key": "Status",
"kind": "deleteDocument", "values": ["Authoritative"], "documentTypes": ["map", "time", "board"] }`) does the same for
`deleteDocument` of a document of those types on a page whose Status holds one of the values: at entry the page's
sidebar and the document's type are read (from the tree, else live; a read that fails counts as protected), and inside
the lock the page's sidebar is read again. Page documents are never deleted this way (`delete_document` refuses them).

**The shared function.** `assessFactChange(rules, before, after)` (src/facts/index.ts) is pure: given a page's facts
before and after a change, it lists the protected changes. C2b's tools call it to tell an agent in a dry run; the engine
guard enforces it whatever they call.

**Retention (v1.0.1).** `executed`, `rejected`, `expired` and `failed` proposals are deleted, with their operations and
pre-state, `POLICY_PROPOSAL_RETENTION_DAYS` (90) days after they finished, by the `proposal-prune` maintenance job
([maintenance.md](maintenance.md#proposal-prune-v101)). `pending`, `approved`, `executing` and `conflicted` proposals are
never pruned. Jobs, journal entries and audit rows keep the proposal id as text.

### Agent-facing tools

Both are read tools (`access: 'read'`, `readOnlyHint: true`) restricted to the caller's own proposals (by principal);
another principal's proposal is reported exactly as if it did not exist.

| Tool                     | Input                                       | Returns                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge_proposal_status` | `{ proposalId?, state?, limit?, project? }` | with `proposalId` one proposal (without it, yours, newest first): state, summary, operation count, times, the rejection reason, the job id, the conflicting operation, the error text; since v2 C2a the pages affected and `requiresCanonicalApproval` with `canonicalReason` |
| (retired name)           | `bridge_proposals_mine`: renamed in v2 E3b  | answers `TOOL_RENAMED` for one release; `bridge_proposal_status` without `proposalId` lists yours, newest first (`limit` 1-50, default 20)                                                                                                                                    |

No MCP tool can change a scope, approve or reject a proposal, or create or revoke a token
(`test/policy/no-agent-escalation.test.ts` calls every registered tool with hostile arguments and checks).

## The page lifecycle guard (v2 C2c)

Lifecycle changes (Authoritative, Working, Archived; [tools.md](tools.md#the-page-lifecycle-v2-c2c), ADR 0035) happen
**only** through `archive_page`, `unarchive_page`, `move_to_working`, `promote_page` and the creation tools' `status`.
A second engine guard, beside the canon guard and combined with it (src/lifecycle/guard.ts), judges every request and
every write, on every path (`set_facts`, the creation and resource tools, `lk_api_write`, `lk_api_batch`, every
`lk_op_*`, an approved proposal), with the project's lifecycle settings:

| Refused                                                                                                                                               | Names                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Status to `Archived`                                                                                                                                  | `archive_page`                     |
| Status from `Archived` to anything                                                                                                                    | `unarchive_page`                   |
| Status from `Authoritative` (or another value) to `Working`                                                                                           | `move_to_working`                  |
| Status from `Working` to `Authoritative` (or another value)                                                                                           | `promote_page` (or `archive_page`) |
| A rename that adds, removes or changes `[BWRK]` or `[BARC]`; a page created with one by hand                                                          | the matching tool                  |
| A move into, out of or between `[INDEX] Working` and `[INDEX] Archived`; a page created under either                                                  | the matching tool                  |
| A Status written as a page mention (CR-2026-11)                                                                                                       | `set_facts` with plain text        |
| C2d (ADR 0036 decision 7): a status tag (`CANON`, `Working`, `Archived`) added or removed by `updateResource` on any route, or added by a create body | the matching lifecycle tool        |
| `[INDEX] Working` or `[INDEX] Archived` itself renamed, moved or deleted; a page given its name                                                       | none: the owner, by hand           |

The refusal is `POLICY_DENIED`, at every scope (a request at scope `propose` is refused, not proposed), with a message
naming the tool to use. `update_resource` answers a prefix change with `PREFIX_CHANGE` before it reaches the guard.

Since CR-2026-11 the guard reads a prefix as a reader sees it: in any case, with or without the space after it, with
spaces or invisible characters before it, in fullwidth or look-alike letters (`[barc] X`, `［BARC］ X` and `[BАRC] X`
with a Cyrillic А are all `[BARC]`). A template copy given no name is judged by the template's name, and a copy's Status
is judged whether or not the caller gave the copy an id. A page made `[BSRC]` (Authoritative) by a create or a rename
that no creation tool or lifecycle tool declares is not refused but becomes a **canonical proposal**, at every scope, as
an Authoritative create through the creation tools is (CR-2026-11, CR-16; ADR 0036 decision 1, accepted by the owner).

**The status tags (C2d, ADR 0036 decision 7, accepted by the owner on 11 November 2026).** The lifecycle settings' three
status tags are compared without case, invisible characters and look-alikes (the same fold as keys and prefixes). A
request that adds or removes one, other than through a lifecycle tool's marker or a creation tool's (which declare the
pages they retag), is refused at entry and again inside the lock, where the page's tags are read as LegendKeeper holds
them. Every other tag is free, and a status tag already on a page is kept when other tags change. The check is the
project's canon rule `status-tags` (kind `statusTags`, on by default; switched off on the dashboard, the status tags are
free again). `createResourceFromTemplate` takes no tags; the creation tools retag a copy with a declared
`updateResource`.

**Whole sets (C2d, ADR 0037).** A set change's marker names every page of the set: content pages with the state they
move to, indexes with the set's (for their status tags). Pages under an archived set's index are in the archive area as
far as the guard is concerned, so no route can create a page there, move one in or out, or rename one out of
`[BARC]`.

**Where it is enforced:** at entry (the request's sidebar writes simulated on the page's sidebar, as the canon guard
does; renames judged from the page's name; moves from where the page is, from the repository tree when it knows the page
and else read, and where it goes, read up the parents when the tree does not know them), at execution of an approved
proposal, and inside the lock before each rename, move or sidebar write: there a move is judged from the page's parent
as LegendKeeper holds it now (the engine's own read), so a page the tree has not seen, or one moved in the app, cannot be
taken out of a lifecycle area unseen (CR-2026-11, CR-13); a place that cannot be told counts as a crossing. A versioned
row write chained from the job's own earlier write is left to LegendKeeper's version check, as for the canon guard; a
caller's `If-Match` is judged.

**The tools' own steps** pass through a **lifecycle marker** on the job (`BatchSubmit.lifecycle`): set only by bridge
code, never parsed from an agent's request, stored with the job and with the proposal's job options, and naming exactly
the pages, prefixes, Status values and places the job may change. A marker that does not cover a change is refused like
a side route. A marker of the four lifecycle tools also makes the request a **canonical proposal at every scope**, which
only "Approve and accept as canon" runs; approved work that should carry a marker and does not (a tampered proposal) is
refused at execution and nothing is written. The creation tools' marker covers only the new pages' prefixes, Status and
place.

**Lifecycle settings** (per project, the dashboard's Projects page, Lifecycle; `GET|PUT /projects/:name/lifecycle`,
audited as `project.set_lifecycle`): the two indexes as the owner confirmed them, the index names they are found by,
the three Status values, the three status tags, the field names (Status, Continuity Type, Scope, Temporal Scope, Last
Major Revision), the Continuity Type values (CANON, AU, NON-CURRENT) and the archive texts. Until the indexes are
confirmed the guard still refuses Status and prefix changes (with the values above), but cannot tell a move into or out
of a lifecycle index, and the four tools and Working creates refuse to run: confirm the indexes first.

## An approval covers only the pages it listed (C2d, ADR 0036 decision 5)

Accepted by the owner on 11 November 2026 and built in C2d. An approved proposal runs only on the pages it showed. Most
operations name every page they touch, so the proposal's own targets (re-read at approval: a target gone or changed is a
conflict) are its list. The pages an operation touches without naming them are listed live when the proposal is captured
and kept with it (`pageScope` in its job options, src/policy/page-scope.ts):

- a cascade `deleteResource`: every page under the page it deletes;
- `createResourceFromTemplate` with `includeChildren`: every page under the template;
- a whole lifecycle set (`subtree: true`): every page under the set's root (the tool's own list).

At approval they are listed again; inside the lock, just before the cascade or the copy is sent, the page-scope guard
lists them once more (for a set, the job's own first check does). A page added, gone, or moved to another parent makes
the proposal **`conflicted`** (nothing written), whatever tool made it: the conflict names the pages. More than 500
pages under one page is refused at capture (delete or copy them in parts).

## Re-authentication for the canon rules and the lifecycle settings (C2d, ADR 0036 decision 4)

Saving the canon rules (`PUT /projects/:name/canon`: any change, a rule switched off and `rules: []` included) and
saving the lifecycle settings (`PUT /projects/:name/lifecycle`) need the owner to have re-confirmed their password (and
authenticator code) on this session within the last 5 minutes, as key changes do (ADR 0028); otherwise `403
REAUTH_REQUIRED` and nothing is saved. "Approve and accept as canon" is unchanged.

## Timeline, map and board content on Authoritative pages (ADR 0036 decision 6)

**Decided by the owner on 11 November 2026: option (a).** Adding, changing or deleting timeline events, lanes, map
features and board shapes on an Authoritative page are **ordinary edits**: they are not canon-gated, just as
`write_page` content is not, and need only the caller's scope (`write`, or a proposal at `propose`). Only deleting a
whole map, timeline or board **document** of an Authoritative page is canonical (C2c's `delete-document-authoritative`
rule, switchable). The chronology's timeline tools (ADR 0038) follow this: an event added to the Authoritative
Universal Chronology is written at scope `write`. **The map-feature tools (v2 D2, [ADR 0040](adr/0040-map-feature-tools.md))
follow it too:** `create_map_feature`, `update_map_feature` and `delete_map_feature` (a folder with `cascade`, every feature
it removes) on an Authoritative page are written at scope `write` with no canonical approval (tested), while `delete_document`
on the page's map is a canonical proposal. Setting a map's image (`update_document`) is an ordinary edit as well.

**Chronology proposals.** A chronology change under `propose` is one proposal. Its table and Main writes are judged at
execution by the job's own check inside the lock (the row still as planned, no identical row, the age's row still
there), which also decides the row's place and the new count; the proposal does not capture those documents' versions,
so a pending chronology proposal does not become conflicted because another event of the same age was approved first.
Its events are captured and compared as any other target.

## Write scope: review, revert and safety rails (v3 F3.4)

[ADR 0055](adr/0055-write-scope-review-revert-rails.md). At scope `write` an agent's ordinary changes run at once; the
owner reviews them afterwards and can revert one. Canon and lifecycle changes stay proposals at every scope, as above.

**Safety rails** (per profile, on the dashboard's Clients & Access page, "Always propose"). Even at scope `write`, a
request that a rail covers becomes an ordinary proposal instead of running:

| Rail                             | Default    | Covers                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deletes                          | on         | deleting a page, a document, a timeline event or lane, a map feature, an asset, a calendar, a sidebar or infobox property, board shapes; replacing a board's content or a calendar whole (`replaceBoardContent`, `updateCalendar`: what is not sent is deleted; CR-2026-11-R2, R2-02); and every removal through the low-level tools (below)      |
| Bulk changes (more than N pages) | on, N = 10 | a job that writes or makes more than N pages (a cascade counts every page under its page, and a copy with its children every page copied: R2-01; a restore every page it may bring back: ADR 0057 decision 9; pages not known count as more; a count from the repository tree that would let the job run is taken again on the live pages: R2-04) |
| Renames and moves of pages       | off        | a page's name changed or the page moved (`moveResource`); a page made in the same job is not counted (renaming an Authoritative page is a canonical proposal whatever the rails: R2-12, ADR 0057 decision 5)                                                                                                                                      |
| Asset deletes and asset moves    | on         | `deleteAsset`, and `updateAsset` to another folder; placing a staged image is not a move                                                                                                                                                                                                                                                          |

- **A rail only adds a proposal.** It is asked only about a request that would otherwise run directly: never about one
  already proposed (scope `propose`, the canon guard, a pack tool's switch), approved work, or the bridge's own. A rail
  that cannot be judged fails closed (a proposal). It is judged in the engine at entry, after the canon and lifecycle
  guards, with the profile's rails read live like its scope.
- **The proposal says which rail sent it**: `proposedBecause`, for example `proposed because: bulk change (14 pages > 10)`
  or `proposed because: delete (1 page “Mehrana al-Khalid”)`, stored with the proposal (`proposals.proposed_because`),
  shown on the Proposals page and returned to the agent with a hint never to retry it or route round it.
- A chronology change that re-makes an event (a date edit that removes an end deletes the event and makes it again) is
  not a delete.
- **Removals through the low-level tools are deletes** (ADR 0057 decision 4, the owner's, 17 November 2026; R2-52).
  Through `lk_api_write`, `lk_api_batch` or `lk_op_*`, the deletes rail also covers `deleteBlock`, `deleteBlockRow`,
  `deletePropertyRow` and `deleteBlockPropertyRow`, and every whole-list write that drops an entry LegendKeeper holds
  now: `replaceDocumentBlocks` (a block not sent), and `updateProperty`, `updateBlockProperty`, `replaceBlock` or
  `updateBlock` whose `items`, `rows` or `children` leave an entry out (read live before the verdict; a read that fails
  counts as a removal). A list write that only adds, reorders or edits entries stays an edit. The high-level tools'
  removals (`write_page`, `set_facts`, the chronology tools) are planned, checked and revertible, and stay edits. Revert
  does not put a low-level removal back yet (open in ADR 0057): the journal keeps the pre-image.
- **A restore counts every page it may bring back** (ADR 0057 decision 9; R2-03): LegendKeeper restores every page
  deleted by the same delete, so the bulk rail counts the page and its restore set (the set the canon guard reads since
  R2-10: the bridge's journal of its own delete, the snapshots, the tree). A set that cannot be told counts as more than
  N (fails closed).
- **The rails are judged when a request arrives** (ADR 0057 decision 6, the owner's: WS-G3). Switching a rail on applies
  to the next request; it does not stop a direct job already accepted and queued. **Lowering the profile's scope is the
  emergency brake**: a direct job is asked again by the gate before each step, so lowering the scope (to `propose` or
  `read`) on Clients & Access stops a queued job before its next write, with one click and no re-authentication.
- **A page never moves under `templates`** (W18, the write-scope rehearsal: LegendKeeper accepts the move and the page
  then reads with parentId "templates", out of the repository). `moveResource` to `templates` is refused for every caller
  at every scope, before anything is queued or proposed (`TEMPLATES_DESTINATION`): `move_resource`, `lk_api_write`,
  `lk_api_batch`, `lk_op_moveResource`, a setting pack's package and the owner's own dashboard work.
- **Changing a rail** is an ordinary profile setting: re-authenticated, audited `profile.set_rails` with the rails before
  and after (`PUT /api/admin/clients/profiles/:id/rails`). N is a whole number from 1 to 1,000.

**Review and Revert** (the dashboard's Review page, [dashboard.md](dashboard.md#review-v3-f34)). Every job an agent ran
directly (not approved by the owner) that wrote something is listed until the owner marks it reviewed (audited
`review.mark`, or `review.mark_all` for a filtered set) or reverts it. Revert (`job.revert`, re-authenticated) is the
owner's: one job, run by the system principal at P1, that puts back what the job changed when nothing has changed since,
from the journal's pre-images and the job's own record (page text block by block, sidebar facts and links, chronology
rows and events in step, names, tags, aliases and moves, image placements). It never reverts a deletion
(`restore_resource`), a proposal, a running job or a revert, and never deletes an asset itself: a reverted image
placement goes back on the Staging page (its file copied to the bridge's server, nothing written to `LK-Bridge
staging`) and deleting the placed asset is one proposal for the owner.

## The second review's changes (CR-2026-11-R2)

What changed in the guards, the rails and Revert after [CR-2026-11-R2](reviews/CR-2026-11-R2.md) (owner decisions in
[ADR 0057](adr/0057-cr-2026-11-r2-owner-decisions.md)):

- **Restores** are judged on every page they may bring back (LegendKeeper restores every page deleted by the same
  delete): from the bridge's journal of its own delete, the snapshots and the tree, at entry and inside the lock. A page
  that comes back Authoritative, or a set that cannot be told, makes the restore a canonical proposal; a restored page
  that crosses a lifecycle area is refused (R2-10).
- **No lifecycle marker declares a lifecycle index**: a page given `[INDEX] Working` or `[INDEX] Archived`'s name is
  refused whatever tool asks, setting-pack packages included; every template copy is judged inside the lock (R2-11).
- **A rename that drops `[BSRC]`** is a canonical proposal, as a rename into it is (R2-12). **Renaming an Authoritative
  page** (by its `[BSRC]` prefix or its Status), even keeping `[BSRC]`, is a canonical proposal too (ADR 0057 decision 5),
  by every route: `update_resource`, `lk_api_write`, `lk_api_batch`, `lk_op_updateResource` and the setting-pack tools
  (an upgrade to a Core, the appraisal's name fix). Judged by the canon guard at entry and again inside the lock. A
  Working or Archived page's rename is not affected (the renames-and-moves rail applies when it is on).
- **Template copies take the template's tags** (and a page saved as a template its page's): they are judged as a
  create's tags, at entry and in the lock; a copy whose template's tags cannot be read is refused (R2-13).
- **Where a page lands is judged inside the lock**, on its parent as LegendKeeper holds it now: a `[BWRK]`, `[BARC]` or
  status-tagged page created under an index the owner has moved since is refused (R2-14).
- **The fold** reads Latin small capitals and Cherokee and Lisu look-alikes as the Latin letters they look like (R2-15).
- **A job with no job-level lock** (a setting pack's package) runs its checks again when it starts again before its
  first write, as a locked job does (CR-06; R2-29).
- **A chosen chronology link** is a proposal at every scope (R2-08; ADR 0057 decision 3, accepted).
- **Re-authentication** for every change that lets a connection do more (R2-50, R2-51; [dashboard.md](dashboard.md);
  ADR 0057 decision 1, accepted).
- **An orphan event beside a row whose date cannot be read** is not deleted (ADR 0057 decision 2; R2-49): while the age's
  table has an unpaired row whose Date cell cannot be read and that is not marked table-only, `delete_timeline_event`
  with `orphan` and the dashboard's "Propose a fix" refuse (`ORPHAN_NEAR_UNREADABLE`, naming the rows), since the bridge
  cannot tell whether one of them is the event's own. Marking the row table-only, or fixing its date, lifts the block; a
  row whose date cannot be read that appears after the proposal stops it inside the lock.
- **ChatGPT's file source has its own switch** (ADR 0057 decision 7; R2-45): the project setting `fileSourceEnabled` (on
  by default), separate from `UPLOAD_ALLOW_URL_SOURCE` (`url` only), with the same guarded download. Switched off, a
  `file` is refused before anything is fetched (`UPLOAD_FILE_SOURCE_DISABLED`). Switching it on needs the owner's
  re-authentication; switching it off is one click; both are audited (`project.set_setting`).
- **A character's art folder comes from its exact path only** (ADR 0057 decision 8; R2-46): `Characters / Group / Race /
Character`. A folder with the character's name anywhere else is never used; a path that is ambiguous, or blocked by an
  asset that is not a folder, is refused (`ART_FOLDER_AMBIGUOUS`).

## Owner commands

`createPolicy(...).commands` (`src/policy/commands.ts`): plain functions for chunk 5's dashboard routes, which must
authenticate the owner (session cookie and CSRF) first. Each takes `actor: 'owner'` as its first argument (typed, and
checked at run time). Every change writes an `audit_log` row (`at`, `actor`, `action`, `target`, `before`, `after`) and
emits a `policy` event on the engine's event emitter; proposal state changes also emit `proposal` events.

| Command                                                      | What it does                                                                                              | Audit action                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `listProfiles(actor)`                                        | Profiles with their count of active connections                                                           | –                                                   |
| `createProfile(actor, { label, kind, scope? })`              | New profile (default scope unless given)                                                                  | `profile.create`                                    |
| `setScope(actor, profileId, scope)`                          | Changes a profile's scope; applies at once to its connections                                             | `profile.set_scope`                                 |
| `setRails(actor, profileId, change)` (v3 F3.4)               | Changes a profile's safety rails (a partial change keeps the other switches); applies at its next request | `profile.set_rails` (rails before and after)        |
| `getDefaultScope(actor)`, `setDefaultScope(actor, scope)`    | The scope new profiles get                                                                                | `policy.set_default_scope`                          |
| `listGrantsAndPats(actor)`                                   | Every grant and PAT with profile, scope, last use, expiry and revocation                                  | –                                                   |
| `setConnectionProfile(actor, id, profileId)`                 | Moves a grant or PAT to another profile (for example out of `legacy`)                                     | `connection.set_profile`                            |
| `revoke(actor, id)`                                          | Revokes a grant (its refresh and access tokens) or a PAT                                                  | `connection.revoke`                                 |
| `listProposals(actor, filter?)`                              | By state, principal, profile, before; newest first                                                        | –                                                   |
| `getProposal(actor, id)`                                     | With each operation's params, pre-state, proposed state, changes, lost unsupported blocks                 | –                                                   |
| `approve(actor, id)`                                         | As above; resolves with the proposal (`executing` or `conflicted`). Refused for a canonical proposal      | `proposal.approve` (then `proposal.executed`, …)    |
| `approveAsCanon(actor, id)` (v2 C2a)                         | "Approve and accept as canon": the only approval of a canonical proposal; records `canonicalApprovedBy`   | `proposal.approve_as_canon`                         |
| `reject(actor, id, reason?)`                                 | A pending or conflicted proposal                                                                          | `proposal.reject`                                   |
| `removeConnection(actor, id)`                                | Removes a revoked or expired connection (tombstone); an active one: `CONNECTION_ACTIVE`                   | `connection.remove`                                 |
| `removeInactiveConnections(actor)`                           | Removes every revoked and expired connection, in one transaction                                          | `connection.remove` (each)                          |
| `revokeStaleConnections(actor, profileId)`                   | Revokes the profile's stale connections                                                                   | `connection.revoke` (`via: 'stale'`)                |
| `getAutoRemoveDays` / `setAutoRemoveDays(actor, days)`       | Days before the daily sweep removes dead connections (0 = never; default 30)                              | `policy.set_auto_remove_days`                       |
| `getStaleAfterDays` / `setStaleAfterDays(actor, days)`       | Days of disuse before a connection is stale (0 = never; default 14)                                       | `policy.set_stale_after_days`                       |
| `bulkApprove(actor, ids)`, `bulkReject(actor, ids, reason?)` | One at a time, in order; a result per id. `bulkApprove` skips a canonical proposal (`skipped: true`)      | as above                                            |
| `bulkApproveAsCanon(actor, ids)`                             | `approveAsCanon` for each id, one at a time, in order; an ordinary proposal is refused and stays pending  | `proposal.approve_as_canon` each, with `bulk: true` |
| `listAudit(actor, filter?)`                                  | The audit log, newest first                                                                               | –                                                   |

The system writes its own rows with actor `system`: `proposal.conflicted`, `proposal.executed`, `proposal.failed`,
`proposal.expired`, `proposal.approval_reverted` and `proposal.approval_interrupted`; since v3 F3.4 also `job.revert`
when a revert job ends (succeeded, failed or cancelled). Read-only commands are not audited.

Errors are `PolicyError` with a stable `code`: `NOT_OWNER`, `INVALID_INPUT`, `PROFILE_EXISTS`, `PROFILE_NOT_FOUND`,
`CONNECTION_NOT_FOUND`, `CONNECTION_ACTIVE`, `PROPOSAL_NOT_FOUND`, `INVALID_TRANSITION`, `PROPOSAL_EXPIRED`, `BRIDGE_READ_ONLY`,
`WRITES_PAUSED`, `DRAINING`, `NO_ENGINE`, `REREAD_FAILED`, `CANONICAL_APPROVAL_REQUIRED` and `NOT_CANONICAL` (v2 C2a).

## Consent and PATs

- **Consent** (chunk 4's screen): after sign-in the owner sees the redirect host in large type, the client's
  self-reported name marked _untrusted name_ (HTML-escaped), and chooses an existing profile or a new one (label and
  kind) and its scope. The suggestion comes from the redirect host only: `claude.ai` and `claude.com` → `claude`,
  `chatgpt.com` → `chatgpt`, loopback → `claude-code`, anything else → `other`. An existing profile with the
  suggested label is preselected; otherwise "New profile" with that label. The new-profile label and kind appear only
  when "New profile…" is selected (CSS `:has()`, no script; a browser without `:has()` shows them all the time under
  "Only for New profile…"). **Preselected scope (v1.0.1, [ADR 0019](adr/0019-consent-keeps-existing-scope.md), changed
  by [ADR 0033](adr/0033-removing-connections-replace-on-reconnect-and-operation-discovery.md)):** the first scope
  radio is _Keep the chosen profile's current scope_ (`keep`), preselected whichever profile is chosen. On the server
  `keep` is the chosen existing profile's current scope, or the default scope for a new profile (`read` unless the
  owner changed it), so approving without touching anything changes nothing and `keep` never asks for a confirmation.
  Choosing read, propose or write explicitly still goes through the confirmation below. **A change to an existing profile's scope is confirmed first:** the bridge shows a second page
  with the warning that it affects every connection on that profile (and how many there are), the change (`from` →
  `to`) and two buttons, _Change to … and approve_ and _Keep … and approve_. Only that confirmation, for exactly that
  change, applies it (audited `profile.set_scope`, `via: consent`); picking another existing profile in the list
  without choosing its scope therefore never changes it silently. A bad choice shows an error without using up the
  request; denial is unchanged.
- **Replace on reconnect (ADR 0033).** When the application being approved already has active connections, the page
  lists them in "This application's existing connections", each with a checkbox ticked by default (label, profile,
  created, last used). The same application is the same `client_id` for a Client ID Metadata Document client; for any
  other client (Dynamic Client Registration gives a new `client_id` every time) it is the same verified redirect origin
  (a loopback address compares scheme and host, not the ephemeral port). The client's self-reported name never decides
  it. **Nothing is revoked at approval.** The ticked grants are stored on the authorisation code
  (`auth_codes.replaces`); only when the `authorization_code` grant succeeds at the token endpoint, in the same
  transaction that stores the new grant, each is re-checked (still active, still the same application, else skipped)
  and revoked with `revoked_reason = 'replaced by <new grant id>'`, audited `connection.revoke` with `via: 'replaced'`.
  If the code is never exchanged, or the exchange fails, the old connections are untouched.
- **PATs:** `npm run pat -- create --name "<name>" [--profile <label>] [--scope read|propose|write]`. The profile
  (default `claude-code`) is created if absent, at the default scope unless `--scope` is given; with an existing
  profile, `--scope` changes its scope (audited). `npm run pat -- list` shows each token's profile and scope. Claude
  Code's PAT profile is expected to be `claude-code` at `write`, set deliberately by the owner.

## Removing connections, stale connections and automatic removal (ADR 0033)

- **Remove.** A revoked or expired connection (grant or PAT) can be removed from Clients & Access. Removing deletes
  its credentials in one transaction: for a grant the `auth_token_families` row and every `auth_refresh_tokens`,
  `auth_access_tokens` and `auth_codes` row of that family; for a PAT the `auth_pats` row. `auth_clients` is never
  touched (a registration may serve other grants). The same transaction writes a **tombstone**
  (`removed_connections`: id, type, label, client, profile, created, revoked, expires, removed at, removed by) and the
  audit row `connection.remove` (`before`: the tombstone fields, `after`: `null`; the actor is `owner`, or `system` for
  the sweep). An **active connection is refused**: `409 CONNECTION_ACTIVE`; revoke it first.
- **History stays readable.** The journal, proposals, jobs, errors and audit log keep the grant or PAT id. Wherever the
  dashboard (journal, proposals, jobs, errors) or `bridge_journal_lookup` shows who, a removed connection is named from
  its tombstone, for example "ChatGPT (removed 10 Nov 2026)"; one with no tombstone (removed before this hotfix, by the
  old prune) reads "Removed connection". Never a bare id.
- **API:** `POST /api/admin/clients/connections/:id/remove`, `POST /api/admin/clients/connections/remove-inactive`
  (returns `{ removed, ids }`), `PUT /api/admin/clients/settings/auto-remove-days`,
  `PUT /api/admin/clients/settings/stale-after-days`, `POST /api/admin/clients/connections/revoke-stale`
  (`{ profileId }`). The dashboard's single Remove has no confirmation (the row is already dead); "Remove all revoked and
  expired (N)" shows only when N > 0 and lists the rows.
- **Automatic removal.** `connections.auto_remove_days` (in `policy_settings`, default **30**, `0` = never; audited
  `policy.set_auto_remove_days`). The maintenance job `connection-removal` runs daily (04:00 London) and removes revoked
  or expired connections whose dead time is at least that many days ago: `revoked_at`, or `expires_at` for a connection
  that expired without being revoked. The auth prune no longer deletes grants (it used to, silently, 30 days after a
  revocation and one day after an expiry); only this sweep and the owner remove a connection, so there is always a
  tombstone.
- **Stale.** An active connection whose last use (its creation, if never used) is older than
  `connections.stale_after_days` (default **14**, `0` = never; audited `policy.set_stale_after_days`) gets a "stale"
  badge. Each profile table has "Revoke stale (N)", with a confirmation listing them; each revocation is audited
  `connection.revoke` with `via: 'stale'`.

## Tool-list caching (observed 10 November 2026)

Tool visibility (a profile's "Show low-level and rarely used tools", or a scope change that hides or shows the write tools) changes the
next `tools/list`, but a client may keep its own copy. **claude.ai** keeps a copy of a connector's tool list: on 10
November 2026 a change showed only after the connector was disconnected and reconnected in claude.ai's settings, and
new chats alone were not enough (observed, not a guarantee). **ChatGPT:** Plugins, then the bridge, then Refresh. The
Clients & Access page and the bridge guide say so too.

## Wiring

`src/runtime.ts` (`createRuntime`) is the one place things are built: governor and LK client, then the policy layer
(`createPolicy`), then the job engine with `policyGate: policy.gate` and `proposalSink: policy.proposals`, then
`policy.attach(engine)` once the engine has started (job outcomes, restart reconciliation, the expiry sweep, the event
stream), then the tools (chunk 3's, plus the two proposal tools with the budget footer). `createBridge` in
`src/server.ts`, which `main` runs, passes `runtime.policy` to `buildServer`, so consent, tool lists and the engine
share one policy layer (`test/tools/policy-e2e.test.ts` › boot).

`buildServer` alone (auth tests) creates a policy layer on `db` when none is passed: consent and tool lists work, and
approval needs an attached engine. It appends the proposal tools unless the given tools already include them.

## Settings

| Variable                         | Meaning                                                                                                                                                                                        | Default |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `POLICY_PROPOSAL_EXPIRY_DAYS`    | A pending proposal expires after this many days                                                                                                                                                | 14      |
| `POLICY_EXPIRY_SWEEP_SECONDS`    | How often expiry is checked                                                                                                                                                                    | 300     |
| `POLICY_PROPOSAL_RETENTION_DAYS` | Finished proposals (executed, rejected, expired, failed) older than this are deleted by the `proposal-prune` maintenance job, with their pre-state; pending and conflicted ones never (v1.0.1) | 90      |

The scope cache is fixed at one second at most (`cacheMs`, 0-1000, in code).

## Hiding the low-level tools (v2 B2)

A profile's **show low-level and rarely used tools** setting (`showLowLevelTools`, default off, migration 1100; named “show low-level tools” until v2 E3b) decides whether its
connections are _shown_ `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, every `lk_op_*` and, since v2 E3b, `lk_upload_image` and `create_bare_resource`
in `tools/list`. The owner changes it on Clients & Access (`PUT /api/admin/clients/profiles/:id/low-level-tools`),
no confirmation is asked, and it is audited as `profile.set_low_level_tools` with the old and new value. **A client may
keep showing the old tool list:** claude.ai keeps its own copy of a connector's tool list, so a change here (or a scope
change that hides or shows write tools) shows in claude.ai only after the connector is disconnected and reconnected in
claude.ai's settings; new chats alone were not enough (observed 10 November 2026, not a guarantee). In ChatGPT, use
Plugins, then the bridge, then Refresh. **Operation discovery without these tools:** a profile that cannot see
`lk_api_list_operations` can still run every operation, so an `UNKNOWN_OPERATION` error suggests up to 5 close ids
(edit distance plus a small synonym map: append, add, create → insert; edit, set → update; remove → delete; fetch → get
or list) and names the low-level tools only if the profile shows them; otherwise it points at `get_bridge_guide`
(Operations), whose Operations section is generated from the registry
([ADR 0033](adr/0033-removing-connections-replace-on-reconnect-and-operation-discovery.md)). It is read live
with the scope, so the next `tools/list` follows it. **It is not a permission.** Every tool stays registered, so a call
to a hidden tool is refused or allowed exactly as before: a `read` profile still gets the read-only refusal for a hidden
write tool, a `propose` profile still gets a proposal, and the engine's guards apply as ever
([ADR 0029](adr/0029-discover-and-read-tools.md)).
