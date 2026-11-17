# ADR 0053: v3 F3d: the lifecycle tag leads where the pack says so, AU in the lifecycle tools and audit, the owner tool's routing lines, raw block edits measured, the canon banner in words

- Status: **Proposed** (v3 F3d, 17 November 2026). Every decision is implemented and tested against the mock LegendKeeper
  and fixtures. The owner's decisions are quoted; the choices this session made where the brief left room are marked
  **chosen**.
- Amends: [ADR 0035](0035-page-lifecycle.md) decision 8 (and decisions 9 and 10 for the tags), with
  [ADR 0037](0037-whole-set-lifecycle-and-page-scoped-ids.md) decisions 11 and 12, **only on a project whose approved
  pack says so** (Part A) or carries the AU ruling (Part B); [ADR 0036](0036-cr-2026-11-owner-decisions.md) decision 7
  (the guarded status tags gain AU under the ruling); [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md)
  "Consequences" and the F3b.1 amendment's item 3 (the two items left for later: done here) and decision 5 (the owner
  tool's routing line); [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 1, "How it is
  measured" (`updateBlock` through the low-level tools).
- Migrations: **none**. The new rule lives in the pack's rules JSON (a new seed, offered as a new version for the
  owner's approval); the rest is code.
- Numbered 0053, the next free number after F3b's 0052.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script.

## Context

Arkona's Controlled Native Tagging Standard v1.8, "Non-current Lifecycle Tags": "A substantive Working page uses name
prefix [BWRK] and a leading, exact-case native tag Working. A substantive Archived page uses … a leading, exact-case
native tag Archived … Do not emit CANON alongside a Working or Archived lifecycle tag. Preserve actually meaningful
existing subject tags in their original relative order after the lifecycle marker…" Arkona's pages follow it
(`[INDEX] Archive`: `Archived, Magic`, `Archived, Species`; `[INDEX] Working`: `Working, Character, Divinity, …`).
The four lifecycle tools (ADR 0035 decision 8) append the incoming tag (`Culture, Language, Archived`). F3b.1 tried
moving it to the front for every project, which broke six lifecycle tests, and left it for a decision. **The owner's
decision: on Arkona the lifecycle tag leads.**

F3b applied the owner's AU ruling (an Authoritative page whose Continuity Type is AU carries `AU`, not `CANON`) to the
pack tools only, so `promote_page` gave a Working AU page `CANON`, and the lifecycle audit expected `CANON` on it. The
owner was told not to promote AU pages until this landed.

## Part A: the lifecycle tag leads, on projects whose pack says so

1. **A per-project setting from the pack** (`src/lifecycle/tags.ts`, `Packs.lifecycleRules`). The pack's rules gain
   `lifecycleTagPosition`, **per project name** (`{ "arkona": "lead" }`): `lead` or `append`; a project not named is
   `append`. **Chosen with the owner (17 November 2026)**: per project rather than pack-wide, because the Arkona pack is
   attached to the test world too, which stays `append`. It is pack data, so it is versioned with the pack and applies
   only once a version holding it is **approved**: the resolver reads the approved version's rules (`PackStore.rulesAt`);
   a newer version waiting for approval does not apply. A project with no attached, approved pack gets `append` (ADR 0035
   exactly). Arkona's seed is now `arkona-2026-11-17-f3d` (superseding F3a's, F3b's and F3b.1's), offered at start as a
   new version.
2. **What `lead` writes** (`placeTags`). The incoming tag goes FIRST, taken out of wherever it stood; every other tag
   keeps its original relative order after it:
   - `move_to_working`: the status tag (`CANON`, or `AU` under the AU ruling) removed, `Working` first;
   - `archive_page`: the same with `Archived` (from Authoritative, or `Working` removed from Working);
   - `promote_page`: `Working` removed, the status tag first (Part B says which);
   - `unarchive_page`: `Archived` replaced in place, at the front, by what the target needs (`Working`, or the status
     tag).
     Whole sets (ADR 0037) alike, indexes included. The target's position is kept with the change (`tagPosition` on the
     lifecycle target, so a resume places tags as the change began); an `append` target is stored exactly as before.
3. **`append` is unchanged.** Every ADR 0035 and 0037 test runs unchanged; the `lead` cases sit beside them
   (`test/lifecycle/lead-au.test.ts`).
4. **The audit's new finding, `lifecycle_tag_not_leading`** (category Lifecycle, warning; on `lead` projects only): a
   `[BWRK]` or `[BARC]` page whose lifecycle tag is not first, or which still carries a status tag (`CANON`, or `AU`
   under the ruling). **Propose a fix** (`reorder_tags`) reorders the tags only: the lifecycle tag first, every other tag
   (a leftover status tag included) in its order, through `update_resource` with the live tags re-read and compared
   (`FIX_STALE` otherwise), checked again in the lock and verified. Nothing is added, removed or renamed, so the
   lifecycle guard sees no status tag change and the proposal is an ordinary one. **Chosen**: a page whose lifecycle tag
   already leads but which still carries a status tag is reported with no fix: removing a status tag is the lifecycle
   tools' (the guard refuses it on any other route), and the existing `lifecycle_inconsistent` finding names it too.

## Part B: AU in the lifecycle tools, the audit and the guard

