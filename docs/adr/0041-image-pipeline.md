# ADR 0041: The image pipeline: four ways in, sharp, a single-use binary endpoint, staging, destinations, and deletes that keep their bytes

Status: Accepted (v2 D3, 12 November 2026). Implements PLAN-v2 4.10, the Images and Backups rows of section 1, the asset
bullets of section 9, the Assets row of section 5 and the D3 note of 10.2; closes the CR-2026-11 open item on asset
deletes (the bytes of a deleted image). Builds on ADR 0027 (the asset tree and its placement plan) and ADR 0026 (the
taxonomy). One decision of chunk 8 changes, narrowly (decision 7): a connection with scope `propose` may now **stage**
an image. Number 0040 and migration 1900 are left to D2, built alongside; this session's migration is 1950. Nothing in
this session touched a live system: every test runs against the mock LegendKeeper, and the sandbox test is written, not
run.

Amended by [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) decision 8 (17 November 2026): the destination rule that
reused a folder named after the character wherever it is is retired; a character's folder comes from its exact path under
Characters only (`ART_FOLDER_AMBIGUOUS` when that path is ambiguous or blocked).

## Context

v1's `lk_upload_image` uploads bytes as they come (base64 or a URL) into a folder id. The owner wants the old bridge's
behaviour: WebP at quality 90, the character's own folder, the stored bytes checked, the same original never uploaded
twice. Three practical problems shaped the rest:

- A chat assistant cannot pass a multi-megabyte image in a tool call: a 2 MB image is about 2.7 million characters of
  base64. Agents with a shell can send a file directly, if the bridge gives them a safe way to; the owner, who has the
  images in hand, can upload them on the dashboard.
- At scope `propose` nothing may be written, but a proposal cannot hold image bytes (chunk 8 refused uploads at
  `propose` for that reason). The setting packs (PLAN-v2 10.2) need images uploaded first and **referred to by id**.
- LegendKeeper has no restore for a deleted asset. Its bytes must be kept before the delete, on every route.

## Decision

1. **The converter is `sharp` 0.35.5, pinned exactly** (`package.json`, `--save-exact`). It ships prebuilt binaries
   (`@img/sharp-linux-x64` with `@img/sharp-libvips-linux-x64` 1.3.4, glibc ≥ 2.26) as optional dependencies; the package
   has no install script, so `npm ci` as `lkbuild` needs no compiler and no network beyond the registry. It works with
   any Node-API version, so with Node 24.
2. **The rules** (src/images/convert.ts): the type is decided by the first bytes only (PNG, JPEG, GIF, WebP; never the
   declared type or the name); limits are checked from the header before any pixel is decoded: bytes
   (`UPLOAD_MAX_BYTES`), pixels **of all frames together** (`IMAGE_MAX_PIXELS`, default 100,000,000, also given to sharp
   as `limitInputPixels`) and frames (`IMAGE_MAX_FRAMES`, default 300); one full decode that discards the pixels
   (libvips statistics, streamed) refuses truncated and corrupt files with the decoder's own words (`failOn: 'error'`),
   for a WebP too; a WebP is then stored **byte for byte**; anything else becomes WebP at quality 90 (`alphaQuality`
   100, `effort` 4) with the EXIF orientation applied first (`autoOrient`), every frame, delay and loop count of an
   animation kept, no resize, and **no metadata** (sharp keeps none unless asked: no EXIF, XMP or ICC). The output is
   read back and must have the source's dimensions and frames. The display name drops a final image extension.
