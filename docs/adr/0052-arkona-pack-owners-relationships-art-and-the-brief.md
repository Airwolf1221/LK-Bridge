# ADR 0052: Arkona pack: owners, relationships, art and the brief

- Status: **Proposed** (v3 F3b, 16 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper with fixtures built from the shapes the design quotes (Salahad, Races of Arkona, the Bestiary, the
  ten-row sidebar), never fetched. The owner's rulings are quoted; the choices this session made where the brief left room
  are marked **chosen**.
- Carries out: the owner-approved design [design/F3b-owner-tools.md](../design/F3b-owner-tools.md) (approved 16 November
  2026, with the ★ calls confirmed and the owner's rulings on the race roster, 1.1a, and on AU pages, 1.5).
- Builds on: [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) (packs as data, versioned governance, one
  proposal per package, the re-check in the job), [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md)
  (server staging, folders found or created at run time, Last Major Revision), [ADR 0026](0026-type-registry-and-name-resolution.md)
  (the registry and its taxonomy), [ADR 0032](0032-set-facts-and-canon.md) and [ADR 0035](0035-page-lifecycle.md) (canon
  and the lifecycle guard), and [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) (decision 1:
  the owner's rule for Last Major Revision and the `lastMajorRevision` override, which the pack tools now apply:
  decision 14).
- Migration: **none**. The pack's rules are one JSON document in the `packs` table already; the new seed reaches a stored
  pack as a new version at start (decision 12), which the owner approves.
- Numbered 0052, the next free number after F3.1's (F3c's) 0051. F3.1's branch was merged in before it reached `main`, so
  that decision 14 could be built on its rule at the owner's request; it has since landed (#60) with the same code.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script.

## Decision 1: one owner tool, typed by the pack's owner table (data)

`arkona_create_owner` makes every non-character owner. The five non-character templates share one sidebar (Status,
Continuity Type, Continuity, Inheritance, Subject, Reference Type, Scope, Temporal Scope, Last Major Revision, Supersedes,
then Dependencies, Related Sources and TAGS), so what differs between types is data: the template, the primary tag, the
allowed specialist tag and the allowed homes. The pack's rules gain an optional `owners` section
(`src/packs/types.ts`): the tool, the shared facts (the required ones, the ten keys, the fixed CANON / Main / None), the
tag grammar (`$status, $primary, $specialist`; a Working page `$status, $primary`), the world prefix (`Arkonan`), the
category that holds nations (`Polities`), the drafted index wording, the race roster (Races of Arkona `rraces01`, and
the `Characters` navigation) and the 19 types of the design's table (Polity, Institution, Military, Culture, Event,
Place, Technology, Magic, Material, Equipment, Species, Creature, Religion, Law, Programme, Education, Ceremony,
Condition, Relationship), each with its template role, primary, specialists and homes.

**Chosen**: a section of its own rather than 19 entries of F3a's `types` (each would repeat the character-shaped fields:
identity, assets, index, overload). The owner planner (`src/packs/engine/owner.ts`) makes the type the shared job
builder reads in memory (`ownerTypeRules`), so the job, the preview, the checks and the verify are F3a's. The schema stays
`schema: 1`: a stored F3a pack has no `owners` and still parses. The four new template roles (`polity`, `place`,
`magictech`, `creature`) are named in the seed by template name (`templateNames`) and worked out in every project,
Arkona included, from its templates as last read (decision 12).

## Decision 2: homes, recognised by name and place (design 1.2)

`home` is required: an index by name, id or path (`Salahad / Salahad Polities`). It is checked against the type's
allowed homes (`src/packs/engine/homes.ts`), each recognised by the index's own name and its place:

- `<Continent> <Category>`: an index named so whose nearest ancestor index named `<Continent>` is not a nation (so
  `Salahad Conflicts`, beneath `Salahad Historical Events`, is a continental Conflicts index);
