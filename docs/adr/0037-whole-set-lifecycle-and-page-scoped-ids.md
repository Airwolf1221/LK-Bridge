# ADR 0037: Whole-set lifecycle; ids keyed by page; row values trimmed as LegendKeeper trims them

Status: Accepted (v2 session C2d, 11 November 2026). Implements the owner's decisions of 11 November 2026 on subtree
lifecycle (PLAN-v2's C2d row, closing the open question of [ADR 0035](0035-page-lifecycle.md)), and the two findings of
the owner's first sandbox run of the assumptions check ([CR-2026-11](../reviews/CR-2026-11.md) section 6, A1 and B16).
Migration 1750 is this session's (1700 is left to D1, which runs alongside). The owner's CR decisions themselves are in
[ADR 0036](0036-cr-2026-11-owner-decisions.md). No decision in PLAN.md or PLAN-v2.md is changed; the choices below fill
the gaps.

## Context

- **A1 (11 November):** LegendKeeper reuses a template's property ids in every copy (`tsqo4cfd, iteayl8v, …`), and
  almost certainly its row and item ids: every page made from one template has the same ids as the template and as each
  other. Ids below a page are unique only within that page. The bridge had keyed some things by such an id alone.
- **B16:** LegendKeeper trims a leading or trailing `{ break: true }` from a key-value row value (the OpenAPI schema says
  so). The bridge compared, remembered and verified what it sent, not what LegendKeeper keeps.
- **Sets:** archiving a whole character (its index, Core and specialist pages) is one change for the owner, and C2c
  refused any page with pages under it.

## Decisions

### Part 1: everything below a page is keyed by the page

1. **The audit** (every place an id below a page is stored, cached, compared or looked up):

   | Where                                                                                                                                                                                                                                                                                                                 | Before                                                                                                                                      | Now                                                                                                                                                                                                                                                        |
   | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Journal lookup by `targetId` (`bridge_journal_lookup`, the dashboard's Journal)                                                                                                                                                                                                                                       | matched the id alone: a row id found every copy's writes                                                                                    | a property, row, item or block id matches only with its page (`resourceId`); without one, only page, document and page-less targets match. The dashboard shows a target as `page › document › id`                                                          |
   | `factsVersion`                                                                                                                                                                                                                                                                                                        | a hash of the facts alone: two untouched copies had the same `fv1_` version, so one copy's version passed as the other's `baseFactsVersion` | `fv2_`, the page's id hashed in. An `fv1_` base sent after the upgrade is a `VERSION_CONFLICT` (`base_unknown`); read the page again                                                                                                                       |
   | The copy check's id map (`bridge.expect` `copy`) and `bindIds`                                                                                                                                                                                                                                                        | one flat map per step, keyed by the template's ids                                                                                          | kept per page (`idsByPage`); a write binds from the map of the page it names, and a page the check did not map is refused. With reused ids the map is the identity, which the tests confirm                                                                |
   | Versions a `bridge.expect` step read (`ifMatchFrom.key`)                                                                                                                                                                                                                                                              | keyed by label (a property's title, which copies share)                                                                                     | kept per page too (`versionsByPage`); a write chains from its own page's                                                                                                                                                                                   |
   | Proposal summaries ("updatePropertyRow on …")                                                                                                                                                                                                                                                                         | named the row alone                                                                                                                         | name the page with it                                                                                                                                                                                                                                      |
   | `facts_versions`, the lifecycle record (`note_block_id` with the document in its target), the link index (by page and title or document), verify targets, the canon and lifecycle guards' simulated sidebars and prefetched reads, the tree, locks (`res:` and `doc:` only), `template_fact_keys`, the capture caches | keyed by page (and document) already                                                                                                        | unchanged (checked)                                                                                                                                                                                                                                        |
   | Markdown keep regions (`<!-- lk:keep id=… -->`)                                                                                                                                                                                                                                                                       | a block id with no document                                                                                                                 | unchanged: a region is resolved against the target document's own blocks, so a marker copied from a twin page can only keep that page's own block; nothing crosses over. Before, it was refused as unknown; now it keeps the twin's same-id block in place |
   | `mapping_field_maps.block_id` (Repository Mappings)                                                                                                                                                                                                                                                                   | a block id with no page                                                                                                                     | unchanged: it is a type-wide location (which reused ids make meaningful across copies); nothing resolves it yet                                                                                                                                            |

2. **Results stored before C2d** (a job that started before the upgrade) carry only the flat maps; `bindIds` and
   `bindIfMatch` fall back to them, so such a job finishes as planned.
3. **The mocks reuse ids as LegendKeeper does** (`test/resources/world.ts` and `test/tree/model.ts`), so every test
   now runs against the real behaviour; `freshCopyIds` keeps the old assumption for tests that need it. The full suite
   passed unchanged under reuse, and a test of two copies (one job making both, two jobs writing them at once, a proposal
   on each, a twin's `factsVersion`) shows nothing crosses over.

### Part 2: row values are planned as LegendKeeper stores them

4. **Every leading and trailing break is trimmed** (`trimRowBreaks`) before planning: `set_facts` values (plain text,
   where a trailing new line would become a break, and `{ "markdown" }`, where a trailing `<br>` would), the creation
   tools' identity facts and a new page's Status, and the lifecycle tools' facts (which now write a multi-line value as
   lines with breaks, as LegendKeeper reads one back). The comparison normal form (`normaliseContent`: the in-lock checks,
   verify, `factsVersion` and the canon guard's model) trims too, so the proposal's captured state agrees.
5. **A value that is nothing but breaks clears the row**, as an empty value does (the row stays, with no value; `null`
   still removes it).
6. All of them, not one: the schema says "a leading or trailing break"; the bridge trims every one. The sandbox check
   B16 now sends two at each end and says plainly if LegendKeeper trims only one.

### Part 4: whole-set lifecycle

7. **`subtree: true` on all four tools.** The set is the page and every page beneath it, listed live (level by level)
   when planned. At most **100 pages**, the root included (`SET_TOO_LARGE`, with the cap).
8. **One canonical proposal for the set**: a set summary (root, page count, content pages and indexes, the state it
   leaves and enters, where its root goes, the layout rule, the estimate) and every page with its own plan (new name,
   move, facts, tags, note). At every scope the only approval is "Approve and accept as canon". The dashboard shows it as
   a table, one row per page.
9. **What a set may hold** (`SET_NOT_ELIGIBLE`, listing each page and why): content pages in the expected state and
   `[INDEX]` pages. Refused: an unclassified page, a lifecycle-inconsistent page (prefix and Status disagree), either
   lifecycle index, a page in another state, a page whose own lifecycle change stopped part-way, and for archiving a page
   with no page document. Expected states: `[BSRC]` for `move_to_working`, `[BWRK]` for `promote_page`, `[BARC]` for
   `unarchive_page`, and for `archive_page` `[BSRC]` **or** `[BWRK]`: the owner's live check archives a set that was
   just moved to Working, and `archive_page` takes either page. **A set must be one state**: a set mixing Authoritative
   and Working pages is refused (each page listed), because unarchiving it could not put both back in one place. The set
   must also be where its state says (a Working set under `[INDEX] Working`, an archived one under `[INDEX] Archived`, an
   Authoritative one under neither). A page the repository tree has not seen yet is refused (`SET_NOT_IN_TREE`: try
   after the next sweep).
10. **Layout (owner): the set stays together.** Its root moves as a group, placed alphabetically among the lifecycle
    index's (or destination's) other children; the structure beneath it is unchanged. So archiving gives
    `[INDEX] Archived / [INDEX] Asagiri Miyabi / [BARC] Asagiri Miyabi - Character Core …`. This is the one exception
    to C2c's "flat" lifecycle indexes. `archive_page` and `move_to_working` take the root to `[INDEX] Archived` or
    `[INDEX] Working`; `promote_page` to `destination` (required; the location `move_to_working` remembered for the set
    is offered as `suggestedDestination`); `unarchive_page` back to the previous parent in the set's record, which must
    still exist and be usable for the state the set returns to (a Working set goes back under `[INDEX] Working`),
    otherwise `destination` is required.
11. **Index pages within a set (owner):** an index stays `[INDEX]`; it gets no Status and its facts are untouched; its
    status tag changes (`CANON` or `Working` → `Archived` on archive and back on unarchive, `CANON` → `Working` on
    `move_to_working`, `Working` → `CANON` on promotion); on archive it gets a short note as its first block, from the new
    lifecycle setting `texts.noteForIndex` (default: "Archived - {date}. The author retired {source} and the pages beneath
    it. They are kept for provenance.", **a proposed default for the owner to confirm**, editable on the dashboard); on
    unarchive the note is removed if unchanged, as for pages. An index with no page document is refused for archiving.
12. **Content pages within a set** get exactly C2c's single-page treatment, each by its own previous state: the note
    variant, the facts, the Scope prefix, the Temporal Scope variant, the tags, Last Major Revision, and the Continuity
    Type rule on promotion (kept when CANON or AU, otherwise CANON). Unarchiving returns each page to the state in its
    own record.
13. **Execution: one job holding every page's lock** (and each note's document): `holdLock` (the root) plus a new
    bridge-only `holdMore` (any number of resources and documents), all taken in sorted key order at the job's start, as
    C2c's job-level locks are, so two such jobs can never wait on each other. Steps are ordered so no page ever claims a
    state it is not in: leaving the current state (archive, move to Working) every rename and status tag first, then the
    facts, the notes, and the root's move last; entering it (unarchive, promote) the root's move first, then the facts
    and notes, and every rename and tag last. Each page's facts keep C2a's in-lock check and If-Match chain; the verify
    step reads back every page (its name, tags and parent from its parent's listing, its facts and its note).
14. **ADR 0036 decision 5 for sets.** The job's first step checks the whole set (`bridge.expect` `subtree`: every page
    under the root, with its parent, name and tags, as captured); the approval lists it again first (`pageScope`). A page
    added, gone or moved (or, inside the job, renamed or retagged) makes the proposal `conflicted`, nothing written.
15. **Records.** A new set record (`lifecycle_sets`: the root, the action, the captured pages, each page's target, the
    set's previous state, parent and rank, the jobs, the proposal) and one lifecycle record per page, linked to it
    (`lifecycle_records.set_id`), written by the job's own `bridge.record` steps (`begin_set` before the first write,
    `complete_set` after the verify step). A part-way stop leaves the set and its pages' records `incomplete`. **Calling
    the same tool again on the root resumes**: the plan is made again from every page as it is now towards its recorded
    target, only what is left is proposed (a new canonical proposal, every check again), and the same records complete
    with the new job added. The set must still be the same pages (`SET_CHANGED` otherwise). Another lifecycle tool on the
    root, and any single-page lifecycle tool on one of its pages, is refused (`LIFECYCLE_INCOMPLETE`, naming the set's
    root) until then.
16. **Related pages** (archive and move to Working only): for every page in the set, the link index's pages and one
    content search per content page, leaving out every link between pages of the set. Reported, never edited.
17. **Single pages and sets.** A single-page change of a page inside a set keeps C2c's behaviour (archiving, moving or
    promoting it alone takes it out of the set, flat). A page unarchived alone from inside an archived set needs
    `destination`: its previous parent is inside the archive. Set unarchiving leaves out pages of the archived set that
    were unarchived alone since (flagged), and refuses a page under the set that was not archived with it (no record
    from the set's archiving).
18. **The lifecycle guard** is unchanged in kind: the tools declare every page of the set in their marker (content pages
    with their new state, indexes with the set's, for their status tags), and the guard allows exactly those changes.
    Pages under an archived set's index are in the archive area as far as the guard is concerned, so nothing can be
    created there, moved in or out, or renamed out of `[BARC]` by any other route.

## Costs

Measured against the mock (`test/lifecycle/sets.test.ts`, costs): `archive_page` with `subtree` on a 4-page set (2
indexes, 2 content pages) costs 20 reads to plan (each page read, listed, its note's document read, a content search per
content page) and 50 reads and 19 writes to run; on a 10-page set (2 indexes, 8 content pages) 56 reads to plan and 134
reads and 61 writes to run. Per page that is about 5–6 planning reads, and about 13 job reads and 6 writes per content
page (1 rename and tag, 5 facts, its note), 3–4 reads and 2 writes per index (tag, note), plus the root's move. The dry
run shows the page count and `bridge_estimate`'s reading of the job's reads and writes. At the bridge's write pacing a
100-page set is about 600 writes: several minutes, within one hour's write budget.

## Consequences

- Copies of one template share their ids, so ids below a page are always given with their page in the journal
  (`resourceId` with `targetId`). `factsVersion` values handed out before C2d (`fv1_`) are conflicts once; read the page
  again.
- A set change is canonical and large: the dashboard shows it page by page; approving it is one decision for the whole
  set, and a set that changed since the proposal ends conflicted rather than half-applied.
- E2's lifecycle-consistency audit gains the set rules (PLAN-v2): under an archived set's index every content page is
  `[BARC]`; under a Working set's index every content page is `[BWRK]`.
- **To verify on the test world** (the owner's live checks): the four set operations on a Working test character with a
  Core and two specialist pages, the conflict when a page is added between proposal and approval, and the sandbox
  assumptions check again (A1 should now report the reused ids as a note, B12 should pass on its own page, B16 should
  pass with every break trimmed).

## Amendment (C2d.1, 12 November 2026)

[ADR 0035's C2d.1 amendment](0035-page-lifecycle.md) lets a Working character's set be built one page at a time, so a
set under `[INDEX] Working` now also holds the specialist pages made under its index, and the owner moves pages within a
lifecycle area. What this changes for sets (no decision above is overturned):

- **Decision 10, layout.** A Working set's root may sit under `[INDEX] Working` or, once the owner has moved it, under
  an `[INDEX]` inside another Working set; an archived set's root under `[INDEX] Archived` or an `[INDEX]` inside an
  archived set. `unarchive_page` with `subtree` still returns the root to the previous parent in the set's own record (a
  Working set to `[INDEX] Working` or the Working-set index it came from, when that index still exists), never to where
  it was moved within the archive. A set unarchived while its root sits inside another archived set works from its
  record alone; unarchiving the OUTER set refuses the moved-in set's pages as "not archived with this set" (decision 17),
  listing them: move the inner set out first.
- **Decision 9, what a set may hold.** Unchanged. A set promoted with `promote_page` and `subtree: true` takes every page
  beneath the character's index, which is why specialist pages are now created under it.
- **Outsiders (new).** The set promotion plan, and so its dry run and its proposal, lists under `outsiders` the
  `[BWRK]` pages directly under `[INDEX] Working` that are outside the set but share its subject (`subjectOf`: the
  Subject row, else the display name before " - "; the root index's own name for a plain index; a character role from
  the registry wins), suggests `move_resource` (page: its id, to: the set's root) to bring each in first, and adds one flag
  to the proposal, so the owner does not approve a partial promotion by accident. It never moves anything for the agent,
  and it does not change what the proposal covers (decision 14: an approval covers only the listed pages). It ran for
  `promote_page` only (C2d.1); a resumed change (an open set record) is not re-checked.
- **Outsiders on archive and move to Working (C2d.2, 12 November 2026: the owner's request).** Already present for
  `promote_page`; **it was not present for `archive_page` and `move_to_working` with `subtree: true`**, so it is now: the same
  listing (`outsiders.pages`, found by `workingOutsiders`), the same flag, in the dry run and in the proposal (the stored
  operation's `lifecycle` head carries both). Archiving a Working character left its flat specialist pages behind, still
  Working; moving an Authoritative set to Working left same-subject Working pages apart from it. `unarchive_page` does not
  list them (it brings pages back from the Archived area, where the trap does not arise). The words differ by action,
  because **a Working page can only be moved into the Working area**: promote and archive of a Working set say "move them in
  first with `move_resource`, then …"; archive of an **Authoritative** set says a Working page cannot be moved into it, so
  archive each with `archive_page` as well (or leave them on purpose); `move_to_working` says to bring them in with
  `move_resource` once the set is Working. Nothing is moved for the agent and the proposal still covers only the listed pages.
