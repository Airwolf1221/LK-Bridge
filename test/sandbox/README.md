# Sandbox tests

Opt-in checks against a real LegendKeeper **sandbox** project (never Baisheng or Arkona). Excluded from `npm test` and from public CI.

v2 A1: the target is a project the bridge serves **and that is marked as a sandbox** in the bridge's database
(`npm run projects -- sandbox <name> on`; [docs/projects.md](../../docs/projects.md)). The key is that project's own,
found as the bridge finds it (OPS2, `target.ts`): the key in the bridge's encrypted store (opened with
`SECRETS_MASTER_KEY`), or, only when nothing is stored for the project, `LK_PROJECT_<NAME>_API_KEY` (`LK_API_KEY` in the
single-project form). With `LKB_ENV_FILE` set, those few names are read from that file (the wrappers do this);
otherwise from the environment. `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID` are retired.

```bash
DB_PATH=… LK_PROJECT_TEST_API_KEY=… LKB_SANDBOX_PROJECT=test npm run test:sandbox
```

```bash
DB_PATH=… LKB_ENV_FILE=/path/to/lk-bridge.env LKB_SANDBOX_PROJECT=test npm run test:sandbox
```

On the server, as the service user, with no workaround (C2d):

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test
```

`lkbridge` cannot write to `node_modules` (it belongs to the build user), so nothing in the run writes there:
**Nothing is written under the app folder** (the owner's runs of 11 and 12 November 2026). Besides `node_modules` (below), the
sandbox runtimes keep their image directory in their own temporary directory (`createSoakRuntime` sets `images.dataDir`), and
the runtime derives the default one from the database it was given, never from the config's `./data/bridge.db`, which is under
the app folder owned by the build user: all five files once failed in their first second with `EACCES: mkdir
'/opt/lk-bridge/app/data/images/upload-tmp'`. `upload-tmp/` is created only by the first upload. v2 E1a: the snapshot
store (which also holds the bytes kept before a delete, formerly `kept-bytes/`) is in the same temporary directory
(`snapshots.dataDir`). `test/tools/sandbox-runtime-readonly.test.ts` (with `soak-runtime-readonly.test.ts`, its inner half, which does nothing
unless that test starts it) builds the sandbox runtime under Node's permission model with the app folder read-only. A
verdict **NOTED** in a report is a fact about LegendKeeper the run records (a refusal the bridge works around), never a failure.

`npm run test:sandbox` loads `vitest.sandbox.config.ts` with `--configLoader runner` (evaluated in memory; the default
loader wrote a bundled copy to `node_modules/.vite-temp` and failed with `EACCES` on the owner's first run, 11 November
2026), and the config switches off Vitest's module cache (`fsModuleCache: false`, which removes the "could not create
.vitest-cache" warning) and its results cache. `test/tools/sandbox-config-readonly.test.ts` runs the command in CI under
Node's permission model with every write outside a temporary directory refused. The sandbox runtimes keep no secrets (a
temporary database; the project's key is handed to them), so they no longer warn that `SECRETS_MASTER_KEY` is not set;
the wrapper still keeps the master key out of every environment. The soak, spike and round-trip wrappers run `tsx`
scripts with no TypeScript config (tsx caches in the system's temporary directory), so they needed no change. Without
`LKB_SANDBOX_PROJECT` the suite is skipped. It **refuses to run** unless the project is marked as a sandbox and the key's own project (from `listProjects`) is exactly that project's stored id (`target.ts`). Everything it creates lives under one throwaway resource that is deleted (cascade) at the end; if that fails the report says which id to delete by hand.

The report (printed at the end) states each item as PASS, FAIL, INCONCLUSIVE or SKIPPED:

- **(a)** LK echoes a client-supplied `x-request-id` (ADR 0010 assumes it does);
- **(b)** the `version` on `getBlock`, `listBlockRows` and `listBlockProperties` reads equals the document version, and a row version works as `If-Match`;
- **(c)** `createManyResources` failing part-way: skipped (it cannot be tested safely); see ADR 0010 and `test/jobs/batch-recovery.test.ts`;
- **(d)** create / read / update / delete for resources, documents, blocks and rows, infobox properties, sidebar properties, timelines, map features, boards, asset folders and calendars, plus the read-only families;
- **(e)** image upload end to end;
- **(f)** a template round trip.

(a) and (b) are assumptions: a FAIL is reported but does not fail the run; a failing family (d, e, f) or leftover does. The script's logic is dry-run against a mock in `test/tools/sandbox-dryrun.test.ts`.

## The soak (chunk 8)

`npm run soak:sandbox -- --project <name> [--writes N]` (on the server: `deploy/soak-sandbox.sh --project test`) runs about 1,000 writes and a matching
mix of reads through the real engine and governor against the same sandbox project, under one throwaway root resource
that it deletes at the end, and reports the time taken, writes per minute, 429 responses (target zero), retries, budget
waits and peak memory. Same guard as above. Code: `soak.ts`; dry run against the mock: `test/tools/soak-dryrun.test.ts`.
How to run it, and why it takes about 20 minutes: docs/runbook-deploy.md, "Soak test".

## The write-scope rehearsal (v3 F3.4)

`npm run rehearse:write-scope -- --project <name>` (on the server: `deploy/rehearse-write-scope.sh --project test`)
rehearses scope `write` before an agent's profile is raised to it (ADR 0055 decision G): as a temporary write-scoped
agent it edits a sentence, changes a fact, fixes a throwaway chronology event and places a staged image (each a direct
write), checks that a pack package is still a proposal, reverts the four and reads each target back, and checks that a
delete and an 11-page batch become proposals under the default rails; then it cleans up. Same guard as the soak. Its
temporary database starts as a read-only copy of the project's settings, repository tree and packs from the bridge's
database (`copyBridgeState`). Code: `write-scope.ts`, `scripts/rehearse-write-scope.ts`; dry run against the mock:
`test/review/rehearsal-dryrun.test.ts`. How to run it: docs/runbook-deploy.md, "Write-scope rehearsal".

## The v2 phase 0 spike

`npm run spike:v2 -- --project <name>` (on the server: `deploy/spike-v2.sh --project test`) is a read-mostly script that checks ten
assumptions of docs/PLAN-v2.md against the test world and prints a Markdown report (PASS / FAIL / INFO with evidence).
Only check 1 writes (a `createManyResources` batch whose parents are minted in the same batch), under one throwaway root
that is deleted at the end, even after a failure. Same guard as the soak; every call goes through the real engine and
governor at P3. Code: `spike-v2.ts` (checks), `spike-report.ts` (report layout); dry run against the mock:
`test/tools/spike-v2-dryrun.test.ts`. How to run it: docs/runbook-deploy.md, "Phase 0 spike".

## The write layer's assumptions (CR-2026-11)

`npm run test:sandbox` (with `LKB_SANDBOX_PROJECT`, as above; on the server `deploy/sandbox-test.sh --project test`) also
runs `assumptions.test.ts`; `npm run test:sandbox -- assumptions.test` runs it alone (`-- assumptions` also runs round
2, below). It checks, on the real API, every
assumption the write layer makes about LegendKeeper that was only ever checked against the mock: the list, with what
breaks if one is false, is [docs/reviews/CR-2026-11.md](../../docs/reviews/CR-2026-11.md), section 6. Each check
prints PASS, FAIL or INCONCLUSIVE with what LegendKeeper answered; the run fails if any assumption FAILs or the
clean-up does.

- **What it creates:** one throwaway root resource named `lk-bridge assumptions <time>` with about 60 pages under it
  (plain names, no `[BSRC]`/`[BWRK]`/`[BARC]`/`[INDEX]` prefix, no Status, Continuity Type or Continuity row, so the
  canon and lifecycle guards never stand in the way), three templates (`lk-bridge assumptions template A1`, `… A2` and
  `… H1`, the last with one page under it), and documents, rows, a link collection and a text field on its own pages.
- **What it cleans up:** everything, at the end, even after a failure: each check's pages (one small cascade each), the
  three templates, then the root. A delete the canon guard could not judge for lack of budget is tried again after a
  minute (up to three times). If something is left, the report names each id to delete by hand.
- **Cost:** about 100 writes and up to about 500 reads (measured against the mock: 102 and 485, which includes the mock
  world's repository tree re-reading every page written; the sandbox runtime has no tree; 117 and 589 since
  CR-2026-11-R2, whose lifecycle guard reads a copy's template and, in the mock world, where each new page lands; on
  the real API about 8 more reads, two for each template copy), plus up to 12 search polls
  while it waits for new text to become searchable. The clean-up's cascades are most of the reads: the canon guard lists
  and reads every page of a cascade at entry and again inside the lock. A few minutes at the bridge's write pacing.
- **Dry run:** `test/tools/assumptions-dryrun.test.ts` runs the same script against the lifecycle test world's mock, to
  check that every check runs to an answer and the clean-up works (the mock does not model every behaviour, so some
  checks FAIL there; that is expected and shows which behaviours only the real API can confirm). A second dry run
  answers as the real API did on the owner's run and checks the corrected checks below pass.
- **Corrected after the owner's first run (C2d, 11 November 2026):**
  - **A1:** LegendKeeper reuses the template's property, row and item ids in a copy. That is its behaviour, not a
    failure: the check passes and notes the reused ids (the bridge keys everything of a page by the page and the id
    together, ADR 0037).
  - **B12:** makes its own page, property, row create and row update (it used to rely on B11, and came out INCONCLUSIVE),
    and checks each write's answered version (in its body, which the bridge chains from) against the next read; an ETag
    header is reported alongside.
  - **B16:** expects the trimmed form: LegendKeeper trims a leading or trailing line break from a row value (the OpenAPI
    schema). It sends two at each end and says plainly if only one is trimmed (the bridge trims them all).
  - **Clean-up:** a page that is already gone (404, or "… is already deleted" after an earlier cascade) counts as
    cleaned; any other failure is confirmed by a read before it is reported as left over.
  - B12 adds a page, a property and two row writes: about 104 writes in all.
- **B12 again (D1.1, 11 November 2026, [ADR 0039](../../docs/adr/0039-date-styles-timeline-repair-and-etag-versions.md)):**
  the owner's run showed that a row write answers no version in its body but an `ETag` header (and a delete answering
  204 one too). The bridge now uses that ETag (unquoted) as the write's new version for the next chained If-Match
  (project setting `useEtagVersions`, default on). B12 therefore asserts, for a row create, a row update and a row
  delete, BOTH that (1) the ETag equals the version the next `listPropertyRows` gives and (2) LegendKeeper accepts it as
  `If-Match` (it is sent instead of the version read). It reports PASS only if both hold for all three, and says
  plainly which half did not. **If B12 fails on the real API, switch `useEtagVersions` off** (Projects page, or
  `npm run projects -- set <project> useEtagVersions off`): the bridge then re-reads, with no deploy. B12 now makes a
  create, an update, a delete and a second create: about 106 writes in all.

- **LS1, LegendKeeper's label sizes (v2 E5.4, [ADR 0046](../../docs/adr/0046-e4-owner-decisions.md) decision 14):**
  on a page of its own under the root (its first, blank document), it writes ONE label with `labelSize: 'md'`, raw
  through the governor (the bridge's engine refuses any label size). It expects `listFeatures` to answer 400 with an
  issue on `labelSize` ("Invalid enum value. Expected 'small' | 'medium' | 'large'"): **PASS** means the bug is still
  there. If `listFeatures` answers 200, it reports **NOTED**: LegendKeeper has fixed it, and `LABEL_SIZE_WRITABLE` in
  `src/maps/features.ts` can be set to true. It then deletes that feature by its id, even if the check failed, and checks
  that `listFeatures` answers 200 again (a FAIL if not, naming the feature to delete by hand). Two writes and two reads
  more: about 108 writes in all.

- **LIM1, LegendKeeper's own limits on its asset routes (v2 E5.5, [ADR 0047](../../docs/adr/0047-learned-operation-limits.md)):**
  runs FIRST, while the key's write minute is nearly unused, so each answer's headers name the asset route's own tier
  (LegendKeeper reports the tier with the fewest requests left). It (1) creates an asset folder
  (`lk-bridge assumptions LIM1 <time>`), (2) uploads one 70-byte PNG into it (`createImageUpload`, the signed PUT through
  the governor as the bridge's upload step sends it, `createImageAsset`), (3) deletes the image and then the folder, by
  id, even after a failure, and (4) records the `X-RateLimit-*` headers each answered as **NOTED**: the limit, the
  remaining count, the reset and the window it implies (for example "createAssetFolder 201: limit 20, remaining 19, reset
  in 58 s (a minute window)"; the PUT usually answers with no rate headers), followed by what the bridge learned from
  them ("assets 20 a minute (seen on createAssetFolder, createImageUpload, createImageAsset); assets 60 a minute (seen on
  deleteAsset)"). Send the owner's LIM1 line to document the real figures. INCONCLUSIVE if a step could not be made; FAIL
  only if the clean-up failed (the report names the asset to delete by hand in the asset library). The signed URL is
  never printed. Five writes and one PUT to the upload host more: about 113 writes in all. The dry run models the asset
  routes' tiers at 20 and 60 a minute and checks the line.

## Round 2: the newer code's assumptions (CR-2026-11-R2)

`npm run test:sandbox -- assumptions-r2` (on the server `deploy/sandbox-test.sh --project test -- assumptions-r2`) runs
`assumptions-r2.test.ts` alone, with the same guard as the smoke. It checks, on the real API, what the code merged since
CR-2026-11 assumes about LegendKeeper and no other sandbox check confirms, and what the second review's own fixes assume:
the list (W1 to W18), with what breaks if one is false, is [docs/reviews/CR-2026-11-R2.md](../../docs/reviews/CR-2026-11-R2.md), section 6. Each check prints PASS,
FAIL, INCONCLUSIVE or NOTED with what LegendKeeper answered; the run fails if any check FAILs or the clean-up does.

- **The asset library** (W1 to W6): an image moved between two throwaway folders (its file downloaded before and after),
  `updateAsset` partial and needing no If-Match, a hidden image listed in its folder, what a delete of a folder holding a
  sub-folder does (NOTED), an image delete, and the root listing.
- **Table rows and nested blocks** (W7 to W11), written exactly as the chronology and Revert write them: a row inserted
  after another, moved (and a stale If-Match: 412, nothing moved), replaced and deleted; `getBlock` of a paragraph in a
  table cell (the read before a direct `updateBlock`, ADR 0055 decision E); `updateBlock` with only `content`.
- **`listEvents` pages** (W12): three events read two at a time through the cursor.
- **What the second review's fixes assume** (W13 to W18): a template saved from a page carries its tags, `getResource`
  answers the template and a copy takes its tags (the lifecycle guard's copy check); `createManyResources` with an id
  already held makes none of its items; a template that does not exist reads 404 and is not copied; an event reads back
  exactly as its write answered it; a move answers the rank `getResource` then gives (Revert's comparisons);
  `getResource` of `templates` answers 404 (the guards read that virtual parent live), and what a move of a page there
  does (NOTED).
- **What it creates and cleans up:** one throwaway root `lk-bridge assumptions-r2 <time>` with nine plainly named pages
  under it (a table page, a timeline page, `W13 source` tagged `lkb-w13` and its copy, `W14 held`, `W17 parent` with two
  pages, and `W18 page`), one template `lk-bridge assumptions-r2 template W13` (outside the root, as templates are), four asset
  folders `lk-bridge assumptions-r2 F1 <time>` to `… F4 <time>` and one 70-byte PNG; everything is deleted at the end,
  even after a failure, and the report names any id left to delete by hand.
- **Cost:** 52 writes and 121 reads, 3 downloads from the asset host and 1 PUT to the upload host (counted against the
  mock); about a minute.
- **Dry run:** `test/tools/assumptions-r2-dryrun.test.ts` runs it against the image test world's mock three times: once
  answering as the spec says (every check PASS or NOTED), once answering otherwise for W1 to W12 and once for W13 to
  W18 (each check FAILs, notes or is INCONCLUSIVE where it should, and the clean-up still works). It also checks that
  another project is refused before anything is written.

## Round 4: after the owner's run of the third review's checks (19 November 2026)

`npm run test:sandbox -- assumptions-r4` (on the server `deploy/sandbox-test.sh --project test -- assumptions-r4`) runs
`assumptions-r4.test.ts` alone, with the same guard as the smoke. Written for the owner; never run by an agent or in CI.

- **Y1** (X6's follow-up): whether a board's, a map's and a timeline's own `updatedAt` (in `getResource`'s document list
  and in `getDocument`) moves on a content edit, NOTED; PASS when the content read shows the edit. The retag read-back
  compares their content now, so it is right either way.
- **Y2** (X2's follow-up): a custom mention label, in a paragraph and in a table cell, reads back as sent, and the generic
  verify finds the document as sent (a mention sent without a label is filled in by LegendKeeper and ignored).
- **Y3** (X5's follow-up): one block id in two documents of one page: `getBlock` answers each document's own, and
  `updateBlock` on one leaves the other as it was.
- **What it creates and cleans up:** one throwaway page `lk-bridge r4 check <time>` with two page documents, a board, a
  map and a timeline; deleted (cascade) at the end, even after a failure. About 25 writes and 30 reads.

## The chronology (v2 D1)

`npm run test:sandbox` (on the server `deploy/sandbox-test.sh --project test`) also runs `chronology.test.ts`;
`npm run test:sandbox -- chronology` runs it alone (on the server `deploy/sandbox-test.sh --project test -- chronology`,
which runs nothing that writes). It is **read-only**: it writes nothing (the run fails if the
transport counted a single write). It checks the calendar engine and the chronology against the real tables and
timelines of every age (the oracle in `test/fixtures/calendar/oracle.json` covers 330 Fourth Age events; this covers all
six ages):

1. every row of every age table: the Date cell parses; the engine's KCY equals the KCY cell byte for byte (in the style
   the tables show most); the engine's date text equals the Date cell, or the difference is listed. Every failing row
   is listed with its exact text, and the distinct shapes of the Date and KCY cells are summarised (digits as `9`,
   words as `Word`);
2. every timeline event: LegendKeeper's `formattedStart` (and `formattedEnd`) read back to exactly its minutes and
   detail, and its minutes formatted back to exactly that text, **in LegendKeeper's style** (no thousands separator in a
   year: `AA 1988119`; the tables' cells, in check 1, are compared in the table style, `AA 1,988,119`: the owner's run
   of 11 November 2026 settled this, [ADR 0039](../../docs/adr/0039-date-styles-timeline-repair-and-etag-versions.md));
3. every age: one lane; every event's `uri` points at its age's table; the Main links; rows in calendar order;
4. **drift**, under its own heading (reported, not a failure of the engine): rows without an event, events without a
   row, a row and its event disagreeing about the date or shape, and the Main count against the rows and events. Rows
   and events are paired as the chronology check pairs them (links, date and name, date alone, then a same-event date
   mismatch). The result line says "PASS (the engine, both date styles and the structure)" and counts the drift
   findings; the dashboard's chronology check lists the same ones, each with "Propose a fix".

- **Which chronology:** the one the owner confirmed on the dashboard (the bridge's stored settings), else
  `LKB_CHRONOLOGY_RESOURCE`, else the test world's Universal Chronology (`h0gczxh7`).
- **Cost:** about 15 reads plus one per 100 events (the test world: about 25), at P2.
- **Dry run:** `test/chronology/sandbox-dryrun.test.ts` runs the same check against the mock chronology.
- **As the service user:** the package script loads the config with `--configLoader runner` and the config turns
  `fsModuleCache` off, so nothing is written under the release's `node_modules`.

## Waiting for parked writes (the owner's run of 12 November 2026)

The sandbox files run **one after another** (`fileParallelism: false` in `vitest.sandbox.config.ts`). In parallel the
smoke and assumptions tests shared the test project's 120 writes a minute; the smoke test's writes were parked
(`waiting_budget`), it reported them as failures instead of waiting, and it left its throwaway page and image behind.
Now every script settles each operation through `wait.ts`: a read refused for budget is made again when the budget
allows; a write parked for budget or queued behind the pacing is **waited for** (up to 10 minutes) and never sent again,
in the clean-up too. `test/tools/sandbox-dryrun.test.ts` and `test/images/sandbox-dryrun.test.ts` check it against the
mock, which throttles a write and the clean-up for longer than the governor waits inline, so both are really parked.

## The image pipeline (v2 D3)

`images.test.ts` (on the server `deploy/sandbox-test.sh --project test -- images`) **writes, then cleans up**
([ADR 0041](../../docs/adr/0041-image-pipeline.md)). It builds the project's asset tree (one listing per folder), then:

1. **The ways in.** `1.base64`: the fixtures (`test/fixtures/images`: PNG with alpha, JPEG with EXIF orientation 6, an
   animated GIF, a WebP) converted and uploaded, each verified. `1.binary`: a single-use capability, the file POSTed
   over real HTTP to the pipeline's own endpoint (on loopback, in the test's runtime), then uploaded. `1.caddy`: a
   large POST (8 MiB, no valid capability) to `<BRIDGE_PUBLIC_URL>/uploads/…`, which must come back from the **live**
   bridge as its generic refusal: Caddy passes the path and the body (PASS on 403; FAIL on 404 or 413; INCONCLUSIVE on a
   proxy error). `1.url`: only when `LKB_SANDBOX_IMAGE_URL` names a stable public test image.
2. **What LegendKeeper stored**: each asset downloaded; SHA-256, dimensions, alpha, orientation (none left) and frames
   as stored, and LegendKeeper's recorded width and height.
3. **Staging**: one image staged (hidden), placed (moved, unhidden, renamed, read back); another staged and discarded,
   its bytes kept first.
4. **A nested destination** (`… / Characters / Group / Race / Name`) created in order under the throwaway folder.
5. **Clean-up**: the throwaway folder `lk-bridge images sandbox <time>` (everything inside goes with it) and the run's own
   staging folder (`<that name> staging`, set as the run's `imageStagingFolder` in its temporary database) are deleted;
   404 or "already deleted" counts as cleaned. Anything left is named: delete it by hand.

Each line is PASS, FAIL or INCONCLUSIVE with its cost. **Cost** (measured against a mock library shaped like the test
world's, 18 folders and 559 images): about **68 reads (32 of them listings), 34 writes and 24 downloads** from the asset
host (downloads draw on no API tier), about 0.2 % of the key's daily budget; a few minutes with the pacing.
`test/images/sandbox-dryrun.test.ts` runs the same script against the mock. The URL check needs
`LKB_SANDBOX_IMAGE_URL`; the Caddy check reads `BRIDGE_PUBLIC_URL` from the env file (or `LKB_PUBLIC_URL`).

## The maps (v2 D2)

`npm run test:sandbox` (on the server `deploy/sandbox-test.sh --project test`) also runs `maps.test.ts`;
`npm run test:sandbox -- maps` runs it alone:

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- maps
```

