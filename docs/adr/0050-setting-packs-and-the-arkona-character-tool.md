# ADR 0050: Setting packs and the Arkona character tool

- Status: **Proposed** (v3 F3a, 16 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper with Arkona-shaped fixtures built from the shapes quoted in the design. The owner's decisions are quoted;
  the choices this session made where the brief left room are marked **chosen**.
- Carries out: PLAN-v2 section 10 (setting packs) and the owner-approved design,
  [design/F3-character-pack.md](../design/F3-character-pack.md) (approved 16 November 2026, all ten questions with their
  recommended answers and two changes, quoted below).
- Builds on: [ADR 0026](0026-type-registry-and-name-resolution.md) (the registry, taxonomy and ordering),
  [ADR 0032](0032-set-facts-and-canon.md) (facts and canon), [ADR 0034](0034-resources-documents-characters.md)
  (creates, minted ids, the verify step), [ADR 0035](0035-page-lifecycle.md) and
  [ADR 0037](0037-whole-set-lifecycle-and-page-scoped-ids.md) (Working first, whole sets),
  [ADR 0041](0041-image-pipeline.md) and [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md)
  (server-side staging, folders found at run time, Last Major Revision).
- Migration: `3000` (`packs`, `pack_projects`, `pack_versions`, `pack_reservations`). No decision in PLAN.md or
  PLAN-v2.md changes; decision 1 records why the pack's rules are not stored in the A3 registry's `recipe` slot, which
  PLAN-v2 10.2 asked A3 to leave room for (it stays empty).
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script. Every test runs against the mock LegendKeeper and fixtures.

## Decision 1: a pack is its own versioned document (**chosen**)

A pack's rules are one JSON document (`src/packs/types.ts`), stored in the `packs` table with every version kept in
`pack_versions`, rather than recipes in each project's A3 registry types:

- a pack belongs to one **setting** and is attached to **several projects** (Arkona and the test world), while the
  registry is per project. One document, one version, one approval covers every project;
- the owner approves a **version** against the governance pages it was derived from (decision 3), which needs the rules
  and their sources versioned together;
- template ids differ between projects, so the rules name template **roles**, and each attachment maps roles to ids
  (`pack_projects.templates`).

The registry stays what the engine asks for placement (the Character taxonomy, by Race / Species, with its fallback
index), names (resolution, aliases) and ordering. The registry's `recipe` column stays empty; it is not removed.

A pack is **data**: its types, roles (template role, name pattern, Reference Type, tag slots, which facts, whether text
is required, the sections warned about, the most per package), identity fields (gated or not), the deliberate gap
(`Unestablished`), placeholders, fixed facts, specialist tags, suggested Reference Types, the asset rules, the index
rules and the text rules. The code holds the engine and small hooks (decision 5).

## Decision 2: seeded once, attached by project, template ids worked out per project

- The bridge knows one seed (`src/packs/arkona.ts`, data). At start it stores a pack that is not stored yet (`pack.seed`)
  and attaches it to the projects its seed names when the bridge serves them (`pack.attach`). A seed never overwrites a
  stored pack: after seeding, the pack is the owner's.
- The home project's template ids are the design's (`bffw83fb` Core, `exl4dzki` Compact, `g7gdpoe6` Art, `krkreawl`
  Relationship, `ie08m47o` General Source, `zaomdr49` index). Another project's are worked out from the home project's
  template **names**, matched exactly against that project's templates as last read on Repository Mappings; a role that
  cannot be worked out stays unset with a note (shown on the Packs page) and a package that needs it is refused
  (`PACK_TEMPLATE_UNSET`). Every plan checks the ids against the project's templates as last read
  (`PACK_TEMPLATE_UNKNOWN`, `TEMPLATES_NOT_READ`). An approval works unset ids out again. Names are never in code.
- A pack's tools are listed only while it is attached to a project the bridge serves (a `listed` predicate on the tool,
  read at each `tools/list`), and refuse any other project (`PACK_NOT_ATTACHED`).

## Decision 3: derived, never competing; drift fails closed

The Controlled Native Tagging Standard requires a machine-readable translation to be "explicitly identified as derived"
and to "compare policy version/digest before writing". The pack records its **governance sources** (for Arkona:
Character Architecture `p5rcvxze`, Source Formatting `l41y28c8` and the Controlled Native Tagging Standard v1.8
`bfrv43jr`, documents of the AI REPOSITORY page `cn8v87hh` in the `arkona` project).

- The owner's **approval** (Packs page, re-authenticated, audited `pack.approve`) records the rules' version and each
  source's document version read at that moment (the audit row also keeps each document's SHA-256 digest). A source that
  cannot be read cannot be approved.
