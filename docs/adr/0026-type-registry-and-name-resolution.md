# ADR 0026: The type registry and taxonomy, name resolution, ordering and character placement

Status: Accepted (v2 session A3, 10 November 2026). Implements PLAN-v2 4.3, 4.4 and 4.5, the placement rules of section
9, and the constraints of 10.2 and 10.4 on how the registry is stored.

## Context

Every write tool in phase C puts pages somewhere: a character under its race, an index under its type's root, a new
`[BSRC]` page in its alphabetical place. Each of those decisions needs three things the repository tree (A2, ADR 0025)
does not give on its own: which index is a type's root and which templates it uses (the **type registry**); which
indexes are categories of a type, with their singular names (the **taxonomy**); and one way to turn a name into exactly
one page (the **resolver**), plus where a new page goes among its siblings (**ordering**). Getting any of these wrong
puts pages in the wrong place, which the owner then has to find and move by hand. The rule throughout is to refuse
rather than guess.

## Decision

1. **Everything is per project and stored as data.** Migration 0800 adds `registry_types`, `taxonomy_entries`,
   `registry_state` (the last read of the project's templates) and `taxonomy_drift_reports`, each row with
   `project_id`, children referencing parents by `(project_id, id)`. Nothing is hard-coded for Arkona: the old bridge's
   conventions (the `Characters` root, the template names, the race-mappings list, the unknown-race index and its
   `Unestablished` value, the Reference Types, the `Subject` and `Race / Species` rows) are **seed defaults**
   (`src/registry/seed-data.ts`) and per-type settings (`placement_config`), editable on the dashboard.
2. **Types grow into recipes (PLAN-v2 10.2).** A type has its singular and plural, root index, index template, page
   templates as a list of named roles (`core`, `compact`, …), asset root folder, placement kind (`character` or
   `generic`), a versioned `recipe` JSON document (`{ "version": 1 }`, empty in v2) and a `pack_id` for the setting
   pack it will belong to. Roles rather than fixed columns let a recipe name any number of page templates later.
3. **Seeding is explicit and once.** The Character type is seeded on the owner's request from the tree (the
   `[INDEX] Characters` node directly under the root) and the project's templates (one `listTemplates` read through
   the project's governor, the registry's only LegendKeeper request). Templates match by exact name with the word
   "Template" ignored, because LegendKeeper's copies drop it (so `[BSRC] AI Character Core Template` is the template
   `[BSRC] AI Character Core`). Anything not found, or found twice, is left empty and the type is `needs_review` with
   the reason. A type's taxonomy is seeded once (`taxonomy_seeded_at`); afterwards **"add missing"** only creates
   entries for indexes that have none and never changes an existing entry. Neither happens by itself.
4. **One walk decides what is a category.** Seeding, "add missing" and the drift report share `classifyType`, so they
   always agree. Under the type root, an index is a **character index** (not a category, and not walked into) when it
   directly holds a `[BSRC]` page whose Reference Type is a character page type and whose subject (its `Subject` row,
   else its display name before " - ") equals the index's name. The unknown-race index directly under the root is
   **reserved**. Every other index is a category. Doubt becomes `needs_review` with a reason, never a silent choice:
   a singular from a rule (`singular_guess`); a category deeper than the race search reaches (`deep`); an empty index,
   which may be a character index without its Core page (`empty`); pages whose properties the tree has not read yet
   (`unread`); two categories with one name (`duplicate_name`); a category under the unknown-race index.
5. **Singulars.** The old bridge's list first (whole name; no review needed). Then rules, each marked for review: the
   list applied to the last word (`Forest Dwarves` → `Forest Dwarf`), `-ies` → `-y`, `-ss` kept, `-s` dropped, and a
   name not ending in `s` kept as it is. `-ves` → `-f` happens only through the list. A singular the owner saves, even
   the guess itself, is the owner's (`singular_source: owner`) and no longer needs review.