PLAN-v2 says D2 makes its own test map; with the rule that a build session touches no live system, this is the test the
owner runs. Unlike the chronology test it **writes**, then cleans up. It prints PASS, FAIL or INCONCLUSIVE per check
(M1 to M8, [ADR 0040](../../docs/adr/0040-map-feature-tools.md) "To verify"), and the run fails if a check FAILs or the
clean-up does.

- **What it creates:** one throwaway page `lk-bridge maps <time>` (a plain name: no `[BSRC]`, `[BWRK]`, `[BARC]` or `[INDEX]`
  prefix and no Status, so the canon and lifecycle guards never stand in the way) whose first, blank document becomes the
  map; one more page under it to link to; **two generated PNGs** (1500×700, a non-square, non-power-of-two size, then
  1024×1024; valid 8-bit RGB files made in the test, a few kilobytes each, uploaded through the existing `upload_image`
  job); and on the map a feature of every type (a pin, a label, a region with one polygon and one with two, a path, folders)
  with pixel coordinates, nested pins, linked pins and a small tree for the cascade.
- **What it checks:** the image uploads at exactly 1500×700 (M1); a blank document given it becomes a map and `MapImage`
  reads back `width`, `height` and `bounds` (M2); **the app's zoom formula `z = ceil(log2(max(w, h)/256))` gives the bounds
  LegendKeeper reports** (M3); each type created by pixel is stored at the schema's lat/lng (to 1e-6) and reads back as the
  same pixel (M4a to f); a link to the throwaway page, to one of its documents, and clearing it with an empty `uri` (M5); a
  nested pin, **the rank LegendKeeper stores equals the rank sent** and a pin placed after a sibling sorts between its
  neighbours, an update moving a pin into the folder, **`parentId: ""` moving it out to the top level, also with a midpoint rank
  (M6c), and a raw `parentId: null` being refused (M6c-null: reported NOTED, a fact about LegendKeeper, not a failure; the owner's
  probe of 12 November 2026)**, a region given several polygons (M6); **deleting a folder leaves its features**, and a cascade delete removes a nested tree deepest first
  with every removed feature in the journal in full (M7); replacing the image keeps every feature's `pos` and the frame follows
  the new size (M8, the basis of the replacement warning). The writes are the jobs the tools submit (`src/maps/jobs.ts`: the
  check inside the lock, the write with its body bound from it, the verify), because the sandbox runtime has no repository tree
  to call the tools with.
