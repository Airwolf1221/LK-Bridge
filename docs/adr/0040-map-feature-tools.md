# ADR 0040: The map-feature tools, map images and pixel coordinates

Status: Accepted (v2 session D2, 12 November 2026). Implements the Maps row of PLAN-v2 section 5 and the "Maps" paragraph of
4.7 on C1's engine hooks (ADR 0031), C2a's internal steps (ADR 0032), C2b's `operation_id` and write jobs (ADR 0034), C2c's
document-lock and verify patterns (ADR 0035), the approval scope of ADR 0036 decision 5 and D1's checkers (ADR 0038), under
the owner's decision on canon (ADR 0036 decision 6, option (a)). **No migration** (see decision 14). No decision in PLAN.md or
PLAN-v2.md is changed; the choices below fill the gaps the plan and the brief leave open. Nothing in this session touched a
live system: every test runs against the mock LegendKeeper, and the sandbox test is written and dry-run against the mock, not
run against LegendKeeper.

## Context

The test world has no maps under AI REPOSITORY, so D2 could not read a real map; what is known about LegendKeeper's maps is
the generated registry (`src/lk/registry.defs.generated.ts`), the spec and the SDK's guide:

- Five operations (`listFeatures`, `createFeature`, `getFeature`, `updateFeature`, `deleteFeature`). **None is versioned**
  (`versioned: false`, `concurrency: "document"`): a feature has no `version` and takes no `If-Match`. CLAUDE.md's "never
  write a versioned entity without If-Match" is satisfied by there being nothing to send; the compare-and-swap PLAN-v2 10.6
  asks for has to be the bridge's own, a content check inside the lock.
- A feature has a type (`pin`, `label`, `region`, `path`, `folder`), `pos` `[lat, lng]`, `polygon`/`polygons`/`polyline`, `uri`,
  `parentId`, `rank` (a fractional index, "e.g. a0") and styles. **Deleting a folder does not delete the features in it**
  (their `parentId` still names the deleted folder). The list is not paged.
- A map's `MapImage` (on `getDocument`, `createDocument` and `updateDocument`; **not** on `listDocuments` or `getResource`)
  carries `width`, `height` and `bounds`, and the schema states the conversion between pixels and `[lat, lng]` exactly.
- A map's image is set with `updateDocument { mapImage: { assetId } }`, which "sets or replaces the image, as Add map and
  Replace map do"; features keep their `pos`; a `blank` document given an image becomes a map.

## Decisions

### The three tools

1. **`create_map_feature`, `update_map_feature`, `delete_map_feature`**, each ONE job (one proposal at scope `propose`), with
   `dryRun`, `operation_id`, `project`. The job is `bridge.expect` (decision 4), the write(s) with the body bound from that
   check (`bindBody`), and `bridge.verify`; it is journalled, never replayed. The tools build their steps with
   `src/maps/jobs.ts`, planned by `src/maps/plan.ts`; the opt-in sandbox test runs the same functions (its runtime has no
   repository tree to call the tools with), so it exercises exactly what a tool submits.
2. **The map** is identified by `page` plus `document` (a name or an id; optional when the page has exactly one map, refused
   with the list otherwise). A document that is not a map is refused with the tool to use: a page (`write_page`), a timeline,
   a board, and a **blank** document (`BLANK_DOCUMENT`: give it an image with `update_document` and it becomes a map; a first
   feature written to a blank document would also convert it, but with no image to place it on, so the tools refuse). The tree
   may lag (a blank document just given an image is a map), so only a type that can never become a map is refused from the
   tree; a blank one is judged by the live `getDocument`.

### Coordinates

