# ADR 0042: Snapshots, restore and the rehearsal (v2 E1a)

- Status: Accepted
- Date: 12 November 2026; amended 13 November 2026 after the owner's sandbox run (decisions 4 and 9, below)
- Session: v2 E1a (PLAN-v2 4.11 and phase E; E1 split into E1a, this, and E1b, the encrypted off-server copy)
- Builds on: ADR 0027 (asset tree), 0031 (`write_page`, keep regions), 0032 and 0036 (canon), 0035 and 0037 (lifecycle),
  0038 (chronology), 0040 (maps), 0041 (images; its kept-bytes store, "E1's backups will reuse this store")

## Context

PLAN-v2 section 1 (Backups) and 4.11 ask for the bridge's own copies of everything it manages: content-addressed,
deduplicated snapshots of each page's pieces, taken in full, after every bridge write, and (if LegendKeeper's
`updatedAt` could be trusted) daily for app edits. **It could not (13 November 2026): the full snapshot is nightly
instead.** (This ADR first said weekly, with a daily pass; both are changed in place below, so it reads as the design
now.) It also asks for restores that are always proposals, and a rehearsal that proves a snapshot can actually be
restored. 4.2 budgeted about 500 reads a day for snapshots on Arkona (about 1,500 pages); nightly fulls take about 3,400
(decision 4), still a small part of the key's 60,000 a day, at P3.

E1 is split in two. **E1a** (this ADR) builds the store, the snapshots, the restore tools and the rehearsal. **E1b** copies
the store and the nightly database copies, encrypted, to Google Drive, with a download-and-verify drill. E1b must be able
to copy the store **as it is**, so its on-disk layout is fixed here as E1b's contract.

The server (owner, 12 November 2026): `/` is 144 GB with 63 GB free.

## Decision 1: the store on disk (E1b's contract)

```
<SNAPSHOT_DIR>/                                  0700, owned by lkbridge
  STORE.json                                     0600  {"format":"lk-bridge-snapshot-store","version":1,"layout":…}
  objects/<first two hex>/<sha256>.gz            0600  gzip of the content; the name is the SHA-256 of the UNCOMPRESSED
                                                       content (a piece's canonical JSON, or an image's raw bytes)
  manifests/<project id>/<snapshot id>.json.gz   0600  gzip of one snapshot's manifest (canonical JSON)
  tmp/                                           0700  files being written; never copied; emptied at start-up
```

