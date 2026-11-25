# ADR 0079: v3 F6b: navigation and subject indexes: [NAV] in the tree, the classification report, the index codes, the creation tools and T11's order

- Status: **Proposed** (v3 F6b, 25 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). The sandbox check
  (`f6b-nav`) is opt-in and the owner runs it. Where the brief was silent the choice is marked **chosen**.
- Design: `LK-Bridge-F6-taxonomy-design.md`, APPROVED with the owner's amendments T11, T12 and T14; this session is
  F6b. The design document is not in the repository; the brief's own wording was used.
- The problem: under Humans the indexes read "Bahram Kaviyan, High Humans, Miyubi Sakura": a race's navigation index
  sorted among character indexes, worse as characters gain indexes. The owner's guiding ruling: atomic, predictable
  structure wins over current names.
- Amends: [ADR 0025](0025-repository-tree.md) (a stored index role), PLAN-v2 4.5 and Source Formatting's sibling order
  ("INDEX pages first" becomes [NAV], then [INDEX], then sources, once approved), [ADR 0044](0044-v2-e2-audits.md) (two
  codes), [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) (two proposal-first codes with Apply allowed),
  [ADR 0065](0065-v3-f4c-fiction.md) (act indexes are [NAV]), [ADR 0076](0076-v3-f6a-reference-type-vocabulary.md) (a
  second draft section that never refuses approval).
- Migrations `4700_index_roles.sql` (`tree_nodes.index_role`), `4710_index_classification.sql`
  (`index_role_decisions`). Pack seed `arkona-2026-11-25-f6b` (supersedes `arkona-2026-11-24-f6a`). One new setting,
  `INDEX_CLASSIFY_BULK_MAX` (500), in `src/config/registry.ts`.

## Decision 1: a role on the same kind, not a new kind (the recommended approach)

`[NAV] <name>` keeps `kind: 'index'` and gains an **index role**, `nav` or `subject` (`[INDEX] <name>`), always derived
from the prefix. `classifyName` recognises `[NAV] ` and returns `{ kind: 'index', displayName, role: 'nav' }`; every
other result is exactly as before (no `role` key: an `[INDEX]` is `subject` by `roleOfClassified`/`indexRoleOf`), so the
existing suites stand untouched. The tree stores the role (`tree_nodes.index_role`, filled from names by migration 4700;
`TreeNode.indexRole`, `NodeScanRow.indexRole`); `CLASSIFICATION_VERSION` `kinds-3` re-classifies a tree stored before
(a `[NAV]` name held as unclassified) once, with no reads. A rename that keeps the prefix keeps the role.

Why not a new kind: `tree_nodes.kind` has a CHECK constraint, and about 130 sites test `kind === 'index'` to mean
"navigation, not a source" (retag exclusions, appraisal rules, lifecycle, audits, search, image destinations…). A role on
the same kind keeps every one of them correct by default.

**The sites that tell NAV from INDEX** (the audit of every `kind === 'index'` site; every other stays as it is):

