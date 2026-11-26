# ADR 0081: v3 F12: agents write directly at scope `write`; the Review page is the safety net; deletes are recoverable; the step-up only for credentials

- Status: **Proposed** (v3 F12, 26 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). The sandbox check
  (`f12-direct`) is opt-in and the owner runs it. Where the brief was silent the choice is marked **chosen**.
- Why (the owner, 26 November 2026): at scope `write` an agent's canon and lifecycle changes, its deletes and anything
  a rail caught still became proposals, so a connection the owner had trusted to write spent most of a session waiting
  for approvals the owner gave without reading. The Review page (ADR 0055) already shows every direct write with Revert;
  F12 makes it the safety net and makes the writes it cannot yet undo undoable.
- Amends: [ADR 0041](0041-image-pipeline.md) (an agent's asset delete is direct, its bytes kept for Revert),
  [ADR 0055](0055-write-scope-review-revert-rails.md) (decisions C and D withdrawn: no rails, no per-tool "always
  propose"; decisions A and B extended), [ADR 0062](0062-dashboard-sessions-and-step-up.md) (the step-up only for
  credential changes; its window a setting), [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) (unchanged in
  effect: automation codes at Propose still propose; the owner's "Apply fix" is one confirmed action).
- Migration `4900_f12_direct_writes.sql`: drops `agent_profiles.write_rails`; rebuilds `snapshot_restores` (a `job_id`,
  the state `running`, a `follow_up_job_id`); adds `consistency_picks.job_id`; creates `delete_copies`. Pack seed
  `arkona-2026-11-26-f12` (supersedes `arkona-2026-11-27-f6c`; it drops `settings.alwaysPropose` and `settings.tools`).

## Rulings (the brief)

1. A proposal is made only by a connection at scope `propose`, or by the owner's own automation for a code at Propose.
   Nothing else proposes.
2. A refusal of an invalid change stays a refusal: F12 removes proposals, not checks.
3. Agent proposals already open are left as they are; the owner decides them as before.

## D1: direct writes at scope `write`

- **The guards** (`src/facts/canonical.ts`, `src/lifecycle/guard.ts`) answer `allow` or `refuse` for an agent at
  scope `write`, never `propose`. The engine marks such a request `direct` (`directWrite` in
  `src/jobs/write-guard.ts`: the gate allowed it, no approval rides on it, and it is an agent's, or the owner's confirmed
  action); `combineGuards` turns any other verdict on a direct request into a denial, so a guard that still says
  `propose` is a bridge fault, reported, never a silent proposal. Inside the lock the guards accept canon on a direct
  job as they accepted an approved one (`canonAccepted`).
- **The rails are gone** (ADR 0055 decision C): `src/policy/rails.ts`, `list-drops.ts`, `text-removal.ts`, the
  per-profile `write_rails` column, the Clients page's rails card, `PUT /clients/profiles/:id/rails`, the gate's
  `rails`, the resume service's rail check, their docs and tests. What a rail guarded (a large text removal, a list
  shortened, a delete) is now on the Review page with Revert, and a delete is copied first (D3).
- **The pack's per-tool "always propose" switches are gone** (ADR 0055 decision D): `settings.alwaysPropose` and
  `settings.tools` are ignored when read and dropped by the seed upgrade; the Packs page loses the switches and
  `PUT /packs/:id/tools` is removed. `arkona_retag_apply`, the split, the rename, the appraisal fixes, the identity
  reconcile and the narrative tools follow their connection's scope.
- **The owner's dashboard actions are one confirmed action.** Where the dashboard used to make a proposal for the owner
  to approve next (a snapshot restore, an image restore and its "finish", an audit's "Apply fix", a chronology fix, an
  appraisal fix, a consistency pick, a tagging fix), it now asks in a confirmation dialog and runs the job at once. The
  job's origin carries `ownerConfirmed: true`, set only by bridge code on a `ui` origin as the system principal
  (`ownerConfirmedOrigin` in `src/admin/routes/util.ts`); on any other origin the engine refuses it (`POLICY_DENIED`).
  The restore routes require `confirm: true` unless the call is a dry run.
- **Kept as proposals:** a `propose`-scope connection's writes; an automation code at Propose; and, **chosen**, three
  narrow cases listed under [Deferred](#deferred).
- `bridge_proposal_status` and `bridge_proposals_mine` stay; their descriptions say a proposal comes from a
  `propose`-scope connection or the owner's automation.

## D2: Review is the safety net

- **Coverage, enforced by test** (`test/review/f12-coverage.test.ts`): every write operation of the registry is in
  exactly one of two tables in `src/review/write-kinds.ts`: `REVERT_PATHS` (how Revert undoes it, in words) or
  `AGENT_REFUSED` (refused for agents, with why: member administration, which the owner does in the LegendKeeper app).
  A new LegendKeeper operation fails the test until it is classified, so nothing is ever written directly with no way
  back. The policy gate refuses every `AGENT_REFUSED` operation for an agent at scope `write`.
- **The generic undo** (`src/review/entity-undo.ts`): Revert gains an `entity` target, a table of entity kinds (read,
  create, update, delete, restore) for the writes the specialised targets did not cover (map features, timeline events
  and lanes, properties, board shapes, documents, assets), with follow-ups for what a job cannot do inside its lock
  (`recreate_pages`, `restore_document`, `reupload_asset`, run after the revert job succeeds and recorded in
  `job_reverts.targets.followUpsDone`). Pre-images are now kept for `updateBlock`, `updateBlockRow`,
  `updateBlockPropertyRow`, `updatePropertyRow` and `updateBoardShapes`.
- **Card fixes:** a created page's sidebar rows collapse into one line; Revert is hidden when there is nothing to
  revert (`revertible: false`; a write on a page the same job created says which change covers it, `coveredBy`); Revert
  of a create deletes the Working pages it made that nobody has touched since.
- **Grouping:** the Review page groups items by workstream and connection (Claude or ChatGPT, from the connection's
  client), with "Mark reviewed (n)" for the whole group.
- **Revert of canon and lifecycle:** the revert job is the owner's confirmed action, and carries a lifecycle marker built
  from the original job's marker and the names before (`lifecycleBack`), so the lifecycle guard accepts the way back.

## D3: recoverable deletes

- **A copy before every agent delete** (`src/snapshots/delete-copy.ts`, the `DeleteCopier` hook in
  `src/jobs/step-exec.ts`): before `deleteResource` or `deleteDocument` runs for an agent's job (or a Revert's), the page
  and, for a cascade, its whole subtree (listed breadth-first, at most `DELETE_COPY_MAX_PAGES` = 1,000) are captured into
  a change snapshot at P1 (`SnapshotService.captureNodes`), recorded in `delete_copies` with the journal step. If the
  copy cannot be taken, the delete is refused with the reason (`DELETE_COPY_FAILED`); nothing is deleted uncopied.
- **What it costs (P1, in the job's name):** every page is read live (**chosen** over trusting the last snapshot, which
  may be a day old; the last snapshot still holds the pages as a second copy): per page one `getResource`, its sidebar
  (`listProperties`) and one read per document; a cascade adds one `listResources` per page with children; a document's
  delete reads only the page and that document. On the mock a page with one child took 5 reads, and one map's delete
  went from 4 to 7 reads; the sandbox reports what it measured (`delete_copies.reads`).
- **Revert of a page delete:** LegendKeeper's own restore first (`restoreResource`, which brings the subtree back with
  its ids); if LegendKeeper no longer holds it, the pages are made again from the copy, parents first, by the snapshot
  restore's `recreate`. The result says the ids changed, maps each old id to its new one, and lists the pages that linked
  to the old ids (the link index) for the owner to relink.
