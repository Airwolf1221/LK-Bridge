# ADR 0027: The asset tree: a walk of the library, the same observation order as the repository tree, and placement as a pure plan

Status: Accepted (v2 session A4, 10 November 2026). Implements PLAN-v2 4.6 and the asset bullets of section 9 (with the
asset-folder facts of section 2). It reuses the rules of [ADR 0025](0025-repository-tree.md) for the asset side; read
that first. Numbers 0026 (A3) and 0028 (OPS2) belong to the sessions built in parallel; migration 0900 is this
session's.

## Context

Every place an image goes is a folder of the project's asset library, and LegendKeeper's `listAssets` returns **one
folder level at a time** (the phase 0 spike found 18 folders and 559 images on the test world, nested up to four
levels). The image pipeline (D3) must know which folder exists, which would have to be created, and whether a name is
taken by something else, without asking LegendKeeper for each. The old bridge's placement rules (PLAN-v2 section 9)
must carry over exactly. Four things can change the library at the same time, exactly as for the repository tree: the
first build, the bridge's own writes, a regular refresh and the nightly check, plus edits made in the LegendKeeper
app, which the bridge cannot see.

## Decision

1. **Storage per project** (migration 0900). `asset_folders` (id, name, parent, depth, cached path of ids and names)
   and `asset_items` (id, name, folder, type, url, width, height, size, SHA-256, hidden, created) for every asset that
   is not a folder. Both carry `project_id`; an asset and a child folder reference their folder by
   `(project_id, id)`, so a row can never name another project's folder (the database refuses it). The library's root
   is not a row: a folder of `null` is "directly in the root". Also: `asset_state`, tombstones, passes, the walk queue,
   the staged listing of a folder in progress, owed re-reads and the correction log, as for the repository tree. Rows
   are updated in place, never deleted and re-inserted for a refresh.
2. **Observation order, not wall-clock freshness** (ADR 0025 decision 2, unchanged). Each read is stamped just before it
   is sent with a strictly increasing stamp; each row keeps the stamp it reflects; a removal leaves a tombstone.
   **An observation never replaces one made later.** A folder's listing is stamped when its first page is requested, so
   a refresh never undoes a rename, a new image or a deletion that the bridge's own write made after that.
3. **The walk.** The model is built by listing every folder, breadth first, at P3 through the project's governor (the
   engine's `internalRead`; a long budget wait is waited out, a build also waits while its project is not served). A
   folder's pages are staged as they arrive and applied **together, in one transaction, when the folder's listing is
   complete**; folders found are queued for the walk in the same transaction. The queue, each folder's cursor and
   stamp, and the staged items are persisted, so a restart continues where it stopped (finished folders are not
   listed again; an interrupted folder continues from its cursor; a cursor that no longer works (400) restarts that
   folder with a new stamp). A pause of 250 ms follows each request: the walk is paced, never a burst.
4. **Absence from a listing is not proof of deletion** (ADR 0025 decision 6). A stored child that a completed folder
   listing does not show, and that nothing newer vouches for, is read with `getAsset`: a 404 removes it, an answer is
   applied (a move shows up as a different folder). A read that fails marks the row stale, never deletes it. A folder
   that reads as 404 is removed **with everything inside it**, because LegendKeeper documents that deleting a folder
   deletes everything inside it at any depth; a row inside it that was observed after the 404 is not removed (the
   folder is marked stale instead). A folder whose listing fails (other than for credentials or the plan, which fail
   the pass) is marked stale and the walk goes on.
5. **A build shows an estimate first, and the estimate is honest about what it cannot know.** Folders are found only
   by listing the folder above them, so the cost of the walk cannot be known before it is made. The build therefore
   **lists the root level only** (one request), then stops on `awaiting_confirmation` with: the folders and assets
   found there, a **minimum** (one request per folder found so far) and, for a rebuild, a **likely** figure from the
   previous inventory (one request per folder plus one per 100 assets), with the governor's wall-clock arithmetic at P3.
   Nothing more is read until the owner confirms. (The repository tree can list everything before it estimates
   because its expensive part is the per-page read that follows; here the listing is the whole cost.)
6. **Updates after the bridge's own asset writes** (ADR 0025 decision 4). `createAssetFolder`, `createImageAsset`,
   `updateAsset` and `deleteAsset` are followed by a `getAsset` in the same job, at its priority; the response's id
   names a create's target, an `updateAsset` (which answers with no body) is always read back, and a create with no id
   in the response lists the folder it was put in. A moved asset whose new folder the model has not seen has its folder
   chain read until a known folder. The owed re-read is written **before** the write is sent. A re-read that fails
   marks the row stale, is logged, and is retried (one minute, doubling to an hour); a crash between a write and its
   re-read is caught up at the next start. **Nothing is re-read before the first build has started**: the build will
   see it. During a build, writes are followed (they may be into folders already walked).
