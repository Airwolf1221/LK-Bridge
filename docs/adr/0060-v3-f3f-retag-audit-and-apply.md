# ADR 0060: v3 F3f (retagging): `arkona_retag_audit`, `arkona_retag_apply`, owner classification and reconciliation

- Status: **Proposed** (v3 F3f, 19 November 2026). It builds what Arkona's Controlled Native Tagging Standard asks of
  the Bridge (its "Bridge and Audit Interface" and its "Classification and Manual Implementation Procedure", read live by
  the owner on 19 November 2026 and quoted in the brief). Every decision is implemented and tested against the mock
  LegendKeeper and fixtures; nothing in this session touched a live system (no LegendKeeper, no bridge connector, no
  dashboard, no sandbox, soak, spike, rehearsal or round-trip script). Where the brief left room, the choice is marked
  **chosen**; where the build departs from it, the departure is listed with its reason ([Departures](#departures)).
- Builds on [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) with its F3b.1 amendment (the tag engine
  `computeTags`, the closed grammar, the token maps, pinned governance), [ADR 0053](0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md)
  (the lifecycle tag leads; AU in the lifecycle tools), [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md)
  (the snapshot overlay, the audits' tag findings), [ADR 0055](0055-write-scope-review-revert-rails.md) and
  [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) (write scope, Revert, rails), [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md)
  with F3d.1's amendment (items, selective approval, Resume; mention labels cannot be changed through the API) and
  [ADR 0059](0059-v3-f3e-splits.md).
- Amends [ADR 0055](0055-write-scope-review-revert-rails.md) (Revert applies to a retag batch although the owner approved
  it, as ADR 0059 did for a split's phase 1), [ADR 0044](0044-audits.md) (on a project whose approved pack has retag rules,
  the tags audit's findings come from the retag engine) and [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md)
  (a pack tool records the pages it makes) and the routing-line writers of ADRs 0050, 0052, 0053 and 0059 (plain
  mentions).
- Migration: `3700_retag.sql` (Resume learns a fifth kind of job, `retag`; `pack_page_records`; the owner's
  classifications and agents' suggestions; audit runs and their verdicts; apply batches; reconciliations).
- Pack version: `arkona-2026-11-19-f3f` (the retag rules as data, the retag apply's "always propose" switch, and the
  Tagging Standard's "Excluded Routine Tags" pinned). It supersedes `arkona-2026-11-18-f3e`; the owner approves it on the
  Packs page before either retag tool works.
- Numbered 0060, the next free number.

## Context

The Tagging Standard: "The rebuilt Bridge should take this current standard as the human-authoritative policy and may
maintain a versioned machine-readable translation, explicitly identified as derived and never a competing source. Its
intended workflows are dry-run preview, read-only policy audit, separately approved guarded apply, and resumable
reconciliation… The Bridge must not generate unknown tag tokens from metadata/body strings. It must use exact approved
category/function and race/culture mappings, distinguish typed race from culture even where the visible token is reused,
fail closed on uncertain categories, and compare policy version/digest before writing. Owner and template changes may
trigger targeted rechecks; a completed earlier audit is not a permanent assertion of current state."

## Decision 1: one engine (src/packs/retag/engine.ts), pure

`retagPage(page, context)` gives a page's verdict: its resource ID, current array, proposed array, a rationale for each
slot (which fact, record or rule), its holds, its exceptions and removals, and its disposition (`compliant`,
`correction`, `hold`, `exception`). The array comes from F3a's tag engine (`computeTags`) with the APPROVED pack version's
rules, so a page a pack tool made and the retag agree by construction.

1. **Scope.** The automatic grammar applies to current Authoritative pages (`[BSRC]`, Status Authoritative) whose
   Continuity Type is CANON with Continuity Main, or AU (the owner's ruling of 16 November 2026: `AU` in place of
   `CANON`). Working and Archived pages are checked only for the lifecycle grammar, by the lifecycle check's own
   function (`leadingProblem`) and finding (`lifecycle_tag_not_leading`), reused, never duplicated. Navigation indexes,
   the governance sources' pages and the excluded areas (the pack's `retag.excludedAreas`: the Legacy Canon Archive, the
   Design References, repository governance; and the lifecycle setting's canon-exempt indexes) are never retagged by
   inference. **Chosen:** an Authoritative page with no (or a contradictory) Continuity Type is a hold (the grammar's
   applicability cannot be told), and one in another continuity is excluded.
2. **The primary category, from deterministic evidence only.** In order: the owner's confirmed classification (C);
   else the page's own pack record (decision 6); else its current tags when they hold exactly one valid primary
   category (a second primary tag read as that category's specialist, as `Character, Relationship` is) and its Reference
   Type does not contradict it. The Reference Types the pack fixes (a Character Core, a Compact Character Reference,
   Character Art, a joint relationship, the race roster's) say which category, and which specialist, they belong to;
   any other Reference Type contradicts nothing. Two sources that disagree, or none, is a hold: "uncertain category;
   owner classification needed". A name, a parent or the body is never evidence.
3. **The specialist**, on the closed list for that category and backed the same way (the classification, the record,
   exactly one specialist tag that the Reference Type does not contradict); otherwise it is omitted, with a hold. A
   Character page with no specialist is an identity page only when its Reference Type is eligible (the identity roles'
   Reference Types and the pack's `retag.identityReferenceTypes`); otherwise its specialist needs the owner.
4. **Identity tokens**: Race / Species through the race map (and the exceptional kinds), Naming Culture through the
   culture map, each typed: a culture never borrows the race map, so a race token given as a Naming Culture with no
   culture entry is a hold. The same token from both is kept once (the Standard's Otheiralth example), and the rationale
   says so. A missing, `Unestablished` (or any `never` value), unmapped or contradictory (the row more than once) value
   omits that slot, with a hold.
5. **No other tag is ever proposed.** A tag outside the grammar is removed only when the Standard's Excluded Routine Tags
   list it (`retag.excludedRoutineTags`, derived from that pinned section): a deterministic correction. Any other is an
   owner exception, kept. A duplicate is removed. A held slot's token is omitted from the proposed array (and the page is
   held, so it is never applied).
6. **Status and lifecycle tags are never added or removed.** A required status tag that is present is moved first; one
   missing or wrong (CANON on an AU page) is a hold ("the lifecycle tools' work").
7. **Disposition**: any hold makes the page a hold; else any exception an exception; else a different array a
   deterministic correction; else compliant. **Chosen:** a page with a hold is held as a whole: the array it shows omits
   the uncertain slot, so applying it would remove a tag on a guess.
8. **The policy**: the approved pack version, its governance sources' approved versions, the Tagging Standard's label
   (`v1.8`) and a SHA-256 digest of the approved rules and those versions. A pack not approved, or with recorded drift,
   computes nothing (`PACK_NOT_CURRENT`, fails closed); an approved version without retag rules is `RETAG_UNAVAILABLE`.

## Decision 2: `arkona_retag_audit`, read-only and free

A page, a branch or everything, from the snapshot overlay (the appraisal's): no LegendKeeper read. `live: true` re-reads
the pages concerned (one `getResource` each, at most 50). Each run is stored (`retag_runs`, `retag_run_pages`) with its
policy and source (the snapshots and their age); `runId` reads it again a page at a time, filtered by disposition. The
answer gives each page's resource ID, current and proposed arrays, a rationale per slot, the policy version and digest,
and its disposition. `suggest` records an agent's suggested classification for a hold, with its reason
(`retag_suggestions`): shown to the owner beside the hold, never used.

**The existing tags audit agrees.** On a project whose approved pack has retag rules, the audits' tag findings come
from the same engine (src/audits/checks/retag-tags.ts), never from the tag-definition document; the codes are kept
(`missing_required_tags`, `tags_outside_definition`, `duplicate_tags`) and two are added: `tags_out_of_order` (the same
tags in another order) and `tags_held` (the engine holds the page). Working and Archived pages stay the lifecycle
check's. A project without retag rules keeps the tag-definition document exactly as before. A2 gathers these findings
as `tag_grammar`, now a judgement naming the retag tools (there is no hand-made tag fix to hand over).

## Decision 3: `arkona_retag_apply`, separately approved and guarded

1. **Only deterministic corrections** of a stored run (`runId` and the page ids): a hold, an exception, a compliant or
   excluded page is refused (`RETAG_NOT_DETERMINISTIC`, naming each). At most `retag.batchSize` pages (25 in the seed;
   `RETAG_BATCH_TOO_LARGE`); a page already in an open batch is refused (`RETAG_PAGE_IN_BATCH`). A run made under another
   policy is refused before anything is proposed (`RETAG_POLICY_CHANGED`).
2. **Always a proposal**: the pack's switch for `arkona_retag_apply` is "always propose" in the seed (ADR 0055 decision
   D), whatever the agent's scope, because the Standard calls for a separately approved apply. Each page is an item (ADR
   0058's selective approval); the proposal holds the run, the policy and each page's arrays.
3. **The job**, in this order:
   1. `retag.policy` (also run again by Resume): the approved pack version and digest are the audit run's, and each
      governance source read now (one read each) is still at its approved version. Otherwise the whole job stops before
      any write: "policy changed since the audit; audit again" (`RETAG_POLICY_CHANGED`).
   2. Per page, `retag.page`: a fresh read. Gone or unreadable: **inaccessible**. Its classification facts changed since
      the audit: **held** ("audit it again"). Already the proposed array: **already compliant**. Its tags differ in ANY
      way from the audit's current array: **conflicted**, skipped and recorded; the job carries on. Never rebased onto
      the newer array: that would be "whole-array replacement from an old checkpoint".
   3. The write (`updateResource` with the proposed array), judged again inside the page's lock by the rebaser
      `retag.tags` on the read the write makes anyway: the same three answers, so nothing that changed between the check
      and the write is overwritten.
   4. `retag.verify`: an independent read-back: the exact array in order, and the name, aliases, parent and place
      (`parentId`, `rank`), hidden and locked flags, documents (each document's id, name, type, rank and `updatedAt`) and
      sidebar (its properties, links included, hashed) exactly as read before the write; each page document's body by
      its version (CR-2026-11-R3, fix C: see Departure 3).
4. **Dispositions** are recorded per page when the job ends (`retag_batches.dispositions`): applied (with whether the
   read-back verified), already compliant, held, conflicted or inaccessible. A page the owner left out of the selection
   gets none and remains.
5. **Last Major Revision is never set**: the job is submitted with `lastMajorRevision: 'skip'` (tags are not a major
   revision, ADR 0051).
6. **Resume** (ADR 0058): `resumable: { kind: 'retag', recheck: [1] }`; the policy check runs again first, no write that
   succeeded is sent again. **Revert** (ADR 0055, amended): a retag batch's job is revertible although the owner approved
   it (`approvedRevertible`); Revert restores each page's exact prior array from the journal's pre-image, only where
   the page is as the job left it (otherwise it asks before a partial revert, as for any job). Amended by
   [ADR 0061](0061-cr-2026-11-r3-decisions.md) part B decision 5 (the owner's, 19 November 2026; R3-57): "as the job
   left it" is the page's tags, name and parent: a page renamed or moved since is not touched.

## Decision 4: the owner's classification

On the Tagging page's Holds tab, an "uncertain category" (or specialist) hold is resolved by the owner choosing the
primary category and, if any, the specialist from the closed list (`POST /api/admin/tagging/classify`, re-authenticated,
audited `retag.classify`; withdrawn with `POST /tagging/unclassify`, re-authenticated, audited). It is stored
(`retag_classifications`) and decides the category in every later audit (decision 1.2). The service refuses any actor
but the owner; agents have no route to it and only suggest (decision 2). **Chosen:** with the owner's classification, a
second primary tag on the page is a deterministic removal (the owner decided the category); with only a pack record, it
stays a hold.

## Decision 5: resumable reconciliation

A reconciliation is a named record (`retag_reconciliations`, `retag_reconciliation_pages`): each page's latest verdict,
its last apply outcome and batch, and whether it is stale. Started (`arkona_retag_audit { reconciliation }`, or the
Reconciliation tab) with a free audit of its scope.

- **Resume** (`arkona_retag_apply { reconciliation }`, or the tab's Resume) marks stale pages, audits what remains afresh
  (free), and proposes the next batch of its deterministic corrections (at most the batch size). What remains: stale
  pages, and corrections not applied (or found already compliant) and not in an open batch.
- **Targeted rechecks.** A page's verdict carries the hash of its inputs (its facts, Reference Type, template, pack
  record, owner classification, name and tags). Whenever a reconciliation is viewed or resumed, each page's hash is worked
  out again from the snapshots (free); one that differs is marked stale and audited again before anything is proposed for
  it. An applied page records the hash it will have with its new array, so it is not stale once the snapshots show it.
  A completed run is never treated as current truth.

## Decision 6: a pack tool's record of the pages it makes

`finishPackage` (F3a's and F3b's packages: characters, owners, relationships, art) records each page with a primary
category in its grammar's tags (`pack_page_records`: the tool, type, role, primary and specialist) when the package is
captured or submitted. The audit uses a record only for a page the snapshots hold (a page left out of an approval was
never made).

## Decision 7: routing lines are plain mentions (part D)

F3d.1 found the bridge's own index routing lines were mentions with a custom label, which LegendKeeper's API cannot
change, so a rename left the old name in them. The writers now emit plain mentions (`[](lk://resources/<id>)`, the label
omitted, the rest of the line kept): F3a's drafted index text and appended routing lines (`draftIndexText`,
`routingLine`), F3b's repointed nation line (`repointRoutingLine`), and F3e's index lines (which use `routingLine`). A
plain mention always shows the page's current name.

The appraisal (A2) gains `routing_labelled_mention` (optional polish): a mention with a custom label in an index's
routing section. **Its follow-up is `none`, "change it in the app"**: LegendKeeper's API cannot change a mention's custom
label (the owner's confirmation, ADR 0058 amendment D), and a block write that drops the label is the very change the
API is confirmed not to make, so no fix is offered.

## Decision 8: the dashboard's Tagging page

In the Repository group: **Audit** (run the free audit on a page, a branch or everything; each page's arrays, rationale
and disposition; pick corrections and propose them as ONE batch), **Holds** (each hold with its reasons and agents'
suggestions; the owner's classification), **Batches** (each batch's proposal and job, and each page's outcome) and
**Reconciliation** (start, open, see the counts and stale pages, Resume). Its API (`/api/admin/tagging…`) writes nothing
to LegendKeeper; every apply is a proposal approved on the Proposals page.

## Costs (measured against the mock, pinned by the tests)

- The audit: no read (`test/packs/retag.test.ts`: the mock's request count is unchanged). `live: true`: one read a page.
- Proposing a batch: no read.
- The job: the governance (one read per source, three for Arkona), then per page three reads (the fresh read, the
  in-lock read, the read-back) and one write. A page skipped at its fresh read costs that one read.

## Departures

1. **The Excluded Routine Tags are pack data, empty in the seed.** The section is pinned (so its change is drift), but
   this session could not read it (no live system), so `retag.excludedRoutineTags` starts empty: until the owner lists
   them in a new pack version, every tag outside the grammar is an owner exception, never removed. The Packs page's
   token-map editor takes the list (`PUT /api/admin/packs/:id/tokens { excludedRoutineTags }`, a new version).
2. **"Repository governance" is named by data.** `retag.excludedAreas` holds `Repository Governance` as an index name
   (with the Legacy Canon Archive and the Design References); the governance sources' own pages are excluded by id. If
   Arkona's governance index has another name, the owner changes the list with a new version.
3. **Document versions are read from `getResource`.** The read-back compares each document's `updatedAt` (and id, name,
   type, rank) as `getResource` lists them, not each document's ETag (one `getDocument` per document): a tags write
   changes neither. **Amended by CR-2026-11-R3 (fix C, the owner's request, 19 November 2026):** Arkona's Repository
   Automation warns that "LK document metadata updatedAt can describe creation/metadata time rather than body version;
   do not claim unchanged content without suitable current evidence". So each **page** document's body is now compared
   by its real version: `retag.page` reads it (`getDocumentBlocks`, one read each) before the write and `retag.verify`
   again after it; a body that cannot be read on either side is reported, never taken as unchanged. Board, map,
   timeline and blank documents are still compared only by the metadata `getResource` lists, and the disposition says
   so: "written and read back: the tags exactly as proposed; name, aliases, parentage and sidebar unchanged; each page
   document's body at the same version as before the write; other documents (board, map, timeline) compared by their
   metadata timestamps only, not their content". Cost: two reads more per page document of each page applied.
   Amended again after the owner's sandbox run of CR-2026-11-R3's checks (X6: `getResource`'s `updatedAt` does not move
   on a content edit): board, map and timeline documents are compared by their content too (a hash of what the
   snapshots take of each: `getBoardContent`; `getDocument` and `listFeatures`; `getDocument`, `listLanes` and
   `listEvents`), read before and after the write; no timestamp is a content signal anywhere. Cost: those reads, twice.
4. **A split's new pages are not recorded** (decision 6): they get their tags from F3a's and F3b's planners inside the
   split's own job; their current tags are their evidence.
5. **The routing-line finding has no fix** (decision 7), as the brief allowed.
6. **The tags audit adds two codes** (`tags_out_of_order`, `tags_held`); the existing ones are unchanged.

## Consequences

- The owner approves the new pack version (`arkona-2026-11-19-f3f`; its pinned "Excluded Routine Tags" must be found on
  the Tagging Standard page), runs the audit, reads the holds, classifies some, approves a first small batch and checks
  its read-back dispositions.
- On Arkona, the Audits page's tag findings now come from the retag engine (`tags_held` for every hold).
- Agents are told (the tools' descriptions, the guide's "Retagging" section): audit first, holds go to the owner, apply
  is always a proposal; never retag by hand with `update_resource`.
