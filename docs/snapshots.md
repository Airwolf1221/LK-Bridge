# Snapshots, restores and the rehearsal: what to know

The design is [ADR 0042](adr/0042-snapshots-restore-rehearsal.md). The dashboard's Snapshots page is in
[dashboard.md](dashboard.md), and the tools are in [tools.md](tools.md). This page collects what an owner runs into in
practice.

## Complete and partial snapshots

A snapshot is **partial** when a piece could not be read or stored. Each missing piece is listed on the page with why. A
partial full snapshot is kept, but a restore cannot bring back the missing pieces from it. The rehearsal and the audits
should use a **complete** one, and the dashboard's rehearsal picker preselects the newest complete full snapshot (v2 E5.4).

### A map LegendKeeper cannot list (v2 E5.4)

LegendKeeper's API contradicts itself on map label sizes ([ADR 0046](adr/0046-e4-owner-decisions.md) decision 14; the bug
report is [reviews/lk-bug-labelsize.md](reviews/lk-bug-labelsize.md)). Its writes take only `xs` to `3xl`, but
`listFeatures` returns only `small`, `medium` or `large`. It refuses to list a map if one feature holds anything else. The
snapshot then records that map document as missing:

> its features: LegendKeeper can't list this map's features: a feature holds a label size its API refuses to return (set
> its label size in the app)

The rest of the page and the rest of the snapshot are taken as usual, and the snapshot is partial. **To fix it,** find the
feature in the app and set its label size again (any of small, medium or large); the next snapshot is complete. The bridge
never writes a label size, so only a write from outside the bridge can cause this.

## Label sizes are not restored

A restore, a recreated page and a rehearsal never send a feature's `labelSize`, so a restored feature takes LegendKeeper's
default size. Each is listed under what could not be restored, once per map with a count:

> label size not restorable: LegendKeeper's API can't write the app's values (small/medium/large) and can't read its own
> (xs–3xl)

This is neither a failure nor a difference. A feature that differs from the snapshot only in its label size is not
updated. Set label sizes in the app if they matter. The switch that would turn this off when LegendKeeper fixes the API is
`LABEL_SIZE_WRITABLE` in `src/maps/features.ts`, and the sandbox assumption LS1 (`npm run test:sandbox`) shows when it is
safe.

## The rehearsal

A rehearsal restores a full snapshot into a throwaway root of a sandbox project, compares it, and deletes the root.

- **Sampled** (the default): about 50 pages chosen to cover every kind of block and document. Since v2 E5.4 a sample copies
  at most **25 events of each timeline** (spread over it, with every lane they use) and at most **40 features of each map**
  (a kept feature brings its folders; a region and a path are kept first if the map has them). The estimate lists what it
  leaves out. **Full** copies everything.
- **The estimate** is paced as the governor will pace the run at background priority (P3): the writes one after another
  at P3's write rate, and the reads at its request rate. At the default limits that is about a second a write and under
  half a second a read once the run is long. The plan shows the rates it assumed.
