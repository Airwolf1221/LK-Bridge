# ADR 0080: v3 F6c: territories, nations and their subindexes: five structural registry types with roles, one list of nation roles and unified names, the Nation Subindexes report, three checks, and placement by role

- Status: **Proposed** (v3 F6c, 26 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). The sandbox check
  (`f6c-territory`) is opt-in and the owner runs it. Where the brief was silent the choice is marked **chosen**.
- Design: `LK-Bridge-F6-taxonomy-design.md`, T3 to T5 as amended; approved by the owner on 23 November 2026, with the
  open points ruled on 26 November 2026 (the unified name form, the ten roles, unmatched names to the owner). The design
  document is not in the repository; the brief's own summary was used and is binding.
- Builds on [ADR 0076](0076-v3-f6a-reference-type-vocabulary.md) (F6a: the table patterns, F6a.1's lessons) and
  [ADR 0079](0079-v3-f6b-navigation-and-subject-indexes.md) (F6b: the approved index classification, `create_index`'s
  nav path, F5b's automation codes).
- Amends: [ADR 0026](0026-type-registry-and-name-resolution.md) (structural types with no root index, role bindings, a short
  name), [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (owner placement by role once seeded;
  a promoted nation recorded in the registry), ADR 0079 (F6b's stopgap `structural.nationSubindexes` replaced by a
  derived list; C2's matching in the nation subindex rule), [ADR 0044](0044-audits.md) (three codes),
  [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) (two proposal-first codes, default Off, Apply allowed).
- Migrations `4800_registry_roles.sql` (`registry_types.taxonomy_kind`, `taxonomy_entries.short_name`,
  `registry_roles`), `4810_nation_subindex_decisions.sql`, `4820_category_home_rulings.sql` (**chosen**: a third
  migration for the "keep it here" rulings rather than a table hidden in 4810). Pack seed `arkona-2026-11-27-f6c`
  (supersedes `arkona-2026-11-25-f6b`). New settings in `src/config/registry.ts`: `NATION_SUBINDEX_BULK_MAX` (500) and
  three per-project switches (`checkNationSubindexNames`, `checkTerritoryCategories`, `checkCategoryHomes`, default on).

## C1: five structural types, with roles

`Territory`, `Nation`, `Divine Realm`, `Culture family`, `Religion family`: ordinary registry types (placement
`generic`) marked by `taxonomy_kind`, one of each per project, with **no root index**: their entries sit wherever the
tree has them. Code: `src/packs/nations/service.ts` (`NationTaxonomyService`), the store's role methods in
`src/registry/store.ts`.

| Type            | Seeded from F6b's approved rows matched by                          | Parent                      | Roles                      |
| --------------- | ------------------------------------------------------------------- | --------------------------- | -------------------------- |
| Territory       | `continent`, `realmship` (not under a `lostRealmshipParents` index) | none                        | the territory categories   |
| Nation          | `nation`                                                            | its Territory entry         | the ten nation roles (C2)  |
| Divine Realm    | `divine_realm`                                                      | none                        | none (no template imposed) |
| Culture family  | `culture_family`                                                    | its Territory, if under one | none                       |
| Religion family | `religion_family`                                                   | its Territory, if under one | none                       |

- **Approved rows only.** A row is seeded only when the owner approved (or changed) it to `subject` on Index
  Classification. A matched row with no decision is returned as **classify first** and never seeded; a row the owner
  left undecided is not listed; a row approved as `nav` is not an entry.
- **Roles** (`registry_roles`): an entry's role bound to ONE node; one node per role per entry and one role per node
  (`ROLE_BOUND`, `NODE_BOUND`). `status` ok or `needs_review` with its reason; `origin` seed, add_missing, owner, or
  **`job`** (**chosen**: a fourth origin for a binding recorded after a job made the index, so the audit trail tells it
  from a seed's). A role with no index is simply unbound: no row.
- **Territory bindings**: by the exact name `<Territory> <Category>` among the territory's children (case and spacing
  aside); `Conflicts` inside the bound `Historical Events` (the pack's `categoryParents`). Two indexes of the expected
  name: none bound, the entry `needs_review` (`role_ambiguous:<category>`).
- **Nation bindings**: C2's matching among the nation index's direct index children (an approved subject excluded), and
  the owner's Nation Subindexes decisions (accept and map give the role; specialist and not-a-subindex none). Two
  children for one role: none bound, the entry `needs_review` (`role_collision:<role>`). A child whose classification is
  not approved as `[NAV]` yet is bound `needs_review` with that reason.
- **The order**: Nation is refused until Territory is seeded (`SEED_TERRITORY_FIRST`), since a nation's parent is its
  Territory entry. A nation with no Territory above it is `needs_review` (`no_territory`).
- **Seed and Add missing** (Repository Mappings, the new "Territories and nations" card; the step-up; audited
  `registry.structural_seed`, `registry.structural_add_missing`): "Seed" the first time (`ALREADY_SEEDED` after);
  "Add missing" creates entries for new approved rows and binds unbound roles, and never changes an existing entry or
  binding. Anything the seed cannot be sure of is `needs_review` with the reason, never guessed.
- **The short name** (`taxonomy_entries.short_name`): edited per Nation entry on the card (through the existing
  `PUT /registry/taxonomy/:id`, audited `registry.entry_update`); used only to name subindexes.
- **A created nation records its entry**: `addPackTaxonomyEntry` is generalised (a `kind`), not copied: an approved
  `arkona_create_owner` package with `promoteNation` records the new nation index as a Nation entry, its parent the
  Territory entry whose bound Polities holds it (a `taxonomy_entry` record step with `taxonomyKind: 'nation'`). A type
  not seeded, or an index with an entry already, is left alone and the record says why.

## C2: the nation roles and the unified name

Pack data (`indexTaxonomy.nationRoles`, `nationRoleVariants`; `src/packs/nations/roles.ts` is pure):

1. Government & Administration · 2. Institutions · 3. Historical Events · 4. Military & Technology · 5. Unique Magic &
   Technologies · 6. Cultures · 7. Settlements & Locations · 8. Religion & Religious Administration · 9. Household &
   Court · 10. Historical Polities

Variants: Government & Institutions → Government & Administration; Institutions & Education → Institutions; History &
Conflicts → Historical Events; Settlements & Infrastructure and Settlements & Historic City-States → Settlements &
Locations; Historical Polities & Integration and Founding Polities & Regions → Historical Polities.

- **The name** (the owner, 26 November 2026): `<Nation> <Role>`, `<Nation>` the entry's short name, else the nation
  index's display name. The prefix stays `[NAV]` (the rename keeps whatever prefix the page has: **chosen**, so an index
  not yet re-prefixed by F6b's `index_prefix` is not given a second change in one write).
- **The match** (`matchNationChild`): the display name (the prefix aside), compared without case or accents (NFD, marks
  removed) and with the dash forms aside, against each role name and each variant, in the three live forms (bare,
  `<Nation> <word>`, `<Nation or short name> - <word>`). The owner's mapping of an exact name is read first. No match: the
  child is **unmatched** and goes to the owner; it is never guessed. `&` and "and" are not folded (**chosen**: "Military
  and Sacred Arsenal" stays unmatched, as the owner listed it).
- **F6b agrees**: F6b's stopgap `structural.nationSubindexes` is replaced by a derived list (the roles and the
  variants), and F6b's `nation_subindex` rule now uses C2's matching with the owner's mappings, the names kept as
  specialist subindexes and the Nation entries' short names (`IndexClassifyDeps.nationSubindex`, the base's cache key
  moving with them). The seed upgrade replaces only that list; every other structural list stays the owner's.

## C3: the Nation Subindexes report and the owner's decisions

A dashboard page, **Nation Subindexes** (Setup, beside Reference Types and Index Classification), F6a and F6b's
patterns: paged (100 a page), filters (status, nation, name, collisions), one request in flight, decisions in
`nation_subindex_decisions` (migration 4810). Read-only and free: the tree, the registry and the pack.

- **The rows**: every direct child index of every nation (a Nation entry once that type is seeded, else an index
  directly in a `<Territory> Polities` index, F3b's rule). A child the Index Classification approved as a **subject**
  index is not a candidate. **Chosen**: a child whose classification is not approved yet is still listed (marked "not
  yet approved as [NAV]", linked to its classification row), so the owner can map or rule it here; the owner's decision
  on this page is itself a ruling that it is (or is not) a nation subindex. Grandchildren (`Al-Falak` inside
  `Settlements & Infrastructure`) are never rows.
- **Each row**: the nation, the child (raw name, link), its children count, the matched role and how (role name,
  variant or the owner's mapping; the form), the proposed name, the status (`proposed`, `unmatched`, `accepted`,
  `mapped`, `specialist`, `not_subindex`), a collision, and, when the matched name names two roles (`Government &
Institutions`), the index's pages with their primary category tags.
- **Actions** (the step-up; audited `nationsubindex.decide`): Accept (`NOTHING_MATCHED` on an unmatched row), Map to a
  role (`ROLE_UNKNOWN` lists the ten), Keep as a specialist subindex, Not a subindex. **"…for every page with this
  name"** (`POST /nation-subindexes/map-all`, audited `nationsubindex.map_all`): every nation's child of that exact display
  name not decided yet, ONE transaction, at most `NATION_SUBINDEX_BULK_MAX` (500; `BULK_TOO_LARGE` above), idempotent.
- **Undo** (audited `nationsubindex.undo`) as on the other two tables: refused once a rename carrying the decision's id
  has been applied (`DECISION_APPLIED`, from the write journal).
- **Collisions**: two children of one nation with the same role: neither is renamed ("two subindexes for one role:
  merge or re-map first"); the bridge never merges or moves pages. **Content that spans two roles** is shown, never
  moved: moving it is the owner's (or `category_home_mismatch`'s proposals, C4).
- **F6a.1 and F11's lessons**: the base (nations, children, grandchildren's tags) is built from ONE light scan
  (`nodeScan`) in chunks that yield, cached on the tree's version, the registry's structure key and the pack's version;
  the rows from it in memory under the decisions and the classification's version. Every route awaits `prepare`.

## C4: three checks (category taxonomy; each switchable per project)

`src/audits/checks/nation-taxonomy.ts`, from the snapshots, free; only under the APPROVED pack with nation roles.
None looks under Working, Archive, the Legacy Canon Archive, the Design References or Narratives. Each is switched off
per project on the Projects page (`checkNationSubindexNames`, `checkTerritoryCategories`, `checkCategoryHomes`; default
on, in the settings registry through the project settings).

| Code                          | Severity        | Reports                                                                                                                                                                          | Fix                                                                                                                                                                                                                        |
| ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nation_subindex_nonstandard` | warning         | an ACCEPTED or MAPPED row whose name differs from `<Nation> <Role>` (undecided rows wait on the page; a collision is never renamed)                                              | `nation_subindex_name`: ONE `updateResource` of the display name, the prefix, id and links kept; FIX_STALE when the decision (its id or role) or the page's name changed; its journal entry carries the decision's id      |
| `territory_category_missing`  | warning         | a Territory entry with a REQUIRED category (`requiredTerritoryCategories`, amendment 1) unbound and no index of the expected name (Conflicts inside the bound Historical Events) | `territory_category`: create_index's role form (`roleFor { territory, category }`, the "[NAV] AI Navigation" template, T11's order and tags) as a proposal; the role bound by a `bridge.record` step once the job succeeds |
| `category_home_mismatch`      | info, judgement | a source whose primary category tag's owner type does not allow its home, resolved by role (C5); pages under a character root are not owner pages and are skipped                | `category_home`: ONE `moveResource` to the nearest allowed home (`suggestHomes`), in its place there; always a proposal, never automation                                                                                  |

- **Automation** (F5b): `nation_subindex_nonstandard` and `territory_category_missing` are proposal-first codes with
  Apply allowed, **default Off** (the owner switches them to Propose for a first batch). `category_home_mismatch` is in
  the catalogue as never eligible (`judgement`).
- **"Keep it here"** (`POST /audits/findings/:id/keep-home`, the step-up, a reason; audited `audits.keep_home`): F5a's
  ruling mechanism, tied to a SHA-256 of the page's tags and parent (migration 4820): silent until either changes.
- Each fix is described in its finding's message, in plain words.

## C5: placement by role

`src/packs/engine/homes.ts` takes a **role view** (`RoleView`, built and cached by the service from the registry):

- `<Continent> <Category>`: once Territory is seeded, a territory's bound role of that category (else the name rule);
- `<Nation> <Category>`: once Nation is seeded, T4's three governed levels: the nation's bound role (`role`); else the
  nation index itself, when the nation has no index bound for that role or the category is not a nation role
  (`nation`); else the territory's bound category of the same name (`territory`); `nationCategoryHome` resolves the same
  for ONE nation, a compact polity included;
- "a nation": once Nation is seeded, a Nation entry's index; `findNation` also by the entry's short name;
- the Polities that hold nations: once Territory is seeded, a territory's bound Polities.

While a type is not seeded, today's name rules stay in force, unchanged (`level: 'name'`). The result says which level
it used and why (`homeMatch`; `arkona_create_owner`'s `home.placement`). This fixes short names: with "Cantha" as the
short name, `<Nation> <Category>` by name would fail (no ancestor is named Cantha), the binding finds it. Used by
`arkona_create_owner` (its home check, its `createSubindex` name: `<Nation> <Role>` once seeded) and
`category_home_mismatch` (the same rules over the snapshots, `homeTreeOf`).

**`create_index`'s role form**: `roleFor` { nation, role } or { territory, category }: the entry by its index's id,
name or a nation's short name (`UNKNOWN_ENTRY`, `ENTRY_AMBIGUOUS`), the type seeded (`NOT_SEEDED`), the role the pack's
(`ROLE_UNKNOWN`), not bound yet (`ROLE_BOUND`); the name C2's (`NAME_NOT_GOVERNED` for another `name`), the parent the
nation's or territory's index (Conflicts: the bound Historical Events, else `CATEGORY_PARENT_UNBOUND`), always `[NAV]`
(`ROLE_FORM_NAV` for `role: "subject"`); a `bridge.record` step after the page binds the role once the job succeeds.

## C6: governance and the seed

Seed `arkona-2026-11-27-f6c`: `nationRoles`, `nationRoleVariants`, `requiredTerritoryCategories` (amendment 1),
`categoryParents` ({ Conflicts: Historical Events }),
`lostRealmshipParents` (Lost Realmships), the derived nation subindex list, and the ruling `nation-subindex-roles`
(26 November 2026), ending "Not yet recorded in Source Formatting's Nation-Centred Territorial Navigation: the owner's
reviewer writes it after deploy." The three codes are registered in the automation catalogue.

**No new parser**: the pack data is the authority. Source Formatting's "Nation-Centred Territorial Navigation" is
pinned already, so the reviewer's text shows as governance drift and the owner approves again.
`ensureSandboxGovernance` is untouched (no parsed section was added).

### The paragraph for "Nation-Centred Territorial Navigation" (the owner's reviewer writes it after deploy)

> A nation's subindexes follow one list of roles, in this order: Government & Administration; Institutions; Historical
> Events; Military & Technology; Unique Magic & Technologies; Cultures; Settlements & Locations; Religion & Religious
> Administration; Household & Court; Historical Polities. Each subindex is a navigation index named `[NAV] <Nation>
<Role>`, where `<Nation>` is the nation's short name when it has one (`[NAV] Cantha Settlements & Locations`), and
> otherwise the nation index's display name (`[NAV] Jabal al-Noor Military & Technology`). A nation has at most one
> subindex per role; a child whose name matches no role goes to the owner, who maps it to a role, keeps it as a
> specialist subindex, or rules it not a subindex.

## C7: guidance

The bridge guide gains "Territories, nations and their subindexes" (under the Arkona sections, after "Navigation and
subject indexes"). "How to decide" is unchanged (no row added, nothing trimmed; its cap stands at 9,779).
`create_index`'s description gives the role form; `arkona_create_owner`'s says placement is by role once seeded.

## Costs (measured against the mock, pinned by the tests)

- The report, the seeding, the decisions, the checks: none (the bridge's own data and the snapshots).
- `nation_subindex_name`: one read to plan; the job one check read, one write, one read-back.
- `territory_category`: create_index's (about 5 reads and 1 write), and the record step (no request).
- `category_home`: two reads and the home's children list to plan; the job one check, one move, one read-back.

## The sandbox check (written, not run; passing on the mock)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6c-territory` (test/sandbox/f6c-territory.ts,
T0 to T5; run in the ordinary suite against the mock by test/sandbox-mock/f6c-territory.test.ts): a throwaway
territory with six of its seven REQUIRED categories (all but Unique Magic & Technologies; its Historical Events without
Conflicts; no Religions, which is recognised but never required, amendment 1) and a nation in its Polities with
"Government & Institutions", "Military & Naval Affairs" and a subject index; the classification and the seed in the
TEMPORARY database; the decisions; the audit, with the two renames and the two category creations applied as the
automation's Apply submits them; everything read back live; clean-up.

## Other choices, and what is deferred

- **Chosen**: `category_home_mismatch` stays on the Audits page and is left out of `arkona_appraise_owner`'s gathered
  audit findings (it is about where a page sits, not a defect of its content; the appraisal's per-page report would
  otherwise repeat a placement judgement on every page of a misplaced batch).
- **Chosen**: the rename check never renames a child into a name a sibling already holds (a collision the report shows),
  besides the decisions' own collisions.
- **Chosen**: the home check caches its match and suggestions per (home, owner type) pair and its tag reading per tag
  list, so it stays within the 10% rule (measured: about 45 ms of a 1.7 s audit at 1,500 pages).
- **Deferred**: `arkona_create_owner`'s `createSubindex` names a new subindex `<Nation> <Role>` once the Nation type is
  seeded, but does not record the binding itself; "Add missing" on Repository Mappings binds it (as it does any new
  matching child). F6b's classifier still finds nations by position (an index in a `<Territory> Polities`), not by
  Nation entry; the two agree on every seeded nation.

## Consequences

- Nothing changes until the owner approves `arkona-2026-11-27-f6c` and seeds: placement keeps its name rules until the
  Territory and Nation types are seeded; the checks act only on the owner's decisions and seeded entries.
- Deploy order: deploy; approve the seed; seed the five types on Repository Mappings (Territory first, then Nation);
  work through Nation Subindexes; switch the two codes to Propose for a first batch; the reviewer writes the governance
  paragraph above; re-approve.

## Amendment 1 (26 November 2026, before deploy): the required categories; "Accept all matched"

- Status: **Proposed**, the owner's follow-up before deploy. Built and tested against the mock only.
- **The required territory categories are the governance's, not the recognised list.** Source Formatting's "Approved
  Hierarchy and Standardised Navigation" requires exactly: Cultures; Historical Events, with Conflicts inside it;
  Institutions; Polities; Regions; Settlements & Locations; Unique Magic & Technologies. No live territory has a
  `<Territory> Religions` index, so reading the recognised list would have proposed 17 empty Religions indexes. New pack
  data `indexTaxonomy.requiredTerritoryCategories` (those seven plus Conflicts, in that order; each must be one of the
  recognised categories, checked by the schema) is read ONLY by `territory_category_missing`.
  `structural.continentCategories` stays the RECOGNISED list: seeding binds Religions wherever a `<Territory> Religions`
  exists, F6b's classifier still knows it, and `create_index`'s role form still makes it on request. A pack version
  without the new list requires every recognised category (the earlier behaviour). This replaces the earlier **chosen**
  note that Religions counts as a territory category for the check.
- **The seed's name stays `arkona-2026-11-27-f6c`**: the f6c seed has not been merged or deployed anywhere, so no stored
  pack can hold the earlier f6c rules (a new name is needed only once a seed may be stored). The seed upgrade carries the
  new list as it carries the rest of `indexTaxonomy` (the owner's structural lists kept).
- **"Accept all matched"** on Nation Subindexes (`POST /nation-subindexes/accept-all`, the step-up; audited
  `nationsubindex.accept_all`): every UNDECIDED row matched by a role name or an approved variant, with no collision and
  an approved `[NAV]` classification; never an unmatched, colliding or unapproved row. The GET counts them for the
  page's filter (`acceptable: { count, ids }`), shown on the button and in the confirmation before anything is sent. ONE
  request by those ids (each checked again; a refused id is returned with its reason: `unmatched`, `collision`,
  `classification_not_approved`, `already_decided`); at most `NATION_SUBINDEX_BULK_MAX` (the rest counted as
  `remaining`); the rows read ONCE at the start, decided in batches of 25 (each one transaction, every row checked again
  against the decisions store), a yield to the event loop between batches, and the rows rebuilt ONCE at the end (F6a.1's
  lesson: no per-row rebuild). Idempotent. Each decision is an ordinary accept (`via` `accept_all`; migration 4810's
  check allows it, unreleased so edited in place), so Undo works per row.
- **Tests**: a territory with all seven and Conflicts and no Religions has no finding (and a version without the list
  still requires Religions); the world's Accept all (eligibility, skipped reasons, idempotence, per-row undo); the page's
  button and confirmation; at Arkona's scale, 60 matched rows in one request under 500 ms, the loop never held for
  100 ms, the heap and RSS flat over ten reloads after it. The sandbox's territory now omits a REQUIRED category (Unique
  Magic & Technologies) and has no Religions index.
