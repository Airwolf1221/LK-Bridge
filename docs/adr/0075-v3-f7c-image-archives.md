# ADR 0075: v3 F7c: image archives: zips staged entry by entry, held rather than refused, and the art tools take their entries

- Status: **Proposed** (v3 F7c, 24 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). The sandbox check
  (`f7c-archive`) is opt-in and the owner runs it. Where the brief was silent the choice is marked **chosen**.
- Design: `LK-Bridge-F7c-art-archives-design.md`, APPROVED 23 November 2026, with Z3 revised by the owner, and the
  owner's Z10 (folder layout as hints) of 24 November 2026.
- The problem: the owner zips images for ChatGPT so they are not recompressed, and stages 100 or more at a time, then
  none for hours. `IMAGE_UPLOAD_RATE_PER_PRINCIPAL` (30 an hour, R2-41) refused long batches part-way with
  `RATE_LIMITED`; ChatGPT passes one file a call (ADR 0049), so it had to unzip locally, attach and stage each image and
  gather the staged ids by hand (the owner's Kamigawa Shirahime evidence: 40 images, 15 outfits).
- Amends: PLAN §5 and §8 (amendment 12), ADR 0041 and CR-2026-11-R2's R2-41 (the brake's default and the per-address
  counter), ADR 0058 (a second kind of `waitFor`), ADR 0070 (art images may be archive entries).
- Migration `4400_image_archives.sql`: `image_archives` and `image_archive_entries`.

## Decision 1: the zip library is yauzl 3.4.0

**yauzl** (`yauzl@3.4.0`, MIT, one small dependency, `pend`; typings `@types/yauzl@3.4.0`, development only). Why:

- It **reads from a file descriptor with random access**: the central directory first, then one entry at a time, so a
  zip is never loaded whole (Z2) and one entry can be read again later for its conversion without unpacking the rest.
- It is **maintained** (3.4.0 released in 2026) and is the reader most Node tools build on; it reads **ZIP64**, data
  descriptors and the Info-ZIP Unicode path field, and exposes each entry's encryption flag, method, sizes and CRC-32.
- It **never writes files**: the bridge decides what reaches the disk.
- The others were set aside: adm-zip and JSZip load the archive into memory; fflate's streaming unzip has no random
  access and no ZIP64 central directory; unzipper's maintenance has lapsed and its stream mode trusts local headers.

Two of yauzl's own checks fail the **whole** zip for one bad entry (an unsafe name; a stored entry whose sizes
disagree). The bridge therefore opens it with `decodeStrings: false` and `validateEntrySizes: false` and makes both
checks itself, entry by entry (decision 3), with yauzl's own `getFileNameLowLevel` and `validateFileName`, so one bad
entry is refused alone (**chosen**). Each entry's decompressed size and CRC-32 are checked against its declaration
after it is read.

## Decision 2: `upload_image_archive` lists first and converts when used (Z1, Z9.1, Z9.2)

`upload_image_archive { file | upload_id, character?, stageAll?, operation_id?, project }`, a write tool (so it takes
`workstream`), `_meta["openai/fileParams"]: ["file"]`. `prepare_image_upload` accepts `content_type:
"application/zip"` up to IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES; the binary endpoint then checks the zip signature, not an
image type. ChatGPT's file is downloaded **straight to disk** (`fetchToFile`, the same guarded transport and address
policy as every fetch; its time limit is the larger of UPLOAD_FETCH_TIMEOUT_MS and UPLOAD_PUT_TIMEOUT_MS, **chosen**:
a 43 MB zip does not fit the 15-second image fetch).

