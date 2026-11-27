# ADR 0082: v3 F6d: templated source names, `<Subject> - <Role>`: the Templated Names report, `name_nontemplated` and its rename through the rename engine, run as an automation code

- Status: **Proposed** (v3 F6d, 29 November 2026, after F12). Built and tested against the mock LegendKeeper only;
  nothing in this session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run).
  The sandbox check (`f6d-names`) is opt-in and the owner runs it. Where the brief was silent the choice is marked
  **chosen**.
- Design: F6 T13, as amended by the owner on 26 November 2026: "I'm not married to the current naming conventions of my
  repository. I would much rather templated names if it will improve usability, with an existing exception for
  specialist sources that need unique naming and typing." The brief's summary is binding.
- Builds on [ADR 0076](0076-v3-f6a-reference-type-vocabulary.md) (F6a: the published vocabulary and its role words, the
  Specialist exemption, the table patterns), [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md) (the rename
  engine), [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) (automation codes) and
  [ADR 0081](0081-v3-f12-direct-writes-review-safety-net.md) (F12's division: proposals only from a `propose`-scope
  connection or the owner's automation at Propose).
- Amends: ADR 0058 (a page mode of the rename engine), ADR 0068 (a batch code: Propose one proposal per run, Apply one
  job per page), [ADR 0044](0044-audits.md) (one code).
- Migration `5000_templated_names.sql` (`templated_name_rows`, `templated_name_reports`, `templated_name_rulings`). Pack
  seed `arkona-2026-11-29-f6d` (supersedes `arkona-2026-11-28-f12`). One new per-project switch, `checkTemplatedNames`
  (default on; on the Projects page through the project settings, as F6c's three). No new environment setting.

## N1: who is in scope

Sources (`[BSRC]`, `[BWRK]`, `[BARC]`) in the AI REPOSITORY, from the audit's snapshot model (free). Never: indexes;
Narratives; the Legacy Canon Archive; the Design References; **Working's infrastructure pages** (**chosen**: a `[BSRC]`
page directly in the Working or the Archive index: an Authoritative page there is about that index, not a source of a
subject); **a registered character's pages** (**chosen**: primary category tag Character, a Reference Type of the
vocabulary's Character category, or a page under a character's repository index: the character tools name them, so an
unregistered character's page is left out too, the safe side). Left-out pages are counted by reason on the page.

**Exempt** (the Specialist exemption): a Reference Type the published vocabulary lists as an approved specialist type,
for any page of its category or for the pages it names.

`[BARC]` is in scope as the brief says, although `arkona_rename` keeps an Archived subject's name (D2): the page mode
renames an Archived page's own name (**chosen**: the owner's ruling of 26 November 2026 names `[BARC]`), and still
never edits text on Archived pages.

## N2: each page's status (pure: `src/packs/names/template.ts`)

