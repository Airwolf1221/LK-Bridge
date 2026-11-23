# ADR 0070: v3 F7: guided character art: one call, one target; the bridge places outfit art; the outfit record; the art layout audit; the verifier's default titles; the image URL check

- Status: **Proposed** (v3 F7, 23 November 2026). It builds G1 to G11 of the owner-approved design
  `LK-Bridge-F7-guided-art-design.md` (approved 23 November 2026). Every decision is implemented and tested against the
  mock LegendKeeper and fixtures; nothing in this session touched a live system (no LegendKeeper, no bridge connector, no
  dashboard, no Drive, no sandbox run). Where the design was silent the choice is marked **chosen**.
- Evidence the design cites: jobs `jkrmpgt21y38x5dp` (1 image, 2 differences), `j5udx2rpurxqcj9k` (11 images, 22
  differences) and `j3u162l831nskgsl` (23 November 2026: a `write_page` adding one image block, `[41].isTitleHidden
expected (absent) actual true`, `[41].title expected (absent) actual "Image"`); the cached asset tree "confirmed 3 h
  ago" still showing folders the owner had already changed; the live layouts of Soraya bint al-Noor and Mehrana
  al-Khalid after the owner's cleanup (the test fixtures, `test/f7/fixtures.ts`).
- Amends: [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (the art step: `subfolder` and the pack's
  `assets.subfolders` are gone, decision 1); [ADR 0031](0031-write-page.md)'s ignored fields (decision 8);
  [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) decision 1 (a code may default to Propose; a proposal-only
  class, decision 7); [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 9 (G6: the
  planner refuses a Forms, Outfits or Details folder, decision 5).
- Migration: `4350_art_outfits.sql` (the outfit record, its aliases and pieces, and the owner's seedings). Numbered
  after F5c's `4300` so the two can merge in either order.
- Numbered 0070: F5c, in parallel, took 0069.

## Decision 1 (G1): one call, one target

`arkona_add_character_art { character, outfit?, newOutfit?, images[], file? }`. `outfit` applies to every image of the
call: absent or null, the images are **design pieces**, always in the character's own folder; a name, they are pieces
of that outfit, placed by decision 2. Each image keeps its own `label` (`{Visual Role} - {Descriptor}`) and its required
`interpretation`; up to 30 images a call. `subfolder` is gone from the tool, from `arkona_create_character`'s art page,
from the pack's `assets` (`subfolders`) and from the guides; a stored pack version that still carries `subfolders` is read
with it dropped (the schema's preprocess), so the owner's approved Arkona version keeps loading. A call that still passes
`subfolder` is refused by the schema (`Unrecognized key`).

**Several files from ChatGPT in one call: no.** The bridge's ChatGPT route is `_meta["openai/fileParams"]: ["file"]`
(ADR 0049 decision 11): ChatGPT replaces an attachment passed in a listed top-level field with ONE file object
(`download_url`, `file_id`, `mime_type?`, `file_name?`); `src/mcp/server.ts` passes `_meta` through as given, and
`upload_image` and this tool each declare a single `file` object. Nothing in the bridge's MCP layer or in the contract
ADR 0049 recorded makes ChatGPT fill an array of files in one field, so the tool does not offer a `files` array (one
declared field per extra attachment, `file2`…, would be a guess the owner has not asked for). **The route is: the agent
stages each image (`upload_image { stage: true }`, no destination: nothing is proposed), then makes ONE
`arkona_add_character_art` call naming every `staged_id`.** The single `file` stays, for one image with no other
source. Whether ChatGPT now fills an array is for the owner to check in ChatGPT itself; it is not asserted here.

## Decision 2 (G2, G9): the bridge decides placement, from a live read

Before deciding anything, the character's folders are read **live** (`AssetService.refreshFolder`: the character's
folder and three levels below, one `listAssets` a folder; an item the tree held that the listing no longer shows is
confirmed by `getAsset`, a 404 removing it). When the tree does not hold the character's folder, its parent is read live
first (the folder may have been made since). A failed live read refuses the call (`ART_FOLDERS_UNREADABLE`): nothing is
decided from the cache.

For an outfit (src/art/placement.ts), the outfit is matched (decision 3) among the character's **record** and the
outfits the seeding rules read from its folders (decision 4) that no record names (so an unseeded character's
`Wardrobe/Jade Moon Kimono` is that outfit, never a new one). Its pieces now are its folder's items, else the loose
Wardrobe pieces the record names or whose names say so; a recorded piece no longer there is not counted (live wins).
**Total = pieces now + arriving**:

- the outfit has its folder: the pieces go there;
- total 1: loose in `Wardrobe`;
- total 2 or more: in `Wardrobe/<Outfit>`, made when missing (found inside the job when another job made it, as every
  folder is, ADR 0049 decision 9), and **the loose piece is moved into it in the same job** (`updateAsset`, after the
  uploads, before the Art page's text).

`Wardrobe` is made on first use. No other folder is ever made: the subfolder chain is the bridge's (`[]`, `['Wardrobe']`
or `['Wardrobe', <Outfit>]`), and an outfit can never be named Wardrobe, Forms, Outfits or Details, hold "/" or " - "
(`OUTFIT_NAME_INVALID`). Inside the job, before any write, the pieces to move are read live again (`pack.art_layout`):
gone or moved meanwhile, the job stops with `ART_LAYOUT_CHANGED`, nothing written. **Chosen:** two calls planned before
either runs each see the outfit's total as 1 and each put a piece loose; the art layout audit then proposes the folder
(decision 6), rather than the job re-planning placement in the lock.

The proposal is the owner's as before (the art tool always proposes); the job's direct effects are the upload's own:
folders found or made, the images uploaded, the loose piece moved, the record written.

## Decision 3 (G3): the outfit record and the near-match test

`art_outfits` (per project and character folder, by its id: a rename keeps it): name, aliases, pieces (asset ids), folder
(null while loose). Written by the art job (`bridge.record`, kind `art_outfit`: the asset ids the job's own
`createImageAsset` steps returned, `JobEngine.stepValue`, plus the moved piece), by the owner's seeding (decision 4) and
the owner's aliases (dashboard).

**Matching**: names and aliases compared with case and spacing normalised (NFC, lower case, white space collapsed).

**Near match** (`OUTFIT_NEAR_MATCH`, listing the candidates; `newOutfit: true` overrides). **Chosen** test, on words
(lower case; apostrophes dropped; anything not a letter or digit separates words): two names are near when

1. one's words appear in order and together inside the other's ("Imperial Regalia" inside "Supreme Imperial Regalia";
   "Kimono" inside "Jade Moon Kimono");
2. they are equal once punctuation is dropped ("Lu'lu'at al-Qamar", "Luluat al Qamar");
3. their joined words differ by at most max(1, ⌊shorter length / 6⌋) edits (Damerau-Levenshtein): a typo ("Moonflower
   Yukata", "Moonflower Yukta"; "Wedding Dress", "Wedding Dresses");
4. they share at least two words and at least half their distinct words (Jaccard ≥ 0.5): "Sapphire Rose Gown",
   "Sapphire Rose Dress".

One shared word alone is never near ("Maid Uniform", "Al-Ghalian Uniform"; "Jade Moon Kimono", "Autumn Blossom Kimono";
"Wedding Dress", "Wedding Gown"). The real outfits of Soraya and Mehrana are pairwise not near. Tested in
`test/f7/outfits.test.ts`.

## Decision 4 (G3): seeding, for the owner's review

An owner action on the dashboard's Asset Tree page ("Outfits", `POST /api/admin/art/outfits/seed`, audited `art.seed`):
the character's folder (by name, one folder of that name, or its id) read **live** at P0, then:

- a `Wardrobe/<X>` folder is outfit X, with its pieces;
- a loose Wardrobe piece named `<Character> - <Outfit>[ - <Descriptor>]` is that outfit with one piece;
- **listed, never guessed**: a name not starting with the character's full name; nothing after it; an outfit part that
  reads as a Visual Role ("Outfit Reference"); a loose piece of an outfit that also has its folder; a folder inside an
  outfit folder; a Forms, Outfits or Details folder still holding assets.

The result waits (`pending`); **Save** (with the step-up, audited `art.seed_save`) records it (an outfit of the same name
keeps its aliases; its pieces and folder become what was read); **Discard** drops it. Aliases are added and removed on
the same panel (audited). On the fixtures: Soraya, six outfits (five loose, Jade Moon Kimono with eight); Mehrana, nine
(the four labelless loose pieces are single-piece outfits); nothing ambiguous on either.

## Decision 5 (G4, G6): names, and no legacy folder

`<Character> - <Label>` for a design piece; `<Character> - <Outfit> - <Label>` for an outfit piece; the character's full
canonical name (its index's name); numbered ` (2)` when taken in the target folder (the loose piece moved into a new
folder counts); never a file extension. An existing loose `<Character> - <Outfit>` is valid (no rename proposed).

**G6**: nothing an agent passes makes a Forms, Outfits or Details folder: the art tool cannot name a folder; the asset
planner refuses any plan that would create one (`LEGACY_ART_FOLDER`: `upload_image`'s `subfolders` and `folder` path
included); `lk_api_write` and `lk_api_batch` refuse a `createAssetFolder` of those names.

## Decision 6 (G5): the Art page

Design pieces under "Reference Images", as before. Outfit pieces (the Art page filler, inside the job's lock, on the page
as it is then): under an existing heading anywhere on the page naming the outfit or an alias (Soraya's nest under
"Approved Rangawan Wardrobe"), at the end of its section, the labels one level below; else a new heading naming the
outfit at the end of the page's first heading holding "Wardrobe"; else a new "Wardrobe" section (level 2) before the
boundary sections, the outfit's heading at 3 and the labels at 4. A new Art page made for outfit pieces gets the same
"Wardrobe" section.

**Lines naming a moved piece** (amended after review, 23 November 2026). When the job moves loose pieces, **every page
under the character's repository index** (the index too; page documents and documents the tree last saw blank) is read
live when the call is planned, and each line naming a moved piece **by asset id or asset name** is listed for the owner
(`linesForOwner`: in the preview, the proposal's notes and the job's record step result): **never edited**, because it
may state the piece's location. The art job removes no folder, so no line it could find names a folder path that has
stopped existing; such lines (left by earlier changes, such as the retired Forms, Outfits and Details) are the art layout
audit's (decision 7), which updates one only where it matches exactly. Prose naming the outfit is never touched.

## Decision 7 (G7): the art layout audit (category `assets`, read-only)

`src/audits/checks/art-layout.ts`, per character folder (a folder under the library's top-level Characters folder
holding a Wardrobe, Forms, Outfits or Details folder, or an asset named after it):

| Code                             | Finding                                                                                                                                                                                                                                     | Fix (one proposal; targets read live first)                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `art_outfit_folder_single`       | an outfit folder with one piece                                                                                                                                                                                                             | move the piece into Wardrobe; delete the folder (only if empty then)                                                                                                                                         |
| `art_loose_outfit_pieces`        | two or more loose pieces of one outfit (record, else names)                                                                                                                                                                                 | make (or find) Wardrobe/<Outfit>; move them in                                                                                                                                                               |
| `art_legacy_folder_empty`        | an empty Forms, Outfits or Details folder                                                                                                                                                                                                   | delete it, its empty folders first (each only if empty then)                                                                                                                                                 |
| `art_legacy_folder_holds_assets` | such a folder that still holds assets                                                                                                                                                                                                       | none: listed for the owner                                                                                                                                                                                   |
| `art_asset_name`                 | a name breaking G4                                                                                                                                                                                                                          | the rename, when certain (extension dropped; an outfit folder's piece given its outfit); else listed                                                                                                         |
| `art_stale_folder_ref`           | a line on ANY of the character's pages (every page under its repository index) naming a folder path under the character's folder that no longer exists, or the id of a folder that is no longer the character's (deleted, or now elsewhere) | a path: the line updated where it matches exactly and the folder's new place is certain (one folder of that name under the character now); an id: listed, with the folder's current name and place suggested |

The audit reads the asset tree and the snapshots, never LegendKeeper: the blocks of every page under each character's
repository index (an index named as a character folder of the asset library) are kept for it, so a stale reference on any
of the character's pages is found (the motivating case: Mehrana's Wardrobe page, "Asset Location and Provenance");
each fix re-reads its targets live (G9) and refuses as `FIX_STALE` when they changed. A line's update is a `replaceBlock`
at the document version read live (a later edit makes the job stop, never overwrite). Every move, rename and delete the
bridge makes on its own initiative is a proposal.

**F5b**: the five codes with a fix are **proposal-only** (`automatable: 'propose'`, a new class in
`src/automation/registry.ts`): Off or Propose, never Apply (`setMode` refuses `PROPOSE_ONLY`); **default Propose**
(`defaultMode`, used while the owner has set nothing). A run proposes each open finding with a fix as its OWN proposal
through the audit's "Propose a fix", as the Automation principal, once (a finding an earlier run proposed is not proposed
again). **Chosen:** the default does not write a paragraph to Repository Automation (only the owner's own switch does, as
F5b's other codes): every one of these fixes waits for the owner's approval, so nothing runs that the governance would
have to authorise; the owner switching a code explicitly still records it there. The dashboard's Automation page offers
these codes Off and Propose only. `art_asset_name` and the appraisal's `asset_extension` overlap on a file extension: two
proposals can name the same asset; approving one makes the other's job stop (the name changed).

## Decision 8 (G10): the verifier and default block titles

`src/jobs/verify-blocks.ts`, inside `dropMintedIds`: for a titled kind, a `title` or `isTitleHidden` the planned block
does not carry is dropped from the stored block **only when it equals that kind's recorded default**
(`TITLED_BLOCK_DEFAULTS`; confirmed: `image: { title: "Image", isTitleHidden: true }`). A value the plan sent is always
compared; a stored value other than the default always counts; a kind not in the table always counts. **Chosen:** per
field rather than "only when the plan carries neither", so `title: "Caption"` sent and stored verifies although
LegendKeeper also stores its default `isTitleHidden` (the design's own case). Listed in `VERIFY_IGNORED_FIELDS` and the
module comment. The other kinds are added once the sandbox probe (decision 10) prints them.

**The warning** (write_page, and every job's answer through `describeJob`): the read-back now carries `cause`.
`concurrent_edit` when a difference lies in a top-level block the plan did not write (sent exactly as the page held it
before, by id, or a stored block beyond those sent) or the version read back is not the one the write returned: "something
else may have edited the page at the same moment". Otherwise `stored_differently`: what differs (the first difference,
sent and stored) and "LegendKeeper may have changed it on save". Both keep the "written but not as planned:" prefix.

**The art jobs** (`upload_image`'s placement and `arkona_add_character_art`) verify their page writes with the same
`compareStoredBlocks` (`verifyAfterWrite`), so the default-title rule covers them; their assets are verified by
`getAsset` targets (folder, name, hidden), the moved pieces included.

## Decision 9 (G11): the image URL check

`FromMarkdownContext.isProjectAsset` is now passed by `write_page`, the narrative tools (`arkona_chapter_save`, the
chapter tools' appends) and the pack planners (`arkona_create_character`, `arkona_create_owner` and the others through
`planPackage` and `planOwner`): a new image's URL must be exactly the `url` of an image asset of the project in the asset
tree (`AssetQueries.assetByUrl`; both forms, `https://assets.legendkeeper.com/<uuid>.webp` and
`…/<projectId-like prefix>_<uuid>.webp`). URLs the page already holds are not checked.

**An asset's id cannot be derived from its URL** (amended after review; live evidence, 23 November 2026: asset
`pr796386prg9780dhbcvhyyd` has url `…/64b8054d-5986-4027-bfb2-8acc55c23035.webp`, asset `rzgwr8y9yan0dxmmzbnjttv6` has
`…/cmretrj150aph43prgyxsdbsn_5aa52e7d-b052-48b2-a5f6-566a113b391f.webp`). So on a miss
(`AssetService.checkUrls`) the re-reads owed after the bridge's own writes are made, then **the project's whole asset
listing is read live once** (`listAssets` on every folder, every page, at P1; an item gone since confirmed with
`getAsset`), **at most once every five minutes per project** (`URL_REFRESH_MS`, in memory). Still missing:
`IMAGE_URL_REFUSED`, saying the listing was read just now. Within the five minutes a miss is refused at once, nothing
read, the message saying when the listing was read and to retry after it (the five minutes from then). While the asset
tree has never been built there is no check (the old `IMAGE_URL_UNCHECKED` warning stays). The mock's asset URLs now
carry a uuid unrelated to the asset's id, so no test can pass by the old guess. **Cost:** one listing request per folder
of the library (a few hundred on a large project), at most every five minutes, and only when an image URL is not known.

## Decision 10: the asset tree after the bridge's own writes, and `browse_asset_tree { refresh: true }` (G9)

The cache is already updated after every bridge asset write (ADR 0027's write observer re-reads `createAssetFolder`,
`createImageAsset`, `updateAsset` and `deleteAsset`: upload, move, rename, delete, folder create or delete); the art
job's move is one of those, tested. `browse_asset_tree` gains `refresh: true` (needs `folder`): that folder and the levels
shown are read live first, the answer saying so (`refreshed`).

## Decision 11: the sandbox step (opt-in)

`npm run test:sandbox` with `-- f7-art` (`test/sandbox/f7-art.ts`; on the server
`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-art`), on the test project: B1 one outfit
piece uploaded into a throwaway character folder's Wardrobe, read live, and the bridge's placement for a second piece;
B2 the second piece into `Wardrobe / Probe Outfit` and the first moved in, read back live, the asset tree following;
B3 the G10 probe, one block of each titled kind written without its title fields, what LegendKeeper stored printed as
`F7 PROBE <kind>: title=… isTitleHidden=…`. It drives the asset steps the art job uses through the bridge's engine (not
the pack tool, which needs an approved pack and a character); the tool's placement and job are covered against the
mock. Runs on the mock in the ordinary suite (`test/sandbox-mock/f7-art.test.ts`).

## Decision 12 (G8): governance

LegendKeeper is not edited. The replacement paragraph for Source Formatting's "Character Art and Assets" is in the
session's report, for the owner to apply after deploy.

## Consequences

- Agents name an outfit, never a folder; one call per target; the bridge reads the folders live first (one listing per
  folder: usually 2 to 5 reads more per call).
- A second piece of a loose outfit costs one more write (the move) and the record step (no LegendKeeper request).
- The nightly automation run proposes art layout fixes by default; the owner switches a code Off on the Automation page.
- The verifier stops reporting LegendKeeper's default image title; the other titled kinds still report until the probe's
  values are pasted in.
- Tests: `test/f7/` (verify-defaults, image-urls, outfits, art-placement, art-page, art-layout) and
  `test/sandbox-mock/f7-art.test.ts`; the earlier art tests updated to one call, one target.