- **Held writes:** every write, the clean-up's included, goes through `test/sandbox/wait.ts` (as the smoke, assumptions and images
  scripts do): a write parked for budget (`waiting_budget`) or queued is waited for, never sent again.
- **What it cleans up:** everything, at the end, even after a failure: both pages (a cascade, which takes the document and its
  features), then both uploaded images. **A page or image that is already gone (404, "already deleted") counts as cleaned**
  (C2d's rule); any other failure is confirmed by a read before it is reported, and the report names each id to delete by hand.
- **Cost:** about 35 writes and 100 to 160 reads (measured against the mock: 161 reads and 35 writes, which includes the mock
  world's repository tree re-reading every page written; the sandbox runtime has no tree, so fewer on the real run), two image
  uploads, and a few minutes at the bridge's write pacing. The link checks wait up to 8 × 4 s for a new page to become linkable.
- **Dry run:** `test/maps/sandbox-dryrun.test.ts` runs the same script against the mock map world: every check runs to an answer
  (19 PASS), once plainly and once with three writes really held for budget (a map job, a document write and the clean-up's
  delete, each parked for 31 s), which it waits for without sending any twice, the upload step is stood in for (the mock cannot take a signed PUT), the generated PNG is decoded and its CRCs
  checked, and the clean-up is verified. A FAIL on the real API is where LegendKeeper differs from what ADR 0040 relies on.

## Snapshots, restores and the rehearsal (v2 E1a)

`npm run test:sandbox` (on the server `deploy/sandbox-test.sh --project test`) also runs `snapshots.test.ts`;
`npm run test:sandbox -- snapshots` runs it alone:

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- snapshots
```

It **writes**, then cleans up. It prints PASS, FAIL or INCONCLUSIVE per check ([ADR 0042](../../docs/adr/0042-snapshots-restore-rehearsal.md),
"To verify"); the run fails if a check FAILs or the clean-up does.

- **Its runtime:** the sandbox runtime (`createSoakRuntime`), whose database **and snapshot store** are in its own
  temporary directory (`snapshots.dataDir`), removed at the end. Its AI REPOSITORY is set, **in that temporary database
  only**, to the throwaway root the test creates, so the full snapshot, the restores and the rehearsal see that subtree and
  nothing else of the test world. The full snapshot also takes the test world's whole asset library (as on the server):
  one listing per 100 assets, and each image's bytes downloaded once from the asset host (no API budget).
- **What it creates:** `lk-bridge snapshots <time>` at the top level (a plain name, no prefix and no Status, so the canon
  and lifecycle guards never stand in the way) with a link target and a page holding a page document (a heading, a mention
  of the target, the image, a **meter block: a keep region**, a paragraph), a map (the image as its `MapImage`, a folder, a
  pin, a region), a timeline (a lane and an event, on the project's first calendar; none, no timeline), a board (one
  shape), and a sidebar (a key-value property and a collection linking the target); **one generated PNG** (64×48).
- **What it checks:**
  - **S:** a full snapshot of the subtree and the library; its reads per page.
  - **R.page, R.map, R.time, R.board, R.sidebar:** each piece edited, then restored from the snapshot (a proposal, approved
    here as the owner approves one) and read back: the stored piece must **hash exactly as the snapshot's**.
  - **D1:** the link target deleted, then undeleted within LegendKeeper's soft delete (`restoreResource`; its content
    follows as a second proposal, or is reported as already matching).
  - **D2:** first **which icon form LegendKeeper accepts**: a probe page is made with `"fas fa-book"` (as a read gives it)
    and another with `"book"` (as the write schema says), each reported ACCEPTED or REFUSED, with how the accepted one reads
    back. Then a page with an icon is made, deleted, and **recreated from the snapshot alone**: whether LegendKeeper took its
    **original id** (said either way; refused, it is recreated with a new id), its text read back as in the snapshot, and
    whether its **icon came back** (or was dropped by the bridge's fallback and listed, which is not a failure; an icon that
    is gone without being listed is a FAIL). The owner's run of 13 November failed here on the icon and never reached the
    id question.
  - **U (NOTED, not run):** the old checks U.a to U.e asked whether `updatedAt` moves when a block, a sidebar row, a map
    feature, a timeline event or the board content changes. The owner's run of 13 November: **all FAIL, it does not**, on
    resources and on documents. So the daily changed-pages pass was removed and the full snapshot is nightly
    (ADR 0042 decision 4). The script records the fact on one line and no longer tests it.
  - **H:** a sampled rehearsal of the subtree's snapshot into its own throwaway root (`lk-bridge rehearsal <time>`),
    compared and deleted. A rehearsal never goes into the project its snapshot came from, so the snapshot is copied, in the
    temporary database only, as one of a stand-in project, and the test project is marked a sandbox there.
- **Held writes:** every write goes through `test/sandbox/wait.ts`: single operations through `runSettled`, the upload,
  each approved restore's job and the clean-up through `waitForJob`. A write parked for budget (`waiting_budget`) or
  queued is waited for, never sent again. The rehearsal waits for each of its own jobs the same way.
- **What it cleans up:** the root (a cascade: every page the run made, the recreated one included) and the image, even
  after a failure; the rehearsal deletes its own root and folder. **Already gone (404, "already deleted") counts as cleaned.**
- **Cost:** measured against the mock, **239 reads and 65 writes** (setup 14 reads and 19 writes; the full snapshot 16
  reads for 3 pages and a 4-image library; each restore 15 to 24 reads and 2 to 4 writes; D2 24 reads and 8 writes, its icon
  probe included; the rehearsal 52 reads and 22 writes; the clean-up 23 reads and 2 writes). On the real API add
  the test world's library listing (one read per 100 assets) and the tree build of the subtree (a few reads); expect
  **about 270 reads and 65 writes**, well inside the test project's budgets, and a few minutes at the write pacing.
- **Dry run:** `test/snapshots/sandbox-dryrun.test.ts` runs the same script against the mock snapshot world: every check
  PASSes (the mock refuses the read form of an icon and takes the bare name, as the real API does), `U` is NOTED, nothing
  is left behind, and the cost above is counted from the mock's own call log.

## Audits (v2 E2)

`npm run test:sandbox -- audits` (on the server `deploy/sandbox-test.sh --project test -- audits`) runs `audits.test.ts`
([ADR 0044](../../docs/adr/0044-audits.md)). **Written, not run**: dry-run against the mock in
`test/audits/sandbox-dryrun.test.ts`. It WRITES one throwaway subtree (deleted at the end, cascade) and checks, on the real
API, what the audits assume: that LegendKeeper keeps a newline inside one text run; that a full snapshot holds the project's
templates and what they cost; that an audit makes **zero** requests and records its snapshot and age; that "Propose a fix" for a
top-level paragraph writes nothing until approved and then reads back as planned (the block keeps its id, the new paragraphs
follow it, the bold mark stays with its words); the same fix for a paragraph **inside a table cell** (NOTED either way: whether
`insertBlock` takes `after` a block inside a container, which decides whether the fix should be offered only at the top
level); and that the finding is gone after the next full snapshot. Like the snapshot sandbox it uses the bridge's own runtime
(a temporary database and snapshot store) with the throwaway root as its AI REPOSITORY.

## Concurrency (v2 E4, PLAN-v2 10.6 test 2)

`npm run test:sandbox -- concurrency` (on the server `deploy/sandbox-test.sh --project test -- concurrency`): what
LegendKeeper itself does with simultaneous writes that carry the SAME expected version, sent straight through the
governor's raw client (bypassing the engine and its locks) on one throwaway page (`lk-bridge concurrency <time>`), deleted
at the end. C1: two `replaceDocumentBlocks` with one If-Match together; C2: five `insertBlock` with one If-Match together;
C3: the control, one after the other (the second must be refused with 412). PASS when LegendKeeper behaved as an atomic
compare-and-swap, **NOTED** when it accepted more than one (the behaviour PLAN-v2 10.6 designs around: report it, nothing
to fix), FAIL only when the control did not refuse a stale version. Its runtime sends writes with no spacing
(`WRITE_SPACING_MS=0`, still through the governor's tiers). About 14 writes and 12 reads. Code: `concurrency.ts`; dry run:
`test/e4/sandbox-concurrency-dryrun.test.ts`.

## Maps M6e (v2 E4, backlog 4)

The `maps` run gains M6e: three throwaway regions, each written RAW with several `polygons` and `polygon: null`,
`polygon: []` or no `polygon`, recording what LegendKeeper accepts and what reads back (NOTED). Until its answer is in,
the bridge writes one consistent form (a region that still carries a `polygon` gets it set to the first of its new
polygons; M6d checks it), and `read_document` and the snapshots name regions that carry both.

## The block-id sweep's check (v3 F3.5)

`assign-block-ids.test.ts` (`… sandbox-test.sh --project test -- assign-block-ids`; ADR 0056): writes a throwaway page
whose blocks are sent without ids and reads it back; with a legacy document it checks that `assignBlockIds` gives every
block a unique id, changes no content (`unsupported` blocks included), moves the version and is idempotent, then deletes
the page. When LegendKeeper gives ids on the write (no legacy document can be made through the API) it reports NOTED with
what to do (`LKB_BLOCKIDS_DOCUMENT=<resourceId>/<documentId>` names a legacy page in a disposable copy). Unlike the other
checks it records its verdict (PASS, NOTED or FAIL) in the bridge's own database (`DB_PATH`, `block_id_sandbox_checks`),
with the bridge version: the sweep can be enabled only with a PASS for the running version, or the owner's override.

## The splits' check (v3 F3e)

`split-ids.test.ts` (`… sandbox-test.sh --project test -- split-ids`; ADR 0059): what `arkona_split_owner` assumes of
LegendKeeper when it moves blocks verbatim between pages. It writes two throwaway pages and checks that a block written
to the second with the id it has in the first keeps that id (its children theirs) and arrives verbatim, and that the
first page's own edit (the block taken out, an interface summary in its place) leaves the copy as it is. What
LegendKeeper does with an id the destination already uses is recorded as NOTED (the split never sends one: it derives
another id and says so in the job). Both pages are deleted at the end. Written for the owner to run; agents never run it.

## The Approved Supplementary Tags and a ruling (v3 F5a)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- tagging-f5a` (`tagging-f5a.ts`; ADR 0067).
WRITES, then cleans up (about 12 writes and 25 reads). The Arkona pack's governance sources sit on Arkona, which the
sandbox runtime does not serve, so in the check's TEMPORARY database only they are pointed at a throwaway governance page
the check makes (every pinned heading; the Approved Supplementary Tags sentence verbatim) and the pack is approved there:
the retag job's policy check reads it, as on Arkona. T1 that page and the approval; T2 two probe pages made with the raw
client (CANON, Cosmology; CANON, Law, lkbf5aprobe), classified Law, their own pages snapshotted; T3 the audit: CANON,
Cosmology is a correction to CANON, Law, Cosmology; T4 the apply approved as the owner would, read back live; T5 "Keep
this tag here" on the second page (compliant); T6 its tags reordered with the raw client: the ruling lapses. Clean-up:
the throwaway index deleted with everything under it, in the check's `finally` and the test file's `afterAll`. Needs the
seed `arkona-2026-11-23-f5a` deployed (T0 says so otherwise). On the mock: `test/sandbox-mock/tagging-f5a.test.ts`.

## Automatic actions for audits (v3 F5b)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- automation-f5b` (`automation-f5b.ts`;
ADR 0068). WRITES, then cleans up (about 14 writes and 60 reads). In the check's TEMPORARY database only, the Arkona
pack's governance sources (Repository Automation's three pinned sections among them) are pointed at a throwaway
governance page the check makes, and the pack is approved there. A1 that page and the approval; A2 two probe pages made
with the raw client (a decorative blank paragraph; tags `Law, CANON`), only they snapshotted; A3 `blank_paragraphs` and
`retag_correction` set to Apply (each paragraph written after the sweep's, read back live; the pack still current); A4
the run, limited to the two probe pages: both applied by the Automation principal, each on the Review page; A5 both
fixes read back live; A6 both codes switched Off (each paragraph amended). Clean-up: the throwaway index deleted with
everything under it, in the check's `finally` and the test file's `afterAll`. Needs the seed `arkona-2026-11-23-f5b`
deployed (A0 says so otherwise). On the mock: `test/sandbox-mock/automation-f5b.test.ts`.

## Identity reconcile, query_facts and workstreams (v3 F5c)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- identity-f5c` (`identity-f5c.ts`;
ADR 0069). WRITES, then cleans up (about 16 writes and 40 reads). In the check's TEMPORARY database only, the Arkona pack's
governance sources are pointed at a throwaway governance page the check makes (the tagging policy check reads them), and
the pack is approved there. I1 that page and the approval; I2 two throwaway characters made with the raw client (Human;
Menkheti and Canthan), found by the tree's sweep; I3 `arkona_identity_reconcile`'s dry run (both planned with their tag
arrays; nothing written, read back live); I4 the run under a workstream label (both done and verified); I5 both read back
live (facts and tags); I6 `query_facts` over them (free); I7 `bridge_workstream_report` (both written and verified,
nothing waiting). Clean-up: the throwaway index deleted with everything under it, in the check's `finally` and the test
file's `afterAll`. Needs F5c deployed (I0 says so otherwise). On the mock: `test/sandbox-mock/identity-f5c.test.ts`.