3. **One conversion at a time** (`IMAGE_CONVERT_CONCURRENCY`, default 1, at most 8 waiting, past that
   `IMAGE_CONVERTER_BUSY`), each with a time limit (`IMAGE_CONVERT_TIMEOUT_MS`, sharp's own timeout), and libvips's
   operation cache off. Measured: a 12 MP noise JPEG (worst case for compression) converts in 3.2 s; an image at the
   100 MP limit takes about 0.5 GiB of native memory at its peak. The service unit's memory ceiling is raised to
   `MemoryHigh=1400M` / `MemoryMax=1536M` accordingly (the V8 heap stays at 700 MB); a normal deploy installs it.
4. **One upload job.** The `upload_image` job kind (v1's three steps) grows: the missing folders first
   (`createAssetFolder`, each new folder's id bound into the next step: `StepOptions.bindFrom`, a new, generic binding
   kept by proposals too), then createImageUpload, the signed PUT and createImageAsset (into the last folder), then
   **`upload_image.verify`**: a custom step that downloads the stored file and compares its SHA-256 with the bytes sent
   (decision 5), then, for a staged image, `updateAsset { isHidden: true }` with the new asset's id bound in. The asset
   tree follows every one of these writes (ADR 0027 decision 6), so it knows the new folders and image at once, and the
   image's hash is recorded on the tree's row once verified.
5. **Verification is anonymous, governed and guarded.** PLAN-v2 section 2 verified that asset files download from
   `assets.legendkeeper.com` without authentication. The download goes through the project's governor (pacing, retries;
   it draws on no API tier) and the existing guarded transport, which now also sends a **GET**, with no key or cookie,
   to a host in `LK_ASSET_HOSTS` only (default `assets.legendkeeper.com`; https, public addresses, the port allowlist,
   DNS pinned; 100 MiB cap). `storedBytesVerified: true` only when the hashes match; a mismatch or a failed download is
   recorded with its reason, never retried, and never fails the job: the asset id is still returned.
6. **Deduplication per project by the original's SHA-256** (`image_uploads.original_sha256`). The same original again
   returns the existing asset (`deduplicated: true`), or the upload still under way; an asset the built asset tree knows
   to be deleted no longer counts. `deduplicate: false` uploads again, and is refused without an `operation_id` (so a
   repeated call cannot upload a third copy). Every upload keeps the original's format, hash and size, the WebP's hash
   and size, dimensions, frames, alpha, orientation, the conversion mode and quality, and its principal and source.
7. **Staging, and the one change to chunk 8's rule.** A staged image is uploaded, verified, **hidden** and recorded in
   the project's staging folder (in the library's root, found by name or created; the project setting
   `imageStagingFolder`, default `LK-Bridge staging`), with the destination given, if any, as the intended one. Placing
   it is ONE `batch_ops` job: the missing folders, `updateAsset` (move, unhide, optionally rename), then a read back
   (`bridge.verify` with a new `asset` target). **At scope `propose`, `upload_image` always stages** (the policy gate
   allows an `upload_image` job that the engine marks `staging`, which only bridge code can set: `lk_upload_image` and raw
   `createImageUpload` / `createImageAsset` calls stay refused at `propose`), and the placement, when a destination was
   given, becomes the proposal. A proposal therefore holds no image bytes: only the staged asset's id and the folders.
   What a `propose` connection can write is one hidden image in the staging folder, which the owner sees and discards.
   Nothing staged is ever removed automatically: images older than `IMAGE_STAGING_REPORT_DAYS` (30) are reported.
8. **Destinations** (src/images/destination.ts, on ADR 0027's planner): `folder` (an id, or a path such as
   `Characters / Beastkin / Qishen / Mehrana al-Khalid`, where `Undetermined / Unknown` stays one name); `for_character`
   (name and race, the rules of `create_character`: a folder named after the character is reused wherever it is, several
   are refused and listed; otherwise `Characters / Group / Race / Name` or `Characters / Race / Name`, **the names from
   the taxonomy's asset folder field** (the race's entry and its group's), an unknown or omitted race
   `Undetermined / Unknown`, a declared race that does not resolve refused); `for_page` (a Core, Reference or character
   index page gives its character, the race read from where the page is, ADR 0027 decision 9; any other page needs a
   `folder`); `subfolders` appended. Missing folders are created in order; folders are never moved; a non-folder asset
   with a needed folder's name is refused (`ASSET_NAME_CONFLICT`). The destination is planned (and refused) before
   anything is uploaded, also when staging.
9. **The single-use binary endpoint** (`prepare_image_upload`, then `POST /uploads/<upload_id>`, then `upload_image`
   with the `upload_id`). The capability is 256 random bits (base64url), handed out once, stored only as its SHA-256,
   bound to the upload id, the project, the principal, the file's SHA-256, length and type; it works for ONE request,
   for 5 minutes. It travels in `Authorization: Upload <token>`. The endpoint streams the body to a private temporary
   file (`<image dir>/upload-tmp`, mode 0700, files 0600, named by a random id) while hashing it, stops at length + 1,
   and answers only "received" with the hash. A received file waits 15 minutes for `upload_image`, only from the same
   connection and project, once. The directory is emptied at start-up and swept every minute. The prepared answer
   carries ready-made scripts (Python with the standard library only, and curl) that check the file's SHA-256 before
   sending it.