6. **Resolution: exactly one, or a typed refusal.** `resolve(project, query, { scope, kinds })` accepts an id (or
   `lk://resources/<id>`) always, within the scope and kinds asked for (`OUT_OF_SCOPE` otherwise); otherwise the name
   is matched exactly (case-insensitive) against raw names, display names, the tree's aliases and Canonical Display
   Names (A2's lookups). Stray leading `[INDEX]` / `[BSRC]` prefixes, in any case, are removed and repeats collapse; a
   prefix given also matches the raw name, and when it tells several matches apart (an index and its own Core page
   share a name) it is used. Several matches: `ambiguous` with every candidate's id, raw name, kind and path. None:
   `not_found` with up to ten near names, a hint for the message that is never used to decide. A tree that is not
   built refuses (`TREE_NOT_READY`) rather than answering "not found". Taxonomy aliases name races for placement only;
   they are not page names. The Markdown converter's `ctx.resolveMention` (B1) is this resolver.
7. **Ordering.** `[INDEX]`, then `[BSRC]`, then unclassified; alphabetical by display name with
   `Intl.Collator('en', { sensitivity: 'base', numeric: true })`. `placementFor` returns the one neighbour to pass as
   `after` or `before`: after the greatest sibling that sorts at or before the new page (by the rule, not by position;
   among equals, the latest), else before the least that sorts after it, else nothing (an empty parent). So a new page
   always lands next to its correct neighbour, even when other siblings are out of order. `excludeId` leaves out a page
   being moved or renamed. `outOfOrder` reports the fewest siblings that would have to move (those outside a longest
   ordered run), each with where it belongs; it never moves anything.
8. **Character placement is a pure plan.** `planCharacterPlacement` makes no write. The race search covers the type
   root's children and grandchildren (Group / Race), so a race directly under the root (Dwarves) works. A race matches
   a taxonomy entry by plural, singular or alias; an unknown or omitted race (null, blank, or one of the configured
   unknown values, any case) goes to the one unknown-race index directly under the root, with `Race / Species` set to
   `Unestablished`; a declared race is never rewritten. Refusals: a race that does not resolve (`RACE_NOT_FOUND`, with
   the labels available), one that matches several entries (`RACE_AMBIGUOUS`), one whose index left the tree
   (`RACE_SOURCE_MISSING`), **an entry still waiting for review** (`RACE_NEEDS_REVIEW`: a guessed singular must not
   place a page before the owner has checked it once), no or several unknown-race indexes, two indexes with the
   character's name under the race, two existing pages of one kind, and a missing template. An existing character
   index is reused; an existing Core or Compact page is returned rather than duplicated; a compact page always goes
   directly under the race. New page names come from the type's `pageNames` (default `{name}`), so C2 can follow the
   world's convention without a code change.
9. **Drift is reported, never fixed.** The tree service gained `onPassFinished` (called after a pass completes,
   errors logged and never failing the pass); the registry makes a report after each completed **daily check** of the
   project, and on the owner's request: an index under a type root with no entry and not a character index; an
   entry's index deleted, renamed or moved (against the parent recorded when the entry was made); an entry whose
   parent no longer matches the tree (the nearest ancestor that is an entry). Types whose taxonomy is not seeded are
   checked only for their root. The newest 60 reports per project are kept.
10. **Owner commands, audited; no MCP tool.** Every change goes through `actor: 'owner'` commands with an `audit_log`
    row naming the project (`registry.type_create`, `.type_update`, `.type_delete`, `.type_seed`,
    `.templates_refresh`, `.taxonomy_seed`, `.taxonomy_add_missing`, `.entry_update`, `.entry_delete`, `.drift_run`).
    Editing refuses a type root that is not an index, a parent loop, and an alias or singular another entry of the type
    already answers to (it would make races ambiguous).

## Consequences

- Phase C tools get one resolver, one ordering rule and one placement plan, each answering from the stored tree with
  no request, and each refusing in a typed, explainable way.
- Until the owner has reviewed the races whose singular was guessed (in the test world: groups such as Beastkin and
  races such as Foxians, Qishen and Saru), placement under them is refused with a pointer to the review queue. That is
  deliberate: it is a one-time check.
- A category more than two levels below the type root (a sub-subrace) is an entry, marked for review, but placement
  cannot use it as a race: section 9's search depth is kept as it was.
- The registry writes `tree_node_links` (`type`, `taxonomy`) only as a convenience for later sessions; its own rows hold the source node ids,
  so a node removed from the tree (which cascades its links) still shows as drift.