- **Default directory:** `snapshots/` next to the database, so `/var/lib/lk-bridge/snapshots` on the server
  (`SNAPSHOT_DIR` overrides it). Directories 0700, files 0600, owned by the service user. A database in memory or in a
  temporary place (tests, the sandbox runtime) gets a private directory under the system's temporary directory, never one
  under the app folder (ADR 0041's lesson).
- **Write-once:** every file under `objects/` and `manifests/` is written to `tmp/`, then renamed into place, and never
  changed afterwards. Files are only added, and removed by the retention and the collector. An incremental copy (rclone)
  only ever uploads new files, and any file it has is complete.
- **Objects before manifests:** a manifest is written only when everything it names is stored. **E1b copies `objects/`
  before `manifests/`**, so a copy that has a manifest has every object the manifest names.
- **Self-verifying:** an object is checked by gunzipping it, hashing it and comparing with its name. The format is plain
  gzip and JSON: a restore needs nothing but the store (no database, no bridge code beyond reading JSON).
- **Compression:** pieces (JSON) at gzip level 6, manifests at 9, images at level 1 (WebP, PNG and JPEG barely compress;
  the gzip wrapper keeps every object the same shape).
- **Snapshot ids** are `YYYYMMDDTHHMMSSZ-<kind>-<hex>`: they sort by time and say their kind.

### Manifests on disk, indexed in the database

**Manifests live in the store** (`manifests/`), not only in the database. The store must restore on its own (E1b's drill
downloads it to a fresh machine), and the nightly database copy is a different file on a different schedule: a manifest in
the database alone would tie the store's meaning to a database copy that may be older or newer. A manifest is small
(hashes and the tree, never content: 124 bytes a page compressed against the mock, a few hundred with real names).

The database **indexes** the manifests (`snapshots`, `snapshot_pieces`: one row a piece), for the dashboard and
`list_snapshots` (a page's history is one indexed query, no file reads). The files are the truth: the index is rebuilt
from them at start-up when a row is missing (`reindex`), and a manifest file that cannot be read is a finding.

### One store with D3's kept bytes

ADR 0041 decision 10 kept an image's bytes before every asset delete in `<image dir>/kept-bytes/`. **That store is merged
into this one** (not reused beside it): the kept bytes are objects here too, named the same way, referred to by
`asset_kept_refs` instead of a manifest. An existing `kept-bytes/` directory is adopted at start-up (each file hashed,
moved in, the directory removed when empty). One copy of each image's bytes serves both a snapshot and a kept delete,
and E1b copies one directory. The collector keeps every object a kept reference names until its window ends.

## Decision 2: what a snapshot holds

A manifest names its project, its kind (`full` or `change`), its time, its trigger, and for every page it took:
the tree (id, parent, rank, name, kind) and the hash and size of each piece. A piece is:

- **the resource:** name, tags, aliases, icon and its other settings (the writable fields; versions and timestamps
  stripped);
- **the sidebar:** every property (rows, collections, `unsupported` placeholders by id) in C2a.1's rank-sorted, by-id form;
- **each document**, by type: a **page**'s blocks (with `unsupported` placeholders and the blocks Markdown shows as keep
  regions, exactly as stored); a **map**'s settings, `MapImage` and every feature; a **timeline**'s settings, lanes and
  every event; a **board**'s content and shapes; a blank document's settings;
- **the images** each page refers to (by URL, with the SHA-256 of their bytes), and in a full snapshot **the whole asset
  library** (its folders and assets as one piece, and every asset's bytes).

**Canonical serialisation:** keys sorted at every level; rows, items, features and lanes in (rank, id) order; events by
(lane, rank, id); board records by id; blocks in document order; versions, `createdAt` and `updatedAt` removed. Two reads of
an unchanged piece therefore hash the same whatever order LegendKeeper answered in, and an unchanged page or image takes no
extra space between snapshots.

A `full` manifest lists every page with every piece. A `change` manifest lists only what it took: a missing
piece there means "not taken", never "empty". A piece that could not be read or stored is listed under `missing` with
why, and makes the snapshot **partial**: never silently "fine".

## Decision 3: integrity and disk

- **Verify** (maintenance job `snapshot-verify`, weekly) re-hashes every object a snapshot or a kept reference names, and
  reads every manifest. A missing or damaged object is a finding on the Snapshots page, and every snapshot that uses it is
  marked partial (with why). A restore from a damaged piece is refused (`SNAPSHOT_PIECE_DAMAGED`). The next snapshot that
  takes the same content writes the object again (repair).
- **Disk check:** before a full snapshot, free space (statfs) minus an estimate of what the run may add must stay above
  `SNAPSHOT_MIN_FREE_GB` (**default 10 GB**, the owner's figure). Otherwise the run is refused, recorded, and shown on the
  Snapshots page; it never fills the disk. The estimate is deliberately generous: 12 KiB a page and 512 KiB an image not
  yet stored.
- The Snapshots page shows the store's size, the deduplication ratio (what the snapshots hold over what the store keeps),
  the compression ratio, the free space against the minimum, and the next full snapshot's estimate against the headroom.

## Decision 4: taking snapshots

1. **Full, nightly** (`snapshot-full`, **every night at 00:30 London time**; a setting on the Maintenance Jobs page): every
   page under the AI REPOSITORY, the lifecycle indexes included, then the asset library. P3, through the governor; it
   waits while agents' P1 or P2 work is queued (as the tree and link sweeps do). **Resumable:** the run records each page
   as it is taken; an interrupted run (restart, stop, budget) continues where it stopped; the manifest is written only
   when the run is complete. The owner can abandon a run from the dashboard.
   - **Why nightly.** Edits made in the LegendKeeper app must be caught within a day, and the API has no change feed
     (PLAN section 1.3). The cheap way, the daily pass below, cannot work. A full snapshot costs about 2.24 reads a page:
     **roughly 3,400 reads a day on Arkona (about 1,500 pages) against the key's 60,000, and about 340 on the test world**,
     at P3 (it stops at the maintenance floor and gives way to agents).
   - **Images are not downloaded again.** A library asset whose **id and URL** are as an earlier snapshot recorded them is
     recorded from that snapshot's hash, with no download, while the store still holds those bytes and no open verify
     finding calls them damaged (then they are fetched and written again: the repair). LegendKeeper's asset URLs are
     content-specific: a replaced image has a new URL, so a replaced or new asset is downloaded, and nothing else. The
     first full snapshot downloads the whole library (549 images for a 558-image library, on the owner's first run);
     the second, with nothing changed, **downloads nothing and stores nothing new** (measured against the mock: 132
     reads, 0 downloads, 0 new objects). The weekly `snapshot-verify` is where stored image bytes are re-checked, not the
     nightly run.
   - Other images (a page's, from a change snapshot) are reused by URL the same way.
2. **Change snapshots:** after every successful bridge write that changes a page (`write_page`, `set_facts`, the C2b, C2c
   and C2d tools, lifecycle, chronology, maps, images, `lk_api_*`), the pieces that write changed are taken **at the end of
   the job**, before it is reported finished, from the reads the job already made after its last write (the verify step's
   read) when they hold the piece; only what is not already read is read again. The pieces owed are recorded first, so a
   restart takes them later. Priority follows the job's (P0/P1 kept, otherwise P2). **A change snapshot never
   downloads an image:** an image the store already holds is named with its hash (the bridge's own uploads included: the
   pipeline hands an upload's bytes to the store as it starts, and the upload's change snapshot matches them to the new
   asset's URL); any other is named by its URL only (`deferred`, not missing), and the next full snapshot stores its bytes
   with the whole library. A bridge write never waits for the asset host, and an image deleted through the bridge in
   between is covered by D3's kept bytes.
3. **There is no daily changed-pages pass.** The design had one (`snapshot-daily`, listing the resources and snapshotting
   the pages whose `updatedAt` moved, with `snapshotDailyPass` and `snapshotDailyPassDocuments` as per-project settings,
   off until the sandbox run confirmed it). **The owner's sandbox run of 13 November 2026 (checks U.a to U.e) failed all
   five: LegendKeeper's `updatedAt`, on resources and on documents, does not move when blocks, sidebar rows, map features,
   timeline events or board content change.** A pass built on it could never see an app edit, so it was removed, not left
   as a switch that does nothing: its two settings, its maintenance job, its service method, its run kind, its dashboard
   switch and its memory table (migration `2100` drops the table and the stored settings and the job's row, and has an
   unchanged full-snapshot schedule worked out again from the new default). The sandbox script keeps one NOTED line (`U`)
   for the record. A manifest no longer records a page's `updatedAt`.
4. **Retention** (`snapshot-prune`, daily), all settings:
   - **full snapshots:** every one for `SNAPSHOT_KEEP_FULL_DAYS` (**30**) days; then, for `SNAPSHOT_KEEP_WEEKLY` (**8**)
     more weeks, **one per ISO week: the latest complete full snapshot of that week** (the week of London time, as the
     schedule is); then none. A partial full snapshot is kept for the first window only. The newest complete full
     snapshot is never removed, however old.
   - **change snapshots:** `SNAPSHOT_KEEP_DAYS` (**30**) days, as before.
   - Then the **collector** removes objects nothing refers to (no manifest, no running run, no kept reference inside its
     window), under the store's exclusive lock, with a grace period for objects written in the last hour. Deduplication
     is why nightly fulls cost little disk: a night adds only what changed, and the retention removes only what no kept
     snapshot shares.

## Decision 5: restores are always proposals

`list_snapshots` (R, free), `snapshot_diff` (R: a few reads against now, free between two snapshots) and `restore_snapshot`
(W). **A restore is always captured as a proposal, at every scope, `write` included** (`forceProposal`), and the owner
approves it on the Proposals page, which shows its diff and everything it cannot restore. "Propose a restore" on the
Snapshots page makes the same proposal (the owner's own proposals stay proposals: `ownerForcedProposal`).

Scopes: a page's documents, its sidebar, one document, a deleted page with its content, or a deleted image. A deleted page
is **undeleted** while LegendKeeper keeps it (`restoreResource`; a second proposal then brings its content back to the
snapshot, planned against the page as it came back), or **recreated** under its snapshot parent: with its **original ids**
where LegendKeeper takes client ids and they are free, otherwise new ones (`ids: "new"`), and the result maps old ids to
new. A recreate that collides (`DUPLICATE_ID`) fails safe: nothing is half-made.

Every restore goes through the normal machinery: the page's lock, the compare-and-swap inside the lock (If-Match on every
versioned write), the verify read, journal pre-images, and every guard:

- **canon:** restoring a Status to `Authoritative`, or a protected Continuity change, needs canonical approval ("Approve
  and accept as canon");
- **lifecycle:** a restore that would change a page's lifecycle state (its prefix, its Status or its status tag) is refused
  (`RESTORE_LIFECYCLE`) with a pointer to the lifecycle tools; a recreate never takes a lifecycle state;
- **decision 5 (ADR 0036):** the proposal covers only what it lists; documents added since the snapshot are left alone
  (and said so).

The sidebar restore brings back the facts property through `set_facts`' own plan (its guards included), the link
collections by item, and every other key-value property row by row (matched by property id and row id).

## Decision 6: what cannot be restored exactly is said

- **`unsupported` blocks and inline icons** cannot be written by the API. A page restore echoes the ones the live page
  still holds (by id); the rest are listed as **lost**. A page whose live blocks hold an inline icon is refused block by
  block (`RESTORE_NOT_WRITABLE`: writing the document would drop it); block-by-block restore is left to E4.
- **A restored image is a new asset with a new URL** (LegendKeeper cannot undelete an asset). Its bytes come from the store;
  it is staged (uploaded, verified, hidden) first, because a proposal cannot hold bytes (ADR 0041 decision 7), and the
  proposal places it back in its folder under its name. The result lists every page the snapshots show referring to the
  old URL, and **when the owner ticks it**, the same proposal updates their page documents and map images; anything else
  (a banner, an event's image) is listed for a hand change.
- **Map features and timeline events have no versions** (ADR 0040): their restore is checked inside the lock against the
  planned state (`SNAPSHOT_MAP_CHECK`, the event and lane checks) and verified after; a change in between makes the job
  stop, not overwrite.
- Board pages, ranks LegendKeeper re-mints, and the order of links re-added are noted where they may differ.

## Decision 7: the rehearsal

PLAN-v2's rehearsal restores a project's snapshot into the test project. A full restore over the test world would destroy
it, so the rehearsal restores into a **throwaway root** at the top level of a **sandbox** project (`lk-bridge rehearsal
<time>`), recreates the snapshot's tree there **with new ids**, and compares: each page document through the Markdown round
trip and the block comparator, ignoring ids; sidebars by key and value, and collections by item; map features, timeline
lanes and events, and board shapes; image bytes by SHA-256. Then it deletes the root and its asset folder, unless the owner
keeps it to inspect ("Delete its root" on the dashboard later).

- **Sampled by default:** about 50 pages, chosen greedily to cover every block kind, every document type, the chronology,
  a map, a board, images, keep regions and sidebar links, then spread over the rest; deterministic. **Full on demand**,
  with its estimated reads, writes and time (the governor's estimate at P3) shown first.
- **Source:** any full snapshot of any project; **never into the project it came from** (`REHEARSAL_SAME_PROJECT`), and
  only into a project marked as a sandbox (`REHEARSAL_NOT_SANDBOX`).
- **Inert:** the copy must not look like canon or move a page's lifecycle in the test world, so names are prefixed
  `rehearsal: `, guarded values (Status and the protected facts) become `rehearsal: <value>`, and status tags
  `rehearsal-<tag>`; the comparison allows exactly these changes and counts them. References (mentions, links, map and event
  links, images) are mapped to the copies.
- **Never outside its root:** every job's steps are checked before submission (each write's resource is the root or a page
  the rehearsal made; asset writes only in its own folder); a step that is not is refused (`REHEARSAL_OUTSIDE_ROOT`).
  A page a step creates counts as inside for the steps after it **in the same job** (a root, a child and a grandchild in one
  job are all inside); a parent the rehearsal did not make is still refused (`assertInsideRoot`, tested both ways).
  **The owner's first sandbox run (13 November) refused itself with this error after 5 writes. The cause was not the
  same-job nesting the first reading suggested** (the rehearsal makes one page a job), **but a page whose creation
  LegendKeeper refused (the icon, decision 9): its children then named a parent that did not exist, and the guard read that
  as "outside the root" and stopped the whole run.** Now a page that could not be made is a difference ("could not be
  created"), its descendants are listed as "not attempted: its parent in the copy could not be created", and the rest of
  the rehearsal goes on. (A test with a refused parent fails on the old code with exactly the owner's message.)
- It runs through the bridge as the owner's job: an ordinary bulk create in the test project, at P3, with the canon and
  lifecycle guards applying. A rehearsal turned into a proposal by a guard stops (`REHEARSAL_PROPOSED`) and writes nothing.
- Results (pages compared, exact, differences with reasons, what a restore cannot bring back, cost, time) are kept
  (`snapshot_rehearsals`) and shown on the dashboard. A restart marks a running rehearsal stopped and lists its root.

## Decision 8: the bridge's database

`deploy/backup.sh` copies the whole database nightly (`sqlite3 .backup`), so everything E1a adds to it is in the copies:
the snapshot index, runs, findings, restores and rehearsals. The manifests themselves are in the store, which E1b copies
beside these database copies. The Snapshots page lists the copies (nightly and pre-deploy) with their size and age, and
warns when the newest nightly copy is older than 36 hours.

## Decision 9: icon names, read form and write form (13 November 2026)

The owner's sandbox run (D2) showed LegendKeeper **reads** an icon as a FontAwesome class string (`"fas fa-book"`) but its
write schema (`createResource`, `updateResource`; a pin's and an event's `iconGlyph` likewise) takes the **bare name**
(`"book"`) and answers 400 VALIDATION_ERROR ("Invalid icon name. Must be a valid FontAwesome icon.") to anything else. A
recreate that wrote back what it read therefore failed, and the original-id question was never reached.

- **Conversion** (`src/lk/icons.ts`, `toWriteIcon`): the style prefix (`fas`, `far`, `fab`, `fal`, `fat`, `fad`, `fa-solid`,
  `fa-regular`, `fa-brands`, `fa-light`, `fa-thin`, `fa-duotone`, `fa-sharp`) and the `fa-` prefix are removed:
  `"fas fa-book"` becomes `"book"`. A bare name is left alone, and so is anything that leaves nothing. Applied wherever the
  bridge writes back what it read: a restore and a recreate (the page, map features, timeline events), the rehearsal, and
  the tools that take an icon from the caller (`update_resource`'s `icon.glyph`, the map-feature tools' `style.iconGlyph`:
  an agent that read `fas fa-book` can pass it back). `update_resource` compares in the write form, so passing back what
  the page already shows changes nothing.
- **A name LegendKeeper still refuses does not fail the restore.** The bridge cannot know FontAwesome's names, so the write
  is sent, and a refusal that names the icon (a 400 VALIDATION_ERROR) makes the step go again **once without the icon**
  (LegendKeeper's default applies): the step option `dropIfRefused`, set only by bridge code, kept with an approved
  proposal. The step's result says what was dropped (`droppedFields`, `droppedWhere`); the **restore record lists each one
  under "couldn't be restored exactly"** (and the Snapshots page shows it), and the rehearsal lists it under what a restore
  cannot bring back and does not count it as a difference. Any other refusal still fails the step.
- **What this does not do.** The write form has no style, so an icon read as `far fa-star` (regular) may read back as
  `fas fa-star` (solid): the rehearsal compares icons by name; a restore's read-back check leaves the icon out. The sandbox
  run reports it.
- **Sandbox D2** now first tries both forms on a page each (`"fas fa-book"` and `"book"`), reports which LegendKeeper
  accepts and how the accepted one reads back, then goes on to the original-id check with a page that has an icon, and
  reports whether the icon came back (or was dropped and listed).

## Costs (measured against the mock)

- **Full snapshot:** 132 reads for 59 pages and 65 documents, **2.24 reads a page** (the resource, then each document's
  own reads: a page 1, a map 2, a timeline 3 or more, a board 1), plus one listing per 100 assets for the library.
  **Nightly: about 3,400 reads a day on Arkona, about 340 on the test world.** A second full snapshot with nothing
  changed: 132 reads, 0 downloads, 0 new objects, 0 new bytes.
- **Change snapshots, extra reads per tool:** `write_page` 1, `set_facts` 0, `create_bare_resource` 1, `delete_resource` 0,
  `restore_resource` 1, `update_resource` 0, `create_document` 2, `update_document` 2, `delete_document` 0,
  `create_map_feature` 2, `lk_api_write` `createEvent` 4, `insertBlock` 2, `replaceBoardContent` 2, `createAssetFolder` 0,
  `archive_page` 0.
- **Rehearsal (full, 59 pages):** 253 writes and 129 compare reads (about 4.3 writes and 2.2 reads a page).

## The owner's sandbox run (13 November 2026) and what it left to verify

`deploy/sandbox-test.sh --project test -- snapshots` (test/sandbox/README.md). **Passed:** every restore type (a page
document with its keep region and image, a map, a timeline, a board, a sidebar), undelete within the soft delete, the full
snapshot, the clean-up. **Failed:** U.a to U.e (`updatedAt` does not track content: decision 4.3), D2 (the icon form:
decision 9) and H (the rehearsal refused itself: decision 7). Still to see, on the rerun: **which icon form LegendKeeper
accepts and how it reads back** (D2), **whether LegendKeeper takes a recreated page's original id** (D2, never reached),
and a sampled rehearsal that completes (H).

## Consequences

- E1b copies `objects/` then `manifests/` (and the database copies), and its drill verifies each downloaded object against
  its name. Nothing in the store is ever rewritten in place.
- App edits are caught by the nightly full snapshot; there is no daily pass to switch on.
- The snapshot store takes very little of the server's disk (see the runbook's estimate); the minimum free space keeps
  the database and the logs safe if a library ever grows.