- **Honest estimates (v2 E5.5, backlog 16; [ADR 0047](adr/0047-learned-operation-limits.md)).** The rates are each
  tier's effective limit, and a write takes at least the target project's **measured per-write duration**: the median
  wall time of its last 200 write steps, floored at the configured spacing. The plan names its asset steps (the folder,
  each image's upload and asset, the PUT, the folder's delete), so a learned limit for the `assets` group paces those
  steps only: they take the longer of their own pacing and what the group's limit allows, and every other write goes at
  P3's share of the documented 120 a minute. `estimate.figures` says which figures were used: `perWrite` (`from`
  `measured` or `spacing`, the median and how many steps it is of), `limits` (each documented tier's limit and P3's share
  of it) and `groups` (each learned group's limit, window, steps and time). Right after a period of slow pacing the
  median reads high until about 200 new write steps have run; the figures make that visible.
- **Progress against the plan (v2 E5.5).** A running rehearsal saves its stage and its writes, reads and uploads every
  few seconds (`progress`). The Snapshots page shows them against the plan's, with the time elapsed and a projected finish
  (the elapsed time over the share of the planned work done, writes and reads weighted by the plan's pacing; before 2% of
  it, the start plus the estimate).
- **Restores** carry the same estimate (`estimate`, at P1, the priority they run at once approved): the dashboard's
  Preview shows it with its figures, and `restore_snapshot` says it in a few words (`estimate.about`,
  `secondsPerWrite`, `perWriteFrom`, and any learned limit that paces it).
- **Reads never fail the run.** Any read in the comparison that fails (a map LegendKeeper cannot list, a timeout, an
  error) is a difference naming the page and the piece. The comparison carries on with the other pages, and the run
  finishes and deletes its root as usual.
- **Leftover roots.** A rehearsal the bridge was restarted during is marked stopped, and its root is kept. Delete it from
  the Snapshots page ("Delete its root"), or in the app (a top-level page named `lk-bridge rehearsal <time>`) if the page
  says the delete failed.

## v3 F2: missing pieces, pages deleted in the app, and finishing a recreate

[ADR 0049](adr/0049-v3-f2-last-major-revision-default-project-and-staging.md) decisions 4 to 6.

- **A partial snapshot says what it is missing.** Each partial snapshot's row on the Snapshots page expands
  (**Show what is missing**) to list each missing piece: the page (a link to it in the tree; the asset library for the
  library's own), the piece, its reference and the reason, read from the manifest once per request. `list_snapshots`
  gives the same in summary form: `missing: { total, thisPage: [{ piece, ref, reason }], otherPages }`. No more
  `node -e` on the server.
- **A page deleted in the LegendKeeper app** can be restored (scope `deleted`) when a full or change snapshot holds it,
  although the bridge holds no delete record of it. The lifecycle and canon guards judge the restore from the newest
  snapshot's state (its name with its prefix, its parent, its Status and tags), as they would a create of that page: an
  Authoritative page comes back only as a canonical proposal. It is refused only when no snapshot holds it. Every restore
  proposal names the snapshot it came from and when it was taken.
- **A recreate that stopped part-way is finished, never duplicated.** Its page's id was minted when its proposal was
  captured and is kept with the restore's record. The same request again (or **Finish** on the restores list of the
  Snapshots page) compares the page it made with the snapshot and proposes only what is missing: documents it lacks (with
  their content), a page document still blank, a map's features, a timeline's lanes and events, a board's content, and
  sidebar properties. When nothing is missing the answer is "nothing to do". A timeline's events are read page by page
  (100 a page), so an event already made is never planned again (CR-2026-11-R2, R2-47).
- **One restore of a deleted page at a time** (CR-2026-11-R2, R2-48). While a recreate or an undelete of a page is still a
  proposal or still running, another restore of that deleted page is refused (`RESTORE_IN_PROGRESS`, naming the restore
  and its proposal): planned meanwhile it would make a second page, or a finish from a page still being written. Once it
  has ended, the same request finishes a recreate that stopped part-way.
- Staged images (on the bridge's server since v3 F2) are unapproved: they are in no snapshot and no off-site copy.
- A restore that changes a page's text sets its Last Major Revision (the restore category; a rehearsal never does). Since
  v3 F3c only when the change is a major revision (8 words or more of text, or a heading), measured when it runs;
  `restore_snapshot` takes `lastMajorRevision` to override.

## v3 F3c: a deleted image comes back without LegendKeeper's staging folder

[ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 3.

- **Until approval, the image is only on the bridge's server.** `restore_snapshot` (scope `image`) and the Snapshots
  page's image restore stage the snapshot store's bytes on the server, exactly as stored (a PNG stays a PNG). Nothing is
  sent to LegendKeeper, nothing is hidden, and nothing is ever written to `LK-Bridge staging`.
- **The proposal says what will happen:** the image's name, the folder it goes back to (its path from the library's
  root) and any folder that has to be made on the way, and the pages that showed it. There is no new asset id or URL yet.
- **Approving it runs one job:** the folder is found, or made again by its path if it was deleted since the snapshot;
  the image is uploaded straight into it under its name and checked; then, with "update references", each page
  document that showed the old URL is rewritten to the new one, and each map image is set to the new asset.
- **A page edited in the meantime is not overwritten.** Its rewrite carries the page's version from when the restore
  was proposed; if the page has changed, the rewrite is refused and the job stops there, after the upload. The image
  stays in its folder. The restore's row on the Snapshots page says `image_relink_failed: the image was restored, but N
page(s) changed since the proposal and still show the old URL (…); relink them by hand to the new asset`, and the
  bridge never retries it. The new asset's id and URL are in the restore's record.
- An image that was at the library's root goes back to the root. One whose folder is gone and whose path the snapshot
  does not hold goes to the root too, and the proposal says so.