5. **The status tag of an Authoritative page** (`statusTagFor`): `AU` when the page's Continuity Type is AU on a project
   whose approved pack carries the ruling (`tags.au`), `CANON` otherwise. Projects without the ruling keep `CANON`.
   - `promote_page` (and a whole set's content pages) chooses it from the Continuity Type the page keeps (CANON and AU
     are kept, ADR 0035 decision 10; anything else becomes CANON, so CANON);
   - `unarchive_page` back to Authoritative chooses it from the recorded Continuity Type it restores;
   - `move_to_working` and `archive_page` from Authoritative remove either status tag. An index (no Continuity Type)
     keeps `CANON`.
6. **The audit** accepts `AU` as the status tag of an Authoritative AU page. `AU` on a non-AU page, or `CANON` on an AU
   page, is its own finding, **`au_status_tag_mismatch`** (category Lifecycle, error; no fix: swapping a status tag is the
   lifecycle tools'). A missing status tag stays `lifecycle_inconsistent`, now naming the one expected; `AU` on a Working
   or Archived page is a `lifecycle_inconsistent` tag problem, as `CANON` is.
7. **The guard** (ADR 0036 decision 7): under the ruling, `AU` is a guarded status tag of the Authoritative state, so it
   is added or removed only by the lifecycle tools and the creation tools by their status (the pack tools' markers
   already declare their Authoritative pages); `update_resource` adding or removing it is refused, naming the tool, as
   for `CANON`. A swap of `CANON` for `AU` is caught as a removal and an addition.

## Part C: the owner tool's routing lines

8. **A routing line in the home index** (`routingChange`, F3a's, shared). When `arkona_create_owner` files an
   Authoritative owner directly into an existing home, the same proposal appends one line for it to the home's
   "How to Use This Index" section, in F3a's pattern (`- [<page name>](lk://resources/<id>): <Scope>`), with the in-lock
   re-plan. A home with no recognisable routing section gets nothing, and the preview's notes say so (as before, now with
   the reason). **Chosen**: a Working owner gets no line (it sits under `[INDEX] Working`; Source Formatting keeps a
   Working page out of a canon page's current links) and a new nation index or subindex already lists it in its drafted
   text.
9. **`promoteNation`**: the new `[INDEX] <Nation>` keeps its drafted routing text (F3b), and the Polities index's line
   that links the nation's Reference is rewritten to link the new index (`repointRoutingLine`: the link's label and
   target replaced, the rest of the line, its Scope, kept; one `replace_section` write of that section with the in-lock
   re-plan). No such line, or more than one: nothing changes and the preview says so.
10. **Last Major Revision** for the edited index is ADR 0051's rule, measured by the pack's job builder as for F3a's
    routing lines; nothing forces it. A line holds the page's name and its Scope, so a long one can reach the rule's 8
    words; that is the rule's call.
11. **Costs**: one more read to plan (the home's text; the Polities index's with `promoteNation`), and one more write
    when a line is added or repointed (`test/packs/owner-costs.test.ts`: an Authoritative owner 5 reads to plan,
    `promoteNation` 8; the fixtures hold no routing section, so the job's counts are unchanged there).

## Part D: two small items

12. **A raw `updateBlock` is measured** (ADR 0051). `updateBlock` sends only the fields it changes, so the journal kept no
    "before" and the run-time measure counted every such edit. When `lk_api_write` or `lk_api_batch` is captured as a
    proposal, the block it reads to capture is now kept as the step's journal pre-image (`journalPreImage` in the stored
    options); approval re-reads the target and ends conflicted if it changed, so the pre-image is the block as it is
    when the job runs. A typo or a KCY-only fix through the low-level tools is then judged like any other edit
    (`test/lmr/update-block.test.ts`). **Left**: a direct `updateBlock` at scope `write` with the caller's If-Match
    makes no read, so it still counts.
13. **The canon banner in words.** The Proposals page printed a lifecycle tool's marker entry as raw JSON
    (`{"lifecycle":"promote_page",…}`). It now says it from the summary the proposal holds, for example "Promote: Status
    would be set to Authoritative; name [BWRK] → [BSRC]; tags Working → CANON" (on a `lead` project "… → CANON (CANON
    first)"); a whole set as "Promote the whole set under … (N pages): working → authoritative; its root goes under …";
    a pack tool's canonical marker by its reason. The confirmation dialog says the same.

## The lifecycle tools whose tag output changed on `lead` projects

All four, single page and whole set: `move_to_working`, `archive_page` (from Authoritative and from Working),
`promote_page` and `unarchive_page`. On a project without the pack's `lead`, none changed; under the AU ruling (any
project whose approved pack carries it), `promote_page` and `unarchive_page` to Authoritative write `AU` for an AU page,
and `move_to_working` and `archive_page` remove `AU`.

## Consequences

- After deploying, the stored Arkona pack has a new version waiting (it carries `lifecycleTagPosition: { arkona: "lead"
}`): the owner approves it on the Packs page. Until then nothing changes on Arkona.
- Then the audit lists `lifecycle_tag_not_leading` for every page the bridge archived or moved to Working before this
  (`Culture, Language, Archived`); each fix is one ordinary proposal that reorders its tags.
- AU pages can be promoted once the version is approved: they get `AU`, first.
- Tests: `test/lifecycle/lead-au.test.ts`, `test/audits/checks.test.ts` and `test/audits/fixes.test.ts` (the new
  findings and the reorder fix), `test/packs/owner-routing.test.ts`, `test/lmr/update-block.test.ts`,
  `test/ui/lifecycle.test.tsx` (the banner).