| Site                                                                | Change                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/tree/classify.ts`, `store.ts`, `queries.ts`                    | `[NAV]` recognised; the role stored, read back, scanned                                                                              |
| `src/registry/ordering.ts`                                          | `compareSiblingsNav` (T11); `slotAmong`/`placementFor` take a new index's role                                                       |
| `src/runtime.ts` (the registry's sibling-order hook)                | T11's order for every parent once the APPROVED pack carries it (placement of creates, moves, renames, lifecycle moves; `outOfOrder`) |
| `src/narrative/names.ts` `narrativeCompare`                         | what the narrative number order does not place follows T11 (inside a story the number order still applies)                           |
| `src/resources/plan.ts` `SiblingSim`                                | siblings and new pages carry their raw name and role, so a new `[NAV]` lands first                                                   |
| `src/audits/checks/references.ts` (`out_of_order`) and the move fix | T11's order only when the approved pack has it; the fix's args say `order: 'nav'` and refuse as stale if it is no longer in force    |
| `src/audits/checks/index-taxonomy.ts`                               | new: `index_prefix`, `index_tags` (decision 4)                                                                                       |
| `src/packs/topic-brief.ts` (`arkona_brief`)                         | labels: `resolvedTo.kind` `nav` for a `[NAV]`, its subindexes marked `kind: 'nav'`, its own note ("only routes")                     |
| `src/mcp/tools/resources.ts` (`create_index`)                       | `role` (decision 5)                                                                                                                  |
| `src/packs/engine/owner.ts` (`arkona_create_owner`)                 | a nation subindex and a race's or racial group's navigation are `[NAV]`; a nation's index stays `[INDEX]`                            |
| `src/mcp/tools/narrative.ts` (`arkona_story_create`)                | the story `[INDEX]`, its acts `[NAV]`                                                                                                |
| `src/packs/indextax/classify.ts`                                    | the classification report (decision 2), continuity and act indexes `nav`, stories `subject`                                          |
| `src/appraisal/rules.ts` (`sibling_order`'s title)                  | says the approved order                                                                                                              |

Sites that only had to ACCEPT `[NAV]` as an index (no distinction): the registry's prefix clean-up and raw-name lookup
(`cleanPrefixes`, `resolve`), the lifecycle guard's and the narrative signals' loose prefix reading, the template
Reference Type reader (`audits/checks/taxonomy.ts`), `search`'s display names, the owner planner's display names, the
lifecycle tools' movers and the narrative story finder. Lookups of the lifecycle and root indexes were already by display
name and kind, so a `[NAV] Working` is still the Working index.

## Decision 2: the classification report (T12 step 1)

`arkona_index_classify` (pack tool, read-only, free; listed while the APPROVED version carries the rule) and the
dashboard's **Index Classification** page. For every current index: the proposed role (`nav`, `subject`, `undecided`),
the rule that decided it and its words, every rule that matched, the current prefix and tags, the status (`proposed`,
`undecided`, `approved`, `changed`, `left_undecided`, `out_of_scope`) and the owner's decision. Rules use only the
bridge's own data (src/packs/indextax/classify.ts):

- **the pack's exact-name lists** (`indexTaxonomy.structural`): the top-level branches (directly under the root), routing
  indexes by exact name (Arkona's Continents, Arkona's Realmships, Lost Realmships, Arkonan Cultures, Religions,
  Historical Events, Conflicts, Divine Realms, Divine Realm Cultures), Setting Framework's category indexes, Divine
  Realms' realm categories: `nav`;
- **category words with position**: `<Continent> <word>` under an ancestor index of exactly that name that is not a
  nation (**chosen**: the seven continent categories are the same words under every continent and Realmship, so the list
  holds the words, matched with the continent read from the position, as the owner tools' homes already do), `<world
