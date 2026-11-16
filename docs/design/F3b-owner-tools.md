# F3b design: `arkona_create_owner`, relationships, art intake and the character brief (for the owner's approval)

**Status:** APPROVED by the owner, 16 Nov 2026, with the rulings below written in. ★ calls confirmed. Species and creature placement and the AU rule are as the owner set them (sections 1.1a and 1.5).

**Status (original):** draft for the owner's approval, 16 Nov 2026. It was built from Arkona read live today: Source Formatting (Page Names and Templates; Nation-Centred Territorial Navigation; Approved Hierarchy; Active Template Suite), the Controlled Native Tagging Standard v1.8 (Exact Tag Grammar; Closed Primary Categories), the sidebars of the five non-character templates, and the real structure of Salahad.

F3b adds four tools to the Arkona pack, all built on F3a's engine (packs as data, versioned governance, one proposal per package, a re-check when the job runs). It also fixes one F3a issue found in evaluation (section 6).

---

## 1. `arkona_create_owner`: one tool for every non-character owner

**Why one tool:** Arkona's non-character owners all share one sidebar. The five templates (Polity and Institution, Place and Divine Realm, Magic and Technology, Creature and Species, General Source) carry the same ten rows in the same rank order:

> Status · Continuity Type · Continuity · Inheritance · Subject · Reference Type · Scope · Temporal Scope · Last Major Revision · Supersedes (preset "None")

plus Dependencies, Related Sources and TAGS. What differs is the **template**, the **primary tag**, the **allowed specialist tag** and **where the page may live**. That's pack data, so it's one tool with a `type`.

### 1.1 Types (decision D1)

The primary and specialist tags come from the Tagging Standard's closed vocabulary. The template follows Source Formatting's "choose by function". **★ marks a judgement call for you to confirm.**

| `type` | Template | Tags (after CANON) | Allowed homes (index names as found) |
|---|---|---|---|
| Polity | AI Polity and Institution | Polity [+ Government] | `<Continent> Polities` (a compact polity); a nation index |
| Institution | AI Polity and Institution | Institution [+ Government \| Religion] | `<Continent> Institutions`; a nation index; `<Nation> Institutions`; `<Nation> Government & Administration` |
| Military ★ | AI Polity and Institution | Military | a nation index; `<Nation> Institutions` |
| Culture | AI General Source | Culture [+ Language \| Naming] | `<Continent> Cultures`; `<Nation> Cultures`; `Arkonan Cultures`; `Divine Realm Cultures` |
| Event | AI General Source | Event [+ Conflict] | `<Continent> Historical Events`; `<Continent> Conflicts`; `Arkonan Historical Events`; `Arkonan Conflicts`; a national history index |
| Place | AI Place and Divine Realm | Place [+ Continent \| Region \| Settlement \| Divine Realm] | `<Continent> Regions`; `<Continent> Settlements & Locations`; `<Nation> Settlements & Locations`; a Divine Realm index |
| Technology / Magic | AI Magic and Technology | Technology, or Magic | `<Continent> Unique Magic & Technologies`; `<Nation> Unique Magic & Technologies`; a nation index |
| Material ★ / Equipment ★ | AI Magic and Technology | Material, or Equipment [+ Sacred Blade] | as Technology |
| Species (a race) | AI Creature and Species | Species [+ Racial Group] | **Races of Arkona** (`rraces01`) or one of its Racial Group References: see 1.1a |
| Species (not a race) / Creature | AI Creature and Species | Species, or Creature | `[INDEX] Bestiary` (`bb9fa6cf7acf8f62565d0d31`, Setting Framework / Creatures & Conditions) |
| Religion, Law, Programme, Education, Ceremony, Condition | AI General Source | that one primary | the matching continental, national or `Arkonan Religions` index, or a nation index |
| Relationship (inter-polity) | AI General Source (the approved exception for crown relationships) | Relationship | `<Continent> Institutions` |

### 1.1a Races: the one allowed non-index home (owner ruling)

**Races of Arkona** (`rraces01`, [BSRC], Reference Type "Racial Foundation") is a substantive page, not an index. It is **the wiki's only exception**: it is meant to hold the actual race owners as its children. Arkona's real shape is:

- `Races of Arkona` contains:
  - `<Group> - Racial Group Reference` (Reference Type "Racial Group Reference"; tags CANON, Species, Racial Group): Beastkin, Elves, Greenskins, Outsiders and Wyrmkin. Each holds `<Race> - Core Information` pages (Reference Type "Race Core Reference"; tags CANON, Species).
  - races that belong to no group, directly: Dwarves, Humans and Sarkaz, each as `<Race> - Core Information`.
- A subrace sits under its race, for example `High Humans - Subrace Reference` under Humans.

So:
- **`kind: "race"`:** the home is the race's racial group's Reference, or `Races of Arkona` itself when it has no group. The name is `<Race> - Core Information`, the Reference Type "Race Core Reference", and the tags CANON, Species.
- **`kind: "racialGroup"`:** the home is `Races of Arkona`. The name is `<Group> - Racial Group Reference`, and the tags CANON, Species, Racial Group.
- **`kind: "subrace"`:** the home is its race's Core Information page. The name is `<Subrace> - Subrace Reference`, and the tags CANON, Species.
- **Anything else of type Species** (not part of the racial roster), and **every Creature**, goes under `[INDEX] Bestiary`.
- These parent pages are allowed as homes **only** for these kinds. No other substantive page is ever accepted as a home without `homeOverride`.
- **A new race or racial group** also needs character navigation (`Characters / <Group> / <Race>`) before F3a's character tool can place anyone in it. The tool **warns** about this. It creates that index only when the package names it explicitly (`createCharacterNavigation: true`), as a separate step in the proposal.

Cosmology, Divinity, Chronology and Setting Framework are left out on purpose: they're framework-level and rare. Use the generic tools for those.

### 1.2 Where it goes (decision D2)

- **`home` is required:** an index by name, id or path. The tool checks it against the type's allowed homes, recognising them by the index's own name ("… Polities", "… Cultures", a nation index under a Polities index, and so on).
- A home that doesn't match is refused with `HOME_NOT_ALLOWED`, listing up to five suitable indexes nearby. `homeOverride: { reason }` lets it through. The reason is printed in the proposal, so you see it when you approve.
- The tool **never invents a home** and never creates a category index. Continents and Realmships already have every approved category, and "do not create a complete set of empty national categories".

### 1.3 Nations: the three scalable levels (decision D3)

Source Formatting: a compact polity sits directly in its continent's Polities index. A nation with several developed owners gets an `[INDEX] <Nation>`, with its Reference inside it.

- If the new owner names `nation: "<Nation>"` and that nation exists only as a direct Reference in a Polities index, the tool refuses with `NATION_NEEDS_INDEX`. Its message describes the change.
- With `promoteNation: true`, the **same proposal** also:
  1. creates `[INDEX] <Nation>` from AI Index, with drafted routing text;
  2. moves the existing Reference into it, keeping its ids, Dependencies and tags;
  3. places the new owner beside it;
  4. re-checks sibling order.

  Moving an Authoritative page is a canonical proposal, as always.
- National thematic subindexes, such as `<Nation> Institutions`, are **never** created automatically. A single-owner subindex needs your explicit approval, so `createSubindex: "<Nation> Institutions"` is a separate, named step in the proposal.

### 1.4 Name, facts, body and links

- **Name:** `<Subject> - <descriptor>`, with the prefix `[BSRC]` or `[BWRK]` by lifecycle, as in F3a. Em dashes, and en dashes used as separators, become ASCII hyphens. A sibling with the same name is refused.
- **Facts:**
  - **Required:** Subject, Reference Type (free text, as Arkona already uses: "Historical Polity Reference", "Regional Cultural Reference"…), Scope and Temporal Scope.
  - **Filled by the tool:** Status, Continuity Type, Continuity and Inheritance come from `status` and `continuity`, as in F3a.
  - **Unestablished** is allowed with `{ value: "Unestablished", reason }`, as in F3a. Last Major Revision is set by the job and Supersedes defaults to "None".
- **Body:** Purpose first, then the agent's sections, then Source Boundaries and Unresolved Material, as in F3a's text rules, with no invented sections. Template placeholder headings that the agent doesn't fill are removed, not left empty: "missing mechanisms, governments… must not be invented to fill empty placeholders".
- **Dependencies:** current Authoritative owners only. A Working dependency is refused, per Source Formatting. Related Sources is optional.
- **Tags:** CANON, the primary tag, and optionally the specialist tag. A Working page gets `Working` + the primary tag, per Tagging Standard v1.8. Nothing else is ever added.

