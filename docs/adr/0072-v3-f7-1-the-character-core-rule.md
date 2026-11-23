# ADR 0072: v3 F7.1: the Character Core rule in one place: a Compact Reference becomes the Core when its character gains an index with several owners (its wording and images too); the `character_core_missing` and `core_compact_wording` audits

- Status: **Proposed** (v3 F7.1, 23 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). Where the brief
  was silent the choice is marked **chosen**.
- The bug (the owner, 23 November 2026): `arkona_add_character_art` on a character with only a Compact Character
  Reference made `[INDEX] <Name>`, moved the Reference into it and made `<Name> - Character Art`, but left the Reference
  a Compact Reference: an index, two owners, no Character Core (Character Architecture: "a character with an index and
  several owners has a Character Core"). Live: Kamigawa Shirahime and Emine al-Noor (Emine's repair is
  `prop_bkgfpviunxb9`). The split had the same bug, fixed by CR-2026-11-R3 R3-66 (ADR 0061).
- The owner's addition (23 November 2026, after review): the upgrade also left the text calling the page compact
  ("Compact Main CANON reference for…", "this compact character reference embeds…", "This compact reference owns…") and
  kept image blocks the Art page also holds; both were hand-fixed on Emine al-Noor and Kamigawa Shirahime. Decision 3.
