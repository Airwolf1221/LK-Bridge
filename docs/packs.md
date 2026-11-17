# Setting packs (v3 F3a, F3b and F3c)

A **setting pack** holds one setting's rules as data, above the general bridge (PLAN-v2 section 10): which pages a kind
of subject gets, from which templates, under which names and in which place, with which sidebar facts and tags, and the
text rules its pages follow. The bridge's code holds the engine that applies any pack's rules and a few small hooks for
what data cannot say. The first pack is **Arkona**, attached to the `arkona` and `test` projects. Its tools:

| Tool                         | What it makes                                                                                                                               | Since |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `arkona_create_character`    | a character's set of pages, or new pages for an existing character                                                                          | F3a   |
| `arkona_create_owner`        | one non-character owner page, typed by the owner table (below)                                                                              | F3b   |
| `arkona_create_relationship` | one joint relationship page for two existing characters                                                                                     | F3b   |
| `arkona_add_character_art`   | reference images for an existing character, on its Art page                                                                                 | F3b   |
| `arkona_character_brief`     | nothing: a read-only brief on a character, from the bridge's own records, free                                                              | F3b   |
| `arkona_appraise_owner`      | nothing: a page, branch or everything appraised against Source Formatting                                                                   | F3c   |
| `arkona_change_impact`       | nothing: what depends on a page, a planned rename or a pending proposal                                                                     | F3c   |
| `arkona_working_digest`      | nothing: Working pages, open proposals, unpromoted sets, contradictions                                                                     | F3c   |
| `arkona_visual_hygiene`      | nothing: the visual references, candidates only                                                                                             | F3c   |
| `arkona_appraisal_fix`       | Repairs one appraisal finding with a deterministic fix: at scope `write` at once (its switch follows the scope, v3 F3.4), else ONE proposal | F3c   |