3. **`latlng` or `pixel`, never both.** A pin or label takes `latlng` `[lat, lng]` or `pixel` `{ x, y }`; a region takes
   `points` (one polygon, 3 or more) or `polygons` (several, at most 100); a path takes `points` (2 or more); a folder none.
   Each point of `points` is `[lat, lng]` or `{ x, y }`, all one kind. Both kinds together, or a request giving more than one
   of `latlng`, `pixel`, `points`, `polygons`, is refused (`COORDINATES_BOTH`, `COORDINATES_CONFLICT`).
   - **Pixels** count from the image's TOP-LEFT corner (x right, y down) and are converted with the schema's formula,
     `pos = [north - y·(north - south)/height, west + x·(east - west)/width]`, written out in `src/maps/geometry.ts` apart from
     the SDK's `pixelToPos` (the tests check the two, the schema's text and the app's frame `[-y/2^z, x/2^z]`,
     `z = ceil(log2(max(w, h)/256))`, as a **property test at 10,000 runs over random sizes**, and again over random bounds).
     Results are rounded to nine decimals (far finer than a pixel at any zoom, and free of floating-point tails).
   - **The live image is read inside the job.** The plan reads the map to plan and to refuse early; the check inside the lock
     reads it again and converts with THAT frame. If the frame differs from the one the pixels were chosen on (the image was
     replaced between the plan and the lock, or between a proposal and its approval), the job is refused (`FRAME_CHANGED`) and
     nothing is sent: pixel `(x, y)` of one image is not pixel `(x, y)` of another.
   - **Pixels are refused** on a legacy tiled map (`url` null: no single image, so pixels mean nothing, even if a frame is
     reported) and on a map with no image, in both cases naming `latlng` (`PIXEL_NEEDS_IMAGE`).
   - **Bounds.** Pixels outside the image and lat/lng outside the frame's bounds are refused with the points listed
     (`OUT_OF_BOUNDS`) unless `allowOutside: true`. On a map with no bounds (legacy, no image) lat/lng has nothing to be
     outside of.

### Not versioned: the compare-and-swap is a content check

4. **`bridge.expect` of a new kind, `map`** (`src/jobs/internal-steps.ts`, `step-exec.ts`): inside the document's lock, before
   the write, the map is read again (`getDocument` for its type and image, `listFeatures`: two reads) and judged by a **map
   checker** the bridge registers by name (`engine.registerMapChecker`, `src/maps/checkers.ts`; the same shape as D1's document
   checkers). It runs the SAME planning functions on the map as it is now, with the plan's **resolved request** (ids, not
   names: the folder, the sibling, the link's `uri`, the frame, the feature's hash), and answers either differences (a
   conflict: nothing is sent) or the body to send. So the converted coordinates and the rank are decided from the map as it is
   at that moment, never from the plan. A request for a changed feature carries its `featureHash` (everything but
   `updatedAt`): any edit since the plan, by the app or another request, is `FEATURE_CHANGED`, conservative and predictable as
   `write_page`'s `baseVersion`. A cascade carries every feature's hash and the set it was planned on: a feature of it
   changed, or a new one under a folder being deleted, is `FEATURE_CHANGED` / `FOLDER_CHANGED` (the approval covers only what
   it listed, ADR 0036 decision 5). Also conflicts: the folder gone or no longer a folder, the sibling gone, the id taken, the
   document no longer a map.
5. **`bridge.verify` of a new kind, `mapChecked`**: reads the features back (`listFeatures`, one read) and checks each feature
   present with the fields written (numbers within a tolerance; a region's `polygon` and `polygons` compared as one list of
   polygons; `parentId` null as none; `uri` `''` as none) and between its neighbours, each deleted one gone. A difference is the
   usual "written but not as planned" with the journal entry, never a retry. A map image is verified the same way
   (`maps.image`: the document is a map and its `mapImage` is that asset).
6. **Proposals** hold the high-level operation and its expansion (steps with their `bindBody`); the approval's own capture of
   an `updateFeature` or `deleteFeature` target compares the feature as a snapshot, and the check inside the lock judges
   everything else, so each stale plan (an edited feature, a folder gone, a sibling gone, a replaced image, a feature added
   under a folder being deleted) ends the proposal `conflicted` with nothing written (tested, one case each).

### Order, folders and links

7. **Order.** The owner orders map features by hand, so the bridge never sorts. A new or moved feature goes at the END of its
   parent by default, or `after` / `before` a named sibling (a name or an id, among the features under the same parent;
   several of one name are refused with each candidate). The rank is computed inside the lock between the **real**
   neighbours with fractional indexing (`src/maps/rank.ts`: base-62, the algorithm of the `fractional-indexing` package, checked
   against its reference vectors and as a property over 1,000 random insertion sequences). "After X" passes X's rank-mates, as
   LegendKeeper places resources; a neighbour with no rank is passed over, one with a rank the scheme cannot read is refused
   (`RANK_UNUSABLE`). A move that leaves a feature exactly where it stands sends nothing.