- `<Nation> <Category>`: the same beneath a nation index; a nation index is an index directly in a `<Continent>
Polities` index;
- `Arkonan <Category>` (the world level), `Divine Realm Cultures` (by name), a Divine Realm index (**chosen**: an index
  directly under `[INDEX] Divine Realms`, the design naming no pattern), the Bestiary (by id `bb9fa6cf…`, else by name);
- the race roster's own pages (decision 4).

A home that does not match is refused with `HOME_NOT_ALLOWED`, listing the allowed homes and up to five suitable indexes
nearby (**chosen**: nearest by tree distance from the refused home, then by path; each is itself an allowed home); a
home that is not there is `HOME_NOT_FOUND` with the nearest from the root. `homeOverride: { reason }` lets a home
through with a warning (`HOME_OVERRIDDEN`); the reason is printed in the proposal's one-line summary ("home override:
…") and on the page's line. A home inside the Working or Archived area is refused even with an override
(`HOME_IN_LIFECYCLE_AREA`). The tool never invents a home and never creates a category index.

**Category names (chosen where the design names a kind, not a name)**: Religion, Law, Programme, Education, Ceremony and
Condition live in "the matching" index: `Religions`, `Laws`, `Programmes`, `Education`, `Ceremonies`, `Conditions`
(continental and national; `Arkonan Religions` at the world level), or a nation index. "A national history index" is
`<Nation> Historical Events` or `<Nation> History`. All of this is data in the owner table, so the owner corrects it with
a new pack version.

## Decision 3: nations, the three scalable levels (design 1.3)

`nation` names the nation an owner belongs to. A nation that is only a compact Reference in a Polities index (a
`[BSRC] <Nation> - …` page directly there) is refused with `NATION_NEEDS_INDEX`, whose message describes the change.
With `promoteNation: true` the SAME proposal makes `[INDEX] <Nation>` from AI Index in that Polities index (with drafted
routing text listing the Reference and the new owner), moves the Reference into it (`moveResource`: its id,
Dependencies and tags kept), places the new owner beside it, and checks the order again: the verify reads each new page's
neighbours, and **chosen** the job builder now works out again the expected neighbours of new pages made beside a page
the job then moves away (the new index stood next to the Reference before it moved; this also hardens F3a's Kamigawa
Miyuki pattern). Moving an Authoritative page makes the proposal canonical: the job's lifecycle marker carries
`canonical` with the reason "moves the Authoritative page … (promoteNation)", so even a Working owner's package is
"Approve and accept as canon" when it promotes a nation (the restructure is canon; the owner itself is drafted in
Working). A nation that already has its index refuses `promoteNation` (`NATION_ALREADY_INDEXED`).

