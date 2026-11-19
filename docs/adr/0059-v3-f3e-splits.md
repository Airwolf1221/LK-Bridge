# ADR 0059: v3 F3e (splits): `arkona_split_appraisal` and `arkona_split_owner`

- Status: **Proposed** (v3 F3e, 19 November 2026). It implements the owner-approved design
  [design/F3e-splits.md](../design/F3e-splits.md) (APPROVED 18 November 2026: D1 to D7 as written). Every decision is
  implemented and tested against the mock LegendKeeper and fixtures; nothing in this session touched a live system (no
  LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip script). The one new
  sandbox check (`test/sandbox/split-ids.test.ts`) is written for the owner to run. Where the design left room, the choice
  is marked **chosen**; where the build departs from it, the departure is listed with its reason
  ([Departures](#departures-from-the-design)).
- Builds on [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (the new owners are made by F3a's and F3b's
  planners), [ADR 0053](0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md) (lifecycle tags),
  [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (the appraisal's groups, reader and change impact),
  [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md) with its amendment (items, selective approval, Resume,
  rebase on conflict, the way agents are steered) and [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md)
  (Last Major Revision per page). Amends [ADR 0055](0055-write-scope-review-revert-rails.md) (Revert applies to a split's
  phase 1, although the owner approved it) and uses [ADR 0042](0042-snapshots-restore-rehearsal.md)'s
  owner-forced proposal for phase 2.
- Migration: `3600_splits.sql` (Resume learns a fourth kind of job, `split`; the splits' records, `pack_splits`).
- Pack version: `arkona-2026-11-18-f3e` (the split rules as data; supersedes `arkona-2026-11-17-f3d` and
  `arkona-2026-11-17-f3-4`). The owner approves it on the Packs page before either tool works.
- Numbered 0059, the next free number.

## Context

Arkona's governance asks a split to account for every claim, assign each to one destination, verify the destinations
before the old definitions go, keep compact interface summaries with exact links in a surviving owner, remap what
depended on it, and retire the old owner only once all of that is verified ("Do not delete a predecessor merely because
a replacement write returned success"). Anti-Fragmentation is the counterweight: "Do not split merely because a character
has many facts." The bridge therefore never decides what to split: it appraises (A6), and it carries out a split the agent
has planned and the owner has approved (C2), proving at every step that nothing is lost or duplicated.

## Decision 1: `arkona_split_appraisal` (A6), read-only and free (the design's section 1)

1. **The triggers** (`src/appraisal/split.ts`, pure). On a page as the appraisal's reader holds it (the snapshots'
   overlay; `live: true` re-reads it, 2 reads a page, at most 25): **Scope Overload** (the Scope, or else the top-level
   sections, name `scopeOverload.minDomains` domains or more), **Retrieval Cost** (`retrievalCost.minWords` words AND
   `retrievalCost.minDomains` section domains; length alone never counts), **Asset Ownership** (a non-Art, non-visual page
   with `assetOwnership.minImages` images, or a wardrobe, form or outfit section with an image), **Shared Ownership** (a
   section about one other named character of `sharedOwnership.minWords` words or more, with no relationship owner for the
   pair), **Distinct Unresolved Material** (`unresolved.minItems` Unresolved Material items under one domain) and
   **Distinct Dependencies** (a Dependency on a universal owner only one section relies on).
2. **D4: the thresholds are pack data** (`rules.splits`, `src/packs/types.ts`): 3 domains; 2,000 words and 2 domains;
   3 images; 120 words; 2 items; the domain vocabularies (a character's and an owner's), the sections that stay (Purpose,
   Identity, Overview, Source Boundaries, Unresolved Material…), the Anti-Fragmentation examples, the draft destinations
   per domain, what counts as visual, the universal owner types, the questions, and the write guard's word count
   (decision 5). The owner tunes them with a new pack version.
3. **Each result is an architectural candidate**: its trigger, its evidence (sections, counts, sizes), a **draft
   destination map** (each section's domain and where it might go: a specialist page by the pack's destinations, a
   relationship owner, an Art page, or "stays") and the **Anti-Fragmentation note** (sections the rule's own examples keep
   together: personality and habits; body, face and forms; a shared romantic hierarchy). Independent Retrieval,
   Independent Maintenance and Downstream Dependency, which it cannot measure, come back as **questions** for the owner.
   A thin character triggers nothing.
4. **F3c's groups**: the candidates go into the architectural group of `arkona_appraise_owner` (A2), so the Appraisal page
   shows them; the Appraisal page also runs A6 itself (its tool list) with the draft map, the Anti-Fragmentation note and
   the questions.

## Decision 2: `arkona_split_owner` (C2), the plan (the design's section 2)

1. **The destination map (D1).** `destinations` (each a `key` and a `kind`): `new` (a character's page by F3a's rules:
   role, title, Reference Type; any other owner by F3b's: type, name, home; each with its Scope and Purpose),
   `existing` (a page and the heading the material goes under), `relationship` (an existing relationship page, or a new
   one `with` the other character, by F3b's relationship rules), or `universal` (D3: an existing universal owner and the
   subject-specific application text). `map`: every top-level section of the source's main document to one key or
   `stays`; a section that must be divided is divided block by block (`blocks: [{ ids, to, summary?, under? }]`).
2. **The checks before anything is proposed** (`src/packs/split/plan.ts`), each refusal with its list: coverage (every
   block exactly once: `SPLIT_COVERAGE` with the unassigned and the twice-assigned blocks, their sections and an
   excerpt), no duplicated authority (`SPLIT_DUPLICATED_AUTHORITY`: a section listed twice), the visual audit
   (`SPLIT_VISUAL`: an image going to a page that is not an Art or visual owner), content LegendKeeper cannot create
   (`SPLIT_UNSUPPORTED_BLOCK`: it can only stay), the universal audit (`SPLIT_UNIVERSAL_TEXT_REQUIRED`,
   `SPLIT_UNIVERSAL_OWNER_NOT_UNIVERSAL`: an Authoritative page of a universal type), the interface summaries
   (`SPLIT_SUMMARY_REQUIRED`: one for every section that leaves a surviving source), D5 (`SPLIT_DEPENDENCIES_UNMAPPED`:
   every incoming Dependency mapped when the source is to be retired; F3c's change impact finds them), the identity page
   (`SPLIT_RETIRE_IDENTITY`), and whatever F3a's and F3b's planners refuse for a new page (names, templates, tags, AU and
   lifecycle, homes, a domain the character already has: `DOMAIN_EXISTS`). **Warnings** for the owner: the relationship
   audit (`SPLIT_RELATIONSHIP_SECTION`: a section about one other character not going to a relationship owner) and a
   block citing a universal owner the source depends on, moving into a character's page (`SPLIT_UNIVERSAL_CANDIDATE`).
   Character Architecture's extra audits (relationship, visual, index) apply when the source is a character's page;
   Lifecycle's rules (coverage, summaries, Dependencies, retirement) apply to any owner.
3. **The plan shows** every destination, each section and where it goes, the interface summaries, the index entries,
   every incoming Dependency and what it will point to (and those left, when the source survives), the chronology rows
   naming the source, the block ids, Last Major Revision per page, the items and what leaving each out means, and the
   cost: the plan's reads as made (counted at the engine) and its estimate of the job.

## Decision 3: phase 1, one job (the design's "Two phases", step 1)

ONE job (`runWriteJob`, `forceProposal`, a canonical lifecycle marker), in this order:

1. **The first check** (`split.source`, run again by Resume): the pack's governance; no page of a new page's name has
   appeared (the pack's own `absent` check); the source is there, not archived, and each approved item's blocks are
   either all there exactly as planned or all gone with the item's own new blocks in their place (moved by this job); no
   block was added since (`SPLIT_SOURCE_GONE`, `SPLIT_SOURCE_ARCHIVED`, `SPLIT_SOURCE_CHANGED`: nothing is written).
2. **The new owners**, by F3a's and F3b's own job steps: the pages from their templates with their facts, tags, links and
   places (a character's land in its index; **chosen**: a Compact Reference with no index gets one, as F3a's Kamigawa
   Miyuki case does, and moves into it), and each page's text: its Purpose, then the moved blocks **verbatim, with their
   ids** (every attribute kept: runs, marks, mentions, images' addresses, nested children), under the agent's headings.
3. **The existing owners**: the moved blocks appended under the agent's heading, before the page's boundaries (Source
   Boundaries, Unresolved Material), each append computed inside the page's lock on the page as it is (`rebase.always`)
   and re-applied after a 412 (F3d.1); an append already there sends nothing; an id that page already uses is replaced by
   a derived id, said in the job.
4. **The destinations check** (`split.destinations`), BEFORE anything leaves the source: each approved destination holds
   each block it receives, by id, with its text unchanged; each new page's Scope and Reference Type are set
   (`SPLIT_DESTINATIONS_UNVERIFIED` stops the job: nothing has left the source).
5. **The source's edits**, one per destination item: its blocks out, its interface summary in their place (**chosen**: the
   section's heading is kept with the summary when the whole section left, and a sentence "See <page>." with a plain
   mention is added when the summary links nothing). A core rebase: the blocks must be exactly as planned, or the job
   stops (resumable); already done sends nothing.
6. **Universal material (D3)**: not migrated; the application text takes its place where the rest of its section goes
   (**chosen**: the destination that takes the rest of that section, else the source, or `in`), with "See <owner> for the
   rule itself." when the text does not mention it, and the universal owner becomes a Dependency of the page that holds
   the text (a new page's own Dependencies; the source's by a facts write).
7. **Index lines** (step 6): a new page's line in an EXISTING character index's routing section, one item per page
   (a new index already lists its pages).
8. **Dependencies (D5)**: each mapped page's Dependencies now name the destination it needs (and no longer the source,
   unless `keepSource` when it survives), through `set_facts`' own plan and checks; their read-backs join the job's verify
   step (Revert reads them there).
9. **Last Major Revision** (ADR 0051), per page, measured when the job runs from what was approved: moved content counts
   on the source and on an existing owner; a remapped Dependency counts; new pages are dated.
10. **The verification** (`split.verify`, the job's last step: a direct re-read of the affected graph): every original
    block's text in exactly one place across the source and the destinations (interface summaries and application texts
    aside; a universal block nowhere), each new page's Scope and Reference Type, each remapped Dependency, and, for a source
    to be retired, that no remapped page still depends on it. A difference stops the job (`SPLIT_VERIFY_FAILED`):
    phase 2 waits for a job that succeeded.

**Items (F3d).** Each destination is an item whose steps include its own source edit, so a destination left out keeps its
sections in the source and coverage holds whatever the owner unticks (D6); the shared checks are trimmed to the approved
items. A universal assignment whose text stays in the source is an item of its own; a new character index, an existing
page's changes, index lines and remapped Dependencies hang off the destinations they need.

## Decision 4: phase 2, D2 (the design's "Two phases", step 2)

`SplitService` (`src/packs/split/service.ts`) records every split (`pack_splits`) and follows its job. When phase 1
succeeds (so has verified) and the source is to be retired, the bridge proposes archiving it with **archive_page's own
plan**, a separate proposal. **Chosen**: it is an owner-forced proposal (ADR 0042: the dashboard's origin with the system
principal), because approving a split that retires its source is the owner's request, and the canonical guard refuses
the bridge any protected change on its own; so it is always a canonical proposal, and nothing is archived until the owner
approves it. **The split never deletes the source.** No phase 2 when the source survives, when the job stopped, or when
an item was left out or skipped (the source still owns material: the record says why). `report` answers what became of a
split (free).

## Decision 5: canonical at every scope, rails, steering (D7)

1. **D7**: always ONE canonical proposal ("Approve and accept as canon"), at scopes `propose` and `write` alike. The bulk
   rail does not apply: it is already a proposal the owner reads item by item.
2. **Never by hand** (as F3d.1 steers renames): on a project whose approved pack has split rules, `write_page` refuses an
   edit that takes `splits.guardWords` (120) words or more off a pack page (a page of a character's set, a page with a
   Subject fact, a pack owner) with `USE_ARKONA_SPLIT`, a hint naming both tools and `useTool`; `plainEdit: { reason }`
   lets a page's own revision through, its reason in the job's title and journal. F3a's `split` input is refused with the
   same code. The bridge guide has an "Arkona splits" section and the line "Split an owner → `arkona_split_appraisal`, then
   `arkona_split_owner` (never by hand)" in "How to decide".

## Decision 6: Resume and Revert

1. **Resume** (ADR 0058): a split's phase 1 is resumable (`job_stops.kind = 'split'`): its first check runs again, no
   succeeded step runs again (an append or a source edit already made sends nothing), and it continues from where it
   stopped; when it then verifies, phase 2 follows.
2. **Revert** (amends ADR 0055): a split's phase 1 is revertible although the owner approved it ("phase 1 can be reverted,
   putting the moved content back and removing what it created"). The revert job puts back what the job changed (the
   source's text, the existing owners' appends, the remapped Dependencies, the index lines, a moved Reference's place,
   relationship links, Last Major Revision), each only while it is as the job left it. The pages it made are not touched
   by that job: once it has succeeded they go to ONE deletion proposal (children before their parents; canonical for an
   Authoritative page), each only while it is exactly as the split made it; a page changed since is kept and listed.
   When the job stopped before anything left the source and nothing else needs putting back, Revert makes only that
   proposal (`status: "proposed"`). A reverted split is never reverted again (`ALREADY_REVERTED`) or resumed (`REVERTED`).
3. **Chosen, for Revert in general**: a row write whose If-Match comes from its target's check, after another write of the
   same revert job changed the same page's sidebar (a split changes a page's Related Sources and its Last Major Revision:
   two targets), is judged inside its lock instead (the rows exactly as the check read them; the version read there),
   which a split's revert needs and which no earlier revert could reach.
4. **Chosen, for the engine**: a write verified after it is sent (`verifyAfterWrite`) that was rebased on a conflict now
   records the rebase (`rebased`, and any items it skipped), as every other rebased write does.

## The owner's surfaces

The Appraisal page runs A6 and shows the candidates with their draft map, Anti-Fragmentation note and questions. The
Proposals page shows each item's "If left out, … stays in …" line, and again in the confirmation before the owner
approves a selection. The Jobs and Review pages resume or revert a stopped phase 1. The Packs page approves the new pack
version.

## Costs (measured against the mock, pinned by the tests)

- **A6**: free (the snapshots); `live: true` 2 reads a page.
- **The character monolith** (the test world's Zahra al-Rashid: six new owners and a new index, one remapped Dependency,
  universal material): the dry run's plan reads 8 (the source and its document, the source again for the pack's planner,
  three templates, the Core whose Related Sources the relationship changes, the remapped page) after the pack's 3
  governance reads; proposing costs 23 requests; the approved job 243 requests, 87 of them writes (its estimate: 171 reads
  and 87 writes).
- **The owner with two domains** (Ostrand's statutes: one new owner, one existing owner extended, two remapped
  Dependencies, retired): proposing 12 requests; the job 84 requests, 22 of them writes (estimate 58 reads, 22 writes);
  then phase 2 is archive_page's own cost.
- **A conflict on an existing owner's append** (LegendKeeper answers 412): one more read and the write again (that
  document is otherwise read 4 times: inside the append's lock, after the write, by the destinations check and by the
  verification).

## Departures from the design

1. **Block-level assignment is by top-level block.** A list, a table or a quote moves whole, with its children: dividing a
   list would change its structure, which is not verbatim. Within a section, every top-level block can go its own way.
2. **Block ids are kept where LegendKeeper allows**, which the build assumes from its specification (ids are per
   document; a requested id is kept): always on a new page; on an existing owner, an id that page already uses is
   replaced by a derived id, said in the job. The sandbox check confirms it on the test world; until the owner runs it,
   this is an assumption.
3. **Scope Overload** counts the domains the Scope names, or, when it names fewer, those of the page's top-level sections
   (a short Scope over a monolith would otherwise hide it).
4. **A2 shows compact candidates.** `arkona_appraise_owner` carries each A6 candidate's trigger and evidence and points to
   A6 for the draft map, the Anti-Fragmentation note and the questions: with all of them, a branch's report exceeded the
   inline result size and came back as a handle.
5. **Phase 2 is also withheld when an item was left out or skipped**, not only when phase 1 failed: the source still owns
   material then (D6), so retiring it would archive current material. Retiring it later is `archive_page`'s.
6. **A character's identity page is never retired by a split** (`SPLIT_RETIRE_IDENTITY`): the character would have none.
   It survives with its interface summaries, or becomes a Core first.
7. **Only Scope and Reference Type stop phase 1.** The design asks that "every new page's Scope and facts are set": the
   split's checks stop the job on those two; the rest of a new page's facts are verified by the pack's own read-back,
   which records a difference without stopping (as for every package).
8. **Lifecycle & Repository Maintenance is not a governance source of the pack**: the pack records Character Architecture,
   Source Formatting and the Tagging Standard (a change to any of them makes the pack not current); the split rules come
   from the approved design's numbers (D4), as pack data, not from pinned sections.
9. **`lk_api_write` is not guarded for splits** (F3d.1 guards a raw `updateResource` rename): judging a raw
   `replaceDocumentBlocks` needs the document as it is, a read the raw path does not make. Agents are steered by the
   guide, `write_page`'s refusal and both tools' descriptions; the low-level tools stay the documented last resort.
10. **The deletion proposal after a Revert keeps a page that differs from what the split wrote**, whatever the reason (an
    edit since, or LegendKeeper not storing a block as sent): the owner decides about it.
