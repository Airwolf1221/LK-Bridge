# ADR 0077: v3 F7d: a character's whole art set in one call and one proposal; the Art page's sidebar filled by the bridge; the identity copy audit

- Status: **Proposed** (v3 F7d, 24 November 2026). It builds A1 to A10 of the owner-approved design
  `LK-Bridge-F7d-one-call-art-design.md` (approved 24 November 2026; A8 to A10 from the owner's follow-up). Every
  decision is implemented and tested against the mock LegendKeeper and fixtures; nothing in this session touched a live
  system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). Where the design was silent the choice is
  marked **chosen**.
- Evidence the design cites (live, 24 November 2026): Iuno - Character Art, made by the bridge, with Canonical Display
  Name, Family / Surname, Personal / Given Name, Naming Culture, Aliases, Temporal Scope and Visual State / Period empty
  and no Dependencies or Related Sources, while her Core has the first five; Soraya bint al-Noor - Character Art,
  completed by hand, with those five copied exactly from her Core and her Core first in its Dependencies.
- Amends: [ADR 0070](0070-v3-f7-guided-character-art.md) decision 1 (one call, one target: the single-target form stays,
  beside `groups`); [ADR 0075](0075-v3-f7c-image-archives.md) Z4 (in a groups call an archive entry that cannot be used
  is one of the call's problems, not left out); [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md)'s item filter (an image binding that
  can leave its blocks out is a soft reference).
- No migration. Two settings (decision 1).

## Decision 1 (A1): `groups`, one form or the other, and the limits

`arkona_add_character_art { character, groups: [{ outfit?, newOutfit?, images }], artPage? }`. A group with no `outfit`
(or `null`) holds the design pieces; each image keeps its label, interpretation and source (`staged_id`, `upload_id` or
`archive: { id, entry }`). The single-target form (`outfit` plus `images`, with `file`, `scope`, `markdown`, `status`)
is unchanged; a call mixing the two is refused `ART_FORMS_MIXED` (**chosen**: `artPage` without `groups` too). New
settings (group "Art", `applies: 'now'`, in `src/config/registry.ts`): **`ART_CALL_MAX_IMAGES`** (default 120, 1 to
1,000) and **`ART_CALL_MAX_GROUPS`** (default 40, 1 to 200); past either, `ART_CALL_TOO_LARGE` before anything is read.
The schema's own caps are wide (1,000 groups, 1,000 images a group); the settings are the limit.

## Decision 2 (A2): planned once, together; every problem at once

`src/packs/art-groups.ts`. The character's folders are read live ONCE (F7's G9, `liveArtFolder`), the outfit record
once, the identity page once. Each outfit group is matched by F7's `decidePlacement` (exact or alias; `OUTFIT_NEAR_MATCH`
unless `newOutfit`; `OUTFIT_NAME_INVALID`); groups resolving to the same outfit (or several design groups) are **merged**,
in the order first given, with a note; each merged group is then placed by G2 counting the outfit's recorded pieces plus
ALL of this call's. Every problem of every group (a source, an empty group, an image in two groups, an archive entry that
cannot be used, a near match, a bad name, an unreadable identity page) is collected and the call refused whole:
`ART_GROUPS_REFUSED` with `problems` (the one problem's own code when there is one). Nothing is proposed. The Core rule
(F7.1/F7.2) is the package engine's own: when the call makes the Art page, a Compact Reference whose character gains an
index with several owners is upgraded in the same proposal.

## Decision 3 (A3): one proposal, approvable item by item

`src/packs/art-items.ts` (`itemizeArtGroups`). The items, in order: **"Art page"** (`art:page`, only when the call makes
it: the page, its facts and links, the index when one is made, the Core upgrade, the identity check), **"Design pieces"**
(`art:design`), and **one per outfit** (`art:outfit:<name>`: its folders, uploads, moves and outfit record). Every other
item depends on "Art page" when it exists, so approving an outfit without it is refused by the proposal's selection rule
with the reason ("untick them too, or tick what they need. Nothing was approved"). The Art page's one write, the sidebar
and the read-back are shared; the read-back's targets carry their group's item. **The item filter** (`filterSteps`): a
`bindAssetUrls` entry that can leave its blocks out (`drop`) is now a soft reference, so the page's item never needs the
images' items, and an image left out of the approval takes its binding and blocks with it (as a withdrawn image's). On a
new page the headings a group made (Wardrobe, the outfit's, Reference Images) go when none of their images is left
(`prune`, applied by the page filler). An unapproved group's staged images (and archive entries) are never taken: they
stay staged for a later call. The preview gives, per group, the folder decision, the asset names and the moves (`groups`).

## Decision 4 (A4): one job; a failed image never fails the rest

The order: the page and the upgrade (with, first, a check that the identity page's rows are still the ones copied); the
folders and the moves; the uploads (staged images, and held archive entries as in F7c: the job waits,
`waiting_staging`); ONE Art-page write (a new page's body; on an existing page the new `pack.art_groups` filler, which
places each group, by its block ids, as the F7 filler would, in the order the groups were given); the outfit records;
the sidebar; the read-back; then the report.

**Withdrawal** (`StepOptions.withdrawWith`, `withdrawAs`, engine): an image's steps carry its staged id. A step that
fails for certain (never an uncertain outcome: it may have written) is recorded as succeeded with `{ skipped,
withdrawn: { keys, reason, code } }` (LegendKeeper's code when it refused); every later step of that image (or of a move
whose folder could not be made) is withdrawn too; F7c's mechanism leaves its blocks off the page, its read-back targets
are skipped (`withdrawnWith` on asset targets), and the outfit record counts only the pieces placed and the moves made. A
rate wait is never a failure: the job parks (`waiting_budget`) and resumes where it stopped, nothing uploaded again
(F7c's Z5). **The report**: the last step (`bridge.record`, kind `art_groups`) works out from the job's own steps, per
group, what was placed and what was not (withdrawn with why; not approved, still staged), and the moves; it is the job's
`artGroups`, with `withdrawn`, in the job's answer and in `bridge_workstream_report` (`groups.artSets`, each image not
placed under "deliberately excluded" and "still to do").

## Decision 5 (A5): cost

The dry run's `cost`: the planning reads (the folders, the identity page, an existing Art page's sidebar), and the job's
reads (an estimate: each check, read-back target, read inside a lock), writes and uploads (exact, from its steps). The
governor paces the job as any other.

## Decision 6 (A6, A7): the guidance

The tool's description and the guide's art section lead with `groups` and say "Do a character's whole art set in one
call; don't wait for the Art page before adding outfits"; the standard path for a whole character is the archive one:
`upload_image_archive` with `character`, look at the images, one groups call naming `{ archive: { id, entry } }`, one
proposal for the owner (also in `upload_image_archive`'s description).

## Decision 7 (A8): the identity copies

The identity page (the character's Core or Compact Reference) is read LIVE when the call is planned (**chosen**, not
inside the job: the copies are then in the proposal the owner approves) and its rows are CHECKED inside the job: a new
Art page's job checks them in its own step before anything is written (they changed: the job stops, nothing written,
plan it again); an existing page's sidebar step checks them with its own rows (they changed: the sidebar is withdrawn
with why, the images stay placed, and the A10 audit catches the copies later). The fields: Subject, Canonical Display
Name, Family / Surname, Personal / Given Name, Naming Culture, Aliases, where the Art page's template has the row
(`identityCopyKeys`, from the pack's identity fields). Only empty rows are filled; a non-empty value that differs is
never overwritten: it is reported (`sidebar.differs`, warning `IDENTITY_COPY_DIFFERS`) and becomes an A10 finding. A new
page's copies are among its facts (its template's rows, C2b's chain, its read-back); an existing page's go through the
governed facts path (`planFacts`, `expandFacts`: the rows checked inside the lock, If-Match chained, journalled, read
back), run after the images (`late`) and withdrawable (`sidebar`).

## Decision 8 (A9): the agent's part

`artPage { scope?, temporalScope?, visualState?, dependencies?, related? }` (and a new page's `markdown`, `status`): used
when the page is made, applied to EMPTY rows when it exists (a non-empty row is left alone, `sidebar.leftAlone`).
Temporal Scope and Visual State / Period are never copied; when the agent gives none they stay empty and are listed under
"still to fill" (the preview's `sidebar.stillToFill` and a note). Dependencies always gain the identity page (added by
the bridge); anything else comes from `dependencies`; Related Sources only from `related`. Both resolve as `set_facts`
links do: a name that resolves to no page (or several) refuses the call.

## Decision 9 (A10): `owner_identity_copy_drift` (category `taxonomy`)

`src/audits/checks/identity-copies.ts`, from the snapshots. For each character index whose identity page (Reference
Type Character Core or Compact Character Reference, named for the index by its Subject, Canonical Display Name or page
name) holds identity values: every other page under the index (nested indexes walked; a relationship page left out)
whose copyable fields, only those its own sidebar has, are empty or differ, each field reported with both values. Never
Temporal Scope, Race / Species or Life State. Fix (`identity_copy`, `src/audits/fixes.ts`): both pages read live, each
row still as the audit saw it (else `FIX_STALE`), then ONE governed `set_facts` copying the identity page's values.
Automation (`src/automation/registry.ts`): `automatable: 'propose'`, **default Propose**, Apply allowed when the owner
switches it (the same job, every guard judging it). On the standard mock worlds it finds nothing (their Art template has
only Subject among the copies, and every Subject agrees); on a world with the real Art template it finds every Art page
made before F7d (the fixture: Iuno's).

## Decision 10: the sandbox step (opt-in)

`npm run test:sandbox` with `-- f7d-art-set` (`test/sandbox/f7d-art-set.ts`; on the server `sudo -u lkbridge
/opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7d-art-set`), on the test project: a throwaway Working
compact character, a zip of four tiny images (one loose, three in two folders), one groups call, the proposal approved
whole, then read back live: the Core upgrade, the folders, one Art page with three headings and four images, the sidebar
copies and the Core in its Dependencies; cleaned up. Runs on the mock in the ordinary suite
(`test/sandbox-mock/f7d-art-set.test.ts`).

## Consequences

- An agent sends a character's art set in one call; the owner approves one proposal, item by item.
- The single-target form keeps its exact behaviour (its pages' sidebars are not filled: A10 repairs them).
- Two new step options (`withdrawWith`, `withdrawAs`), one asset-target field (`withdrawnWith`), one filler
  (`pack.art_groups`), one record kind (`art_groups`), one fix kind (`identity_copy`), one audit code.
- Tests: `test/f7d/` (groups, items, job, sidebar, core-upgrade, identity-copy-drift) and
  `test/sandbox-mock/f7d-art-set.test.ts`.

## Amendment 1 (25 November 2026, the owner's review)

1. **The single-target form is a one-group call of the same planner** (`runArtSingle`, src/packs/art-groups.ts). It
   gains the Art page's sidebar (A8: the identity copies into empty rows, the identity page in Dependencies) and takes
   `artPage` (A9); `scope`, `markdown` and `status` may be given at the top level or in `artPage`, never both
   (`ART_PAGE_FIELD_TWICE`). Its behaviour and answers are otherwise as before: its sources (ChatGPT's `file`; an
   archive entry that cannot be used left out with why, never the others), its first refusal answered alone as its own
   error, its notes and `placement`, its one section on an existing Art page (the F7 filler), its job without the
   groups' withdrawal and report, its items (the package's own: the identity check is the Art page's item). The revert
   planner ignores the identity check (it explains no write).
2. **Proposal or job.** "ONE proposal whatever your scope" was wrong. The tool follows its switch in the pack (F3.4,
   ADR 0055 decision D; the seed's default "follow the scope"): at scope `propose` one proposal; at scope `write` a job,
   except that a new Authoritative Art page, or an Authoritative Compact Reference's upgrade to its Core, is a canonical
   proposal, and the owner's rails can make it a proposal (`proposedBecause`); so adding to an existing Art page at
   `write` is direct. The owner can set the tool to "always propose" on the Packs page. The tool's description and the
   guide say exactly this; "one proposal" in this ADR means the package when it is a proposal. `arkona_create_character`
   was right for its own switch (default "always propose"); its description now names the switch too.