`createSubindex: "<Nation> <Category>"` makes one national subindex, as its own named step (its page line says "national
subindex (createSubindex): its own, named step"), only for a category the type lives in (`SUBINDEX_NOT_ALLOWED`), never
over an existing one (`SUBINDEX_EXISTS`); it combines with `promoteNation`. Subindexes are never made automatically.

## Decision 4: the race roster (the owner's ruling, design 1.1a)

`type: "Species"` takes `kind`: `race` (home: a racial group's `<Group> - Racial Group Reference`, or Races of Arkona
itself for a race of no group; name `<Race> - Core Information`; Reference Type `Race Core Reference`; tags status,
Species), `racialGroup` (home: Races of Arkona; `<Group> - Racial Group Reference`; Reference Type `Racial Group
Reference`; tags status, Species, Racial Group) or `subrace` (home: its race's Core Information page; `<Subrace> -
Subrace Reference`; the Reference Type from the package; tags status, Species). These pages are homes only for these
kinds; any other species and every creature go to the Bestiary; no other substantive page is ever a home without
`homeOverride`. A kind's Reference Type and name are fixed (`REFERENCE_TYPE_FIXED`, `DESCRIPTOR_FIXED`).

A new race or racial group has no character navigation (`Characters / <Group> / <Race>`) yet: the tool warns
(`CHARACTER_NAVIGATION_MISSING`, with the path). `createCharacterNavigation: true` adds `[INDEX] <Race>` (or `<Group>`) as
its own step. **Chosen**: because `arkona_create_character` places characters by the registry's Character taxonomy, the
same job then records ONE taxonomy entry for the new index (a `bridge.record` step, as the Repository Mappings page's
"Add missing" would: the singular by the same rules, the parent entry, the asset folder; audited
`registry.taxonomy_add_entry`), and the proposal says so. A singular guessed by a rule is left for the owner's review on
Repository Mappings (the registry's own rule: `RACE_NEEDS_REVIEW` until then), and the preview warns about it
(`TAXONOMY_SINGULAR_GUESS`). Nothing else of the taxonomy changes.

## Decision 5: name, facts, text, links and tags (design 1.4)

- **Name**: `<Subject> - <descriptor>`, the descriptor defaulting to the Reference Type (`DESCRIPTOR_REQUIRED` when
  neither is usable); a `name` holding " - " with no descriptor is read as both (said in the notes). Dashes replaced and
  listed, CANON and dates refused, as F3a; a sibling of the same name refused (`OWNER_EXISTS`), in its place now and,
  for a Working owner, in the place it will be promoted to.
- **Facts**: Subject is the name; Reference Type, Scope and Temporal Scope are required (`OWNER_FACTS_INCOMPLETE`:
  "ask the owner, never invent"); `{ value: "Unestablished", reason }` as F3a, the reason written into Unresolved
  Material; Status, Continuity Type, Continuity and Inheritance from `status` and `continuity` (**chosen**: `continuity`
  is "Main", the default, or an alternate universe's name, which makes the page AU); Supersedes "None" unless given; Last
  Major Revision set by the job. Only rows the template has, in its rank order.
- **Text**: Purpose first, the agent's sections, Source Boundaries and Unresolved Material warned about when missing, no
  empty or placeholder section. The template's own placeholder headings the package does not fill are removed: the page's
  text replaces the template copy's, keeping only what Markdown cannot express (a collection, `unsupported` content); the
  filler's note on the job lists the headings it left out (`droppedHeadings`).
- **Links**: Dependencies name current Authoritative owners only (`DEPENDENCY_NOT_AUTHORITATIVE` for a Working or
  Archived page or an index, a Working owner's included); Related Sources follow F3a's rule.
- **Tags**: `CANON` (or `AU`, decision 6), the primary, optionally one specialist from the type's closed list. **Chosen
  (the design's 1.4 read literally)**: a Working page gets `Working` and the primary tag only; a specialist tag given is
  held and reported (`heldTags`, slot `working`, "add it when the page is promoted"), never silently dropped. The two
  lists are data (`owners.tags`), so the owner can change the Working grammar with a new pack version.

## Decision 6: the AU ruling (the owner, 16 November 2026, design 1.5)

"An AU page carries the status tag `AU` in place of `CANON`, and Continuity Type AU stays in its facts." The pack records
the ruling with its date (`rulings: [{ key: "au-status-tag", date: "2026-11-16", by: "owner", … }]`) and its data
(`tags.au: { continuityType: "AU", tag: "AU" }`). Every pack tool computes the status tag from the page's lifecycle and
Continuity Type (`statusTag`): Working first for a Working page (an AU one too: the lifecycle tag replaces the status
tag, so neither CANON nor AU appears), AU for an Authoritative AU page, CANON otherwise. F3a's character tool changes to
match (an AU character's new Authoritative pages now carry AU; its test changed with it). A pack without `tags.au` keeps
CANON. The Tagging Standard does not record the ruling yet: when it does, the pack sees governance drift and is approved
again, as the design expects.

## Decision 7: `arkona_create_relationship` (design section 2)

A joint relationship of two EXISTING characters, on F3a's builder: the package is F3a's extension of `a` with one
relationship page `with` `b`. Both names are taken exactly as their indexes give them (a character with no index: its
subject); the page is `<a> & <b> - <label>` from AI Relationship, hosted by F3a's rule (`host: "a"`, the default, is
F3a's `self`; `"b"` is F3a's `other`, which needs b's index and refuses a Working relationship there), tagged
`CANON, Character, Relationship` (by the AU rule and the lifecycle as every page), and added to both participants'
Related Sources in the same proposal; F3a's rule for a Working relationship with a canon partner stands
(`PARTNER_LINK_DEFERRED`). F3a's routing line in the hosting index is kept. Refused: a character that does not exist
(`CHARACTER_NOT_FOUND`, pointing to `arkona_create_character`), an ambiguous one (`CHARACTER_AMBIGUOUS`), the same
character twice, and a pair that already has a relationship owner, by any label and in either order, anywhere in the
tree (`RELATIONSHIP_EXISTS`, naming it).

## Decision 8: `arkona_add_character_art` (design section 3)

F3a's art step on its own. Sources: `staged_id`, `upload_id`, or (for one image) ChatGPT's `file` (the tool declares
`_meta["openai/fileParams"]: ["file"]`, as `upload_image` does); an upload or file is staged on the bridge's server
first, exactly as `upload_image { stage: true }` with no destination (**chosen**: even on a dry run, since ChatGPT's link
expires; the answer gives the staged ids; the same original again is the same staged image). The folder is the
character's (`Characters / <race path> / <Name> / Forms | Outfits | Details / …`), found or created when the job runs;
names are `{Subject} - {Label}`, extension-free, numbered when taken; each image needs its interpretation (`BARE_IMAGE`).
The Art page is created when missing (F3a's extension, AI Character Art; its Purpose drafted when no text is given), or
**extended** under its "Reference Images" section: **chosen**, by a filler registered with the job engine
(`pack.art_append`) that appends the new image sections to the page as it is inside the lock (made before the boundary
sections when missing), with `judgedInLock` (the proposal captures no version of the page, so an edit elsewhere on it
never conflicts and nothing else is touched; `unsupported` blocks stay where they are), the image addresses bound from
the job's own asset steps. Retention approval is the proposal itself.

## Decision 9: `arkona_character_brief` (design section 4)

Read-only, from the bridge's own tree (the identity page's sidebar summary, the set's pages with their Reference Type
and Scope, relationships by name), snapshots (each page's newest document: Art pages' image counts, Unresolved Material
items) and audits (open findings on the set's pages), each with how fresh it is. It reads nothing from LegendKeeper,
not even the pack's governance; `live: true` re-reads the identity page's sidebar, one read.

## Decision 10: the staged-image takeover (design section 6)

A package takes over a staged image whose ONLY pending activity is its own placement proposal (made by `upload_image` at
scope `propose`): the proposal service's `isImagePlacement` (no high-level operation, every operation that image's
`place_image`) and a pending state decide it. After the package's proposal is captured, that placement proposal is
withdrawn (`proposals.supersede`: pending to rejected by `system`, reason "superseded by package prop_…", audited
`proposal.superseded`), the image's record follows the package, and the answer lists `takenOver`. Any other activity
(another package's proposal, an approved or running placement, a discard) is still `STAGED_IMAGE_BUSY`, now with the hint
to stage with no destination. If the placement proposal was decided in the moment between, the package's job checks,
before any write, that each image it places is still staged, on the server and placed by nothing else
(`STAGED_IMAGE_BUSY` in the job otherwise). The guide and the pack tools' descriptions tell agents to stage art with
`upload_image { stage: true }` and no destination.

## Decision 11: governance pins sections; drift still fails closed (design section 5)

A governance source may name the sections the rules depend on (`sections`); Arkona's pins Source Formatting's Page Names
and Templates, Nation-Centred Territorial Navigation, Approved Hierarchy and Active Template Suite, and the Tagging
Standard's Exact Tag Grammar and Closed Primary Categories. The approval records each section's SHA-256 (its heading
and the blocks to the next heading of its level or higher) and is refused when a pinned section cannot be found
(`GOVERNANCE_SECTION_MISSING`, listing the document's headings); headings match loosely (case, punctuation, numbering,
"&" for "and"). Drift still fails closed on the document's version, as F3a; the status now says which pinned section
changed (or "outside its pinned sections"), the Packs page shows it per source, and the drift record keeps the sections.

## Decision 12: the new seed reaches a stored pack as a new version (chosen)

F3a's rule stands: a seed never overwrites a stored pack. A seed may name the seeds it supersedes; at start, a pack
stored from one of them is offered the new seed's rules as a NEW version (audited `pack.seed_upgrade`), never approved
by the bridge: the owner's token maps are kept, the governance sources keep their stored places and take the seed's
names and pinned sections, and each attachment gains the template roles the rules now need (worked out by name).
Until the owner approves it on the Packs page, every package is refused (`PACK_NOT_CURRENT`, `rules_changed`).

## Decision 13: the job's re-checks, generalised (design section 5)

The job's `pack.absent` check takes, besides F3a's subject reservation and live listings: more reservations (an owner's
name in its home, a nation index, a relationship's pair), a refusal code per listed place (`OWNER_EXISTS`,
`NATION_INDEX_EXISTS`, `SUBINDEX_EXISTS`, `NAVIGATION_EXISTS`, `RELATIONSHIP_EXISTS`) with name prefixes (a pair under
any label), existing pages that must still be where the plan saw them (the Reference `promoteNation` moves:
`NATION_REFERENCE_MOVED`), and the staged images (decision 10). Each refuses before the job's first write. Where a
proposal captured an existing page's version (a relationship's Related Sources), the approval's own re-read may already
find the change and mark the proposal conflicted, also before anything is written.

## Decision 14: Last Major Revision by the owner's rule (ADR 0051), with `lastMajorRevision`

The owner asked, once F3.1 (ADR 0051) settled what a major revision is, that every pack tool editing an EXISTING page use
that rule and take its override. As built (`src/packs/engine/lmr.ts`):

- **Pages a package makes are always dated**, the day its job runs, whatever `lastMajorRevision` says (the owner's
  character-pack answer 10).
- **An existing page a package changes** is decided by ADR 0051's rule, from what the planner already read (no extra
  read): the facts as they were and as planned (a housekeeping key such as Reference Type never counts; trims, typos and
  punctuation do not), the link collections' additions and removals (a Dependency counts; Related Sources alone does
  not), the text the package adds or rewrites (an index's routing lines; an Art page's new image sections, each with a
  heading). A move and a new name never count. So `arkona_create_character` with `target` dates a Core whose gated fact
  it fills, but not an upgraded Reference that is only renamed and moved, nor a partner whose Related Sources gains the
  relationship; `arkona_create_relationship` leaves both participants' dates; `arkona_add_character_art` dates the Art
  page it extends; `promoteNation` leaves the moved Reference's date.
- **The override**, as for the general write tools: `lastMajorRevision: "auto"` (the default), `"set"` (date every
  existing page the package changes that has the row) or `"skip"` (date none of them). F2's per-project switches stay as
  ADR 0051 keeps them: the setting-pack switch (`lmrPackTools`) decides whether the rule is asked at all under `"auto"`,
  and names and moves (`lmrNamesTagsMoves`) or link collections (`lmrLinkCollections`), switched on, count as in F2.
- **Said, not hidden**: the preview and the answer carry `lastMajorRevision: { mode, newPages, existing: [{ page, set,
why }] }`; the proposal's summary and each changed page's line carry the general tools' words (`+ Last Major Revision →
date of approval (auto: a heading added (“…”))`, `Last Major Revision skipped: a move, not a major revision`). A page
  known to have no such row is left out. **Chosen**: the pack job keeps planning its own `bridge.lmr` steps (the engine's
  general planner leaves a request that has them alone, so nothing is dated twice) and passes the override to the engine
  too, for a package that ends up with none.
- Costs: unchanged for the packages measured (the decisions need no read; the steps are the ones F3a planned).

## Costs (measured against the mock, test/packs/owner-costs.test.ts)

| Package                                      | Plan reads | Job reads | Job writes |
| -------------------------------------------- | ---------- | --------- | ---------- |
| Compact owner, a dry run                     | 4          | 0         | 0          |
| Compact owner, Working                       | 4          | 20        | 13         |
| Compact owner, Authoritative                 | 4          | 18        | 13         |
| promoteNation: index, Reference moved, owner | 7          | 31        | 16         |
| Relationship of two canon characters         | 14         | 40        | 15         |
| Art: a new Art page with one image           | 7          | 27        | 16         |
| Art: one image on an existing Art page       | 4          | 11        | 3          |
| Brief                                        | 0          | -         | -          |
| Brief, `live: true`                          | 1          | -         | -          |

## Departures from the approved design, and why

| Design                                                                     | As built                                                                                                      | Why                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Subject is a required fact                                                 | Subject is the package's `name` (always given)                                                                | The name's first part is the Subject; asking for it twice invites a mismatch                                                              |
| A new race "needs character navigation" before placement                   | `createCharacterNavigation` also records one Character taxonomy entry for the new index (reviewed if guessed) | The character tool places by the registry's taxonomy; an index alone would still not place anyone                                         |
| Art: "staged_id, file or upload_id"                                        | `file` is one top-level attachment, for the one image with neither other source                               | ChatGPT fills declared file parameters at the top level only (ADR 0049 decision 11)                                                       |
| Art: images "come from staged_id, file or upload_id"                       | An upload or file is staged on the bridge's server first, even on a dry run (its staged id returned)          | A ChatGPT link expires before a second call can use it                                                                                    |
| A Working page gets Working + the primary tag (1.4)                        | As written; a specialist tag given is held and reported                                                       | 1.5 says lifecycle tags "replace the status tag", which could keep the specialist: the literal reading is the safer, and the rule is data |
| promoteNation "places the new owner beside it"                             | For a Working owner, the restructure is made and the owner drafted under [INDEX] Working                      | A Working page cannot sit under a canon index (the lifecycle guard); it is promoted into the new index later                              |
| HOME_NOT_ALLOWED lists "suitable indexes nearby"                           | Nearest by tree distance; for a home not found, nearest to the root (`HOME_NOT_FOUND`)                        | "Nearby" needs a measure; a home that does not exist has no place to measure from                                                         |
| Relationship: hosting by F3a's rule                                        | F3a's routing line in the hosting index is added too                                                          | F3a's builder does so for every new page under an existing character index                                                                |
| F3a's answer 10: Last Major Revision on every page "substantially" changed | ADR 0051's rule decides for existing pages; `lastMajorRevision` overrides; new pages always dated             | The owner's instruction after F3.1 landed: one rule for every tool                                                                        |

## Consequences

- After deploying, the stored Arkona pack has a new version waiting for the owner (decision 12): approve it on the Packs
  page. Its approval needs the six pinned sections to be found on Arkona's governance pages.
- Every pack tool's AU pages carry AU. The general bridge's tools are unchanged: **left for later** (outside the pack
  tools): `promote_page` still writes CANON when it promotes an AU page, and the lifecycle audit still expects CANON on
  an Authoritative AU page; both should learn the ruling from the pack.
- Four tools are added (67 with the per-operation tools off, 156 with them on; 61 in a `propose` or `write` profile while
  a pack is attached, 26 in a `read` profile, the brief being a read tool).
- ADR 0051's "Left" item for the setting-pack tools (they did not apply the rule or take `lastMajorRevision`) is done
  here (decision 14).
- Left for later: editing the owner table on the dashboard (it is read-only there; a new version comes from the seed or
  the owner's `replaceRules`), a routing line in an existing home index (the owner tool leaves it, and says so), the
  monolith split and selective approval (PLAN-v2 10.5).