10. **Asset deletes keep their bytes, on every route.** The engine's one read before a destructive write (the journal's
    pre-image) now calls a keeper for every `deleteAsset`, whatever sent it (Staging's Discard, `lk_api_write`,
    `lk_api_batch`, `lk_op_*`): the asset's file is downloaded (decision 5) and stored content-addressed by SHA-256 in
    `<image dir>/kept-bytes` (0700 / 0600), with a reference row; the pre-image records `keptBytes { sha256, size,
contentType }`. A folder's delete lists its children at every depth (`listAssets`, in the job's name) and keeps each
    image's bytes; the pre-image has the list. If a file cannot be fetched (or the folder holds more than 500 assets),
    the delete is refused (`ASSET_BYTES_NOT_KEPT`) unless the owner has allowed that one asset on the Staging page
    (re-authenticated, one use, an hour). Kept bytes are removed after `ASSET_BYTES_RETENTION_DAYS` (90); E1's backups
    will reuse this store. **v2 E1a ([ADR 0042](0042-snapshots-restore-rehearsal.md) decision 1): merged into the snapshot
    store** (one store, the same content addressing); `kept-bytes/` is adopted at start-up, and the collector keeps every
    kept object until its window ends.
11. **The dashboard's Staging page** lists staged images (a thumbnail from the asset's own URL, name, size, who, when,
    the intended destination), uploads files (choose or drag; the raw body, owner session and CSRF; the same pipeline
    and limits; each answer shows its `staged_id`), places and discards, and allows a delete without bytes. The
    dashboard's CSP allows images from `https://assets.legendkeeper.com` (images only; no other source). Every action is
    audited.
12. **Reading.** `browse_asset_tree` and `list_assets` add, for an image the bridge uploaded, `bridgeUpload` (original
    format, dimensions, frames, conversion, `storedBytesVerified`, staged and its `staged_id`).

## Threat review of the binary endpoint

The endpoint is new, public and unauthenticated by session or bearer: the capability is the only key.

