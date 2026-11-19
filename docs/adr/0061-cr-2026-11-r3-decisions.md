# ADR 0061: Decisions from the third review (CR-2026-11-R3)

Status: **Proposed** (19 November 2026). Part A records what this review's fixes chose where an earlier ADR said
otherwise or said nothing: built, for the owner to confirm or reverse. Part B asks the owner to decide what the review
leaves open. The findings are in [docs/reviews/CR-2026-11-R3.md](../reviews/CR-2026-11-R3.md).

- Amends: [ADR 0055](0055-write-scope-review-revert-rails.md) decision B (a confirmed partial revert is not offered for a
  split's phase 1); [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md) decisions 2.5 ("Propose these again")
  and 3 (Resume); [ADR 0059](0059-v3-f3e-splits.md) decisions 2.1, 3, 4, 5 and 6.2 (the new owners, appends, the
  verification, phase 2, the visual audit, Revert) and its
  departure 10 (what "verbatim" is checked by); [ADR 0060](0060-v3-f3f-retag-audit-and-apply.md) decisions 1.6 and 3
  (status-tag spellings, suggestions) and departure 3 (the read-back, as amended by fix C).

## Context

The owner asked for a third independent review of everything merged after the second (splits, renames, retagging,
selective approval, Resume, the block-id sweep and the second review's own decisions), with three fixes of their own:
a clean shutdown on SIGTERM (A), the memory of the largest jobs (B) and an honest retag read-back (C). Most of the
review's fixes make an existing rule hold on every route. These go further than a rule as written, or leave a choice
that is the owner's.

## Part A: chosen by this review's fixes (built; the owner confirms or reverses)

1. **A split's phase 1 is reverted whole or not at all** (R3-09, R3-10). The source's edit and each destination's write
   are the two halves of one move. A confirmed partial revert took the moved blocks off the destination while the
   source (changed since, by a later edit or phase 2's archive note) stayed without them: the moved sections were on no
   live page, and the deletion proposal that followed said they were back. Now Revert refuses a split's phase 1 when any
   target cannot go back (`SPLIT_REVERT_NOT_WHOLE`; the preview says `wholeOnly`; the Review page offers no partial
   revert for it), naming what to do (put those targets back as the split left them; a source phase 2 archived is
   unarchived first). And a page the split made is proposed for deletion only once the material it took is read back in
   the source, block by block, by content. Alternative: keep partial reverts, coupling each item's source edit and
   destination write (larger; not recommended now).
2. **"Propose these again"** (ADR 0058 decision 2.5): only once the approved part has run to the end (`executed`), not
   while it runs or after it failed (R3-14: the left-out items lost their dependency on what had not run yet, such as
   the subject's new name or an unapproved pack version); one at a time (`REPROPOSE_RUNNING`, R3-16); never for a split
   or a retag batch (`REPROPOSE_REFUSED`, R3-15: the old plan names blocks the first job moved, and a retag re-proposal
   was an untracked job): the way on is a new split of what is left, or a fresh audit. It now puts back the routing
   lines the partial approval left out of the index (R3-37) and treats the pages the approved part made as made
   (R3-43).
3. **Resume and step Retry** (ADR 0058 decision 3): an approved job is resumed only while its proposal is `failed` (or
   `executing`), never once the owner rejected it (R3-13); a split's destinations check runs again with its first check
   (`resumable.recheckCheckers`, R3-22); a job reverted, being reverted, or whose revert stopped part-way is never
   continued, by Resume or by a step Retry (`REVERT_STOPPED`, R3-45).
4. **Splits** (ADR 0059): an existing owner's second (or later) append is core once an earlier append of the same item
   has landed (the job stops, resumable, instead of skipping the item part-way and leaving its blocks in two places,
   R3-23); an image assigned as universal material is refused by the visual audit (universal material is removed, not
   moved, R3-11); a source holding an inline icon is refused before anything is made (`SPLIT_NOT_WRITABLE`: the split
   writes the source back whole, R3-51); "moved verbatim" is checked on the whole block, not its words (R3-17, R3-18).
5. **Retagging** (ADR 0060): a second spelling of a status or lifecycle tag (`canon`, `ＣＡＮＯＮ`, `" AU"`) is a status
   hold, never removed as a duplicate, and a token map or Excluded Routine Tag that names one is never used (R3-06,
   R3-07); one suggestion per page from each principal, the newer replacing the older (R3-47).
6. **One check step holds at most 5,000 entries** (was 400; R3-01): a heavily referenced character (700 pages) could not
   be renamed. A pack plan beyond it is refused plainly (`STEP_TOO_LARGE`) before it is submitted or proposed.
7. **The restart (the owner's fix A).** On SIGTERM the bridge answers new requests 503 "the bridge is restarting",
   lets requests already sent to LegendKeeper finish (at most 10 s), stops each running job at its next step boundary
   (never part-way through a write) and records it queued, to continue when the bridge starts; ends every wait for
   budget, pacing, a lock or a retry's back-off at once; closes the database and exits, with a 25-second watchdog.
   `TimeoutStopSec=75` in `deploy/lk-bridge.service` is the cushion. Measured in the tests: 1.5 s with a write in
   flight for 1.5 s, 4 s with the block-id sweep's 4-second request in flight, under 0.1 s with nothing in flight
   (section 5 of the review).
8. **The retag read-back (the owner's fix C)** compares each page document's own version (`getDocumentBlocks`, one read
   a document), not only getResource's metadata: "written and read back: the tags exactly as proposed; name, aliases,
   parentage and sidebar unchanged; each page document's body at the same version as before the write; other documents
   (board, map, timeline) compared by their metadata timestamps only, not their content". A body that cannot be read is
   reported as a difference, never taken as unchanged.

9. **A large job waits for the budget instead of starting over** (R3-62, amends CR-2026-11-R2's R2-29 re-check). A
   check's or a read-back's reads, in a job holding no job-level lock, wait in their queue for the budget however long
   it takes (behind higher priorities; a cancel, a pause or a restart ends the wait). After a wait before its first
   write, a check of more than 300 estimated reads runs again light (its governance checks only, its result kept); a
   smaller one runs again whole, as R2-29 decided. Alternatives: (a) as built; (b) refuse a plan whose check needs more
   than about a third of an hour's budget (a 700-page rename could then not run at all); (c) split large checks into
   steps (a planner change for every pack tool).

10. **A split never leaves a multi-owner character without a Character Core** (R3-66, the owner's report; amends ADR
    0059 decisions 2.1 and 3.2, the new owners by F3a's rules, and 6.2, Revert). A Compact Character Reference the split leaves at the head of several owners is
    upgraded in place in the same canonical proposal (F3a's `upgradeToCore`), every new owner needing that upgrade;
    any other such map is refused (`SPLIT_CORE_REQUIRED`). Revert of such a split leaves the Core rename to the deletion
    proposal of the pages it made (canon, approved as canon), after them, and only when every page the split made goes.
    Alternative: refuse every such split until the owner upgrades the Reference first (more steps for the same result).
11. **A split is verified only by its job's verification** (R3-67, the owner's report; amends ADR 0059 decisions 3.10
    and 4, the verification and what triggers phase 2), and the generic verify compares a mention by its target (`resourceId`, `documentId`), its `name`
    and `text` being display fields LegendKeeper fills in (amends the ignored fields of ADR 0031 and ADR 0032's generic
    verify). A job that ran to its end but read back a difference leaves the split `unverified` (new state, migration
    3800): nothing is retired. Consequence: a mention's custom label is no longer compared by the verify (LegendKeeper's
    API cannot change a label anyway; the appraisal still reports labelled routing lines). A read-back's property names
    the Last Major Revision row a step of the same job dates (`datedRowId`), which that step judges. A split resumed
    after a write that read back a difference stays `unverified` (part B, decision 6).

## Part B: the owner's decisions (open findings; their tests are kept as `it.fails`)

1. **Text emptied through a raw route** (R3-53: `lk_api_write` `replaceDocumentBlocks` keeping every id, or
   `lk_api_batch` `updateBlock`, emptied a pack page's text directly; `write_page` refuses the same with
   `USE_ARKONA_SPLIT`). The deletes rail compares block ids only (ADR 0057 decision 4). Options: (a) leave it: the write
   is direct, journalled, on the Review page and revertible; (b) the deletes rail counts a low-level write that takes
   the pack's `guardWords` words or more off a pack page as a removal (a proposal); (c) as (b) on any page.
   Recommended: (b).
2. **The split guard counts per edit** (R3-52: two `write_page` edits of 100 words each took 200 words off one page).
   Options: (a) leave it (the guard steers agents; it is not a security boundary, and the edits are on the Review page);
   (b) count the words a connection takes off one page over a day. Recommended: (a), with Part B decision 1 (b).
3. **Whose cancel a Resume may undo** (R3-54: the owner cancelled an agent's direct job part-way; the agent resumed it
   with `bridge_job_resume`). Options: (a) leave it; (b) record who cancelled, and refuse an agent's Resume of a job the
   owner (or the system) cancelled. Recommended: (b).
4. **The rails at Resume** (R3-55: a job stopped, the owner switched "renames and moves" to always propose, the agent
   resumed and the rename ran directly). ADR 0055 C3 judges the rails when a request arrives. Options: (a) leave it
   (lowering the scope is the brake, ADR 0057 decision 6); (b) an agent's Resume judges the rails again on the steps
   left, and a step they now cover makes the rest a proposal. Recommended: (b).
5. **Revert of a retag batch, a page renamed or moved since** (R3-57: its tags as the job left them, so it was
   reverted). ADR 0060 decision 3.6 says "only where the page is as the job left it". Options: (a) the tags are what the
   job left (as built); (b) also its name and parent. Recommended: (b).

6. **A resumed job's verification** (from R3-67's fix: a split is verified only when its job is). A job stopped by a
   write that read back a difference keeps that difference in its verification after Resume, even once it is put right
   by hand: a split resumed so ends `unverified`, and phase 2 is the owner's (`archive_page`); before R3-67 the split
   said "verified" and proposed it. Options: (a) as built; (b) Resume reads each such write back again before it
   continues, and one that now reads back as planned counts as verified ("put right since", said in the job's result).
   Recommended: (b).

Left open as low findings for the next slice, not decisions: R3-56 (a rename's re-placing moves are not re-anchored for
names left out, and are computed against a simulated order), R3-58 (`lk_api_write`'s rename steering reads the tree's
stored sidebar; unknown, it does not read the page), R3-59 (`arkona_appraisal_fix`'s name fix is not steered) and R3-60
(the token check is not repeated inside the tag writes' locks).

## Consequences

One migration (`3800_split_unverified.sql`: the split state `unverified`). Every part A change has a regression test
that fails on the reviewed code. Agents see new codes: `SPLIT_CORE_REQUIRED`, `SPLIT_REVERT_NOT_WHOLE` (the owner's, on
the dashboard), `SPLIT_NOT_WRITABLE`, `STEP_TOO_LARGE`, `REPROPOSE_REFUSED`,
`REPROPOSE_RUNNING`, `REVERT_STOPPED`, `PROPOSAL_NOT_APPROVED`, `FROM_NOT_A_FORMER_NAME`, `RETAG_STALE` and
`BRIDGE_RESTARTING` (503 while the bridge restarts).
