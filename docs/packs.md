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

Arkona's seed pins eleven sections (six until v3 F3f added Excluded Routine Tags, v3 F5a Approved Supplementary Tags and v3 F5b Repository Automation's three), by the headings exactly as the pages have them (read on 16 November 2026; ADR 0052,
amendment):

| Page                                                     | Pinned heading                                     |
| -------------------------------------------------------- | -------------------------------------------------- |
| Source Formatting (`cn8v87hh/l41y28c8`)                  | Page Names and Templates                           |
| Source Formatting                                        | Nation-Centred Territorial Navigation              |
| Source Formatting                                        | Approved Hierarchy and Standardised Navigation     |
| Source Formatting                                        | Active Template Suite and Sidebar Collections      |
| Controlled Native Tagging Standard (`cn8v87hh/bfrv43jr`) | Exact Tag Grammar                                  |
| Controlled Native Tagging Standard                       | Closed Primary Categories and Specialist Functions |
| Controlled Native Tagging Standard                       | Excluded Routine Tags (v3 F3f)                     |
| Controlled Native Tagging Standard                       | Approved Supplementary Tags (v3 F5a)               |
| Repository Automation (`cn8v87hh/xd9gzkel`, v3 F5b)      | Default Boundary                                   |
| Repository Automation                                    | Approved Narrow Automations                        |
| Repository Automation                                    | Source Boundaries                                  |

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
   offered, never imposed** (v3 F3b): a seed names the seeds it supersedes (`arkona-2026-11-18-f3e`, v3 F3e, the split
   rules, supersedes every earlier one: F3a's `arkona-2026-11-16`, F3b's `arkona-2026-11-16-f3b`, F3b.1's
   `arkona-2026-11-16-f3b1`, F3.3's `arkona-2026-11-17-f3d`, which was named after the wrong session, and F3.4's
   `arkona-2026-11-17-f3-4`, the tool switches), and a pack stored from one of them is given
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
- since v3 F5b ([ADR 0068](adr/0068-v3-f5b-automatic-actions-for-audits.md) decision 3) the bridge's OWN write of a
  bridge-managed paragraph of Repository Automation (the owner switching an automation on or off) carries the approval
  over it: once the page reads exactly as the write planned and the approval recorded the version written over, each
  source kept on that page takes the new version and its pinned sections' digests (audited `pack.carry_approval`).
  Anything else changed on the page meanwhile carries nothing: it is drift, as above.

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

## Renames, items and resuming a package (v3 F3d (renames))

[ADR 0058](adr/0058-v3-f3d-renames-selective-approval-resume.md); the owner-approved design:
[design/F3d-renames.md](design/F3d-renames.md). The tool: [tools.md](tools.md#arkona_rename).

**`arkona_rename`** renames a character or an owner everywhere it is named, as one canonical proposal made of **items**:
its page names (ids kept), identity facts, the old name kept as an alias (the Aliases fact and the pages' search aliases),
index routing lines, chronology rows (with their events, by the chronology tools' own path), the art
folder and asset names, a race's taxonomy entry, a culture's or race's identity token (with every character's fact and
tag) and each textual restatement elsewhere. What it reads: the pack's approved rules (the keys of the name parts, the
Aliases fact, Naming Culture and Race / Species; the routing and Unresolved Material headings; the token maps), the
full-text index (A1) to find every mention, and each page or document it plans to edit, live.

**The token change is the pack's (D3).** A culture or race whose token map entry changes comes with a NEW pack version in
the same package: when the owner approves the rename with its token item, the bridge makes the version (the pack's
`renameToken` command: the entry for the old value renamed to the new value, with its new token; audited
`pack.rename_token`), and the rename's job **waits** until the owner approves that version on the Packs page (its check
confirms, inside the lock, that the approved version maps the new value to the new token). Until then the pack is "waiting
for approval", so every package tool refuses, as for any new version. Left out, the token item makes no version, and the
characters' tags (which need it) are left out with it.

**Name parts are never inferred (D4).** The planner compares the character's Given and Family facts with the old and new
names: a part that is in the old name and not in the new one must be given (`given`, `family`), or the plan is refused
(`NAME_PARTS_REQUIRED`).