- Every **preview** reads each source's version (one read each) and compares; every **job** reads them again in the lock
  before its first write (`PACK_GOVERNANCE_CHANGED`, a refusal in the lock, nothing written).
- The pack is **current** only when the current version is approved and every source is as approved. Otherwise
  (`unapproved`, `rules_changed`, `changed`, `unreadable`) **no tags are computed** and every package is refused
  (`PACK_NOT_CURRENT`, with the preview so far and what changed). A first sight of a changed source is audited
  (`pack.drift`) and shown as an alert on the Packs page.

## Decision 4: one package, one preview, one proposal, one job, verified

- `dryRun` (or `preview`) returns the whole plan and writes nothing: the tree (each page's parent and neighbours), each
  page's template, facts, tags, links, text shape and drafted index text, the changes to existing pages, the assets and
  the folders they create, every dash replaced, the held tag slots, refusals, warnings, notes, and the job's steps and
  writes. A refusal returns the same preview so far with every refusal listed.
- Otherwise the package is **one proposal** for the owner whatever the agent's scope while the pack's `alwaysPropose`
  is on (**chosen**: on in the Arkona seed for its first weeks; the job engine's `forceProposal`). It is a canonical
  proposal ("Approve and accept as canon") when it makes canon. Every new page's id is minted at plan time, so the
  proposal fixes the structure; the proposal stores the high-level operation (the package and its preview) beside its
  expansion, with a page-level summary and each image placement.
- On approval it runs as **one job**: the governance check and the in-job existence check (decision 11), then per page
  the copy from its template, its text (filling the copy while keeping the template's collection block), its tags, its
  rows in template order, its Last Major Revision; the changes to existing pages; the images; then the **verify**: each
  page's place, the six identity fields one by one, the tags in order, every template row (none missing, none added),
  each link, the text, and each image's bytes (SHA-256) and block. A difference is recorded on the job and the proposal.

## Decision 5: type-driven; the hooks are the F3b extension points

The engine (`src/packs/engine`) never assumes it is making a character. A type's rules say what it makes; its hook
(`src/packs/hooks.ts`) answers only what data cannot say well. The extension points for F3b:

- **`identityRole`**: which role holds a new subject's identity (Character: `core` or `compact` from `depth`);
- **`wantsIndex`**: whether a new set gets an index (Character: a Core always; a Compact Reference only with siblings);
- **`relationships`**: pages shared by two subjects, hosted under one and linked from both;
- **`upgrade`**: the role an existing identity page can become (Character: compact to core);
- **`routing`**: whether new pages are announced in an existing index's routing section;
- the **placement kinds** (`taxonomy` by a fact through the registry; `fixed` under one index), the **registered
  checks** (`pack.governance`, `pack.absent`, `pack.page`) and the **filler** (decision 12).

A type whose rules name no hook gets the generic behaviour. A tool name the pack's types share, other than the explicit
`arkona_create_character` (its own schema), is served by a **generic pack tool**, `{prefix}{tool}` with a `type`
argument, listed while its types exist and the pack is attached, and kept in step with the rules (**chosen**). The
tests define a dummy "Polity" type in test data only and run it through plan, preview, proposal, approval and verify
with no code change (`test/packs/type-driven.test.ts`).

## Decision 6: the package and the gate (the design's section 3, with four additions)

The package is the design's: `name`, `depth`, `status`, `identity`, `pages` (only the domains with real content), and
`index`. Four additions, each because the approved rules needed a place to say it:

- an identity value is a string **or `{ value, reason }`**: question 7's "`Unestablished` is accepted only with a reason,
  which is written into Unresolved Material" needs the reason (`UNESTABLISHED_NEEDS_REASON` without one);
- each image has **`interpretation`**: section 2's "each image needs its interpretation text; a bare image is refused"
  (`BARE_IMAGE`);
- **`target`** and **`upgradeToCore`** for an existing character (decision 10); `preview` is a synonym of `dryRun`;
- **`split`** is accepted only to be refused (`MONOLITH_SPLIT_UNSUPPORTED`): section 6 leaves the monolith split to F3b,
  and an explicit refusal tells an agent so rather than ignoring the field.

**The gate** (question 7): a new character's six fields (Personal / Given Name, Family / Surname, Race / Species, Naming
Culture, Life State, Temporal Scope) are required, never blank or a placeholder; `IDENTITY_INCOMPLETE` names the missing
ones and says to ask the owner, never to guess. An existing character's blank gated fields are a warning
(`IDENTITY_DEBT`, with a suggested `set_facts`), fixed in the same proposal when the package gives them.

## Decision 7: names and text (the owner's change 1)

"Em dashes are **replaced** with ASCII hyphens (names, headings and body text), not refused, and every replacement is
listed in the preview; CANON or a date in a name is still refused."

- Every em dash, and every en dash used as a separator (a space on at least one side), is replaced by an ASCII hyphen
  with a space either side, anywhere in the package (names, labels, facts, headings, text; never inside a fenced code
  block); each replacement is listed with where it was (`replacements`). An en dash inside a range (`1990–1995`) is kept
  (**chosen**: the owner's rule is about the separator dash). A body line that would start with `- ` after the change
  (a dialogue dash) is escaped, so it never becomes a list item.
- `CANON` or a date (ISO, numeric, written-out, a year, Arkona's `4A 563` style) in a page name is refused
  (`NAME_HAS_FORBIDDEN_WORD`, `NAME_HAS_DATE`).
- Text: `Purpose` first; no repeated title, no metadata header, no empty or placeholder section (refused); a missing
  Source Boundaries or Unresolved Material, and a large biography, personality, powers, wardrobe or physical block in a
  Core, are warnings (the owner's judgement, as the design says).

## Decision 8: tags are computed

From the typed facts and the closed list (Controlled Native Tagging Standard v1.8): identity pages
`{status}, Character, {race token}, {naming culture token}` (duplicates dropped); specialist pages
`{status}, Character, {one specialist tag}`; Art `{status}, Character, Character Art`; Relationships
`{status}, Character, Relationship`; an index none (question 4). `{status}` is `CANON` (Authoritative) or `Working`
(Working, first, with no `CANON`). A race or culture with no approved token **holds** its slot (left out and reported);
`Unknown`, `Unestablished` and `None` are never tags; an agent's extra tag is refused. The token maps are the standard's
own examples, editable on the Packs page.

**Chosen:** a page of an AU character carries the status tag of its lifecycle status (`CANON` when Authoritative): the
status tag is the lifecycle's, while the continuity is the page's facts (Continuity Type `AU`, its Continuity), copied
from the character (decision 10).

## Decision 9: Last Major Revision (the owner's change 2)

"Last Major Revision is set to today on every page the tool creates or substantially changes (the bridge-wide rule for
other tools is session F2's)."

- Every page the package creates gets it; every existing page it substantially changes (a gate fix, an upgrade) gets it
  while the project's `lmrPackTools` switch (F2's category for setting-pack tools) is on, its default; the preview notes
  when it is off. A link alone (Related Sources) is not substantial.
- It is dated when the job runs (a `bridge.lmr` step, as F2's), so a proposal is dated the day the owner approves it,
  not the day it was previewed (**chosen**, as F2 decided for every proposal; the preview says so). F2's planner stands
  aside for a request that already carries these steps.

## Decision 10: placing a set, and an existing character (section C2)

- **New:** `compact` makes one Compact Character Reference directly under its race (or subrace) index, with an index
  only when the package brings a sibling (question 1); `developed` makes `[INDEX] {name}` with a Character Core. Working
  (question 5, the default) puts the set under `[INDEX] Working`; `authoritative` in its race's place. A race with no
  race index goes under `[INDEX] Undetermined / Unknown` with a warning. Each page goes in its alphabetical place in the
  same write.
- **Existing characters are found first** by id, name, alias or Canonical Display Name (an index, a Core or a Compact
  Reference). Without `target`, a name that exists is refused (`CHARACTER_EXISTS`, naming it and suggesting `target`);
  never a second set. With `target`: an ambiguous name is refused with each candidate and its role
  (`TARGET_AMBIGUOUS`), an Archived character is refused (unarchive first), a domain it already has is refused
  (`DOMAIN_EXISTS`, naming the page).
- **Standing copied:** the new pages take the character's Status, Continuity Type, Continuity and Inheritance, so a
  Working character's pages go inside its Working set and an AU character's pages stay in its AU branch with its
  continuity.
- **A Working override** (`status: "working"` on a canon character) drafts the pages as `[BWRK]` flat under
  `[INDEX] Working`, with a note to promote each into place later (**chosen**: the lifecycle guard allows a Working page
  only under `[INDEX] Working` or a Working set's index, never under a canon index).
- **The Kamigawa Miyuki pattern:** a Compact Reference with no index that gains sibling pages gets `[INDEX] {name}` in
  its place; the Reference moves under it and keeps its id (the lifecycle guard judges a move into a parent made earlier
  in the same request by the area that parent is created in).
- **`upgradeToCore`** renames a Compact Reference to its Character Core (Reference Type `Character Core`, the Core
  template recorded on its tree node, its text, id and rows kept). Refused when the two templates' rows differ
  (`TEMPLATES_DIFFER`); sections the new pages now own are warned about, to trim afterwards.
- **Routing:** each new page is appended as a line to the index's "How to Use This Index" section (never a rewrite;
  warned and skipped when the section is missing or ambiguous).
- **Monolith split:** refused (`MONOLITH_SPLIT_UNSUPPORTED`); F3b.

## Decision 11: two packages for one new character (**chosen**)

Two proposals for the same new character can both be captured (a proposal is a plan, not a claim). The **job** decides:
in the lock it records a reservation of the character's name (`pack_reservations`, atomic, counted while its job is
queued, running or waiting), then lists each planned parent live and asks the tree by name. A second job that finds the
first's reservation or its pages stops with `CHARACTER_EXISTS` (or `DOMAIN_EXISTS` for a page of an existing character)
before any write. This was chosen over a claim held by a pending proposal, which would block a character for as long as
a proposal waits and would need releasing on every rejection.

## Decision 12: what the general bridge gained

Each is general, not Arkona's:

- **Registered async checks** (`registerAsyncChecker`) in a job's expect and verify steps, with read access through the
  engine and a refusal that becomes `refused_in_lock` (`CheckRefusedError`); a **filler** (`registerFiller`) that writes
  a template copy's text in the lock from what the copy really holds; the record store `pack`.
- Binders: **`bindAssetUrls`** (an image block's URL from its asset step), `bindFrom` `documents.main.id` (a new page's
  main document), each upload's key bound to the nearest preceding upload step.
- Images: a staged upload is settled as placed when its own asset step succeeded (several images in one job).
- The write-job options **`forceProposal`** and **`stagedPlacement`**; MCP tools may carry a **`listed`** predicate, and
  the runtime keeps its tool list live (pack tools appear and leave as packs are attached or their types change).
- The lifecycle guard judges a move into a parent created earlier in the same request; the registry resolves a race to
  its index (`raceIndex`).

## Decision 13: the Packs page

A dashboard page after Repository Mappings: each pack's state, governance sources with approved and current versions,
projects and template ids, token maps (editable), rules (read-only), versions. **Approve this pack version** and
**Save token maps** each need a confirmation and a fresh re-authentication, and are audited. Saving token maps makes a
new version that waits for approval. Editing the rest of the rules on the dashboard is left for later.

## Deviations from the approved design, and why

| Design                                                          | As built                                                                                   | Why                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Identity values are strings                                     | A string or `{ value, reason }`                                                            | Question 7's reason for `Unestablished` needs a field                                                                           |
| Images: `staged_id`, `label`, `subfolder`                       | Plus `interpretation`                                                                      | Section 2 refuses a bare image                                                                                                  |
| The relationship is added to both participants' Related Sources | Deferred for a Working relationship whose partner is canon (`PARTNER_LINK_DEFERRED`)       | Source Formatting: no Working page as a current link on a canon page; the warning says to add it with `set_facts` once promoted |
| `host` names the hosting participant                            | `host: "other"` refused for a Working relationship (`HOST_NOT_WORKING`)                    | A Working relationship sits in its own character's Working set                                                                  |
| Last Major Revision is today                                    | The day the job runs (the day of approval); existing pages follow `lmrPackTools`           | F2's rule for proposals and its per-project switch                                                                              |
| The package names the Core's markdown `# Purpose`               | Any heading named Purpose first; the guide shows `## Purpose`                              | Arkona's pages use level-2 sections; both are accepted                                                                          |
| Pack rules "stored per project"                                 | One pack document, attached to projects, template ids per project                          | Decision 1                                                                                                                      |
| Art page: image blocks stating what each establishes            | A "Reference Images" section: per image its label (level 3), the image, its interpretation | One place on the page for the references (**chosen**; in the pack's data, `assets.section`)                                     |
| Existing characters found by name resolution                    | Also `target` (explicit), `upgradeToCore`, routing lines, the in-job existence check       | Section C2 of the brief                                                                                                         |

## Consequences

- Another setting gets its own pack (rules and seed) without changes to the general bridge; F3b's types (outfits,
  species, institutions, nations, owner types) are new types in the Arkona pack's data, with a hook only where needed.
- Every Arkona package is a proposal for its first weeks; the owner turns `alwaysPropose` off by a new pack version when
  trusted (not yet editable on the dashboard).
- The pack tool adds about 2,330 tokens to a `propose` or `write` profile's tool list (57 tools, about 32,660), only
  where the pack is attached. A compact character costs 4 reads to plan, then about 20 reads and 19 writes (one write per
  sidebar row).
- Left for later: selective approval and resuming a part-built package (PLAN-v2 10.5), the monolith split, the other
  pack tools, and editing more of the rules on the dashboard.
