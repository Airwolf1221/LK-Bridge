# The type registry, taxonomy, name resolution and ordering (v2 A3)

Where each kind of page lives, and how the bridge finds and places pages (PLAN-v2 4.3, 4.4, 4.5 and section 9). The
**type registry** says, for each type (for example Character), its root index, templates, asset folder and placement
rule. The **taxonomy** lists a type's categories (for Characters: groups such as Beastkin, races such as Foxians,
subraces such as High Humans). The **resolver** turns a name into exactly one page; **ordering** says where a new page
goes among its siblings; **character placement** plans where a character's pages go. Later write tools (phase C) use
all of them. Nothing here writes to LegendKeeper, and there is no MCP tool.

Design: [ADR 0026](adr/0026-type-registry-and-name-resolution.md). Source: `src/registry/`. Migration:
`0800_type_registry.sql`. Routes: `src/admin/routes/registry.ts`. Page: the **Repository Mappings** page
(`ui/src/pages/registry.tsx`). Tests: `test/registry/`, `test/ui/registry.test.tsx`.

## Setting it up on the test world

The repository tree must be built first ([docs/tree.md](tree.md): set the AI REPOSITORY root, start the first build,
wait for **Ready**). Then, on the dashboard, with the project chosen in the sidebar:

1. **Seed the Character type.** Repository Mappings → _Types and taxonomy_ → **Seed the Character type**. The bridge
   reads the project's templates once (one `listTemplates` request per 100 templates, through the project's governor)
   and looks for `[INDEX] Characters` directly under AI REPOSITORY. The type appears in the table with its root index
   (a link to the Repository Tree), its templates and **OK** or **Needs review** with the reasons (a template not
   found, or found twice; no root, or two).
2. **Fix and review the type.** **Edit**: correct anything flagged (template ids can be typed or picked from the list
   of the project's templates; **Read the templates again** refreshes it), tick **Mark as reviewed**, **Save**.
3. **Seed the taxonomy.** In _Taxonomy_, with Characters chosen, **Seed the taxonomy**, then confirm. Every index under
   Characters becomes an entry, except character indexes and `[INDEX] Undetermined / Unknown`. The note after it says
   how many entries were made, how many need review, and how many character indexes were left out.
4. **Work through the review queue.** _Review queue_ lists every entry marked **Needs review**, with the reasons. For
   each: **Edit** (or click its name in the queue), check the singular (and add aliases, an asset folder or notes if
   wanted), keep **Mark as reviewed** ticked, **Save**. Saving a guessed singular as it is confirms it. On the test
   world expect the groups and races whose names do not come from the old bridge's list (Beastkin, Foxians, Qishen,
   Saru and the like), empty indexes, and anything more than two levels below Characters.
5. **Check it.** _Try it_ → **Plan a character placement**: a known character and race (for example the race's plural
   or singular) should show the race index, "reuse" or "create" for the character index, and an existing Core returned
   rather than duplicated; a blank race should go to `Undetermined / Unknown` with Race / Species `Unestablished`.

From then on the nightly check of the tree also makes a **drift report** (the _Drift_ section); **Compare now** makes
one at once. **Add missing** creates entries for new indexes later; it never changes existing entries.

## Types

| Field             | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| singular, plural  | `Character` / `Characters`; unique within the project (either name)                                        |
| root index        | a node of the repository tree; it must be an `[INDEX]` page                                                |
| index template    | the template new indexes of this type are made from                                                        |
| page templates    | a list of named roles, for example `core` → `[BSRC] AI Character Core`, `compact` → `…Compact…`            |
| asset root folder | `Characters` (A4 and D3 use it)                                                                            |
| placement rule    | `character` (section 9, settings below) or `generic` (a page goes under the index it is given)             |
| recipe            | a versioned JSON document, `{ "version": 1 }`, empty in v2; it will hold page types, facts and child pages |
| status, review    | `ok` or `needs_review`, with the reasons the seed recorded; cleared by **Mark as reviewed**                |

The table also shows **live checks** that are never stored: no root set, a root not in the tree, a template id not
among the project's templates as last read.

**Character placement settings** (per type, defaults from the old bridge, editable through the API; the dashboard edits
the placement rule itself): `unknownIndexName` (`Undetermined / Unknown`), `unknownRaceValues` (`Unknown`,
`Undetermined`, `Unestablished`, `Undetermined / Unknown`; blank and null always count), `unknownSpeciesValue`
(`Unestablished`), `referenceTypes` (`Character Core`, `Compact Character Reference`), `subjectRow` (`Subject`),
`speciesRow` (`Race / Species`), `pageNames` (`{name}` for both).

## The taxonomy

Each entry: plural (the index's display name), singular, parent entry, aliases, the source index's id, the asset folder
(default: the plural), status and review reasons, notes. Owner edits: singular, aliases, asset folder, parent, notes,
and **Mark as reviewed**. An alias or singular that another entry of the type already answers to is refused (it would
make races ambiguous); so is a parent loop. Deleting an entry with entries under it is refused.

**How seeding decides.** It walks the type root's subtree in the tree:

- an index that directly holds a `[BSRC]` page whose Reference Type is `Character Core` or `Compact Character
Reference`, and whose subject (its `Subject` row, else its display name before " - ") equals the index's name, is a
  **character index**: not an entry, and not walked into;
- `[INDEX] Undetermined / Unknown` directly under the root is reserved for unknown races;
- every other index is an entry, its parent the nearest entry above it.

**Marked for review, with the reason:** a singular from a rule; an index more than two levels below the type root
(the race search reaches only the root's children and grandchildren); an empty index (it may be a character index whose
Core page does not exist yet); an index whose pages' properties the tree has not read yet; two indexes with one name; an
index under the unknown-race index.

**Singulars.** First the old bridge's `race-mappings.json` list (Human, High Human, Elf, Dark Elf, High Elf, Moon Elf,
Sea Elf, Sky Elf, Sun Elf, Wood Elf, Dwarf, Greenskin, Goblin, Orc, Outsider, Daemon, Devil, Faerie, Genie, Therian,
True Dragon): no review needed. Then rules, all marked for review: the list applied to the last word, `-ies` → `-y`,
`-ss` kept, `-s` dropped, a name not ending in `s` kept as it is (Beastkin, Saru, Qishen). `-ves` → `-f` only via the
list.

