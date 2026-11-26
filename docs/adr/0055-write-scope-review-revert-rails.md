# ADR 0055: Write scope: after-the-fact review, revert and safety rails

- Status: **Proposed** (v3 F3.4, 17 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper and fixtures. The owner's decisions are quoted from the F3.4 brief; the choices this session made where
  the brief left room are marked **chosen**.
- Amends: [ADR 0046](0046-e4-owner-decisions.md) decision 1 (the block-by-block undo, generalised into Revert);
  [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) (every package a proposal whatever the scope: now a
  per-tool switch in the pack's data); [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md)
  decision 1, "How it is measured" (a direct `updateBlock` is read first when the rule needs a "before"). Revert keeps
  ADR 0051 decision 3's "nothing is ever written to `LK-Bridge staging`" (decision B5, the owner's ruling of 17
  November 2026).
- Migration: `3200_write_scope.sql` (the profiles' rails, the rail a proposal names, the Review queue, the reverts).
- **Amended by [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md)** (CR-2026-11-R2, 17 November 2026): the deletes and
  bulk rails widened (C1), Revert's comparisons, order and confirmation (B), the summary of a low-level job (A2) and the
  stricter switch (D1); see [the review](../reviews/CR-2026-11-R2.md).
- Numbered 0055: F3c (appraisal), running at the same time, takes 0054.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script. The new rehearsal script was run only as a dry run against the mock.

## Context

The owner moves the agents (Claude and ChatGPT) from scope `propose` to scope `write`. At `propose` the owner sees every
change before it happens. At `write` ordinary changes go straight through, so the bridge must make them easy to review
afterwards and to undo cleanly. Canon and lifecycle changes stay proposals whatever the scope (the canon guard and the
lifecycle guard, unchanged).

## Decision A: a Review queue for direct writes

1. **What is recorded** (`src/review/service.ts`, table `direct_writes`). When a job is created whose principal is an
   agent (not `system`), that was not approved by the owner, and that writes, it is recorded with its agent, profile and
   tool. It is **listed** once it has finished and its journal shows something applied (or possibly applied): a job that
   wrote nothing is not listed. Approved proposals (the owner saw them first), pack packages (proposals by default, D)
   and the bridge's own work are never recorded. **Chosen:** event-driven rows rather than a query of the jobs table by
   time, so "unreviewed" is exact and cheap to count.
2. **The page** ("Review", in `TOP_NAV` beside Overview, Jobs and Proposals) lists the items newest first, with the
   agent, the tool, a summary in the words a proposal would have used (the tool's own summary, else the job's title)
   and the pages touched. Each expands to the same diff a proposal shows, built from the journal's pre-images and the
   job's own record: page text as a Markdown diff, facts before and after, links added and removed, names, tags and
   aliases, moves, chronology rows and events, image placements; and, for each thing Revert cannot put back, why.
   Filters: unreviewed, reviewed or all; profile; tool.
3. **Actions.** Mark reviewed (audited `review.mark`); **Mark all reviewed** for the filtered set, after a confirmation
   naming the count: the request carries that count and is refused with `REVIEW_CHANGED` (409) when the set changed in
   the meantime (audited `review.mark_all`; at most 1,000 at a time); Revert (B). A reverted job is marked reviewed
   (`via: revert`).
4. **The badge** beside Review counts the unreviewed items of the projects in view, as the Proposals badge counts
   pending proposals; the Overview page shows the same count as a tile.
5. Admin API: `GET /api/admin/review` (`state`, `profile`, `tool`, `before`, `limit`), `GET /review/counts`,
   `GET /review/:jobId`, `POST /review/mark`, `POST /review/mark-all`.

## Decision B: Revert a job (owner-initiated, from the journal)

1. **Where.** Revert is on every finished direct-write job, on the Review page and the Jobs page. A preview
   (`GET /api/admin/jobs/:id/revert`) lists each target with its state; the revert itself
   (`POST /api/admin/jobs/:id/revert`, `{ confirm: true, confirmPartial? }`) needs the owner's re-authentication and is
   audited `job.revert` with the job, the targets and the outcome: refused (with the code), submitted, and then
   succeeded, failed or cancelled when the revert job ends.
2. **Supported**, each read live and compared with the state the job left, by content:
   - **page text**, block by block: the undo's planner (`planBlockwise` with `undoOf`) and its "is the page exactly as
     the job left it" check (`BLOCKWISE_CHECK`), inside the lock; a page whose blocks the job moved is written back whole
     (the undo's own fallback), checked first;
   - **sidebar facts and link collections**: planned with `set_facts`' planner from the live sidebar (values back,
     rows the job added removed, rows it removed added again, links back);
   - **chronology rows and their timeline events, kept in step** as the chronology tools keep them (one chronology record,
     tool `job_revert`): a row and event the job added are deleted and the age's count put back; a changed row and event
     get their old values (a row moved by a date edit goes back to its place); an event the job re-made (a date edit
     that removed an end) is made again with its old fields;
   - **resource name, tags, aliases** (and icon, lock, full width) in one `updateResource`, and a **move**: back to the
     old parent, placed by its old neighbours;
   - **image placement**: B5.
3. **Never reverted:** a deletion (`DELETION`: Revert says so and points to `restore_resource`, or the journal's
   pre-images); anything the canon guard handled (it was a proposal: `WAS_A_PROPOSAL`); a job still running
   (`JOB_RUNNING`); a revert (`IS_A_REVERT`); a job already reverted or being reverted. **Chosen:** Revert never deletes
   what a job made (a page, a document, a folder, a lane, a feature, an image uploaded straight into its folder): it
   lists it as not revertible ("delete it yourself if it should go"). The one exception is the chronology, where a row
   and event the job added are removed together because the chronology tools keep them in step and the record shows
   they are exactly the job's. A placed staged image is not deleted by Revert either: its deletion is a proposal (B5).
   Map features, document fields, lanes, board shapes and raw sidebar-row or block-row writes are not among the kinds
   Revert puts back: listed as not revertible, with the journal as the way further.
4. **Only when nothing has changed since.** A target that differs from what the job left is not reverted; the result
   lists it with what changed. An outside edit is never overwritten: each target is checked again inside the revert
   job's lock before it is written (registered checks `review.revert` and `review.revert.blocks`). **The default is all
   or nothing:** when any target cannot be reverted the revert is refused (`PARTIAL_REVERT_NEEDS_CONFIRMATION`) unless
   the owner confirms a partial revert; with nothing left to write it is `NOTHING_TO_REVERT`.
5. **Image placements: back on the Staging page, the deletion proposed** (the owner's ruling, 17 November 2026,
   replacing this session's first design). Nothing is ever written to LegendKeeper's staging folder (`LK-Bridge
staging`), and the revert itself never deletes an asset. For the placement of a staged image (one placed from the
   bridge's server staging, an upload into its folder; or one staged the old way in LegendKeeper's staging folder, a
   move out of it):
   - **Before the job**, the placed asset's file is copied back into the bridge's server staging (F2's
     `images/staged/`): one download from the asset host, no API request. It must be the very file that was staged (the
     staged record's WebP SHA-256), so placing it again uploads exactly it. A file that cannot be downloaded or is not
     that file refuses the revert (`IMAGE_NOT_SAVED`) before anything is written; the copy of a revert that does not go
     ahead is removed.
   - **The revert job** only checks, inside its lock, that the asset is still as the placement left it (folder, name,
     not hidden). The page's blocks that show the image, when the same job wrote them, are reverted with the page's text
     as any text is.
   - **Once the job has succeeded**, the staged record goes back on the Staging page (staged on the server again, no
     asset), to place again or discard, and deleting the placed asset is **ONE proposal** for the owner, by the bridge
     (`deleteAsset`; approved, it keeps the asset's bytes first, as every asset delete does). Recorded with the revert
     (the proposal's id) and audited (`job.revert`, outcome `images`). An asset moved, renamed or hidden since the
     placement is not touched (`changed`).
   - An ordinary asset move (not a placement) goes back to its old folder, name and hidden flag (its pre-image, now
     journalled: F); one out of the staging folder that no staged record explains is not revertible, since Revert
     never writes there. An image uploaded straight into its folder is a creation (B3). The folders a placement made
     stay.
6. **One job**, run by the system principal at P1, internal: If-Match chained from its own reads, every lock held for
   the whole run (pages, documents and assets), verified, journalled like any write. Its result points to the journal
   (`bridge_journal_lookup`) and the snapshots if the owner needs to go further.
7. **Last Major Revision.** The revert job leaves the engine's own rule out (`lastMajorRevision: 'skip'`), then restores
   the page's previous value **if the job changed it** (the value the job's `bridge.lmr` decision replaced, now recorded
   as `previous`), and only while the row is still what the job wrote; otherwise it leaves it alone.

## Decision C: safety rails per agent profile

1. **The switches**, per profile at scope `write`, on Clients & Access ("Always propose"):

   | Rail                                       | Default    | Counts                                                                                                                 |
   | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
   | Deletes                                    | on         | pages, documents, timeline events and lanes, map features, assets, calendars, sidebar properties, board shapes         |
   | Bulk changes, more than N pages in one job | on, N = 10 | each page written, each page made (`createManyResources` item by item), a cascade's page and every page under it       |
   | Renames and moves of pages                 | off        | a page's name changed, a page moved (`moveResource`, or `updateResource` with a parent); not a page the same job makes |
   | Asset deletes and asset moves              | on         | `deleteAsset`; `updateAsset` to another folder; not the placement of a staged image                                    |

2. **What a rail does.** A request that would run directly is captured as an ordinary proposal instead, which says which
   rail sent it: `proposed because: bulk change (14 pages > 10)` (stored on the proposal, shown on the Proposals page,
   returned to the agent as `proposedBecause` with a hint not to retry or route round it). A rail **only adds a
   proposal**: it is asked only about a request that would otherwise run (never one already proposed by scope, the
   canon guard, the lifecycle guard or a pack switch), never about approved work or the bridge's own, and a rail that
   cannot be judged fails closed (a cascade whose pages are not known counts as more than any N). Canon and lifecycle
   changes remain proposals regardless, exactly as before.
3. **Where.** In the job engine at entry (`authorize`), after the canon and lifecycle guards; the gate reads the
   profile's rails live with its scope. **Chosen:** at entry only; a queued job is not asked again (its scope still is).
4. **Two exemptions, chosen so the rails do not surprise** (F): a chronology change that re-makes an event (the old one
   deleted and a new one made in the same job, as a date edit that removes an end does) is not a delete; the placement
   of a staged image (marked by bridge code, never by an agent) is not an asset move.
5. **Settings.** Ordinary per-profile settings: `PUT /api/admin/clients/profiles/:id/rails` with `{ rails, confirm: true }`,
   re-authenticated, audited `profile.set_rails` with the rails before and after. N is a whole number from 1 to 1,000.

## Decision D: pack tools at write scope

1. **A per-tool switch in the pack's data** (`settings.tools`: tool → `propose` or `scope`), shown on the Packs page:
   `arkona_create_character`, `arkona_create_owner` and `arkona_create_relationship` default to **always propose** (a
   package makes several pages at once); `arkona_add_character_art` to **follow the agent's scope**; the appraisal tools
   (F3c) never write and have no switch; `arkona_appraisal_fix` **follows the scope** in the seed. A tool with no switch
   keeps F3a's rule (`alwaysPropose`).
   `arkona_appraisal_fix` (F3c, wired at the merge) reads its switch from the version the owner **approved**
   (`Packs.toolMode`; "always propose" while none is), because it does not refuse a pack waiting for approval as the
   package tools do: following the scope, its own fix runs at scope `write` as one job (reviewed afterwards) and is a
   proposal at `propose`; the audits' fixes it hands over (sibling order, tags) and the Appraisal page's **Propose a
   fix** stay proposals.
2. **Changing a switch makes a new pack version**, approved as usual (`PUT /api/admin/packs/:id/tools`, re-authenticated,
   audited `pack.set_tool_modes`; the tools refuse with `PACK_NOT_CURRENT` until the owner approves it).
3. **The seed** is `arkona-2026-11-17-f3-4`, named after the session (F3.3's was mislabelled `arkona-2026-11-17-f3d`,
   which it supersedes): offered at start as a new version waiting for the owner's approval.

## Decision E: a direct `updateBlock` measured for Last Major Revision

At scope `write`, an `updateBlock` that carries its own If-Match made no read, so ADR 0051's rule had no "before" and
counted it a major revision. The engine now reads the block first (one read, `readBefore`) **only** when the rule needs
it: the page has a Last Major Revision row and the mode is `auto` (a `measure` step naming that write). The read also
becomes the write's journal pre-image. A typo fix at scope `write` is now measured as minor (tested).

## Decision F: everything else at write scope (the audit)

Every write tool, between `propose` and `write`. "Proposal" means the owner sees it first; at `propose` every write is
one. Checked across the table: `operation_id` gives the same answer at both scopes, a rail's proposal included (a repeat
returns the same proposal); direct jobs run at P1 under the project's governor and budgets exactly as an approved
proposal's job does (the proposal's own priority); Last Major Revision, the run-time re-checks (find-or-create folders,
`CHARACTER_EXISTS`) and the verify steps are steps of the job itself, so they apply identically. The one difference
kept: a direct job is asked again by the gate before each step (a revoked connection or a lowered scope stops it), an
approved one is not (the owner's approval wins), as since chunk 8.

| Tool                                                                           | At scope `write`                                                      | Still a proposal when …                                                                                                                          | Revert                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `write_page`                                                                   | runs (block by block; Last Major Revision measured)                   | never (page text is not canon-gated, ADR 0036 decision 6)                                                                                        | yes, block by block; Last Major Revision restored                 |
| `set_facts`                                                                    | runs                                                                  | canon: Status to or from Authoritative, an existing Continuity Type or Continuity changed (Status lifecycle changes are refused: the four tools) | yes: facts and links; Last Major Revision restored                |
| `create_index`, `create_resource`, `create_bare_resource`, `create_character`  | runs (Working pages)                                                  | an Authoritative page asked for (canon); more than N pages (bulk rail)                                                                           | the pages made: no (never deletes)                                |
| `create_many_resources`                                                        | runs                                                                  | more than N pages (bulk rail, 10); an Authoritative page (canon)                                                                                 | no (pages made)                                                   |
| `update_resource`                                                              | runs                                                                  | a rename or a move, when the renames-and-moves rail is on (off by default); status tags and prefixes are refused (lifecycle)                     | yes: name, tags, aliases, icon, lock, width; a move               |
| `move_resource`                                                                | runs                                                                  | the renames-and-moves rail on (off by default); into or out of Working or Archived is refused (lifecycle tools)                                  | yes: back to the old parent and place                             |
| `delete_resource`                                                              | **a proposal** (deletes rail, on)                                     | always under the default rails; an Authoritative or Archived page: canonical                                                                     | never (`restore_resource`)                                        |
| `restore_resource`                                                             | runs                                                                  | never                                                                                                                                            | no (it would be a delete)                                         |
| `create_document`                                                              | runs                                                                  | never                                                                                                                                            | no (made)                                                         |
| `update_document`                                                              | runs                                                                  | never                                                                                                                                            | no (document fields are not a Revert kind)                        |
| `delete_document`                                                              | **a proposal** (deletes rail)                                         | always under the default rails; an Authoritative page's map, timeline or board: canonical                                                        | never                                                             |
| `create_map_feature`, `update_map_feature`                                     | runs                                                                  | never                                                                                                                                            | no (not a Revert kind)                                            |
| `delete_map_feature`                                                           | **a proposal** (deletes rail)                                         | always under the default rails                                                                                                                   | never                                                             |
| `create_timeline_event`, `update_timeline_event`, `sync_timeline_event`        | runs (row, event and count in one job)                                | never; a re-made event is not a delete (C4)                                                                                                      | yes, in step                                                      |
| `delete_timeline_event`                                                        | **a proposal** (deletes rail)                                         | always under the default rails                                                                                                                   | never                                                             |
| `create_timeline_lane`                                                         | runs                                                                  | never                                                                                                                                            | no (made)                                                         |
| `archive_page`, `unarchive_page`, `move_to_working`, `promote_page`            | **a canonical proposal**                                              | always (the lifecycle guard's marker)                                                                                                            | not applicable                                                    |
| `upload_image`                                                                 | staging: nothing in LegendKeeper (the bridge's server); placing: runs | never; a placement is not an asset move (C4, fixed here)                                                                                         | a placement: back on the Staging page, its deletion proposed (B5) |
| `lk_upload_image`                                                              | runs (an upload)                                                      | never                                                                                                                                            | no (an asset made)                                                |
| `prepare_image_upload`                                                         | nothing in LegendKeeper                                               | never                                                                                                                                            | not applicable                                                    |
| `lk_api_write`, `lk_api_batch`                                                 | runs                                                                  | every rail, operation by operation; canon and lifecycle as for the tools                                                                         | where the record allows; raw row writes and block deletes no      |
| `restore_snapshot`                                                             | **a proposal**                                                        | always                                                                                                                                           | not applicable                                                    |
| `arkona_create_character`, `arkona_create_owner`, `arkona_create_relationship` | **a proposal** (switch: always propose)                               | by default; switched to follow the scope: canon as for the tools, and the bulk rail                                                              | (switched) the pages made: no                                     |
| `arkona_add_character_art`                                                     | runs (switch: follow the scope)                                       | canon as for the tools; the rails                                                                                                                | its image placement: yes; pages made: no                          |
| `bridge_job_cancel`                                                            | cancels the agent's own job                                           | never                                                                                                                                            | not applicable                                                    |

**What the audit fixed:**

1. `updateAsset` keeps a pre-image in the journal (one read before each; a rare write), so a revert can put an asset
   back where it was.
2. The Last Major Revision decision records the value it replaced (`previous`), so a revert restores it (B7).
3. A direct `updateBlock` is read first when the rule needs it (E).
4. A chronology date edit that removes an end re-makes the event (delete, then create): the deletes rail would have
   proposed it and Revert would have refused it as a deletion. The rail now treats the pair as one change, and Revert
   re-makes the old event (C4, B2).
5. Placing an image staged the old way, in the project's staging folder in LegendKeeper, moves the asset: the asset
   rail would have proposed every such placement. It is now marked as a placement by bridge code and not counted (C4).

## Decision G: a write-scope rehearsal (written, not run)

`npm run rehearse:write-scope -- --project test`; on the server
`sudo -u lkbridge /opt/lk-bridge/app/deploy/rehearse-write-scope.sh --project test` (test/sandbox/write-scope.ts). It
refuses any project not registered as a sandbox in the bridge's database, and any key whose own project is not that
one. It runs the bridge's code on a temporary database that starts as a **read-only copy** of the project's settings,
repository tree and packs from the bridge's database (no tree build; nothing written to the bridge's database), with a
temporary write-scoped agent (default rails) and a helper (rails off) that only makes and removes the throwaway
chronology event. Steps: an edited sentence, a changed fact, a chronology fix, a placed staged image (each direct); a
pack package still a proposal; the four on the Review queue; each reverted and read back (the image back on the Staging
page, the placed asset's deletion proposed, which the script approves as the owner would); a delete and an 11-page
batch proposed by the default rails; clean-up. PASS, FAIL, NOTED, INCONCLUSIVE or SKIPPED for each step; exit 0, 1 or 2.

**Chosen:** a wrapper of its own (`deploy/rehearse-write-scope.sh`, the soak's form) rather than
`sandbox-test.sh -- write-scope`: the rehearsal is an npm script, as the soak is, not a vitest file. **Step 5 checks the
decision, not a real package:** a package's tags need the pack's governance sources, which live in the Arkona project,
and the rehearsal never reads another project. It checks the approved version's switches and sends a package-shaped
job down the same path a package takes (`forceProposal` from the switch), which must be captured as a proposal (then
rejected). A dry run against the mock passes every step and leaves nothing behind (test/review/rehearsal-dryrun.test.ts).

## Consequences

- The owner reviews direct writes on the Review page and undoes one with Revert; the rails keep deletes, bulk changes
  and asset changes as proposals until the owner switches them off per profile.
- A rail's proposal looks like any proposal, plus its reason. Agents are told not to retry it or route round it (the
  bridge guide's "At write scope" section).
- One more read per `updateAsset`, and per direct `updateBlock` on a page with a Last Major Revision row in `auto`.
- In the tests, the test stack's default profile (`tools-test`) has its rails off, so the earlier tests keep testing the
  direct writes they were written for; every profile a test makes with `newToken` keeps the defaults.
- Reverting an image placement leaves the placed asset where it is until the owner approves the proposal to delete it;
  meanwhile the image is also back on the Staging page (rejecting the proposal keeps both).
- F3c's test worlds switch `arkona_appraisal_fix` to "always propose" by default (as `arkona_add_character_art`), so
  its earlier tests keep testing the proposal path; the "follow the scope" path has tests of its own.

## Amendment: F12 (26 November 2026)

[ADR 0081](0081-v3-f12-direct-writes-review-safety-net.md) withdraws decision C (the safety rails: removed with their
stored settings, the Clients page's card and their tests) and decision D (the pack's per-tool "always propose":
removed; a pack tool follows its connection's scope). Decisions A and B are extended: every write kind an agent can
cause has a Revert path or is refused for agents (a test keeps it so), Revert gains a generic `entity` target with
follow-ups, deletes are copied first and restored by Revert, and the Review page groups by workstream and connection.
Canon and lifecycle changes at scope `write` are direct.