| Threat                                                                                                 | What stops it                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token theft through logs**                                                                           | The token is never in a URL (the endpoint ignores the query string; nothing reads it), the server logs paths only and redacts `authorization`; the token is stored only as a hash; the audit rows name the upload id and the hash, never the token. Tested: neither the audit log nor the errors table contains it.                                                                                  |
| **Token theft through transcripts** (the prepare answer and its scripts are in the agent's transcript) | Single use; 5 minutes; bound to one file by SHA-256 and length, one project and one connection, so a stolen token can only send that same file, once, to the upload the connection itself prepared, and only `upload_image` from that same connection can use what arrives.                                                                                                                          |
| **Replay**                                                                                             | The slot moves `prepared → receiving` atomically before a byte is read; a second request finds it no longer `prepared` and gets the generic refusal. A received file is consumed once (`received → consumed`).                                                                                                                                                                                       |
| **Guessing**                                                                                           | 256-bit tokens, compared by hash in constant time; one generic answer (403 `upload_refused`) for a missing, malformed, wrong-scheme, unknown, expired, used or mismatched capability, so nothing tells which check failed; per-address rate limit.                                                                                                                                                   |
| **Large bodies**                                                                                       | A declared Content-Length over the prepared length is refused before reading; a chunked body is cut at length + 1; `byte_length` is capped at `UPLOAD_MAX_BYTES` when preparing. Fastify does not buffer the body (the route's own parser).                                                                                                                                                          |
| **Slow-loris**                                                                                         | An idle limit (`IMAGE_UPLOAD_IDLE_TIMEOUT_MS`, 15 s with no data) and a whole-body limit (`IMAGE_UPLOAD_BODY_TIMEOUT_MS`, 2 minutes); either drops the body, removes the partial file and spends the slot.                                                                                                                                                                                           |
| **Path traversal**                                                                                     | The file name is a random hex id chosen by the bridge; the upload id must match `upl_` + 22 base64url characters before the database is consulted; nothing the caller sends becomes part of a path.                                                                                                                                                                                                  |
| **Content sniffing**                                                                                   | The body must have the declared SHA-256 and its magic bytes the declared type; it is converted again by `upload_image` (decision 2) before anything reaches LegendKeeper. The endpoint answers JSON with `nosniff` and `no-store`, sets no cookie and sends no CORS header, so a page elsewhere cannot read its answer, and it never serves the file back.                                           |
| **Resource exhaustion**                                                                                | Bytes, pixels and frames are capped; conversions run one at a time with a time limit and a short queue; temporary files expire after 15 minutes and are swept every minute and at start-up; rate limits per principal (`IMAGE_UPLOAD_RATE_PER_PRINCIPAL`, 30 an hour, for prepares and for accepted uploads) and per address (`IMAGE_UPLOAD_RATE_PER_IP`, 60 an hour, refused requests included).    |
| **Abuse by a principal**                                                                               | `prepare_image_upload` needs scope `write` or `propose` (hidden from `read`); the scope is read again when the body arrives (a connection demoted to `read` or removed gets the generic refusal); everything that reaches LegendKeeper still goes through `upload_image` and the policy gate; uploads and refusals are audited with the principal (`image.upload_received`, `image.upload_refused`). |

Caddy passes `POST /uploads/*` with any body size as it is (the site block has no `request_body` limit and proxies
every path); the bridge's own global 1 MiB body limit does not apply to this route. The opt-in sandbox test posts a large
body to the public address and expects the live bridge's generic refusal.

## Consequences

- Images arrive as WebP, verified, in the character's folder, and the same original is never stored twice. An upload
  into an existing folder costs 2 writes, 1 read and 1 download (plus the PUT on the upload tier); each new folder 1
  write and 1 read; staging 1 more write and read (the hide); placing a staged image 1 write and 2 reads (the re-read and
  the read back); a deduplicated call nothing.
- `propose` connections can upload, staged; the owner decides where the image goes.
- A deleted asset is restorable from the bridge for 90 days (restore tools are E1's). A delete whose file cannot be
  fetched waits for the owner. Each image delete costs 1 download more.
- The server needs nothing beyond a normal deploy: `npm ci` installs sharp's prebuilt binary, the deploy installs the
  unit's new memory limits, and the image directory under `/var/lib/lk-bridge` is created by the first upload or the first
  kept file (amended 12 November 2026: it used to be created at start-up, see "Notes: the image directory").
- Open: a thumbnail on the Staging page uses the asset's URL, so a project whose assets are served from another host
  (`LK_ASSET_HOSTS`) shows none until the CSP names it; restore tools for kept bytes are E1's.

## Notes: the Staging page's live updates (12 November 2026, the owner's addendum)

The page listed staged images on load and after its own actions only; an agent's stage, an approved placement or a failed
job never reached it. Decision 11's page now listens. `ImageStore` calls a change listener after every insert and update of
an upload record, the one place every route passes (the service's steps, a job ending, a proposal, the dashboard), and
`ImageService` turns a change to a staged image into the engine bus's `staging` event (`created`, `uploaded`, `failed`,
`placed`, `discarded`, `updated`, with the staged and old counts after it), which the dashboard's stream relays. It is sent
from the service, not the dashboard's routes. A placement proposed at `propose` was only noticed when a read next settled the
record; the service now follows the proposal's events and settles open placements whenever a job ends. An image that was never
staged sends nothing. See docs/dashboard.md, Staging and Stream.

## Notes: the image directory (12 November 2026, the owner's full sandbox run)

All five sandbox files failed in their first second with `EACCES: mkdir '/opt/lk-bridge/app/data/images/upload-tmp'`.
`createSoakRuntime` (`test/sandbox/soak.ts`) handed over `DEFAULT_TOOLS_SETTINGS`, whose `images.dataDir` is `null`
("`images/` next to the database"), and the runtime then resolved "the database" from the config's default path
(`./data/bridge.db`, relative to the working directory, the app folder owned by the build user), not from the temporary
database it had been given. The live bridge was unaffected (its `DB_PATH` is `/var/lib/lk-bridge/bridge.db`), and CI did not
notice because its working directory is writable: every test that built a runtime with the default settings had been
quietly creating `./data/images/` in the repository. Three changes, amending decision 3 of the server layout and the
"created at start-up" line of Consequences:

1. **The runtime derives the default directory from the database it was actually given**, never from a working-directory
   relative default. `src/db/open.ts` has `databaseFile(db)`, which asks SQLite itself (`PRAGMA database_list`) for the
   absolute path of the open file (null for an in-memory or temporary database), and `src/runtime.ts` passes that, not
   `config.server.dbPath`, to the image service. `IMAGE_DATA_DIR` and the project setting still win when given. On the live
   bridge the two are the same file, so nothing moves.
2. **`createSoakRuntime` sets the image directory inside its own temporary directory** (`<temp>/images`), as it already does
   for its database.
3. **The directories are created lazily (my call; the brief left it open).** `upload-tmp/` is created by the first binary upload
   (in `UploadSlots.receive`, `mkdir -p`, mode 0700), `kept-bytes/` by the first file kept (`ByteStore.put`), and the image
   directory itself with the first of them. Constructing the service and starting it touch no folder, and the start-up clean
   and the minute sweep treat a missing directory as an empty one. So a runtime that never handles an upload (the sandbox
   scripts, the maps and chronology tests, a bridge nobody has uploaded to) writes nothing under its data directory, and the
   class of bug cannot come back through a runtime that merely starts. Rejected: creating them at start-up but tolerating
   EACCES, which would hide a real misconfiguration until the first upload. A failure to create the directory at the first
   upload surfaces then, as that upload's error, and spends its slot like any other refusal.

**Tests.** `test/images/directory.test.ts` (derivation from the given database, the explicit settings winning, nothing created
at construction or by a sweep, `upload-tmp` 0700 at the first upload and not before, `kept-bytes` 0700 at the first kept file).
`test/tools/sandbox-runtime-readonly.test.ts` runs `test/sandbox/soak-runtime-readonly.test.ts` under Node's permission model
(`--permission`, writes allowed only in one temporary directory, which holds even for root), as C2d's loader test does for
`node_modules`: the working directory is then a read-only app folder, the inner file first checks the harness really refuses a
write there, then builds `createSoakRuntime` and the real boot path with the default tool settings. It fails with the old code
(checked by restoring it) and passes now.

## Notes: asset files served from `assets2`, and the one redirect an asset download follows (15 November 2026, E5.2)

Arkona's first full snapshot came out partial, with two rows missing: the background image of the Arkona map (page
`bwrldgeo`, asset `jhk3txl4lmrvaupwpf4s8t45`), as the image and as the asset, both "The upload host answered HTTP 302".
The owner's curl showed why: a GET on `assets.legendkeeper.com/<file>.webp` answers `302` with an empty body and
`Location: https://assets2.legendkeeper.com/<file>.webp` (and a HEAD answers 404 with JSON, so HEAD is no probe on this
host). The other 49 files were served directly. The browser follows the redirect; the guarded transport refused every
redirect, and `downloadAsset` reported it as a failure. Because the audits run only on a complete full snapshot, none of
Arkona's would ever run; the same failure would hit the upload's verify, the bytes kept before a delete and an image
restore of any asset LegendKeeper serves from `assets2`. Decided, narrowly:

1. **`assets2.legendkeeper.com` is a known asset host.** `DEFAULT_LK_ASSET_HOSTS` (`src/lk/constants.ts`) lists `assets`
   and `assets2`; they are `LK_ASSET_HOSTS`'s default, the dashboard CSP's `img-src`, and what the snapshot's
   `imageUrls` recognises (an image URL already on `assets2` is an asset image). A **set** `LK_ASSET_HOSTS` is used as it
   is: the owner adds `assets2.legendkeeper.com` to it.
2. **An asset download follows redirects, and nothing else does.** Only `downloadAsset` (`src/images/download.ts`), which
   every caller uses (the upload's verify, kept bytes, snapshot capture and so image restores), follows one: on 301, 302,
   303, 307 or 308 with a `Location`, at most 3 hops, a relative `Location` resolved against the URL that answered. Every
   hop is checked as the first is: `isAssetUrl` (https, no credentials, a host on the list) before it is asked, then the
   transport's own guards on its own request (public addresses, the port allowlist, the DNS answer pinned), and each hop
   is a governed request of its own. Another host is refused with a reason naming it; an `http:` Location, a loop or a
   fourth redirect likewise. A redirect's (empty) body is never taken for the asset. No API key, cookie or other
   credential is sent on any hop (tested). The transport (`createUploadTransport`) hands an asset GET's redirect back as
   it is, a status and a `Location`, and follows nothing itself; the API client, OAuth's metadata fetch and the upload PUT
   still refuse every redirect (tested, unchanged).
3. **The reference stays the URL the page holds.** The snapshot, the hash index and the kept bytes record the original
   URL; the page's image URL is never rewritten. The final URL appears only in the upload verify's detail
   (`servedFrom`).

No migration. Tests: `test/images/redirect.test.ts`, and `test/snapshots/e5-2.test.ts` (a snapshot whose map image
redirects comes out complete). The same day's other finding (old label sizes on map features) is ADR 0046 decision 11.

## Notes: an agent's asset delete is direct (26 November 2026, v3 F12)

[ADR 0081](0081-v3-f12-direct-writes-review-safety-net.md) D3: at scope `write` an agent's `deleteAsset` runs directly;
the bytes are kept before it (the image store's kept references, as for the owner's deletes), and Review's Revert
uploads them again as a new asset in the same folder under the same name, relinking the pages that have not changed
since. Staging at scope `propose` is unchanged.