The zip is hashed and kept as `images/archives/<archive_id>.zip`, a name the bridge chooses. The same SHA-256 in the
same project **is the same archive** (same id, same rows, nothing staged twice); a discarded or expired one comes back
under its id, its discarded entries listed again. A new archive is **listed** at once: every entry with its path, folder,
size, SHA-256 (a hash pass), format and size from its header (sharp's metadata: header only, never decoded). Nothing is
converted and nothing counts against any limit until an art call uses an entry, or `stageAll: true`. An entry whose
bytes are already staged in the project reuses that staged image. `operation_id` works as on the other tools (the
request's hash names a ChatGPT file by its `file_id`, never its link).

Staging only: nothing is proposed and nothing reaches LegendKeeper.

## Decision 3: safe unpacking (Z2)

The whole archive is refused with **one** error only when it cannot be read (`ARCHIVE_UNREADABLE`), holds more than
IMAGE_ARCHIVE_MAX_ENTRIES records (`ARCHIVE_TOO_MANY_ENTRIES`, the central directory's count, before anything else),
unpacks to more than IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES (`ARCHIVE_TOO_LARGE`, from the declared sizes, before anything
is decompressed; the archive file itself is capped at the same figure), or its declared total is more than 100 times its
size (`ARCHIVE_BOMB`). Every other problem refuses one row (`refused` with its reason): an absolute, climbing or
backslashed path (`UNSAFE_PATH`), an encrypted entry (`ENCRYPTED`), a method other than stored or deflate
(`UNSUPPORTED_COMPRESSION`), an entry over 100:1 (`ARCHIVE_BOMB`) or over the single-image limits (`IMAGE_TOO_LARGE`),
another archive by its first bytes (zip, rar, 7z, gzip, bzip2, xz, zstd, tar: `NESTED_ARCHIVE`, never opened), anything
that is not a PNG, JPEG, GIF or WebP by its first bytes whatever its extension (`NOT_AN_IMAGE`), and bytes that do not
decompress to their declared size and CRC (`ENTRY_UNREADABLE`). Reading an entry stops at its declared size and at the
single-image limit. `__MACOSX/` and hidden files (any part of the path starting with a dot) are skipped, and folders are
not rows. The same SHA-256 twice in one archive is one entry and a `duplicate` row naming it.

**No path taken from a zip is ever written.** The bridge never extracts: an entry is read into memory for its hash and
header, and again for its conversion; the staged file is named by its WebP's SHA-256, as every staged image is.

## Decision 4: three limits, kept apart; held, never refused (Z3, Z9.5)

- **Holding**: IMAGE_STAGED_MAX_BYTES (new, default 5 GiB, `applies: now`), the total size of the images staged on the
  server (each server file once), plus the disk headroom (IMAGE_STAGING_MIN_FREE_GB) and the archive caps. **This is the
  real limit.**
- **Processing**: the image service's one ConversionQueue with IMAGE_CONVERT_CONCURRENCY. The archive worker runs at
  most that many conversions and they go through the same queue: there is no second pool.
- **LegendKeeper writes**: the governor's budgets and tiers, unchanged.
- **The brake**: IMAGE_UPLOAD_RATE_PER_PRINCIPAL, default 30 → **1,000** an hour (range up to 100,000), a runaway brake
  only (R2-41's comment says so). The `prepare_image_upload` and binary-upload per-connection limits are the same
  setting, so they are 1,000 too.
- **Per address**: IMAGE_UPLOAD_RATE_PER_IP now counts only binary-endpoint requests that fail authentication (a missing,
  wrong, used or expired capability) or are refused before it (the connection no longer allowed to write); an
  authenticated request is never counted.

A **single** upload past the brake or the capacity is refused as before, its message naming the cap
(`RATE_LIMITED` … IMAGE_UPLOAD_RATE_PER_PRINCIPAL; `STAGING_FULL` … IMAGE_STAGED_MAX_BYTES). An **archive entry** past
either is **held** (`heldBy: rate` with `expectedAt`, worked out from the brake's window; `heldBy: storage` with no
time). The archive's server copy stays, and a background worker (a pass on each request, on a staged image leaving
staging, and every minute) stages held and queued entries in archive order as the hour moves on or space frees.
Admission is decided synchronously and in order before any conversion starts (the bytes of conversions under way are
counted, so two cannot take the last room); an entry that does not fit holds back the rest of its archive (**chosen**:
archive order). Everything is in the database: a restart resets a cut-short `converting` to `queued` and the worker
resumes. `bridge_archive_status` and the dashboard show each limit separately, with queue positions, `converting`,
waiting for space and waiting for the window.

## Decision 5: entries resume independently (Z9.3)

A conversion failure marks only its entry `failed`, with its reason. A transient one (`IMAGE_CONVERT_TIMEOUT`,
`IMAGE_CONVERTER_BUSY`, an I/O error) is retried once automatically; any other, or a second, leaves it `failed`.
`bridge_archive_status { archive_id, retry: [entries] }` (write or propose scope) queues just those again; an entry not
failed says so and is left alone. Nothing already staged is redone. Entries are named by path, or by base name when only
one entry has it.

## Decision 6: the art tools take archive entries; the job waits (Z4)

In `arkona_add_character_art`, and in `arkona_create_character`'s (and the generic pack tools') art pages, an image may
give `archive: { id, entry }` instead of `staged_id` (exactly one source). One call may draw from several archives and
one archive may feed several calls.

- **Staged**: the entry's staged image is used exactly as its `staged_id`.
- **Not staged yet** (listed, queued, converting, held): the entry is asked for and gets a **reserved staged id** (the
  same one each time it is named); the call plans from its header (a planning record that is never stored), proposes as
  normal, and the package's job carries `waitFor { kind: "archive_staging", stagedIds }` (ADR 0058's mechanism, now
  with a check per kind). The job waits before its first step with `waitReason.held: "waiting_staging"` and a message
  naming what it waits for, shown by `bridge_job_status` and on the Jobs page; the worker pokes the scheduler when it
  stages. The image's upload steps carry `bindStaged { stagedId }` (new, bridge code only): just before each runs, the
  staged image's WebP length, SHA-256 and server file replace the planning placeholders (bound once; a step that may have
  been sent keeps what it was sent with). The placement waiting on an entry is recorded on the entry and put on the
  image's record when it is staged, so the image follows the package as any staged image does.