8. **Folders** by name or id, with one lookup: several folders of one name are refused with the candidates and their paths
   (`FOLDER_AMBIGUOUS`); a feature that is no folder is `FOLDER_NOT_FOUND`. `update_map_feature` moves a feature or a whole
   folder into another folder (a folder moved into itself or beneath itself is `FOLDER_CYCLE`).
9. **Moving to the top level: `folder: null` sends `parentId: ""`, never `null`** (amended 12 November 2026 by the owner's
   probe, see "Notes: root moves" below). The first build sent `null`, because the spec's description says "(null = root)"
   while its type is a string only; LegendKeeper enforces the type and answered the owner's live check with a
   `VALIDATION_ERROR`. The bridge's own plan still says "no parent" as `null` (`UpdateRequest.parentId`), and
   `wireParent()` turns it into `""` only where a body is built. **One reading of a feature's parent**, `parentOf()` in
   `src/maps/features.ts`: a `parentId` that is absent, `""` or `null` is the top level, anything else is the folder's id.
   Planning, siblings, the checks inside the lock, verify (`holds`), `read_document`'s tree (`renderMap`), the cascade
   (`descendantsOf`), `findFeature`'s `featureFolder: null`, the tool's placement and the journal's summaries all use it.
   The generated registry is unchanged (the drift check compares it), and the bridge's own validation no longer lets
   `updateFeature`'s `parentId` be null (the earlier amendment is removed): a raw `lk_api_write` with null is refused
   locally, before it spends budget, as LegendKeeper would refuse it.
10. **Links.** `link` is a page by name or id, optionally a document of it (`{ page, document }`), turned into
    `lk://resources/<id>` or `lk://resources/<id>/docs/<documentId>`. Names resolve as write targets do (C2b): an ambiguous
    name is refused with each candidate and its role (`AMBIGUOUS`), nothing is guessed; the page must be inside the AI
    REPOSITORY. Then the page is read live (one read): it must exist and not be deleted (`LINK_TARGET_DELETED` for a page the
    app deleted since the tree last saw it), and so must the document (`LINK_DOCUMENT_NOT_FOUND`, `LINK_DOCUMENT_AMBIGUOUS`).
    A page just created in the app can take a few seconds to become linkable; LegendKeeper then refuses the link (nothing is
    written) and the tool description says so. **Clearing a link is explicit: `link: null`** (sends `uri: ''`); leaving `link`
    out leaves it alone.
11. **Styles** pass through `style`, checked against the schema's enums and formats (`iconShape`, `iconSize`, `fillStyle`,
    `borderStyle`, `strokeStyle`, `labelVisibility`, `labelSize`, `textEffect`, `#RRGGBB` colours, `visibilityRange` as a pair),
    and unknown fields are refused. A field sent to a type it does not apply to (an `iconColor` on a region, a `color` on a
    pin; the schema says LegendKeeper answers 400) is refused here with the types it applies to (`STYLE_NOT_FOR_TYPE`).
    `hidden` hides a feature. A feature's type is not changed by update (delete and add).

### Delete, cascade, canon, resume