| Status              | When                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kept`              | the owner's "Keep this name", while the Subject, the Reference Type and the full name hash to what it was made on                                                                                                                                                      |
| `held_type`         | the vocabulary is not published ("the vocabulary is not published": every row); no type; a type not canonical (it waits for `reference_type_noncanonical`); a canonical type of another category than the page's tag (it waits for `reference_type_category_mismatch`) |
| `exempt_specialist` | an approved specialist type for the page                                                                                                                                                                                                                               |
| `held_no_subject`   | Subject empty, missing or in the sidebar twice; a Subject holding an em dash ("Subject uses an em dash; fix the Subject first"); a template the pack's name rules refuse (a forbidden word, a date)                                                                    |
| `templated`         | the display name equals `<Subject> - <Role>`, case, accents (NFD, marks removed), the prefix and an ASCII hyphen versus any dash aside                                                                                                                                 |
| `held_collision`    | the full name (prefix included) is a sibling's already (F6c's guard), or another rename under the same parent would take it too: held, the reason naming the other page                                                                                                |
| `rename`            | otherwise                                                                                                                                                                                                                                                              |

- The order of the checks is the table's (**chosen**: a kept row is kept whatever else; a draft vocabulary holds every
  row before anything else is judged).
- The Subject is used exactly as written (white space collapsed); a hyphen-minus in it is fine.
- The role word is read from the APPROVED pack version's vocabulary, which once published is Source Formatting's
  section as F6a parses it; nothing is hard-coded. Decisions on the Reference Types page not published yet add no role
  word (**chosen**: "from the published vocabulary").
- The run order (the report's, the automation's): primary category, then name.

## N3: the Templated Names page

- **Built once per audit run** (**chosen**, F6a.1 and F11's lessons): the check works the report out from the run's
  context (memoised on it), and the audit service stores it in `templated_name_rows` in one transaction
  (`templatedNamesSink`). The page reads it in SQL, paged (100), filtered by status and primary category, the counts per
  status under the category filter: O(rows), never pages × rows, nothing per request is rebuilt. The rulings are laid
  over the stored rows when read (a matching hash reads `kept`), so "Keep this name" shows at once. Free; the run it came
  from and its snapshot are named; with the check switched off the report is still built (no findings).
- **Keep this name** (`POST /templated-names/keep`, a reason; audited `templatednames.keep`): a ruling tied to a
  SHA-256 of `[Subject, Reference Type, full name]` (`templated_name_rulings`); the page's open finding goes with it; it
  lapses when any of the three changes, and the page is judged again. **Undo** (`POST /templated-names/undo`; audited
  `templatednames.undo`). **Chosen**: a small table of its own rather than F5a's tag rulings (they are tied to tags).
  Neither asks for the step-up (after ADR 0081; in the route inventory). Keep is offered on rename and held rows only.
- No other decision: renames are the check's fix under automation.

## N4: the check and its fix

`name_nontemplated` (category `taxonomy`, info, switchable per project): one finding per `rename` row; held rows are on
the page only. Its fix, `templated_name` (`src/packs/names/rename-fix.ts`):

- **Stale refusal**: the page read live first; its name, Subject or Reference Type changed since the finding is
  `FIX_STALE`, nothing planned.
- **The rename engine's page mode** (`planRename` with `page: true`, ADR 0058 amended): the subject is the one page,
  the new name its whole display name. Only that page is renamed and re-placed among its siblings (the sibling guard
  `NAME_TAKEN` checked again); its Subject and every fact stay, no alias is added (**chosen**: "the id, prefix, tags and
  links stay"); every write is ONE item, `page:<id>`, so a run's proposal has an item per page. Mentions show the new
  name by themselves; **routing lines** naming the old name follow (part of the item); **every other occurrence** (another
  page's prose or sidebar, a chronology row, a custom mention label) is listed for review only (`kind: restatement` or
  `custom label`), never edited (**chosen**: nothing outside the engine's rules is edited, and an old page name in prose
  is the owner's to change). The journal carries the rename's id on every write; Last Major Revision is skipped (a
  name). An Authoritative page's rename carries the canonical lifecycle marker, as `arkona_rename`'s does.
- Never through `update_resource` alone. The rename record (`pack_renames`, kind `page`) and its review list are kept
  for each rename the dashboard or the automation submits (the automation's `afterBatch`).

## Automation (F5b; F12's division)

`name_nontemplated` is a proposal-first audit code with Apply allowed, **default Off**, and a new **batch** kind
(`CodeEntry.batch`, checked by `defineCode`):

- **Propose**: ONE proposal per run, an item per page (the engine's `proposeAll`; the rename plans captured and merged,
  their step references re-numbered); the owner approves some or all items (as canon for Authoritative pages). A page an
  earlier run proposed (approved or left out) or applied is not taken again. Not paused for being canonical.
- **Apply**: ONE job per page, submitted as the Automation principal and never forced into a proposal (no forced
  proposal path), settled and read back (the page identical but for its name and rank). A guard's refusal is a skip; a
  guard that makes it the owner's canonical proposal (**every Authoritative page's rename: ADR 0057 decision 5**) is
  recorded as `guarded` and the run goes on, the code not paused.
- Order: primary category, then name (the finding's `order`). A rename colliding with another of the run is held by the
  report (N2), naming the other page. The caps (`AUTOMATION_CAP_PER_CODE`, `_PER_RUN`) apply.

**For the owner to know**: at Apply, a `[BSRC]` page's rename is still the canon guard's: it becomes a canonical
proposal per page (only `[BWRK]` and `[BARC]` pages run as jobs). Most of Arkona's sources are `[BSRC]`, so the Propose
batch (one proposal, approved as canon) is the practical path for them; making the owner's Apply switch stand as the
canonical approval of this one transformation would need an amendment to ADR 0057 decision 5 and ADR 0081 (deferred,
for the owner to decide).

## N5: governance and seed

Seed `arkona-2026-11-29-f6d`: `rules.templatedNames` (`template: '<Subject> - <Role>'`, `subjectRow: 'Subject'`,
`exempt: 'vocabulary-specialist-types'`, `ruling: 'templated-names'`) and the ruling `templated-names` (26 November
2026): the template; the Specialist exemption; registered characters' own naming; no Subject held, never guessed;
collisions held; the renames as an automation code at the owner's chosen mode. No new parser and no new pinned section:
Source Formatting's "Page Names and Templates" is pinned already, so the reviewer's paragraph shows as governance drift
and the owner approves again. `ensureSandboxGovernance` is unchanged (its guard test stays green).

**The paragraph for the reviewer** (Source Formatting › Page Names and Templates):

> An ordinary source is named `<Subject> - <Role>`: its Subject sidebar value exactly as written, a space, a hyphen, a
> space, and the role word of its Reference Type as the Reference Type Vocabulary gives it in brackets (Polity Reference
> gives "Falkenreich - Polity"; Language & Naming Reference gives "Shahravi - Language & Naming"). The lifecycle prefix
> ([BSRC], [BWRK], [BARC]) stays. Exempt: a page whose Reference Type is an approved specialist type keeps its unique
> name; a registered character's pages keep the names the character tools give them; indexes, Narratives, the Legacy
> Canon Archive and the Design References are not sources in this sense. A page without a Subject is not named until it
> has one, and a Subject never holds an em dash.

The bridge guide gains "Templated names" under the Arkona sections; `create_resource` (`templatedName`) and
`arkona_create_owner` (its `notes`) suggest the templated name when the name given differs; neither refuses.

## Tests

- Unit (`test/f6d/template.test.ts`): every status; dash and accent normalisation; a Subject holding an em dash or a
  hyphen-minus; collisions (a sibling, two renames under one parent; another parent or prefix free); specialist types
  (category-wide, named pages); "Keep this name" lapsing on Subject and type; the draft vocabulary; the run order.
- World and contract (`test/f6d/world.test.ts`, mock LegendKeeper): the draft vocabulary holding every row; published:
  each status from the published role words, a character's page left out, the route's filters and counts; the findings;
  the stale refusal; Propose: ONE proposal with three items, one approved and two left out, only that page renamed and
  not proposed again; Apply: a Working page renamed by one job and read back, an Authoritative page the canon guard's
  proposal (guarded, not paused); a mention on another page showing the new name, the routing line following, prose left
  and listed for review in the rename record; Keep this name holding, lapsing when the Subject changes, Undo.
- Performance (`test/f6d/scale.test.ts`, 1,500 sources): the audit timing test (medians of seven interleaved runs with and
  without templated names, at most 10% more) and the page (each GET under 500 ms, the loop never held for 100 ms, memory
  flat).
- Sandbox `f6d-names` (opt-in, the owner's; `test/sandbox/f6d-names.ts`, N0 to N6, `ensureSandboxGovernance` always)
  and its mock run (`test/sandbox-mock/f6d-names.test.ts`).

## Deferred

- The owner's Apply switch as standing canonical approval of a `[BSRC]` page's templated rename (see Automation above).
- A rename record made for a run's merged proposal stays `proposed` after the owner approves it (`arkona_rename`'s hooks
  follow only its own proposals); its review list is kept.
- The report is as fresh as the newest audit run (a Subject fixed in the app shows after the next snapshot and audit, or
  "Run audit now").
