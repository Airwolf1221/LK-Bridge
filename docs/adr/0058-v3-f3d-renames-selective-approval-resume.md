# ADR 0058: v3 F3d (renames): `arkona_rename`, selective approval and resuming a package

- Status: **Proposed** (v3 F3d (renames), 18 November 2026). It implements the owner-approved design
  [design/F3d-renames.md](../design/F3d-renames.md) (APPROVED 18 November 2026: D1 (a), D2 to D6 as written). Every
  decision is implemented and tested against the mock LegendKeeper and fixtures; nothing in this session touched a live
  system (no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip script).
  Where the design left room, the choice is marked **chosen**; where the build departs from it, the departure is listed
  with its reason ([Departures](#departures-from-the-design)).
- Amends: [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (a package is a proposal made of items);
  [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 6 (a recreate's Finish goes through
  Resume, with the same behaviour); [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) (how a
  rename's name facts count). Builds on [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (A1, A3),
  [ADR 0055](0055-write-scope-review-revert-rails.md) (rails, Revert) and
  [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) decision 5 (renaming canon is a canonical proposal).
- Migration: `3400_renames_items_resume.sql` (a proposal's items and what was approved and left out; where a resumable
  job stopped, `job_stops`; the renames, `pack_renames`).
- Numbered 0058, the next free number. The session's label is "v3 F3d (renames)": PR #63, titled "v3 F3d", was session
  F3.3 (lifecycle tags, [ADR 0053](0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md)).

## Context

Renaming a character or an owner in Arkona touches far more than its page: the pages of its set, its identity facts,
mentions labelled with its name, index routing lines, chronology rows and their events, its art, a race's taxonomy, a
culture's or race's identity token on every character, and every sentence elsewhere that restates the name. Some of
those must not change (history, quotations, "formerly …"). The owner wants ONE proposal that shows every one of those
edits, can be approved in part, and, if its job stops part-way, can be resumed without repeating or duplicating anything.

## Decision 1: `arkona_rename` (the design's section 1)

1. **Input.** `subject` (any page of a character's set, or an owner page: by name, alias, path or id), `newName`,
   `given` and `family` (D4: only as the owner decided), `keepOldAsAlias` (default true), `effectiveDate`, and **chosen**:
   `token` (a culture's or race's new tag when its old one is not its name: `TOKEN_REQUIRED` otherwise, never inferred),
   `from` (a follow-up: the old name, when the subject already has the new one) and `report` (read-only: what a rename
   left). `dryRun` previews.
2. **The plan** (`src/packs/rename/plan.ts`) finds the name through the full-text index (A1: every unit holding the old
   name as a phrase) and the set through the repository tree, then reads live each page and document it will edit. ONE
   package of **items**, each with an id, its change and its dependencies: page names (the index, the Core or Reference,
   every `<Old> - …` child, every relationship naming it, either way round, wherever hosted; ids kept); identity facts
   (Subject, Canonical Display Name, any fact of the set naming it; the name parts as given; the old name added to
   Aliases); resource aliases (each renamed page's old name); mention labels (a custom label holding the old name; a plain
   mention needs nothing); index routing lines (an index's routing section); chronology rows (through the chronology
   tools' own `buildJob`, the row and its bridge-linked event in step); the art folder and asset names (the character's
   art folder, found as the image pipeline finds it, and every asset below it named with the old name); a race's
   Character taxonomy entry; the identity token (D3) and each character's fact and tag; and each textual restatement
   elsewhere, one item per occurrence with its sentence. Every item depends on the subject's own new name; a page's facts
   and alias depend on that page's name; a mention label on the name of the page it mentions; a character's fact and tag
   on the token.
3. **D1 (a): the ticks.** Every item is ticked except a restatement inside quotation marks, after "formerly",
   "previously", "once called" or "originally" in the same sentence (before the name), under an Unresolved Material
   heading, in a chronology row dated before `effectiveDate`, or on a page that is not current (neither Authoritative nor
   Working); each unticked item says why. Approving without a selection approves the plan's ticks (decision 2.4).
4. **D2: history is never touched.** Archived pages, the Legacy Canon Archive and the Design References are listed as
   "left as historical" and never become items; an Archived page of the set keeps its name. **AU pages are included**,
   labelled AU (their Continuity Type, read from the snapshot overlay).
5. **D3: the identity token.** A culture's or race's token map changes in the same package, as a NEW pack version: when
   the owner approves the rename with its token item, the proposal hook (`beforeSubmit`) makes the version (the pack's
   `renameToken` command: the old value's entry renamed to the new value with its new token; audited
   `pack.rename_token`, and `rename.token_version` on the rename), and the job is submitted **waiting** for it (`waitFor`:
   the engine holds it until the approved pack version reaches it; the Packs page's approval pokes the scheduler). Its
   check confirms inside the lock that the APPROVED version maps the new value to the new token
   (`PACK_TOKEN_NOT_APPROVED` otherwise). The hook refuses while another version waits for approval (the proposal stays
   pending). Left out, the token item makes no version and the characters' items are left out with it.
6. **D4: name parts.** A given or family name that is in the old name and not in the new one must be supplied, or the
   plan is refused with `NAME_PARTS_REQUIRED` naming it; nothing is inferred from the shape of a name.
7. **Always a canonical proposal**, whatever the caller's scope (ADR 0057 decision 5), with the lifecycle marker
   `arkona_rename`. **The rails:** a rename is **not subject to the bulk rail** (ADR 0055 decision C): one subject, one
   proposal the owner reads item by item and approves as canon; the rails judge what an agent may do directly, and a
   rename is never direct.
8. **One job.** Step 1 is ONE check inside every lock the job holds (the subject's page, every page, document and asset
   it edits, the chronology's documents): the subject still has its old name (renamed meanwhile: `SUBJECT_RENAMED`,
   nothing is written; gone: `SUBJECT_GONE`), each page's name, aliases and tags are as planned, each block it edits is as
   planned apart from this rename's own edits (a fingerprint with the old and new names masked; its new body is worked
   out from the block as it is now), each asset's name and folder, and the approved token. Then the approved items in
   dependency order: names (with a move only when a page's place among its siblings, all renamed at once, changes), facts
   and aliases, then everything that points at them (blocks, chronology, art, taxonomy, characters), Last Major Revision
   (decision 1.9), and the read-back of every page it touched (names, aliases, tags, each edited block occurrence, each
   asset).
9. **Last Major Revision, by ADR 0051's rule, per page**, measured when the job runs from the writes that were approved.
   **Chosen** (the design's "a name or alias change alone is minor"): a fact whose only change is the old name for the
   new one, a name part the owner gave, and the old name added to Aliases are the page's name in another place and never
   count, like the page name and its aliases; a page with nothing else gets no Last Major Revision step at all. Restated
   text is measured (8 words, a heading), and a chronology row counts as the rule says.
10. **What is left (verification).** When the job ends, the full-text index (brought up to date by the job's own change
    snapshot) is searched for the old name again; every occurrence still on a current page (not history, not the old name
    kept as an alias, the name as written) is listed with its link, and offered as a follow-up: `arkona_rename { subject,
newName, from: "<old name>" }` plans exactly what is left. `report` answers it, free. The record is `pack_renames`.
11. **Cost**, measured against the mock and pinned in the tests: planning reads each page of the set and each document
    holding the name once, plus the pack's three governance reads: 22 for the test character (seven pages of its set, six
    other pages naming her, two chronology rows), 13 for a culture with six characters. The character's approved job
    (the plan's ticks, 7 items left out): 185 requests, 49 writes; the culture's: 98 requests, 20 writes (each with its
    check, read-back and change snapshot). The tool's description states them; `dryRun` states the plan's own estimate.

## Decision 2: selective approval (the design's section 2, D5)

1. **Items for every proposal made of them** (`src/jobs/items.ts`): a rename, and every F3a and F3b package
   (`src/packs/engine/items.ts`: a new character's set with its identity page, each other new page, the changes to each
   existing page). Each write step names its items; a shared step (a check, the read-back) names the parts of it that
   belong to each item. **Chosen: hard and soft dependencies.** A step that binds another's result, a page created under
   another, or a write to a page another item creates is a hard dependency (the item cannot run without it); a mention,
   a link or a routing line to a page left out is soft: it is removed from what is written (a mention becomes its plain
   label), so the rest still makes sense.
2. **A closed selection.** The owner's selection must keep, for every item, what it depends on; the dashboard drops the
   dependants of an unticked item itself and shows them before confirming; the server refuses a selection that is not
   closed (`SELECTION_NOT_CLOSED`, naming each item and what it needs), so the owner approves exactly what they saw.
3. **Only the approved set runs.** The job's steps are filtered: writes of items left out are dropped, shared checks and
   the read-back trimmed to the approved items, If-Match chains re-chained past dropped writes, Last Major Revision steps
   and their evidence trimmed (a page with nothing approved loses them), placements re-anchored past pages not made.
   Approving with everything ticked runs exactly the captured steps (unchanged behaviour).
4. **The default.** Approving an itemized proposal without a selection approves the plan's ticks (every item for a
   package; D1 (a)'s for a rename). The same re-authentication and canonical confirmation as the whole apply.
5. **Recorded.** The proposal keeps the items approved and left out (`approved_items`, `omitted_items`); a partial approval
   is audited `proposal.approve_selected` (or `…_as_canon`) with both lists. **"Propose these again"** (after the approved
   part has been submitted, once) makes ONE new proposal of exactly the items left out, captured afresh, recorded on both
   (`reproposed_as`, `reproposal_of`, audit `proposal.repropose`). Agents can never approve. A proposal that is not made
   of items is unchanged.

## Decision 3: Resume (the design's section 3, D6)

1. **Where it stopped.** A job submitted as resumable (a package, a rename, a recreate) records, when it fails or is
   cancelled, its last verified step (every step up to it succeeded and none was read back different from its plan), the
   step it stopped at and why (`job_stops`).
2. **Resume in place** (`src/resume/service.ts`, `engine.controls.resumeStopped`): the same job continues, so every
   binding stays valid. Its own checks (step 1) run again first, inside its locks; a step that succeeded is never sent
   again; a failed step gets a fresh idempotency key, an ambiguous one keeps its key and is verified before anything is
   re-sent; nothing is made twice (a package's check counts the pages and images this job already made as its own).
   A step that is no longer safe is refused by that check, with its reason, and the job stops again where it was.
3. **Who.** The owner, on the Jobs page and the Review page (Resume, with a confirmation that says from where it
   continues). An approved proposal's job resumes without a fresh approval (the plan is the one approved): audited
   `job.resume` with where it stopped and who approved the work; the proposal goes back to `executing`. An agent, with
   `bridge_job_resume { jobId }`: only its own job, only one the owner did not approve (`OWNER_APPROVED_JOB`), only at
   scope `write` (`SCOPE`).
4. **F2's Finish** (ADR 0049 decision 6) of a recreate goes through the same service and keeps its behaviour: a new
   proposal of only what is still missing (audited `job.resume` and, as before, `snapshots.finish_recreate`).
5. **Revert** (ADR 0055) is unchanged and stays the alternative for a direct job: a reverted (or reverting) job is never
   resumed (`REVERTED`, `REVERT_RUNNING`).

## Departures from the design

1. **A race's art folder is kept** (**chosen**): the taxonomy entry is renamed (its plural, the old plural and singular
   kept as aliases, the singular worked out again unless the owner chose it), but its asset folder stays as it is, so the
   race's art stays where it is; the race's navigation index is renamed only when it is named exactly as the race (else
   it is reported). Renaming a race's whole art tree is a separate decision for the owner.
2. **Table cells and code blocks** in ordinary documents, and a name split by formatting, are reported (`notPlanned`)
   rather than edited: a cell's paragraph cannot be rewritten safely through the block routes the rename uses, and a
   split name has no single run to change. The leftover report lists them again after the job.
3. **Sidebar restatements are one item per page** (not per occurrence): a page's facts are written as one checked chain.
4. **Mention labels and routing lines are always ticked**: D1 (a) is about restatements.
5. **Only bridge-linked timeline events** follow their rows; an unlinked event is named in its row's item
   (`sync_timeline_event` renames it).
6. **The token map entry is renamed** (the old value removed): a character still holding the old value (one the owner
   left out) has no token until it is renamed too. While the new version waits for the owner, every package tool refuses,
   as for any new version.
7. **Leftovers are offered, never proposed by themselves**: the follow-up call is given (`report`, the dashboard's job and
   the record); an agent makes it only when the person asks.
8. **A recreate's Resume is F2's Finish** (a new proposal of what is missing), not an in-place continuation: its plan is
   made afresh from the snapshot.

## Consequences

- One rename is one canonical proposal the owner reads item by item; nothing is renamed piecemeal by agents.
- Every package is now a proposal made of items: whole approvals behave exactly as before; partial ones run a filtered
  job whose shared checks and read-back cover only what was approved.
- A package or a rename that stops part-way can be continued safely instead of planned again; the audit shows each resume.
- **What the sandbox has confirmed, and what it has not.** The rename's writes are the ones the existing sandbox rounds
  check (a page renamed and re-placed, W17; an asset renamed by `updateAsset` without If-Match, W2; a block replaced with
  its ids kept and the document's version chained, W9 and W10; a mention's name read-only, D22). Two are not yet
  checked on a real project: an asset **folder** renamed by `updateAsset`, and a mention's **custom label** changed
  through `replaceBlock`. No new sandbox script was written in this session: the owner's second step below (one
  character on the test world, with selective approval) exercises both, and a failure there stops the job at that step,
  resumable, with nothing duplicated.
- The owner's steps after deploying: (1) approve the new pack version, if one was made; (2) try a rename on the test
  world first, using one character and the selective approval; (3) then use it on Arkona.