## Guided character art (v3 F7)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-art` (`f7-art.ts`; ADR 0070). WRITES,
then cleans up (about 20 writes and 40 reads). B0 the asset tree built; B1 one outfit piece uploaded into a throwaway
character folder's Wardrobe (`lk-bridge f7 check <time> / F7 Probe / Wardrobe`), read live: loose in Wardrobe, and the
bridge's placement for a second piece is "a new folder, the loose piece moved"; B2 the second piece uploaded into
`Wardrobe / Probe Outfit` (the folder made by its job) and the first piece moved in (`updateAsset`, as the art job does),
read back live: both in the folder, nothing loose, and the bridge's asset tree followed the move; B3 the titled-block
probe for the verifier (G10): one block of each titled kind written without `title` and `isTitleHidden` on a throwaway
page, and what LegendKeeper stored printed as NOTED, one line a kind: `F7 PROBE <kind>: title=… isTitleHidden=…`. Paste
the values into `TITLED_BLOCK_DEFAULTS` (src/jobs/verify-blocks.ts); a kind refused in its minimal form says so. The
first live run (23 November 2026) confirmed every kind except `meter`, whose minimal block was refused (Validation
error: its item had no `icon`). Since v3 F7b the probe sends the spec's `MeterBlock` minimal shape, `{ kind: "meter",
mode: "bar", items: [{ name: "Probe", icon: "heart", current: 1, max: 2 }] }` (`mode`, and each item's `name`, `icon`,
`current` and `max`, all required), so the next run prints `F7 PROBE meter: …`; paste that line's values in too.
Clean-up: the throwaway asset folder (with everything in it) and the probe page, in the check's `finally` and the test
file's `afterAll`. On the mock: `test/sandbox-mock/f7-art.test.ts`.

## Image archives (v3 F7c)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7c-archive` (`f7c-archive.ts`; ADR
0075). WRITES, then cleans up (about 7 writes, 10 reads and one download from the asset host). C0 the asset tree built;
C1 a small zip of 3 images (`alpha.png`, `Probe Outfit/orientation-6.jpg`, `already.webp`) taken in as an image archive:
listed at once, nothing converted, nothing sent to LegendKeeper; C2 ONE entry asked for as an art call asks: converted
and staged by the archive worker, the other two still listed; C3 that entry placed as an outfit piece by the art job's
own steps (createImageUpload, the signed PUT, createImageAsset, the stored-file check, the read back) into a throwaway
character folder's Wardrobe (`lk-bridge f7c check <time> / F7c Probe / Wardrobe`), read live; C4 the archive discarded:
its server copy removed, the two listed entries discarded. **What to look for:**

