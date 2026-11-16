# ADR 0049: v3 F2: Last Major Revision on substantial edits, the stored default project, snapshot follow-ups, server-side image staging, ChatGPT files and folders found at run time

- Status: **Proposed** (v3 F2, 16 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper and fixtures. The owner's decisions it carries out are quoted; the choices this session made where the
  brief left room are marked **chosen**.
- Builds on: [ADR 0048](0048-chronology-ii.md) (accepted with this session), [ADR 0035](0035-page-lifecycle.md) (the
  lifecycle tools already set Last Major Revision), [ADR 0032](0032-set-facts-and-canon.md) (facts, canon, the job
  model), [ADR 0041](0041-image-pipeline.md) (images; decision 7's staging folder is superseded here),
  [ADR 0042](0042-snapshots-restore-rehearsal.md) (snapshots and restores), [ADR 0046](0046-e4-owner-decisions.md)
  (decisions 4 and 6, and E4-OPEN-1), [ADR 0023](0023-project-model.md) and [ADR 0024](0024-env-sync.md) (projects,
  env-sync).
- Migrations: `2800` (the name tail on a chronology link), `2900` (server staging columns and the migrate-staging
  requests). No decision in PLAN.md or PLAN-v2.md changes; ADR 0041 decision 7 (the hidden staging folder) is superseded
  by decision 10 below, at the owner's request.
- Sections H (ChatGPT files) and I (asset folders found at run time) were added to the session by the owner while it ran;
  their decisions are 11 and 9.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script. Sandbox scripts were edited (LS1, the image and map checks) and only their dry runs against
  the mock were run.

## Decision 1: a qualified event's date tail follows its row

ADR 0048 decision 3 names a qualified row's event `<opening words> – <Date cell>`, and `sync_timeline_event` never
renamed an event, so an edited cell (`c. 4A 563; exact date unresolved` → `Isar 3rd, 4A 563; exact day disputed`) left a
stale tail.

- The link between a row and its event records the tail the bridge wrote (`chronology_links.name_tail`, migration 2800:
  `''` none; text the tail; NULL a link made before 2800, recognised once from the record of the change that created the
  event: it had a tail when the event's name then equalled `opening words – Date cell` exactly).
- A sync or "Propose a fix" of a **linked** event whose name still ends, after its **last** `–`, with the tail the
  bridge wrote, rewrites that tail to the row's current Date cell (capped as before at 500 characters), in the same
  proposal as any date change; a row that has become plain (readable without the qualified reader) drops the tail and its
  `–`. The opening words are never touched. An unlinked event, an event the owner renamed (its tail is no longer the
  bridge's), and an event whose `–` came from anyone else are never renamed.
- Wording alone (the date unchanged) is a `name_drift` finding on the row (audits: `chronology_name_drift`), fixed by
  "Propose a fix" as a name-only update.
- The proposal says it: `name: "… – c. 4A 563; exact date unresolved" → "… – Isar 3rd, 4A 563; exact day disputed"`.

Note on the brief's example: `Isar 3rd, 4A 563` on its own is a plain date, so by the brief's own rule the tail is
**dropped**, not rewritten; with a qualifier (`Isar 3rd, 4A 563; exact day disputed`) it is rewritten. Both are tested.

## Decision 2: Last Major Revision on every substantial edit (owner, 16 November 2026)

"ANY substantial edit to a page should automatically include a call to set the sidebar's Last Major Revision."

**What counts**, each category a per-project on/off setting (Projects page), with the owner's defaults:

| Category (setting)                   | Default | What                                                                                                                                                                                    |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lmrWritePage`                       | on      | `write_page`, any mode                                                                                                                                                                  |
| `lmrBlockEdits`                      | on      | block edits through `lk_api_write` / `lk_api_batch` (insert, replace, update, delete a block, `replaceDocumentBlocks`; block rows and infobox rows), and the dashboard's own text fixes |
| `lmrChronologyTable`                 | on      | chronology table row changes (`create_` / `update_` / `delete_timeline_event` on the table) and the count fix                                                                           |
| `lmrRestore`                         | on      | a restore that changes text                                                                                                                                                             |
| `lmrPackTools`                       | on      | setting-pack tools (none exist yet: a write they plan names its `pack` in its journal operation)                                                                                        |
| `lmrFacts` (+ `lmrHousekeepingKeys`) | on      | a fact's value through `set_facts`, except the housekeeping keys: `Last Major Revision; Reference Type; Supersedes; Status`                                                             |
| `lmrNamesTagsMoves`                  | off     | tag, alias, icon or name changes; moves and re-orders (of pages, and **chosen**: `moveBlock`)                                                                                           |
| `lmrLinkCollections`                 | off     | link-collection-only changes (Dependencies, Related Sources)                                                                                                                            |
| `lmrTimelineMap`                     | off     | timeline events, lanes and map features on their own                                                                                                                                    |
| `lmrAuditSplit`                      | off     | an audit's paragraph split (the content is unchanged)                                                                                                                                   |

Whitespace-only or unchanged writes write nothing, so they set nothing (the decision step sees an `unchanged` result).
**Chosen**: a page created in the same request is left alone (it is new, not edited); row writes other than `set_facts`
(a raw `updatePropertyRow`, a create tool's facts, a restore's sidebar) are not "a fact's value through set_facts"; a
restore rehearsal never sets it (it must reproduce the snapshot exactly); a request that sets the row itself is left
alone.

**How.** The engine asks one planner (src/lmr/, hooked in `JobEngine.run` and `submitBatch`) about every caller's write
request; never about approved work (its approval covers exactly the stored steps) and never twice. The planner reads
nothing: from the request's operations, the tool that made them and the repository tree's sidebar summary it appends
two steps to the same job, and so to the same proposal:

1. `bridge.lmr` (a new internal step, reads only): today on the bridge's clock, Europe/London, `YYYY-MM-DD` (Arkona's
   form), worked out **when it runs** (for a proposal, the day it is approved and applied; the summary says
   `+ Last Major Revision → date of approval`). Its If-Match: the new version (or ETag, `useEtagVersions`) of an earlier
   row write of the same property in the job when there is one, else the version one read of the rows gives inside the
   job. It skips when the edit wrote nothing, the page has no such row (a page the tree has not read yet costs one read
   of its sidebar to find out; a page outside the tree is skipped), or the row already says today.
2. `updatePropertyRow` of that row, its path and body bound to the decision (`decisionFrom`), skipped when the decision
   says so.

Pages whose tree summary has no such row (indexes, AI REPOSITORY tabs) get no steps at all. A job that holds job-level
locks (a chronology job holds only documents) also holds the page's. The canon guard does not judge the planned row at
entry (it is not a protected fact); it still judges the bound write inside the lock.

**Never blocks the edit.** Both steps carry `followUp: 'lmr_failed'`: a failure is recorded on the step, in the errors
table and in the job's result (`followUps`), the job carries on and ends succeeded, and the content stays written. No
rollback. It applies to every agent and the dashboard's own fixes, at any scope. The lifecycle tools keep setting it
themselves (their jobs are left alone).

## Decision 3: "Make default" on the Projects page

- The default project is stored in the database (`projects.is_default`): **Make default** on a project row, with a fresh
  re-authentication, audited `project.make_default`. The registry answers from it at once: no restart.
- `LK_DEFAULT_PROJECT` stays an override: while it is set and names a served project that is not the stored default, it
  wins, and the page says "The env file's `LK_DEFAULT_PROJECT=…` overrides this; remove that line to use the dashboard's
  choice." The env no longer overwrites the stored default at start (a database with none stored takes the effective one
  once, so the choice starts where it was). With several projects listed, `LK_DEFAULT_PROJECT` is now optional.
- `env-sync.sh --retire-default-project` comments the line out once the stored default agrees (the bridge, as the service
  user, says which it stored: `npm run projects -- stored-default`); a disagreeing or absent stored default is refused
  and named. The same pattern as `--retire-imported-keys`.

## Decision 4: a partial snapshot's missing pieces are shown

The Snapshots page expands a partial snapshot's row to list each missing piece (page link, piece, reference, reason),
read from its manifest once per request (only partial snapshots are read; at most 200 listed, the rest counted).
`list_snapshots` gives them in summary form per snapshot: `missing: { total, thisPage: [{ piece, ref, reason }],
otherPages }`.

## Decision 5: a page deleted in the app is restored from a snapshot (ADR 0046 decision 4, the owner's amendment)

`restore_snapshot` (scope `deleted`) no longer refuses a page the bridge holds no delete record of. When a full or change
snapshot holds the page, the lifecycle guard judges the undelete from the newest snapshot's state (its name with its
prefix, its parent, its tags), as it judges a create of that page; the canon guard judges the sidebar the page comes back
with as a new page's facts, so an Authoritative page comes back only as a canonical proposal. Refused only when no
snapshot holds it. The proposal's summary names the snapshot and when it was taken (`… to the full snapshot
20261116T… (taken 2026-11-16T…)`). The page name a restore shows is the page's own (its resource piece's), never a
document's (a bug found here).

## Decision 6: finishing a part-made recreate (E4-OPEN-1)

A recreate's target page id is minted when its proposal is captured and kept with its restore record (its own id, or the
id map's new one). When the same request is made again (or **Finish** on the Snapshots page's restores list, audited
`snapshots.finish_recreate`) and that page exists, the restore compares it with the snapshot and plans only what is
missing: a document of that type and name it lacks (created, with its content), a page document still blank, a map's
features, a timeline's lanes and events, a board's content, and sidebar properties it lacks. Nothing is written twice,
and no second page or document is ever made; when nothing is missing the answer is `nothing_to_do`. The content writes of
a recreate are now one helper shared by the recreate and the finish.

## Decision 7: LS1's clean-up, and one region polygon form

1. **LS1.** "The feature removed with its throwaway page" is a successful clean-up (PASS with a note), not FAIL:
   LegendKeeper also refuses `deleteFeature` on such a map; `docs/reviews/lk-bug-labelsize.md` says so.
2. **The region polygon form (chosen: clear it).** The owner's M6e run showed that `polygon: []` clears the old single
   shape cleanly, so a region written with `polygons` that still carries a `polygon` now has it cleared (`polygon: []`),
   not set to the first of the polygons as E4 did: the region is stored with one shape. The map sandbox check M6d now
   expects the old `polygon` gone. Cosmetic either way.

## Decision 8: the timing-sensitive maintenance test is deterministic

`test/maintenance/jobs.test.ts` (the file using `m.rig.h.clock`) failed once under load: its setup sent real requests to
the mock LegendKeeper and waited for them in real time. It now runs on the fake clock alone: journal entries are recorded
directly, proposals are captured from creates (which read nothing at capture), and the executed proposal's job is made
while writes are paused (queued, never sent), so no request reaches the mock and nothing waits in real time.

## Decision 9: asset folders are found or created when the job runs (owner's report, 16 November 2026)

**The cause, as found in the code.** Confirmed as the brief describes: `ImageService.place` turned `plan.wouldCreate`
(worked out when the call was made) into plain `createAssetFolder` steps, and `JobEngine.submitUpload` did the same for an
upload's `createFolders`. Each of two placements planned while a chain was missing created it in its own job; nothing
re-checked at run time or serialised folder creation, and LegendKeeper accepts two folders of one name under one parent.
Two further details: the planner reused a folder **ignoring case** (`nameKey`), while LegendKeeper keeps names byte for
byte; and a proposal captured at `propose` scope ran its folder steps verbatim on approval.

- A `createAssetFolder` the bridge planned carries `findOrCreate`. When the job runs, under the project's asset-folder
  lock (`<project>:asset-folders`, the engine's existing lock manager, held for that step only, never for the upload),
  the parent's children are listed fresh; a folder whose name is **exactly** the planned one is used (the step succeeds
  with its id, `found: true`, nothing sent, a journal entry `found existing folder` with outcome `not_applied`), and only
  otherwise is one created (journalled `created folder`). The steps after it bind the id the same way in both cases, and
  the verify checks the folder actually used. A raw `createAssetFolder` through `lk_api_write` keeps its plain meaning.
- The planner compares folder names byte for byte too, so a folder differing only in case or a trailing space is another
  folder, and the plan (and proposal) says a new one will be made.
- The job's result lists each planned folder: `foldersUsed: [{ name, id, outcome: "found existing folder" | "created
folder" }]`. The proposal still says "create folder …" (the plan when it was written).
- Two proposals approved one after the other, two jobs at write scope together, or one batch with two placements to one
  missing path: one chain. A parent deleted between planning and running fails with LegendKeeper's own error and creates
  nothing.
- **Duplicate asset folders** (audit finding `duplicate_asset_folders`, category `assets`, read-only, from the bridge's
  asset tree): two or more sibling folders with exactly the same name, with each one's path and how many assets it holds.
  Its fix (`merge_asset_folders`, one proposal): the later duplicates' assets moved into the earliest (by when the bridge
  first saw each), matched folder by folder down the chain, then each emptied duplicate deleted, deepest first, each only
  if it is empty when the job runs (`onlyIfEmpty`: a folder filled since is skipped, never deleted with what is in it);
  pre-images journalled as for any `updateAsset` and `deleteAsset` (whose bytes are kept). A same-named asset is moved,
  never deleted, and the proposal says so. A duplicate that would still hold something (a subfolder with no match) is never
  deleted.

## Decision 10: unapproved images wait on the bridge's server (owner, 16 November 2026)

Arkona's Visual References standard ("Intake and approval") keeps unapproved images out of LegendKeeper Assets, with no
staging image folder there. This supersedes ADR 0041 decision 7 and the owner's D3 approval of the folder.

- **Staging** converts as before and keeps the WebP on the bridge's own disk (`images/staged/`, content-addressed by
  SHA-256; **chosen**: not the snapshot store, so staged images are in no snapshot and no off-site copy), with its SHA-256,
  size, dimensions, intended destination and extension-free name (`image_uploads.server_sha256`, migration 2900).
  Nothing is sent to LegendKeeper. A new staging upload is refused (`STAGING_DISK_LOW`) when the disk is below
  `IMAGE_STAGING_MIN_FREE_GB` (5).
- **Placing** (on approval, at `propose`) is ONE batch job: the folders found or created (decision 9), `createImageUpload`,
  the signed PUT of the server's bytes (`upload_image.put` reads them by hash when it runs; a bridge-built batch may now
  carry the upload's two custom steps), `createImageAsset` with the final `folderId` and extension-free name, the stored
  file's SHA-256 checked (`upload_image.verify`), and the asset read back (folder, name, not hidden). The hide-and-move
  steps are gone. The server copy is removed once the image is placed. At scope `propose` the placement batch is a
  proposal (the gate's new `stagedPlacement` context; any other upload stays refused at `propose`).
- `staged_id` works exactly as before for agents, proposals and the Staging page (the same tools, ids and page). The
  Staging page's thumbnail is the bridge's own copy, served by the dashboard behind the owner's session
  (`GET /api/admin/staging/:id/image`). Discard deletes the server copy.
- **Retention**: older than `IMAGE_STAGING_REPORT_DAYS` (30) is reported, as before. Past `IMAGE_STAGING_MAX_DAYS` (90;
  per project `imageStagingMaxDays` on the Projects page) an unplaced image is first warned about on the Staging page
  (with the date it goes) and removed from the server a week later (the hourly sweep).
- **The old folder**: `npm run images -- migrate-staging --project <name>` (as the service user) writes a request; the
  running bridge (which holds the key) runs it within a minute and the command prints what it did: each staged record in
  the old folder has its bytes downloaded (checked against its SHA-256) and kept on the server, the record keeps its
  staged id; then ONE proposal deletes the hidden assets (`deleteAsset` keeps their bytes as usual) and, when nothing
  else is in it, the folder. It never deletes without a proposal and is idempotent (copied records are not copied again;
  while its proposal is pending nothing new is proposed). Anything it does not know is listed and left alone. The
  `imageStagingFolder` setting retires once the folder is gone.
- **Left in LegendKeeper (chosen, for now)**: the image restore of E1a still stages its image hidden in LegendKeeper,
  because its proposal rewrites page references to the new asset's URL, which only exists once uploaded. A later session
  can move it to upload-on-approval with the URL bound in the job.

**The Visual References upload order, checked against D3's code:**

1. Subject and role, and the destination folder resolved deterministically: **already done** (the planner refuses an
   ambiguous folder, `AMBIGUOUS_FOLDER`, and never guesses). **Gap fixed**: an image is never placed in the library's root
   (`DESTINATION_IS_ROOT`).
2. A collision check on the display name in that folder: **gap fixed** (D3 had none): a name already there is numbered,
   `Name (2)`, `Name (3)`, compared exactly.
3. WebP bytes, content type, length and SHA-256 from the converted bytes: already done.
4. Find or create the folders: already done at plan time; **gap fixed** by decision 9 (at run time, serialised).
5. Upload with the final `folderId` and an extension-free name: **new** (it was hidden in the staging folder, then moved).
6. Verify: already done (the stored file's SHA-256), and now the asset's folder and name too.

## Decision 11: a ChatGPT conversation attachment as `upload_image`'s `file`

ChatGPT's code environment cannot reach the bridge (`prepare_image_upload`'s scripts fail), `data_base64` is unusable for
real images, and an attachment has no public URL. ChatGPT's supported route (OpenAI Apps SDK, "Define file inputs"): a
tool lists its file inputs in `_meta["openai/fileParams"]`, and ChatGPT replaces an attachment passed there with
`{ download_url, file_id, mime_type?, file_name? }`.

- A fifth source, `file`: `{ download_url (required), file_id (required), mime_type?, file_name? }`,
  `additionalProperties: false`. The exactly-one-source rule covers five sources. One file per call.
- `upload_image`'s descriptor carries `_meta: { "openai/fileParams": ["file"] }`. **The MCP SDK in use
  (`@modelcontextprotocol/server` 2.4.0) passes a tool's `_meta` through unchanged**: `registerTool` takes `_meta` in its
  config and `tools/list` returns it as given. The bridge only had to pass its own `meta` field through
  (`McpToolProvider.meta`); no SDK change. Claude ignores it.
- The download happens during the call, at every scope, through the `url` source's guarded transport (whatever
  `UPLOAD_ALLOW_URL_SOURCE` says): https only, public addresses only, the port allow-list, the DNS answer pinned, no
  credentials and never the LegendKeeper key, `UPLOAD_MAX_BYTES` while streaming, a timeout, at most 3 redirects with every
  hop re-checked. At `propose` the bytes are staged at once (decision 10) and only the placement waits. Any declared
  content type is accepted (the file store may answer `application/octet-stream`); `mime_type` is never trusted: the magic
  bytes decide. Then the existing pipeline: WebP, deduplication, destination, `stage`, proposal. The source is recorded as
  `chatgpt_file` (no migration: the column has no constraint).
- The name: `name` if given, else `file_name` with its extension dropped, else `INVALID_REQUEST` asking for `name`.
- `download_url` is a capability: never logged, stored, journalled or returned. The answer says `file: { id, host }`; the
  request record (`operation_id`) hashes `file_id`, so a fresh link with the same `operation_id` is the same request; the
  tool-call log keeps only an object's size, as for every argument.
- A link that answers 401, 403, 404 or 410 is `FILE_URL_EXPIRED`, with the hint "Call upload_image again with the same
  attachment so ChatGPT issues a fresh link; if that fails, ask the user to attach the image again." Never retried.
- `prepare_image_upload`'s description: "Not for ChatGPT or any assistant whose code environment cannot reach the bridge:
  ChatGPT uses upload_image's `file`." The tool count does not change.

## Consequences

- Every substantial edit of a page with the row costs one more write (and usually one read). `set_facts` chains (no
  read). A proposal of an edit carries two more operations (shown as one summary note).
- Staging costs nothing in LegendKeeper; placing a staged image costs the upload's two writes, a read and a download
  (instead of a move and a hide). The old staging folder is migrated once, by the owner.
- `LK_DEFAULT_PROJECT` can be retired; the dashboard owns the default.
- New audit category `assets` (duplicate folders). The audits read the bridge's asset tree for it (no request).
- Tests: Last Major Revision (`test/lmr`), the name tail (`test/chronology/name-tail.test.ts`), Make default
  (`test/secrets/make-default.test.ts`, `test/unit/env-sync.test.ts`), missing pieces (`test/snapshots/e5-4.test.ts`), a
  page deleted in the app (`test/snapshots/deleted-in-app.test.ts`), finishing a recreate
  (`test/e4/rv4-recreate-resume.test.ts`), server staging and migrate-staging (`test/images/staging*.test.ts`,
  `test/images/migrate-staging.test.ts`), folders (`test/images/folder-race.test.ts`,
  `test/images/duplicate-folders.test.ts`), ChatGPT files (`test/images/chatgpt-file.test.ts`), LS1
  (`test/unit/ls1-cleanup.test.ts`).

## For the owner after deploying

1. Projects page: **Make default** on arkona; the page notes the env file's override. Run
   `sudo /opt/lk-bridge/bin/env-sync.sh --retire-default-project` and check that the note goes.
2. Have Claude make a one-sentence `write_page` edit to a test world page, approve it, and check that its Last Major
   Revision is today.
3. Snapshots page: a partial snapshot's row lists its missing pieces (if there are any).
4. `sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run images -- migrate-staging --project test`, then
   `--project arkona`; approve the proposals it makes; check that `LK-Bridge staging` is gone from LegendKeeper.
5. Stage a small test image on the test world: nothing new appears in LegendKeeper until its placement is approved.
6. ChatGPT: refresh the bridge connector (it reads the new tool list); use the web or desktop app (mobile uploads are
   reported to send incomplete file references); attach one image and ask it to upload it to the test project with
   `stage: true`: it appears on the Staging page.
