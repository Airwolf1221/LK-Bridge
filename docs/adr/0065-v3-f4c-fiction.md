# ADR 0065: v3 F4c: fiction (the narrative layout, tools and audit)

- Status: **Proposed** (v3 F4c, 20 November 2026). It builds the owner-approved design
  [design/F4c-fiction.md](../design/F4c-fiction.md) (APPROVED 20 November 2026: E1 to E10 as written), copied into the
  repository unchanged as this session's first commit. Where the design was silent the choice is marked **chosen**, for
  the owner to confirm.
- Every decision is implemented and tested against the mock LegendKeeper and fixtures modelled on the live repository as
  the owner described it on 20 November 2026 (`test/narrative/world.ts`), never fetched. Nothing in this session touched
  a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip
  script. The sandbox check below is written, not run.
- Builds on [ADR 0063](0063-v3-f4a-governance-drift-names-and-briefs.md) (`arkona_brief`, `arkona_name_check`, the
  governance audit's equivalence map), [ADR 0064](0064-v3-f4b-consistency-and-as-of.md) (`arkona_as_of`, the facts index,
  the calendar reading), [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md) (items, selective approval),
  [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md)
  (packs as data, pinned governance), [ADR 0053](0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md)
  (lifecycle tags), [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (the audits' "Propose a fix", the
  ordering rule), [ADR 0055](0055-write-scope-review-revert-rails.md) and [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md)
  (write scope, Review, the rails) and [ADR 0062](0062-dashboard-sessions-and-step-up.md).
- Migration: **none** (the narrative layout is pack data; the audit's findings use the existing store).
- Pack version: **`arkona-2026-11-20-f4c`** (`rules.narrative`, the narrative tools' switches, `plan-baisheng-stories` in
  the equivalence map, the two fiction Design References pinned). It supersedes `arkona-2026-11-20-f4b`; the owner
  approves it on the Packs page. Until then the narrative tools are not listed, the narrative audit reports nothing and
  Narratives is ordinary repository content.
- Numbered 0065, the next free number.
- **Write scope: no issue found.** The writing tools are direct at scope `write` exactly as the design's E5 says (routine
  narrative organisation, 32B), on the Review page and Revertible; every narrative job declares its pages as having no
  lifecycle (a marker with `to: null`), so the lifecycle guard still refuses any lifecycle change, and the canon guard
  still judges every write. The audit's fixes are always ONE proposal. The reading tools write nothing; promotion is a
  canon proposal at every scope (a character or page made Authoritative, facts and texts `forceProposal`).

## E1, E9: the layout as pack data

1. **`rules.narrative`** (`src/packs/types.ts`, seeded in `src/packs/arkona.ts`): the index names (Narratives,
   Continuities, Main CANON), the reserved word (`CANON`), the Continuity values meaning the main continuity
   (`Main CANON`, `Main`), the Continuity Type values (`CANON`, `AU`), the name patterns (`Story Map`, `Act {n} Map`,
   `Chapter {n} Plan`, `Act {n} - {Title}`, `Chapter {n} - {Title}`, the Chronology Map's names), the four templates by
   name, the tags (including `Flashback`), the fields by name, the Question Gate's and Planning Status's values, the
   plan sections the reading tools return, the dateline's separator (`·`, spaced), the placeholder patterns, the
   new-lore cap and the capitalised words that are never names.
2. **Pinned governance by name** (E9). A governance source may now name its page instead of its ids (`page`): the page
   of that display name in the project's tree, **any dash and any spacing** ("Arkona – …" and "Arkona - …" are one name),
   its page document read (`src/packs/find-page.ts`). Pinned: the Workflow's "LegendKeeper Planning and Manuscript
   Structure" and the Fiction Writing Reference's "32B. Durable Chapter Persistence in LegendKeeper". **Chosen:** the
   pin is the full heading as the handoff quotes it; if the page's heading differs, approval refuses with the page's
   outline and the owner re-maps the pin on the Packs page (ADR 0052 amendment), as for every pin. On a seed upgrade a new
   source found by name takes the project the stored sources share. The governance drift audit still reads only the
   governance root's tabs (the by-name sources are Design References pages).
3. **The order inside Narratives** (E1): the Story Map (or a continuity's Chronology Map) first; then acts and chapters by
   NUMBER (Act 10 after Act 9), act indexes before chapters; plans under their maps by number; anything else after them
   by the ordinary rule (`src/narrative/names.ts`). The registry asks the runtime for a parent's own order
   (`setSiblingOrder`, from the approved rules), so every tool that places a page in Narratives uses it (the creates,
   `move_resource`, renames); the ordering audit uses it for every parent inside Narratives (pages included: a Story Map,
   an Act Map), and "Propose a fix" moves a page into its narrative place. Directly under Narratives the ordinary rule
   holds (**chosen**: the continuity indexes stay alphabetical).

## E2: narrative pages

1. **Classified by where they sit**: everything under the one Narratives index (Narratives itself is not a narrative
   page). **Chosen: indexes keep `[INDEX]`** (a continuity, a story, an act): every index in the repository carries it, and
   the tree, the ordering rule and the tools recognise indexes by it; pages (the maps, plans, chapters, the Chronology
   Map) carry no prefix. The design's "no [BSRC] or [BWRK] prefix" is kept exactly.
2. **Tags**: `Narrative`, the kind, `AU` in an AU's continuity, set by the tools; any other tag (`Flashback`) kept after
   them; a template's own status tag (the Chapter template's `Working`) never copied (the tools set the tags).
3. **Exempt**: the owner body rules, the completion gate and the split triggers (the appraisal: `NARRATIVE_EXEMPT` for a
   page, skipped in a branch), the tagging grammar (`arkona_retag_audit`: excluded, `narrative`), the audits' rules, tags,
   lifecycle and unclassified checks (`ownedPages`), and the lifecycle tools (`NARRATIVE_NO_LIFECYCLE` from
   `promote_page`, `archive_page`, `unarchive_page`, `move_to_working`; **chosen**: unarchive too).
4. **Never authority**: the consistency check's facts index is handed the appraisal's overlay WITHOUT the pages under
   Narratives (`src/narrative/authority.ts`), so no birth, death or identity fact is ever taken from a story; the
   consistency code itself is unchanged (the F4b.1 session owns it). `arkona_brief` refuses a narrative page
   (`NARRATIVE_NOT_AUTHORITY`) and never lists one as an owner, dependency or source. Tested: a chapter stating a birth.
5. **`create_resource` under Narratives** (**chosen**, E2's "the narrative templates' naming pattern applies none"): no
   prefix, no status (refused if given), the narrative tags, placed in the narrative order. This is how the optional
   Chronology Map is made (no tool of its own).

## E3: templates

Read by name; fields by name. **Chosen**: a field a tool NEEDS (Chapter Number and In-world Date on a chapter; any
field the caller gives a value for) that the template lacks is a refusal, `TEMPLATE_MISMATCH`, naming it; a field the tool
would fill but the caller did not ask for (Story, Act Number, Planning Status on today's generic Working sidebars) is
skipped and listed (`fieldsNotOnTemplate`). The Status field of the generic Working sidebar is never written (narrative
pages have no lifecycle). **Chosen**: the plan's working title is kept in its Subject field (the generic sidebar's only
place for it), and a new plan's Question Gate starts `Open`.

## E4: continuity indexes

The narrative audit reports a missing Main CANON (`narrative_main_index_missing`) and an AU defined under Continuities
with no index under Narratives (`narrative_au_index_missing`), each with "Propose a fix": ONE proposal making the index
(named as the AU, tagged `Narrative` and `AU`). **Chosen**: an AU's name is its definition's subject (its display name
before " - "); an index under Narratives that is neither is `narrative_unknown_continuity`. `arkona_story_create` refuses
a continuity index that does not exist (`CONTINUITY_INDEX_MISSING`), pointing to the audit.

## E5: the writing tools

`src/mcp/tools/narrative.ts`, `src/mcp/tools/narrative-support.ts`. Each tool's switch is pack data (`scope` in the seed;
the owner may set `propose`); at scope `write` a direct job, at `propose` a proposal; more than 10 pages meets the bulk
rail (tested with a token keeping the default rails: ONE proposal of 14 items).

1. **`arkona_story_create`**: the story index, the Story Map, the act indexes and Act Maps, one job, placed in the
   narrative order (a new parent's children too). Continuity Type and Continuity are written where the template has
   them.
2. **`arkona_chapter_plan`**: creates under the act's Act Map (or the Story Map), or updates the plan of that number
   (one sidebar read; a plan in another act is `PLAN_ELSEWHERE`). **Chosen**: `questionGate` (`open`/`closed`) closes the
   gate after the questions are answered (the Workflow's Question Gate).
3. **`arkona_chapter_save`**: the dateline is written by the tool as the first line (`<In-world Date> · <place>`); an
   agent's own dateline (a first line that is a date the calendar reads, with at most a place, no sentence end) is
   replaced and named in the answer. The date must be read WHOLE by the calendar engine (`DATE_UNREADABLE` lists the
   accepted forms). New: the chapter from the Chapter template with its fields and collections (a character's name takes
   the character rule: its Core), its text (bound to the copy's main document, as a package's), the plan's Chapter and
   Planning Status (`Drafted`). Existing: **`baseVersion` is required** (without it the number is "taken":
   `NUMBER_TAKEN`, the design's refusal of a number another chapter holds), the document is read fresh and replaced in
   place (`VERSION_CONFLICT` when stale), its fields updated, a new title renames it; one resource and one document.
   The Drafting Gate: the plan's Question Gate read live; `Open` refuses (`QUESTION_GATE_OPEN`) unless
   `overrideGate: { reason }`, whose reason goes in the job's title, so the Review page shows it; no gate field on the
   plan: not enforced, and said so. **The read-back** (32B): after the job, the chapter's document read again and its
   words compared with what was sent (`readBack: { matches, words, firstDifference? }`). **Chosen**: `act` that does not
   hold the number's position is `ACT_POSITION`; with acts and no `act`, the one act that fits is used, else
   `ACT_REQUIRED`.
4. **`arkona_chapter_insert`** and **`arkona_chapter_move`**: every later chapter and plan renumbered (names and
   Chapter Number), as ONE job of items (one per page: its check, rename, move, Chapter Number), renamed away from the gap
   first so no two pages ever share a name. **Chosen**: insert makes the new chapter's **Chapter Plan** at the position
   (Question Gate Open), not the chapter: a chapter needs its date and prose, which `arkona_chapter_save` gives. Move
   re-places the moved chapter (and its plan) by number, in its new act when its position or `act` says so. "Through the
   rename engine" is taken as F3d's items and selective approval; mentions follow because LegendKeeper's mentions point
   at pages; prose is never changed. Planning yields to the event loop every five pages (R3-64; tested).
5. **Locks** (**chosen**): a revision holds the chapter and its document (and the plan) for the job; a new chapter holds
   none at job level (its text binds to the copy's document when it exists, as a package's does), each write its own; a
   renumbering holds every page it renames and the new plan's parent.

## E8: the Narrative Integrity audit

`src/audits/checks/narrative.ts`, category `narrative`, codes `narrative_*` (docs/audits.md lists all 25). From the
snapshots; a chapter's first block's text is kept in its scan (`firstText`) for the dateline. Mechanical fixes only, each
ONE proposal re-read live first (`src/audits/fixes.ts`, kind `narrative`: `index`, `tags`, `link`, `dateline`; plus
`set_facts` for a Chapter Number and `move_resource` for a Story Map not first). **Chosen**: a number held by a plan but
no chapter is not a gap (a planned chapter); an act layer is empty only when its act holds no chapter AND its Act Map no
plan (a story planned but not yet drafted is not ceremonial); a backwards date compares each chapter with the one before
it in number order; placeholder text is pack data (patterns such as "Link to the …", "Exact or an approximate range").

## E6: the reading tools

`src/mcp/tools/narrative-read.ts`.

1. **`arkona_chapter_context`** (free: the snapshots through the appraisal's reader, the tree, the calendar; `live: true`
   reads the pages now): the date (In-world Date, else the plan's Planned Date); `arkona_as_of` (in the story's
   continuity) for the POV and Characters Present; `arkona_brief` for each of them and each Location (at most 12);
   **chosen**: the chronology rows and the open contradictions are those the as-of answers give for its characters (a
   general window around the date is not added); the plan's Canon Constraints and Question Gate; the previous chapter's
   last section (or its last three blocks) and its plan's Closing State. Every part says its evidence class; the plan and
   earlier chapters are "narrative (never canon)".
2. **`arkona_chapter_check`** (read-only; **chosen**: the chapter is read LIVE by default, 2 reads, since it is checked
   right after a save; `live: false` reads the snapshots): people through the as-of states (not yet born and recorded
   deceased are `Contradicts canon`; nothing recording them alive is `Unestablished in canon`); **chosen**: presence
   (listed but not in the prose, in the prose but not listed) is its own list, `presence`, unlabelled, since it is about
   the chapter's own sidebar, not canon; births and deaths written in the prose by the pack's prose phrasings (by name,
   never a pronoun) against the as-of values (`Contradicts canon` when the spans cannot both be true, `Not in canon
(candidate)` when canon records none); ages by `rules.consistency.ages` when the approved pack has them (see "Waiting
   for F4b.1"); names: F4a's run reader (`capitalisedRuns`) per sentence, the sentence's first word dropped, resolved
   against every page's names, subjects, aliases and Canonical Display Names, every current character's names and name
   parts, the pack's `notNames` and the calendar's month and era words; a name resolving only to Archived or Legacy
   Canon Archive pages is `Unestablished in canon`, one resolving nowhere `Not in canon (candidate)` (capped at
   `candidateCap`, the rest counted); Locations gone (`Not in canon (candidate)`) or only Archived. An AU chapter's as-of
   is asked in its AU.

## E7: promotion

`arkona_promote_from_chapter { chapter, candidates: [{ candidate, as, … }] }` (at most 20). **Chosen, the shape**: a
list of candidates, so several can be offered at once. `character` and `page` go through `arkona_create_character` and
`create_resource` themselves, called with `status: "authoritative"` (so a canon proposal whatever the scope; the
character tool's namesake warning is carried); each is its own proposal. `fact` and `text` (on an existing owner page) are
planned as `set_facts` and `write_page` plan them (`append_to_section`) and submitted as ONE proposal of items
(`forceProposal`), so the owner accepts some and rejects the rest. The chapter is cited in each proposal's note:
**chosen**, the proposal's summary (the line the owner reads), through a new `annotate` of a pending proposal (no
migration); never a Dependency or a Related Source. The agent supplies every value; nothing is taken from the prose by
the tool, and nothing is ever applied by itself.

## On top of F4b.1

The coordination of 20 November 2026: the F4b.1 session owned `rules.consistency` and the extractor and comparison code.
Once it was merged to main (ADR 0064 amendment 1), main was merged in (not rebased) and these were added on top of its
pack seed; `arkona-2026-11-20-f4c` supersedes `arkona-2026-11-20-f4b1` (approving it covers both). The extractor and the
comparison code are unchanged; everything below is pack data or `arkona_as_of`.

1. **Ages** (`rules.consistency.ages`): "<Name> is / was <n> (years old)" and "<Name>, aged <n>", by a name only, read by
   `arkona_chapter_check` against the elapsed calendar years (a number outside the as-of range is `Contradicts canon`;
   no birth recorded is `Unestablished in canon`).
2. **The bare-range attested phrasing** (the owner's F4b decision 6): a Temporal Scope clause that is only a range of
   dates, "5A 900 - 5A 931" (Tsubame Hoshizora's), reads as attested bounds (`attested.scope.range`). Attested bounds are
   still never compared. The coverage report counts such characters under attested bounds (six of F4b's fixture
   characters moved there from "nothing readable").
3. **"Deceased by <date>"** (the owner's ruling from F4b.1's review; `rules.consistency.deceasedBy`): a Life State clause
   "Deceased by <date>" (or "before") is an upper bound on death read by `arkona_as_of` only: at or after the bound the
   state is "Deceased (recorded by <date>)", with `deceasedBy` (value, precision, the Life State it comes from); before
   it, the other rules apply. It is never a fact: F4b.1's reading ("Deceased by" is never a death date; "exact death date
   unestablished" a gap) is kept, and the consistency check never compares it (Jahan-Timur).
4. **D9 in `arkona_as_of`**: in an AU with no identity page of its own, the attested life and the Life State are
   inherited from Main CANON with the birth and death (F4b inherited only the birth and death values), and a state decided
   by inherited values is labelled "inherited from Main CANON" (`state.label`). Rashad al-Khalid is Alive (recorded) in
   Moonfall, labelled; Harun al-Saffar Deceased (recorded), labelled.
5. **D7 amended (the owner's ruling, 20 November 2026)**: a Life State whose principal part is one of
   `rules.consistency.aliveValues` (Arkona: "Alive") records the character alive at the pack's present, so with a recorded
   birth the character is Alive (recorded) from just after the birth to the present ("between the recorded birth and the
   present (5A 931): the Life State records the character …"); with none, at the present only. Never before the birth,
   never past the present, never against a recorded death. Read by `arkona_as_of` only, never compared. This resolves
   decision 10 below: Yasmin al-Naim (born Camue 1st, 4A 100 in Main CANON, Life State "Alive") is Alive (recorded) at 4A
   120 in Main CANON and, labelled "inherited from Main CANON", in Moonfall. F4b's test that Titania was Unestablished at
   4A 100 now reads her Alive (her Life State is "Alive"); before her birth she is still Unestablished.
6. **The guard on that ruling (the owner, before merge): a recorded death always wins inside its own span.** When a
   death is recorded before the present and the current Life State records the character alive (a rebirth, a
   reincarnation, a return: Mehrana al-Khalid's incarnations, Nahla's Sidhe rebirth, Yue Bailu's Kitsune rebirth),
   `arkona_as_of` reads the identity page's dated deaths and starts: before the first death, the other rules; from a
   death to the next recorded birth or return, "Deceased (recorded)"; after the last death with no return after it, up to
   the present, "Unestablished (recorded death; current Life State Alive)", never "Alive (recorded)" across the gap. A
   return is recorded by a new Temporal Scope phrasing, `attested.scope.return` ("Reborn / Returned / Reincarnated /
   Resurrected <date>"), as an attested start of life (`bound: from`), so it is never a second birth and never compared.
   **Chosen**: after a recorded return, the Life State carries the life from the return to the present ("Alive
   (recorded)", "between the recorded return and the present"); a date that straddles a death or a return is plain
   Unestablished. In an AU with no identity page of its own, Main CANON's deaths and returns are used and the state is
   labelled "inherited from Main CANON". Fixtures: two stand-ins modelled on those characters (a death with no return; a
   death and a return), in Main CANON and inherited into Moonfall.

## Guidance and docs

`get_bridge_guide` gains the part "Arkona fiction" (the layout, the tools, the Drafting Gate, and the Workflow's working
sequence: `arkona_chapter_context` → the Question Gate → draft → `arkona_chapter_save` → `arkona_chapter_check` →
`arkona_promote_from_chapter`) and a line in "How to decide"; docs/tools.md, docs/audits.md and the CHANGELOG describe the rest. `plan-baisheng-stories` maps to the narrative
tools in the governance audit's equivalence map.

## For the owner

1. Indexes keep `[INDEX]` (E2 decision 1); pages carry no prefix.
2. Fields: needed fields refuse, others are skipped and listed (E3); the plan's title in Subject; a new plan's gate Open.
3. `arkona_chapter_insert` makes the plan, not the chapter (E5 decision 4).
4. A revision needs `baseVersion` (otherwise the number is "taken").
5. The audit's narrower readings: a planned number is not a gap; an act is empty only with no chapter and no plan.
6. `unarchive_page` refuses narrative pages too; `create_resource` makes narrative pages (no prefix, no status).
7. Continuity indexes directly under Narratives stay alphabetical.
8. `arkona_chapter_check` reads the chapter live by default; presence is its own unlabelled list.
9. Promotion takes a list of candidates; the citation is appended to the proposal's summary.
10. Resolved (see "On top of F4b.1", 5): D7 amended so a Life State of "Alive" records the life up to the present;
    Yasmin is Alive (recorded) in Moonfall at 4A 120, inherited from Main CANON. The six fixture characters with a bare
    range now count as attested bounds.

## The sandbox check (written, not run)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- narrative-f4c`
(`test/sandbox/narrative-f4c.test.ts`): on the test world, Narratives found by name and Main CANON found or made (with
the raw client), a throwaway story with one act, two plans and two chapters (each read back word for word), a chapter
inserted at 2 and the renumbering read back live, the check and the audit, and clean-up of everything it made. It needs
`arkona-2026-11-20-f4c` approved.
