# ADR 0071: v3 F7b: seeing character art: `arkona_get_art` (links and inline images with their written authority, a bounded art cache); F7's titled-block defaults completed

- Status: **Proposed** (v3 F7b, 23 November 2026). It builds D1 to D4, D6 and D7 of the owner-approved design
  `LK-Bridge-F7b-art-download-design.md` (approved 23 November 2026), and completes F7's G10 from the owner's live probe
  of 23 November 2026. Every decision is implemented and tested against the mock LegendKeeper; nothing in this session
  touched a live system (no LegendKeeper, no bridge connector, no asset host, no sandbox run). Where the design was silent
  the choice is marked **chosen**.
- The problem (the owner, 23 November 2026): agents need to SEE character art to use it as a literal visual reference
  (the Visual References rules). ChatGPT could not: `getAsset` returns only metadata, its code sandbox cannot reach
  `assets.legendkeeper.com`, so it showed generic web images as if they were the character. ChatGPT's web browsing tool
  did open `https://assets.legendkeeper.com/cmretrj150aph43prgyxsdbsn_5aa52e7d-…webp` and described it correctly: the
  public URL is ChatGPT's route. ChatGPT's connector drops MCP `image` content blocks (forum reports, February to
  September 2026); Claude reads them. So the tool gives both.
- Builds on: [ADR 0070](0070-v3-f7-guided-character-art.md) (the outfit record and matcher, G3; the live folder read,
  G9; the image URL check, G11), [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (the full-text and asset
  reference index), [ADR 0041](0041-image-pipeline.md) (`downloadAsset`, the guarded transport, `sharp`).
- Amends: [ADR 0070](0070-v3-f7-guided-character-art.md) decision 8 (the confirmed titled-block defaults, decision 9
  here); [ADR 0041](0041-image-pipeline.md) (`downloadAsset` may count a download on the budget, decision 6).
- No migration: the art cache is files on disk (decision 5).

## Decision 1 (D1): one read-only pack tool, exactly one selector

`arkona_get_art { asset? | character? (outfit? | design?) | page? (document?), delivery?, limit?, cursor?, project }`,
`access: 'read'` (read-only annotations), listed while the Arkona pack is attached to a served project, as the other
character tools (`get_art` is the character hook's fourth tool, read-only: no per-tool switch). It never writes to
LegendKeeper. Exactly one selector, else `SELECTOR_REQUIRED`; `outfit` and `design` only with `character`, never both;
`document` only with `page` (`INVALID_INPUT`).

- **`asset`**: 1 to 6 asset ids or file URLs. A URL must be an https URL on an asset host (`NOT_ASSET_URL`). It is
  matched EXACTLY to an image asset of the project (both forms, `…/<projectId>_<uuid>.webp` and `…/<uuid>.webp`); one
  the asset tree lacks goes through F7's URL check (G11: the whole listing read live, at most once every five minutes
  per project). An id the tree lacks is read live (`getAsset`, one read). Not found, or not an image, is listed in
  `notFound` (`ASSET_NOT_FOUND`, `NOT_AN_IMAGE`) and never fails the call.
- **`character`**: found as the character tools find it (`CHARACTER_NOT_FOUND`, `CHARACTER_AMBIGUOUS`); its asset folder
  read **live** first by F7's code, now shared (`liveArtFolder`, src/packs/art-place.ts: the folder found as the planner
  finds it, its parent read first when the tree lacks it, then the folder and three levels below; a failed read is
  `ART_FOLDERS_UNREADABLE`, nothing decided from the cache). Its art in its folder's order: design pieces, Wardrobe's
  loose pieces, each outfit folder's (by name), then any legacy folder's, each with its `group`. `outfit` is resolved by
  F7's own `decidePlacement` (the record, the layout's outfits, names and aliases case- and spacing-blind): a near miss is
  `OUTFIT_NEAR_MATCH` with its candidates; a name that matches no outfit is `OUTFIT_NOT_FOUND`, listing the outfits
  (**chosen**: F7 would make it a new outfit; there is nothing to see). Its pieces are exactly what placement counts as
  the outfit's (its folder's items, else the recorded or named loose pieces). `design: true`: the character folder's own
  items only.
- **`page`**: resolved as `read_document` resolves a page (inside the AI REPOSITORY); every page document read live
  (one read each), or the one `document` names; every image block (nested ones in place) in document order, each with
  its `block` (document, block id, alt). Its URLs are matched to assets as above, for the images of this call only.