- **Refused, discarded or failed when the call is made**: that image is left out with its reason (`IMAGE_NOT_USED`
  warnings in the answer) and the others go ahead; if none is left, the call is refused (`ARCHIVE_ENTRIES_UNAVAILABLE`).
- **Refused or discarded while the job waits**: the job runs and that image is **withdrawn**: its upload steps are
  recorded as succeeded with `{ skipped, withdrawn }` and nothing is sent; the Art page's text leaves out its blocks (its
  label heading, image and interpretation: `bindAssetUrls` entries carry `drop`); the read back and the outfit record
  pass it by; the package's own check does not count it as busy. A failed entry keeps the job waiting, its message saying
  to retry it or discard the archive (**chosen**: a manual retry can still save it).

**Why not F5c's `isolateItems`.** A package's items are its pages: every image's steps belong to the Art page's item,
so isolating items would fail the whole Art page with all its other images. The withdrawal above leaves out exactly the
one image (**chosen**, as the brief allows).

## Decision 7: LegendKeeper's limits during a placement job (Z5)

Checked against the governor and `upload-step.ts`, and tested: a 429 or `UPLOAD_RATE_EXCEEDED` with a Retry-After past
the short wait parks the job `waiting_budget` (the step pending again), and it resumes from that step; no step that
succeeded is sent again, so no image already in LegendKeeper is uploaded twice. One gap was found and closed: a
signed upload URL that **expired while the job waited** failed the PUT (`UPLOAD_URL_EXPIRED`). The PUT step now makes
the upload again through the governor (createImageUpload, its own idempotency key), sends the bytes there, and returns
the new key, which `createImageAsset` binds in preference to the expired one's: the image is still sent once and its
asset made once. The mock LegendKeeper was corrected to match PLAN §1.1: it stored a 429 for idempotent replay, which
LegendKeeper never does.

Pinning: a staged image a proposal or job references already never expires (its placement is on its record); a held or
queued entry an open proposal or job waits for pins its archive, whose server copy then never expires.

## Decision 8: lifetime and the dashboard (Z6)

An archive's server copy is removed when every entry is staged, refused, a duplicate or discarded; when it is discarded;
or once it has been unused for its project's staging expiry (`imageStagingMaxDays`, else IMAGE_STAGING_MAX_DAYS) from
its last activity, never while referenced (its unfinished entries then `discarded`, `ARCHIVE_EXPIRED`). The Asset Tree
page lists the project's archives with their rows, statuses, expected times and reasons, the three limits, and a
**Discard** button (step-up; audited `archive.discard`). Discarding leaves staged images staged (the Staging page places
or discards them). Admin API: `GET /api/admin/archives`, `POST /api/admin/archives/:id/discard`.

## Decision 9: folder layout as hints (Z10)

Each row carries `folder` (raw; null at the top level) and `suggestedOutfit` (the last folder name with `-`, `_`, `.`
and `+` as spaces). With `character`, each distinct folder is matched against that character's outfits as an art call
reads them (its asset folders read live, its outfit record, F7's matcher), by its raw name and its display form: `exact`
(with the outfit), `near` (with the candidates `OUTFIT_NEAR_MATCH` would list) or `new`. A character that does not
resolve is reported in `character`, not an error. Top-level entries are never classified, and the bridge never places
by folder: the art call's `outfit` (or its absence) alone decides, after the agent has looked at the image. The guidance
says so, in the tool descriptions, the answers' `guidance` and the bridge guide's art section ("How to decide" is
unchanged: it is at its cap).

## Settings (registry, `.env.example`, `deploy/env.template`)

| Key                                    | Default               | Range                                       | Applies    | Group              |
| -------------------------------------- | --------------------- | ------------------------------------------- | ---------- | ------------------ |
| `IMAGE_STAGED_MAX_BYTES`               | 5,368,709,120 (5 GiB) | 1 MiB to 1 TiB                              | now        | Images and uploads |
| `IMAGE_ARCHIVE_MAX_ENTRIES`            | 300                   | 1 to 10,000                                 | now        | Images and uploads |
| `IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | 2,147,483,648 (2 GiB) | 1 MiB to 20 GiB                             | now        | Images and uploads |
| `IMAGE_UPLOAD_RATE_PER_PRINCIPAL`      | 1,000 (was 30)        | 1 to 100,000 (was 10,000)                   | next start | Images and uploads |
| `IMAGE_UPLOAD_RATE_PER_IP`             | 60 (unchanged)        | unchanged; counts only refused requests now | next start | Images and uploads |

The 100:1 ratio is fixed by the design, not a setting (**chosen**).

## Consequences

- Staging 150 images from one zip takes one call and no hand work; the art call names entries, and a batch past the
  limits finishes on its own.
- The bridge's disk holds archives until they are used up, discarded or expired; the staging capacity bounds what is
  staged from them.
- The owner's example `Ishikawa_Rei.zip` is described as 49 WebP entries, but its folders and loose images add up to 46
  (13 + 11 + 10 + 3 + 9); the fixture follows the per-folder counts.
