# The asset tree (v2 A4)

The bridge's own model of each project's **asset library** (PLAN-v2 4.6): its folders, and the images, maps and audio
in them. LegendKeeper lists one folder level at a time, so the bridge walks every folder. Later v2 tools (the Discover
tools, the image pipeline) answer from it, so most questions about the library cost no LegendKeeper request. It also
decides **where a character's images go**: the old bridge's placement rules, as a pure planning function.

Design and concurrency rules: [ADR 0027](adr/0027-asset-tree.md). Source: `src/assets/`. Migration:
`0900_asset_tree.sql`. Tests: `test/assets/`, `test/ui/assets.test.tsx`. It is the asset-side twin of the
[repository tree](tree.md) and follows the same rules.

## Setting it up on the server

There is nothing to configure: the asset library has no root to choose.

1. **Start the first build.** On the dashboard's **Asset Tree** page, with the project chosen in the sidebar, press
   **Start the first build…**, then **List the root level**. The bridge makes one request (the library's root level)
   and stops to show the estimate: the folders and assets it found there, and what the walk will cost.
2. **Read the estimate, then press Start walking the folders.** Folders are only found by listing the folder above
   them, so the total cannot be known in advance. The walk makes **one request per folder**, plus one for every
   further 100 items in a folder. What the page shows is a minimum (one request per folder found so far); a rebuild
   also shows a better figure from the last inventory. **Cancel** stops it (what was read is kept).
3. **Check the result.** When it finishes the status is **Ready**: folder and asset counts, the deepest folder, and a
   browsable folder tree. The finished build is also on the **Jobs** page.

A restart during the build continues where it stopped (finished folders are not listed again; an interrupted folder
continues from its stored cursor). The regular refresh and the nightly check start by themselves once the tree is built
(Maintenance Jobs page).

## What each row holds

| Table / field                                                          | From                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Folder**: id, name, parent, depth, path                              | A `FOLDER` asset. The path (ids and names, cached) is recomputed whenever a folder is renamed or moved, with everything below it.                                                                                                                                                                |
| **Asset**: id, name, folder, type, url                                 | Any other asset (`IMAGE`, `MAP`, `AUDIO`). A folder of `null` is the library's root.                                                                                                                                                                                                             |
| width, height                                                          | LegendKeeper's, where given (images).                                                                                                                                                                                                                                                            |
| size                                                                   | Bytes, **when LegendKeeper says**. Its `Asset` carries no size today, so this is empty; the column is kept for E1 and is read if LegendKeeper ever adds it.                                                                                                                                      |
| SHA-256                                                                | Recorded for images the bridge uploads once their stored file is verified (v2 D3, [ADR 0041](adr/0041-image-pipeline.md)), with the size; otherwise empty until E1 downloads images for backups. A recorded hash is kept across refreshes and dropped when the image's `url` changes (new file). |
| hidden, created                                                        | LegendKeeper's.                                                                                                                                                                                                                                                                                  |
| last read (when, and by `build`, `write`, `refresh` or `check`); stale | The tree itself.                                                                                                                                                                                                                                                                                 |

## Status

| Status      | Meaning                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `not_built` | The first build has not completed.                                                                                |
| `building`  | A build is walking the folders (its estimate was confirmed).                                                      |
| `ready`     | Built, confirmed by a build, refresh or check within the last 26 hours, and nothing is stale.                     |
| `stale`     | Something could not be confirmed (a re-read failed, or a folder could not be listed), or 26 hours without a pass. |

Every query answer states the status, why it is not ready, and when the tree was last confirmed. There is no
`not_configured`: unlike the repository tree, the asset tree needs no setting before it can be built.

## How it stays current

- **After the bridge's own asset writes.** For `createAssetFolder`, `createImageAsset`, `updateAsset` and `deleteAsset`
  the job re-reads what changed with `getAsset`, in the same job and at its priority, and the tree stores what
  LegendKeeper answered, never what the request asked for. `updateAsset` answers with no body, so it is always read
  back. A create whose response has no id (an uncertain outcome) lists the folder it was put in instead. A moved
  asset's new folder, if the tree has not seen it, has its ancestors read until a known folder is reached. A deleted
  folder is removed with everything in it once it reads as 404 (LegendKeeper's `deleteAsset` deletes a folder's
  contents at any depth). A re-read that fails marks the row stale, is logged, and is retried (one minute, doubling to
  an hour); a crash between a write and its re-read is caught up at the next start. Before the first build nothing is
  re-read (the build will see it).
- **Regular refresh** (`asset-refresh`, every 6 hours, per project, can be switched off). The same walk as the build,
  at P3, with a short pause after each request (250 ms), so it is paced and gives way to agents' work. It costs the
  listing requests only; a getAsset is made only for something a listing did not show.
- **Nightly check** (`asset-check`, 02:50 London time, per project, alongside the repository tree's check at 02:30).
  The same walk, plus an audit of the tree itself (every folder's cached path against its parent links). It runs even
  when the regular refresh is switched off.
- **The correction log** (Asset Tree page): each value a refresh or check corrected (old and new), each folder or
  asset it added or removed, and each re-read that failed, with the pass that found it. The newest 10,000 entries per
  project are kept.

**Absence from a listing is not proof of deletion.** A stored row that a folder's listing does not show is read with
`getAsset`: a 404 removes it (a folder with everything in it); an answer is applied (a move shows up as a new folder).
If that read fails the row is marked stale, never deleted. A refresh or check never undoes what the bridge itself
changed after the folder was listed (ADR 0027).

Switching the refresh off (the nightly check still runs), on the Projects page or from the server's shell:

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- set test assetRefreshEnabled off
```

`npm run projects -- set test assetRefreshEnabled -` restores the default (on). A refresh started with **Refresh now**
or **Run now** on the Maintenance Jobs page runs even while it is switched off.

## Cost

- **First build:** one request per folder (the root included), plus one for every further 100 items in a folder. The
  test world (18 folders, 559 images, one folder with 260 images and one with 150): **22 requests**, about 6 seconds of
  deliberate pacing plus the requests' own time (roughly 10 to 20 seconds in all), 0.07 % of the key's 30,000 requests a
  day. An idle key never makes the walk wait. Everything runs at P3, behind agents' work.
- **Refresh and check:** the same, every 6 hours and every night: about 110 requests a day on the test world.
- **After a write:** one `getAsset` per asset write (plus the ancestors of a folder the tree has not seen).

## The query layer (for later sessions)

`runtime.assets.queries` (`src/assets/queries.ts`); no LegendKeeper request. Each method returns `{ tree, data }`, where
`tree` is the status, the reason and when the tree was last confirmed. A folder id of `null` means the library's root.

- `folder(project, id)`, `asset(project, id)`, `path(project, folderId)`;
- `foldersByPath(project, names, { caseSensitive })`: every folder reached by following `names` from the root. **All
  matches** are returned (the library does not forbid two folders with one name);
- `children(project, folderId | null)` (subfolders by name), `assetsIn(project, folderId | null, { types, limit, offset })`,
  `subtree(project, folderId | null, { maxDepth, limit })` (depth first, siblings by name);
- exact-name lookups, **every match**, case-insensitive unless `caseSensitive: true`: `findFoldersByName(project, name,
{ withinFolderId })` and `findAssetsByName(project, name, { folderId })` (assets only, never folders). No partial or
  fuzzy matching;
- `counts(project)`, `stale(project)`, `status(project)`.

## Placement planning

`planAssetDestination(projectId, request, deps)` (`src/assets/plan.ts`; bound as `runtime.assets.plan(projectId,
request)`) says where an image for a character belongs. It is **pure**: it reads the stored asset tree and repository
tree, writes nothing and asks LegendKeeper nothing. D3's image pipeline creates what the plan says. **Folders are never
moved.** Since CR-2026-11-R2 (R2-44) every folder name the plan writes is canonical: NFC, with zero-width characters
removed and no-break spaces written as spaces, so two names that show the same make one folder (a folder made by hand
under a non-canonical name is still matched byte for byte).

Since the same review, the staged images on the bridge's server: one placement, discard or restore of a staged image at
a time (a second gets `STAGED_BUSY`, R2-38); an image restore reuses only its own staged record holding the snapshot's
bytes (R2-39); `IMAGE_UPLOAD_RATE_PER_PRINCIPAL` limits stagings from every source (R2-41); a server file is kept while
any staging or record still needs it, and a record keeps naming its file until the file is gone, the minute sweep
trying a failed removal again (R2-42, R2-43).

```ts
request = { characterResourceId?: string; characterName?: string; subfolders?: string[] }  // exactly one of the first two
        | { folderPath: string[] }                                                          // a literal path from the root
```

The old bridge's rules, exactly (PLAN-v2 section 9):

1. A folder named exactly after the character is reused **wherever it already is**, if there is exactly one.
2. Otherwise the destination is `Characters / Group / Race / Character`, or `Characters / Race / Character` when the
   race sits directly under Characters. The labels come from the character page's **real ancestry** in the repository
   tree (display names, so the `[INDEX]` and `[BSRC]` prefixes are gone), as the old bridge did; they are never taken
   from the type registry. A Character Core page sits below the character's own `[INDEX]` page: that index gives the
   name and is not a label. At most a group and a race are allowed (the registry's race search depth, two).
   Four things come from **A3's type registry** (the project's `character` type), each falling back to the old
   bridge's literal when the project has no such type or leaves it empty (`PlanDeps.characterType`, wired by the
   runtime):
   - the **asset root folder name** (the type's `assetRootFolder`), else "Characters";
   - the **Characters index page** (the type's `rootIndexId`), used when the project has no `charactersRootId` setting
     (which wins), and otherwise the one `[INDEX]` page named like the asset root directly under the AI REPOSITORY;
   - the **unknown-race folder** (the placement setting `unknownIndexName`), else "Undetermined / Unknown";
   - the **Core Reference Type** (`referenceTypes.core`) that tells a Core page from the character's own index, else
     "Character Core".

3. An unknown race (no page under Characters answers to the name, or the page sits directly under Characters) uses the
   unknown-race folder, by default the literal `Undetermined / Unknown`. The plan says so in its notes.
4. Then the literal `subfolders`: a list of plain names, **never a slash path** (`"a/b"` is refused; the one name with
   a slash that is allowed is `Undetermined / Unknown`). Surrounding spaces are removed; empty, over-long (200) and
   control-character names are refused.
5. A non-folder asset with the same name where a folder is needed is a **conflict**; more than one folder with the
   character's name (or with a path segment's name in one place) is an **ambiguity**. Neither is guessed at.

Names match exactly: Unicode NFC, **ignoring case**, like the repository tree's lookups ("inae mikumo" is the folder
"Inae Mikumo"; the plan says so in its notes). No partial or fuzzy matching.

The result is `{ ok: true, plan }` or `{ ok: false, error }`; domain outcomes are returned, not thrown. A plan has
`steps` (every folder from the root to the destination, in order, each `reuse` with its folder id or `create`),
`reused`, `wouldCreate`, `destination` (`path`, `folderId` or `null`, `exists`), `character` (name, group, race, where
the race came from), `notes`, and the asset tree's status. A folder to be created below one that is also to be created
has `parentFolderId: null`; its `path` says where.

| Error code                  | Meaning                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_REQUEST`           | Both or neither of `characterResourceId` and `characterName`; a `folderPath` mixed with a character; an empty path.                |
| `INVALID_NAME`              | A name that is empty, too long, has a control character, or is a slash path.                                                       |
| `ASSET_TREE_NOT_READY`      | The asset tree is `not_built` or `building`: a folder cannot be told from a missing one. (`stale` still plans, with a note.)       |
| `REPOSITORY_TREE_NOT_READY` | The race must be read from a repository tree that is not configured, not built or being built. A folder that exists needs no tree. |
| `CHARACTER_NOT_FOUND`       | `characterResourceId` is not in the repository tree.                                                                               |
| `NOT_A_CHARACTER`           | The page is not under the Characters index.                                                                                        |
| `CHARACTERS_ROOT_UNKNOWN`   | The Characters index could not be found (set the project's `charactersRootId`).                                                    |
| `CHARACTER_PAGE_AMBIGUOUS`  | Pages with that name sit in different places under Characters: give `characterResourceId`.                                         |
| `ANCESTRY_TOO_DEEP`         | The page is more than two levels (group, race) below Characters: give a `folderPath`.                                              |
| `AMBIGUOUS_FOLDER`          | **The typed ambiguity.** More than one folder with the name; `details.candidates` lists each with its path.                        |
| `ASSET_NAME_CONFLICT`       | **The typed conflict.** A non-folder asset has the name where a folder is needed; `details.assets` lists them.                     |

## Dashboard and admin API

The **Asset Tree** page (per project): status, counts, the build button with its estimate and progress, the last build,
refresh and check, stale rows, failed re-reads, the correction log, a browsable folder tree (one folder at a time, with
its assets), **Refresh now**, and the read-only **Try it** panel for placement planning.

| Route                                                                         | Does                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /api/admin/asset-tree?project=`                                          | Everything the page shows                                                            |
| `GET /api/admin/asset-tree/children?project=&id=&limit=&offset=`              | A folder (the root by default), its path, subfolders and assets                      |
| `GET /api/admin/asset-tree/corrections?project=&limit=&before=&source=&pass=` | The correction log, newest first                                                     |
| `POST /api/admin/asset-tree/build?project=`                                   | Lists the root level (`202`); audited `assets.build_prepare`                         |
| `POST /api/admin/asset-tree/build/confirm?project=`                           | `{ confirm: true }`: starts the walk; audited `assets.build_start` with the estimate |
| `POST /api/admin/asset-tree/build/cancel?project=`                            | `{ confirm: true }`; audited `assets.build_cancel`                                   |
| `POST /api/admin/asset-tree/refresh?project=`                                 | Runs a refresh now, in the background (`202`); audited `assets.refresh_now`          |
| `POST /api/admin/asset-tree/plan?project=`                                    | "Try it": a read-only plan; not audited, nothing requested from LegendKeeper         |

Errors: `409 PASS_RUNNING`, `NOTHING_TO_CONFIRM`, `NOTHING_TO_CANCEL`; `400 INVALID_INPUT`.