**Items, for every package.** Since F3d each F3a and F3b package is made of items too: the new character's set (its index
with its identity page), each other new page, and the changes to each existing page. Everything ticked runs exactly as
before; the owner can leave a page out (the pages that need it go with it), and propose what was left out again later
(the package's own check still knows the pages the first part made: `ownIds`).

**The amendment of 18 November 2026** (ADR 0058, after the owner's live test):

- **A conflict part-way is rebased, not a stop.** A rename's job holds no lock for its whole run (each write takes its own
  page's lock only for itself, so ordinary agent writes to those pages never wait for all of it) and re-checks inside that
  lock. When another writer got there first, the same change is re-applied to the fresh content (at most 3 attempts); an
  item whose exact text changed meanwhile, or now appears twice, is skipped and listed with a before and after excerpt, and
  the job carries on. Only the subject's own page names and identity facts stop it (resumable). Skipped items are proposed
  again with the left-out ones (**Propose these again**).
- **Name parts are for review, never edited.** The plan and the report list the old given name, family name and aliases
  on their own, each with its page, section and sentence, flagging a page of another character sharing the part (at most
  200, with a count of the rest). There is nothing to approve: the agent brings them to the owner.
- **Agents are steered to `arkona_rename`.** On a pack project, `update_resource` (and `updateResource` through
  `lk_api_*`) refuses a subject's rename with `USE_ARKONA_RENAME` and a hint; `plainRename: { reason }` lets a plain rename
  through with its reason shown; a descriptor-only rename (after " - ") is never refused.
- **Custom mention labels are not written.** LegendKeeper's API cannot change a mention's custom label (and Arkona's
  repository does not use them): a custom label holding the old name is listed for review ("change it in the app if
  wanted"), never planned as a write, and never fails a rename.

**Resuming.** A package or a rename whose job stops part-way records where; the owner resumes it (Jobs and Review pages), an
agent its own direct job (`bridge_job_resume`). The package's check runs again first: a page this package already made is
its own (`ownIds`), and an image this job already placed is not "busy". Nothing is made twice.

## Splits (v3 F3e)

[ADR 0059](adr/0059-v3-f3e-splits.md); the owner-approved design: [design/F3e-splits.md](design/F3e-splits.md). The
tools: [tools.md](tools.md#setting-packs-splits-v3-f3e).

**The split rules are pack data** (`rules.splits`, new in `arkona-2026-11-18-f3e`; the owner approves the version on the
Packs page before either split tool works, and tunes any of it with a new version). D4's thresholds and what the
appraisal and the split need to know:

| Key                                         | Arkona's value                                                                                                                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopeOverload.minDomains`                  | 3 (the Scope, or else the top-level sections, name that many domains)                                                                                                                                                                                                 |
| `retrievalCost.minWords`, `.minDomains`     | 2,000 words AND 2 section domains (length alone never counts)                                                                                                                                                                                                         |
| `assetOwnership.minImages`, `.sectionWords` | 3 images on a non-Art page; a wardrobe, outfit or form section with any image                                                                                                                                                                                         |
| `sharedOwnership.minWords`                  | 120 words about one other named character, with no relationship owner for the pair                                                                                                                                                                                    |
| `unresolved.minItems`                       | 2 Unresolved Material items under one domain                                                                                                                                                                                                                          |
| `domains`, `ownerDomains`                   | the words that put a section in a domain: a character's (Biography, Appearance, Personality, Relationships, Powers, Wardrobe, Career) and any other owner's (History, Geography, Government, Military, Economy, Culture, Religion, Law, Magic, Technology, Education) |
| `stays`                                     | the sections a page keeps (Purpose, Identity, Overview, Summary, Source Boundaries, Unresolved Material, How to Use This Index)                                                                                                                                       |
| `together`                                  | the Anti-Fragmentation examples (personality and habits; body, face and forms; a shared romantic hierarchy)                                                                                                                                                           |
| `destinations`                              | the draft destination per domain (Biography → a "Biography" page, Character Biography; Appearance → "Physical & Visual Reference"; Relationships → a relationship owner; …)                                                                                           |
| `visual`                                    | what counts as an Art or visual owner (the `art` role; Character Art and Character Physical & Visual Reference; the Character Art and Visual Reference tags)                                                                                                          |
| `universalTypes`                            | the owner types whose material is universal (Species, Creature, Culture, Magic, Technology, Material, Equipment, Religion, Law, Condition, Ceremony…)                                                                                                                 |
| `questions`                                 | the owner's questions for the triggers the bridge cannot measure                                                                                                                                                                                                      |
| `guardWords`                                | 120: `write_page` refuses taking that many words off a pack page (`USE_ARKONA_SPLIT`)                                                                                                                                                                                 |
| `sections`                                  | CR-2026-11-R4: which new owners answer for Source Boundaries and Unresolved Material, by Reference Type, else role, else owner type, else `otherwise` (Arkona: a Core, a Compact Reference, a relationship owner and any other owner; not an Art or specialist page)  |

**What the pack's rules do in a split.** A new owner is made by F3a's rules (a character's page: its role, title,
Reference Type, its place in the character's index; a Compact Reference with no index gets one, and moves into it) or
F3b's (any other owner: type, Subject, home, Temporal Scope), with the pack's names, templates, computed tags, AU and
lifecycle, as every package is; a new owner of a canon page is canon in the same canonical proposal. The appraisal uses
the domains, `stays`, `together`, `destinations`, `visual` and `questions`; the split's visual audit uses `visual`, its
universal audit `universalTypes`. Character Architecture's extra audits (relationship, visual, index) apply when the
source is a character's page; Lifecycle's split rules (coverage, summaries, Dependencies, retirement) apply to any owner.

**Items and phases.** Each destination is an item, with its own source edit: left out, its sections stay in the source.
Phase 1 is one job (made, moved verbatim with the blocks' ids, checked before anything leaves the source, edited,
remapped, dated, verified); phase 2, for a source to be retired, is a separate canonical `archive_page` proposal the
bridge makes once phase 1 has verified and nothing was left out. The split never deletes. A stopped phase 1 is resumed
or reverted by the owner; a reverted one proposes deleting the pages it made.

## Retagging (v3 F3f)

[ADR 0060](adr/0060-v3-f3f-retag-audit-and-apply.md). The tools: [tools.md](tools.md#setting-packs-retagging-v3-f3f).
The Controlled Native Tagging Standard asks the Bridge for "dry-run preview, read-only policy audit, separately approved
guarded apply, and resumable reconciliation", using a versioned machine-readable translation "explicitly identified as
derived and never a competing source". The translation is this pack's data, approved by the owner like every rule.

**The retag rules** (`rules.retag`, new in `arkona-2026-11-19-f3f`, which also pins the Tagging Standard's "Excluded
Routine Tags" and switches `arkona_retag_apply` to "always propose"):

| Key                      | Arkona's value                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batchSize`              | 25 (pages in one apply proposal)                                                                                                                        |
| `identityReferenceTypes` | Character Core, Compact Character Reference (the pages that carry the identity tokens; with the roles whose grammar names `$race` or `$culture`)        |
| `excludedRoutineTags`    | none yet: the owner lists them from the Standard's pinned section (the Packs page's token-map editor); until then every tag outside the grammar is kept |
| `excludedAreas`          | Legacy Canon Archive, Design References, Repository Governance (index names; the governance sources' own pages are always excluded)                     |

**The engine** (src/packs/retag/engine.ts) gives each page's verdict from the approved version's rules through F3a's
tag engine (`computeTags`): the scope (current Authoritative Main CANON owners, and AU owners under the 16 November
ruling; Working and Archived pages for the lifecycle grammar only); the primary category from deterministic evidence only
(the owner's classification, the page's own pack record, or exactly one valid primary tag its Reference Type does not
contradict: otherwise a hold); the specialist from the closed list backed the same way; the identity tokens typed (race
through the race map, culture through the culture map, kept once when the same: the Otheiralth example); no other tag
ever proposed; status and lifecycle tags never added or removed. Its disposition: compliant, deterministic correction,
hold or exception. The policy it states: the approved version, its governance versions and a digest of both.

**Pack records.** Since v3 F3f a package records each page it makes with its category (`pack_page_records`: the tool,
type, role, primary and specialist), the retag's first evidence after the owner's own classification. Pages made before
v3 F3f have none; their current tags are their evidence.

**Owner classification.** An "uncertain category" hold is the owner's: on the Tagging page they choose the category (and
the specialist) from the closed list, with a reason; re-authenticated, audited (`retag.classify`), stored, and used by
every later audit. Agents suggest (`arkona_retag_audit { suggest }`), never classify.

**Apply.** Deterministic corrections of a stored run, at most 25, as ONE proposal (each page an item). The job compares
the policy first (changed: it stops), then per page reads it fresh (a page whose tags changed is conflicted and skipped,
never rebased; one whose facts changed is held), writes inside its lock and reads back the exact array and everything
else unchanged. Each page's disposition is recorded (applied, already compliant, held, conflicted, inaccessible). Last
Major Revision is never set. Resume and Revert work.

**Reconciliation.** A named record across batches: what was audited, proposed, applied, held and conflicted, and what
remains. Resume audits what remains afresh and proposes the next batch. A page whose facts, Reference Type or template
changed in the snapshots since its verdict is marked stale and audited again: a completed run is never current truth.

**Routing lines** (part D): the pack's routing-line writers (F3a's drafted index text and appended lines, F3b's
repointed line, F3e's index lines) emit plain mentions, which always show the page's current name.

## Approved Supplementary Tags and the owner's rulings (v3 F5a)

[ADR 0067](adr/0067-v3-f5a-supplementary-tags-rulings-bulk-actions-and-unknown-outcomes.md); the seed
`arkona-2026-11-23-f5a`. The Tagging Standard's section "Approved Supplementary Tags" (the author's ruling of 23
November 2026) is pinned, and its list is pack data, `retag.supplementary` (Cosmology, Chronology, Setting Framework in
the seed). At each governance check the section's sentence ("… permitted supplementary tags …: A, B and C.") is parsed;
a different list is offered as a NEW version for the owner's approval (audited `pack.derive_supplementary`), and a
sentence that cannot be read exactly refuses the approval (`GOVERNANCE_SECTION_UNPARSABLE`). The Excluded Routine Tags
are the opposite list and are never merged with it. A governance source changed since the approval is drift even while a
newer version waits (the approved version computes nothing until the owner approves again).

On the Tagging page's Exceptions tab the owner rules on an exception: **Keep this tag here** (one page, while its tags are
unchanged) or **Allow this tag everywhere** (the bridge edits the section's list as the owner's action, a dry run first,
the step-up, one revertible job; the pack then offers its new version). Agents suggest either ruling with
`arkona_retag_audit { suggestRuling }`, never take it.

## Automation's caps and Repository Automation (v3 F5b)

`arkona-2026-11-23-f5b` ([ADR 0068](adr/0068-v3-f5b-automatic-actions-for-audits.md)): `automation = { perCode: 25,
perRun: 100, source: 'repository-automation', section: 'Approved Narrow Automations', sweepMarker: 'Assign Block IDs
Sweep' }`, the caps of the automation framework, and where it records each code the owner switches on (after the
block-id sweep's paragraph). Which codes run is never pack data: it is the owner's setting per project on the Automation
page ([dashboard.md](dashboard.md#automation-v3-f5b)). Repository Automation is a governance source with its Default
Boundary, Approved Narrow Automations and Source Boundaries pinned; while any source drifts, no automation runs.

## Governance drift, names and briefs (v3 F4a)

[ADR 0063](adr/0063-v3-f4a-governance-drift-names-and-briefs.md). The tools: [tools.md](tools.md#setting-packs-briefs-and-names-v3-f4a);
the audit: [audits.md](audits.md#governance-drift-category-governance-v3-f4a). Two sections are new in
`arkona-2026-11-19-f4a`, which the owner approves on the Packs page before they apply (both are read from the approved
version):

| Key                                 | Arkona's value                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `governanceAudit.legacyNames`       | `write_lk`, `read_lk`, `job_action`: the old bridge's call shapes, flagged wherever they appear                                                                                                                                                                                                                                                                        |
| `governanceAudit.equivalents`       | the equivalence map: `write_lk` with `job_action: guide` → `get_bridge_guide`; `format-baisheng-owners` → `arkona_appraise_owner`; `audit-baisheng-change-impact` → `arkona_change_impact`; `audit-baisheng-chronology` → the chronology audit; `intake-baisheng-visuals` → `arkona_visual_hygiene`; `resume-baisheng-workstreams` → `arkona_working_digest` (partial) |
| `governanceAudit.referenceSections` | Startup, Related Guidance, Source Boundaries, Dependencies: the headings whose sections are checked for missing references                                                                                                                                                                                                                                             |
| `governanceAudit.resolution`        | leading `Arkona -` (any dash), generic Reference, Standard, Workflow, Index: a page's subject also resolves with these removed ("Fiction Writing" is "Arkona – Fiction Writing Reference"), and a name in the text is also tried without its generic word (the owner's review; absent: the four generic words only)                                                    |
| `naming.culturesIndex`              | Arkonan Cultures: where a Naming Culture's owner is looked for (by the culture map's token, or the value, as a page's subject, name or alias)                                                                                                                                                                                                                          |
| `naming.sections`                   | none: a culture owner's sections whose heading matches "name" or "naming" are returned; more can be listed                                                                                                                                                                                                                                                             |
| `naming.presentationStandard`       | East Asian Personal Name Presentation Standard: the governance tab every name check points to (not pinned; names are matched in both orders)                                                                                                                                                                                                                           |

An equivalence entry is `{ name, when?, use, note?, partial? }`: `when` names the arguments a call must carry (the most
specific entry that matches wins), `use` is the suggested replacement, and `partial` says the equivalent covers only part
of what the name did. The owner changes the map with a new pack version; a name that is a real external skill is better
allowed on the Audits page than mapped.

**Never an inference.** The name check reports namesakes and a culture's own sections and members; it never suggests or
infers a naming culture, race or nationality from a name, and never proposes a rename. The brief labels every item by
lifecycle and never merges across lifecycles.

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
