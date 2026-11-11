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

| Tool                        | Access | Annotations (read-only / destructive / idempotent / open-world) | Cost                                                  |
| --------------------------- | ------ | --------------------------------------------------------------- | ----------------------------------------------------- |
| `list_projects`             | read   | true / false / true / false                                     | none                                                  |
| `browse_repository_tree`    | read   | true / false / true / false                                     | none (the tree)                                       |
| `browse_asset_tree`         | read   | true / false / true / false                                     | none (the asset tree)                                 |
| `search`                    | read   | true / false / true / false                                     | none; 1 read with `content: true`                     |
| `get_resource`              | read   | true / false / true / false                                     | 1 read (none with `live: false`)                      |
| `get_resources`             | read   | true / false / true / false                                     | 1 read per page, one job                              |
| `list_tags`                 | read   | true / false / true / false                                     | none (the tree)                                       |
| `list_templates`            | read   | true / false / true / false                                     | none, or 1 read per 100 templates                     |
| `list_calendars`            | read   | true / false / true / false                                     | 1 read                                                |
| `list_assets`               | read   | true / false / true / false                                     | none (the asset tree)                                 |
| `read_document`             | read   | true / false / true / false                                     | 1 read (a timeline: 2 + 1 per 100 events)             |
| `write_page`                | write  | false / **true** / false / false                                | 2 reads + 1 write + 1 verify read                     |
| `set_facts`                 | write  | false / **true** / false / false                                | see below (typically 4 reads + 1 write)               |
| `create_index`              | write  | false / false / false / false                                   | see [C2b](#resources-documents-and-characters-v2-c2b) |
| `create_resource`           | write  | false / false / false / false                                   | see C2b                                               |
| `create_bare_resource`      | write  | false / false / false / false                                   | 1 write + 1 listing + the tree’s re-read              |
| `create_many_resources`     | write  | false / false / false / false                                   | see C2b                                               |
| `create_character`          | write  | false / false / false / false                                   | see C2b                                               |
| `update_resource`           | write  | false / **true** / false / false                                | 1 read + 1 write (+1 to re-place) + verify            |
| `move_resource`             | write  | false / **true** / false / false                                | 1 write + 1 listing + the tree’s re-read              |
| `delete_resource`           | write  | false / **true** / false / false                                | 1 read + canon reads + 1 write + 1 read               |
| `restore_resource`          | write  | false / false / false / false                                   | 1 write + 1 read + the tree’s re-read                 |
| `create_document`           | write  | false / false / false / false                                   | 1 write + 1 read                                      |
| `update_document`           | write  | false / **true** / false / false                                | 2 reads + 1 write + 1 read                            |
| `delete_document`           | write  | false / **true** / false / false                                | 1 write + 1 read                                      |
| `archive_page`              | write  | false / **true** / false / false                                | see [C2c](#the-page-lifecycle-v2-c2c)                 |
| `unarchive_page`            | write  | false / **true** / false / false                                | see C2c                                               |
| `move_to_working`           | write  | false / **true** / false / false                                | see C2c                                               |
| `promote_page`              | write  | false / **true** / false / false                                | see C2c                                               |
| `get_markdown_guide`        | read   | true / false / true / false                                     | none                                                  |
| `get_bridge_guide`          | read   | true / false / true / false                                     | none                                                  |
| `lk_api_list_operations`    | read   | true / false / true / false                                     | none                                                  |
| `lk_api_describe_operation` | read   | true / false / true / false                                     | none                                                  |
| `lk_api_read`               | read   | true / false / true / false                                     | 1 read                                                |
| `lk_api_write`              | write  | false / **true** / false / false                                | 1 write (+ items for createMany)                      |
| `lk_api_batch`              | write  | false / **true** / false / false                                | sum of its steps, at job priority                     |
| `lk_api_paginate_all`       | read   | true / false / true / false                                     | 1 read per page of 100                                |
| `lk_upload_image`           | write  | false / false / false / **true**                                | 2 writes (+ upload-tier backoff)                      |
| `bridge_info`               | read   | true / false / true / false                                     | up to 2 cached reads (10 min)                         |
| `bridge_budget`             | read   | true / false / true / false                                     | none                                                  |
| `bridge_estimate`           | read   | true / false / true / false                                     | none                                                  |
| `bridge_job_status`         | read   | true / false / true / false                                     | none                                                  |
| `bridge_job_wait`           | read   | true / false / true / false                                     | none (waits at most 25 s)                             |
| `bridge_job_cancel`         | write  | false / false / true / false                                    | none                                                  |
| `bridge_errors_recent`      | read   | true / false / true / false                                     | none                                                  |
| `bridge_journal_lookup`     | read   | true / false / true / false                                     | none                                                  |
| `bridge_result_page`        | read   | true / false / true / false                                     | none                                                  |
| `bridge_proposal_status`    | read   | true / false / true / false                                     | none                                                  |
| `bridge_proposals_mine`     | read   | true / false / true / false                                     | none                                                  |
| `lk_op_<operationId>` (89)  | per op | derived from the operation, see below                           | that of the operation                                 |

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

**Per-operation tools.** With `MCP_EXPOSE_PER_OP_TOOLS=true` the bridge also registers `lk_op_<operationId>` for all 89 operations (141 tools in all, 143 with the policy layer’s two proposal tools). Each takes the operation's own input (`path`, `query`, `ifMatch`, `body`) plus `detail` (and `allowUnsupportedLoss` / `confirm` on writes), runs through exactly the same path, and records its own name as the job's tool. `access` equals the operation's kind. Annotations come from the operation: reads are read-only and idempotent; writes are `destructiveHint: true` when the operation's risk is `destructive` or `admin`, and `idempotentHint: true` for PUT, DELETE, move, restore, assign-block-ids and delete-shapes. This lists about 600 KB of schemas, which is why it is off by default.

### Bridge awareness

**`bridge_info`** `{ project? }`: version; the asked project (`projectInfo`: name, id, display name, default, read-only, available) and every project (`projects`); the project's LegendKeeper name and the key's role (`ADMIN`, `MEMBER` or `unknown`; inferred from `listMembers`, because LK shows member emails to ADMIN keys only); read-only flag (`effective`; `bridge`, the bridge-wide flag; `project`, the project's own flag; configured, overridden); whether writes are paused or draining, and `canWrite`; writer pool; the calling connection, its profile and its live scope (`read`, `propose` or `write`), and `canWriteAs` (`direct`, `proposal (the owner approves)` or `no (read-only)`). The project name and role come from one lookup per project shared by every caller and cached for 10 minutes; it runs as the bridge's own work (`system` principal, v1.0.1), so a failure there shows on the dashboard's Errors page under `system`, not in a caller's `bridge_errors_recent`.

**`bridge_budget`** `{ project?, allProjects? }`: one project's tiers (used, limit, remaining, seconds to reset, any block after a 429, drift), queue depth per priority, write pacing. `allProjects: true` lists every project's budget side by side.

**`bridge_estimate`** `{ reads?, writes?, createManyItems?, priority? }`: against the asked project's budget, projected wall-clock time, the tightest tier, whether it fits today's request budget, with advice. Call it before large workloads.

**Your own work only.** `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_result_page` and `bridge_errors_recent` show only the calling connection's jobs, stored results and errors; another connection's job id or handle answers exactly like one that does not exist. `bridge_journal_lookup` shows every connection's writes (so agents can cross-check each other), each with its principal, profile and approver; job ids appear only on your own entries, and a `jobId` filter matches only your own jobs.

**`bridge_job_status`** `{ jobId?, steps?, status?, limit? }`: one job (status, progress, last error, result, failed steps), or recent jobs when `jobId` is omitted. Signed-URL material is redacted.

**`bridge_job_wait`** `{ jobId, seconds? }`: waits at most 25 seconds, then returns the job as it stands (`done: true` when finished).

**`bridge_job_cancel`** `{ jobId }`: the step in flight finishes; nothing further is sent; finished steps are not undone. A job the owner approved (an approved proposal's job, which runs as the connection that proposed it) is refused with `OWNER_APPROVED_JOB`: only the owner stops approved work, on the dashboard (CR-2026-11).

**`bridge_errors_recent`** `{ grouped?, limit?, sinceMinutes?, jobId? }`: failures grouped by operation, code and path (default), or one row each, with LegendKeeper `requestId`s.

**`bridge_journal_lookup`** `{ resourceId?, documentId?, targetId?, operationId?, jobId?, principalId?, profile?, outcome?, withPreImage?, before?, sinceMinutes?, limit?, includePreImage? }`: the write journal, newest first. Since chunk 8 it holds **every** write the bridge sends (creates, inserts, patches, deletes), each with operation, target, time, outcome (`applied`, `not_applied`, `unknown`, `pending`), principal, profile and approver; destructive writes also keep their pre-image. Since v2 C1 an entry made by a high-level tool also has `operation`: for `write_page` the tool, mode, section, a SHA-256 of the Markdown (`markdownSha256`) and its length, the version the plan was built on (`plannedOn`), the agent's `baseVersion`, `dropRegions`, and `replannedInLock` when the bridge re-planned a section edit inside the lock. Since v2 C2a, `set_facts` entries have the tool, the page, the property, the counts and the write (`Status: changed`); the first write to the key-value property keeps the property as the plan saw it as its pre-image. `targetId` also matches every resource a `createManyResources` created. Pages hold `limit` entries (default 10, at most 100); when a page is full, `nextBefore` is the cursor for the next, older page (`before`).

**`bridge_proposal_status`** `{ proposalId }` and **`bridge_proposals_mine`** `{ state?, limit? }`: your own proposals in the asked project (a proposal belongs to the project its write was for, and runs there once approved) (writes at scope `propose`, waiting for the owner): state, summary, the rejection reason, the conflicting operation and the job once executed ([policy.md](policy.md)). Since v2 C1 a proposal made by a high-level tool also has `operation`, briefly (for `write_page`: the tool, page, document, mode, section, the version it was planned on and the counts; never the Markdown). Since v2 C2a each also has `pages`, the page-level summary (one plain line per page, for example `Asagiri Miyabi: sidebar, 2 facts changed`), and `requiresCanonicalApproval` with `canonicalReason` when the change touches protected canon (only the owner's "Approve and accept as canon" can run it).

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
(display), `kind` (`index` / `bsrc` / `bwrk` / `barc` / `unclassified`), `type` (Reference Type), `scope` (shortened to 60 characters),
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
`bwrk` / `barc` / `unclassified`) `under:` (a page name or id; pages below it) `scope:`. `NOT` binds tightest, then `AND` (spaces), then
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
LegendKeeper's answer has one. With a live read it also gives **`factsVersion`** (v2 C2b): the bridge's own version of
the page's sidebar facts (the key-value rows by rank and id, and the link collections' items and filters), the same from
every read of an unchanged sidebar; pass it to `set_facts` as `baseFactsVersion`. Cost: 1 read; `live: false` makes none.

**`get_resources`** `{ resources, live?, detail?, confirm? }`: up to 25 pages as one `batch_ops` job. Each entry is `ok`
with the same data (summarised unless `detail: "full"`, with each page's `factsVersion`) or has its own `error`. More than 10 live reads return
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

| Setting | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| off     | the 12 above, `write_page` (v2 C1), `set_facts` (v2 C2a), the 12 Resources, Documents and character tools (v2 C2b), the 4 lifecycle tools (v2 C2c), `calendar_date` and the 4 timeline tools (v2 D1), `list_projects`, `lk_api_read`, `lk_api_write`, `lk_api_batch`, `lk_upload_image` and the 11 `bridge_*` tools (51 for a profile with scope `propose` or `write`; a `read` profile does not see the write tools: `write_page`, `set_facts`, the 12 of C2b, the 4 of C2c, the 4 timeline tools of D1, `lk_api_write`, `lk_api_batch`, `lk_upload_image` and `bridge_job_cancel`) |
| on      | all of those, plus `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, and with `MCP_EXPOSE_PER_OP_TOOLS=true` the 89 `lk_op_*`                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Facts and links: `set_facts` (v2 C2a)

Changes a page's sidebar **facts** (the key-value rows of its `PROPERTIES` property) and its relationship **links** (the
link collections, such as Dependencies and Related Sources), as ONE job under the page's lock, checked inside the
lock, chained version by version, and read back. Design: [ADR 0032](adr/0032-set-facts-and-canon.md). The agent
guide's "Editing facts and links" and "Canon and approval" sections ([bridge-guide.md](bridge-guide.md)) are the short
version.

**`set_facts`** `{ page, facts?, links?, property?, baseFactsVersion?, dryRun?, project }`: `access: write`, annotations
`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: false`. A `read` profile
neither sees nor may call it. `project` follows A1's rule: required while the bridge serves several projects.

| Argument           | Meaning                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`             | A page name or id, resolved by A3's resolver inside the AI REPOSITORY only.                                                                                                                                                                                                                       |
| `facts`            | Key → value. A string is plain text, written exactly (a line break becomes a line-break run); `{ "markdown": "…" }` is inline Markdown; `null` removes the row.                                                                                                                                   |
| `links`            | Collection title → `{ add?, remove? }`; each entry a page name or id, or `{ "page": …, "document": … }` for one document of a page.                                                                                                                                                               |
| `property`         | The key-value property's title. Default: the project's setting `factsPropertyName` (`PROPERTIES` until set).                                                                                                                                                                                      |
| `dryRun`           | Plan only: what would change, the writes, and whether it touches protected canon. Nothing is written, queued or proposed.                                                                                                                                                                         |
| `baseFactsVersion` | v2 C2b: the `factsVersion` `get_resource` (or an earlier `set_facts`) gave when you read the page. If ANY sidebar row or link collection has changed since, nothing is written: `VERSION_CONFLICT` with `differences` (which rows or collections). Checked at planning and again inside the lock. |

**Facts.** Keys match existing rows without case and with outer spaces ignored; an existing row keeps its key (as
written), its id and its place. The same value writes nothing. A key that occurs twice in the property is refused
(`FACT_KEY_DUPLICATED`): the bridge does not guess which row. A **new template fact** goes in the template's order:
after its nearest existing preceding template fact, else before its nearest following one, else above the facts that
are not in the template. The template is the one the repository tree recorded for the page (C2b records it when it
creates a page), or else the page's Reference Type mapped through the type registry to a type and role (for
characters: `Character Core` → the type's `core` template). The template's keys are read once and kept for a day. **Any
other new fact** goes at the bottom, in the order given. When no template can be determined, new facts go at the bottom
and the result says so in `notes`.

**Inline Markdown** (B1's inline subset, [markdown.md](markdown.md)): `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
`<u>`, `<sub>`, `<sup>`, links, `<br>`, and mentions: `[[Name]]` and `[[Name|label]]` resolved through A3 inside the AI
REPOSITORY (exactly one page, or `MENTION_AMBIGUOUS` with the candidates / `MENTION_NOT_FOUND`), and
`[label](lk://resources/<id>/docs/<docId>)` for a document. **A character's pages** (v2 C2b, decided by the owner on 10
November 2026): when a mention matches several pages of ONE character (the same subject, each a Character Core, a
Compact Character Reference or the character's `[INDEX]`), it goes to the Core, else the Reference, else the index, and
the result's `mentions` says which page was chosen and why. Pages of different subjects, or a page with no character
role among them, stay `MENTION_AMBIGUOUS`. The same rule applies to `write_page`. It never applies to the page a tool
writes to (`page`): a name that matches several pages is `AMBIGUOUS`, each candidate with its `role`. Anything that is not one line of inline text (a heading, a
list, two paragraphs, an image) is `FACT_VALUE_NOT_INLINE`. Values are converted before anything is read.

**Links.** The collection is found by its title (`resourceCollection` or `resourceLink`; `LINK_COLLECTION_NOT_FOUND`
with the titles there are, or `LINK_COLLECTION_AMBIGUOUS`). Adds resolve through A3 inside the root; a document must
exist on its page (`DOCUMENT_NOT_FOUND` / `DOCUMENT_AMBIGUOUS`). Adds go after the existing items; a page (or document)
already linked is reported in `alreadyLinked`, not doubled. A remove matches by page (every item of that page) and, when
a document is given, by document; one that matches nothing is reported in `notLinked`. A remove may also name an item
by the page id it holds, even when that page is no longer in the tree. **Existing items keep their ids, ranks and
order, and the collection's filter is never sent, so LegendKeeper keeps it** (the old bridge's rule). LegendKeeper has
no item-level operations for collections, so a changed collection is ONE `updateProperty` with the full items list:
every kept item exactly as read (`id`, `rank`, `resourceId`, `documentId`), then the new ones (page and document only).

**Examples**

```json
{ "project": "test", "page": "[BSRC] Asagiri Miyabi", "facts": { "Status": "Working", "Scope": "Foxian shrine maiden" } }
{ "project": "test", "page": "miyabi01", "facts": { "Old Note": null } }
{ "project": "test", "page": "miyabi01", "facts": { "Sister": { "markdown": "**Elder** sister of [[Asagiri Kaede]]" } } }
{ "project": "test", "page": "miyabi01", "links": { "Dependencies": { "add": ["Fourth Age - Table", { "page": "Universal Chronology", "document": "Main" }], "remove": ["Asagiri Kaede"] } } }
{ "project": "test", "page": "miyabi01", "facts": { "Mood": "Calm" }, "links": { "Related Sources": { "add": ["Inae Mikumo"] } }, "dryRun": true }
```

**How a write runs** (one job, holding the page's lock from its first step to its last)

1. **Plan** (before anything is queued): one `listProperties` (each property with its rows, items and filter), the
   values, the links, the template's order when a new fact needs it. **An empty plan writes nothing**
   (`status: "no_change"`, no job). A `dryRun` stops here.
2. **Check, inside the lock** (`bridge.expect`): every property the plan changes is read again (`listPropertyRows` for
   the key-value property, which gives the version row writes check; `getProperty` for each collection) and compared
   with the state the plan was built on: rows by id (key, value and rank), both sides in LegendKeeper's rank order,
   because `listProperties` gives rows in stored order and `listPropertyRows` sorted by rank; items by id, page and
   document in order; the filter whole; a property's version where both reads give one. Any difference is a conflict
   (`VERSION_CONFLICT`, naming the row) and **nothing is written**. LegendKeeper's If-Match is not an atomic compare-and-swap (PLAN-v2 10.6), so this check
   is the bridge's own.
3. **The writes**, in order: changes, additions, removals (additions are anchored to rows that stay), then each
   collection. Each row write chains its If-Match from the write before it (the first from the check). A write with
   nothing to chain from (after a removal, which LegendKeeper answers without a version) reads the rows inside the lock
   and compares them with the plan first. A collection write (`updateProperty`, which LegendKeeper does not version)
   reads the collection inside the lock and compares it with the plan first.
4. **Verify** (`bridge.verify`): the sidebar is read back and compared with the planned state (keys, values, order,
   links, the filter), rows by id in rank order, a new row where the plan put it (between its anchor and the anchor's
   rank-sorted neighbour, where LegendKeeper ranks it). A difference is **"written but not as planned"**: recorded on the job, in the errors table
   (`VERIFY_MISMATCH`) and in the result, and never retried. The job's journal entries hold what each write changed.
5. **The tree** re-reads the page once, when the job ends (Reference Type, Scope and the other catalogue fields).

**Cost.** Planning: 1 read (plus 1 the first time a template's order is needed). The job: 1 read to check (plus 1 per
collection changed), 1 write per fact changed, added or removed, 1 read and 1 write per collection changed, 1 read to
verify and 1 for the tree. Changing two facts: 4 reads and 2 writes. Two facts and one link: 6 reads and 3 writes. A
dry run, or a proposal: the planning read (a proposal adds 1 read per property to capture it, and runs the job when
approved).

**Results** (each names its project and ends with its budget line):

```json
{"project":"test","page":{"id":"miyabi01","name":"Asagiri Miyabi","path":"AI REPOSITORY / Characters / …"},"property":"PROPERTIES",
 "facts":{"changed":[{"key":"Status","before":"Draft","after":"Working"}],"added":[{"key":"Mood","value":"Calm"}]},
 "links":{"Dependencies":{"added":["Fourth Age - Table"],"removed":[],"alreadyLinked":["Asagiri Kaede"]}},
 "status":"written","verified":true,"jobId":"j…"}
budget (test): writes 3/120·min …
```

`status` is `written` (with `verified`: `true`, `false` with a `warning` and `verification`, or `null` when the read
back could not be made), `no_change`, `dry_run` (with `writes` and `summary`), `proposal_captured`, `queued` or
`waiting_budget` (follow the job; never send it again). Every result carries `factsVersion` (v2 C2b): the version the
plan was built on, and for `written` `{ before, after }` (`after` from the verify step's read). `mentions` lists any
`[[Name]]` resolved by the character rule (below). `facts` lists `added`, `changed`, `removed`, `unchanged` and
`notPresent` (a removal of a key that is not there); `links` lists per collection `added`, `removed`, `alreadyLinked`,
`notLinked`, and a note when the collection has a filter. `notes` says when the template could not be determined.

**Refusals** (typed, nothing is written): `INVALID_PARAMS` (nothing to do), `INVALID_FACTS` (an empty key, or one key
twice), `FACT_KEY_DUPLICATED`, `FACTS_PROPERTY_NOT_FOUND` (with `available`), `FACTS_PROPERTY_AMBIGUOUS`,
`FACT_VALUE_NOT_INLINE`, the mention codes, `INVALID_LINKS` (a collection named twice, the same page added and removed,
more than 256 items), `LINK_COLLECTION_NOT_FOUND`, `LINK_COLLECTION_AMBIGUOUS`, `DOCUMENT_NOT_FOUND`,
`DOCUMENT_AMBIGUOUS`, `VERSION_CONFLICT` (the check in the lock; read the page again and redo the change), and the name
and tree codes of the read tools (`NOT_FOUND`, `NOT_IN_REPOSITORY`, `AMBIGUOUS`, `TREE_NOT_READY`). A job that stops
after some writes reports `WRITTEN_IN_PART` with the writes that were made; read the page before anything else. A write
whose answer was lost and could not be checked is reported as `OUTCOME_UNKNOWN` with `uncertain` (it may have been
made), never as not written (CR-2026-11).

**Protected canon.** A change that touches a protected fact (by default: `Status` set to or changed from
`Authoritative`; an existing `Continuity Type` or `Continuity` changed) becomes a proposal **whatever the connection's
scope**: `status: "proposal_captured"`, `requiresCanonicalApproval: true` and the `reason`. Only the owner's "Approve and
accept as canon" can run it ([policy.md](policy.md)). A `dryRun` says `requiresCanonicalApproval` with the
`protectedChanges`.

**At scope `propose`** the same plan is captured as ONE proposal that holds the high-level operation (the page, the
facts table before and after, the links added and removed) and its expansion: the check, the writes and the verify
step, exactly as a direct write runs them. The dashboard shows the page-level summary first, then the facts table and
the links, then each operation. On approval the usual re-read applies (a property that changed since capture makes
the proposal **conflicted**), and the approved job runs the same check inside the lock (a change after the approval's
re-read makes it conflicted too, nothing written).

## Resources, documents and characters (v2 C2b)

Twelve write tools for pages and documents: `create_index`, `create_resource`, `create_bare_resource`,
`create_many_resources`, `create_character`, `update_resource`, `move_resource`, `delete_resource`, `restore_resource`,
`create_document`, `update_document` and `delete_document`. Design: [ADR 0034](adr/0034-resources-documents-characters.md).
The agent guide's "Creating and changing pages" section ([bridge-guide.md](bridge-guide.md)) is the short version.

### What every one of them does

- **One job, or one proposal.** At scope `write` the call runs as ONE job (the creates, each new page's facts, then the
  verify step); at scope `propose` it becomes ONE proposal holding the high-level operation(s) and their expansion, with
  the page-level summary first (`New page [BSRC] X - Character Core under [INDEX] X: 6 facts`). Every new page's id is
  minted when the plan is made (at capture for a proposal) and used exactly at approval, so a child under a new index,
  and a link to a new page, are fixed in the proposal. Every guard runs again when the job runs.
- **`dryRun: true`** shows the plan (pages, names, parents, places, facts, links, the canon assessment) and writes
  nothing.
- **Inside the AI REPOSITORY only.** Every page and every parent is resolved inside the root (`NOT_IN_REPOSITORY`,
  `NOT_FOUND`, `AMBIGUOUS` with each candidate and, for a character's pages, its role). New pages go under an index (or
  the root itself): `PARENT_NOT_INDEX` otherwise.
- **Alphabetical place in the same write.** `[INDEX]` pages first, then `[BSRC]`, each alphabetical (A3's rule): a
  created or moved page gets its `after` / `before` neighbour in the create or move itself. A rename that changes a
  page's place adds one `moveResource` to the same job (LegendKeeper's `updateResource` takes no place). Nothing else is
  ever moved or reclassified.
- **A lifecycle status (since v2 C2c).** Every page create takes `status: "working" | "authoritative"` (default
  `working`): a Working page is `[BWRK]`, directly under `[INDEX] Working`, with Status `Working` and the `Working`
  tag; an Authoritative page is `[BSRC]` in its normal place, with Status `Authoritative` and the `CANON` tag, and is
  always a canonical proposal. See [The page lifecycle](#the-page-lifecycle-v2-c2c). An index gets no Status and no
  status tag. A Status in `facts` must agree with `status` (`INVALID_FACTS` otherwise). Templates carry no defaults.
- **The template is recorded** on the new page's tree node at once, so `set_facts` finds its template order later.
- **Verified.** A verify step reads back every page made or changed: a created or moved page by its parent's listing
  (its name, parent and exact neighbours, one read per 100 siblings, shared by every page under that parent), its facts
  by one `getResource`, a deleted page as gone, a document by the page's document list. `verified: true`, `false` (with
  `warning` and `verification`: written but not as planned, never retried), or `null` (not read back).
- **Never replayed.** A job that stops part-way answers `WRITTEN_IN_PART` with `written`, `notWritten` and the
  `journal` entries; nothing is retried, and the same request with the same `operation_id` returns that result rather
  than running again. Make a new, smaller request for what was not written. A write whose answer was lost and could not
  be checked is `uncertain` (code `OUTCOME_UNKNOWN`): it may have been made, so it is never listed under `notWritten`
  (CR-2026-11); read the pages first.

### `operation_id` (every create tool)

An optional id of your own (1 to 128 of `A-Z a-z 0-9 - _ . :`), kept per project and connection with a hash of the
normalised request (spacing and key order do not count; `project`, `dryRun` and the id itself are left out):

- the **same id with the same request** returns the earlier result (`repeated: true`): the job as it stands now (its
  outcome once finished), or the proposal (`proposalState`). It never creates anything twice;
- the **same id with a different request** is refused: `OPERATION_ID_REUSED`; nothing is done;
- an id whose first call is still being planned answers `OPERATION_IN_PROGRESS`;
- a dry run or a refused call does not use the id up. Ids are kept at least as long as the journal (30 days by default).

### Creating pages

**`create_index`** `{ name, parent?, type?, category?, dryRun?, operation_id?, project }`: `[INDEX] {name}` from the
type's Index template. Give `parent`, or `type` and `category` (the category's index is then the parent; for example
`{ "type": "Character", "category": "Foxians" }`), or both (the parent must then be the category's index or under it).
Without `type`, the type is the one whose root index holds the parent. Refusals: `UNKNOWN_TYPE` (with `types`),
`UNKNOWN_CATEGORY` (with `categories`), `CATEGORY_AMBIGUOUS`, `CATEGORY_MISMATCH`, `TYPE_MISMATCH`,
`TEMPLATE_NOT_CONFIGURED`, `INDEX_EXISTS` (an index of that name under the parent).

**`create_resource`** `{ name, template, parent, facts?, links?, tags?, aliases?, dryRun?, operation_id?, project }`: a
`[BSRC]` page from a template (name or id; see `list_templates`) under an index. The name follows the template role's
pattern (`{name}` by default). `facts` and `links` are as in `set_facts` (a new page has no links to remove), written in
the same job in the template's order. Refusals: `TEMPLATE_NOT_FOUND` (with `templates`), `TEMPLATE_AMBIGUOUS`,
`CHARACTER_TEMPLATE` (use `create_character`), `INDEX_TEMPLATE` (use `create_index`), `PAGE_EXISTS`, the facts and
links codes of `set_facts`.

**`create_bare_resource`** `{ name, parent?, status?, tags?, aliases?, dryRun?, operation_id?, project }`: a page
with no template. The name is used as given and must start with exactly `[INDEX] `, `[BSRC] ` or `[BWRK] `
(`INVALID_NAME` otherwise, including a doubled prefix and `[BARC] `, which only `archive_page` makes); a page's prefix
must agree with `status` (`[BWRK] ` for Working, the default; `[BSRC] ` for Authoritative). An index takes no status
and is refused under the lifecycle indexes. `PAGE_EXISTS` for a sibling of the same kind and name.

**`create_many_resources`** `{ items[1..100], dryRun?, operation_id?, project }`, each item
`{ key, name, parent | parent_key, template?, facts?, links?, tags?, aliases? }`: up to 100 pages in one request, nested
by `parent_key` (a parent made in the same request works). Each item follows the single-create rules above. Pages
without a template go in `createManyResources` calls (one write for up to 100; children of a parent made in the same
call are created in sorted order, as LegendKeeper places them after their earlier siblings); each page from a template
is its own write. Parents always come first. More than 100 items, a `parent_key` that names no item
(`PARENT_KEY_NOT_FOUND`), a loop (`PARENT_KEY_LOOP`), a key used twice or two items with one name under one parent
(`INVALID_ITEMS`) are refused before anything is read or sent. Canon is judged per item; under `propose` the whole batch
is one proposal.

**`create_character`** `{ kind: "core" | "compact", name, race?, type?, facts?, links?, dryRun?, operation_id?, project }`
(the old bridge's rules, PLAN-v2 section 9, on A3's `planCharacterPlacement`):

- **core**: an existing unique `[INDEX] {name}` under the race index is reused, else made from the Index template; then
  `[BSRC] {name} - Character Core` beneath it from the Core template;
- **compact**: `[BSRC] {name} - Character Reference` directly under the race index, with no index;
- an existing Core or Reference is **returned, not duplicated** (`status: "existing"`, with a note and its
  `factsVersion`);
- in the same job: Reference Type (exactly `Character Core` or `Compact Character Reference`), Subject and Canonical
  Display Name (the name), Race / Species (exactly as given, or `Unestablished` for an unknown or omitted race), Status
  (by `status`), then your `facts` and `links` (a fact that contradicts one of the first four is refused);
- **`status`** (since v2 C2c; default `working`): a Working Core goes under its own `[INDEX] {name}` directly under
  `[INDEX] Working` as `[BWRK] {name} - Character Core`; a Working compact page goes directly under `[INDEX] Working`.
  The race is still validated (and recorded), and `promote_page` later takes the character to its race index. An
  existing Core or Reference is looked for in both places;
- an unknown or omitted race (`null`, blank, `Unknown`, `Undetermined`, `Unestablished`, `Undetermined / Unknown`) goes
  to `[INDEX] Undetermined / Unknown`; a race given that does not resolve fails (`RACE_NOT_FOUND`, with the labels
  available); and A3's other refusals (`RACE_AMBIGUOUS`, `RACE_NEEDS_REVIEW`, `CHARACTER_TYPE_AMBIGUOUS`, …);
- never automatic: no race or classification index is made, nothing is moved or reclassified, no tag is inferred;
- **duplicates**: a request for a character (same name without case, stray prefixes or extra spaces) while another
  request for it is being planned, queued, running or a pending proposal, from any connection, is refused
  (`DUPLICATE_REQUEST`, naming the other's `jobId` or `proposalId`). Once that one has finished, a new request finds the
  page it made (`existing`).

The page names come from the type's page-name patterns (`{name} - Character Core` and `{name} - Character Reference` by
default; the owner can change them on the Repository Mappings page).

Every create answers with `pages` (each `id`, `name`, `parent`, `after` / `before`, `template`, `facts`, `links`),
`writes`, `status`, `verified`, `jobId` and `factsVersions` (each new page's `factsVersion` after the job, by name).

### Changing, moving, deleting and restoring

**`update_resource`** `{ page, name?, tags?: { add?, remove? }, aliases?: { add?, remove? }, icon?: { glyph?, color?,
shape?, size? }, banner?: { url?, yPosition?, enabled? }, hidden?, locked?, dryRun?, project }`: one read of the page,
then one `updateResource` (and, after a rename that changes the page's place, one `moveResource` among the same
siblings), under the page's lock, journalled with the page as it was. A rename keeps the page's prefix (`PREFIX_CHANGE`
for a name with another prefix; never a reclassification) and refuses a sibling's name (`NAME_TAKEN`). Tags and aliases
are compared without case. An unchanged request sends nothing (`no_change`).

**`move_resource`** `{ page, to, dryRun?, project }`: the page and everything under it, to a new parent index inside
the repository, in its alphabetical place there (one `moveResource`, journalled with the page as it was).
`MOVE_CYCLE` for a move under itself or a descendant; `NOT_IN_REPOSITORY` for a destination outside; `NAME_TAKEN` for a
sibling of the same kind and name there.

**`delete_resource`** `{ page, confirm: true, cascade?: true, dryRun?, project }`: `confirm: true` is required; a page
with pages under it is refused (`HAS_CHILDREN`, listing them) unless `cascade: true` is passed too. The result lists
every page removed (`removed`). The journal keeps the page (its `getResource`) and the subtree's ids, names and parents.
LegendKeeper's deletes are soft: `restore_resource` brings them back. **Protected canon** (decided by the owner on 10
November 2026): deleting a page whose Status is `Authoritative`, or with `cascade` any page of the subtree that is,
needs the owner's canonical approval, whatever the scope: the call becomes a proposal (`proposal_captured`,
`requiresCanonicalApproval`, the `reason` naming each page). The guard reads each page's sidebar live (up to 101; a
larger cascade, or a sidebar it cannot read, counts as protected), and reads the page again inside its lock. A dry run
says what the tree last read.

**`restore_resource`** `{ page, dryRun?, project }`: `page` is the deleted page's id (a deleted page has no name the tree
can find; `delete_resource`'s result and `bridge_journal_lookup` show it). Restores it and whatever was deleted with it
in the same cascade, and adds it back to the tree. **No canonical approval**: restoring brings back what was approved.
Refused: an id the bridge has no record of deleting from the repository (`NOT_IN_REPOSITORY`), a page that is not
deleted (`NOT_DELETED`), a page whose parent is deleted too (`PARENT_DELETED`: restore the parent).

### Documents

**`create_document`** `{ page, name, type: "map" | "timeline" | "board", calendar?, hidden?, fullWidth?, dryRun?,
operation_id?, project }`: a map, timeline (optionally in a calendar, by name or id) or board on a page.
`DOCUMENT_EXISTS` for a document of the same name on the page. Page text is `write_page`'s.

**`update_document`** `{ page, document, name?, hidden?, fullWidth?, calendar?, mapImage?, dryRun?, project }`: a
document's settings only, never its content. Page and blank documents are refused (`DOCUMENT_IS_PAGE`: use
`write_page`). Only what changes is sent.

**`delete_document`** `{ page, document, confirm: true, dryRun?, project }`: refused for the page's last document
(`DOCUMENT_LAST`) and for its only page-type document (`DOCUMENT_ONLY_PAGE`): that is the page's content (use
`write_page` or `delete_resource`). Since v2 C2c the switchable canon rule `delete-document-authoritative` (on by
default) makes deleting a map, timeline or board of an Authoritative page a canonical proposal.

### Costs (reads and writes, typical)

Measured against the mock LegendKeeper (test/resources/costs.test.ts), every read the call causes included: planning
reads, the job's checks, the canon guard's in-lock read, the verify step and the repository tree's re-reads.

| Call                                                    | Reads | Writes |
| ------------------------------------------------------- | ----- | ------ |
| `create_character` core with a new index, 1 caller fact | 11    | 9      |
| `create_character` compact, no caller facts             | 8     | 7      |
| `create_character` that returns an existing page        | 1     | 0      |
| `create_resource` with 2 facts and 1 link               | 10    | 6      |
| `create_bare_resource`                                  | 2     | 1      |
| `update_resource` rename (re-placed among its siblings) | 4     | 1      |
| `move_resource`                                         | 3     | 1      |
| `delete_resource`, one page                             | 4     | 1      |
| `restore_resource`                                      | 3     | 1      |
| `create_document`                                       | 2     | 1      |
| `update_document`                                       | 4     | 1      |
| `delete_document`                                       | 4     | 1      |
| `set_facts`, 2 facts (unchanged from C2a)               | 4     | 2      |

These are the v2 C2c numbers: the creates are Working by default, so an index gets no Status (fewer reads and writes)
and a page from a template gets its status tag in one more write; the measured rename is of the only page under
`[INDEX] Working` (no re-placing); a document delete reads the page's facts and the document for the
delete-document canon rule.

Where they go, for a Working Core with a new index: 2 template sidebars (planning), 2 creates; for the Core, 1 copy
check, 1 in-lock read of the rows and 1 canon check of the sidebar, then 1 write per fact (Status included) and 1 for
its status tag; the verify step's facts read and listings (the Working index's children, the new index's); the tree's
re-reads, one per page, at the end of the job. `create_many_resources` with 100 pages without templates: 1 write, 1–2
listings to verify, and the tree's 100 re-reads. A dry run costs the template reads only (none for the other tools); a
proposal costs the planning reads, then the job when approved (capture reads nothing for pages it creates). A cascade
delete adds 1 read per page under it (the canon check).

## The page lifecycle (v2 C2c)

Every page is in one of three lifecycle states, each with a prefix, a Status, a status tag and a place (decided by the
owner on 10 November 2026). Design: [ADR 0035](adr/0035-page-lifecycle.md).

| State         | Prefix   | Status          | Tag        | Place                                                    |
| ------------- | -------- | --------------- | ---------- | -------------------------------------------------------- |
| Authoritative | `[BSRC]` | `Authoritative` | `CANON`    | its normal place (the registry's placement rules)        |
| Working       | `[BWRK]` | `Working`       | `Working`  | directly under `[INDEX] Working`, flat and alphabetical  |
| Archived      | `[BARC]` | `Archived`      | `Archived` | directly under `[INDEX] Archived`, flat and alphabetical |

The values are per project and the owner can change them (dashboard, Projects page, Lifecycle); the defaults above are
the owner's. The two indexes are found **by name** through the tree, never by a fixed id or position, and stored once
the owner confirms them. Until then, or when a confirmed index has gone, been renamed or stopped being an index, every
lifecycle tool and every Working create is refused with `LIFECYCLE_NOT_CONFIGURED`, `LIFECYCLE_INDEX_MISSING` or
`LIFECYCLE_INDEX_CHANGED`, saying what the owner has to do.

`[BWRK]` and `[BARC]` pages are pages like `[BSRC]` ones everywhere: `browse_repository_tree` and `search` show their
kind (`kind: "bwrk"` / `"barc"` filters them), `get_resource` resolves their names without the prefix, and the
dashboard's tree counts them. When one name could be several pages of the same subject, a mention prefers the current
`[BSRC]` page (or an index), then the `[BWRK]` page, then the `[BARC]` page; `AMBIGUOUS` lists each with its role.

### Creating Working and Authoritative pages

`create_resource`, `create_bare_resource`, `create_many_resources` (per item) and `create_character` take
`status: "working" | "authoritative"`. **The default is `working`**, which changes C2b's behaviour: a page created
without a status is now a `[BWRK]` page under `[INDEX] Working`, not a `[BSRC]` page under the given parent.

- **`working`**: `[BWRK] {name}` directly under `[INDEX] Working` (alphabetical), Status `Working`, the `Working` tag
  added and `CANON` removed. Leave `parent` out, or give `[INDEX] Working` itself (`WORKING_PARENT` otherwise).
- **`authoritative`**: `[BSRC] {name}` in its normal place, Status `Authoritative`, the `CANON` tag. This is canon:
  the call is always a canonical proposal (`proposal_captured`, `requiresCanonicalApproval`), whatever the scope. A
  parent in a lifecycle area is refused (`LIFECYCLE_AREA`).
- **Characters**: a Working Core gets its own `[INDEX] {name}` directly under `[INDEX] Working`, with the Core,
  `[BWRK] {name} - Character Core`, beneath it; a Working compact page goes directly under `[INDEX] Working`. The race
  is still validated (and written as Race / Species). When the race index already holds an `[INDEX] {name}`, a
  Working Core is refused (`CHARACTER_INDEX_ELSEWHERE`: it would clash when promoted; create the Core as authoritative
  there). Return-existing and the duplicate check look in both places.
- **`create_index`** takes no status: an index has no lifecycle state and gets no Status. It is refused under
  `[INDEX] Working` or `[INDEX] Archived` (`LIFECYCLE_AREA`; a Working character's own index is made by
  `create_character`).
- **`create_many_resources`**: a Working item's parent must be `[INDEX] Working` (or left out) or, for a character, a
  character index directly under it; nothing goes under a Working item (`WORKING_PARENT`: Working pages are flat). A
  batch may mix Working and Authoritative items; any Authoritative item makes the whole batch one canonical proposal.

A Status in `facts` must agree with `status` (`INVALID_FACTS`). No lifecycle record is written for a create.

### The four lifecycle tools

`archive_page`, `unarchive_page`, `move_to_working` and `promote_page` are the only way a page changes state. Each:

- **always needs the owner's canonical approval**, at every scope (a profile with scope `write` too): the call returns
  `proposal_captured` with `requiresCanonicalApproval`; the dashboard's ordinary Approve is refused, only "Approve and
  accept as canon" runs it. Never retry the call; follow it with `bridge_proposal_status`;
- shows the **full plan** in the proposal and with `dryRun: true`: the move and new name, every fact as a table (before
  and after), the tags removed and added, the archive note as a Markdown diff, and (for `archive_page` and
  `move_to_working`) the related pages;
- is **checked again when it runs**: a page changed after capture conflicts, and nothing is written;
- refuses an index (`INDEX_PAGE` / `LIFECYCLE_INDEX`), a page with pages under it (`HAS_SUBPAGES`, listing them), a
  page whose prefix and Status disagree (`LIFECYCLE_INCONSISTENT`: make them agree by hand first), a page already as
  the tool would leave it (`NOTHING_TO_DO`), and a name already taken in the destination (`NAME_TAKEN`);
- refuses a second request for the same page while one waits or runs (`DUPLICATE_REQUEST`, `LIFECYCLE_IN_PROGRESS`).

**`archive_page`** `{ page, dryRun?, project }`: an Authoritative `[BSRC]` or Working `[BWRK]` page becomes
`[BARC] {name}` directly under `[INDEX] Archived` (alphabetical), in one job:

- a **dated note**, one paragraph, as a new first block of its main page document (the page document named Main,
  else the first), with `{date}` today in ISO form (London time) and `{source}` the page's display name. Nothing else
  in the document changes. A page with no page document is refused (`NO_PAGE_DOCUMENT`). From Authoritative:

  > Archived - {date}. The author retired {source} and its applications from Main CANON. The text below records the
  > former design for provenance.

  From Working:

  > Archived - {date}. The author retired {source}, a Working concept, without adopting it into Main CANON. The text
  > below records the former design for provenance.

- **facts**: Status `Archived`, Continuity Type `NON-CURRENT`, Scope `Archived record of the retired` plus one space
  and the original Scope (the prefix alone when there was none), Temporal Scope `Former Main CANON. Retired on {date}.`
  (from Authoritative) or `Former Working concept. Retired on {date}.` (from Working), Last Major Revision today. A
  missing row is added;
- **tags**: the outgoing status tag (`CANON` or `Working`) removed and `Archived` added; other tags untouched.

**`unarchive_page`** `{ page, destination?, previousState?, restore?, dryRun?, project }`: reverses an archiving
**from its lifecycle record**. A formerly Authoritative page goes back under its previous parent (alphabetical) as
`[BSRC]`, with its recorded Status, Continuity Type, Scope and Temporal Scope and the `CANON` tag; a formerly Working
page goes back under `[INDEX] Working` as `[BWRK]` with Status `Working`, the `Working` tag and its other recorded
values. Last Major Revision becomes today (a recorded fact that was absent is removed again). The archive note is
removed **only if it is still exactly as inserted**; otherwise it stays and the result flags it. A Scope edited since
archiving is flagged (the recorded original is restored). When the previous parent has gone, is outside the repository
or is in a lifecycle area, give `destination` (`DESTINATION_REQUIRED` otherwise). A page **archived by hand** has no
record: give `previousState`, `restore: { continuityType, scope, temporalScope, status? }` and (for an Authoritative
page) `destination`; without them the call is refused with `NO_LIFECYCLE_RECORD`, naming what is missing. Refused for
anything but a `[BARC]` page (`NOT_ARCHIVED`).

**`move_to_working`** `{ page, dryRun?, project }`: an Authoritative `[BSRC]` page becomes `[BWRK]` directly under
`[INDEX] Working`, Status `Working`, `CANON` swapped for `Working`. Nothing else changes; the record keeps where it was.
Only from `[BSRC]` (`NOT_AUTHORITATIVE`). A Character Core under its own character index moves **alone** (the index and
its other pages stay; the result flags it, and `promote_page` takes it back).

**`promote_page`** `{ page, destination, dryRun?, project }`: a Working `[BWRK]` page becomes `[BSRC]` under
`destination` (required; alphabetical), Status `Authoritative`, Last Major Revision today, Continuity Type kept when
`CANON` or `AU` and otherwise set to `CANON`, `Working` swapped for `CANON`. Without `destination` it is refused with
`DESTINATION_REQUIRED` and, when the page came from `move_to_working`, `suggestedDestination`: the place it was in
(never used unless you pass it). A Working character's Core (or compact page) under its own `[INDEX] {name}` takes
that index with it to the destination (normally its race index); other pages under the index keep their state and are
listed. Only from `[BWRK]` (`NOT_WORKING`); a destination in a lifecycle area is refused (`LIFECYCLE_AREA`).

### Order, failures and resuming

The steps are ordered so that a failure part-way never leaves a page that claims a state it is not in: leaving canon
(`archive_page` from Authoritative, `move_to_working`), the rename and tags come first, then the facts, the note and
the move; entering a state (`unarchive_page`, `promote_page`), the move comes first, then the facts and the note, and
the rename and tags last. Every write goes through the page's lock, compare-and-swap (If-Match) and the journal, and the
job ends with a verify step.

A job that stops part-way marks the page's **lifecycle record** `incomplete` and the result says which steps ran
(`WRITTEN_IN_PART`). **Calling the same tool on the page again resumes it**: the bridge plans again from the page as it
is now and proposes only what is left (a new canonical proposal; nothing is replayed). Another lifecycle tool on that
page is refused until then (`LIFECYCLE_INCOMPLETE`, naming the tool to call).

### What a result says

`page`, `action`, `newName`, `newParent`, `place` (`after` / `before`), `facts` (each `{ field, before, after }`),
`tags` (`remove`, `add`), `note` (with its Markdown `diff`), `characterIndex` (when one moves), `flags` (what the owner
should know), `resumes` (a resumed record), `relatedPages`, and, once the job runs, `verified` and the lifecycle
record's `recordId`. The dashboard's "Archive and lifecycle" page lists every record, linked to the journal.

**Related pages** (`archive_page` and `move_to_working`): the pages that link to the page (a link collection, named)
or mention it in their text (the document named), from the **link index**, with `freshness` ("link index as of …":
the last complete sweep, plus the bridge's own writes since); then the hits of **one** LegendKeeper content search for
the page's display name that the index does not hold, each marked `found by text search (may be incomplete)`.
Related pages are reported, never edited. The link index is kept up to date from the bridge's own writes and refreshed
by the paced link sweep ([maintenance.md](maintenance.md)).

### The side routes are refused

The lifecycle guard (in the engine, on every write path: `set_facts`, the create tools, `update_resource`,
`move_resource`, `lk_api_write`, `lk_api_batch`, the `lk_op_*` tools and an approved proposal) refuses with
`POLICY_DENIED`, naming the tool to use:

- a Status change to or from `Working` or `Archived`, and `Working` → `Authoritative` (a Status in a create body
  included);
- a rename that adds, removes or changes `[BWRK]` or `[BARC]` (`update_resource` answers `PREFIX_CHANGE`), and a page
  created with one by hand;
- a move into, out of or between the lifecycle indexes, and a page created under one by hand.

Only the four tools' own steps pass, through a marker only bridge code can set (an agent's request body can never carry
it); approved work that should carry it and does not is refused when it runs. Even at scope `propose` these routes are
refused, not proposed.

### Costs (reads and writes, typical)

Measured against the mock LegendKeeper (test/lifecycle/costs.test.ts), every read included: to capture the proposal
(planning, the note's place, the content search), then the job the owner's acceptance runs (its checks, the canon and
lifecycle guards' reads, the in-lock reads before each write, the verify step and the tree's re-read). CR-2026-11 took
4 reads off every job without dropping a check: the guards' entry reads of the sidebar now use the approval's re-read of
the page, made a moment before, and the tree re-reads the page once when the job ends rather than after the rename and
the move as well.

| Call                               | Capture reads | Job reads | Job writes |
| ---------------------------------- | ------------- | --------- | ---------- |
| `archive_page`, from Authoritative | 6             | 15        | 8          |
| `archive_page`, from Working       | 5             | 15        | 8          |
| `unarchive_page`, to Authoritative | 4             | 15        | 7          |
| `unarchive_page`, to Working       | 4             | 15        | 7          |
| `move_to_working`                  | 3             | 11        | 3          |
| `promote_page`                     | 2             | 11        | 5          |

The writes: `archive_page` 1 rename-and-tags, 5 facts (one added), 1 note, 1 move; `unarchive_page` 1 move, 4 facts,
1 note removal, 1 rename-and-tags; `move_to_working` 1 rename-and-tags, 1 fact, 1 move; `promote_page` 1 move, 3 facts,
1 rename-and-tags (plus 1 move for a character index that goes with it). A dry run costs the capture reads.

## The calendar and the timelines (v2 D1)

Design: [ADR 0038](adr/0038-calendar-engine-and-chronology-sync.md). The calendar engine is built from the project's
LegendKeeper calendar definition alone and matches LegendKeeper on every event of the spike's oracle. A chronology event
is three things kept in step: a row of its age's table (the **authority**), an event of its age's timeline (a derived
view) and one in its age's count on the Main table.

**Before any chronology write** the owner reads and confirms the chronology on the dashboard (Chronology page): the
Universal Chronology page, its calendar, its Main document, and per age its "- Table" page, its "- Timeline" document,
that timeline's one lane and its Main row, plus how the tables write dates and KCY values (learned from the rows). Until
then, or when a confirmed document has gone, been renamed or changed type, the three event tools refuse with
`CHRONOLOGY_NOT_CONFIGURED` or `CHRONOLOGY_CHANGED`.

| Tool                    | Access | What it does                                                                                                                                                                                                                                                                           |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_date`         | R      | `date` (any accepted form), `minutes` (with `detail`, `endMinutes`) or `kcy`: the form, shape and detail, minutes, KCY (and its table text), the age, LegendKeeper's formatted text and the table's text; or exactly why the date is refused. No request while the calendar is cached. |
| `create_timeline_event` | W      | `date`, `name` (timeline), `description` (table; text or `{ markdown }`), optional `age` (to confirm the date's). One job: the row in calendar order, the event (exact minutes, detail, the age's lane, `uri` to the age's table), the count +1. An identical row is refused.          |
| `update_timeline_event` | W      | `event` (its date with its description or name, or `row_id` / `event_id`), and a new `date`, `name` and/or `description`. Another age moves the row and the event and adjusts both counts. Refused when the row and its event have drifted apart.                                      |
| `delete_timeline_event` | W      | `event`, `confirm: true`. Removes the row and the event, count −1; the journal keeps both.                                                                                                                                                                                             |
| `create_timeline_lane`  | W      | `page`, `document` (a timeline), `name`, `size`, `color`. Touches only that timeline; refused on the chronology's age timelines (exactly one lane each by design).                                                                                                                     |

All four W tools take `dryRun`, `operation_id` (C2b's) and `project`, and under `propose` give ONE proposal whose page
shows the change as a Markdown diff of the rows, the count and the event.

**Accepted date forms** (from the calendar's own templates; for Kumikan): `Kumikas 1st, 1A 159` (a day), `4A 881` (a
year), `Unknown, 4A 101` (a year, stored year-only), `Zahras 4A 367` (a month), `Kumikas 19th, 4A 100 - Meshaph 10th, 4A
102` (a date range), `Jehet 11th - 18th, 4A 424` (days of one month), `Isar 20th - Pahan 31st, 4A 32` (days of one
year), `Kumikas - Azaakh, 4A 180` and `Zahras 4A 367 - Attina 4A 367` (month ranges), `4A 881 - 4A 900` (a year range).
Case, ordinal suffixes, extra spaces, the dash and year commas do not matter. `Unknown` alone is refused, as are an
unknown month or era, an impossible day, a date outside its era (before Azah 18th in 4A 1, say) and a reversed range,
each with a precise message (`DATE_*`). A row is written in the form given.

**Calendar order** in a table: by year; within a year the dated rows by their start (a range by its start), then the
year-only rows (and year ranges); a new row goes after the existing rows of the same date. The place and the new count
are decided inside the job's lock from the documents as they are then, so concurrent writes and several approved
proposals for one age all land correctly.

**Refusals** besides the date's: `AGE_MISMATCH`, `AGE_NOT_CONFIGURED`, `DUPLICATE_EVENT`, `EVENT_NOT_FOUND`,
`EVENT_AMBIGUOUS`, `CHRONOLOGY_DRIFT`, `CHRONOLOGY_INCOMPLETE` (another change of the age stopped part-way),
`CHRONOLOGY_IN_PROGRESS`, `CHRONOLOGY_RESUME_CONFLICT`, `CHRONOLOGY_TIMELINE` and `LANE_EXISTS`.

**Stopped part-way.** The answer says which writes were made. The same request again makes only what is left
(`resumes` in the answer); until then other changes of that age are refused. The owner can mark a stopped change
resolved on the Chronology page.

**Canon.** These are ordinary edits on the Authoritative chronology page, never canon-gated (ADR 0036 decision 6,
option (a)); only deleting a whole timeline document of an Authoritative page is canonical.

### Costs (reads and writes, measured against the mock)

| Call                                 | Reads | Writes |
| ------------------------------------ | ----- | ------ |
| `calendar_date` (calendar cached)    | 0     | 0      |
| `create_timeline_event`              | 10    | 3      |
| `update_timeline_event`, same age    | 9     | 3      |
| `update_timeline_event`, another age | 18    | 6      |
| `delete_timeline_event`              | 12    | 3      |
| `create_timeline_lane`               | 2     | 1      |

Add one read per 100 events of the age's timeline when an event is found by its row (update and delete). A dry run
costs the planning reads only (3 to 5).

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