- **C1**: three `F7C ROW` lines, e.g. `F7C ROW orientation-6.jpg folder="Probe Outfit" suggestedOutfit="Probe Outfit"
jpeg <w>×<h> listed` and `F7C ROW alpha.png folder=null suggestedOutfit=null png … listed`.
- **C3**: `F7C PLACED F7c Probe - Probe Outfit - Outfit Reference - Front in lk-bridge f7c check … / F7c Probe /
Wardrobe (asset …); storedBytesVerified=true`.
- **cleanup**: `nothing left`.

Clean-up: the throwaway asset folder (with everything in it) and the archive, in the check's `finally` and the test
file's `afterAll`. On the mock: `test/sandbox-mock/f7c-archive.test.ts`.

## Seeing character art (v3 F7b)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7b-art` (`f7b-art.ts`; ADR 0071). WRITES,
then cleans up (about 6 writes, 12 reads and one download from the asset host). It runs on a temporary database copied
read-only from the bridge's (`copyBridgeState`, as `identity-f5c`), so deploy F7b first: A0 fails, naming the packs
attached, when the Arkona pack (seed `arkona-2026-11-23-f7b`) is not attached to the project. A0 the asset tree built;
A1 one small image (`alpha.png`) uploaded into `lk-bridge f7b check <time>`, and a throwaway page
`lk-bridge f7b probe <time>` under the AI REPOSITORY showing it under a heading with its alt text and a paragraph (the
authority text); then `arkona_get_art` as the MCP server calls it, for a temporary read-scope principal, with each
delivery. **What to look for:**