## Drift

Made after each completed nightly check of the tree (and by **Compare now**), from the stored tree, with no request.
**Reported, never fixed.**

| Finding             | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| Type root missing   | the type's root index is no longer in the tree                                     |
| Index with no entry | an index under a seeded type's root with no entry, and not a character index       |
| Index deleted       | an entry's index is no longer in the tree                                          |
| Index renamed       | an entry's index has another name than the entry's plural                          |
| Index moved         | an entry's index has another parent than when the entry was made, or left the type |
| Parent differs      | the entry's parent is not the nearest entry above its index in the tree            |

Each finding links to the page on the Repository Tree page (`/ui/tree?node=<id>`).

## For later sessions

`runtime.registry.forProject(projectId)` (`ProjectTypes`), all synchronous and answering from the stored tree:

- `resolve(query, { scope?: { under: nodeId } | { type: typeName }, kinds?: ['index' | 'bsrc' | 'unclassified'] })` →
  `{ status: 'resolved', node, matchedBy }` | `{ status: 'ambiguous', candidates }` | `{ status: 'not_found', near }`.
  A query is an id (or `lk://resources/<id>`), a raw name, a display name, an alias or a Canonical Display Name, any
  case; stray leading `[INDEX]` / `[BSRC]` prefixes are removed (repeats collapse) and, when they tell matches apart,
  used. Scope below a node excludes the node itself. `resolveOne` throws `RegistryError` `AMBIGUOUS` / `NOT_FOUND`
  instead. A tree that is not built throws `TREE_NOT_READY`.
- `mentionResolver(options?)` → B1's `ctx.resolveMention` for `[[Name]]`.
- `placementFor(parentId, newDisplayName, kind, { excludeId? })` → `{ after }`, `{ before }` or `{}` (empty parent), for
  createResource, createResourceFromTemplate and moveResource. `outOfOrder(parentId?)` → the siblings that break the
  rule, per parent, each with where it belongs.
- `planCharacterPlacement({ characterName, race?, kind: 'core' | 'compact', type? })` → the race index, the species
  value to write (`species.row`, `species.value`), the character index (`reuse` or `create` with its name, template and
  slot; core only), the page (`return_existing`, or `create` with its parent, name, template, Reference Type and slot;
  `parentId: null` means the index this plan creates), existing Core and Compact pages, and warnings. Refusals are
  `RegistryError`s: `NO_CHARACTER_TYPE`, `TYPE_ROOT_MISSING`, `UNKNOWN_INDEX_MISSING`, `UNKNOWN_INDEX_AMBIGUOUS`,
  `RACE_NOT_FOUND` (with `available`), `RACE_AMBIGUOUS` (with `candidates`), `RACE_NEEDS_REVIEW`,
  `RACE_SOURCE_MISSING`, `CHARACTER_INDEX_AMBIGUOUS`, `EXISTING_PAGE_AMBIGUOUS`, `TEMPLATE_NOT_CONFIGURED`.
- `commands` (owner, audited) and `store` (the tables).

## Admin API

All under `/api/admin`, in the `project` query parameter's project (another project's ids are "not found").

| Route                                                              | Does                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `GET /registry`                                                    | types (with live checks), the templates snapshot, seed defaults   |
| `POST /registry/types`, `GET`/`PUT /registry/types/:id`            | create, read, edit a type (`reviewed: true` marks it reviewed)    |
| `POST /registry/types/:id/delete`                                  | `{ confirm: true }`; its entries go with it                       |
| `POST /registry/seed-character`                                    | seed the Character type (optional overrides of the seed defaults) |
| `POST /registry/templates/refresh`                                 | read the project's templates again                                |
| `GET /registry/types/:id/taxonomy`                                 | entries in tree order, with their index now, and the review queue |
| `POST /registry/types/:id/taxonomy/seed`                           | `{ confirm: true }`; once per type                                |
| `POST /registry/types/:id/taxonomy/add-missing`                    | entries for new indexes only                                      |
| `PUT /registry/taxonomy/:id`, `POST /registry/taxonomy/:id/delete` | edit an entry; delete one (`{ confirm: true }`)                   |
| `GET /registry/drift`, `POST /registry/drift/run`                  | the latest report and recent ones; compare now                    |
| `GET /registry/try/resolve?query=&type=&under=&kinds=`             | read-only                                                         |
| `GET /registry/try/placement?characterName=&race=&kind=&type=`     | read-only                                                         |
| `GET /registry/try/ordering?parentId=&name=&kind=&excludeId=`      | read-only; also the parent's out-of-order siblings                |
| `GET /registry/out-of-order?parentId=`                             | read-only; every parent when omitted                              |

Errors are `{ error: { code, message, … } }` with the details (`candidates`, `available`, `review`): `400
INVALID_INPUT`, `403 NOT_OWNER`, `404 NOT_FOUND`, and `409` for every refusal of a lookup, seed or plan.
Audit actions: `registry.type_create`, `.type_update`, `.type_delete`, `.type_seed`, `.templates_refresh`,
`.taxonomy_seed`, `.taxonomy_add_missing`, `.entry_update`, `.entry_delete`, `.drift_run`.