### 1.5 AU (owner ruling, 16 Nov 2026)

**An AU page carries the status tag `AU` in place of `CANON`**, and Continuity Type AU stays in its facts. Everything after the status tag follows the same grammar (primary, specialist, identity tokens).

- This applies to **every** pack tool, F3a's `arkona_create_character` included. F3b changes F3a's AU handling to match.
- **Necessary deduction:** a Working or Archived AU page leads with `Working` or `Archived`, as every non-current page does. Those lifecycle tags replace the status tag, so neither CANON nor AU appears on them.
- The Tagging Standard page doesn't record this ruling yet. The pack stores it as an owner ruling, with this date. If the ruling is later written into the Standard, the pack will see governance drift and need re-approving, which is expected.

---

## 2. `arkona_create_relationship`: a standalone joint relationship

This reuses F3a's relationship builder for two **existing** characters:
- the AI Relationship template, and the name `<A> & <B> - Relationship`, with both names exactly as their indexes give them;
- hosting by F3a's rule;
- tags `CANON, Character, Relationship`;
- both participants' **Related Sources** gain the new page, in the same proposal.

A Working relationship whose partner is canon follows F3a's rule: the partner's link waits until promotion, with a warning.

It's refused if either character doesn't exist (`CHARACTER_NOT_FOUND`, suggesting `arkona_create_character`) or the pair already has a relationship owner (`RELATIONSHIP_EXISTS`, naming it).

## 3. `arkona_add_character_art`: art for an existing character

This is F3a's art step on its own:
- **Images** come from `staged_id`, `file` (ChatGPT) or `upload_id`.
- **Folder:** `Characters / <race path> / <Name> / Forms | Outfits | Details / …`, found or created at run time.
- **Names:** semantic and extension-free, checked for collisions.
- **The Art page** is created if missing (AI Character Art) or **extended** under its "Reference Images" section, as F3a stores it. Each image gets its label and interpretation text, and an image without interpretation is refused.
- **Retention approval** is the proposal itself: nothing reaches LegendKeeper until you approve it.

## 4. `arkona_character_brief`: read-only, and free

This is Character Architecture's "remind the user who is under discussion" step:
- the six gated identity fields;
- every owner page, with its Reference Type and Scope;
- relationships, art pages and image counts;
- open audit findings, and any Unresolved Material headings.

It reads the snapshots and the tree, so it costs no API reads, and it says how fresh they are. `live: true` re-reads the Core's sidebar (one read).

## 5. Shared by all four

- Every package is a proposal whatever the agent's scope, as in F3a.
- **Governance drift fails closed**, as in F3a. The governance pages this pack version depends on now include Source Formatting's territorial and hierarchy sections and the Tagging Standard's categories.
- **A re-check when the job runs:** a sibling with the same name, a relationship that already exists, a nation index someone else has just created. Any of these makes the job fail cleanly before it writes anything.
- **Costs** are measured and stated in the tool descriptions, as F3a did.

## 6. The F3a fix found in evaluation (scenario 32)

At propose scope, `upload_image` stages the image **and** proposes its placement. When the agent then calls `arkona_create_character` with that `staged_id`, it's refused with `STAGED_IMAGE_BUSY`, because the image has a pending placement proposal. The owner had to approve the placement first.

The fix:
- **Packages take over a staged image's own pending placement.** If the image's only pending activity is a placement proposal, the package withdraws it, recording "superseded by package prop_…", and places the image itself.
- Any other pending activity still refuses.
- Pack tools and the guide tell agents to stage art with `upload_image { stage: true }` and **no destination**, which proposes nothing.

---

## Decisions for the owner

- **D1:** the type table, and especially the ★ rows: Military in Polity and Institution; Material and Equipment in Magic and Technology; Species and Creature with an explicit home only.
- **D2:** `home` is required and validated, with `homeOverride` plus a reason.
- **D3:** `promoteNation` restructures a nation in the same proposal. National subindexes are created only when explicitly named.
- **D4:** AU is refused until you set a rule, or you give the rule now.
- **D5:** relationship and art standalone tools as described.
- **D6:** the staged-image takeover in section 6.