7. **Refresh and check.** `asset-refresh` (every 6 hours; background; recorded as a job only when it corrected something
   or failed) and `asset-check` (daily at 02:50 London time, after the repository tree's check at 02:30; always
   recorded) run the same walk. The check additionally audits the model (each folder's cached path against its parent
   links) and logs what it repaired. The regular refresh can be switched off per project (`assetRefreshEnabled`, on the
   Projects page or `npm run projects -- set`); the check always runs. A **manual** run (Maintenance Jobs "Run now" or
   **Refresh now**) goes ahead even when the switch is off: someone asked for it. (This differs from the repository
   tree's sweep, which skips when off even if asked; nothing else depends on it.) A scheduled run skips while the model
   is not built, or while another pass runs, and says why.
8. **Size and hash.** LegendKeeper's `Asset` has `width` and `height` but **no size**. `size` is kept as a column that
   stays empty (and is read if LegendKeeper adds a size field); the SHA-256 is **left empty for E1**. A recorded hash
   survives a refresh and is dropped only when the image's `url` changes (a different file); a size LegendKeeper does
   not state never overwrites one E1 recorded.
9. **Placement is a pure plan** (`planAssetDestination`), with the old bridge's rules exactly (PLAN-v2 section 9):
   reuse a folder named exactly after the character wherever it is if there is exactly one; otherwise
   `Characters / Group / Race / Character`, or `Characters / Race / Character` when the race sits directly under
   Characters, with the labels taken from the character page's ancestry in the repository tree (display names); an
   unknown race uses the literal folder `Undetermined / Unknown`; then the literal `subfolders`. The result lists the
   steps in order, each reused (with its folder id) or to be created. A non-folder asset where a folder is needed is
   `ASSET_NAME_CONFLICT`; more than one folder with the character's name (or with a path segment's name in one place)
   is `AMBIGUOUS_FOLDER`. Folders are never moved or renamed. It reads the stored models only: no request, no write.
   Interpretations the rules leave open, each visible to the caller:
   - **Matching ignores case** (Unicode NFC, like the repository tree's lookups): "inae mikumo" is "Inae Mikumo". The
     safe direction: a case-sensitive rule would create a second folder, while two folders that differ only by case are
     an ambiguity the owner sees. The plan says so in its notes.
   - **A Character Core page sits below the character's own `[INDEX]` page** (PLAN-v2 section 9): that index gives the
     character's name and is not a label. More than a group and a race (three or more levels) is refused
     (`ANCESTRY_TOO_DEEP`, "give a folderPath"), because the rules know no third level and a guess would file images
     in the wrong place.
   - **A name no page answers to, or a page directly under Characters, is an unknown race** with a note saying why;
     a **race that cannot be read because the repository tree is unusable is refused** (`REPOSITORY_TREE_NOT_READY`),
     never silently treated as unknown. A folder that exists needs no repository tree.
   - **No plan while the asset tree is `not_built` or `building`**: nothing could be told from a missing folder.
   - **Names are literal**: surrounding spaces are removed; empty, over-long (200), control-character and slash-path
     names are refused, except the literal `Undetermined / Unknown`.
   - **The asset root folder name** comes from the type registry when A3's data exists (a hook,
     `PlanDeps.assetRootFolderName`, not wired by this session); otherwise "Characters".
10. **Stays in its area.** No MCP tools, no uploads or image processing (D3), no writes to LegendKeeper. The migration,
    the `src/assets` folder, one maintenance file, one admin route file and one page; the shared files it touches
    (runtime, maintenance registry, admin plugin, project settings, the dashboard's navigation) take one small addition
    each.

## Consequences

- Most questions about the library cost no LegendKeeper request. Each asset write the bridge makes costs one extra read
  (in the same job). The test world's build is **22 requests** (19 first pages, 3 more for the folders with 262 and 150
  items), 0.07 % of the key's daily budget; a refresh or check is the same, about 110 requests a day.
- The model can be `stale` for a while after an outside edit (until the next refresh, at most six hours; the nightly
  check settles anything else) or a failed re-read. Every query states the status and when it was last confirmed.
- An outside move of an image to another folder is seen by that folder's listing (the row moves; no extra read). An
  outside deletion costs one confirming read in the next refresh; a deleted folder is confirmed by the folder alone.
- D3 can create exactly what a plan says, and E1 can fill the hash and size columns without a migration.
- A3's registry plugs into one hook; until then characters' images go to the folder "Characters".