Design: [ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md) and the owner-approved
[character pack design](design/F3-character-pack.md) (F3a); [ADR 0052](adr/0052-arkona-pack-owners-relationships-art-and-the-brief.md)
and the owner-approved [F3b design](design/F3b-owner-tools.md) (F3b); [ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md)
and the owner-approved [F3c design](design/F3c-appraisal.md) (F3c). The tools' reference:
[tools.md](tools.md#setting-packs-arkona_create_character-v3-f3a),
[tools.md](tools.md#setting-packs-owners-relationships-art-and-the-brief-v3-f3b) and
[tools.md](tools.md#setting-packs-appraisal-and-full-text-search-v3-f3c). The agents' guide: the "Setting packs
(Arkona)" section of [bridge-guide.md](bridge-guide.md), a part per tool. The dashboard pages:
[dashboard.md](dashboard.md#packs-v3-f3a) and [Appraisal](dashboard.md#appraisal-v3-f3c).

## What a pack holds

One versioned JSON document, its **rules** (`src/packs/types.ts` checks its shape):

- **settings**: `alwaysPropose` (every package is a proposal for the owner, whatever the agent's scope; on for a pack's
  first weeks), and since v3 F3.4 **`tools`**, a switch per writing tool that overrides it: `propose` (always a
  proposal) or `scope` (follows the agent's scope: at scope `write` the package runs and the owner reviews it afterwards
  on the Review page). The Arkona seed: `arkona_create_character`, `arkona_create_owner` and
  `arkona_create_relationship` propose; `arkona_add_character_art` and `arkona_appraisal_fix` follow the scope; the
  read-only tools have no switch ([ADR 0055](adr/0055-write-scope-review-revert-rails.md) decision D). Changing a
  switch on the Packs page (**Save tool switches**, re-authenticated, audited `pack.set_tool_modes`) makes a new version,
  which waits for the owner's approval like any other.
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
- **lifecycleTagPosition** (v3 F3d): where the four lifecycle tools put the lifecycle tag, per attached project by its
  name: `lead` or `append` (a project not named: `append`). Arkona's seed says `{ "arkona": "lead" }`
  ([below](#the-lifecycle-tag-and-au-in-the-lifecycle-tools-v3-f3d)).

Beside the rules a pack keeps its **governance sources** (the pages its rules were derived from: for Arkona, the
Character Architecture, Source Formatting and Controlled Native Tagging Standard v1.8 documents on the AI REPOSITORY
page, and since v3 F3b the **sections** of them the rules depend on, pinned by their exact headings, below), the
projects it is **attached** to with the template ids it uses in each, every **version** of its rules, and the owner's
**approval**.

### The pinned sections

Arkona's seed pins six sections, by the headings exactly as the pages have them (read on 16 November 2026; ADR 0052,
amendment):

| Page                                                     | Pinned heading                                     |
| -------------------------------------------------------- | -------------------------------------------------- |
| Source Formatting (`cn8v87hh/l41y28c8`)                  | Page Names and Templates                           |
| Source Formatting                                        | Nation-Centred Territorial Navigation              |
| Source Formatting                                        | Approved Hierarchy and Standardised Navigation     |
| Source Formatting                                        | Active Template Suite and Sidebar Collections      |
| Controlled Native Tagging Standard (`cn8v87hh/bfrv43jr`) | Exact Tag Grammar                                  |
| Controlled Native Tagging Standard                       | Closed Primary Categories and Specialist Functions |

A pinned heading matches a page heading **as a whole**: case, spacing, punctuation, a leading number ("3.", "B)") and
"&" for "and" are ignored, but there is no prefix or nearest match, so "Approved Hierarchy" does not find "Approved
Hierarchy and Standardised Navigation". A pinned section must be unambiguous. (F3b's seed, `arkona-2026-11-16-f3b`,
pinned three of them abbreviated, so its version could not be approved; the seed `arkona-2026-11-16-f3b1` replaces it.)

### Re-mapping a pinned heading

When a pinned heading is not on its page (an approval refused with `GOVERNANCE_SECTION_MISSING`, or a governance check
after a page renamed a pinned heading), the Packs page shows each missing heading beside a picker of that page's actual
headings, in order with their levels. Choosing one and pressing **Re-map** (the password again) re-maps the pin:

- the new heading must be one of the page's headings as read now (matched whole, as above); one already pinned on that
  page cannot be chosen;
- the mapping becomes part of a **new pack version** (`pack_versions`, its reason "pinned section of … re-mapped on the
  Packs page: “old” → “new”"), which waits for the owner's approval like any other: the owner approves the mapping and
  the version together, and the approval records the section's digest under its new heading;
- it is audited (`pack.remap_section`, the old heading in `before`, the new one in `after`, with the versions).

A renamed governance heading is therefore an expected drift, not a dead end. If a section was removed rather than
renamed, the rules derived from it need checking first: re-map only to the section that now says the same thing. A
later seed that names its own pinned headings replaces a re-mapped one when it is offered (and the owner approves it).
API: `POST /api/admin/packs/:id/sections` `{ source, from, to, confirm: true }` (re-authenticated). Refusals:
`SECTION_NOT_PINNED` (`from` is not pinned), `HEADING_NOT_FOUND` (`to` is not on the page now, with its outline),
`SECTION_ALREADY_PINNED`, `SOURCE_NOT_FOUND`, `GOVERNANCE_UNREADABLE`.

Storage (migration `3000`; v3 F3b needs no migration, its additions live in the rules and governance JSON):
`packs` (the current rules, governance, approval, drift), `pack_projects` (attachments and template ids),
`pack_versions` (every version with its reason) and `pack_reservations` (a running job's claim on what it is about to
make: a new character's name, an owner's name in its home, a nation index, a relationship's pair; so two approved
packages cannot both create it).

## Seed, attach, approve

1. **Seeded once.** At start the bridge stores each pack it knows (`src/packs/arkona.ts`, data) if it is not stored yet
   (audited `pack.seed`). After that the stored copy is the owner's: it is never overwritten by code. **A new seed is
   offered, never imposed** (v3 F3b): a seed names the seeds it supersedes (`arkona-2026-11-17-f3-4`, v3 F3.4, the tool
   switches, supersedes F3a's `arkona-2026-11-16`, F3b's `arkona-2026-11-16-f3b`, F3b.1's `arkona-2026-11-16-f3b1` and
   F3.3's `arkona-2026-11-17-f3d`, which was named after the wrong session), and a pack stored from one of them is given
   the new seed's rules as a NEW version at start
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
   when a pinned section cannot be found on its page (`GOVERNANCE_SECTION_MISSING`, listing the page's headings and its
   outline; a heading renumbered, recased or written with "&" for "and" is still found, a shortened one is not); the
   owner re-maps the pin on the Packs page ([above](#re-mapping-a-pinned-heading)). Until a version is approved, the
   pack's tools compute nothing.

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
  Hierarchy and Standardised Navigation”)"), or says the change is outside the pinned sections; the Packs page shows
  each section's state, and a picker for a pinned heading the page no longer has. The document's version still decides:
  a change anywhere on a governance page stops the pack, as before.

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
| Owner page, Working or Archived   | `Working` or `Archived`, its type's primary tag, its specialist (if any) |
| Index made by the owner tool      | none                                                                     |

The status is `CANON` for an Authoritative page and `Working` for a Working one (which never carries `CANON`). An agent
never types a tag: an extra one is refused (`TAG_NOT_ALLOWED`).

**Working owners keep the specialist (the owner, 16 November 2026).** A Working or Archived owner's tags are the
lifecycle tag, then the primary, then the specialist if any (`Working, Culture, Language`; with no specialist,
`Working, Culture`), as the Tagging Standard preserves "actually meaningful existing subject tags… after the lifecycle
marker" and as F3a's Working characters keep their identity tokens. F3b held a Working owner's specialist and reported
it; it is no longer held. Archiving (`archive_page`) swaps only the status tag, so an Archived owner keeps its primary
and specialist. Since v3 F3d the lifecycle tag leads on Arkona there too (`Archived, Culture, Language`): see
[below](#the-lifecycle-tag-and-au-in-the-lifecycle-tools-v3-f3d).

**The AU ruling (the owner, 16 November 2026).** An AU page (Continuity Type AU) carries the status tag `AU` in place
of `CANON`, and Continuity Type AU stays in its facts; everything after the status tag follows the same grammar. A
Working or Archived AU page leads with `Working` or `Archived`, so neither `CANON` nor `AU` appears on it. It holds for
every pack tool (`arkona_create_character` changed with it) and is recorded in the pack's `rulings` with its date and in
`tags.au`. The Tagging Standard does not record it yet: when it does, the pack sees governance drift and the owner
approves it again. Since v3 F3d the lifecycle tools, the lifecycle audit and the guard apply it too
([below](#the-lifecycle-tag-and-au-in-the-lifecycle-tools-v3-f3d)).

## The lifecycle tag and AU in the lifecycle tools (v3 F3d)

[ADR 0053](adr/0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md). Two rules reach the bridge-wide
lifecycle tools (`archive_page`, `unarchive_page`, `move_to_working`, `promote_page`), the lifecycle audit and the
lifecycle guard from the pack attached to a project, from its **approved** version only (a version waiting for approval
does not apply; a project with no approved pack keeps ADR 0035's behaviour):

- **`lifecycleTagPosition`** (`lead` or `append`, per project name). Arkona's seed says `{ "arkona": "lead" }`, as the
  Controlled Native Tagging Standard v1.8 orders Working and Archived pages ("a leading, exact-case native tag … preserve
  actually meaningful existing subject tags in their original relative order after the lifecycle marker"); the test world
  is not named, so it keeps `append`. With `lead`:

  | Tool              | Before                     | After                                                       |
  | ----------------- | -------------------------- | ----------------------------------------------------------- |
  | `move_to_working` | `Culture, CANON, Language` | `Working, Culture, Language`                                |
  | `archive_page`    | `Magic, CANON`             | `Archived, Magic`                                           |
  | `archive_page`    | `Working, Character`       | `Archived, Character`                                       |
  | `promote_page`    | `Working, Culture`         | `CANON, Culture` (`AU, Culture` for an AU page)             |
  | `unarchive_page`  | `Archived, Magic`          | `CANON, Magic` (or `AU`, or `Working`, as its target needs) |

  Whole sets alike. With `append` (every other project), ADR 0035's order: the incoming tag last.

- **The AU ruling** (`tags.au`): `promote_page` and `unarchive_page` (back to Authoritative) give a page whose Continuity
  Type is AU the status tag `AU`, any other page `CANON`; `move_to_working` and `archive_page` remove either. The audit
  reports `AU` on a non-AU page or `CANON` on an AU page (`au_status_tag_mismatch`), and the guard treats `AU` as a
  status tag (only the lifecycle tools add or remove it). A pack without the ruling: `CANON`, as before.

On a `lead` project the audit reports a `[BWRK]` or `[BARC]` page whose lifecycle tag is not first, or which still
carries a status tag (`lifecycle_tag_not_leading`); its fix reorders the tags only ([audits.md](audits.md)). After the
new version is approved, every page the bridge archived or moved to Working before shows up there.

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

## Appraisal (v3 F3c)

The read-only half of the pack ([ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md)). Repository
Automation sets the boundary: "Automations are diagnostic and read-only by default. Report detected issues and the
appropriate interactive follow-up; do not silently perform the repair." So:

- **The four reports write nothing**, to LegendKeeper or as a proposal. They read the snapshot overlay (the nightly full
  snapshot plus the change snapshots since, kept in the bridge's database with a full-text index), the audits' findings,
  the asset tree and the bridge's own database: free, unless `live: true` asks for a fresh read of the pages concerned.
  Each says what it inspected, how fresh its data was and what it could not check; it never guesses.
- **Their rules are the pack's data**, the same the creation tools use: the identity fields and placeholders of the
  completion gate, the roles and templates (which fields a page's sidebar should hold), the first heading (`Purpose`),
  the sections a role warns about when missing (Source Boundaries, Unresolved Material), the sidebar's names
  (PROPERTIES, Dependencies, Related Sources), the overload domains and their threshold, the name rule for dashes. A
  change to the pack changes both. The report names the pack version it applied (`source.pack`); the appraisal does not
  need the pack to be current, as it never writes.
- **Each finding names its rule** (the governance page and section: Source Formatting's Body Structure, Sidebar
  Metadata, Page Names and Templates, Links, Dependencies and Tags, Indexes; the Tagging Standard; Character
  Architecture; Visual References; Repository Automation) and its evidence class, in Repository Automation's groups
  (A2: required defects, optional polish, architectural candidates, blocked cases; A3: proven breakage, review
  candidates; A4 and A5 their own).
- **The audits are reused, never duplicated**: A2 gathers the page's open audit findings (sibling order, tags, facts,
  references, lifecycle…) and adds only the checks they do not cover.
- **Acting on a finding** is a separate, explicit request (the owner's addition, design section F): a finding whose
  follow-up is a `fix` can be turned into **one ordinary proposal** by the Appraisal page's "Propose a fix", or by
  `arkona_appraisal_fix`, after a live re-read shows it still holds. Since v3 F3.4 the tool follows its switch in the
  pack's data: by default the agent's scope (at scope `write` the fix is made at once and reviewed afterwards on the
  Review page); switched to "always propose", one proposal whatever the scope. Sibling order and tags go to the audits' own fixes. A
  `judgement` names the tool and what has to be decided, and is the owner's.
- **Reports are not written to LegendKeeper.** The bridge keeps the latest run of each tool and scope in its own database
  for comparison, as the audits do ([dashboard.md](dashboard.md#appraisal-v3-f3c)).

The full-text index also serves the general `search` tool (`content: true`), for every project with snapshots, not
only Arkona's: the pack decides only the appraisal tools.

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

## Since the second review (CR-2026-11-R2)

- **A pinned heading must be unambiguous**: a governance page with the pinned heading twice is drift (`ambiguous`, named
  in the message), the owner's approval is refused (`GOVERNANCE_SECTION_AMBIGUOUS`) and a re-map to a heading the page
  has twice is refused (`HEADING_AMBIGUOUS`) (R2-33).
- **A package's checks run again after a hold**: a direct package job held after its checks (writes paused, read-only, a
  budget wait, a restart) checks the governance, what must be absent and its images again before its first write, and
  stops (`PACK_GOVERNANCE_CHANGED`) when the tool's switch now says "always propose" (R2-29).
- **The switch** that applies is the stricter of the approved version's and one waiting for approval: a switch to
  "always propose" applies at once; a loosening waits for the approval (R2-35).
- **The staged-image takeover**: a package takes over only its own agent's pending placement of an image (another
  agent's is `STAGED_IMAGE_BUSY`), and withdraws it only once the package is a proposal or its job has succeeded
  (R2-34, R2-40).
- **No lifecycle index name**: a package that would make a page named as a lifecycle index is refused (R2-11).
- **One-line fields** (a page's Scope, the owner tool's Reference Type, Scope and Temporal Scope) are kept on one line
  (R2-37); a continuity is compared through the facts fold, and an alternate universe's name with an invisible character
  is refused (`CONTINUITY_INVISIBLE_CHARACTER`, R2-36).
- **Appraisal** reads the approved version's rules only; with none approved, `arkona_appraisal_fix` proposes. The asset
  fix and the Related Sources fix check their target again inside their job (`FIX_STALE`): the Related Sources fix reads
  the linked page live (2 reads to plan, 1 in the job) (R2-30 to R2-32).

## When a package is refused

| Code                                   | What to do                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PACK_NOT_CURRENT`                     | The owner checks the governance pages and approves the pack again on the Packs page                         |
| `PACK_NOT_ATTACHED`                    | Use a project the pack is attached to (the message names them)                                              |
| `PACK_TEMPLATE_UNSET`, `…_UNKNOWN`     | The owner refreshes the project's templates (Repository Mappings) and approves the pack again               |
| `TEMPLATES_NOT_READ`                   | The owner refreshes the project's templates (Repository Mappings)                                           |
| `LIFECYCLE_NOT_CONFIGURED`             | The owner confirms the Working index (Projects page, Lifecycle), or the package uses `"authoritative"`      |
| `IDENTITY_INCOMPLETE`                  | The agent asks the owner for the missing values; never guesses                                              |
| `CHARACTER_EXISTS`                     | Call again with `target` (the existing character's name or id)                                              |
| `PACK_GOVERNANCE_CHANGED` (in the job) | A governance page changed after the proposal: approve the pack again, then ask for a new package            |
| `GOVERNANCE_SECTION_MISSING` (approve) | A pinned heading is not on its page: the owner re-maps it on the Packs page (a new version), or restores it |
| `HOME_NOT_ALLOWED`                     | Choose one of the allowed homes listed; `homeOverride` only on the owner's decision                         |
| `NATION_NEEDS_INDEX`                   | Call again with `promoteNation: true` (the nation's index made in the same proposal)                        |
| `OWNER_FACTS_INCOMPLETE`               | The agent asks the owner for Reference Type, Scope or Temporal Scope; never guesses                         |
| `CHARACTER_NOT_FOUND`                  | Make the character first with `arkona_create_character`                                                     |
| `RELATIONSHIP_EXISTS`                  | Edit the relationship page the message names with `write_page`                                              |
| `STAGED_IMAGE_BUSY`                    | The image is in another package: stage the art again with `upload_image { stage: true }`, no destination    |
