# ADR 0063: v3 F4a: the governance drift audit, the name check and the topic brief

- Status: **Proposed** (v3 F4a, 19 November 2026). It answers the owner's repository check of 19 November 2026: Character
  Architecture told agents to call an old bridge's tool (`write_lk {"job_action":"guide"}`, since corrected by hand to
  `get_bridge_guide`); Repository Automation's "Startup and Current Evidence" names its sources by short names, and its
  "Diagnostic Workflows" name skills by their old names; characters share names while Character
  Architecture makes a naming-culture review mandatory at every intake; and Project Navigation's "Smallest Sufficient
  Retrieval" is lost when an agent reads five pages to answer one question about a nation or a culture.
- Every decision is implemented and tested against the mock LegendKeeper and fixtures shaped like the owner's report
  (`test/packs/f4a-world.ts`), never fetched. Nothing in this session touched a live system: no LegendKeeper, no bridge
  connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip script. Where the brief left room, the choice
  is marked **chosen**.
- Builds on [ADR 0044](0044-audits.md) (the audits, read from the snapshots), [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md)
  and [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) with its F3b.1 amendment (packs as data,
  pinned governance, the owner tools, `arkona_character_brief`), [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md)
  (the snapshot overlay, the full-text index, the non-current areas), [ADR 0055](0055-write-scope-review-revert-rails.md)
  and [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) (write scope, Review, the rails), [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md)
  (renames; its review of name parts, which characters share) and [ADR 0060](0060-v3-f3f-retag-audit-and-apply.md)
  (retagging).
