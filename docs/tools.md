# MCP tools (chunk 3)

LK-Bridge exposes LegendKeeper to Claude, Claude Code and ChatGPT as a small set of MCP tools. The 89 LegendKeeper operations sit behind a few **meta-tools**, so the tool list stays short; per-operation tools are optional. Every call goes through the job engine and the rate governor, and every result ends with a one-line budget footer.

Since v2 A1 one bridge serves **several LegendKeeper projects** (each with its own key, so its own rate budget). Every tool takes an optional `project` argument, and every result names the project it used: see [Projects](#projects) and [projects.md](projects.md).

Source: `src/mcp/tools/`. Design notes: [ADR 0011](adr/0011-tool-layer.md). Authentication: [auth.md](auth.md).

## Agent guidance (the MCP server `instructions`)

> LK-Bridge gives governed access to LegendKeeper projects (list_projects); every tool takes an optional project, and a write must name its project when the bridge serves several. Call get_bridge_guide first: it explains projects, the repository tree, finding and reading pages, writing, budgets and proposals. Find pages with search and browse_repository_tree, read them with get_resource and read_document (Markdown; see get_markdown_guide). Every result names its project and ends with that project's budget line; budgets are finite, so never loop on budget errors, and check bridge_estimate before hundreds of calls. Never retry a write that returned waiting_budget, queued or proposal_captured: follow a job with bridge_job_status and a proposal with bridge_proposal_status. Results are summaries (detail "full" opts in); oversized results come as handles for bridge_result_page. The lk_api_* tools are the low-level fallback.

The text is `BRIDGE_INSTRUCTIONS` in `src/mcp/tools/index.ts`; a test checks it covers each point. Since v2 B2 it is short and points to the bridge guide ([bridge-guide.md](bridge-guide.md), served by `get_bridge_guide`); the detail that used to be here lives in the guide.

## How results look

Every result is one text block: compact JSON naming the project, then that project's budget footer on the last line.

```
{"project":"arkona","status":"succeeded","operationId":"getDocumentBlocks","result":{"id":"d1","version":"v3","blockCount":12,"outline":[…]},"requestIds":["lkb.r….1"]}
budget (arkona): writes 87/120·min 2,410/3,000·h | all 241/300·min 5,102/6,000·h 48k/60k·d | project 9.8k/12k·h | queue P1:0 P2:14
```

A refused `project` argument (below) carries the default project's footer, since that is where a read would have gone.

- **Summaries by default.** Lists become `{ count, hasMore, nextCursor, items }` with scalar fields only (ids, names, versions; nested values become counts). A block tree becomes `{ version, blockCount, outline[…], unsupportedBlockIds }`. Pass `detail: "full"` for whole payloads.
- **Handles for big results.** A result over `MCP_RESULT_MAX_CHARS` (default 40,000 characters, far below Claude Code's 25,000-token cut-off) is stored as a job artefact (a succeeded one-step job) and comes back as `{ "status": "stored", "handle": "art_…", "preview": … }`. Page it with `bridge_result_page`.
- **Typed errors.** A failure is `{ "error": { "code", "message", … } }` with `isError: true`. Codes include `WRONG_TOOL_FOR_OPERATION`, `UNKNOWN_OPERATION`, `INVALID_PARAMS`, `VERSION_CONFLICT` (with `currentVersion`), `UNSUPPORTED_BLOCK_LOSS` (with `blockIds`), `CASCADE_CONFIRM_REQUIRED`, `READ_ONLY`, `MEMBER_ADMIN_DISABLED`, `POLICY_DENIED`, `BUDGET_EXHAUSTED` (with `retryAt`), `LK_ERROR` (with `lkCode`, `status`, `requestId`), the project codes `UNKNOWN_PROJECT`, `PROJECT_REQUIRED` and `PROJECT_UNAVAILABLE` (each with `registered`, the project names), and the upload codes below.
- **Not errors:** `queued`, `waiting_budget` and `proposal_captured` mean the write is accepted or waiting. Never retry it; follow it with `bridge_job_status`.

## Projects

The bridge serves the projects listed in `LK_PROJECTS` (one key each; [projects.md](projects.md)). Every tool takes an optional **`project`**: a project name (any case) or its LegendKeeper id.

- **Unknown project:** refused with `UNKNOWN_PROJECT` and `registered`, the names you may use. Nothing is sent or recorded.
- **Reads without `project`** use the default project (`LK_DEFAULT_PROJECT`).
- **Writes without `project`** are refused with `PROJECT_REQUIRED` while the bridge serves more than one project (`REQUIRE_PROJECT_FOR_WRITES=true`, the default), so a forgotten argument can never land in the wrong project. With one project, or with the setting off, they go to the default project. This covers every write tool (`lk_api_write`, `lk_api_batch`, `lk_upload_image`, `bridge_job_cancel` and the write `lk_op_*` tools), and writes at scope `propose` too.
- **A project that is not served now** (its key was refused, it belongs to another project than the one stored, or LegendKeeper could not be reached at start-up) is refused with `PROJECT_UNAVAILABLE` and the reason. The other projects carry on.
- **Each project has its own budget.** The footer names the project: `budget (arkona): …`. Exhausting one project's tier never slows another (the writer pool, `WRITERS_MAX`, is shared, with turns across projects).
- **Records belong to a project.** Jobs, stored results, errors, journal entries and proposals are those of the asked project only: a job id of another project answers like one that does not exist.

**`list_projects`** `{}`: the projects this bridge serves: `name` (pass it as `project`), LegendKeeper `id`, `displayName`, `default`, `readOnly`, `available` (with `reason` when not), and `writesNeedProject`. Never a key, and not whether a project is a sandbox.

```json
{"project":"arkona","count":2,"default":"arkona","writesNeedProject":true,"projects":[{"name":"arkona","id":"lkp_…","displayName":"Arkona","default":true,"readOnly":false,"available":true},{"name":"test","id":"lkp_…","displayName":"Test","default":false,"readOnly":false,"available":true}]}
budget (arkona): writes 0/120·min …
```

## Tool reference

`access` (`read` or `write`) is what the policy layer filters on: a connection whose profile has scope `read` sees only `read` tools, and a direct call to a hidden `write` tool is refused with the read-only message; the engine's policy gate refuses the write in any case ([policy.md](policy.md)). Annotations are what Claude and ChatGPT use to decide what to auto-approve: read tools are `readOnlyHint: true`; write tools are `readOnlyHint: false`.

| Tool                        | Access | Annotations (read-only / destructive / idempotent / open-world) | Cost                                      |
| --------------------------- | ------ | --------------------------------------------------------------- | ----------------------------------------- |
| `list_projects`             | read   | true / false / true / false                                     | none                                      |
| `browse_repository_tree`    | read   | true / false / true / false                                     | none (the tree)                           |
| `browse_asset_tree`         | read   | true / false / true / false                                     | none (the asset tree)                     |
| `search`                    | read   | true / false / true / false                                     | none; 1 read with `content: true`         |
| `get_resource`              | read   | true / false / true / false                                     | 1 read (none with `live: false`)          |
| `get_resources`             | read   | true / false / true / false                                     | 1 read per page, one job                  |
| `list_tags`                 | read   | true / false / true / false                                     | none (the tree)                           |
| `list_templates`            | read   | true / false / true / false                                     | none, or 1 read per 100 templates         |
| `list_calendars`            | read   | true / false / true / false                                     | 1 read                                    |
| `list_assets`               | read   | true / false / true / false                                     | none (the asset tree)                     |
| `read_document`             | read   | true / false / true / false                                     | 1 read (a timeline: 2 + 1 per 100 events) |
| `write_page`                | write  | false / **true** / false / false                                | 2 reads + 1 write + 1 verify read         |
| `get_markdown_guide`        | read   | true / false / true / false                                     | none                                      |
| `get_bridge_guide`          | read   | true / false / true / false                                     | none                                      |
| `lk_api_list_operations`    | read   | true / false / true / false                                     | none                                      |
| `lk_api_describe_operation` | read   | true / false / true / false                                     | none                                      |
| `lk_api_read`               | read   | true / false / true / false                                     | 1 read                                    |
| `lk_api_write`              | write  | false / **true** / false / false                                | 1 write (+ items for createMany)          |
| `lk_api_batch`              | write  | false / **true** / false / false                                | sum of its steps, at job priority         |
| `lk_api_paginate_all`       | read   | true / false / true / false                                     | 1 read per page of 100                    |
| `lk_upload_image`           | write  | false / false / false / **true**                                | 2 writes (+ upload-tier backoff)          |
| `bridge_info`               | read   | true / false / true / false                                     | up to 2 cached reads (10 min)             |
| `bridge_budget`             | read   | true / false / true / false                                     | none                                      |
| `bridge_estimate`           | read   | true / false / true / false                                     | none                                      |
| `bridge_job_status`         | read   | true / false / true / false                                     | none                                      |
| `bridge_job_wait`           | read   | true / false / true / false                                     | none (waits at most 25 s)                 |
| `bridge_job_cancel`         | write  | false / false / true / false                                    | none                                      |
| `bridge_errors_recent`      | read   | true / false / true / false                                     | none                                      |
| `bridge_journal_lookup`     | read   | true / false / true / false                                     | none                                      |
| `bridge_result_page`        | read   | true / false / true / false                                     | none                                      |
| `bridge_proposal_status`    | read   | true / false / true / false                                     | none                                      |
| `bridge_proposals_mine`     | read   | true / false / true / false                                     | none                                      |
| `lk_op_<operationId>` (89)  | per op | derived from the operation, see below                           | that of the operation                     |

`lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all` and every `lk_op_*` are **low-level tools**: since v2 B2 they are left out of the tool list of a profile whose **show low-level tools** setting is off (the default; [below](#visibility-of-the-low-level-tools)).

`lk_api_write` is annotated `destructiveHint: true` because it covers the destructive operations; clients therefore ask before each write.

### Low-level layer

**`lk_api_list_operations`** `{ tag?, kind?, risk? }`: the 89 operations with kind (`read` / `write` / `upload`), risk (`safe` / `destructive` / `admin`), cost class, one-line summary, `versioned`, `paged`.

**`lk_api_describe_operation`** `{ operationId }`: the input JSON Schema (with only the `$defs` it uses), risk, concurrency, whether it is versioned and which read gives the version, rate costs, and the guards that apply. A very large schema (the block model) comes back as a handle.

**`lk_api_read`** `{ operationId, params?, detail? }`: runs ONE operation whose kind is `read`. A write operation is refused with `WRONG_TOOL_FOR_OPERATION` (`useTool: "lk_api_write"`) and costs nothing.

```json
{ "operationId": "getDocumentBlocks", "params": { "path": { "resourceId": "r1", "documentId": "d1" } } }
```

`params` is `{ path?, query?, ifMatch?, body? }`; `projectId` is supplied by the bridge, from the `project` argument (every tool below also takes `project`, which these signatures leave out).

**`lk_api_write`** `{ operationId, params?, allowUnsupportedLoss?, confirm?, detail? }`: runs ONE operation whose kind is not `read`, including the raw `createImageUpload` and `createImageAsset`. A read operation is refused with `useTool: "lk_api_read"`. Every engine guard applies:

- versioned writes always send `If-Match`: your `params.ifMatch` if you give it (a stale one is refused with the current version), otherwise the version the bridge reads just before writing;
- a replace that would delete `unsupported` blocks, or a `deleteBlock` whose block or subtree holds one, is refused unless `allowUnsupportedLoss: true` (an `unsupported` block without an id can never be kept: run `assignBlockIds` first);
- `deleteResource` with `query.cascade = true` needs `confirm: "cascade"`;
- `inviteMember`, `removeMember`, `revokeInvite` are refused unless `LK_ALLOW_MEMBER_ADMIN=true`;
- everything is refused while the bridge is read-only.

```json
{
  "operationId": "replaceDocumentBlocks",
  "params": {
    "path": { "resourceId": "r1", "documentId": "d1" },
    "ifMatch": "v3",
    "body": { "blocks": [{ "kind": "paragraph", "content": [{ "text": "Hello" }] }] }
  }
}
```

**`lk_api_batch`** `{ calls: [{ operationId, params?, allowUnsupportedLoss?, confirm? }], onError?, title? }`: one persisted `batch_ops` job. `onError` is `stop` (stop on error, default) or `continue`. Every step is validated and checked against the guards and policy before anything is queued. Returns `{ jobId, status: "queued", eta }`.

**`lk_api_paginate_all`** `{ operationId, params?, maxItems?, maxPages? }`: a `paginate_all` job over a paged read (`listResources`, `listTemplates`, `listEvents`, `listAssets`, `listProjects`). Each page is its own governed read at job priority. Returns `{ jobId, handle }`; the items are readable through `bridge_result_page` while the job runs.

**`lk_upload_image`** `{ name, base64 | url, contentType?, description?, folderId?, waitSeconds? }`: see [Image upload](#image-upload).

**Per-operation tools.** With `MCP_EXPOSE_PER_OP_TOOLS=true` the bridge also registers `lk_op_<operationId>` for all 89 operations (119 tools in all, 121 with the policy layer’s two proposal tools). Each takes the operation's own input (`path`, `query`, `ifMatch`, `body`) plus `detail` (and `allowUnsupportedLoss` / `confirm` on writes), runs through exactly the same path, and records its own name as the job's tool. `access` equals the operation's kind. Annotations come from the operation: reads are read-only and idempotent; writes are `destructiveHint: true` when the operation's risk is `destructive` or `admin`, and `idempotentHint: true` for PUT, DELETE, move, restore, assign-block-ids and delete-shapes. This lists about 600 KB of schemas, which is why it is off by default.

### Bridge awareness

**`bridge_info`** `{ project? }`: version; the asked project (`projectInfo`: name, id, display name, default, read-only, available) and every project (`projects`); the project's LegendKeeper name and the key's role (`ADMIN`, `MEMBER` or `unknown`; inferred from `listMembers`, because LK shows member emails to ADMIN keys only); read-only flag (`effective`; `bridge`, the bridge-wide flag; `project`, the project's own flag; configured, overridden); whether writes are paused or draining, and `canWrite`; writer pool; the calling connection, its profile and its live scope (`read`, `propose` or `write`), and `canWriteAs` (`direct`, `proposal (the owner approves)` or `no (read-only)`). The project name and role come from one lookup per project shared by every caller and cached for 10 minutes; it runs as the bridge's own work (`system` principal, v1.0.1), so a failure there shows on the dashboard's Errors page under `system`, not in a caller's `bridge_errors_recent`.

**`bridge_budget`** `{ project?, allProjects? }`: one project's tiers (used, limit, remaining, seconds to reset, any block after a 429, drift), queue depth per priority, write pacing. `allProjects: true` lists every project's budget side by side.

**`bridge_estimate`** `{ reads?, writes?, createManyItems?, priority? }`: against the asked project's budget, projected wall-clock time, the tightest tier, whether it fits today's request budget, with advice. Call it before large workloads.

**Your own work only.** `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_result_page` and `bridge_errors_recent` show only the calling connection's jobs, stored results and errors; another connection's job id or handle answers exactly like one that does not exist. `bridge_journal_lookup` shows every connection's writes (so agents can cross-check each other), each with its principal, profile and approver; job ids appear only on your own entries, and a `jobId` filter matches only your own jobs.

**`bridge_job_status`** `{ jobId?, steps?, status?, limit? }`: one job (status, progress, last error, result, failed steps), or recent jobs when `jobId` is omitted. Signed-URL material is redacted.

**`bridge_job_wait`** `{ jobId, seconds? }`: waits at most 25 seconds, then returns the job as it stands (`done: true` when finished).

**`bridge_job_cancel`** `{ jobId }`: the step in flight finishes; nothing further is sent; finished steps are not undone.

**`bridge_errors_recent`** `{ grouped?, limit?, sinceMinutes?, jobId? }`: failures grouped by operation, code and path (default), or one row each, with LegendKeeper `requestId`s.

**`bridge_journal_lookup`** `{ resourceId?, documentId?, targetId?, operationId?, jobId?, principalId?, profile?, outcome?, withPreImage?, before?, sinceMinutes?, limit?, includePreImage? }`: the write journal, newest first. Since chunk 8 it holds **every** write the bridge sends (creates, inserts, patches, deletes), each with operation, target, time, outcome (`applied`, `not_applied`, `unknown`, `pending`), principal, profile and approver; destructive writes also keep their pre-image. Since v2 C1 an entry made by a high-level tool also has `operation`: for `write_page` the tool, mode, section, a SHA-256 of the Markdown (`markdownSha256`) and its length, the version the plan was built on (`plannedOn`), the agent's `baseVersion`, `dropRegions`, and `replannedInLock` when the bridge re-planned a section edit inside the lock. `targetId` also matches every resource a `createManyResources` created. Pages hold `limit` entries (default 10, at most 100); when a page is full, `nextBefore` is the cursor for the next, older page (`before`).

**`bridge_proposal_status`** `{ proposalId }` and **`bridge_proposals_mine`** `{ state?, limit? }`: your own proposals in the asked project (a proposal belongs to the project its write was for, and runs there once approved) (writes at scope `propose`, waiting for the owner): state, summary, the rejection reason, the conflicting operation and the job once executed ([policy.md](policy.md)). Since v2 C1 a proposal made by a high-level tool also has `operation`, briefly (for `write_page`: the tool, page, document, mode, section, the version it was planned on and the counts; never the Markdown).

**`bridge_result_page`** `{ handle, offset?, limit?, detail? }`: for a paginate handle `offset` and `limit` count items (the page is trimmed to the output budget; use `nextOffset`); for a stored oversized result `offset` counts characters of the JSON text and slices must be concatenated in order.

## Discover and read tools (v2 B2)

The first tools built on the bridge's own models (the repository tree, the asset tree and the type registry) and on the
Markdown converter. All are `read` tools with `readOnlyHint: true`, take the optional `project`, and end with the
project's budget line. Design: [ADR 0029](adr/0029-discover-and-read-tools.md). The agent guide is
[bridge-guide.md](bridge-guide.md).

**Rules that hold for all of them**

- **Only the AI REPOSITORY.** A page outside the project's AI REPOSITORY root is refused (`NOT_FOUND`, or
  `NOT_IN_REPOSITORY` for an id-shaped query), with a message that `lk_api_read` can still reach it. The asset library
  has no such root and is browsable whole; templates are listed by `list_templates`.
- **Names or ids.** A page is a name or an id, resolved by A3's resolver (display name, full name, alias, Canonical
  Display Name; a stray `[INDEX]` or `[BSRC]` is removed). Several matches are refused as `AMBIGUOUS` with `candidates`
  (id, name, kind, path); none is `NOT_FOUND` with `near` names as a hint only. Nothing is guessed.
- **The tree's status.** Every answer from the tree has `tree: { status, confirmedAt, confirmed, note? }`. `stale` still
  answers (and says so); `not_configured`, `not_built` and `building` are refused with `TREE_NOT_CONFIGURED` or
  `TREE_NOT_READY`, with nothing spent. Asset answers carry `assetTree` the same way and refuse with
  `ASSET_TREE_NOT_READY`.
- **Sizes.** Summaries by default; a result longer than `MCP_RESULT_MAX_CHARS` is stored and comes back as
  `{ status: "stored", handle, chars, preview }` for `bridge_result_page`. Default results stay under 20,000 tokens (3.5
  characters per token) on the test world's largest subtree, a 100-result search and the Fourth Age table page.

### Finding things

**`browse_repository_tree`** `{ path?, depth?, kinds?, limit?, offset? }`: a subtree, nested. Each page: `id`, `name`
(display), `kind` (`index` / `bsrc` / `unclassified`), `type` (Reference Type), `scope` (shortened to 60 characters),
`tags`, `childCount`, and `children` down to `depth` (default 2, at most 6; 0 is the page alone). `path` is a name, an id
or `"Characters / Beastkin / Foxians"` (default: the root). `kinds` leaves out other kinds (and their subtrees; `matchingChildren` says how many matched).
`limit` (default 150, at most 400) cuts the listing level by level and says so (`truncated`, `nextOffset`); `offset`
skips the first page's children. Cost: none.

```json
{ "path": "Foxians", "depth": 2 }
```

**`browse_asset_tree`** `{ folder?, depth?, includeAssets?, assetsPerFolder?, limit? }`: the same for asset folders:
each folder's `folderCount` and `assetCount`, subfolders to `depth`, and with `includeAssets: true` up to
`assetsPerFolder` (20) assets per folder (name, type, dimensions, size where LegendKeeper says). `folder` is an id, a name
or a path (`"Characters / Beastkin / Qishen"`); a name shared by several folders is `AMBIGUOUS` with their paths. Cost: none.

**`search`** `{ query, content?, limit?, offset? }`. Syntax: words (all must match), `"quoted phrases"`, `OR`, `NOT` or a
leading `-`, `( )`, and the filters `name:` `tag:` `type:` (Reference Type, whole words) `kind:` (`index` / `bsrc` /
`unclassified`) `under:` (a page name or id; pages below it) `scope:`. `NOT` binds tightest, then `AND` (spaces), then
`OR`; `OR`, `AND` and `NOT` are operators only in capitals. A word without a filter matches the display name, aliases,
Canonical Display Name and Scope. Results are ranked exact name, name prefix, a word of the name, text inside the name,
alias or Canonical Display Name, then Scope, and each result's `matched` says why. A malformed query is `SEARCH_SYNTAX`
with `position` and an explanation. Cost: none from the tree.

`content: true` also runs LegendKeeper's own search for the positive words (1 read; ranked, **incomplete by nature**,
no operators). The bridge applies the operators to the combined results, removes duplicates and pages outside the root,
and marks pages found only through their text (`foundBy: "page text"`, ranked after every name match). With no words to
search for (only filters), LegendKeeper is not asked. If the tree cannot answer, a plain-text content search still works
(live, confined to the root by each hit's ancestry); anything with operators is refused.

```json
{ "query": "foxian tag:elder -kind:index under:Characters", "limit": 10 }
```

**`get_resource`** `{ resource, live? }`: the page from the tree (`path`, `kind`, `documents` (id, name, type), `tags`,
`aliases`, `referenceType`, `scope`, `indexScope`, `canonicalDisplayName`, `childCount`, flags, when the tree read it)
and, from one live `getResource`, its `sidebar` in order: `facts` (key and value, with `mentions` of pages), `links`
(collections and links, each item with the page's name and, for a link to one document, `documentId` and the document's
name; `hasFilter` when LegendKeeper adds items by a filter), `text`, and any other property named with `readOnly: true`
(`unsupported: true` for what the API cannot show, such as the TAGS block). A property's `version` is included where
LegendKeeper's answer has one. Cost: 1 read; `live: false` makes none.

**`get_resources`** `{ resources, live?, detail?, confirm? }`: up to 25 pages as one `batch_ops` job. Each entry is `ok`
with the same data (summarised unless `detail: "full"`) or has its own `error`. More than 10 live reads return
`{ status: "estimate", reads, wallClockSeconds, tightestTier, fitsToday }` and run only on `confirm: true`. Cost: 1 read per page.

**`list_tags`** `{ query?, limit? }`: the tags in use under the root with counts, most used first. Cost: none.
**`list_templates`** `{ refresh? }`: each template (name, id) and the registry type and role that use it
(`usedBy`). From the bridge's copy (when it was read is shown); read live (1 read per 100) when there is none or with
`refresh: true`. **`list_calendars`** `{}`: name, id, months (count and names), days in a regular year, hours and
minutes, eras and formats, summarised. Cost: 1 read. **`list_assets`** `{ folder?, type?, limit?, offset? }`: the assets
directly in a folder, paged, with `url` (use it in Markdown as `![alt](url)`). Cost: none.

### Reading

**`read_document`** `{ resource, document?, outline?, section?, format? }`: a document of a page, `document` by name or id
(default "Main"; a page without one named Main but with a single document uses that, and says so). Returns
`{ format: "markdown", markdown, version, regions, warnings?, blockCount }`: B1's Markdown, the document version for the
write tools, and every keep region (`id`, `kind`, why). `outline: true` returns `headings` (level, text, `path`);
`section: "Biography > Early Life"` returns just that section (with its regions); a heading that occurs more than once
is `SECTION_AMBIGUOUS` with `options` (choose with `Notes [2]`), and none is `SECTION_NOT_FOUND` with the page's
headings. `format: "json"` returns the raw blocks. Maps, timelines and boards are rendered read-only by B1's renderers
(`document.type` says which). Cost: 1 read for a page, map or board; a timeline reads its lanes and then 100 events per
read (at most 1,000 events). A long result is a handle.

```json
{ "resource": "Asagiri Miyabi", "section": "Biography" }
```

### The guides

**`get_bridge_guide`** and **`get_markdown_guide`** `{ section? }` return [bridge-guide.md](bridge-guide.md) and
[markdown.md](markdown.md), whole or one section by heading (`"Keep regions"`, or `"A > B"`; an unknown heading lists
them). Both are also MCP resources: `lk-bridge://guides/bridge` and `lk-bridge://guides/markdown`
(`text/markdown`). Cost: none.

## Writing pages: `write_page` (v2 C1)

The main way agents change the owner's pages: Markdown in the owner's schema ([markdown.md](markdown.md)), turned into
LegendKeeper blocks by B1's converter, written as ONE `replaceDocumentBlocks` under the document's lock, and read back
to check it. Design: [ADR 0031](adr/0031-write-page.md). The agent guide's "Writing pages" section
([bridge-guide.md](bridge-guide.md)) is the short version.

**`write_page`** `{ page, document?, mode, section?, markdown, baseVersion?, dropRegions?, dryRun?, detail?, project }`:
`access: write`, annotations `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`,
`openWorldHint: false`. A `read` profile neither sees nor may call it. `project` follows A1's rule: required while the
bridge serves several projects.

| Argument      | Meaning                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`        | A page name or id, resolved by A3's resolver inside the AI REPOSITORY only (as `read_document`).                                                                              |
| `document`    | A document name or id (default "Main"). Pages (and `blank` documents, which a write makes a page) only: a map, timeline or board is refused with `WRONG_TOOL_FOR_DOCUMENT`.   |
| `mode`        | `append`, `prepend`, `replace`, `replace_section`, `append_to_section`.                                                                                                       |
| `section`     | A heading path (`Biography > Early Life`, `Notes [2]`), for the two section modes only.                                                                                       |
| `markdown`    | At most 1,000,000 characters.                                                                                                                                                 |
| `baseVersion` | The version `read_document` returned. Optional, strongly recommended (rules below).                                                                                           |
| `dropRegions` | Keep-region block ids removed on purpose (a whole-page or section replace). `unsupported` blocks are never dropped by `write_page` (there is no `allowUnsupportedLoss` here). |
| `dryRun`      | Plan only: the counts and the Markdown diff, nothing written, queued or proposed.                                                                                             |
| `detail`      | `"full"` adds the Markdown diff to the result.                                                                                                                                |

**Examples, one per mode**

```json
{ "project": "test", "page": "Asagiri Miyabi", "mode": "append", "markdown": "## Legacy\n\nRemembered at the shrine.", "baseVersion": "v12" }
{ "project": "test", "page": "Asagiri Miyabi", "mode": "prepend", "markdown": "> [!warning]\n>\n> Draft: not yet canon.", "baseVersion": "v12" }
{ "project": "test", "page": "Asagiri Miyabi", "mode": "replace", "markdown": "<the whole page as read, edited>", "baseVersion": "v12" }
{ "project": "test", "page": "Asagiri Miyabi", "mode": "replace_section", "section": "Biography > Early Life", "markdown": "Born on Kumikas 1st, 4A 881, at dawn.", "baseVersion": "v12" }
{ "project": "test", "page": "Fourth Age - Table", "mode": "append_to_section", "section": "Notes", "markdown": "Checked against the archives.", "baseVersion": "v7" }
```

`replace_section` replaces the heading too when the Markdown starts with a heading of the section's level or higher;
otherwise the heading stays.

**How a write runs**

1. **Plan** (before anything is queued): one read of the document; B1's `applyEdit`; the version rules below. Every
   refusal is typed. **An empty plan writes nothing** (`status: "no_change"`, no job).
2. **Write**: one job (`replaceDocumentBlocks`, recorded as a one-step job) under the document's lock. Inside the lock
   the engine reads the document again and compares its version with the one the plan was built on: the bridge's own
   compare-and-swap, because LegendKeeper's `If-Match` is not atomic. On a mismatch, a **section** edit whose section's
   Markdown is unchanged is re-planned there, on the current page; anything else ends as a conflict and nothing is
   sent. Then ONE `replaceDocumentBlocks` with `If-Match`, every `unsupported` block echoed by id (the engine's guard
   applies as ever). The journal keeps the pre-image and the high-level operation (above).
3. **Verify**: still inside the lock, the document is read back and the stored blocks are compared with the blocks
   sent, ids included. Ignored, because LegendKeeper changes them legitimately: a block's `version`; a mention's `name`
   (read-only); run normalisation (empty text runs dropped, neighbouring runs with the same marks merged); the id
   LegendKeeper gives a block sent without one; the document's own `version`, `text` and `schema`. A difference is
   recorded on the job (`result.verification`), in the errors table (`VERIFY_MISMATCH`) and in the result as
   "written but not as planned: …" with the journal entry for recovery. It is **never retried**.

**Cost**: normally 2 reads and 1 write, plus the verify read (a dry run: 1 read; a proposal: 1 read to capture, then 2
reads, 1 write and the verify read when approved).

**The version rules (`baseVersion`)**

| The page's version now                      | `append`, `prepend`, `replace`                     | `replace_section`, `append_to_section`                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| equal to `baseVersion` (or none was passed) | planned on it                                      | planned on it                                                                                                                                                                                         |
| newer than `baseVersion`                    | `VERSION_CONFLICT`, reason `version_changed`       | planned on the current page when the section is exactly as it was at `baseVersion` (the bridge remembers recent versions it read); else `VERSION_CONFLICT` with `currentVersion` and `currentSection` |
| changes between the plan and the write      | `VERSION_CONFLICT`, reason `changed_while_waiting` | re-planned inside the lock when the section is unchanged; else `VERSION_CONFLICT`, reason `section_changed`                                                                                           |

Conflict reasons: `version_changed`, `section_changed`, `base_unknown` (the bridge no longer remembers that version,
so it cannot tell), `section_missing_at_base`, `section_gone`, `replan_refused`, `changed_while_waiting`. A conflict
never merges and never writes; read the page again and redo the edit.

**Results** (every one names the project and ends with its budget line):

```json
{"project":"test","page":{"id":"miyabi01","name":"Asagiri Miyabi","path":"AI REPOSITORY / Characters / … / Asagiri Miyabi"},"document":{"id":"d000001c","name":"Main"},"mode":"append_to_section","section":"Asagiri Miyabi > Biography > Early Life","status":"written","version":"v13","previousVersion":"v12","counts":{"kept":11,"changed":0,"added":1,"removed":0,"moved":0,"regionsKept":1,"regionsDropped":0},"summary":"11 kept, 0 changed, 1 added, 0 removed; 1 keep region(s) kept","verified":true,"jobId":"j…","diffLines":{"added":2,"removed":0}}
budget (test): writes 1/120·min …
```

- `status`: `written`, `no_change`, `dry_run`, `queued` or `waiting_budget` (accepted, runs by itself; never submit
  again: it re-checks the version in the lock when it runs), `proposal_captured`.
- `verified`: `true`, `false` (with `warning` and `verification.differences`), or `null` (the read back could not be
  made; `verification.reason`).
- `note`: when an older `baseVersion` was accepted because the section is unchanged, or when the write was re-planned
  inside the lock.
- `warnings`: the converter's (for example `KEEP_REGION_EDITED`).
- With `detail: "full"` (and always for `dryRun`): `diff`, the Markdown diff as unified-diff text, each keep region one
  placeholder line (`[keep region: infobox infobx01]`).

**Refusals** (typed, nothing is written): every B1 code (`KEEP_REGIONS_MISSING` with `ids`, `UNSUPPORTED_BLOCK_LOSS`
with `blockIds`, `MENTION_NOT_FOUND`, `MENTION_AMBIGUOUS` with the candidates in `problems`, `EDITOR_LIMIT` with
`rule`, `FIELD_LIMIT`, `SCHEMA_VIOLATION`, `SECTION_NOT_FOUND` with `available`, `SECTION_AMBIGUOUS` with `options`,
`KEEP_REGION_UNKNOWN`, `KEEP_REGION_DUPLICATE`, `INVALID_LK_BLOCK`, `IMAGE_URL_REFUSED`, …), `VERSION_CONFLICT`
(above), `WRONG_TOOL_FOR_DOCUMENT`, `PAGE_NOT_WRITABLE` (the page already holds blocks LegendKeeper's write schema
would not take back, such as text with an inline icon, listed in `blocks`: a whole-document write cannot leave them as
they are), `INVALID_PARAMS` (a section mode without `section`, or a whole-page mode with one), and the name and tree
codes of the read tools (`NOT_FOUND`, `NOT_IN_REPOSITORY`, `AMBIGUOUS`, `DOCUMENT_NOT_FOUND`, `TREE_NOT_READY`).

**At scope `propose`** (or whenever policy turns the write into a proposal) the same plan is captured as ONE proposal
that holds the **high-level operation** (page, document, mode, section, the Markdown, `baseVersion`) and its planned
expansion (the new block tree, pinned to the version it was built on). The capture reuses the plan's read. The
dashboard shows the page's Markdown before and after as a line diff (keep regions as labelled placeholders) beside the
block diff. On approval the usual re-read applies: if the version changed since capture the proposal becomes
**conflicted** (no re-planning: the owner approves exactly what they saw); otherwise the stored expansion runs through
the same lock, compare-and-swap and verify, with `approvedBy: "owner"`. A change between the approval's re-read and
the write is caught by the compare-and-swap, and the proposal becomes conflicted too. A `dryRun` never captures.

### Visibility of the low-level tools

Each profile has **show low-level tools** (default off), edited on the dashboard's Clients & Access page and audited
(`profile.set_low_level_tools`). When off, `tools/list` leaves out `lk_api_list_operations`, `lk_api_describe_operation`,
`lk_api_paginate_all` and every `lk_op_*`. `lk_api_read`, `lk_api_write`, `lk_api_batch` and `lk_upload_image` stay.
**Hiding changes the list, nothing else:** a hidden tool is still refused or allowed at call time by the profile's scope
and the engine's guards exactly as before. The change applies at the next `tools/list`; ChatGPT needs a tool refresh
(Plugins, the bridge, Refresh).

The tools a profile sees:

| Setting | Tools                                                                                                                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| off     | the 12 above, `write_page` (v2 C1), `list_projects`, `lk_api_read`, `lk_api_write`, `lk_api_batch`, `lk_upload_image` and the 11 `bridge_*` tools (29 for a profile with scope `propose` or `write`; a `read` profile does not see the five write tools `write_page`, `lk_api_write`, `lk_api_batch`, `lk_upload_image` and `bridge_job_cancel`) |
| on      | all of those, plus `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, and with `MCP_EXPOSE_PER_OP_TOOLS=true` the 89 `lk_op_*`                                                                                                                                                                                        |

## Image upload

`lk_upload_image` runs one `upload_image` job of three steps (it needs scope `write`: uploads are not proposable in v1, so at `propose` it, and raw `createImageUpload` / `createImageAsset` calls, are refused before anything is sent):

1. `createImageUpload` (an LK call through the governor, with an idempotency key);
2. `upload_image.put`, a custom step: a `PUT` of the file to the signed `uploadUrl` with exactly the headers LK returned. This is **not** an LK API call and goes to another host, but it still runs inside `governor.execute`, on the reactive-only `upload` tier;
3. `createImageAsset` with the `uploadKey` (an LK call, with an idempotency key).

The source is **base64** (a `data:` URI is accepted) or a **public https URL** (switch off with `UPLOAD_ALLOW_URL_SOURCE=false`). At scope `propose` the tool is refused before anything is fetched or sent. The bytes are checked before any job exists: size at most `UPLOAD_MAX_BYTES` (10 MB by default), and the first bytes must be a PNG, JPEG, GIF or WebP image that agrees with any `contentType` given.

Network rules for both the URL fetch and the PUT (the address policy of chunk 4, `src/auth/ip.ts`, enforced inside the connection's DNS lookup as in `src/auth/safe-fetch.ts`):

- https only, no credentials in the URL;
- **port 443 only** (v1.0.1), unless the exact `host:port` is listed in `OUTBOUND_EXTRA_PORTS_ALLOWLIST`; the check is
  part of the same guard, so it applies to the first URL, every redirect hop and the PUT, before any DNS lookup or
  connection (`UPLOAD_URL_REFUSED`, `UPLOAD_TARGET_REFUSED`, with a message naming the port, never the URL);
- private, loopback, link-local, CGNAT and other non-public addresses are refused, whether literal or by DNS (`UPLOAD_URL_REFUSED`, `UPLOAD_TARGET_REFUSED`);
- URL fetches follow at most 3 redirects, each hop checked; they time out after `UPLOAD_FETCH_TIMEOUT_MS`;
- each PUT attempt has its own deadline, `UPLOAD_PUT_TIMEOUT_MS` (default 120 s), not the governor's 30-second LegendKeeper request timeout;
- the PUT is retried with backoff on 502/503/504 and connection errors; a `429` from the storage host becomes `UPLOAD_RATE_EXCEEDED`, so the governor blocks the upload tier and honours `Retry-After`;
- the signed URL is never logged, put in an error message, or shown by a tool, and the storage host's error body is replaced.

**Crash recovery.** The two LK steps use idempotency keys, so a restart replays them. The PUT is idempotent and is simply sent again. The image bytes live in the PUT step's stored params and are discarded once the PUT succeeds. If the signed URL has expired by the time a resumed job reaches the PUT, the job fails with `UPLOAD_URL_EXPIRED`; upload again.

Codes: `UPLOAD_SOURCE_INVALID`, `UPLOAD_TOO_LARGE`, `UPLOAD_NOT_AN_IMAGE`, `UPLOAD_URL_SOURCE_DISABLED`, `UPLOAD_URL_REFUSED`, `UPLOAD_URL_FAILED` (before any job), and in the job `UPLOAD_TARGET_REFUSED`, `UPLOAD_URL_EXPIRED`, `UPLOAD_BYTES_DISCARDED`.

## Settings

| Variable                         | Default            | Meaning                                                                                                                                                                                                                |
| -------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRE_PROJECT_FOR_WRITES`     | `true`             | A write tool called without `project` is refused while the bridge serves more than one project (v2 A1)                                                                                                                 |
| `MCP_EXPOSE_PER_OP_TOOLS`        | `false`            | Also register `lk_op_<operationId>` for all 89 operations                                                                                                                                                              |
| `MCP_RESULT_MAX_CHARS`           | `40000`            | Results longer than this are stored and returned as a handle                                                                                                                                                           |
| `UPLOAD_MAX_BYTES`               | `10485760` (10 MB) | Largest image `lk_upload_image` accepts. The `/mcp` request body limit is sized from it (below)                                                                                                                        |
| `UPLOAD_ALLOW_URL_SOURCE`        | `true`             | `false`: base64 only                                                                                                                                                                                                   |
| `UPLOAD_FETCH_TIMEOUT_MS`        | `15000`            | Deadline for fetching an image from a URL                                                                                                                                                                              |
| `UPLOAD_PUT_TIMEOUT_MS`          | `120000`           | Per-attempt deadline of the signed-URL PUT (5 s to 10 min), separate from the 30 s LegendKeeper request timeout                                                                                                        |
| `OUTBOUND_EXTRA_PORTS_ALLOWLIST` | empty              | Exact `host:port` pairs, comma-separated, that the image fetch, its redirects, the PUT and the CIMD fetch may use besides 443 (v1.0.1). No wildcards; a malformed entry stops the bridge at start-up, naming the entry |

The governor's per-attempt timeout (30 s) also bounds the PUT.

**Request size (chunk 8).** A base64 image is a third larger than the image, inside a JSON-RPC envelope. The `/mcp`
request body limit is therefore `max(4 MiB, ceil(UPLOAD_MAX_BYTES / 3) × 4 + 256 KiB)`: about 13.6 MiB for the default
10 MiB. (Fastify's own 1 MiB `bodyLimit` does not apply to `/mcp`: the body is left for the MCP SDK, which enforces this
limit, with a `413`, only after the bearer token has been checked.) An image over `UPLOAD_MAX_BYTES` that still fits the
request is refused by the tool with `UPLOAD_TOO_LARGE`. URL sources are not limited by the request size.