- **Paging**: at most 6 a call (`limit` 1 to 6); `nextCursor` (opaque: the selection's hash and the offset) continues;
  a cursor of another selection is `CURSOR_INVALID`. **Chosen:** each page of results re-reads its selection live (the
  folders, the page), so a change between calls can shift the list; the answer's `total` says what was read.

## Decision 2 (D2): each image's written authority

Each image: `assetId`, `name`, `folder` (its path), `width`, `height`, `format` (from the URL; the delivered one is in
`inline`), `bytes` (the asset tree's size, else the original's once downloaded), `url`, and `authority`
(src/art/view/authority.ts):

- **Where**: the bridge's asset reference index (`appraisal_images`: every image block of every page in the newest
  snapshot, by its URL's PATH, so the same file on `assets` and `assets2` matches) and the snapshot store's copy of each
  embedding document; never LegendKeeper's search. A document this call read live (the page selector) stands in for its
  snapshot copy; the page's other documents still count. Every page the index holds is looked at (the AI REPOSITORY;
  a page in the Legacy Canon Archive or the Design References carries its `area`). "Look first on the character's Art
  and Wardrobe pages" is the ORDER: a page whose Reference Type or tags are the pack's `artView.ownerPages` (Character
  Art, Character Physical & Visual Reference, Character Wardrobe & Personal Presentation Reference; the tags Character
  Art, Visual Reference, Wardrobe), or the character's Art page by name, is `ownerPage: true` and listed first within its
  lifecycle.
- **What**: per embedding image block: `page` (id, name, path), `document`, `section` (the heading path above it; a
  container's heading governs only inside it, as the appraisal reads sections), `lifecycle`, `label` (the block's alt
  text), `text`: the blocks that follow the image in the same list, up to the next image or heading, joined by blank
  lines, trimmed to `artView.textChars` (1,200) characters **including** a closing "…", with `truncated: true`; `from`
  (`snapshot` or `live`).
- **Order**: Authoritative, then no lifecycle (an index), then Working, then Archived; owner pages first within each;
  then by path.
- **Status**: `found`; `none` with the warning "No owner page embeds this image; it establishes nothing about canon";
  **chosen**: `unavailable` (with the reason) when there is no index yet (no full snapshot), never `none`, which would be
  a claim. With no index, pages read live in the call still answer (`found`, `partial` saying why the rest is unknown).
- **Freshness**: the answer's `authorityFrom` names the snapshot the index is current to, and the pages read live.
- **Size**: **chosen**: when the JSON would pass `MCP_RESULT_MAX_CHARS`, the text of each image's later embedding pages
  is dropped (`textOmitted`, saying to call for that image alone); the first page's text always stays.

## Decision 3 (D3): links

`url` is the asset's own file URL exactly as LegendKeeper gives it (the asset tree holds `getAsset`'s and
`listAssets`' value; an asset read live gives it directly). No bridge-hosted link. `howToView` ("Open each url with your
web browsing tool, not with code: code sandboxes cannot reach this host.") is on every result that includes links:
`delivery` `link` or `both`, or `inline` when any image came as a link only (a failure or the size cap). `url` is on
every image, whatever the delivery (**chosen**: an image that failed inline must keep its link, D4).

## Decision 4 (D4): inline images

One MCP `image` content block per image delivered inline, after the JSON text block, in the images' order;
`inline.content` is its position. src/art/view/derive.ts, with `sharp`:

- the EXIF orientation applied (`rotate()`), every piece of metadata dropped (sharp keeps none unless asked);
- the long edge at most 1,568 px, never enlarged; the first frame of an animation only (**chosen**: a reference image);
- WebP at quality 82; for a source without alpha, JPEG at the same quality when the WebP is the larger (decided at every
  step, white behind any transparency JPEG cannot hold, which by the rule never arises);
- under 1,000,000 bytes: the quality steps 82, 75, 68, 60, then the long edge shrinks to 85 % a step at quality 60;
  **chosen**: never below 256 px, delivered over the target then with `overTarget: true`;
- `inline` reports `format`, `width`, `height`, `bytes` and `cached`; the original's size goes in `bytes` when the tree
  had none.

