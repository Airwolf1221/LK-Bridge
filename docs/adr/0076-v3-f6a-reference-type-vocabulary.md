# ADR 0076: v3 F6a: the Reference Type vocabulary: a report with rule-based suggestions, the owner's decisions, publishing to governance, two taxonomy checks and the creation tools' guard

- Status: **Proposed** (v3 F6a, 24 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). The sandbox check
  (`f6a-reftypes`) is opt-in and the owner runs it. Where the brief was silent the choice is marked **chosen**.
- Design: `LK-Bridge-F6-taxonomy-design.md`, APPROVED 23 November 2026; this session is T14's F6a (T1, T2, T3's first
  half, T13's data). The design document is not in the repository; the brief's own wording and examples were used.
- The problem: Source Formatting makes Reference Type a standard sidebar field but defines no vocabulary. On 23 November
  2026 live Arkona held well over 150 distinct values ("Culture Reference", "Cultural Reference", "Historical Cultural
  Reference", "Regional Culture and Naming Reference", "Culture & Naming Reference"…; about 20 Polity variants), driven
  by time words, scope adjectives, content detail and synonyms. The owner's ruling: templated names are preferred where
  they improve usability, with an exception for specialist sources that need unique naming and typing.
- Amends: [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (one more pinned section, which may be
  absent while unpublished), [ADR 0067](0067-v3-f5a-supplementary-tags-rulings-bulk-actions-and-unknown-outcomes.md)
  (the same derive-on-check pattern for a second section), [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) and
  [ADR 0072](0072-v3-f7-1-the-character-core-rule.md) (one more proposal-only code with `applyDirect`, default Off),
  [ADR 0071](0071-v3-f7b-seeing-character-art.md) decision 9 (meter's titled-block default).
- Migration `4500_reference_types.sql`: `reference_type_decisions`, `reference_type_publications`.
- Pack version: seed `arkona-2026-11-24-f6a` (supersedes `arkona-2026-11-23-f7b`); the owner approves it on the Packs
  page. No new setting (nothing added to `src/config/registry.ts`).

## Decision 1: the vocabulary is pack data, a draft until published (T1, T13)

`rules.referenceTypes` (src/packs/types.ts): `{ source, section, under, status: 'draft' | 'published', rule,
categories: [{ category, types: [{ name, role, aliases? }] }], specialist: [{ type, category, pages | null }],
normalise: { synonyms, timeWords, scopeWords } }`.

- **The rule**: a Reference Type names the page's ROLE, from a closed list per primary category (the categories are
  the closed primary categories the retag engine already knows); time goes in Temporal Scope, geography in placement,
  detail in Scope.
- **Role words** are stored now for F6d's templated names (Polity Reference → "Polity", Polity Constitution Reference →
  "Constitution", Language & Naming Reference → "Language & Naming", Race Core Reference → "Race"). Nothing in F6a
  renames a page.
- **The draft** in the seed (src/packs/arkona.ts) is the design's T1 table (given by the owner at review, 24 November
  2026), in its order, for Polity, Institution, Culture, Religion, Event, Place, Magic, Technology, Equipment, Material,
  Law, Species, Creature, Condition and Relationship; then the first draft's types T1 does not list are kept: Character
  (the pack's own Reference Types as they stand: Character Core, Compact Character Reference, Character Art, Joint
  Character Relationship Reference, Character Biography and the four specialist references), Military, Education and
  Ceremony, Magic Reference and Law Reference. Programme Reference (role word "Programme") is the Programme primary
  category's, not Technology's: the owner's ruling of 24 November 2026 corrects T1, which listed it under Technology;
  Technology keeps Technology Reference only. It is marked draft; the owner's decisions and publication replace it.
- **Names the section could not write back** are refused by the schema (`;`, `(`, `)`, `:`, ", also").
- **`aliases`**: variants the vocabulary itself says mean a type ("Culture & Naming Reference" → Language & Naming
  Reference only if the vocabulary lists it). The draft lists none.

## Decision 2: suggestions by rules only (T2)