- **The rule all three follow** (Repository Automation's Default Boundary: report, never repair): none of them writes
  to LegendKeeper, none of them repairs, and none of them infers. The governance check offers no fix; governance edits
  are the owner's. The name check never suggests or infers a naming culture, race or nationality from a name, a surname
  or its etymology, and never proposes a rename. The brief reads and labels; it never merges or summarises across
  lifecycles.
- Migration: **none**. The drift rules and the naming data are pack data (a new version); the names the owner allows
  are one more audit setting (the settings are one JSON document, read with defaults).
- Pack version: **`arkona-2026-11-19-f4a`** (the equivalence map's seed, the sections checked for missing references,
  and the name check's cultures index). It supersedes `arkona-2026-11-19-f3f`; the owner approves it on the Packs page.
  Until then the package tools refuse as for every new version (`PACK_NOT_CURRENT`, `rules_changed`), the governance
  category reports nothing (it reads the approved version's rules), and the name check finds namesakes but looks up no
  culture owner.
- Numbered 0063, the next free number.

## A. The governance drift audit (the audits' `governance` category)

1. **What it reads.** The governance documents are the **tabs of the governance root**: every page document of the
   pages the pack's governance sources sit on in this project (on Arkona, the AI REPOSITORY root `cn8v87hh`), the pinned
   sections included. **Chosen:** all of the root's tabs, not only the three sources the pack pins: Repository Automation
   and Project Navigation are not pinned, and are where the owner's check found the drift. They are read from the
   snapshots, as every check reads its pages (the reader keeps the blocks of those pages only, so a model of 1,500 pages
   stays small): free, and run with the nightly audit after each full snapshot (and on demand). The check is a pure
   function of its context, like every other (`src/audits/checks/governance.ts`).
2. **Its rules are pack data** (`rules.governanceAudit`, `src/packs/types.ts`), read from the version the owner
   APPROVED (the current version's only while none is approved), as every report-only reading of a pack is since
   CR-2026-11-R2: `legacyNames` (the old bridge's call shapes), `equivalents` (the equivalence map) and
   `referenceSections`. A project with no attached pack carrying them, or no governance source in it, gets no check.
3. **`governance_unknown_tool` (warning).** A name in tool form that the bridge's tool registry does not have. Tool form
   is a snake_case identifier of two words or more in code formatting (an inline code run, adjacent runs joined; a code
   block) or right after "call", "invoke" or "use" (and their inflections). The old bridge's call shapes (`write_lk`,
   `read_lk`, `job_action`) are flagged **wherever** they appear as a word. **Chosen**, so a call is one finding: an
   argument of an old call (a `when` key of the map that is itself a legacy name, `job_action`) is folded into the call
   when both are in the same block, and its value read (`job_action: "guide"`), which picks the map's entry. The message
   names the bridge's equivalent when the map has one. **Chosen**, to keep noise down: the registry is the runtime's
   tool list (pack tools and the proposal tools included) plus every `lk_op_<operationId>` whether or not this server
   lists them; a **retired name** (`get_resources`, `bridge_job_wait`, `bridge_proposals_mine`) is flagged with the tool
   that took over; and the bridge's own words that are not tools (its tools' argument names such as `operation_id`, the
   finding codes, the job and proposal states, `proposal_captured`) are never reported. The check is skipped, never
   wrong, while the tool list is empty.
4. **`governance_external_name` (info).** A kebab-case skill name of three words or more, each starting with a letter
   (`format-baisheng-owners`), in tool form, or any name of the equivalence map found anywhere as a word. It is reported
   with its equivalent: `format-baisheng-owners` → `arkona_appraise_owner`; `audit-baisheng-change-impact` →
   `arkona_change_impact`; `audit-baisheng-chronology` → the chronology audit (`audit_findings` with category
   `chronology`); `intake-baisheng-visuals` → `arkona_visual_hygiene`; `resume-baisheng-workstreams` →
   `arkona_working_digest`, **partial**, and said so ("it lists Working pages, pending proposals and approved packages
   not yet promoted; it does not resume a workstream"). `plan-baisheng-stories` has none, and says so. These may be real
   skills the owner uses elsewhere, so the owner can **allow** a name on the Audits page ("Allow this name", decision 7);
   an allowed name is never reported again.
5. **`governance_missing_reference` (info).** A capitalised name that resolves to no page, tab or alias in the AI
   REPOSITORY, looked for only in sections whose heading holds one of `referenceSections` as whole words (Startup,
   Related Guidance, Source Boundaries, Dependencies; a section runs to the next heading of its level or higher, its
   subsections included). **Chosen, the reading of a name:** a run of capitalised words (a joining word such as "and" or
   "of" may sit inside), ending at clause punctuation, a lower-case word or a possessive. Every known name of two words
   or more is taken out of the run first (the longest from the left); what is left is split at "and", "&" and "or", a
   sentence's starter ("Read", "The", "Then"…) is dropped from each piece, and a piece of two capitalised words or more
   that resolves to nothing is reported. A single word never stands for a name, so a page called "Moonlit" never hides
   a missing "Moonlit Ledger". **The owner's review (20 November 2026): resolution is generous before anything is
   reported.** "Fiction Writing" in Repository Automation's Startup section is not missing: it is the Design References
   page "Arkona – Fiction Writing Reference" (tagged "Fiction Writing"). So a short name resolves if it matches a page's
   subject with its lifecycle prefix, a leading "Arkona -" (any dash, any spacing) and a trailing generic word
   ("Reference", "Standard", "Workflow", "Index") removed (pack data, `governanceAudit.resolution`), a tab's name, an
   alias or a tag, of any page in any area (the Design References and the Legacy Canon Archive included). Besides those:
   every page's display name, its name without prefix, its subject (before a dash) and its subject with the
   descriptor's last word ("the Salahad Reference"), its Canonical Display Name, every template's name, the governance
   documents' own headings (a reference to another standard's section is a reference), and any of these without its
   trailing generic word or a leading "The" (an epithet is written "the White Fox" in a sentence). A name in the text
   is also tried without its own trailing generic word ("the Fiction Writing Standard"). Mention links are never read
   as names (they resolve by id), nor is code formatting. **The owner's decision (20 November 2026): a run inside a
   longer name never resolves silently.** A name that matches only as a run of two words or more inside a known name
   ("the Tagging Standard" inside the tab "Controlled Native Tagging Standard") is reported as an info near miss naming
   the name and page it partially matched (`nearMiss.partial`), for the owner to acknowledge; "Fiction Writing" and "the
   Fiction Writing Standard" still resolve, as whole names.
6. **What a finding holds.** One finding per tab and name (and, for a tool, per equivalent), fingerprinted on them.
   Each carries `tab`, `name`, the sections it appears in, `arguments` for an old call, `equivalent` (`use`, `note`,
   `partial`) and **`suggestedReplacement`**, the text the owner may copy into a `write_page` edit by hand. Every finding
   suggests a replacement. A name that resolves to nothing but is near a known one is reported as a **near miss**,
   still `info`: first a known name it is only a run inside (decision 5; `partial: true`; among several, a tab first,
   then the name of fewest words, and the message says how many names hold the run), else one near it in spelling or
   words (two edits at most, one under eight letters; the same words reordered; or a longer name holding every word).
   Its evidence names the closest match (`nearMiss: { closest, kind, page, partial? }`, a tab first among equals) and
   carries it as `suggestedReplacement`, as the owner's review asked ("LK Bootstrap" → the root's tab "AI Bootstrap").
   A name with nothing near says so, and what to do. An unknown tool with no equivalent names the bridge tool nearest in
   spelling in its message. **Chosen:** a missing reference's evidence is its tab, section and name (and a near miss's
   closest match), so the owner's acknowledgement survives a reworded sentence; it covers the match it was given, so a
   nearer name made later re-opens it with the new suggestion. A near tool name stays in the message only, so a bridge
   upgrade never re-opens a finding. The sentence itself is in the message. **No fix is ever offered** (no `fix`, so no "Propose a fix"), and
   "Re-check now" is not offered: a governance finding depends on the whole repository and the bridge's tools, and is
   checked again by the next run.
7. **Allowing a name.** `POST /api/admin/audits/findings/:id/allow-name` (the Audits page's "Allow this name" on a
   `governance_external_name` finding, after a confirmation) adds the name to the audit settings'
   `governanceAllowedNames` (per project, compared without case), marks its open findings gone at once, and is audited
   (`audits.allow_name`). Any other finding is refused (`NOT_ALLOWABLE`: acknowledge it instead). **Chosen:** like an
   acknowledgement it only silences a report, so it asks no step-up; removing an allowed name is a settings change on the
   same page, which asks for the step-up as every settings change does (ADR 0062).
8. **The existing categories are unchanged.** The check only adds findings of its own category; a run with and without
   the drift rules leaves every other finding, its fingerprint and its evidence the same (tested).

## B. The name check (`arkona_name_check`)

1. **The tool.** `{ name?, givenName?, surname?, aliases?, namingCulture?, exclude?, detail? }`, read-only and free: the
   repository tree and its stored sidebars (the facts), and the snapshots (a culture owner's sections). `detail: "full"`
   lists up to 200 namesakes and members and longer sections.
2. **Current characters** are the pack's identity pages (the Reference Types of its identity roles: Character Core,
   Compact Character Reference) that are Authoritative or Working, AU included, each labelled; never an Archived one, nor
   one in the Legacy Canon Archive or the Design References (counted in `inspected.leftOut`). A page whose sidebar the
   tree has not read yet is matched by its names and aliases only, and says so.
3. **Matching** compares names without case, accents (NFKD), apostrophes, punctuation or a lifecycle prefix. **Chosen,
   one full-name match per character, the most exact:** the name as written (its subject or Canonical Display Name); else
   one of its aliases ("your full name is their alias"); else its given name and surname together, in either order, the
   order judged from how its own name is written ("the same names in the other order"); else, when no parts are recorded
   on either side, the same two words in the other order. Then the partial matches: the given name, the surname, an
   alias of the new name; and, when only a name is given, a character's given name or surname found as whole words of it
   (literal, never a guess at which word is which).
4. **Severity.** An exact full-name match (the full name is exactly a name another current character goes by: its full
   name in either order, its Canonical Display Name or one of its aliases) is a `warning`; every partial match is
   `info`. **Nothing is ever refused: names may be shared.**
5. **Name order.** **Chosen:** every full name is matched in both orders, so "Asagiri Miyabi" finds "Miyabi Asagiri"
   and the reverse whichever culture either belongs to, and the bridge never has to decide a culture's order. Each answer
   points to the "East Asian Personal Name Presentation Standard" tab on the governance root (`naming.presentationStandard`,
   found by name in the tree), which decides how a name is **presented**. It is **not pinned**: the pack derives nothing
   from it (a pin would make every package refuse until it is approved, and its document id could not be read in this
   session). If the owner wants the bridge to apply the order (to present a name, or to split one into parts), the
   family-first cultures become pack data and the standard's section is pinned: a later change, the owner's decision.
6. **The naming culture.** With `namingCulture` (a value the owner gave), the value is looked up in the approved
   version's culture map (F3a's token maps, keys without case). A mapped value resolves to its culture owner under the
   pack's cultures index (`naming.culturesIndex`, `Arkonan Cultures`): a page there whose subject, name or alias is the
   token or the value (or, for a culture with its own index, that index's pages). The answer gives the owner's naming
   sections (headings matching `/nam(e|ing)/`, plus any `naming.sections` lists), as Markdown from the snapshots, each cut
   at 2,500 characters (20,000 with `detail: "full"`) with a result handle for `bridge_result_page`; and the current
   characters recorded with that Naming Culture (by the value, or by the same token), with their names, for consistency.
   **An unmapped value is reported as such**, and no owner is looked for: "ask the owner which culture is meant; never
   choose one from the name".
7. **Never an inference.** Nothing in an answer is derived from the form of a name: no culture, race or nationality is
   ever suggested, and no rename proposed (tested with a surname of an obvious etymology). Every answer states the rule.
8. **Wired into the creation and rename tools.** `arkona_create_character` (a new character) and `arkona_rename` (a
   character subject, not a follow-up) run the namesake part on the new name, free (no extra read). An exact full-name
   match is a `NAMESAKE` warning in the preview and the answer and in **the proposal the owner sees**: the proposal's
   one-line summary ("namesake: Kamigawa Miyuki (Authoritative) already goes by this name"), and for a rename its
   operation (`warnings`, `namesakes`). A partial match is a note. **Chosen:** a rename leaves its subject out, and uses
   the given and family names the owner gave for it; `CHARACTER_EXISTS` (ADR 0050 decision 10: never a second set of
   pages for one character) is unchanged and still refuses a new character whose exact name a character's page already
   has, and the characters it names are not repeated as namesakes.

## C. The topic brief (`arkona_brief`)

1. **The tool.** `{ subject, live?, include?, detail? }` generalises `arkona_character_brief` to any subject (a nation,
   polity, culture, religion, place, event, magic system, item). Free: the tree and its stored sidebars, the snapshots
   (the appraisal's overlay: sidebars, link collections, bodies, references), the chronology's tables from the snapshots,
   the proposals and the audit findings. `live: true` re-reads the head owner's sidebar: one read.
2. **The subject.** Resolved as the registry resolves names, in the default scope: a page in the Legacy Canon Archive or
   the Design References only with `include` (`SUBJECT_NOT_CURRENT` otherwise, naming the `include` to pass). **Chosen:**
   one character's pages are one subject (the character: **delegated** to `arkona_character_brief`, which says so); an
   index with pages directly in it is one subject (the index); a name the registry does not resolve is looked for as a
   page's subject (before " - ") or alias ("Lumen Strand" finds "Lumen Strand - Polity Reference"). Several subjects
   are refused with the candidates (`AMBIGUOUS`), exactly as `get_resource` refuses an ambiguous name.
3. **The owner:** an index and the pages directly in it (its subindexes listed by name, not descended), or the single
   owner page; each with its lifecycle (Authoritative, Working, Archived; `au` from its Continuity Type), Reference
   Type, Scope, Last Major Revision and tags, and where its facts came from and how old they are.
4. **Dependencies, one level**, from each owner's sidebar in the snapshots (or live), each with its lifecycle and Scope.
   A Dependency on a Working or Archived page, on historical material (a non-current area) or on a page no longer in the
   repository carries a `flag` quoting Project Navigation: "Current authority must not depend on Working, historical
   material or an unrelated AU". **Incoming Dependencies**: the count and the first ten (a hundred with `detail: "full"`).
5. **Source Boundaries and Unresolved Material**, from each owner's main document in the snapshots, as Markdown, cut at
   1,500 characters (20,000 with `detail: "full"`) with a handle; the headings are the pack's own.
6. **Related Sources**, each with its lifecycle.
7. **Chronology:** each age table of the chronology's settings, read from the snapshots: a row names the subject by a
   mention of one of its pages, or its name or an alias as whole words (names of three letters or more; a possessive
   counts, "Al-Tibr’s fleet"); each with its age, table, date and KCY, and the chronology page's own lifecycle (one page,
   so one label serves every row). **Departure:** the brief reads LegendKeeper's table shape, where a header row is made of
   table cells (the block model has no header-cell kind), as the chronology's own reader does.
8. **Work in progress:** the Working pages that mention or depend on the subject's pages (the overlay's references), and
   the pending or conflicted proposals whose operations touch them (an operation on one of them, or a page made or
   moved under one).