- **A2** (`delivery: "link"`): `URL https://assets.legendkeeper.com/…webp`, exactly the URL `getAsset` gives (checked).
  Open it in a browser: it is the route ChatGPT's web browsing takes. `authority unavailable` here is expected: the
  temporary database has no snapshot index (the bridge's own has one).
- **A3** (`delivery: "inline"`, by the probe page): `inline block <n> bytes (image/webp, <w> × <h>, cached false)`, the
  original's size, and `authority found on “lk-bridge f7b probe …”: label “Primary Reference - F7b Probe”, text “…”`:
  the page read live stands in for its snapshot.
- **A4** (`delivery: "both"`, by the asset, again): `cache hit: cached true, downloads 0, cacheHits 1`.

Clean-up: the throwaway asset folder and page, in the check's `finally` and the test file's `afterAll`. On the mock:
`test/sandbox-mock/f7b-art.test.ts`.

## The Compact Reference becomes the Character Core (v3 F7.1)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7-1-core` (`f7-1-core.ts`; ADR 0072).
WRITES, then cleans up (about 22 writes and 45 reads). C0 the Arkona pack attached, the asset tree built, and **the pack's
governance current in the temporary database**: on the server the pack reads its six governance sources from project
`arkona`, which a sandbox runtime never registers (it holds the sandbox project's key only), so the check points them at
a throwaway governance page `lk-bridge f7.1 governance Probe <Letters>` under the AI REPOSITORY, in the TEMPORARY
database only, and approves the pack there, as `identity-f5c`'s I1 does (`governance.ts`, `ensureSandboxGovernance`).
C0's line says which happened. Without this, C1 failed PACK_NOT_CURRENT ("project arkona is not registered", the live
run of 23 November 2026). C1 a throwaway Working compact character; C2 one art piece; C3 read back live and printed as
`F7.1 CORE …`. Clean-up: the throwaway index (or Reference), the character's asset folder and the governance page. On the
mock: `test/sandbox-mock/f7-1-core.test.ts`, and `test/sandbox-mock/pack-governance.test.ts` with the governance in
`arkona`, as on the server.

## A whole art set in one call (v3 F7d)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7d-art-set` (`f7d-art-set.ts`; ADR
0077). WRITES, then cleans up (about 50 writes and 80 reads). It calls the tools as two temporary principals, one at
scope `propose` and one at scope `write`, because the pack's switch for `arkona_add_character_art` is "follow the
scope": at `propose` a call is one proposal; at `write` it runs as a job, unless it makes an Authoritative Art page or
upgrades an Authoritative Core. D0 the Arkona pack attached, the asset tree built, the pack's governance current in the
temporary database (the throwaway governance page, as f7-1-core's C0); D1 a throwaway Working compact character
`Probe <Letters>`; D2 a zip of 5 tiny images taken in as an archive (`portrait.png` at the top, `Probe Gala/front.png`
and `Probe Gala/back.png`, `Probe Hunt/front.png`, `Probe Ride/front.png`); D3 **at scope `propose`**, ONE
`arkona_add_character_art` call with `groups` naming four entries, ONE proposal of four items, printed as
`F7D PLAN items=Art page | Design pieces | Outfits(Probe Gala) | Outfits(Probe Hunt)`, approved whole, its job
succeeded and verified (`placed Design pieces 1, Outfit Probe Gala 2, Outfit Probe Hunt 1`); D3b **at scope `write`**,
a second, smaller groups call on the same Working character now that its Art page exists (the new outfit Probe Ride, one
piece): it runs **directly as a job, with no proposal**, printed as `F7D DIRECT job … succeeded and verified; placed
Outfit Probe Ride 1`; D4 read back LIVE and printed as `F7D SET …`: `core=[BWRK] Probe <Letters> - Character Core
referenceType=Character Core`, `folders=Wardrobe, Wardrobe / Probe Gala (2) looseInWardrobe=2 designPieces=1`, the Art
page's `headings=` holding Reference Images, Probe Gala, Probe Hunt and Probe Ride, `images=5`, `copies=` with the
Core's values, `dependsOnCore=true`. Clean-up: the throwaway index, the character's asset folder, the archive and the
governance page. On the mock: `test/sandbox-mock/f7d-art-set.test.ts`, on a world with the pack's seed switches (the
tool at "follow the scope", as live; the run asserts it).