prefix> <word>`; a nation subindex, a child of a nation index named `<word>` or `<Nation> <word>`: `nav`;
- **the registry**: a race or racial group (a taxonomy entry of a character type) and the unknown-race index: `nav`; a
  character index (under a character type's root, not an entry, holding the Character Core or Compact Character
  Reference of its own subject): `subject` (Character). **Chosen**: the registry's own `characterRole` takes any other
  index under the root as a character; the report asks for the identity page too, so an index named like a character
  with no Core is left undecided, never guessed;
- **the narrative layout**: a continuity index (Main CANON or an AU named under Continuities) and an act: `nav`; a story:
  `subject` (Story);
- **position**: a nation (directly in a `<Continent> Polities`): `subject` (Polity); a continent or Realmship (directly
  in the pack's continents or Realmship indexes), a named Divine Realm (directly in a realm category): `subject` (Place);
  a culture or religion family (directly in a `… Cultures` or `… Religions` index): `subject` (Culture, Religion).

No rule: `undecided`. Two rules that disagree: `undecided` with both named (`conflict`). Pages under Working, Archive,
the Legacy Canon Archive or the Design References (the pack's `outOfScope`, by an ancestor's name) are reported, never
proposed (the branch index itself is still classified). The lists are pack data; the owner edits them on the page
(**Structural names**), which makes a new pack version to approve.

**F6a.1 and F11's lessons**: the report's base (every verdict) is built from ONE light scan (`TreeQueries.nodeScan`, no
sidebars) in chunks that yield, cached on the tree's version, the rules' version and the registry's taxonomy; the rows
are rebuilt from it in memory under the decisions; paged (100 a page on the dashboard, up to 200 for the tool). Every
route awaits `prepare` first.

## Decision 3: the owner's decisions

Per row, dashboard only, the step-up, audited (`indexclassify.decide`): **Approve** (as proposed, the rule kept with the
decision), **Change** (to nav, or to subject with the subject's kind, optional: without one `index_tags` proposes
nothing for it), **Leave undecided**. Deciding again replaces the decision. An out-of-scope row cannot be decided
(`OUT_OF_SCOPE`); "Approve" on an undecided row is refused (`NOTHING_PROPOSED`). **Approve all as proposed** within a
filter: ONE request by ids (the page sends the proposed rows of its whole filter), ONE transaction, bounded by
`INDEX_CLASSIFY_BULK_MAX` (500; `BULK_TOO_LARGE` above it), idempotent (a decided row is skipped); audited
`indexclassify.bulk_approve`. Stored in `index_role_decisions` (migration 4710). A decision made on a different proposal
than today's is marked `drifted` on the page.

## Decision 4: the migration proposals (T12 step 2)

Two codes, category **taxonomy** (**chosen**: they carry out the taxonomy's classification, beside F6a's codes), only for
rows the owner approved or changed:

| Code           | Finding                                                                                    | Fix                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index_prefix` | the prefix disagrees with the approved role                                                | ONE `updateResource` of the name: the prefix only (`[INDEX] X` ↔ `[NAV] X`); the display name, id, parent, tags and links (by id) stay. Read live first (a changed name: `FIX_STALE`), checked in the lock, read back.                                                                                         |
| `index_tags`   | the tags differ from T11 (exactly Navigation; exactly the subject's category; never CANON) | Through the retag engine's own write path: its page check (`retag.page`: a renamed or moved page, or tags changed since, skipped and recorded), the write with its rebaser (`retag.tags`, judged again in the lock, never rebased onto a newer array), its read-back (`retag.verify`). Tags never date a page. |
| `out_of_order` | (existing)                                                                                 | T11's order once the approved pack has it (decision 6); the old rule until then.                                                                                                                                                                                                                               |

- Taking a status tag (CANON, AU) off an index is canon's: the `index_tags` job then carries a **canonical** lifecycle
  marker, so it is always the owner's canonical approval, at every scope and under the automation's Apply (the lifecycle
  guard refuses the removal otherwise; it is never bypassed). Other tag changes are ordinary proposals.
- `index_tags` reports only once the rule is in force: the approved version's section is the Tagging Standard's
  published one; while it is a draft the old rules stay in force. **Chosen**: under Narratives the narrative tools'
  grammar sets the tags (ADR 0065, E2: `Narrative, Story`…), so `index_tags` is not applied there (only the prefix is);
  otherwise the narrative audit and this code would undo each other. The owner may rule otherwise.
- Both are registered with F5b's automation: proposal-only with Apply allowed (`applyDirect`), **default Propose**, the
  caps as usual. Each finding is its own proposal **as one item** (`index_prefix` / `index_tags`) carrying its before
  and after with F7.1a's display (the name or the tag list, the changed words marked); the automation's caps make the
  batches (**chosen**: one proposal per page, as every proposal-only code's, rather than one many-page proposal, so the
  owner can take or leave each). With Apply, the same job is submitted and every guard judges it: an Authoritative page's
  rename is what the canon guard decides; nothing bypasses it.
- `out_of_order` is already at Apply on live Arkona: once the new rule is approved, renamed `[NAV]` pages are re-placed
  first among their siblings automatically, within the caps.

## Decision 5: the creation tools emit the right prefix

- `create_index` gains `role` (`nav` or `subject`): required on a project whose pack carries the rule (`ROLE_REQUIRED`
  otherwise, never guessed), `subject` by default elsewhere. `nav` makes `[NAV] <name>` from **"[NAV] AI Navigation"**,
  resolved by NAME in the project's template list; missing: `TEMPLATE_MISSING`, naming it, nothing made. `subject` makes
  `[INDEX] <name>` from the type's Index template, as before. A `[NAV]` needs no type.
- `arkona_create_character`: a character's index is `[INDEX]` (unchanged). It never makes a race's or racial group's
  index itself: `arkona_create_owner` (Species, `createCharacterNavigation`) does, now `[NAV]`.
- `arkona_create_owner`: a nation's index is `[INDEX]` (`promoteNation`); a national subindex (`createSubindex`) and a
  race's or racial group's navigation are `[NAV]`, from "[NAV] AI Navigation" (`TEMPLATE_MISSING` while it does not
  exist), wherever the pack carries the rule.
- `arkona_story_create`: the story `[INDEX]`, its acts `[NAV]` (once the APPROVED pack carries the rule). Neither uses a
  template, as before.
- New pages are placed by T11's order where it is in force.

## Decision 6: governance and the pack

Seed `arkona-2026-11-25-f6b` adds `indexTaxonomy`: the section (`tagging-standard`, "Navigation and Subject Index Tags"),
`status: 'draft'`, `ordering: 'nav-index-sources'`, the navigation tag (`Navigation`), the subjects' tags (Character,
Polity, Culture, Religion, Place, Story), the two templates by name, the structural lists and the out-of-scope areas; and
a ruling (`nav-and-subject-indexes`, 25 November 2026). The Tagging Standard's pins gain the section.

