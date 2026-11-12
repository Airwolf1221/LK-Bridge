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
'/opt/lk-bridge/app/data/images/upload-tmp'`. `upload-tmp/` and `kept-bytes/` are created only by the first upload or kept
file. `test/tools/sandbox-runtime-readonly.test.ts` (with `soak-runtime-readonly.test.ts`, its inner half, which does nothing
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

## The v2 phase 0 spike

`npm run spike:v2 -- --project <name>` (on the server: `deploy/spike-v2.sh --project test`) is a read-mostly script that checks ten
assumptions of docs/PLAN-v2.md against the test world and prints a Markdown report (PASS / FAIL / INFO with evidence).
Only check 1 writes (a `createManyResources` batch whose parents are minted in the same batch), under one throwaway root
that is deleted at the end, even after a failure. Same guard as the soak; every call goes through the real engine and
governor at P3. Code: `spike-v2.ts` (checks), `spike-report.ts` (report layout); dry run against the mock:
`test/tools/spike-v2-dryrun.test.ts`. How to run it: docs/runbook-deploy.md, "Phase 0 spike".

## The write layer's assumptions (CR-2026-11)

`npm run test:sandbox` (with `LKB_SANDBOX_PROJECT`, as above; on the server `deploy/sandbox-test.sh --project test`) also
runs `assumptions.test.ts`; `npm run test:sandbox -- assumptions` runs it alone. It checks, on the real API, every
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
  world's repository tree re-reading every page written; the sandbox runtime has no tree), plus up to 12 search polls
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