src/packs/reftypes/suggest.ts, for a value and the page's primary category (from its tags, the retag engine's
`categoryFromTags`): (1) canonical as it is (any category); (2) the comparable form: case, spacing, punctuation, `&` and
`and`, a missing or extra "Reference"; a type's name, an alias or its role word, **within the page's category**; (3)
synonyms word by word (Cultural → Culture), then time words (Historical…) and scope adjectives (Regional, Shared,
National, Cross-National, Cross-Jurisdictional, Civilisation…) stripped, the words moved named in the reason; step 2
again, in three ordered attempts, the first matching exactly one type winning: time and scope words stripped without
synonyms (so "Historical Legal Reference" finds Legal Reference before Legal → Law), then with synonyms, then time
words only with a scope adjective read as its noun through the synonyms when it alone names the role ("Historical
Regional Reference" → Region Reference; "Regional Settlement Reference" is still Settlement Reference, Regional moved
to Scope); (4) another category's type, two roles or two categories ("Historical Polity and Institution Reference"), or no
primary category tag: **no confident suggestion**, the candidates listed, the choice the owner's. Never inferred from a
page's content. The words are pack data (`normalise`).

## Decision 3: the report, `arkona_reference_types` (T2)

Read-only and free: the repository tree's stored sidebars. **One row per value and primary category** (**chosen**: a
suggestion is made within the category, so a value used in two categories is two rows and two decisions). Each row: its
count, its pages (id, name, path, category, lifecycle, coverage), the suggestion and reason (or "no confident
suggestion" with candidates), its status (`canonical`, `mapped`, `specialist`, `rejected`, `open`), its decision and any
conflict. Out of scope and counted (`excluded`): the Legacy Canon Archive, the Design References, Working, Archived and
Narratives pages (the Narratives index by the pack's narrative rules). Filters: category ("none"), status, minCount,
under. Paged (limit up to 200). Coverage as `query_facts` states it: pages read recently, stale (more than 26 hours, or
the tree's own stale mark), never read (listed: their Reference Type is unknown), the oldest read, the tree's
confirmation. Listed while the APPROVED pack version has a vocabulary (LD-01).

## Decision 4: the owner's decisions (T2)

The dashboard's **Reference Types** page (Setup, after Repository Mappings). Per row: **Accept** (the confident
suggestion), **Edit** (a canonical value of the category from a picker, or a new canonical value with its role word,
added to the category's vocabulary), **Reject** (left as it is, never suggested again), **Keep as specialist** (T13's
Specialist exemption: for exactly the pages listed, or any page in the category). **Accept all confident suggestions**
in a filter. Every decision asks for the step-up and is audited (`reftypes.decide`, `reftypes.undo`, with who, when,
old and new). Stored in the bridge's database: the owner's approval, no pack version each.

- A mapping to another category's canonical value is refused (`TARGET_OTHER_CATEGORY`): the category is the page's
  primary tag, the owner's to change (T7).
- **Undo** only before applied: a mapping a fix has written (counted from the write journal, where every write of the
  fix carries the decision's id), or any decision the published vocabulary holds, is refused (`DECISION_APPLIED`,
  `DECISION_PUBLISHED`).
- Agents never decide: the tool reports; the service refuses any actor but the owner (`NOT_OWNER`).

## Decision 5: publishing the vocabulary to governance (T1)

"Publish vocabulary" (preview free, the write after the step-up): ONE job of the bridge's, `replaceDocumentBlocks` of
Source Formatting with If-Match the version read, journalled, verified after the write (`verifyAfterWrite`); every
block outside the section kept as read (ids and `unsupported` blocks included). The section "Reference Type Vocabulary"
goes under "Sidebar Metadata" (one heading level below it, at most 3); publishing again replaces it in place. Its text
(src/packs/reftypes/vocabulary.ts, one fixed form, read back in that form only): the rule; an introduction; one
paragraph per category, `Polity: Polity Reference (Polity); Polity Constitution Reference (Constitution).`; then the
approved specialist types, `Specialist type: X (Category), any page in this category.` or `…, for these pages:` with the
pages as mentions.

- **Pinned** in the f6a seed (Source Formatting's pins gain "Reference Type Vocabulary"). While the version's vocabulary
  is a draft and the section is not there, its pin reads **`unpublished`** and never refuses the approval (**chosen**).
- **Read at each governance check** as F5a reads the Approved Supplementary Tags: a section that differs from the
  version's vocabulary (the bridge's publication, or the owner's own edit) is offered as a NEW version, `published`,
  the section's content as the authority (audited `pack.derive_reference_types`); the draft is then ignored. A section
  that cannot be read exactly refuses the approval (`GOVERNANCE_SECTION_UNPARSABLE`). Publishing changes the governance
  page, so the pack drifts and the Packs page asks for approval again; the action's confirmation says so.
- **The section wins**: a decision the published section contradicts (a new type or a specialist type the owner removed
  by hand, a mapping to a type no longer listed, a rejected value the section made canonical) is marked as a conflict on
  the page and in the report and adds nothing (its findings offer no fix). Decisions not published yet add to the
  vocabulary in force until the next publication.
- A later seed never replaces a published vocabulary with its draft.
- Revert applies to the publication's job (`approvedRevertible`), as to F5a's governance edit.

## Decision 6: the two checks (T3, first half)

Category `taxonomy`, from the snapshots, free, on every audit (the nightly one included); the scope of decision 3.

- **`reference_type_noncanonical`** (info): the value is not in the vocabulary in force. With an approved mapping the
  finding carries the fix `reference_type`: ONE sidebar field set through the governed facts path (`planFacts`,
  `expandFacts`: the row checked in the lock, the write's If-Match chained from it, journalled with the decision,
  read back); the mapping and the page's value re-checked live first (`FIX_STALE`). A proposal; the canon guard decides
  an Authoritative page's as for any write. With no decision (`open`): a judgement with a link to the mapping row. A
  rejected value, or a specialist type covering the page: no finding.
- **Automation**: registered as a proposal-only code with `applyDirect` (as F7.1's codes), **default Off**. T10's order:
  approve mappings, then switch to Propose, then Apply. Apply submits the same job as the Automation principal, every
  guard judging it.
- **`reference_type_category_mismatch`** (info, judgement): the value is canonical in another category than the page's
  primary category tag; both shown; no fix (T7).
- **Promotion**: `promote_page`'s preview (a page, or each page of a set) warns when a page being promoted has a
  non-canonical Reference Type, so Working pages are checked when they become canon.

## Decision 7: the creation tools (T1)

`arkona_create_owner`, `arkona_create_character` (every pack package, in `finishPackage`) and `create_resource` (a
`Reference Type` fact on a project whose approved pack has a vocabulary): a type outside the vocabulary is **refused
once published** (`REFERENCE_TYPE_NOT_IN_VOCABULARY`, naming the nearest canonical value) and a **warning while a
draft**. An approved specialist type for any page of the category is accepted (**chosen**: one restricted to listed
pages cannot cover a page not made yet).

## Decision 8: guidance

The bridge guide: one row in "How to decide" (its cap, 9,450 characters, unchanged at 9,446: rules 1 and 4, the split
line and the scope paragraph trimmed; rule 2 kept whole at the owner's review; R5 trims the section), and the section "Arkona Reference Types" (use the vocabulary; never invent a type;
`arkona_reference_types` for the state; the owner decides). `arkona_create_owner`'s example now uses a canonical type.

## Decision 9: meter's titled-block default (F7's G10 completed)

F7's probe printed meter on 23 November 2026: `title="Meter" isTitleHidden=false`. It is in `TITLED_BLOCK_DEFAULTS`;
every titled kind of the spec is now confirmed.

## Costs (measured against the mock, pinned by the tests)

- The report, the checks, decisions: none.
- The fix: 2 reads to plan (the page, its properties), then the facts job (one check read, one write, one read-back).
- Publish: one read (the preview), and one write with its read-back.

## The sandbox check (written, not run; passing on the mock)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6a-reftypes` (test/sandbox/f6a-reftypes.ts,
F0 to F6; run in the ordinary suite against the mock by test/sandbox-mock/f6a-reftypes.test.ts). On the test world: a
throwaway index and, under it, a throwaway governance page (always, so nothing is written to `test`'s own governance),
the pack's sources pointed at it and the pack approved in the TEMPORARY database only; three pages with variant
Reference Types; the report printed row by row (`ROW value=… status=… suggestion=… reason=…`); one mapping recorded;
the audit and the fix's job; the page read back live (`LIVE …`); the vocabulary published to the throwaway page and
parsed back. Clean-up in its `finally` and the test file's `afterAll`. The other sandbox checks' throwaway governance
pages leave the draft vocabulary's section out, so it stays unpublished there.

## Consequences

- The owner approves `arkona-2026-11-24-f6a` on the Packs page (the vocabulary's pin shows "unpublished"), runs the
  report on Arkona and works through the table (design T10 step 1, the main piece of work before F6b), publishes the
  vocabulary, approves the pack again, then switches `reference_type_noncanonical` to Propose and later Apply.
- Agents are told (the guide, the tool descriptions): use the vocabulary, never invent a type; the owner decides.
- Reminder for the owner (not this session): before F6b, create the template "[NAV] AI Navigation" as a copy of
  "[INDEX] AI Index".

## Amendment 1 (v3 F6a.1, 25 November 2026): the live hang of 24 November; a decision is cheap, the report is cached

- Status: **Proposed** (v3 F6a.1). Reproduced and fixed against the mock LegendKeeper only, at Arkona's scale; nothing in
  this session touched a live system. The owner's evidence: the journal and the unit's cgroup samples of 24 November.
- Amends decisions 3 (the report: cached and paged), 4 (the decisions: a bulk accept is one request by ids, one
  transaction, bounded) and 5 (the governance check after a publication: owned by the runtime). The logging that names a
  hang is [ADR 0061 amendment 1](0061-cr-2026-11-r3-decisions.md#amendment-1-v3-f6a1-25-november-2026-a-hang-names-itself).
- Migration `4510_tree_versions.sql` (a version per project's tree, bumped by triggers). New setting `REFTYPE_BULK_MAX`
  (default 500, `applies: now`), in `src/config/registry.ts`.

### What happened

On live Arkona (1,493 pages, about 150 values), "Accept all confident suggestions" hung the bridge: the journal's last
line 23:01:34, nothing for 20 minutes, the process throttled at MemoryHigh (1.4 GB) with 2.8 GiB in swap and growing.

### The cause, named

`ReferenceTypeService.bulkAccept` was ONE synchronous loop calling `decide` per row, and `decide` began with
`this.rows(projectId)`: the whole report rebuilt for every row (**repeated**, O(rows × pages)). Each build ran `scopeOf`,
whose `kindOf` asked `TreeQueries.node()` for every id on every page's path, the page itself included: **1,703 calls per
build** at 1,500 pages, each running `TreeService.meta()` with five freshly prepared SQLite statements (plus the project's
settings read). better-sqlite3 frees a statement's native memory only when V8 collects its wrapper AND runs the weak
callback, on a later turn of the event loop; inside one synchronous loop none was freed (**retained until the loop
yields, which it never did**): about 116 MB per build, so the V8 heap stayed flat (65 MB in the journal's last line)
while RSS climbed past MemoryHigh, the kernel throttled and swapped the process, and nothing else could run (the
scheduler included). The `decide` and reload timings (1.3 to 1.8 s) were the same builds, one at a time.

Measured on the mock (test/f6a1, 1,500 pages, 208 values, 131 confident):

|                      | before                                   | after                                         |
| -------------------- | ---------------------------------------- | --------------------------------------------- |
| a report build       | 500 ms, 1,703 tree status reads          | 68 ms, 3 queries (cached after)               |
| the page's load      | 921 ms, loop held 497 ms                 | 93 ms, 62 ms                                  |
| a reload             | 514 ms, loop held ~500 ms                | 19 to 24 ms                                   |
| Accept all, 10 rows  | 6.7 s, loop held 6.7 s, RSS +955 MB      | —                                             |
| Accept all, 131 rows | the test process at 13 GB in 3 s, killed | 124 ms, loop held 118 ms, RSS ±0              |
| 20 reloads after it  | —                                        | RSS 588.2 MB flat, heap +6 MB (flat over 200) |

At 300 pages the old code took 26.9 s for "Accept all", the loop held throughout, RSS 491 MB → 4,627 MB; the new test
(`test/f6a1/scale.test.ts`) fails there on its lag bound.

### Decision A: the report in two cached layers, built without a status read per node

- **The base** (every page in scope with its value, category, lifecycle and read times): ONE light scan of the tree
  (`TreeQueries.pageScan`, without the stored sidebars) and ONE query of every node's kind (`TreeQueries.kinds`). Cached on
  the tree's version (migration 4510's triggers bump it on any node's insert, update or delete), the pack's
  approved version and the project's settings. Built by `prepare` in chunks of 250 pages that yield to the event loop
  (every route and the tool await it; one build at a time per project), or at once by a synchronous caller.
- **The rows** (grouped, suggested, statused): from the base in memory, cached on the base and the decisions' version
  (each write of the decisions store moves it) and the minute (the coverage's "stale" moves with the clock).
- The mappings' applied counts: ONE scan of the write journal, only when the journal's newest entries moved (it was one
  `LIKE` scan per mapping per build).
- Hot SQL is prepared once per connection (`src/db/statements.ts`: the tree's status queries, a node, a project).

### Decision B: a decision is cheap

`decide` reads the cached base, computes its one row's suggestion under the vocabulary in force, writes its decision and
audit row, and returns the decision and its row as it now stands (`POST /reference-types/decide` → `{ decision, row }`).
It never rebuilds the report, re-runs an audit or reads a snapshot. A decision starts no background work (the
`reference_type_*` findings follow at the next audit, as before; the fix re-checks the decision live).

### Decision C: "Accept all" is one request, ids in, rows out, one transaction, bounded

- `POST /reference-types/bulk-accept { ids: [rtr_…], confirm: true }` (the step-up): the page sends the ids of the
  confident open rows of its whole filter (the GET lists them as `confident: { count, ids, sample }`, with `bulkMax`).
  The filter form (no ids) is kept: the first `REFTYPE_BULK_MAX` rows, the rest counted as `remaining`.
- A row id is stable: `rowIdOf(value, category)`, `rtr_` and 16 hex of a SHA-256 of the value and the category's key.
- ONE transaction: every decision and its `reftypes.decide` audit row, or none.
- Bounded: more ids than `REFTYPE_BULK_MAX` (default 500, 1 to 5,000) is refused, `BULK_TOO_LARGE` (413), nothing written.
- Idempotent: each row is checked inside the transaction; one already decided (`already_decided`), canonical now, not
  open, with no confident suggestion or not in use is skipped with its reason. Running it again touches only the rows
  still open (**the owner's recovery**: the decisions recorded before the hang are intact, each a committed row; "Accept
  all" again decides the five left).
- It returns `{ accepted, skipped, remaining, max, decisions, rows, skippedRows }`: the rows it changed, not a report.

### Decision D: the page fetches what it shows

The table is paged (100 rows a page, Previous and Next); "Value contains" is a server filter (`value`), so paging holds.

### Decision E: background work an action starts is the runtime's

`src/background.ts` `BackgroundRunner`, made by the runtime: `trigger(key, …)` is debounced (2 s) and runs one at a time
per key (a trigger during a run makes one more after it); `track(label, promise)` keeps work already started; `stop()`
drops pending debounces, aborts every signal and awaits every run (bounded), before the engine and the database stop.
An aborted run is logged at debug, never as an error.

- The governance check after "Publish vocabulary" (the sandbox's race: `TypeError: The database connection is not open`
  from `governance` → `PackStore.newVersion` after the stop closed the database) and after "Allow this tag everywhere":
  `trigger('governance:<pack>')`, reading at **P3** (it is background work), with the stop's signal; a check whose signal
  is aborted writes nothing (`governance` stops before deriving a version).
- The other admin-started background work with the same `void …catch()` shape, now tracked: "Run audit now", the
  chronology's "Check now", and the job follow-ups an owner's action sets off (Revert's automation follow-up, its images
  back on Staging, a reverted split's deletion proposal; a split's phase 2; a rename's leftovers; an identity reconcile's
  outcome; block-by-block undo; a restore's second proposal). The audit a full snapshot starts is awaited (bounded) too.
- The audit run yields to the event loop between its checks (each a synchronous pass over every page).

### Tests

`test/f6a1/`: `scale.test.ts` (Arkona's scale: Accept all plus 20 reloads, heap within 64 MB of its start, RSS step under
128 MB and flat across reloads, lag under 500 ms on every request; fails on the old code), `bulk.test.ts` (one
transaction, bounded, idempotent, the rows returned, a decide without a tree read, the cache's hits and invalidations,
paging, the debug start line), `background.test.ts`, `publish-race.test.ts` (fails on the old code with the sandbox's
error), `watchdog.test.ts` (ADR 0061 amendment 1).