- While the section is missing and the rule a draft, its pin reads **unpublished** (as F6a's vocabulary): it never
  blocks approval, and the old tag rules stay in force.
- Once the owner's reviewer writes it, each governance check parses it exactly (one paragraph per kind, `<Kind>
index[ (…)]: <Tag>.`); a rule that differs from the version's is offered as a NEW version (`published`, the section as
  the authority; audited `pack.derive_index_tags`); an unreadable section refuses the approval
  (`GOVERNANCE_SECTION_UNPARSABLE`).
- **The ordering applies once a version carrying `indexTaxonomy` is APPROVED** (the brief's step 5): approving this seed
  turns T11's order on. The tag rule waits for the published section. A later seed keeps the owner's structural lists
  and a published tag rule.

### The governance texts (the owner's reviewer writes them after deploy)

The current text of Source Formatting's sections is not in the repository: the first two are given as the sentences to
put in place of what those sections say about index prefixes and sibling order.

1. **Source Formatting, "Page Names and Templates"** (add):

   > Index pages carry one of two prefixes. `[NAV] <name>` is a navigation index: it only groups or routes (a top-level
   > branch, a racial group or race, a continent's or Realmship's category index, a nation subindex, a continuity or
   > act index), and is made from the "[NAV] AI Navigation" template. `[INDEX] <name>` is a subject index: it is about
   > one subject (a character, a nation or polity, a continent, a Realmship, a named Divine Realm, a culture or religion
   > family, a story), and is made from the "[INDEX] AI Index" template. Sources carry `[BSRC]` (Authoritative),
   > `[BWRK]` (Working) or `[BARC]` (Archived).

2. **Source Formatting, the sibling-ordering rule** (replaces "INDEX pages first"):

   > In every parent, `[NAV]` indexes come first, then `[INDEX]` indexes, then sources, each group in alphabetical order
   > (case and accents ignored, numbers by value). Inside a story the narrative order applies: the Story Map first, then
   > acts and chapters by number.

3. **Controlled Native Tagging Standard, new section "Navigation and Subject Index Tags"** (the form the bridge reads;
   `indexTagSectionText`):

   > An index is one of two kinds. A navigation index, [NAV] <name>, only groups or routes: it carries exactly one tag,
   > the navigation tag. A subject index, [INDEX] <name>, is about one subject: it carries exactly that subject’s primary
   > category tag. Neither carries CANON, and neither carries a lifecycle, specialist or identity tag.
   >
   > Navigation index ([NAV]): Navigation.
   >
   > Character index: Character.
   >
   > Polity index (a nation or polity): Polity.
   >
   > Culture index (a culture family): Culture.
   >
   > Religion index (a religion family): Religion.
   >
   > Place index (a continent, a Realmship or a named Divine Realm): Place.
   >
   > Story index: Story.
   >
   > In every parent, [NAV] indexes come first, then [INDEX] indexes, then sources, each group in alphabetical order;
   > inside a story the narrative number order applies.

   One paragraph each. The owner then re-approves the pack (the section's pin moves from unpublished to approved, and the
   rule becomes `published`).

## Decision 7: guidance

The bridge guide's "How to decide" gains one which-tool row ("Make an index, or tell [NAV] from [INDEX]", 166
characters; the cap raised by exactly that, 9,613 → 9,779; the five rules unchanged), and a short section, "Navigation
and subject indexes" (under the Arkona sections). The creation tools' descriptions say which prefix they make.

## Consequences

- Until the owner approves the f6b version nothing changes but the report's availability; after it, T11's order is in
  force (and `out_of_order`, at Apply on live Arkona, re-places pages within its caps). Until the tag section is
  published and approved, no index is retagged.
- Nothing is renamed, moved or retagged without the owner's approval of the classification report (rows), and then of
  the proposals (or the owner's own switch to Apply).
- The narrative tags of story and act indexes stay the narrative grammar's (decision 4); the owner may rule to apply T11
  there too (a new pack version and a change to the narrative tag grammar).