**The 25 November 2026 run failed D3 with "not one proposal".** The check, not the product, was wrong: it made its
call at scope `write` on a Working character, which runs directly as a job (the tool's description since F7d), and it
expected the old "always a proposal" claim. The run on the mock passed only because the mock's pack had the tool at
"always propose". Fixed in F10's Step 0 as above; rerun it after deploying:
`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7d-art-set`.

**Any check that runs a pack's tag-computing tools** (`arkona_create_*`, `arkona_identity_reconcile`, `arkona_rename`,
`arkona_split_owner`, `arkona_retag_apply`) on a copy of the bridge's state must opt in the same way, or point the
governance itself; `copyBridgeState`'s report lists, in `governanceMissing`, each pack whose sources are in a project
this runtime does not register, and `pack-governance.test.ts` fails a check that opts in to neither.

## The bulk class P4 (v3 F9)

`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- bulk-f9` (`bulk-f9.ts`; ADR 0074).
WRITES, then cleans up (about 15 writes and 100 reads, plus the asset library's listing). Setup: a throwaway root
`lk-bridge bulk-f9 <time>` with 12 pages, made the AI REPOSITORY in the sandbox runtime's TEMPORARY database only, and
its tree. Then a small full snapshot of that subtree (and the asset library, as every full snapshot takes it), with a
change snapshot requested mid-way: at the third page, a rename of one of its pages as a P2 job. The two timelines are
printed first, each with its start, finish, request count and classes:

```
full snapshot   started 02:40:36.584  finished 02:40:36.833  27 requests  classes P4
change snapshot started 02:40:36.628  finished 02:40:36.679  4 requests  classes P1, P2
```

What to look for: B1 every request of the full snapshot's run at **P4**; B2 the write and its change snapshot at P1 or
P2, **never P4**, finished **before** the full snapshot finished; B3 the full snapshot still finished, complete, with
every page (13: the root and its 12). INCONCLUSIVE on B2 means the full snapshot ended before the write was made (a
tiny library on a fast link): run it again. Clean-up: the root, with its subtree. On the mock:
`test/sandbox-mock/bulk-f9.test.ts`.

## Every check on the mock, in the ordinary suite (CR-2026-11-R4)

Each check's steps are an exported runner beside its thin `.test.ts` wrapper (the wrapper is the real run, unchanged in
what it does and prints). The ordinary suite (`npm test`) runs every runner against the mock LegendKeeper through the
same runtime as the real run (`createSoakRuntime` pointed at the mock on loopback, `test/sandbox-mock/harness.ts`; with
the mock world's asset and upload hosts where a check uploads or downloads, `test/sandbox-mock/hosts.ts`), and **fails
on any item that is not PASS or NOTED**, printing the whole report. A SKIPPED item passes only where the check itself
always skips it and the run asserts its reason (the smoke's (c)).

| Check                          | Its run on the mock                                         |
| ------------------------------ | ----------------------------------------------------------- |
| smoke                          | `test/tools/sandbox-dryrun.test.ts`                         |
| assumptions                    | `test/tools/assumptions-dryrun.test.ts`                     |
| assumptions-r2                 | `test/tools/assumptions-r2-dryrun.test.ts` (run 1)          |
| assumptions-r3, assumptions-r4 | `test/sandbox-mock/assumptions-r3.test.ts`, `…-r4…`         |
| audits                         | `test/audits/sandbox-dryrun.test.ts`                        |
| chronology                     | `test/chronology/sandbox-dryrun.test.ts`                    |
| concurrency                    | `test/e4/sandbox-concurrency-dryrun.test.ts`                |
| consistency-f4b                | `test/sandbox-mock/consistency-f4b.test.ts`                 |
| images                         | `test/images/sandbox-dryrun.test.ts`                        |
| maps                           | `test/maps/sandbox-dryrun.test.ts`                          |
| snapshots                      | `test/snapshots/sandbox-dryrun.test.ts`                     |
| split-ids, assign-block-ids    | `test/sandbox-mock/split-ids.test.ts`, `…assign-block-ids…` |
| f7-art                         | `test/sandbox-mock/f7-art.test.ts`                          |
| f7c-archive                    | `test/sandbox-mock/f7c-archive.test.ts`                     |
| f7-1-core                      | `test/sandbox-mock/f7-1-core.test.ts`, `…/pack-governance…` |
| f7d-art-set                    | `test/sandbox-mock/f7d-art-set.test.ts`                     |

The mock answers as LegendKeeper does only with its **faithful** setting on (`test/sandbox-mock/faithful.ts`, which
these runs turn on and nothing else does): each behaviour there names the owner's run or the part of the spec it comes
from, and one no real run has established yet is modelled as the bridge assumes it and says so. A failing item's detail
carries the whole answer (`whole.ts`), never a slice of it.

## Steps, timeouts and the clean-up (R4.1)

The owner's run of 21 November 2026: consistency-f4b hung for its whole 30-minute timeout with no output, and left its
probe pages on the test world because its clean-up never ran. Every check now runs through `steps.ts`:

- **Each step prints a line as it starts and as it finishes** (`[consistency-f4b] start F3: … (timeout 10 min)`, then
  `done F3 in 2.4 s`, `failed F3 after …: <the first line of the error>` or `timed out F3 after …`), so a run that stops
  shows where.
- **Each step has its own timeout, which names the step** (10 minutes unless the step says otherwise): a step that never
  answers fails as `step F3 (<its title>) did not finish within its timeout of …`, a FAIL in the report, and the check
  goes on to its clean-up.
- **The clean-up is a registry**: each action runs once, newest first, with its own timeout (5 minutes; longer for
  assumptions, assumptions-r2 and maps, whose clean-ups wait out the write minute) and its own start and finish lines.
  The check runs it in its own `finally` as before (so its report says what was cleaned), and the test file runs it again
  in an `afterAll` with its own timeout: an action not yet run (the test itself timed out, or something hung outside any
  step) runs there; one already run is not run again. An action that fails or times out fails the `afterAll`, naming it.
- **consistency-f4b and narrative-f4c snapshot only their own pages** (`page-snapshot.ts`), never the test world (about
  1,500 pages at the governor's rate, which outlasted the whole timeout): their temporary database gets an empty base,
  then one change snapshot of the probe's (or the story's) pages, which the readers lay over it.

`test/sandbox-mock/steps-timeout.test.ts` proves it on the mock: consistency-f4b with its F3 never answering fails at F3's
own timeout naming it, runs no later step, prints a start and a finish for each step and cleans up the probe; with a
step timeout longer than the test's, the `afterAll` clean-up deletes the probe while the check is still stuck; and all
18 test files and their 17 runners go through the harness.