12. **Delete.** `confirm: true`. Because LegendKeeper leaves a folder's features in place, a folder that holds features is
    refused (`HAS_FEATURES`, listing them) unless `cascade: true`, and a cascade deletes the features first, **deepest first**,
    then the folder, as one job: a stop part-way never leaves a feature pointing at a folder that is gone. The answer lists
    everything removed (`removed`, `removedCount`). **The journal keeps every removed feature in full**: each delete's own
    entry holds its feature (the engine's read before the delete), and the folder's entry also holds every feature that went
    with it (`preImage.with.removedWithIt`; `StepOptions.journalPreImageWith`, bridge code only), the same lesson as D1's lane
    delete, so each can be added again with `create_map_feature`. An update's journal pre-image is the feature as the plan read
    it, which the check inside the lock confirmed is exactly what was there.
13. **Canon: option (a) of ADR 0036 decision 6**, as the owner decided on 11 November 2026. Adding, changing or deleting a map
    feature on an Authoritative page is an ordinary edit, not canon-gated (tested: at scope `write` it goes straight through);
    only deleting the whole map document of an Authoritative page is canonical (C2c's `delete-document-authoritative` rule,
    unchanged: tested). The lifecycle and status-tag guards are unaffected.
14. **Resume, never replay, without a record table.** D1 and C2c keep a record row because a change touches several documents
    or pages and must be resumed against its own target list. A map change touches ONE document, a create or an update is ONE
    write (atomic: it was made or not, and the engine's recovery of a write that may have reached LegendKeeper finds out by the
    feature's minted id), and a cascade's target list is on the map itself (what is left under the folder). So: a job that
    stops part-way answers `WRITTEN_IN_PART` with what was written and what was not (and the journal entries), nothing is
    retried, and **asking again plans from the map as it is now and does only what is left** (a cascade stopped at its third
    delete: the same call deletes the remaining three; stopped at the folder itself: a plain delete of the now-empty folder).
    `operation_id` returns the earlier result for a repeat. Therefore no migration, no `maps_records` table. Rejected: the
    record table (more code and a state to keep consistent, for no case the map itself does not already hold).

### Map images and reading maps

15. **`update_document` sets a map's image.** C2b's `update_document` took `mapImage` as a raw `MapImageParams`: no name
    lookup, no blank documents, no warning. It now takes `mapImage` as an asset **id or name** (`{ assetId }` also works), found
    in the asset tree and read live (`getAsset`: it must be an `IMAGE` or `MAP` asset); a name that matches several assets is
    refused with each candidate and its folder (`ASSET_AMBIGUOUS`); a missing one is `ASSET_NOT_FOUND`. **A blank document
    becomes a map** when given one (a blank document with no `mapImage` is still refused, now with a message that says so; a
    page is refused as before). **A replacement with a different pixel size
    needs confirmation when features would shift** (owner decision, 12 November 2026; first built as a warning only). If the
    new image's pixel size differs from the old one's and the map has features with a position (pins, labels, regions, paths;
    folders hold none), `update_document` without `confirm: true` **refuses and writes nothing** (`CONFIRMATION_REQUIRED`):
    the answer gives how many features will sit over different pixels and the old and new dimensions. With `confirm: true`
    it goes ahead and the warning stays in the result (`FEATURES_OVER_DIFFERENT_PIXELS`, the same figures). The same size,
    or a map with no such features (or no image yet), needs no confirmation and carries no warning. **Under `propose` scope
    the tool captures the proposal instead of refusing**: its summary and page line show the count and the sizes ("replaces
    the image (2048×1024 → 4096×1024), 12 feature(s) will sit over different pixels; approving confirms it"), and **approving
    it counts as the confirmation** (the owner sees the count before approving). A dry run says whether confirmation is
    required. A legacy map replaced gets `LEGACY_MAP_REPLACED` (its pixels cannot be compared, so it asks for nothing).
    **Nothing is moved**: features keep their `pos` (the schema says so; sandbox M8 checks it) and the owner decides. The same asset again
    sends nothing. The image is verified (`maps.image`). Uploading a new image is D3's.
16. **`read_document` on a map** reads the document's settings too (one more read: a map costs 2) and adds the map's `width`,
    `height` and `bounds` to the header (`map` in the answer and an `Image:` line in the Markdown) and each feature's **pixel
    position** next to its `pos` (and a region's or path's points in pixels). Long point lists are summarised (a pixel box;
    "detail full lists every point") unless `detail: "full"`; up to six points are listed. A legacy tiled map and a map with
    no image say so and show lat/lng only. The JSON form is unchanged. `renderMap` without an image is byte for byte as before.

## Costs

Measured against the mock (`test/maps/*.test.ts`; typical, no links):

| Call                                             | Reads | Writes | Where the reads go                                                                 |
| ------------------------------------------------ | ----- | ------ | ---------------------------------------------------------------------------------- |
| `create_map_feature`                             | 5     | 1      | plan 2 (settings, features); check 2; verify 1                                     |
| `update_map_feature`                             | 5     | 1      | the same                                                                           |
| `delete_map_feature` (one feature)               | 6     | 1      | plan 2; check 2; the journal's pre-image 1; verify 1                               |
| `delete_map_feature`, cascade of 6               | 11    | 6      | plan 2; check 2; one pre-image read per feature (6); verify 1                      |
| `update_document` with `mapImage` (no image yet) | 7     | 1      | the settings, the asset, the journal's read, the verify (2) and the tree's re-read |
| `read_document` on a map                         | 2     | 0      | settings, features                                                                 |
| a dry run                                        | 2     | 0      | the plan's reads (+1 per link)                                                     |

A `link` costs one more read at plan (the page, live). The sandbox test makes about 160 reads and 35 writes on the mock
(which includes the mock tree's re-reads); against LegendKeeper it has no tree, so fewer reads.

## Consequences

- 53 → 56 bridge tools (58 on the server with the two proposal tools; 145 with the 89 per-operation tools).
- The engine gains the `map` expect check, the `mapChecked` verify target (with `withDocument`), `registerMapChecker` and
  `journalPreImageWith`; `lk_api_*` routes are unchanged (`deleteFeature`'s journal pre-image already existed, CR-2026-11).
- A map is read for 2 requests instead of 1.
- `write_page`'s pointer for a map now names the three tools.

## To verify on a real map (the owner's sandbox run, `deploy/sandbox-test.sh --project test -- maps`)

Each is a check in `test/sandbox/maps.ts` that prints PASS, FAIL or INCONCLUSIVE:

- **M1/M2** a generated 1500×700 PNG uploads and is reported at that size; a blank document given it becomes a map and
  `MapImage` reads back its width, height and bounds.
- **M3** the app's zoom formula `z = ceil(log2(max(w, h)/256))` gives the bounds LegendKeeper reports.
- **M4** a feature of every type, by pixel position, is stored where the formula says (to 1e-6), and a pin reads back as the
  same pixel.
- **M5** a link to a page and to one of its documents is stored as sent (a page created a moment ago may need a few seconds),
  and an empty `uri` clears it.
- **M6a** LegendKeeper stores the rank the bridge sent (and ranks sort as the bridge assumes); **M6b** an update moves a pin into
  a folder; **M6c** `parentId: ""` moves a pin out to the top level, also with a midpoint rank between two siblings
  (decision 9); **M6c-null** a raw `parentId: null` is refused by LegendKeeper, reported as **NOTED**, a fact about
  LegendKeeper and never a failure (INCONCLUSIVE if LegendKeeper has begun to accept it: the bridge sends `""` either way);
  **M6d** a region given several polygons has no stale `polygon` (INCONCLUSIVE if both are kept: which one the app draws is
  not known).
- **M7a** deleting a folder leaves its features in place; **M7b** a cascade removes a nested tree deepest first and the journal
  holds every removed feature in full.
- **M8** replacing the image with one of another size keeps every feature's `pos` and the frame follows the new size (the basis
  of the replacement warning).

## Notes: root moves (12 November 2026, the owner's live check)

`update_map_feature` with `folder: null` failed live with LegendKeeper `VALIDATION_ERROR` and nothing written (the journal's
`changes: ["rank","parentId"]` lists what was being changed, not what LegendKeeper objected to). The owner probed the real API
on the test world (map `b8zos6tn` on `sp0ko4hnx2eihcznb944ibp4`, the probe features since deleted):

| Probe                                                                                                         | Answer                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `updateFeature` with `parentId: null`                                                                         | 400, issue `parentId: "Expected string, received null"`. The schema's "(null = root)" is wrong; its `type: string` is what is enforced. |
| `updateFeature` with `parentId: ""` and a rank                                                                | Succeeds; the feature is at the top level and reads back with `parentId: ""`.                                                           |
| Into a folder (`parentId: <folder id>`, `rank: "a0"`), then out with `""` and `"a1V"` (between `a1` and `a2`) | Both succeed: the bridge's base-62 fractional ranks are accepted.                                                                       |
| A feature **created** at the top level                                                                        | Reads back with **no `parentId` field at all**. One **moved** there reads back with `""`. Both mean the top level.                      |

What changed (decision 9): a move to the top level sends `parentId: ""`; every reader treats absent, `""` and `null` as the
top level (`parentOf`, one function); the mock (`test/maps/world.ts`) reads a moved feature back with `parentId: ""`, leaves a
created one with no field and refuses `null` on `updateFeature` with the same 400 and issue, so the tests reproduce the real
API; sandbox M6c asserts `""` works and M6c-null records the refusal as a noted fact. A create at the top level still sends no
`parentId`. Only `updateFeature` was probed: `createFeature` was never sent a null (the bridge never does).

## Open for the owner

- (Decided 12 November 2026: an image replacement that would shift features needs `confirm: true`, decision 15.)
- The live checks on the test world are in the session summary (a test map, a pin by pixel linked to a page, a region by
  pixels, a folder with a label, moving the label out, a cascade delete and the journal). **Moving the label out with
  `folder: null` is to be redone after the fix** (12 November 2026: the first attempt failed on `null`, see "Notes: root moves").