9. **The open audit findings** on the subject's pages, and the **freshness** of each source (the tree, the snapshots
   and each owner's, the live read).
10. **The rules.** Every item carries its lifecycle; owners and items are listed apart and never merged or summarised
    across lifecycles. The non-current areas are left out (and counted, `leftOut`: each page once, however many owners
    point at it) unless `include` names them. A long answer comes as a handle, as every tool's does.

## D. Guidance

`get_bridge_guide`'s "How to decide" now opens its subject work with `arkona_brief` ("A question about a subject →
`arkona_brief` first … then `search` and `read_document` only for what it points to") and makes `arkona_name_check`
part of every character intake and rename; its which-tool table and the Setting packs table list both, and a new part,
"Arkona briefs and names", explains them. The audit findings section describes the governance category. The tool
descriptions of `search`, `read_document`, `arkona_create_character`, `arkona_rename` and `arkona_character_brief`
point to the new tools. "How to decide" stays under its 9,000-character limit (8,854).

## Costs

| Call                                                            | LegendKeeper reads                 |
| --------------------------------------------------------------- | ---------------------------------- |
| The governance category (in every audit run)                    | 0                                  |
| Allow this name (the dashboard)                                 | 0                                  |
| `arkona_name_check`, any arguments                              | 0                                  |
| `arkona_brief`                                                  | 0                                  |
| `arkona_brief` with `live: true`                                | 1 (the head owner's sidebar)       |
| The namesake part of `arkona_create_character`, `arkona_rename` | 0 (the tools' own costs unchanged) |

## Consequences

- After deploying, the owner approves the new pack version (`arkona-2026-11-19-f4a`) on the Packs page; the next
  nightly audit (or "Run an audit now") reports the governance category, and the culture lookup works.
- Agents start a subject's question with one free call, see every item's lifecycle, and meet namesakes at every intake
  and rename; the owner sees a namesake in the proposal's summary before approving.
- Left for later: applying a culture's name order (decision B5), an override for two different characters with exactly
  the same name (decision B8), and a dashboard list of the allowed names beyond the settings editor's.

## Tests

`test/audits/governance.test.ts` (the check on hand-made documents: the old `write_lk` line with `get_bridge_guide`
suggested and `job_action` folded in; the old skill names with their equivalents, the partial one and one with none; an
allowed name silent; "Fiction Writing" resolved to its Design References page (by its name with the prefixes and
"Reference" removed, with either dash, by a tag, an alias or a tab), "Moonlit Ledger" missing in a Startup section and
only there, "LK Bootstrap" an info near miss for the root's tab "AI Bootstrap" with it suggested, "the Tagging Standard" and
"the Continent Reference" near misses naming the tab and the page they are only part of; names resolving to a tab, a page, a
subject, an alias or a heading silent; the reading of runs), `test/audits/governance-world.test.ts` (the nightly run
reports it; `audit_findings` reads it; "Allow this name" through the admin API, audited, then silent; the existing
categories unchanged), `test/packs/name-check.test.ts` (exact, given-name, surname and alias matches; East Asian order
both ways; accents and prefixes; `exclude`; the labels; the culture, its section cut with a handle, its members; an
unmapped culture; no inference; the create and rename warnings and their proposals), `test/packs/topic-brief.test.ts`
(a nation index with three owners; a single owner; a character delegated; a Dependency on a Working page flagged;
chronology rows by an alias; the non-current areas left out and brought in; an ambiguous name refused; work in progress;
no read without `live`, one with it), and the guide's (`test/discover/guide-sections.test.ts`, `test/discover/visibility.test.ts`).