- **Why a new ADR, not an amendment of ADR 0070**: the rule is not about art. It changes every package planner (the
  package planner's extend mode, `arkona_create_owner`, the split) and adds an audit code and an automation flavour.
- Amends: [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (`upgradeToCore` is no longer only the
  agent's: decision 1); [ADR 0061](0061-cr-2026-11-r3-decisions.md) R3-66 (the split's counting is the shared helper's;
  its upgrade gains the text change, decision 3); [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) and
  [ADR 0070](0070-v3-f7-guided-character-art.md) decision 7 (a proposal-only code may allow a direct Apply, decision 5).
- No migration.

## Decision 1: one rule in the planner, not per tool

`src/packs/engine/core.ts` holds the rule; every planner asks it:

- **What counts**: an owner page is a page of the character's set: in the tree, a `[BSRC]` or `[BWRK]` page directly
  under the character's index (never an index, never an Archived page); in a package, a page whose role rule holds facts
  (every role but the index's, the registry's `facts: 'none'`) placed under the character's index. A relationship hosted
  under the other participant, and a Working draft placed flat under `[INDEX] Working`, are not this index's owners.
- **The rule** (`coreNeed`): the identity page is a Compact Character Reference, the character has an index after the
  change (one now, or one the change makes), and it has two or more owner pages then (the identity page, the others it
  keeps, the new ones).
- **The package planner** (`planPackage`, extend mode): when the rule holds, the existing upgrade (F3a's `upgradeToCore`)
  is applied automatically, in the same proposal, exactly as `upgradeToCore: true` does: renamed `<prefix><Name> -
Character Core`, Reference Type `Character Core`, the Core template recorded; id, documents, identity facts, links and
  text kept; the overlap warnings as before. An explicit `upgradeToCore: false` then is refused (`CORE_REQUIRED`), never
  silently honoured. When the upgrade cannot be made (`TEMPLATES_DIFFER`, a name problem, a template the pack cannot
  resolve), the WHOLE package is refused as `CORE_REQUIRED` with the cause (`cause`) and the fix: the index is never made
  with the Compact Reference left at its head.
- **The split** (`core.needed`, src/packs/split/plan.ts) counts with the same helper; its behaviour is unchanged (its
  tests pass unchanged, its measured reads and costs included: the planner is handed the source document the split
  already read).

**The callers**, each checked:

| Caller (planPackage extend mode, or a package that adds an owner page)                                    | Covered                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arkona_add_character_art`, a new Art page (`runArt`'s `if (!art)` branch)                                | yes, by the planner                                                                                                                                                                                                                                                                       |
| `arkona_add_character_art`, an existing Art page (`planArtExtension`)                                     | no new owner page, so no upgrade; when its character is already the broken shape it warns (`CORE_MISSING`, naming the repair), and the audit proposes it (decision 5)                                                                                                                     |
| `arkona_create_character` with `target` and `pages`                                                       | yes, by the planner (no `upgradeToCore` needed)                                                                                                                                                                                                                                           |
| `arkona_create_relationship` hosted under `a` (`runRelationship`)                                         | yes, by the planner                                                                                                                                                                                                                                                                       |
| a relationship hosted under the other participant (`host: "other"`)                                       | the other character's index must exist (`HOST_HAS_NO_INDEX`), so the package never makes it; a Compact Reference heading that index with no Core is refused `CORE_REQUIRED` (one package upgrades only its own target): upgrade it first, or host the relationship under `a` (**chosen**) |
| `arkona_create_owner` (`planOwner`, not planPackage) with a home in a character's index (a home override) | yes: `runOwner` asks the same rule and adds the character planner's upgrade to the package (`withCharacterCore`); an upgrade that cannot be made refuses `CORE_REQUIRED`                                                                                                                  |
| `arkona_split_owner` (`planSplit` → planPackage with `upgradeToCore`)                                     | yes, as R3-66; now through the shared helper                                                                                                                                                                                                                                              |
| `runPackage`'s other callers (the generic pack tool for data-only types)                                  | the generic hook has no upgrade (`upgrade: null`): the rule never applies                                                                                                                                                                                                                 |
| the audit's fix (decision 5)                                                                              | yes: the character planner itself                                                                                                                                                                                                                                                         |

## Decision 2: the preview and the proposal say so

The plan's notes (preview and proposal): "<Name> - Character Reference becomes <Name> - Character Core (the character now
has an index and several owners: N). Its id, documents, identity facts, links and text are kept…". The rename's summary
line adds "the character now has an index and several owners". The overlap warnings stay as today.

## Decision 3: the upgrade's text change (the owner's addition), in the shared upgrade

Planned on the pages read live (the Core's main document; the character's Art page when it exists; a new Art page of the
same package is changed in its plan) and applied by the `pack.core_text` filler inside the job's lock, on the page as it
is then, touching only the blocks the plan named (every `unsupported` block stays). The split's R3-66 path gets it too,
run after phase 1's verification (the split's checks compare the source's blocks with what it planned), on the blocks
that stay in the source.

1. **Wording**, deterministic, keeping capitals: "Compact Main CANON reference" (Main optional; CANON or AU) → "Main CANON
   Character Core"; "Compact Character Reference", "compact character reference", "compact reference" → "Character
   Core"; the page's old name "<Name> - Character Reference" → "<Name> - Character Core". On the Art page also
   "character reference" where the sentence means the identity page (**chosen** test: after "her", "his", "their",
   "its", "the" or "<Name>'s", and not followed by "images", "sheet", "art", "pages" or "folder": "her character
   reference owns…" → "her Character Core owns…"; "the character reference images" is left). Only text runs (never a
   mention, never across runs). Every replacement is in the preview (`existing[].replacements`), the proposal and the
   job's record. Any other sentence still containing "compact" is listed (`COMPACT_WORDING_LEFT`, and a note "For the
   owner (not edited)"), never edited.
2. **Images**: every top-level image block of the Core whose file (by URL path, as the asset reference index matches) the
   Art page also embeds is removed from the Core. An image the Art page lacks is first appended to the Art page under its
   images section ("Reference Images"; made before the boundary sections when missing) with a label (its alt text), the
   image and its following paragraphs up to the next image or heading as its interpretation, then removed from the
   Core: never dropped. The Art page's write runs before the Core's; the Core's item depends on the Art page's (a
   partial approval cannot drop an image), and the filler removes a block only while it still shows the planned file.
   No Art page (and none in the package): the images stay, and a note says so. A split whose new Art page the split
   writes itself keeps such an image on the Core (`CORE_IMAGE_KEPT`, **chosen**). Only image blocks leave the Core: the
   text left in a visual section whose images left goes into the overlap warnings (`UPGRADE_OVERLAP`) for the owner to
   trim.

The wording counts toward Last Major Revision as text (a few words: not major by itself).

## Decision 4: Revert

A package job that ran directly (a Working character at scope write; an Authoritative one is a canonical proposal, which
Revert never applies to, as before) is reverted by the generic Revert: the rename's target now carries the template the
job recorded (`set_template` records `previousTemplateId` since F7.1), so its revert puts back the name, the Reference
Type (the facts target) and the Compact template record; the text change is the page's text target, as any job's. The
split keeps R3-66's path (its deletion proposal puts the Compact Reference back).

## Decision 5: the audit check `character_core_missing` (category `taxonomy`), and its automation

- **Category `taxonomy`**: the character checks live there (`race_not_in_taxonomy`, `race_index_mismatch`).
- **Finds**: a character index (an index whose name is the character's) whose identity page is a Compact Character
  Reference (`[BSRC]` or `[BWRK]`) beside one or more other owner pages, by the shared rule.
- **The fix** (`core_upgrade`): the character tool's own planner (`arkona_create_character` with `target` and
  `upgradeToCore`, `src/packs/core-fix.ts`), so the upgrade, its wording and its images are decision 1 and 3's exactly;
  ONE proposal per character; the page read live first (renamed since: `FIX_STALE`, nothing proposed). An Authoritative
  page's rename is a canonical proposal, as always.
- **Automation** (F5b): default **Propose** (each finding its own proposal through the audit's "Propose a fix", as the
  art layout's codes); **Apply** is allowed only when the owner switches it (a new registry flag, `applyDirect`, on a
  proposal-only audit code): the same fix submitted as the Automation principal's job without being forced into a
  proposal, so every guard judges it as any write (the canon guard keeps an Authoritative page's rename a canonical
  proposal; recorded as proposed, "a guard made it a proposal"). As the other proposal-only codes, the default writes no
  paragraph to Repository Automation; the owner's own switch does.
- **On the live repository** it should find exactly Kamigawa Shirahime and Emine al-Noor, unless the owner has approved
  their repairs by then (Emine's `prop_bkgfpviunxb9`; Kamigawa's is still to be proposed).

## Decision 5b: the audit check `core_compact_wording` (category `taxonomy`), added after the owner's review

The owner's review of F7.1 (23 November 2026): a Core upgraded before F7.1 (or by hand) keeps the wording that calls it
compact, and decision 3 only changes the text of an upgrade it makes. So a second check beside `character_core_missing`:

- **Finds**: a Character Core (Reference Type Character Core, `[BSRC]` or `[BWRK]`) whose main document still says it is a
  compact reference by exactly the shared helper's deterministic rules (`reword`, role `core`), and the character's Art
  page (under its index, by name or Reference Type Character Art) where "character reference" means the identity page
  by the helper's own test (role `art`). One finding per character, only where a rule would replace something (**chosen**:
  a Core whose only "compact" sentence the rules do not cover gives no finding: nothing in it is the bridge's to fix).
  Every other sentence still saying "compact" on either page is listed in the finding (`left`), never edited.
- **Reads**: the snapshots only. The audit now keeps the blocks of every page named `… - Character Core` or
  `… - Character Art` (beside F7's character pages) and exposes a page's main document to the checks (`mainBlocks`).
- **The fix** (`core_wording`, src/audits/fixes.ts): each page read LIVE first (its name, its document); the replacements
  the rules make now must be exactly those the finding recorded (block and text), else `FIX_STALE` and nothing is
  proposed. Then ONE proposal per character: the Art page's write first, the Core's after, each filled inside the lock by
  the upgrade's own filler (`pack.core_text`: the rules applied to the named blocks only; block ids, every other block
  and every `unsupported` block kept), verified on read-back.
- **Automation**: default **Propose**, Apply allowed only when the owner switches it (`applyDirect`), exactly as
  `character_core_missing`: the same job submitted without being forced into a proposal, every guard judging it.

## Decision 6: guidance

`arkona_add_character_art`'s and `arkona_create_owner`'s descriptions and the guide's character section each gain one
sentence: a Compact Reference becomes the Character Core automatically when its character gains an index with several
owners. "How to decide" is unchanged (its 9,450 cap).

## Decision 7: the sandbox step (opt-in, the owner's)

`npm run test:sandbox -- f7-1-core` (`test/sandbox/f7-1-core.ts`; on the server
`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-1-core`), on the `test` project: a
throwaway Working compact character (its wording saying "compact reference"), one art piece added with
`arkona_add_character_art`, then the result read back live: the index, the Character Core (renamed, Reference Type
Character Core, its wording replaced) and the Art page; then everything it made deleted. It prints `F7.1 CORE …` lines.

## Consequences

- No character can be left with an index and several owners under a Compact Reference by any bridge tool; the two live
  characters are repaired by the audit's proposals.
- An upgrade costs one more read (the Core's document; and the Art page's when it exists) and, when the text changes,
  one or two more writes (the Core's document, the Art page's).
- Tests: `test/f7_1/core-upgrade.test.ts` (art, the other callers, the refusals, Revert, both audits and their automation
  default); the earlier upgrade tests updated where the Core's wording now changes (`test/packs/extend.test.ts`,
  `test/packs/pack-lmr.test.ts`); the split's tests unchanged.