- **Revert of an asset delete:** the bytes kept before the delete (the image store's kept references) are uploaded again
  as a new asset in the same folder under the same name (the image restore's own path, given the name and folder it had;
  a folder the asset tree has not read yet is read live once). Pages that showed the old URL and have not changed since
  are relinked; the rest are listed.
- **Retention:** `DELETE_COPY_RETENTION_DAYS` (default 90, 1 to 3,650): the snapshot pruner keeps a delete's copy that
  long, then forgets it.

## D4: guidance

- The MCP instructions' rule 3 is now: "Write directly at your connection's scope. Canon and lifecycle changes
  (promote_page, archive_page, CANON, deleting pages) are direct too, and every change is on the owner's Review page with
  Revert: make them only when the owner has asked for them in this conversation, and say what you changed."
- One line for scope `propose`: every write becomes a proposal; follow it with `bridge_proposal_status` and never
  resubmit.
- Every "always a proposal" sentence is gone from the tool descriptions and `docs/bridge-guide.md`; "How to decide"
  stays within its cap (the guides test).
- The governance pages are not changed by the bridge. The passages for the owner's reviewer are listed in
  [Governance passages](#governance-passages-for-the-reviewer).

## D5: the step-up only for credentials

- Sign-in is unchanged. The fresh code (`requireReauth`, 403 `REAUTH_REQUIRED`) is asked only for: the password change;
  authenticator set-up, reset and removal; viewing or regenerating recovery codes; connections (creating a profile,
  changing a profile's or the default scope in either direction, moving, revoking or removing a connection), MCP tokens
  (OAuth clients have no admin routes; MCP tokens are the PATs); adding, checking, replacing or removing a project's API
  key; the off-site credentials (client, connect, disconnect, keys). The consent page's step-up is unchanged.
- Everything else stopped asking: approvals, resumes and retries, Revert, budgets, settings, maintenance, project
  settings, packs, tagging, automation and the owner's decision pages. CSRF, Origin and the session check are unchanged.
- **`AUTH_STEP_UP_WINDOW_SECONDS`**, default 43,200 (12 hours), 300 to 604,800, replaces the hard-coded
  `REAUTH_WINDOW_SECONDS`; the dialog and the Account page say "within the last 12 hours" from the setting.
- **Route inventory** (`test/auth/stepup-routes.ts`, `test/auth/stepup-inventory.test.ts`): every `requireReauth` call
  in `src` is found statically and mapped to its route; the set must equal the named list, and each listed route answers
  403 to a session that has not stepped up.
- **Chosen:** creating a profile asks whether or not a scope is given; lowering a scope asks; removing a project asks
  (it deletes the stored key); "Make default", the low-level-tools switch and the clean-up day settings do not ask.

## Settings

- **Removed:** the per-profile rails (stored in `agent_profiles.write_rails`, set on the Clients page; never an
  environment setting) and the pack's `alwaysPropose` and `tools` (pack data, dropped by the seed upgrade);
  `REAUTH_WINDOW_SECONDS` (a constant, not a setting) replaced by the setting below.
- **Added** (`src/config/registry.ts`, `.env.example`, `deploy/env.template`, docs): `DELETE_COPY_RETENTION_DAYS`
  (90) and `AUTH_STEP_UP_WINDOW_SECONDS` (43,200).

## Governance passages for the reviewer

The bridge does not edit governance. These passages describe the old flow; the suggested wording is for the owner's
reviewer, who changes the pages and then re-approves the pack (the pack's pinned sections are read at each check, so an
edit there is drift until it is approved).

1. **Controlled Native Tagging Standard, "Bridge and Audit Interface"** (pinned via ADR 0060): "Its intended workflows
   are dry-run preview, read-only policy audit, separately approved guarded apply, and resumable reconciliation…".
   Suggested: "Its intended workflows are dry-run preview, read-only policy audit, guarded apply (a direct write at the
   connection's scope, shown on the owner's Review page with Revert, or a proposal from a `propose`-scope connection or
   the owner's automation at Propose), and resumable reconciliation…".
2. **Source Formatting, the lifecycle text** (where it says promotion, archiving or a change of Continuity Type is a
   proposal the owner accepts). Suggested: "Promotion, archiving and Continuity Type changes are made only when the
   owner asks for them; a Bridge connection at write scope makes them directly and each is on the owner's Review page
   with Revert; at propose scope they are proposals."
3. **Repository Automation, "Default Boundary"** ("A separately approved narrow automation action must identify exact
   scope…"): unchanged in effect (automation is still switched on code by code). If it says an agent's write is a
   proposal, suggested: "An agent's write at write scope is direct and reviewable; automation remains separately
   approved, code by code."
4. **Anything quoting "always a proposal"** for canon, lifecycle or deletes (the reviewer's search on the governance
   root): replace with "made only when the owner asks; on the Review page with Revert".

## Deferred

- **A chronology change that only adds a link** (`timelines.ts`) stays a proposal at every scope (`forceProposal`): the
  sync's own check decides it, and its Revert path is not yet built.
- **A document LegendKeeper has purged** is not recreated by Revert: the result names the copy's snapshot for a restore
  from the Snapshots page.
- **The lifecycle record** (the bridge's own lifecycle history) is not reset by Revert; the page is.
- **The CLI's `migrate-staging`** keeps making a proposal (the owner's own tool, run by hand).
- **Re-proposing a proposal's left-out items** keeps its proposal (it is the owner's proposal page).
- **A dry run of a protected change** still answers `requiresCanonicalApproval: true` at both scopes (the dry run does
  not know the caller's scope); its message says what each scope does: direct at `write`, a canonical proposal at
  `propose`.

## Tests

- Unit: the gate and guards (direct, refused, a propose verdict on a direct request denied), automation Propose and
  Apply, the pack upgrade (`test/packs/f12-packs.test.ts`), delete copies with the refusal, Revert coverage, the route
  inventory and the window setting.
- Contract (`test/review/f12-direct.test.ts`, at scope `write` through the MCP transport and Revert): promote then
  revert; CANON off then revert; a page with two children deleted then reverted (copy of all three, all three back); an
  asset deleted then reverted (a new asset in the same folder under the same name, the page relinked); the owner's
  restore as one confirmed action; `ownerConfirmed` refused off the dashboard.
- Sandbox `f12-direct` (`test/sandbox/f12-direct.ts`, D0 to D5, `ensureSandboxGovernance`, a `propose`-scope principal
  kept for the proposal path) and its mock dry run (`test/sandbox-mock/f12-direct.test.ts`). The `write-scope` sandbox
  check now expects direct writes and checks the delete's copy.
