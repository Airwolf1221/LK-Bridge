# ADR 0057: Owner decisions from the second review (CR-2026-11-R2)

Status: **Accepted** (the owner, 17 November 2026: every decision as recommended; built the same day, see "As built"
below). Proposed by CR-2026-11-R2 (numbered 0057 because F3.5's block-id sweep took 0056 while the review ran). The
findings are in [docs/reviews/CR-2026-11-R2.md](../reviews/CR-2026-11-R2.md).

Amended by [ADR 0062](0062-dashboard-sessions-and-step-up.md) (accepted, 19 November 2026): decision 1's
re-authentication is now the step-up (the authenticator code within 10 minutes, or the password without one); a raise
still asks and a lowering is still one click (the owner's rule: tightening is one click, loosening asks), and every new
personal access token asks, at any scope. Decision 7 stands: switching ChatGPT's file source off is one click. And by
[ADR 0061](0061-cr-2026-11-r3-decisions.md) part B decision 1 (accepted, 19 November 2026): decision 4's deletes rail
also counts text taken off a pack page through a low-level tool (the split guard's words or more) as a removal.

- Amends (the findings' fixes, each in the review): [ADR 0036](0036-cr-2026-11-owner-decisions.md) decision 3 (a
  lifecycle index name is refused whatever the lifecycle marker) and decision 7 (a template copy takes its template's
  tags, so they are judged); [ADR 0048](0048-chronology-ii.md) decision 7 (the orphan delete lists rows whose date cannot
  be read) and F2.1 (a chosen link is a proposal at every scope); [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md)
  (the approved version's rules only; the fixes check inside their jobs); [ADR 0055](0055-write-scope-review-revert-rails.md)
  decisions A2 (a low-level job's summary), B (Revert compares in full, checks first, one at a time, the confirmed set),
  C1 (the deletes and bulk rails widened) and D1 (the stricter switch); [ADR 0041](0041-image-pipeline.md) and [ADR
  0049](0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 9 (canonical folder names) and the server
  staging (one placement at a time, a rate per connection, files kept while needed).

## Context

The owner moved Claude and ChatGPT to scope `write` on Arkona on 17 November 2026. The second independent review
checked everything merged since the first one (`08feec9`, 11 November) with that in mind. Most fixes only make an
existing rule hold on every route and need no decision. These go one step further than a rule as written, or leave a
choice that belongs to the owner.

## The owner's decisions (17 November 2026)

| #   | Decision                                                                                            | Option chosen             |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Raising scope (and every change that lets a connection do more) needs re-authentication             | (a), as implemented: kept |
| 2   | A row whose date cannot be read, beside an orphan event, blocks that event's delete                 | (b), the stricter option  |
| 3   | An agent's chosen chronology link is a proposal at every scope                                      | as implemented: kept      |
| 4   | Removals through the low-level tools go through the deletes rail now; Revert support later          | (b) now, (c) later        |
| 5   | Renaming an Authoritative page, even keeping `[BSRC]`, is a canonical proposal                      | (b), renames              |
| 6   | The rails are judged when a request arrives; lowering the scope is the emergency brake              | (a), documented           |
| 7   | ChatGPT's file source gets its own switch, `fileSourceEnabled`, on by default                       | (b)                       |
| 8   | An art folder is resolved only from the character's exact path under Characters, never by name      | stricter than (b)         |
| 9   | A restore counts every page it will bring back towards the bulk rail; an unknown set counts as over | (a)                       |

## Decisions as proposed to the owner

1. **Re-authentication for every change that lets an agent's connection do more (implemented, R2-50; accepted).** ADR 0055
   decision C5 asks for the owner's re-authentication before a safety rail is switched off, because "a rail switched off
   lets more go straight through"; raising a profile from `propose` to `write` needed only the session. Implemented, as
   ADR 0028 decision 7 (within the last 5 minutes): raising a profile's scope, raising the default scope, moving a
   connection to a profile with a higher scope or to one at scope `write` (its rails may be weaker), and a personal
   access token for a profile at scope `write`. Lowering a scope, moving a connection down and a token for a lower scope
   stay one click (they are how the owner stops an agent quickly). Alternatives: (a) as implemented; (b) only the scope
   raises, not connection moves or tokens; (c) every change on Clients & Access, lowering included (not recommended: it
   slows the owner down exactly when stopping an agent).
2. **An event "without a row" beside a row whose date cannot be read (R2-49; accepted: option (b), built).** ADR 0048
   decision 7 refuses to delete an event an unpaired row could own: the same date, the same start, or its name. A row
   whose Date cell cannot be read has no date, so only its name can match, and the timeline's short name differs from
   the table's description by design: the event the owner made for such a row, under a short name, is offered for
   deletion. Implemented: the proposal and the tool's dry run list every unpaired row of the age whose date cannot be
   read, with a note to check them first or mark them table-only (no change to what is deleted). Options: (a) as
   implemented (the owner judges, with the rows in front of them); (b) refuse the delete (`PAIRING_AMBIGUOUS`) while any
   unpaired row of the age with an unreadable date is not marked table-only: the safest, at the price of marking such
   rows table-only once before any orphan of that age can go; (c) as (b), but only rows whose KCY cell reads as the
   event's year block it. Recommended: (b) or (c).
3. **A chronology link an agent chooses is a proposal at every scope (implemented, R2-08; accepted).** `sync_timeline_event` with
   `event_id` on an event that already agrees records "this row is that event" (ADR 0048 F2.1): no LegendKeeper write,
   but it decides what the check pairs, repairs and offers to delete from then on. At scope `propose` it was a proposal
   for that reason; at scope `write` it ran directly, and its job holds only the bridge's own steps, which the Review page
   (ADR 0055 decision A) never lists, so the owner never saw it and Revert could not offer to undo it. Implemented: a link
   is a proposal at every scope (the dashboard's "Pair with this row" already was). Alternative: (b) direct at scope
   `write` but listed on the Review page (a row in `direct_writes` for a job that recorded a link, its diff naming the
   row and the event), with Revert removing the link.
4. **Removals through the low-level tools are neither proposed nor revertible (R2-52; accepted: (b) built, (c) open).** ADR 0055 decision C1
   counts a block delete, a row delete and a collection's items as edits, not deletes, and its table lists raw row writes
   and block deletes as not revertible. Together: an agent at scope `write` can delete a whole chronology table (one
   `deleteBlock`) or empty a curated link collection (`updateProperty` with `items: []`) directly, and Revert can only
   say so; the journal keeps the pre-images to put back by hand. The high-level tools are unaffected (`write_page`,
   `set_facts` and the chronology tools are revertible). Options: (a) as now; (b) a rail "removals through the low-level
   tools" (on by default): a `deleteBlock`, `deletePropertyRow`, `deleteBlockRow` or `deleteBlockPropertyRow`, or an
   `updateProperty` that drops items, sent through `lk_api_write`, `lk_api_batch` or `lk_op_*`, becomes a proposal;
   (c) Revert puts them back from the journal (block deletes by their pre-image and the neighbour they followed;
   collection items by id). Recommended: (b) now, (c) later.
5. **Renaming an Authoritative page that keeps its `[BSRC]` prefix ran directly (accepted: (b) for renames, built).** ADR 0055's table lets
   `update_resource` rename any page at scope `write` (the renames-and-moves rail is off by default), and Revert puts a
   name back. Removing the `[BSRC]` prefix is now a canonical proposal (R2-12); a rename that keeps it (`[BSRC] Old
Harbour` to `[BSRC] Old Port`) is still direct. The review's brief counted "renaming canon" as something that should
   need a proposal. Options: (a) as now; (b) any rename or move of an Authoritative page is a canonical proposal; (c)
   switch the renames-and-moves rail on by default for every profile. Recommended: (b).
6. **The rails are asked at entry only (ADR 0055 decision C3; accepted: (a), documented).** Switching a rail on does not stop a direct
   job already queued (WS-G3); lowering the profile's scope does (the job is asked again before each step). Options: (a)
   as now, with the dashboard saying that lowering the scope is the emergency brake; (b) ask the rails again before a
   queued direct job's first write, and stop it (the agent then proposes it). Recommended: (a).
7. **`file.download_url` is fetched when URL sources are switched off (R2-45; accepted: (b), built).** ADR 0049 decision 11 keeps
   ChatGPT's file path (`file` with a `download_url`) working whatever `UPLOAD_ALLOW_URL_SOURCE` says, but `.env.example`
   promises "no fetching of image URLs" and `docs/tools.md` "base64 only"; any connection can make the bridge GET any
   public https URL on port 443 through `file` (every address and redirect guard still applies). Options: (a) the switch
   covers `file` too (ChatGPT's files then need it on); (b) `file` gets a switch of its own; (c) `file` only from
   ChatGPT's file hosts (an allowlist). Recommended: (c), or (a) where ChatGPT is not used. The docs now say what the
   switch covers.
8. **A folder named after a character captures that character's images (R2-46; accepted: the exact path only, built).** ADR 0041's rule 1
   reuses a folder named after the character wherever it is, so a folder another agent makes first (`Junk / Asagiri
Miyabi`) receives every later image for her. Options: (a) as now (the Staging page and the Review page show where each
   image went); (b) prefer the Characters path, and reuse a same-named folder elsewhere only when the bridge made it, or
   recorded it, for that character.
9. **A restore counted as one page by the bulk rail (R2-03; accepted: (a), built).** LegendKeeper restores every page deleted by the
   same delete, but the bulk rail counts the restored page only: a restore that brings back 16 pages runs directly at
   scope `write` (a restore that brings back an Authoritative page is now a canonical proposal: R2-10). Options: (a) count
   the pages from the same restore set the canon guard reads (the bridge's journal of its own delete, the snapshots, the
   tree), failing closed when it cannot be told; (b) record the subtree of every cascade delete the bridge makes, and fail
   closed for any other restore of a page known to have had children; (c) as now (a restore undoes a delete, and the
   Review page lists it). Recommended: (a).

## As built (17 November 2026)

1. **Re-authentication (R2-50, R2-51).** Confirmed as built in the review branch, unchanged:
   `test/admin/r2-scope-reauth.test.ts`.
2. **The orphan delete beside an unreadable date (R2-49).** `planOrphanDelete` (src/chronology/orphan.ts) refuses with
   `ORPHAN_NEAR_UNREADABLE`, naming every unpaired row of the age whose Date cell cannot be read (in the tool's dry run,
   `delete_timeline_event` with `orphan`, and the dashboard's "Propose a fix" alike). Rows marked table-only take no part
   in the pairing, so marking a row table-only lifts the block; so does fixing its date. The plan records the rows whose
   date cannot be read that it found accounted for (`unreadableKnown`), and the table check inside the lock refuses the
   delete if another such row has appeared since (a proposal stored before this has no list and is not checked for
   it). `test/chronology/r2-orphan-unreadable.test.ts` (four cases); `test/chronology/qualified.test.ts` marks its
   unreadable row table-only before its orphan delete.
3. **The chosen chronology link (R2-08).** Confirmed as built, unchanged: `test/chronology/r2-link-review.test.ts`.
4. **Low-level removals (R2-52).** The deletes rail (src/policy/rails.ts) also counts, for a request through
   `lk_api_write`, `lk_api_batch` or `lk_op_*` (the request's `origin.tool`, now passed to the rails): `deleteBlock`,
   `deleteBlockRow`, `deletePropertyRow`, `deleteBlockPropertyRow` (`LOW_LEVEL_REMOVALS`), and every whole-list write
   that drops an entry LegendKeeper holds now (`LIST_WRITES`): `replaceDocumentBlocks` (a block left out),
   `updateProperty` and `updateBlockProperty` (`items`, `rows` or `children`), `replaceBlock` (every list of the block)
   and `updateBlock` (the lists it sends). The registry was checked for other removal semantics: the deletes already on
   the rail, the two whole replaces of R2-02, and member removals (refused outright unless LK_ALLOW_MEMBER_ADMIN) cover
   the rest; `updateResource` replacing `tags` is left to the canon and lifecycle guards (status tags) and is not a
   content removal. Whether a list write drops anything is read live before the verdict (src/policy/list-drops.ts: an
   entry is kept when an entry with its id is sent anywhere in the write, or, for a link item without an id, one naming
   the same page and document); a read that fails counts as a removal. The high-level tools are not affected.
   **Revert support stays open** (option (c)): Revert still lists these as not revertible, and the journal keeps the
   pre-image. `test/review/r2-writescope/deletes.test.ts` (A5, A6), `removals.test.ts`, `test/policy/rails.test.ts`,
   `test/policy/list-drops.test.ts`.
5. **Renaming an Authoritative page.** The canon guard (src/facts/canonical.ts, `assessRename`) makes any
   `updateResource` that changes the name of an Authoritative page (its `[BSRC]` prefix, or a Status the rules protect as
   Authoritative) a canonical proposal, at entry (on the tool's own `getResource` read where it has one, else one read)
   and again inside the lock. Every route meets it: `update_resource`, `lk_api_write`, `lk_api_batch`,
   `lk_op_updateResource`, and the setting-pack tools (an upgrade to a Core, the appraisal's name fix). The owner's
   decision named renames: a move of an Authoritative page within its area is unchanged (a move out of canon is the
   lifecycle guard's, as before). `test/review/r2-writescope/canon-lifecycle.test.ts` (C2a, three routes and a control),
   `test/packs/extend.test.ts` (an upgrade to a Core), `test/review/r2-packs/appraisal.test.ts` (ATK-14).
6. **The rails at entry (WS-G3).** Kept, and documented in docs/policy.md and the bridge guide: switching a rail on
   applies to the next request; lowering the scope stops a queued direct job before its next write.
   `test/review/r2-writescope/idempotency.test.ts` (G3, G4).
7. **ChatGPT's file source (R2-45).** The project setting `fileSourceEnabled` (default on; src/projects/settings.ts),
   separate from `UPLOAD_ALLOW_URL_SOURCE`. `resolveImage` refuses a `file` with `UPLOAD_FILE_SOURCE_DISABLED` before
   anything is fetched when it is off (`upload_image` and the setting-pack intake both pass it). Switching it on, or
   clearing it back to on, needs the re-authentication of ADR 0028 decision 7; switching it off is one click (as decision
   1 keeps lowering quick). Every change is audited `project.set_setting`. A project setting rather than an environment
   variable, so that the switch has the dashboard's re-authentication and audit. `test/review/r2-images/url-switch.test.ts`,
   `test/admin/r2-scope-reauth.test.ts`.
8. **Art folders (R2-46).** ADR 0041's rule 1 is retired: `planAssetDestination` (src/assets/plan.ts) resolves a
   character's folder only by walking `Characters / [Group /] Race / Character`. A folder with the character's name
   anywhere else is never used. A path that is ambiguous (two folders of one name in one place) or blocked by an asset
   that is not a folder is `ART_FOLDER_AMBIGUOUS` (the cause kept in the details). Consequences: names are compared byte
   for byte on the path, as every walk already did (another case is another folder), and a plan by name needs the
   repository tree for the race (an existing folder no longer stands in for it). `test/review/r2-images/folder-chain.test.ts`
   (E4), `test/assets/plan.test.ts`, `test/images/upload.test.ts`, `test/images/subfolders.test.ts`.
9. **Restores and the bulk rail (R2-03).** The policy gate reads, for each `restoreResource` of a request, the restore set
   the canon guard reads since R2-10 (`restoreSetReader`, src/lifecycle/deleted.ts), and the rail counts the page and
   every page of the set; a set that is not known (or cannot be read) counts as more than N.
   `test/review/r2-writescope/bulk.test.ts` (B3, B6), `test/policy/rails.test.ts`.

Also built with these: **W18** (the write-scope rehearsal: LegendKeeper accepts a move to the parent `templates`):
`moveResource` to `templates` is refused for every caller at every scope, before anything is queued or proposed
(`TEMPLATES_DESTINATION`, src/jobs/guards.ts), with a regression test of every move route at every scope
(`test/review/r2-writescope/templates-destination.test.ts`). **W5** (a deleted image's old file URL still serves the
file) is LegendKeeper's behaviour; docs/tools.md and the image-revert docs (docs/dashboard.md, Review) say a deleted
image is not private.

**Open:** Revert of low-level removals (decision 4, option (c)).

## Residual risks (accepted, or for a later session)

- A page added under a page after the last full snapshot and then deleted with it in the app is not in any restore set
  the bridge can read: a restore of the parent brings it back unjudged (the restore set is "known" from the snapshot).
- A plain page (no prefix, no status tag) created under an index the owner moved into a lifecycle area in the app, before
  the tree's sweep: the tree is trusted for a page that belongs in no area.
- A move's or create's ancestors above the parent still come from the repository tree, as CR-13 left them.
- The in-process holds of R2-21 (one revert at a time) and R2-38 (one placement at a time) do not survive a restart; a
  restart between the hold and the record leaves at most a refusal to retry.