The result carries at most 6,000,000 bytes of image data (the raw derivatives; base64 adds a third on the wire): an image
past it comes as a link only, `inlineSkipped: "result size"`. A download or resize that fails gives that image
`inline: { ok: false, reason }`, its link and authority kept; the call never fails for it. `ART_VIEW_LIMITS` holds the
cap and the byte target as a test seam only (six derivatives under 1 MB never reach 6 MB, so the cap's test lowers it);
nothing in the bridge changes them.

## Decision 5 (D6): the art cache

src/art/view/cache.ts: files under `ART_CACHE_DIR`, default `art-cache/` beside the database (DB_PATH's directory; a
private temporary directory per runtime for an in-memory database, so test runtimes never share entries).
Content-addressed: the key is the SHA-256 of the asset id, the file URL and the size parameters (`DERIVE_PARAMS`), so a
changed URL, or a change to the rules, is fetched again. Each entry is `<key>.bin` (the derivative) and `<key>.json`
(what it is), written to temporary names then renamed. Bounded by `ART_CACHE_MAX_MB` (default 500): after a write that
takes the total over it, the least recently used entries (by modification time, touched on every hit) are deleted until
it fits. **Chosen:** the original is not kept (the tests need it not; it would double the disk for nothing an agent
reads). The cache holds nothing in memory but its running total; a full or unwritable disk never fails a call (the
derivative is delivered, uncached). Both names are in `.env.example`, without values.

## Decision 6 (D6): cost, and the one fetch path

Bytes from LegendKeeper come only through `downloadAsset` (src/images/download.ts): the project's governor and the
guarded transport (LK_ASSET_HOSTS, the pinned DNS answer, no API key, the `assets` → `assets2` redirect). It gains one
option, `costs`: what the download draws on the project's budget, on its **first hop only** (a redirect's hops are the
same download); default none, so every other caller is unchanged. `arkona_get_art` passes the tiers of one read
(`getAsset`'s: key minute, hour and day, project hour), at P1, with the call's abort signal. A cache hit is free;
`delivery: "link"` never downloads. The description states "Cost: none for links; 1 read per image downloaded for inline
(cached)", and the live reads that select (a character's folders, a page's documents, an asset id the tree lacks). The
answer's `reads` gives the live reads, the downloads and the cache hits.

## Decision 7: the pack seed `arkona-2026-11-23-f7b`

It supersedes `-f5c` and adds `artView` (`ownerPages.referenceTypes`, `ownerPages.tags`, `textChars: 1200`) to the
rules (an optional block of the rules' schema). Offered as a new version waiting for the owner's approval, as every seed
is. **Chosen:** the tool reads `artView` from the pack's current version, else `DEFAULT_ART_VIEW` (the same values), and
does not read the pack's governance, as `arkona_character_brief` does, so it answers while the version waits.

## Decision 8 (D7): guidance and governance

The bridge guide gains "Seeing character art" (under Setting packs): call `arkona_get_art` before describing, drawing on
or writing about a character's appearance; what it returns is literal, read with the `authority` text, which governs;
images that did not arrive inline are opened by `url` with web browsing, never code; never an image found elsewhere; if
no route reaches you, say you could not see the art. "How to decide" gains ONE row of its which-tool table and nothing
more. That row is 166 characters (the table is padded), so the section grows from 9,282 to 9,448 characters: the test's
bound moves from 9,400 to 9,450 (**chosen**, for the owner to confirm: no existing text was cut to make room). The
Setting packs table gains its row too. LegendKeeper is not edited: the sentence for the Visual References page is in the
session's report, for the owner's reviewer to write after deploy.

## Decision 9: F7's titled-block defaults completed (G10)

F7's sandbox probe B3, run live by the owner on 23 November 2026, recorded what LegendKeeper stores for a block written
without `title` and `isTitleHidden`. `TITLED_BLOCK_DEFAULTS` (src/jobs/verify-blocks.ts) now holds: image "Image",
hidden; embed "Embed", hidden; keyValue "Stats", shown; resourceCollection "Collection", shown; resourceLink "Links",
shown; map "Map", shown; textField "Text", shown. `meter` is left out, so a difference on it is still reported: the
probe's minimal meter was refused (Validation error) because its item had no `icon`, which the spec's `MeterBlock`
requires with `name`, `current` and `max`. The probe now sends `{ kind: "meter", mode: "bar", items: [{ name: "Probe",
icon: "heart", current: 1, max: 2 }] }` (the shape the snapshot check already writes), so its next run prints meter's
values; the sandbox README says so. One verifier test per kind (test/f7b/verify-titled-kinds.test.ts).

## Decision 10: the sandbox step (opt-in)

`npm run test:sandbox` with `-- f7b-art` (`test/sandbox/f7b-art.ts`; on the server
`sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f7b-art`), on the test project, on a
temporary database copied read-only from the bridge's (`copyBridgeState`): A0 the asset tree and the pack attached; A1 one
small image uploaded into a throwaway folder and a throwaway page under the AI REPOSITORY showing it with its alt text and
a paragraph; A2 `link` (prints the URL, checked against `getAsset`); A3 `inline` by the page (prints the inline block's
size, format and dimensions and the authority found, from the page read live); A4 `both` by the asset again (prints the
cache hit). Clean-up in `finally` and `afterAll`. Runs on the mock in the ordinary suite
(`test/sandbox-mock/f7b-art.test.ts`).

## Consequences

- An agent sees a character's art in Claude (image blocks) and in ChatGPT (the public URL, opened with web browsing),
  always with the owner's written authority beside it, and is told never to substitute another image.
- Inline images cost one read each the first time and nothing after, within a disk cache of at most 500 MB by default;
  links cost nothing.
- The authority is as fresh as the newest snapshot (said in each answer), except for pages read live in the call.
- The verifier stops reporting LegendKeeper's defaults for seven titled kinds; meter still reports until the probe's next
  run prints it.
- Tests: `test/f7b/` (derive, cache, authority, get-art, memory, guide, verify-titled-kinds),
  `test/sandbox-mock/f7b-art.test.ts`, and a redirect-counting case in `test/images/redirect.test.ts`.
