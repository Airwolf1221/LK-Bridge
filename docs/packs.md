# Setting packs (v3 F3a and F3b)

A **setting pack** holds one setting's rules as data, above the general bridge (PLAN-v2 section 10): which pages a kind
of subject gets, from which templates, under which names and in which place, with which sidebar facts and tags, and the
text rules its pages follow. The bridge's code holds the engine that applies any pack's rules and a few small hooks for
what data cannot say. The first pack is **Arkona**, attached to the `arkona` and `test` projects. Its tools:

| Tool                         | What it makes                                                                  | Since |
| ---------------------------- | ------------------------------------------------------------------------------ | ----- |
| `arkona_create_character`    | a character's set of pages, or new pages for an existing character             | F3a   |
| `arkona_create_owner`        | one non-character owner page, typed by the owner table (below)                 | F3b   |
| `arkona_create_relationship` | one joint relationship page for two existing characters                        | F3b   |
| `arkona_add_character_art`   | reference images for an existing character, on its Art page                    | F3b   |
| `arkona_character_brief`     | nothing: a read-only brief on a character, from the bridge's own records, free | F3b   |

Design: [ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md) and the owner-approved
[character pack design](design/F3-character-pack.md) (F3a); [ADR 0052](adr/0052-arkona-pack-owners-relationships-art-and-the-brief.md)
and the owner-approved [F3b design](design/F3b-owner-tools.md) (F3b). The tools' reference:
[tools.md](tools.md#setting-packs-arkona_create_character-v3-f3a) and
[tools.md](tools.md#setting-packs-owners-relationships-art-and-the-brief-v3-f3b). The agents' guide: the "Setting packs
(Arkona)" section of [bridge-guide.md](bridge-guide.md), a part per tool. The dashboard page:
[dashboard.md](dashboard.md#packs-v3-f3a).

## What a pack holds

One versioned JSON document, its **rules** (`src/packs/types.ts` checks its shape):

- **settings**: `alwaysPropose` (every package is a proposal for the owner, whatever the agent's scope; on for a pack's
  first weeks).
- **tags**: the status tags (`CANON` for Authoritative, `Working` for Working, first and with no `CANON`), the AU rule
  (`au`: the Continuity Type that makes a page AU and the tag it carries in place of `CANON`; v3 F3b), the values that are
  never tags (`Unknown`, `Unestablished`, `None`), the **token maps** (a Race / Species or Naming Culture value and the
  tag token it becomes) and the exceptional identity kinds.
- **names**: words never in a page name (`CANON`) and the date patterns refused in one.
- **sidebar**: the key-value property's title (`PROPERTIES`) and the two link collections (Dependencies, Related
  Sources).
- **types**, each with its tool name (`create_character` becomes `arkona_create_character`), its hook (or none), its
  placement (by a fact through the registry's taxonomy, with a fallback index; or under one fixed index), its **roles**
  (each with its template role, name pattern, Reference Type, tag slots, which facts it gets, whether text is required,
  the sections warned about when missing, and how many a package may bring), its identity fields (which are **gated**:
  required, never blank or a placeholder), the deliberate gap (`Unestablished`, only with a reason), the placeholders
  refused, the fixed facts, the closed list of specialist tags, suggested Reference Types, the asset rules (the folder
  names for forms, outfits and details; the image name; the Art page's section), the index rules (its Purpose, routing
  section, collection and boundaries) and the text rules (the first heading; the Core-overload warning).
- **owners** (v3 F3b): the owner table behind `arkona_create_owner` ([below](#the-owner-table-v3-f3b)): the shared facts,
  tag grammar, index wording and race roster, and the 19 types with their templates, primary and specialist tags and
  allowed homes.
- **rulings** (v3 F3b): the owner's rulings the rules carry, each with its key, date, who made it and what it says (the
  AU status tag, 16 November 2026).

Beside the rules a pack keeps its **governance sources** (the pages its rules were derived from: for Arkona, the
Character Architecture, Source Formatting and Controlled Native Tagging Standard v1.8 documents on the AI REPOSITORY
page, and since v3 F3b the **sections** of them the rules depend on: Source Formatting's Page Names and Templates,
Nation-Centred Territorial Navigation, Approved Hierarchy and Active Template Suite, and the Tagging Standard's Exact Tag
Grammar and Closed Primary Categories), the projects it is **attached** to with the template ids it uses in each, every
**version** of its rules, and the owner's **approval**.

Storage (migration `3000`; v3 F3b needs no migration, its additions live in the rules and governance JSON):
`packs` (the current rules, governance, approval, drift), `pack_projects` (attachments and template ids),
`pack_versions` (every version with its reason) and `pack_reservations` (a running job's claim on what it is about to
make: a new character's name, an owner's name in its home, a nation index, a relationship's pair; so two approved
packages cannot both create it).

## Seed, attach, approve

1. **Seeded once.** At start the bridge stores each pack it knows (`src/packs/arkona.ts`, data) if it is not stored yet
   (audited `pack.seed`). After that the stored copy is the owner's: it is never overwritten by code. **A new seed is
   offered, never imposed** (v3 F3b): a seed names the seeds it supersedes (`arkona-2026-11-16-f3b` supersedes F3a's
   `arkona-2026-11-16`), and a pack stored from one of them is given the new seed's rules as a NEW version at start
   (audited `pack.seed_upgrade`), keeping the owner's token maps and the governance sources' places, taking the seed's
   source names and pinned sections, and adding to each attachment the template roles the new rules need. It waits for
   the owner's approval like any other version.
2. **Attached** to the projects the seed names, when the bridge serves them (`pack.attach`). Template ids differ between
   projects: the home project's are given (Arkona's AI Character Core, AI Compact Character Reference, AI Character Art,
   AI Relationship, AI General Source and the index template); another project's are worked out from the home project's
   template **names**, matched exactly, from each project's templates as last read on Repository Mappings. The four roles
   v3 F3b adds (AI Polity and Institution, AI Place and Divine Realm, AI Magic and Technology, AI Creature and Species)
   are named in the seed and worked out by name in every project, Arkona included. A role that
   cannot be worked out stays unset, with a note on the Packs page, and a package that needs it is refused
   (`PACK_TEMPLATE_UNSET`) until the owner refreshes the templates and approves again (an approval works the unset ids out
   again).
3. **Approved** by the owner on the Packs page: the current version, with each governance source's document version read
   at that moment and (v3 F3b) a digest of each pinned section (`pack.approve`, re-authenticated). An approval is refused
   when a pinned section cannot be found on its page (`GOVERNANCE_SECTION_MISSING`, listing the page's headings; a heading
   renumbered, recased or written with "&" for "and" is still found). Until a version is approved, the pack's tools
   compute nothing.

A pack's tools are listed to agents only while the pack is attached to a project the bridge serves, and refuse any other
project (`PACK_NOT_ATTACHED`).

## Derived, never competing: drift fails closed

The Controlled Native Tagging Standard says a machine-readable translation of it must be "explicitly identified as
derived" and must "compare policy version/digest before writing". So:

- every preview reads each governance source's current document version (three reads for Arkona) and compares it with
  the approved one;
- every job reads them again, in the lock, before its first write (`PACK_GOVERNANCE_CHANGED` stops it otherwise);
- when a source has changed, or the rules were edited since the approval, or a source cannot be read, the pack is not
  current: **no tags are computed**, every package is refused (`PACK_NOT_CURRENT`, naming what changed), and the Packs
  page shows an alert (`pack.drift` is audited when a check first sees it). The owner reads the changed page, adjusts
  the token maps if needed, and approves again.
- since v3 F3b the message names the **pinned section** that changed ("Source Formatting (pinned section “Approved
  Hierarchy”)"), or says the change is outside the pinned sections; the Packs page shows each section's state. The
  document's version still decides: a change anywhere on a governance page stops the pack, as before.

## Editing a pack

F3a edits only the **token maps**, on the Packs page: a value and its token per row, for Race / Species and Naming
Culture. A save makes a new version (`pack.set_tokens`, re-authenticated), which waits for approval. A token is never a
never-tag, and no value or token has an em or en dash in it. Everything else in the rules is read-only in F3a: the service's `replaceRules` command (the tests use it) makes a new
version the same way (`pack.replace_rules`), and a seed never overwrites a stored pack.

**A value with no token is held, not invented.** When a character's race or naming culture has no token, that tag slot is
left out and reported in the preview (`heldTags`); the page is still made. Add the token on the Packs page and approve,
then add the tag with `update_resource` if the page should have it now.

## The tags Arkona computes (Controlled Native Tagging Standard v1.8)

| Page                              | Tags, in order                                                           |
| --------------------------------- | ------------------------------------------------------------------------ |
| Character Core, Compact Reference | status, `Character`, race token, naming culture token (once if the same) |
| Specialist page (Biography, …)    | status, `Character`, its one specialist tag (optional)                   |
| Character Art                     | status, `Character`, `Character Art`                                     |
| Relationship                      | status, `Character`, `Relationship` (never a participant's race)         |
| `[INDEX]` of a character          | none                                                                     |
| Owner page (v3 F3b)               | status, its type's primary tag, at most one specialist tag               |
| Owner page, Working (v3 F3b)      | `Working`, its type's primary tag                                        |
| Index made by the owner tool      | none                                                                     |

The status is `CANON` for an Authoritative page and `Working` for a Working one (which never carries `CANON`). An agent
never types a tag: an extra one is refused (`TAG_NOT_ALLOWED`).

**The AU ruling (the owner, 16 November 2026).** An AU page (Continuity Type AU) carries the status tag `AU` in place
of `CANON`, and Continuity Type AU stays in its facts; everything after the status tag follows the same grammar. A
Working or Archived AU page leads with `Working` or `Archived`, so neither `CANON` nor `AU` appears on it. It holds for
every pack tool (`arkona_create_character` changed with it) and is recorded in the pack's `rulings` with its date and in
`tags.au`. The Tagging Standard does not record it yet: when it does, the pack sees governance drift and the owner
approves it again. Outside the pack tools, `promote_page` and the lifecycle audit do not know the ruling yet (left for
later, ADR 0052).

## The character tool, in short

`arkona_create_character` takes one package (the name, `depth`, `status`, the identity facts, only the pages with real
content, the index text) and builds the set: a Compact Character Reference under its race index for a minor character,
or an `[INDEX] {name}` with a Character Core and one page per domain for a developed one; Art pages with staged images
placed in the character's asset folder; relationships hosted under one participant and linked from both. It previews
everything first (`dryRun`), then makes **one proposal**; on approval it runs as one job and verifies what it wrote. With
`target` it adds pages to an existing character without duplicating it: new pages take the character's standing, a
Compact Reference gets an index in its place when it gains siblings (its id kept), `upgradeToCore` makes it a Core, and
the index's routing section gains a line per new page. Its gate: a new character's six identity fields are required,
and an agent asks the owner rather than guess. The full reference is in [tools.md](tools.md#setting-packs-arkona_create_character-v3-f3a).

## The owner table (v3 F3b)

`arkona_create_owner` makes every non-character owner. The five non-character templates share one sidebar (Status,
Continuity Type, Continuity, Inheritance, Subject, Reference Type, Scope, Temporal Scope, Last Major Revision,
Supersedes, then Dependencies, Related Sources and TAGS), so a type is data: its template, primary tag, closed specialist
tags and allowed homes. `<Continent>` stands for a continent's name, `<Nation>` for a nation's; a **nation index** is
an index directly in a `<Continent> Polities` index.

| Type                                           | Template                  | Primary             | Specialist tags                             | Homes                                                                                                                                                 |
| ---------------------------------------------- | ------------------------- | ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Polity                                         | AI Polity and Institution | Polity              | Government                                  | `<Continent> Polities`; a nation index                                                                                                                |
| Institution                                    | AI Polity and Institution | Institution         | Government, Religion                        | `<Continent> Institutions`; a nation index; `<Nation> Institutions`; `<Nation> Government & Administration`                                           |
| Military ★                                     | AI Polity and Institution | Military            |                                             | a nation index; `<Nation> Institutions`                                                                                                               |
| Culture                                        | AI General Source         | Culture             | Language, Naming                            | `<Continent> Cultures`; `<Nation> Cultures`; `Arkonan Cultures`; `Divine Realm Cultures`                                                              |
| Event                                          | AI General Source         | Event               | Conflict                                    | `<Continent> Historical Events`, `<Continent> Conflicts`; `Arkonan Historical Events`, `Arkonan Conflicts`; `<Nation> Historical Events` or `History` |
| Place                                          | AI Place and Divine Realm | Place               | Continent, Region, Settlement, Divine Realm | `<Continent> Regions`; `<Continent> Settlements & Locations`; `<Nation> Settlements & Locations`; a Divine Realm index                                |
| Technology, Magic                              | AI Magic and Technology   | Technology, Magic   |                                             | `<Continent> Unique Magic & Technologies`; `<Nation> Unique Magic & Technologies`; a nation index                                                     |
| Material ★, Equipment ★                        | AI Magic and Technology   | Material, Equipment | Equipment: Sacred Blade                     | as Technology                                                                                                                                         |
| Species                                        | AI Creature and Species   | Species             | a racial group: Racial Group                | the Bestiary; with `kind`, the race roster (below)                                                                                                    |
| Creature                                       | AI Creature and Species   | Creature            |                                             | the Bestiary                                                                                                                                          |
| Religion                                       | AI General Source         | Religion            |                                             | `<Continent> Religions`; `<Nation> Religions`; `Arkonan Religions`; a nation index                                                                    |
| Law, Programme, Education, Ceremony, Condition | AI General Source         | its own name        |                                             | `<Continent>` or `<Nation>` `Laws`, `Programmes`, `Education`, `Ceremonies`, `Conditions` (the matching one); a nation index                          |
| Relationship (between polities)                | AI General Source         | Relationship        |                                             | `<Continent> Institutions`                                                                                                                            |

★ The owner confirmed (16 November 2026) the template of Military, Material and Equipment.

**Recognising a home.** By the index's name and place in the tree: `<Continent> <Category>` is an index so named whose
nearest ancestor index named `<Continent>` is not a nation (so `Salahad Conflicts` beneath `Salahad Historical Events`
counts); `<Nation> <Category>` the same beneath a nation index; `Arkonan <Category>` the world level; a Divine Realm index
is an index directly under `[INDEX] Divine Realms`; the Bestiary by its id, else its name. A home that does not match is
refused (`HOME_NOT_ALLOWED`) with up to five allowed homes nearby; `homeOverride { reason }` places it anyway with the
reason in the proposal. No category index is ever made; a national subindex only by `createSubindex`; a nation's own
index only by `promoteNation` (which moves its compact Reference into it).

**The race roster (the owner's ruling, 16 November 2026).** Races of Arkona and its racial group and race pages are the
homes of the roster only, by `kind`:

| `kind`        | Home                                                                          | Page                               | Reference Type         | Tags                              |
| ------------- | ----------------------------------------------------------------------------- | ---------------------------------- | ---------------------- | --------------------------------- |
| `racialGroup` | Races of Arkona                                                               | `<Group> - Racial Group Reference` | Racial Group Reference | status, `Species`, `Racial Group` |
| `race`        | its group's `<Group> - Racial Group Reference`, or Races of Arkona (no group) | `<Race> - Core Information`        | Race Core Reference    | status, `Species`                 |
| `subrace`     | its race's `<Race> - Core Information`                                        | `<Subrace> - Subrace Reference`    | from the package       | status, `Species`                 |

Any other species, and every creature, goes in the Bestiary. A new race or racial group needs its character navigation
(`Characters / <Group> / <Race>`) before `arkona_create_character` can place its characters: the owner tool warns
(`CHARACTER_NAVIGATION_MISSING`), and `createCharacterNavigation: true` makes the `[INDEX]` and records one Character
taxonomy entry for it (audited `registry.taxonomy_add_entry`; a guessed singular waits for the owner's review on
Repository Mappings).

**Changing the table.** It is data: a new version of the rules (the service's `replaceRules`, or a new seed offered at
start), approved by the owner. The Packs page shows it read-only.

## Last Major Revision (v3 F3b, by ADR 0051's rule)

Every page a package makes is dated the day its job runs (the owner's character-pack answer 10), whatever is asked. An
existing page a package changes is dated by the owner's rule for real revisions (ADR 0051, `src/lmr`), applied by the
pack's job builder (`src/packs/engine/lmr.ts`) from what the planner already read: a fact changed (not a housekeeping
key, a trim or a typo), a Dependency added or removed, 8 or more words of text, a heading. A move, a new name and
Related Sources alone are never enough on their own (unless the owner switched names and moves, or link collections, on
for the project), so `promoteNation`'s moved Reference, an upgraded Reference's new name and a relationship's links keep
their date; an Art page's new image sections and a filled-in gated fact set it. The four write tools take
`lastMajorRevision: "auto" | "set" | "skip"` (the same override as the general write tools) for those existing pages; the
project's `lmrPackTools` switch still decides whether the rule is asked under `"auto"`. The preview, the answer, the
proposal's summary and each page's line say what was decided and why.

## Relationships, art, the brief and the staged-image takeover (v3 F3b)

- **`arkona_create_relationship`** builds on the character tool: the package is the character tool's extension of `a`
  with one relationship page `with` `b`, named with both names exactly as their indexes give them, added to both
  characters' Related Sources in the same proposal. A missing character (`CHARACTER_NOT_FOUND`) or a pair that has a
  relationship page already, under any label and in either order (`RELATIONSHIP_EXISTS`), is refused.
- **`arkona_add_character_art`** is the character tool's art step on its own: images placed in the character's folders
  (found or made when the job runs) under semantic, extension-free names, shown on the Art page, which is made when
  missing or extended under "Reference Images" by the `pack.art_append` filler (inside the job's lock, nothing else on
  the page touched).
- **`arkona_character_brief`** reads the bridge's own tree, snapshots and audits, never LegendKeeper (`live: true`: one
  read of the identity page's sidebar), and does not need the pack to be current.
- **The takeover.** A package that names a staged image whose only pending activity is its own placement proposal (what
  `upload_image` with a destination does at scope `propose`) withdraws that proposal once the package's is captured
  ("superseded by package prop_…", audited `proposal.superseded`) and places the image itself. Anything else is still
  `STAGED_IMAGE_BUSY`; the job checks again before it writes.

## Types as data, and what F3b extends

The engine never assumes it is making a character: a type's rules say what it makes, and a hook (`src/packs/hooks.ts`)
answers only what data cannot say. A type with no hook gets the generic behaviour, and a tool name shared by a pack's
types (other than `arkona_create_character` and `arkona_create_owner`, which have their own schemas) is served by a
**generic pack tool**, `{prefix}{tool}` with a `type` argument, listed while its types exist. The tests define a dummy
"Ward" type in data only and run it through plan, preview, proposal and verify with no code change (F3a's dummy was a
"Polity"; Polity is a real owner type since F3b).

The extension points named for F3b (ADR 0050):

- **a type's hook**: `identityRole` (which page holds a new subject's identity), `wantsIndex` (when a set gets an
  index), `relationships` (pages shared by two subjects, hosted under one), `upgrade` (an existing identity page that can
  become another role), `routing` (whether new pages are announced in an index's routing section);
- **placement kinds**: `taxonomy` (by a fact through the registry) and `fixed` (under one index); a new kind is a small
  addition to the planner;
- **roles** with their own template, name, tags and facts (outfits, species, institutions, nations are new types and
  roles, not new engines);
- **the registered checks** the job runs in the lock and at verify (`pack.governance`, `pack.absent`, `pack.page`), and
  the **filler** that writes a template copy's text while keeping the template's collection block;
- **selective approval and resuming a part-built package** (PLAN-v2 10.5) and **splitting an existing page** (refused
  in F3a: `MONOLITH_SPLIT_UNSUPPORTED`) were named for F3b; the owner's F3b design did not take them up, and they are
  still left for later.

What F3b added to the engine: the owner table and its planner (`src/packs/engine/owner.ts`, homes in
`src/packs/engine/homes.ts`), more reservations and re-checks in `pack.absent` (an owner's name, a nation index, a
relationship's pair, a page that must still be where the plan saw it, the staged images), the `pack.art_append` filler,
a `taxonomy_entry` record for new character navigation, the canonical marker for a package that moves canon, and the
pinned governance sections.

## When a package is refused

| Code                                   | What to do                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PACK_NOT_CURRENT`                     | The owner checks the governance pages and approves the pack again on the Packs page                      |
| `PACK_NOT_ATTACHED`                    | Use a project the pack is attached to (the message names them)                                           |
| `PACK_TEMPLATE_UNSET`, `…_UNKNOWN`     | The owner refreshes the project's templates (Repository Mappings) and approves the pack again            |
| `TEMPLATES_NOT_READ`                   | The owner refreshes the project's templates (Repository Mappings)                                        |
| `LIFECYCLE_NOT_CONFIGURED`             | The owner confirms the Working index (Projects page, Lifecycle), or the package uses `"authoritative"`   |
| `IDENTITY_INCOMPLETE`                  | The agent asks the owner for the missing values; never guesses                                           |
| `CHARACTER_EXISTS`                     | Call again with `target` (the existing character's name or id)                                           |
| `PACK_GOVERNANCE_CHANGED` (in the job) | A governance page changed after the proposal: approve the pack again, then ask for a new package         |
| `GOVERNANCE_SECTION_MISSING` (approve) | A pinned section is not on its page: the owner restores the heading, or the pack's sections change       |
| `HOME_NOT_ALLOWED`                     | Choose one of the allowed homes listed; `homeOverride` only on the owner's decision                      |
| `NATION_NEEDS_INDEX`                   | Call again with `promoteNation: true` (the nation's index made in the same proposal)                     |
| `OWNER_FACTS_INCOMPLETE`               | The agent asks the owner for Reference Type, Scope or Temporal Scope; never guesses                      |
| `CHARACTER_NOT_FOUND`                  | Make the character first with `arkona_create_character`                                                  |
| `RELATIONSHIP_EXISTS`                  | Edit the relationship page the message names with `write_page`                                           |
| `STAGED_IMAGE_BUSY`                    | The image is in another package: stage the art again with `upload_image { stage: true }`, no destination |
