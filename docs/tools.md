# MCP tools (chunk 3)

LK-Bridge exposes LegendKeeper to Claude, Claude Code and ChatGPT as a small set of MCP tools. The 89 LegendKeeper operations sit behind a few **meta-tools**, so the tool list stays short; per-operation tools are optional. Every call goes through the job engine and the rate governor, and every result ends with a one-line budget footer.

Since v2 A1 one bridge serves **several LegendKeeper projects** (each with its own key, so its own rate budget). Every tool takes an optional `project` argument, and every result names the project it used: see [Projects](#projects) and [projects.md](projects.md).

Source: `src/mcp/tools/`. Design notes: [ADR 0011](adr/0011-tool-layer.md). Authentication: [auth.md](auth.md).

## Agent guidance (the MCP server `instructions`)

> LK-Bridge gives governed access to LegendKeeper projects (list_projects). Every tool takes an optional project; a write must name its project when the bridge serves several.
> FIRST call get_bridge_guide with section "How to decide", then read its section for your task before you do it; read get_markdown_guide before writing Markdown. Every result names its project and ends with that project’s budget line.
> The four rules that matter most:
>
> 1. Use the high-level tools (search, get_resource, read_document, write_page, set_facts, create__); the lk_api__ tools are only the fallback for a job none of them does.
> 2. Read before you write, and pass the version you read (baseVersion, baseFactsVersion). Never retry a write that returned proposal_captured, queued or waiting_budget: follow it with bridge_proposal_status or bridge_job_status.
> 3. New pages are Working. Canon and lifecycle changes (promote_page, archive_page, deleting Authoritative pages) are always proposals only the owner can accept: tell the person, never route around it.
> 4. Budgets are finite: never loop on an error, and check bridge_estimate before bulk work.
>    Results are summaries (detail "full" opts in); oversized results come as handles for bridge_result_page.

The text is `BRIDGE_INSTRUCTIONS` in `src/mcp/tools/index.ts`; a test checks it covers each point. Since v2 B2 it is short and points to the bridge guide ([bridge-guide.md](bridge-guide.md), served by `get_bridge_guide`); the detail that used to be here lives in the guide. Since v2 E3 ([ADR 0045](adr/0045-tool-review-and-the-tool-call-log.md)) it is the ten-line version of the guide: the guide first (its section "How to decide"), then the four rules that matter most. A test keeps it under 1,500 characters.

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
- **At scope `write` (v3 F3.4, [ADR 0055](adr/0055-write-scope-review-revert-rails.md)).** Ordinary writes run at once and
  the owner reviews them afterwards (the dashboard's Review page, with Revert). A write the profile's **safety rails**
  keep for approval (by default: deletes, a job touching more than 10 pages, asset deletes and moves) comes back
  `proposal_captured` with `proposedBecause` (`"proposed because: bulk change (14 pages > 10)"`) and a hint not to retry
  it or route round it; canon and lifecycle changes, `restore_snapshot` and (by default) a setting pack's packages stay
  proposals whatever the scope. The full table, tool by tool: ADR 0055, decision F.

## How the tools are described (v2 E3)

Every description follows one shape, so an agent can pick a tool from its first sentence: **what it does**; **when to use it, and
what to use instead**; **its scope behaviour** (at `propose` a write becomes a proposal: nothing is written, never resubmit
it); **the mistake to avoid**; **the cost line** (`Cost:` in reads and writes, measured against the mock). Examples are kept
only where the arguments are nested. Shared argument texts (`project`, `operation_id`, `status`, `subtree`, map points) are
short because they repeat in every schema. The whole list as a client receives it is measured by
`npx tsx scripts/tool-surface.ts` (`--inventory` for the per-tool table): since v2 E3b in a `propose` or `write` profile, **56 tools,
about 29,850 tokens** (characters ÷ 4; 61 tools and about 31,100 before the owner's answers); in a `read` profile, **25 tools, about
8,760** (28 and 9,100 before); with “show low-level and rarely used tools” on, 61 and 28; the per-operation tools would add about
171,000 and stay off. **Since v3 F3a** a bridge that serves a project with a setting pack attached also lists the pack's tool,
`arkona_create_character` ([below](#setting-packs-arkona_create_character-v3-f3a)): **57 tools, about 32,660 tokens** in a
`propose` or `write` profile (the pack tool is about 2,330 of them; 62 with the low-level tools on), and the same 25 in a
`read` profile. **Since v3 F3b** the Arkona pack lists five tools ([below](#setting-packs-owners-relationships-art-and-the-brief-v3-f3b)):
**61 tools, about 38,050 tokens** in a `propose` or `write` profile, measured with F3c's `lastMajorRevision` on the write
tools (the five pack tools about 6,530 of them: `arkona_create_character` 2,520, `arkona_create_owner` 1,730,
`arkona_add_character_art` 1,100, `arkona_create_relationship` 850, `arkona_character_brief` 330; 66 with the low-level
tools on), and **26, about 9,090**, in a `read` profile (the read-only `arkona_character_brief`; 29 with the low-level
tools on). **Since v3 F3c** it lists ten ([below](#setting-packs-appraisal-and-full-text-search-v3-f3c)): **66 tools, about
41,080 tokens** in a `propose` or `write` profile (the five appraisal tools about 2,820 of them: `arkona_appraise_owner`
705, `arkona_change_impact` 636, `arkona_visual_hygiene` 525, `arkona_working_digest` 504, `arkona_appraisal_fix` 449;
`search` 620 with its `content` and `include`; 71 with the low-level tools on), and **30, about 11,670**, in a `read`
profile (the four read-only appraisal tools; 33 with the low-level tools on). **Since v3 F3d** the Arkona pack lists eleven
tools ([below](#setting-packs-renames-selective-approval-and-resume-v3-f3d)), and `bridge_job_resume` is added: **68 tools** in
a `propose` or `write` profile (`arkona_rename` and `bridge_job_resume` are write tools; 73 with the low-level tools on), and
the same **30** in a `read` profile. **Since v3 F3e** it lists thirteen ([below](#setting-packs-splits-v3-f3e)): **70
tools, about 46,790 tokens**, in a `propose` or `write` profile (`arkona_split_owner`, a write tool, about 2,230 of them;
`arkona_split_appraisal`, a read tool, about 790; 75 with the low-level tools on), and **31, about 12,460**, in a `read`
profile (34 with the low-level tools on). **Since v3 F3f** it lists fifteen ([below](#setting-packs-retagging-v3-f3f)):
**72 tools** in a `propose` or `write` profile (`arkona_retag_apply` a write tool; 77 with the low-level tools on), and
**32** in a `read` profile (`arkona_retag_audit` a read tool). **Since v3 F5c** ([below](#orchestration-v3-f5c)) every
profile gains `bridge_workstream`, `bridge_workstream_report` and `query_facts` (read tools), and a `propose` or `write`
profile `arkona_identity_reconcile` (a write tool, listed with the pack); every write tool takes `workstream`. The review, with the owner's answers on the proposed merges and hiding and what the wording changes did:
[reviews/E3-tools.md](reviews/E3-tools.md). The script the owner runs in ChatGPT and Claude:
[reviews/E3-evaluation.md](reviews/E3-evaluation.md). What each assistant really called is on the dashboard's **Tool calls**
page ([dashboard.md](dashboard.md#tool-calls-v2-e3)).

**Refusals name the next step.** A typed error with no hint of its own gets one from a single table (`NEXT_STEP`,
`src/mcp/tools/shape.ts`): read-only (tell the person), draining (wait, send once more), member admin (switched off), a
cascade delete (ask first), canonical approval (only the owner; never retry), an unknown job or project. `POLICY_DENIED` says
to use the tool the message names, once, and not to try another route. Codes and which calls are refused are unchanged.

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

| Tool                        | Access | Annotations (read-only / destructive / idempotent / open-world) | Cost                                                                                                                    |
| --------------------------- | ------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `list_projects`             | read   | true / false / true / false                                     | none                                                                                                                    |
| `browse_repository_tree`    | read   | true / false / true / false                                     | none (the tree)                                                                                                         |
| `browse_asset_tree`         | read   | true / false / true / false                                     | none (the asset tree)                                                                                                   |
| `search`                    | read   | true / false / true / false                                     | none (the tree; `content: true`: the full-text index); 1 read with `content: "live"`                                    |
| `get_resource`              | read   | true / false / true / false                                     | 1 read per page (none with `live: false`); `resources` runs several as one job                                          |
| `list_tags`                 | read   | true / false / true / false                                     | none (the tree)                                                                                                         |
| `list_templates`            | read   | true / false / true / false                                     | none, or 1 read per 100 templates                                                                                       |
| `list_calendars`            | read   | true / false / true / false                                     | 1 read                                                                                                                  |
| `list_assets`               | read   | true / false / true / false                                     | none (the asset tree)                                                                                                   |
| `read_document`             | read   | true / false / true / false                                     | 1 read (a map: 2; a timeline: 2 + 1 per 100 events)                                                                     |
| `write_page`                | write  | false / **true** / false / false                                | 2 reads + 1 write + 1 verify read                                                                                       |
| `set_facts`                 | write  | false / **true** / false / false                                | see below (typically 4 reads + 1 write)                                                                                 |
| `create_index`              | write  | false / false / false / false                                   | see [C2b](#resources-documents-and-characters-v2-c2b)                                                                   |
| `create_resource`           | write  | false / false / false / false                                   | see C2b                                                                                                                 |
| `create_bare_resource`      | write  | false / false / false / false                                   | 1 write + 1 listing + the tree’s re-read                                                                                |
| `create_many_resources`     | write  | false / false / false / false                                   | see C2b                                                                                                                 |
| `create_character`          | write  | false / false / false / false                                   | see C2b                                                                                                                 |
| `update_resource`           | write  | false / **true** / false / false                                | 1 read + 1 write (+1 to re-place) + verify                                                                              |
| `move_resource`             | write  | false / **true** / false / false                                | 1 write + 1 listing + the tree’s re-read                                                                                |
| `delete_resource`           | write  | false / **true** / false / false                                | 1 read + canon reads + 1 write + 1 read                                                                                 |
| `restore_resource`          | write  | false / false / false / false                                   | 1 write + 1 read + the tree’s re-read                                                                                   |
| `create_document`           | write  | false / false / false / false                                   | 1 write + 1 read                                                                                                        |
| `update_document`           | write  | false / **true** / false / false                                | 2 reads + 1 write + 1 read (a map image: 7 reads in all)                                                                |
| `delete_document`           | write  | false / **true** / false / false                                | 1 write + 1 read                                                                                                        |
| `create_map_feature`        | write  | false / false / false / false                                   | see [D2](#maps-v2-d2): 5 reads + 1 write                                                                                |
| `update_map_feature`        | write  | false / **true** / false / false                                | see D2: 5 reads + 1 write                                                                                               |
| `delete_map_feature`        | write  | false / **true** / false / false                                | see D2: 5 + 1 read and 1 write per feature                                                                              |
| `archive_page`              | write  | false / **true** / false / false                                | see [C2c](#the-page-lifecycle-v2-c2c) and [C2d](#whole-sets-guarded-tags-and-approval-scope-v2-c2d)                     |
| `unarchive_page`            | write  | false / **true** / false / false                                | see C2c and C2d                                                                                                         |
| `move_to_working`           | write  | false / **true** / false / false                                | see C2c and C2d                                                                                                         |
| `promote_page`              | write  | false / **true** / false / false                                | see C2c and C2d                                                                                                         |
| `get_markdown_guide`        | read   | true / false / true / false                                     | none                                                                                                                    |
| `get_bridge_guide`          | read   | true / false / true / false                                     | none                                                                                                                    |
| `lk_api_list_operations`    | read   | true / false / true / false                                     | none                                                                                                                    |
| `lk_api_describe_operation` | read   | true / false / true / false                                     | none                                                                                                                    |
| `lk_api_read`               | read   | true / false / true / false                                     | 1 read                                                                                                                  |
| `lk_api_write`              | write  | false / **true** / false / false                                | 1 write (+ items for createMany)                                                                                        |
| `lk_api_batch`              | write  | false / **true** / false / false                                | sum of its steps, at job priority                                                                                       |
| `lk_api_paginate_all`       | read   | true / false / true / false                                     | 1 read per page of 100                                                                                                  |
| `lk_upload_image`           | write  | false / false / false / **true**                                | 2 writes (+ upload-tier backoff)                                                                                        |
| `upload_image`              | write  | false / false / false / **true**                                | 2 writes, 1 read, 1 download; +1 write and read per new folder; see [Images](#images-v2-d3)                             |
| `prepare_image_upload`      | write  | false / false / false / false                                   | none                                                                                                                    |
| `upload_image_archive`      | write  | false / false / **true** / **true**                             | none in LegendKeeper (with `character`: a live read of its asset folders); see [Image archives](#image-archives-v3-f7c) |
| `bridge_archive_status`     | read   | **true** / false / **true** / false                             | none                                                                                                                    |
| `list_snapshots`            | read   | true / false / true / false                                     | none (the bridge's snapshot index)                                                                                      |
| `snapshot_diff`             | read   | true / false / true / false                                     | none between two snapshots; against now 1 read + the document's own (page 1, map 2, timeline 3+)                        |
| `restore_snapshot`          | write  | false / **true** / false / false                                | always a proposal; to plan 1–2 reads + the documents' own; see [Snapshots](#snapshots-and-restores-v2-e1a)              |
| `audit_findings`            | read   | true / false / true / false                                     | none (the bridge's own findings); see [Audits](#audits-v2-e2)                                                           |
| `bridge_info`               | read   | true / false / true / false                                     | up to 2 cached reads (10 min)                                                                                           |
| `bridge_budget`             | read   | true / false / true / false                                     | none                                                                                                                    |
| `bridge_estimate`           | read   | true / false / true / false                                     | none                                                                                                                    |
| `bridge_job_status`         | read   | true / false / true / false                                     | none (`wait_seconds` waits at most 25 s)                                                                                |
| `bridge_job_cancel`         | write  | false / false / true / false                                    | none                                                                                                                    |
| `bridge_job_resume`         | write  | false / false / false / false                                   | none to ask; the job's own steps that are left (`wait_seconds`-style wait of at most 25 s)                              |
| `bridge_errors_recent`      | read   | true / false / true / false                                     | none                                                                                                                    |
| `bridge_journal_lookup`     | read   | true / false / true / false                                     | none                                                                                                                    |
| `bridge_result_page`        | read   | true / false / true / false                                     | none                                                                                                                    |
| `bridge_proposal_status`    | read   | true / false / true / false                                     | none (without `proposalId` it lists yours)                                                                              |
| `bridge_workstream`         | read   | true / false / true / false                                     | none (the connection's default workstream label, held on the bridge)                                                    |
| `bridge_workstream_report`  | read   | true / false / true / false                                     | none (the bridge's own records); see [F5c](#orchestration-v3-f5c)                                                       |
| `query_facts`               | read   | true / false / true / false                                     | none (the tree's stored sidebars); `live: true` 1 read per row; see [F5c](#orchestration-v3-f5c)                        |
| `lk_op_<operationId>` (89)  | per op | derived from the operation, see below                           | that of the operation                                                                                                   |

`lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all` and every `lk_op_*` are **low-level tools**, and since v2 E3b (the owner's answers to P4 and P5, [ADR 0045](adr/0045-tool-review-and-the-tool-call-log.md)) so are two **rarely used** ones, `lk_upload_image` (which `upload_image` replaces) and `create_bare_resource` (a page with no template; `create_resource` covers every templated page): they are left out of the tool list of a profile whose **show low-level and rarely used tools** setting is off (the default; [below](#visibility-of-the-low-level-tools)). They still work when called by name, under the same policy.

**Renamed tools (v2 E3b).** `get_resources`, `bridge_proposals_mine` and `bridge_job_wait` were merged into `get_resource` (`resources`), `bridge_proposal_status` (no `proposalId` lists yours) and `bridge_job_status` (`wait_seconds`). For one release the old names stay registered but are never listed: a call (from a client's cached tool list) answers `TOOL_RENAMED` with "renamed to …" and how to ask for the same thing, and does nothing. Remove them in the release after.

`lk_api_write` is annotated `destructiveHint: true` because it covers the destructive operations; clients therefore ask before each write.

### Low-level layer

Last Major Revision (v3 F2, v3 F3c): a block edit through `lk_api_write` or `lk_api_batch` that is a major revision sets it
on the page, in the same job or proposal, measured when the job runs; `lastMajorRevision` overrides
([below](#last-major-revision-only-for-real-revisions-v3-f2-v3-f3c)).

**`lk_api_list_operations`** `{ tag?, kind?, risk? }`: the 89 operations with kind (`read` / `write` / `upload`), risk (`safe` / `destructive` / `admin`), cost class, one-line summary, `versioned`, `paged`.

**`lk_api_describe_operation`** `{ operationId }`: the input JSON Schema (with only the `$defs` it uses), risk, concurrency, whether it is versioned and which read gives the version, rate costs, and the guards that apply. A very large schema (the block model) comes back as a handle.

**`lk_api_read`** `{ operationId, params?, detail? }`: runs ONE operation whose kind is `read`. A write operation is refused with `WRONG_TOOL_FOR_OPERATION` (`useTool: "lk_api_write"`) and costs nothing.

```json
{ "operationId": "getDocumentBlocks", "params": { "path": { "resourceId": "r1", "documentId": "d1" } } }
```

`params` is `{ path?, query?, ifMatch?, body? }`; `projectId` is supplied by the bridge, from the `project` argument (every tool below also takes `project`, which these signatures leave out).

**`lk_api_write`** `{ operationId, params?, allowUnsupportedLoss?, confirm?, detail?, lastMajorRevision?, plainRename? }`
(`plainRename`: see [`USE_ARKONA_RENAME`](#changing-moving-deleting-and-restoring)): runs ONE operation whose kind is not `read`, including the raw `createImageUpload` and `createImageAsset`. A read operation is refused with `useTool: "lk_api_read"`. Every engine guard applies:

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

**`lk_api_batch`** `{ calls: [{ operationId, params?, allowUnsupportedLoss?, confirm?, plainRename? }], onError?, title?, lastMajorRevision? }`: one persisted `batch_ops` job. `onError` is `stop` (stop on error, default) or `continue`. Every step is validated and checked against the guards and policy before anything is queued. Returns `{ jobId, status: "queued", eta }`.

**`lk_api_paginate_all`** `{ operationId, params?, maxItems?, maxPages? }`: a `paginate_all` job over a paged read (`listResources`, `listTemplates`, `listEvents`, `listAssets`, `listProjects`). Each page is its own governed read at job priority. Returns `{ jobId, handle }`; the items are readable through `bridge_result_page` while the job runs.

**`lk_upload_image`** `{ name, base64 | url, contentType?, description?, folderId?, waitSeconds? }`: see [Image upload](#image-upload-v1-lk_upload_image). For converted, verified and placed images use `upload_image` ([Images](#images-v2-d3)).

**Per-operation tools.** With `MCP_EXPOSE_PER_OP_TOOLS=true` the bridge also registers `lk_op_<operationId>` for all 89 operations (189 tools in all with the Arkona pack's thirty-two tools, v3 F6a's `arkona_reference_types`, v3 F7c's `upload_image_archive` and `bridge_archive_status`, v3 F3a's `arkona_create_character`, v3 F3b's four, v3 F3c's five, v3 F3d's `arkona_rename`, v3 F3e's `arkona_split_appraisal` and `arkona_split_owner`, v3 F3f's `arkona_retag_audit` and `arkona_retag_apply` and v3 F4a's `arkona_name_check` and `arkona_brief`, v3 F4b's `arkona_consistency`, `arkona_as_of`, `arkona_as_of_coverage` and `arkona_consistency_suggest`, v3 F4c's `arkona_story_create`, `arkona_chapter_plan`, `arkona_chapter_save`, `arkona_chapter_insert`, `arkona_chapter_move`, `arkona_chapter_context`, `arkona_chapter_check` and `arkona_promote_from_chapter`, v3 F5c's `arkona_identity_reconcile`, v3 F7b's `arkona_get_art`, and v3 F3d's `bridge_job_resume` and v3 F5c's `bridge_workstream`, `bridge_workstream_report` and `query_facts`; 191 with the policy layer’s two proposal tools; a generic pack tool for a data-only type, below, adds one more). Each takes the operation's own input (`path`, `query`, `ifMatch`, `body`) plus `detail` (and `allowUnsupportedLoss` / `confirm` on writes), runs through exactly the same path, and records its own name as the job's tool. `access` equals the operation's kind. Annotations come from the operation: reads are read-only and idempotent; writes are `destructiveHint: true` when the operation's risk is `destructive` or `admin`, and `idempotentHint: true` for PUT, DELETE, move, restore, assign-block-ids and delete-shapes. This lists about 600 KB of schemas, which is why it is off by default.

### Bridge awareness

**`bridge_info`** `{ project? }`: version; the asked project (`projectInfo`: name, id, display name, default, read-only, available) and every project (`projects`); the project's LegendKeeper name and the key's role (`ADMIN`, `MEMBER` or `unknown`; inferred from `listMembers`, because LK shows member emails to ADMIN keys only); read-only flag (`effective`; `bridge`, the bridge-wide flag; `project`, the project's own flag; configured, overridden); whether writes are paused or draining, and `canWrite`; writer pool; the calling connection, its profile and its live scope (`read`, `propose` or `write`), and `canWriteAs` (`direct`, `proposal (the owner approves)` or `no (read-only)`); since v3 F5b, `automation`: the finding codes the bridge's automation handles in the project (`code`, `name`, `setting`: `propose automatically` or `apply automatically`, `paused`), `pausedAll`, and a note: the bridge fixes these after the nightly audit (or proposes the fix), so do not propose or apply the same fixes; only the owner changes these settings ([ADR 0068](adr/0068-v3-f5b-automatic-actions-for-audits.md)). The project name and role come from one lookup per project shared by every caller and cached for 10 minutes; it runs as the bridge's own work (`system` principal, v1.0.1), so a failure there shows on the dashboard's Errors page under `system`, not in a caller's `bridge_errors_recent`.

**`bridge_budget`** `{ project?, allProjects? }`: one project's tiers (used, limit, remaining, seconds to reset, any block after a 429, drift), queue depth per priority, write pacing. `allProjects: true` lists every project's budget side by side. v2 E5.5: `learnedOperationLimits` (only when there are any) lists the limits LegendKeeper reported for an operation group that match no documented tier (the asset routes' about 20 a minute): group, operations, limit, window, remaining, seconds since last seen, seconds to expiry, any block.

**`bridge_estimate`** `{ reads?, writes?, createManyItems?, priority? }`: against the asked project's budget, projected wall-clock time, the tightest tier, whether it fits today's request budget, with advice. Call it before large workloads. v2 E5.5: `secondsPerWrite` and `perWriteFrom` say what one write is taken to cost: the median of the project's last 200 write steps, or the configured write spacing when that is longer.

**Your own work only.** `bridge_job_status`, `bridge_job_cancel`, `bridge_result_page` and `bridge_errors_recent` show only the calling connection's jobs, stored results and errors; another connection's job id or handle answers exactly like one that does not exist. `bridge_journal_lookup` shows every connection's writes (so agents can cross-check each other), each with its principal, profile and approver; job ids appear only on your own entries, and a `jobId` filter matches only your own jobs.

**`bridge_job_status`** `{ jobId?, steps?, status?, limit?, wait_seconds? }`: one job (status, progress, last error, result, failed steps; `done` is true when it has finished), or recent jobs when `jobId` is omitted. `wait_seconds` (1 to 25, needs a `jobId`: `JOB_ID_REQUIRED` otherwise) waits for the job to finish first and then answers (v2 E3b: this is the former `bridge_job_wait`; call again if `done` is false). Signed-URL material is redacted.

**`bridge_job_cancel`** `{ jobId }`: the step in flight finishes; nothing further is sent; finished steps are not undone. A job the owner approved (an approved proposal's job, which runs as the connection that proposed it) is refused with `OWNER_APPROVED_JOB`: only the owner stops approved work, on the dashboard (CR-2026-11).

**`bridge_job_resume`** `{ jobId }` (v3 F3d, ADR 0058): resumes one of **your own** jobs that stopped part-way (a setting-pack package or a rename that failed or was cancelled after doing some of its work), in the same job: its own check runs again first, inside its locks; a step that succeeded is never sent again and nothing is made twice; a step that is no longer safe (its page changed since) is refused with its reason, and the job stops again where it was. Only at scope `write`, and only for a job the owner did not approve (`OWNER_APPROVED_JOB`: the owner resumes approved work on the dashboard); another connection's job answers `JOB_NOT_FOUND`. CR-2026-11-R3 (ADR 0061 part B, the owner's decisions): a job the owner (or the bridge) cancelled is not resumed by an agent (`CANCELLED_BY_OWNER`; the bridge records who cancelled, and an agent resumes only what it cancelled itself, R3-54); and the connection's safety rails are judged again on the steps left (R3-55): when one now covers a step, the rest becomes one proposal for the owner (`proposal_captured`, with `proposedBecause`), and the job is not resumed again while it stands (`REST_PROPOSED`). Audited as `job.resume`. `bridge_job_status` shows where a resumable job stopped (`stoppedAt`: its last verified step, the step it stopped at, why, how often it was resumed, and `youMayResume`).

**`bridge_errors_recent`** `{ grouped?, limit?, sinceMinutes?, jobId? }`: failures grouped by operation, code and path (default), or one row each, with LegendKeeper `requestId`s.

**`bridge_journal_lookup`** `{ resourceId?, documentId?, targetId?, operationId?, jobId?, principalId?, profile?, outcome?, withPreImage?, before?, sinceMinutes?, limit?, includePreImage? }`: the write journal, newest first. Since chunk 8 it holds **every** write the bridge sends (creates, inserts, patches, deletes), each with operation, target, time, outcome (`applied`, `not_applied`, `unknown`, `pending`), principal, profile and approver; destructive writes also keep their pre-image. Since v2 C1 an entry made by a high-level tool also has `operation`: for `write_page` the tool, mode, section, a SHA-256 of the Markdown (`markdownSha256`) and its length, the version the plan was built on (`plannedOn`), the agent's `baseVersion`, `dropRegions`, and `replannedInLock` when the bridge re-planned a section edit inside the lock. Since v2 C2a, `set_facts` entries have the tool, the page, the property, the counts and the write (`Status: changed`); the first write to the key-value property keeps the property as the plan saw it as its pre-image. `targetId` also matches every resource a `createManyResources` created. Pages hold `limit` entries (default 10, at most 100); when a page is full, `nextBefore` is the cursor for the next, older page (`before`).

**`bridge_proposal_status`** `{ proposalId?, state?, limit? }`: with `proposalId` one of your own proposals, without it your own proposals newest first (`state` and `limit` filter; v2 E3b: this is the former `bridge_proposals_mine`), in the asked project (a proposal belongs to the project its write was for, and runs there once approved) (writes at scope `propose`, waiting for the owner): state, summary, the rejection reason, the conflicting operation and the job once executed ([policy.md](policy.md)). Since v2 C1 a proposal made by a high-level tool also has `operation`, briefly (for `write_page`: the tool, page, document, mode, section, the version it was planned on and the counts; never the Markdown). Since v2 C2a each also has `pages`, the page-level summary (one plain line per page, for example `Asagiri Miyabi: sidebar, 2 facts changed`), and `requiresCanonicalApproval` with `canonicalReason` when the change touches protected canon (only the owner's "Approve and accept as canon" can run it).

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

**`browse_asset_tree`** `{ folder?, depth?, includeAssets?, assetsPerFolder?, limit?, refresh? }`: the same for asset folders:
each folder's `folderCount` and `assetCount`, subfolders to `depth`, and with `includeAssets: true` up to
`assetsPerFolder` (20) assets per folder (name, type, dimensions, size where LegendKeeper says). `folder` is an id, a name
or a path (`"Characters / Beastkin / Qishen"`); a name shared by several folders is `AMBIGUOUS` with their paths. Cost: none.
**Since v3 F7** (ADR 0070, G9) `refresh: true` (needs `folder`: `REFRESH_NEEDS_FOLDER`) reads that folder and the levels
shown LIVE first (one listing per folder; an item gone since confirmed with a `getAsset`), and the answer says so
(`refreshed: { live, requests }`); a read that fails is `REFRESH_FAILED`.

**`search`** `{ query, content?, include?, limit?, offset? }`. Syntax: words (all must match), `"quoted phrases"`, `OR`, `NOT` or a
leading `-`, `( )`, and the filters `name:` `tag:` `type:` (Reference Type, whole words) `kind:` (`index` / `bsrc` /
`bwrk` / `barc` / `unclassified`) `under:` (a page name or id; pages below it) `scope:`. `NOT` binds tightest, then `AND` (spaces), then
`OR`; `OR`, `AND` and `NOT` are operators only in capitals. A word without a filter matches the display name, aliases,
Canonical Display Name and Scope. Results are ranked exact name, name prefix, a word of the name, text inside the name,
alias or Canonical Display Name, then Scope, and each result's `matched` says why. A malformed query is `SEARCH_SYNTAX`
with `position` and an explanation. Cost: none from the tree.

**`content: true`** (v3 F3c, [ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md)) also searches page
**text** through the bridge's full-text index: free, and complete as of the newest snapshot it names (page text, sidebar
fact values, names and aliases; edits made in LegendKeeper since are not in it yet). Each term is answered as the set of
pages whose text holds it (a word matches words starting with it, a phrase exactly those words in order; case and accents
ignored), so the operators combine whole pages exactly as they combine names. Pages found only through their text are
marked (`foundBy: "page text"`, ranked after every name match, then by relevance) and carry `text` hits: document, block,
section path and a snippet with the words marked «». Every result of such a search carries `lifecycle` (Authoritative,
Working, Archived) and `branch` (the top-level index it sits under). The answer's `content` note gives the index's base full snapshot, its
newest change snapshot and their age. **Scope (decision D1)**: the Legacy Canon Archive and the Design References are left
out unless `include: ["legacy", "design"]` names them (`content.leftOut` counts what was left out). With no full snapshot
yet, only names, aliases and Scope are searched and the note says so. Discovery evidence, never proof on its own.

**`content: "live"`** runs LegendKeeper's own search for the positive words (1 read; ranked, **incomplete by nature**, no
operators): what `content: true` did before v3 F3c. The bridge applies the operators to the combined results, removes
duplicates and pages outside the root, and marks pages found only through their text (`foundBy: "page text"`, ranked after
every name match). With no words to search for (only filters), LegendKeeper is not asked. If the tree cannot answer, a
plain-text live content search still works (confined to the root by each hit's ancestry); anything with operators is
refused.

```json
{ "query": "foxian tag:elder -kind:index under:Characters", "limit": 10 }
```

**`get_resource`** `{ resource | resources, live?, detail?, confirm? }`: the page from the tree (`path`, `kind`, `documents` (id, name, type), `tags`,
`aliases`, `referenceType`, `scope`, `indexScope`, `canonicalDisplayName`, `childCount`, flags, when the tree read it)
and, from one live `getResource`, its `sidebar` in order: `facts` (key and value, with `mentions` of pages), `links`
(collections and links, each item with the page's name and, for a link to one document, `documentId` and the document's
name; `hasFilter` when LegendKeeper adds items by a filter), `text`, and any other property named with `readOnly: true`
(`unsupported: true` for what the API cannot show, such as the TAGS block). A property's `version` is included where
LegendKeeper's answer has one. With a live read it also gives **`factsVersion`** (v2 C2b): the bridge's own version of
the page's sidebar facts (the key-value rows by rank and id, and the link collections' items and filters), the same from
every read of an unchanged sidebar; pass it to `set_facts` as `baseFactsVersion`. Cost: 1 read; `live: false` makes none.

**Several pages** (v2 E3b, formerly `get_resources`): pass `resources` (up to 25 names or ids) instead of `resource`, one or the other (`RESOURCE_REQUIRED` otherwise). They run as one `batch_ops` job. Each entry is `ok`
with the same data (summarised unless `detail: "full"`, with each page's `factsVersion`) or has its own `error`. More than 10 live reads return
`{ status: "estimate", reads, wallClockSeconds, tightestTier, fitsToday }` and run only on `confirm: true`. Cost: 1 read per page.

**A character's pages (v2 E3b).** A character's facts and Scope live on its **Character Core** (or **Character Reference** for a compact character), not on its `[INDEX]`. So `get_resource` on a character's `[INDEX]` page, Working or Archived ones too, adds a `character` note naming the Core (or Reference) with its `id` and that sentence; and an `AMBIGUOUS` answer whose candidates are one character's pages lists each with its `role` (`character index`, `Character Core`, `Character Reference`) and adds the same sentence as a `hint`. Writes stay strict: a name that matches several pages is never resolved for the agent.

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
(`document.type` says which). A **map** also carries `map` (`{ image: "single", width, height, bounds, assetId }`, or why it
has none) and, with an image, each feature's position in **pixels** beside its lat/lng (see [Maps](#maps-v2-d2)); `detail:
"full"` lists every point of a long region or path (default: a pixel box). Cost: 1 read for a page or board, 2 for a map
(its settings, then its features); a timeline reads its lanes and then 100 events per read (at most 1,000 events). A long
result is a handle.

```json
{ "resource": "Asagiri Miyabi", "section": "Biography" }
```

### The guides

**`get_bridge_guide`** and **`get_markdown_guide`** `{ section? }` return [bridge-guide.md](bridge-guide.md) and
[markdown.md](markdown.md), whole or one section by heading (`"Keep regions"`, or `"A > B"`). Both are also MCP resources: `lk-bridge://guides/bridge` and `lk-bridge://guides/markdown`
(`text/markdown`). Cost: none.

**Forgiving sections (v2 E3b).** A heading is matched exactly first (case does not matter). A miss is matched loosely, and the evaluation showed why: agents guess names such as "find pages", "Promote" or a label copied from the which-tool table, and six exact-match misses wasted calls. The loose match ignores case, punctuation and spacing; counts the key words of a heading (a word found in few headings counts for more than "page" or "text"); knows a few synonyms ("promote", "promotion" and "lifecycle" lead to the page lifecycle; "find", "search" and "read" to finding and reading; "canon" and "approval", "image" and "upload", "date" and "timeline", and so on); and takes the labels of the "Which tool?" table as aliases of the section they point to. One clear match returns that section with `matched` naming the exact name to ask for next time; several return `SECTION_AMBIGUOUS` with the `candidates`; none returns `SECTION_NOT_FOUND` with `sections`, every exact section name. The bridge guide's "How to decide" lists the exact names. The code is `src/mcp/tools/guide-sections.ts`.

## Last Major Revision only for real revisions (v3 F2, v3 F3c)

[ADR 0049](adr/0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 2, narrowed by
[ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 1 (the owner, 16 November 2026:
"Tiny edits like this aren't enough for a major revision"). An edit that is a **major revision** of a page also sets the
page's `Last Major Revision` row to today on the bridge's clock (Europe/London, `YYYY-MM-DD`), **in the same job and the
same proposal** as the edit, as one more step after the content write. Agents never set it themselves.

**What is a major revision** (ADR 0051 has the exact wording):

| Counts                                                                                                                               | Does not count                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| page text: paragraphs, list items, headings or table rows added, removed or rewritten, **8 words or more** changed in the whole edit | a value trimmed to a prefix of itself, or with a descriptive tail or a parenthetical removed                     |
| a heading added, removed or reworded (any number of words)                                                                           | only punctuation, dashes, whitespace or capitalisation changed                                                   |
| a sidebar fact added, removed or changed, other than the housekeeping keys (Status, Reference Type, Last Major Revision, Supersedes) | a typo fix: at most 2 characters changed per word, in at most 3 words (a changed word with a digit is never one) |
| a page added to or removed from **Dependencies**                                                                                     | Related Sources (or any other link collection) alone                                                             |
| a chronology row added or removed, or its Date or description cell changed                                                           | a KCY-only change in a chronology row; the Main count                                                            |
|                                                                                                                                      | tags, resource aliases, the page name, a move; an empty fact added                                               |

**`lastMajorRevision`** (`"auto"` | `"set"` | `"skip"`, default `"auto"`) on `write_page`, `set_facts`, `lk_api_write`,
`lk_api_batch`, `create_timeline_event`, `update_timeline_event`, `delete_timeline_event`, `sync_timeline_event` and
`restore_snapshot`: `"auto"` lets the rule decide; `"set"` sets the row although the rule would not; `"skip"` leaves it
although the rule would set it. The answer's `lastMajorRevision` and any proposal's summary say which applied and why:

- `+ Last Major Revision → date of approval (auto: 12 words of page text changed)`
- `+ Last Major Revision → date of approval (set: lastMajorRevision "set" was asked)`
- `Last Major Revision skipped: Subject: a trimmed value, not a major revision`
- `Last Major Revision skipped: lastMajorRevision "skip" was asked`
- after a job: `Last Major Revision set to 2026-11-16 (auto: Subject: a fact changed)`, or
  `Last Major Revision not set: 1 word of page text changed (fewer than 8), not a major revision`

**The per-project switches** (Projects page) still say which kinds of write are considered at all; a switched-off one
never sets it under `"auto"`:

| On by default                                                                                                                                                           | Off by default (the rule never counts these; switched on, they count as in F2)   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `write_page`, any mode (`lmrWritePage`)                                                                                                                                 | tag, alias, icon or name changes; moves and re-orders (`lmrNamesTagsMoves`)      |
| block edits through `lk_api_write` / `lk_api_batch`: insert, replace, update, delete a block, `replaceDocumentBlocks`; the dashboard's own text fixes (`lmrBlockEdits`) | link collections other than Dependencies: Related Sources (`lmrLinkCollections`) |
| a chronology table's rows (`create_` / `update_` / `delete_timeline_event` on the table) and the count fix (`lmrChronologyTable`)                                       | timeline events and map features on their own (`lmrTimelineMap`)                 |
| a restore that changes text (`lmrRestore`)                                                                                                                              | an audit's paragraph split (`lmrAuditSplit`)                                     |
| setting-pack tools (`lmrPackTools`; since v3 F3b the existing pages a package changes go through the rule, pages it makes are always dated)                             |                                                                                  |
| `set_facts` facts and Dependencies, except the housekeeping keys (`lmrFacts`; `lmrHousekeepingKeys`, default `Last Major Revision; Reference Type; Supersedes; Status`) |                                                                                  |

- **When it is measured.** When the edit is planned, from what the calling tool already read (`write_page`'s blocks,
  `set_facts`' sidebar, a chronology row's cells): no extra read, and an edit that is not a major revision gets no
  steps at all. A block write whose old text the request did not hold (`lk_api_write`, `lk_api_batch`, a restore, the
  dashboard's fixes) is measured when the job runs, from its journal pre-image; the proposal says `(auto: if the edit is
a major revision, measured when it runs)`. A raw `updateBlock` keeps no pre-image and counts.
- **How it is set.** A `bridge.lmr` decision step, then `updatePropertyRow` of the row. The date is worked out when the
  job runs (a proposal: the day it is approved and applied). Its own If-Match: chained on the edit's own row write's
  version or ETag (`useEtagVersions`) when there is one (`set_facts`), otherwise the version one read of the rows gives
  inside the job.
- **Only on pages with the row** (the repository tree's sidebar says where it is; indexes and AI REPOSITORY tabs usually
  have none and are skipped silently, with no request). Already today: nothing is written. The lifecycle tools set it
  themselves, as before; a restore rehearsal never does; a page created in the same request is left alone.
- **Never blocks the edit.** If the date cannot be written after the content was, the job still succeeds and records a
  follow-up (`followUps: [{ kind: "lmr_failed", … }]` in its result, and an error row); the content stays written.
- It applies to every agent and to the dashboard's own fixes, at any scope. It is not a canon-protected fact.

**A direct `updateBlock` (v3 F3.4, ADR 0055 decision E).** At scope `write` an `updateBlock` that carries its own
If-Match made no read, so the rule had no "before" and counted it a major revision. When the page has a Last Major
Revision row and the mode is `auto`, the block is now read first (one read; it is also the write's journal pre-image),
so a typo fix is measured as minor.

## Writing pages: `write_page` (v2 C1)

The main way agents change the owner's pages: Markdown in the owner's schema ([markdown.md](markdown.md)), turned into
LegendKeeper blocks by B1's converter, written as ONE `replaceDocumentBlocks` under the document's lock, and read back
to check it. Design: [ADR 0031](adr/0031-write-page.md). The agent guide's "Writing pages" section
([bridge-guide.md](bridge-guide.md)) is the short version.

Last Major Revision: a `write_page` edit that is a major revision (8 words or more, or a heading's wording) sets it, in the
same job or proposal; `lastMajorRevision` overrides ([above](#last-major-revision-only-for-real-revisions-v3-f2-v3-f3c)).

**`write_page`** `{ page, document?, mode, section?, markdown, baseVersion?, dropRegions?, dryRun?, detail?, lastMajorRevision?, plainEdit?, project }`:
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

**Block by block (v2 E4, [ADR 0046](adr/0046-e4-owner-decisions.md) decision 1).** A page holding content LegendKeeper's
write schema would not take back (text with an inline icon) cannot be written back whole, so `write_page` writes only the
blocks the edit changes, one by one: `insertBlock` for new blocks (each placed after its nearest earlier sibling that is
already there), then `replaceBlock` for changed ones, then `deleteBlock` for removed ones, so a stop part-way never loses
text. It is ONE job (or one proposal) holding the document's lock: the page must be exactly as planned inside the lock
(compared by content), each write's If-Match is chained from the write before (a delete's from its `ETag`), each replace
and delete keeps its pre-image in the journal, and the whole page is verified at the end. The plan is replayed on a copy
first and must give the edit exactly. The answer carries `blockwise` (`writes`, `inserts`, `replaces`, `deletes`) and the
new `version`. Refused (`PAGE_NOT_WRITABLE`, with `reason`): an edit that changes, removes or re-sends the icon paragraph
itself (`unwritable`), moves blocks (`moved`), would delete an `unsupported` block (`unsupported`), needs more than 200
writes (`too_many`), or meets a legacy page without block ids (`ids`). **A write that stops part-way is undone** by the
bridge (the system principal, at P1) from the job's own record, but only when the page is exactly as the stopped job left
it; the answer's `undo` says what happened (`succeeded`, `stale` when the page changed since: nothing is undone, the
journal holds every block as it was). Removing the icon paragraph on purpose with `dropRegions` is C1's deliberate
deletion and writes the page whole. Cost: 1 plan read, the in-lock read, 1 read per replace or delete, the writes, and the
verify read.

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
(above), `WRONG_TOOL_FOR_DOCUMENT`, `PAGE_NOT_WRITABLE` (v2 E4: the page holds blocks LegendKeeper's write schema
would not take back, such as text with an inline icon, and this edit would change, remove, move or re-send one of them,
or delete an `unsupported` block; `reason` says which, and `blocks` lists them. Any other edit of such a page is written
block by block: see below), `INVALID_PARAMS` (a section mode without `section`, or a whole-page mode with one),
`USE_ARKONA_SPLIT` (v3 F3e, [below](#setting-packs-splits-v3-f3e)), and the name and tree codes of the read tools
(`NOT_FOUND`, `NOT_IN_REPOSITORY`, `AMBIGUOUS`, `DOCUMENT_NOT_FOUND`, `TREE_NOT_READY`).

**At scope `propose`** (or whenever policy turns the write into a proposal) the same plan is captured as ONE proposal
that holds the **high-level operation** (page, document, mode, section, the Markdown, `baseVersion`) and its planned
expansion (the new block tree, pinned to the version it was built on). The capture reuses the plan's read. The
dashboard shows the page's Markdown before and after as a line diff (keep regions as labelled placeholders) beside the
block diff. On approval the usual re-read applies: if the version changed since capture the proposal becomes
**conflicted** (no re-planning: the owner approves exactly what they saw); otherwise the stored expansion runs through
the same lock, compare-and-swap and verify, with `approvedBy: "owner"`. A change between the approval's re-read and
the write is caught by the compare-and-swap, and the proposal becomes conflicted too. A `dryRun` never captures.

### Visibility of the low-level tools

Each profile has **show low-level and rarely used tools** (default off; called "show low-level tools" before v2 E3b, and the setting, its column and its audit action `profile.set_low_level_tools` are unchanged), edited on the dashboard's Clients & Access page and audited. When off, `tools/list` leaves out `lk_api_list_operations`, `lk_api_describe_operation`,
`lk_api_paginate_all`, every `lk_op_*`, and (v2 E3b) `lk_upload_image` and `create_bare_resource`. `lk_api_read`, `lk_api_write` and `lk_api_batch` stay.
**Hiding changes the list, nothing else:** a hidden tool is still refused or allowed at call time by the profile's scope
and the engine's guards exactly as before. The change applies at the next `tools/list`; ChatGPT needs a tool refresh
(Plugins, the bridge, Refresh).

The tools a profile sees:

| Setting | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| off     | the 12 above, `write_page` (v2 C1), `set_facts` (v2 C2a), the 12 Resources, Documents and character tools (v2 C2b), the 4 lifecycle tools (v2 C2c), `calendar_date` and the 5 timeline tools (v2 D1 and D1.1), `upload_image` and `prepare_image_upload` (v2 D3), `list_projects`, `lk_api_read`, `lk_api_write`, `lk_api_batch` and the `bridge_*` tools. **Since v2 E3b: 56 tools for a profile with scope `propose` or `write`, 25 for a `read` profile** (61 and 28 before: `get_resources`, `bridge_proposals_mine` and `bridge_job_wait` are merged into their siblings, and `lk_upload_image` and `create_bare_resource` are hidden). **Since v3 F3a: 57 for `propose` or `write`** while the bridge serves a project with a setting pack attached (the pack's `arkona_create_character`; a pack tool is never listed otherwise). **Since v3 F3b: 61 for `propose` or `write`, 26 for `read`** with the Arkona pack attached (its five tools; `arkona_character_brief` is a read tool). **Since v3 F3c: 66 for `propose` or `write`, 30 for `read`** (its ten tools; the four appraisal reports are read tools, `arkona_appraisal_fix` a write tool). **Since v3 F3d: 68 for `propose` or `write`, 30 for `read`** (`arkona_rename` and `bridge_job_resume`, both write tools). **Since v3 F3e: 70 for `propose` or `write`, 31 for `read`** (`arkona_split_owner`, a write tool, and `arkona_split_appraisal`, a read tool). A `read` profile does not see the write tools |
| on      | all of those, plus `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, `lk_upload_image`, `create_bare_resource` (61 for `propose` or `write`, 28 for `read`: 56 + 5, 25 + 3; with the Arkona pack attached 66 and 29 since v3 F3b, 62 with F3a's one tool), and with `MCP_EXPOSE_PER_OP_TOOLS=true` the 89 `lk_op_*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Facts and links: `set_facts` (v2 C2a)

Changes a page's sidebar **facts** (the key-value rows of its `PROPERTIES` property) and its relationship **links** (the
link collections, such as Dependencies and Related Sources), as ONE job under the page's lock, checked inside the
lock, chained version by version, and read back. Design: [ADR 0032](adr/0032-set-facts-and-canon.md). Last Major
Revision: a fact really changed (not trimmed, punctuated or typo-fixed), or a Dependency added or removed, sets it
(chained on the job's own row write), except the housekeeping keys
([above](#last-major-revision-only-for-real-revisions-v3-f2-v3-f3c)). The agent
guide's "Editing facts and links" and "Canon and approval" sections ([bridge-guide.md](bridge-guide.md)) are the short
version.

**`set_facts`** `{ page, facts?, links?, property?, baseFactsVersion?, dryRun?, lastMajorRevision?, project }`: `access: write`, annotations
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

**Versions from the ETag (v2 D1.1, [ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md)).** LegendKeeper
answers a row write with no version in its body but with an `ETag` header (a delete answering 204 sends one too), so
the bridge uses that ETag as the write's new version for the next chained If-Match, and a chained row write no longer
reads the property inside the lock. Measured: changing two facts costs 4 reads and 2 writes with it, 6 without; a
change, a change, an addition and a removal 6 reads against 10, with the same 4 writes. A removal reads its row for the
journal pre-image either way. With neither a body version nor an ETag the bridge re-reads (the safe fallback). The
project setting `useEtagVersions` (default on; Projects page) switches it off without a deploy if the sandbox's B12
check ever fails.

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

**`create_bare_resource`** `{ name, parent?, status?, tags?, aliases?, dryRun?, operation_id?, project }` (a rarely used tool, v2 E3b: listed only with the profile's “show low-level and rarely used tools”, callable always): a page
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
  To add specialist pages to a Working Core, call `create_resource` (Working) with `parent` = the character's index
  (v2 C2d.1), one page at a time; `promote_page` with `subtree` then takes the whole set.
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
shape?, size? }, banner?: { url?, yPosition?, enabled? }, hidden?, locked?, plainRename?: { reason }, dryRun?, project }`:
one read of the page, then one `updateResource` (and, after a rename that changes the page's place, one `moveResource`
among the same siblings), under the page's lock, journalled with the page as it was. A rename keeps the page's prefix
(`PREFIX_CHANGE` for a name with another prefix; never a reclassification) and refuses a sibling's name (`NAME_TAKEN`).
Tags and aliases are compared without case. An unchanged request sends nothing (`no_change`).

**`USE_ARKONA_RENAME`** (ADR 0058 amendment C). On a project with an approved setting pack, a rename that changes the
**subject** part of a page's name (the text before " - ", or the whole name of an index) is refused, with nothing sent,
for a page of a character's set, a page with a Subject fact, or a pack owner (a page tagged with an owner type's primary
tag). The refusal's `hint` names `arkona_rename`, which renames the subject everywhere it is referred to (its set, its
identity facts and aliases, routing lines, chronology, art and every restatement), as one proposal the owner approves item
by item. Renaming only the descriptor (after " - ") is never refused. **`plainRename: { reason }`** (3 to 500
characters) lets such a rename through, for a genuinely plain rename (a typo): the reason is shown with the proposal (its
summary and operation) or, for a direct write, on the Review page (the job's title) and in the journal entry. The same
refusal and the same `plainRename` apply to `updateResource` through `lk_api_write`, `lk_op_updateResource` and each call
of `lk_api_batch` (a refused call refuses the whole batch, `callIndex` naming it). `update_resource` judges a Subject fact
on the page as it reads it; the low-level routes on the sidebar the bridge's tree holds, and (CR-2026-11-R3, R3-58) when
the tree has not read it yet (a page made or changed since its last properties pass) and the answer turns on it, they read
the page live once (`getResource`, in the calling tool's name and counted in its cost; `lk_api_batch` reads each page
once, before anything is queued), and the guards and a captured proposal use that read rather than read again. A page
that cannot be read is answered as `update_resource` answers it: the read's error, and nothing sent.

**`move_resource`** `{ page, to, dryRun?, project }`: the page and everything under it, to a new parent index inside
the repository, in its alphabetical place there (one `moveResource`, journalled with the page as it was).
`MOVE_CYCLE` for a move under itself or a descendant; `NOT_IN_REPOSITORY` for a destination outside; `NAME_TAKEN` for a
sibling of the same kind and name there. A move into or out of Narratives is a proposal at every scope (canonical when a
page of the subtree carries a lifecycle signal; see "Narrative pages" under the Arkona fiction tools).

**Moves within a lifecycle area** (v2 C2d.1, decided by the owner on 12 November 2026) are ordinary moves: no lifecycle
change, no canonical approval, and the page's prefix, Status and tags never change. **Working:** a `[BWRK]` page (or a
Working set's `[INDEX]`, which moves with its pages) between `[INDEX] Working` and an `[INDEX]` inside a Working set, and
back. **Archived:** a `[BARC]` page, or an archived set's `[INDEX]` together with its pages, between `[INDEX] Archived`
and an `[INDEX]` inside an archived set, and back. The destination must be an `[INDEX]` (`PARENT_NOT_INDEX` for a page).
The lifecycle guard (unchanged) still refuses a move into or out of either area, and between the two (`POLICY_DENIED`,
naming `archive_page`, `unarchive_page`, `move_to_working` or `promote_page`). A move writes no lifecycle record: each
page's record keeps its original previous place, so `unarchive_page` (single or `subtree`) returns it to where it came
from, not to where it was moved within the archive. (A Working page archived from a Working set's index and then
unarchived also returns to that index when it still exists, else to `[INDEX] Working`.)

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
document's settings only, never its content. Page documents are refused (`DOCUMENT_IS_PAGE`: use `write_page`), and so is
a blank document unless it is given a `mapImage` (it then becomes a map, v2 D2). Only what changes is sent. `mapImage` is an
image asset by **id or name** (`{ assetId }` also works; a name matching several assets is `ASSET_AMBIGUOUS` with each
candidate and its folder): see [Maps](#maps-v2-d2).

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

- **`working`**: `[BWRK] {name}` under `[INDEX] Working` (alphabetical), Status `Working`, the `Working` tag added and
  `CANON` removed. Leave `parent` out (the default), or give `[INDEX] Working` itself, or (C2d.1) an `[INDEX]` page
  inside a Working set: a Working character's own index, or any index within a Working set kept together. The page is
  placed alphabetically among that index's children. Any other parent is `WORKING_PARENT`, naming the allowed ones
  (`allowedParents`); nothing goes under a `[BWRK]` page. A Working character is built by `create_character` (Working),
  then `create_resource` (Working) with `parent` = the character's index, one page at a time.
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
- **`create_many_resources`**: a Working item's parent follows the same rule as a single create (`[INDEX] Working`, left
  out, or an `[INDEX]` inside a Working set); nothing goes under a Working item (`WORKING_PARENT`: no `parent_key` under
  a `[BWRK]` item). A
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

**Where the tags go (v3 F3d, [ADR 0053](adr/0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md)).**
By default (`append`, ADR 0035) the outgoing status or lifecycle tag is removed and the incoming one added **last**;
every other tag stays where it is. On a project whose approved setting pack says the lifecycle tag leads
(`lifecycleTagPosition`: Arkona), the incoming tag goes **first** and every other tag keeps its order after it:
`move_to_working` `Culture, CANON, Language` → `Working, Culture, Language`; `archive_page` `Magic, CANON` →
`Archived, Magic`; `promote_page` `Working, Culture` → `CANON, Culture`; `unarchive_page` puts what its target needs where
`Archived` was, first. **The status tag** of an Authoritative page is `CANON`, or `AU` for a page whose Continuity Type
is AU on a project whose approved pack carries the owner's AU ruling (Arkona): `promote_page` and `unarchive_page` (back
to Authoritative) write that one, and `move_to_working` and `archive_page` remove either. Both rules hold for whole sets
(an index, with no Continuity Type, takes `CANON`).

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
- **tags**: the outgoing status tag (`CANON`, `AU` under the AU ruling, or `Working`) removed and `Archived` added
  (last, or first where the pack says the lifecycle tag leads); other tags untouched.

**`unarchive_page`** `{ page, destination?, previousState?, restore?, dryRun?, project }`: reverses an archiving
**from its lifecycle record**. A formerly Authoritative page goes back under its previous parent (alphabetical) as
`[BSRC]`, with its recorded Status, Continuity Type, Scope and Temporal Scope and the `CANON` tag (`AU` for an AU page
under the AU ruling; first where the lifecycle tag leads); a formerly Working
page goes back under `[INDEX] Working` as `[BWRK]` with Status `Working`, the `Working` tag and its other recorded
values. Last Major Revision becomes today (a recorded fact that was absent is removed again). The archive note is
removed **only if it is still exactly as inserted**; otherwise it stays and the result flags it. A Scope edited since
archiving is flagged (the recorded original is restored). When the previous parent has gone, is outside the repository
or is in a lifecycle area, give `destination` (`DESTINATION_REQUIRED` otherwise). A page **archived by hand** has no
record: give `previousState`, `restore: { continuityType, scope, temporalScope, status? }` and (for an Authoritative
page) `destination`; without them the call is refused with `NO_LIFECYCLE_RECORD`, naming what is missing. Refused for
anything but a `[BARC]` page (`NOT_ARCHIVED`).

**`move_to_working`** `{ page, dryRun?, project }`: an Authoritative `[BSRC]` page becomes `[BWRK]` directly under
`[INDEX] Working`, Status `Working`, the status tag (`CANON`, or `AU`) swapped for `Working` (first where the lifecycle
tag leads). Nothing else changes; the record keeps where it was.
Only from `[BSRC]` (`NOT_AUTHORITATIVE`). A Character Core under its own character index moves **alone** (the index and
its other pages stay; the result flags it, and `promote_page` takes it back).

**`promote_page`** `{ page, destination, dryRun?, project }`: a Working `[BWRK]` page becomes `[BSRC]` under
`destination` (required; alphabetical), Status `Authoritative`, Last Major Revision today, Continuity Type kept when
`CANON` or `AU` and otherwise set to `CANON`, `Working` swapped for `CANON` (for an AU page `AU`, under the AU ruling;
first where the lifecycle tag leads). Without `destination` it is refused with
`DESTINATION_REQUIRED` and, when the page came from `move_to_working`, `suggestedDestination`: the place it was in
(never used unless you pass it). A Working character's Core (or compact page) under its own `[INDEX] {name}` takes
that index with it to the destination (normally its race index). v2 E4 ([ADR 0046](adr/0046-e4-owner-decisions.md)
decision 2): when any other page is under that index, at any depth, promoting the Core alone is refused
(`SET_HAS_OTHER_PAGES`, naming them): promote the set with `subtree: true` on the index, or move the pages out first; the
job also checks inside the lock that the index still holds only the Core, so a page added since makes the proposal
`conflicted`. Only from `[BWRK]` (`NOT_WORKING`); a destination in a lifecycle area is refused (`LIFECYCLE_AREA`).

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
- a move into, out of or between the lifecycle indexes, and a page created under one by hand;
- C2d (ADR 0036 decision 7): adding or removing a status tag (`CANON`, `Working`, `Archived`; see below).

Only the four tools' own steps pass, through a marker only bridge code can set (an agent's request body can never carry
it); approved work that should carry it and does not is refused when it runs. Even at scope `propose` these routes are
refused, not proposed.

### Costs (reads and writes, typical)

Measured against the mock LegendKeeper (test/lifecycle/costs.test.ts), every read included: to capture the proposal
(planning, the note's place, the content search), then the job the owner's acceptance runs (its checks, the canon and
lifecycle guards' reads, the in-lock reads before each write, the verify step and the tree's re-read). CR-2026-11 took
4 reads off every job without dropping a check: the guards' entry reads of the sidebar now use the approval's re-read of
the page, made a moment before, and the tree re-reads the page once when the job ends rather than after the rename and
the move as well. **D1.1** (the ETag as the next write's version, above) takes a further 4 reads off `archive_page`
and 3 off `unarchive_page` (and so off their Working forms), 2 off `promote_page` and none off `move_to_working`; the
numbers below are measured with it (test/lifecycle/etag-costs.test.ts compares the three ways a version can arrive).

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

## Whole sets, guarded tags and approval scope (v2 C2d)

Decided by the owner on 11 November 2026 ([ADR 0037](adr/0037-whole-set-lifecycle-and-page-scoped-ids.md),
[ADR 0036](adr/0036-cr-2026-11-owner-decisions.md) decisions 4, 5 and 7).

### Whole sets: `subtree: true`

All four lifecycle tools take **`subtree: true`**: the page and every page beneath it change together, as **one
canonical proposal** (the only approval is "Approve and accept as canon"). The main case is a character: its
`[INDEX] {name}` with its Core and specialist pages.

- **`archive_page`** `{ page, subtree: true, dryRun?, project }`: the set's root moves under `[INDEX] Archived`.
- **`unarchive_page`** `{ page, subtree: true, destination?, dryRun?, project }`: every page returns to its own previous
  state from its record; the root goes back to its previous parent, which must still exist (otherwise `destination` is
  required). `previousState` and `restore` are for one hand-archived page only (refused with `subtree`).
- **`move_to_working`** `{ page, subtree: true, dryRun?, project }`: an Authoritative set's root moves under
  `[INDEX] Working`. Lists `outsiders` as `promote_page` does (C2d.2): same-subject Working pages flat under
  `[INDEX] Working` stay apart from the set; bring them in with `move_resource` once it is Working.
- **`promote_page`** `{ page, subtree: true, destination, dryRun?, project }`: a Working set's root moves to `destination`
  (required); without it, `DESTINATION_REQUIRED` offers the place `move_to_working` remembered (`suggestedDestination`).
  **Outsiders (C2d.1):** the plan (and so the dry run) lists under `outsiders` any `[BWRK]` page of the same subject
  (`subjectOf`: a Subject row, else the name before " - "; the set root's own name for a plain index) that sits flat
  directly under `[INDEX] Working` outside the set, with a `suggestion` to bring each in with `move_resource` first, and
  a flag in the proposal, so the owner does not approve a partial promotion by accident. Nothing is moved for you.
  **`archive_page` with `subtree: true` lists the same `outsiders` (C2d.2)**: archiving a Working character would leave its
  flat specialist pages Working, behind it. Move them in first with `move_resource`; for an Authoritative set, which a
  Working page cannot be moved into, archive each with `archive_page` as well. `unarchive_page` lists none.

**Layout: the set stays together.** Its root moves as a group, placed alphabetically among its new parent's children;
the structure beneath it is unchanged (`[INDEX] Archived / [INDEX] Asagiri Miyabi / [BARC] Asagiri Miyabi - Character
Core …`). This is the one exception to the lifecycle indexes being flat.

**Each page.** A content page gets exactly the single-page treatment, by its own previous state (note variant, facts,
Scope prefix, Temporal Scope variant, tags, Last Major Revision, the Continuity Type rule on promotion). An `[INDEX]`
page stays `[INDEX]`, gets no Status and keeps its facts; its status tag changes (`CANON`/`Working` → `Archived` on
archive and back on unarchive, `CANON` → `Working`, `Working` → `CANON`); archiving gives it a short note as its first
block (the lifecycle setting “Note on an index archived with its set”, default "Archived - {date}. The author retired
{source} and the pages beneath it. They are kept for provenance."), removed again on unarchive if unchanged.

**What a set may hold**, else `SET_NOT_ELIGIBLE` with every page that cannot be part of it and why: content pages in the
expected state (`[BSRC]` or `[BWRK]` for `archive_page`, one state for the whole set; `[BSRC]` for `move_to_working`;
`[BWRK]` for `promote_page`; `[BARC]` archived with this set for `unarchive_page`) and `[INDEX]` pages. Refused: an
unclassified page, a lifecycle-inconsistent page, either lifecycle index, a page in another state, a set mixing
Authoritative and Working pages, a page whose own change stopped part-way, a page with no page document (archiving), a
set not where its state says. At most **100 pages** (`SET_TOO_LARGE`). A page the tree has not seen yet:
`SET_NOT_IN_TREE` (try after the next sweep).

**The result** (and the dry run): `set` (root, pages, content pages, indexes, from, to, new parent, place), `pages`
(each page's new name, move, changed facts, tags, note), `estimate` (the page count and `bridge_estimate`'s reading of
the job's reads and writes), `flags`, and for `archive_page` and `move_to_working` `relatedPages` (for every page, the
pages that link to or mention it, links between pages of the set left out).

**Running it.** One job holds every page's lock in sorted order. Leaving the current state (archive, move to Working):
every rename and status tag first, then the facts, the notes, the root's move last; entering it (unarchive, promote): the
root's move first, then the facts and notes, the renames and tags last. The job's first step checks the whole set as
captured (pages, parents, names, tags); the approval checks the pages first too. A page added, removed or moved since the
proposal: the proposal ends `conflicted`, nothing written.

**Stopping part-way.** The set record (and each page's record, linked to it) stays `incomplete`; call the same tool
again with `subtree: true` on the root to resume: only what is left is proposed (`resumes: { setId }`). Until then,
another lifecycle tool on the root, or any lifecycle tool on one of its pages, is refused (`LIFECYCLE_INCOMPLETE`).

**Single pages in a set** keep C2c's behaviour (archiving, moving or promoting one page takes it out of the set). A page
unarchived alone from inside an archived set needs `destination` (its previous parent is inside the archive).

**Costs** (measured against the mock, `test/lifecycle/sets.test.ts`): `archive_page` with `subtree` on a 4-page set (2
indexes, 2 content pages) 20 reads to plan, then 50 reads and 19 writes; on a 10-page set (2 indexes, 8 content pages)
56 reads to plan, then 134 reads and 61 writes. About 5–6 planning reads per page; per content page about 13 job reads
and 6 writes (rename and tag, 5 facts, note); per index about 3–4 reads and 2 writes (tag, note); plus the root's move.

### The status tags are the lifecycle tools'

`CANON`, `Working` and `Archived` (as the lifecycle settings name them; compared without case, and look-alikes such as
`ＣＡＮＯＮ`, a Cyrillic `С` or a zero-width space caught) are added or removed only by the four lifecycle tools and by
the creation tools according to their `status`. `update_resource`, `updateResource` through `lk_api_write`,
`lk_api_batch` or `lk_op_updateResource`, and a create body that adds one are refused (`POLICY_DENIED`), naming the tool
to use (`move_to_working or archive_page` to take `CANON` off, `promote_page` to add it, …). Every other tag stays free;
a status tag already on a page is kept when other tags change. A per-project canon rule (`status-tags`), on by default,
switchable on the dashboard.

### An approval covers only the pages it listed

At execution, a proposal that would touch a page not in its captured list does not run: it becomes `conflicted`. Pages
captured but now gone conflict too. The pages an operation touches without naming them are listed when the proposal is
captured and again at approval and inside the lock: a cascade `deleteResource` (`delete_resource` with `cascade`, or
`lk_api_*`), a template copied with its children, and a whole lifecycle set. Any tool. A cascade over more than 500
pages is refused at capture (delete it in parts).

### Ids below a page; line breaks in row values

- Copies of one template share their property, row and item ids with the template and each other (LegendKeeper reuses
  them). `bridge_journal_lookup`'s `targetId` therefore matches such an id only with its page (`resourceId`); without
  one, only page and document targets match. `factsVersion` is now `fv2_…`, unique to its page (a version from before
  the upgrade, or one read on another page, is a `VERSION_CONFLICT`).
- LegendKeeper trims a leading or trailing line break from a row value, so the bridge does too before planning: a value
  with a trailing new line (plain) or `<br>` (Markdown) is written, verified and remembered without it; a value of only
  line breaks clears the row (as an empty value does).

## Setting packs: `arkona_create_character` (v3 F3a)

A **setting pack** is one world's rules held by the bridge as data (the `packs` table): its types (Character first), each
type's page roles, names, templates, sidebar facts and placement, its closed tag grammar with the token maps, its text
rules, and the governance pages they were taken from. The owner approves a pack version on the dashboard's **Packs**
page ([dashboard.md](dashboard.md#packs-v3-f3a)); the approval records each governance page's document version, and a
changed page (or rules edited since) stops the pack's tools until the owner approves again. Design:
[ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md), [packs.md](packs.md) and the owner-approved
[character pack design](design/F3-character-pack.md). The agent guide's section is "Setting packs (Arkona)", its part
"Arkona characters" (v3 F3b gave the section a part per tool).

A pack's tools carry its prefix (`arkona_`) and are listed only while the pack is attached to a project the bridge
serves (the list changes at the next `tools/list` when that changes); called for any other project they answer
`PACK_NOT_ATTACHED` with the projects they work on. Each writing tool has a switch in the pack's data (v3 F3.4,
[ADR 0055](adr/0055-write-scope-review-revert-rails.md) decision D), set on the Packs page: **always propose** (every
call is **one proposal** for the owner, whatever the connection's scope) or **follow the scope** (at scope `write` it
runs, and the owner reviews it afterwards). The seed's defaults: `arkona_create_character`, `arkona_create_owner` and
`arkona_create_relationship` always propose; `arkona_add_character_art` follows the scope. A tool with no switch keeps
the pack's `alwaysPropose`. A package that makes canon is a canonical proposal ("Approve and accept as canon") either
way.

**`arkona_create_character`** `{ name, depth?, status?, identity, pages, index?, target?, upgradeToCore?, lastMajorRevision?, dryRun?, preview?, operation_id?, project }`:
a whole character from one package, by Arkona's Character Architecture, Source Formatting and Controlled Native
Tagging Standard (v1.8).

- `depth`: `"compact"` (one `{name} - Character Reference` from the Compact template, directly under the race index,
  with an index only when the package brings a sibling page) or `"developed"` (an `[INDEX] {name}` from the index
  template, with a `{name} - Character Core`). Left out, it follows the identity page given.
- `status`: `"working"` (the default for a new character: `[BWRK]` pages, the set under `[INDEX] Working`, Status
  `Working`, the `Working` tag and no CANON) or `"authoritative"` (`[BSRC]` pages in the race's place, Status
  `Authoritative`, `CANON`; a canonical proposal). With `target`, the default is the existing character's standing.
- `identity`: `givenName`, `surname`, `race`, `namingCulture`, `lifeState`, `temporalScope` (the completion gate: each
  required for a new character, never blank or a placeholder), and `subject`, `canonicalDisplayName`, `aliases`,
  `supersedes`. Each is a string or `{ value, reason? }`; `"Unestablished"` needs a `reason`, which is written into the
  identity page's Unresolved Material.
- `pages` (up to 30): `{ role, scope?, markdown, dependencies?, related?, … }`, only the domains with real content.
  `core` or `compact` is the identity page (exactly one for a new character); `specialist` takes `title` (the page is
  `{name} - {title}`), `referenceType` (suggested from the title when left out, or refused with suggestions:
  `REFERENCE_TYPE_REQUIRED`) and at most one `specialistTag` from the closed list; `art` takes `images`
  (`{ staged_id, label, interpretation, subfolder? }`, from `upload_image` with `stage: true`); `relationship` takes
  `with`, `label` (default `Relationship`) and `host` (`self`, the default, or `other`). The text is converted as
  `write_page` converts it.
- `index`: `{ markdown }`, the index text. Left out, a minimal one is drafted (Purpose, How to Use This Index with a
  line per page from its name and Scope, the template's Subpages collection, Index Boundaries) and shown in the preview.
- `target`: an existing character (its id, name, an alias or its Canonical Display Name; an index, Core or Compact
  Reference) to add pages to; `upgradeToCore: true` with a Compact Reference renames it to its Character Core (its text,
  id and rows kept, Reference Type `Character Core`, the Core template recorded). `split` is refused (`MONOLITH_SPLIT_UNSUPPORTED`): splitting an
  existing page is a later tool.
- `dryRun: true` (or `preview: true`): the whole preview, nothing written or proposed. `operation_id` as for every
  create tool.

**What it builds.** Only the pages given, plus the index when one is wanted; each from its role's template (the pack's
template ids for the project, checked against the project's templates as last read); named by its role's rule
(`{name} - Character Core`, `{name} - Character Reference`, `{name} - {title}`, `{name} - Character Art`,
`{A} & {B} - {label}`); placed by the race (the registry's Character taxonomy, falling back to
`[INDEX] Undetermined / Unknown` with `RACE_FALLBACK`), in its alphabetical place in the same write. The sidebar is filled
in the template's order and never gains or loses a row: the fixed facts (Continuity Type `CANON`, Continuity `Main`,
Inheritance `None`, unless an existing character's standing says otherwise), Status, Subject, Reference Type, Scope,
the identity facts on the identity page, Supersedes `None` unless given, and **Last Major Revision set to the day the job
runs** (a `bridge.lmr` step, as F2's; on an existing page the package changes, since v3 F3b only when ADR 0051's rule or
the package's `lastMajorRevision` says so, and while the project's `lmrPackTools` switch is on, its default; the preview
notes it when off). Tags are
**computed**, never typed: `{status tag}, Character, {race token}, {naming culture token}` on the identity page (one
token when they are the same), `{status tag}, Character, {specialist tag}` on a specialist page,
`{status tag}, Character, Character Art` and `{status tag}, Character, Relationship`; a race or culture with no approved
token leaves its slot out and is reported (`heldTags`); `Unknown`, `Unestablished` and `None` are never tags; an index has
none. Dependencies and Related Sources are resolved to exact pages (a CANON page links only current `[BSRC]` pages). A
relationship is added to both participants' Related Sources (for a Working relationship, a canon partner's link is
left until the set is promoted: `PARTNER_LINK_DEFERRED` says to add it then with `set_facts`). Images are placed
from the bridge's staging (v3 F2) into the character's asset folder, which mirrors the race path
(`Assets › Characters › … › {name}`, then `Forms`, `Outfits` or `Details`), named `{Subject} - {Label}`, found or
created folder by folder, and shown in the Art page's "Reference Images" section.

**Text rules.** An em dash or en dash used as a separator in a name, heading or text is replaced by an ASCII hyphen, and
each replacement is listed (`replacements`, with where it was). A page name with `CANON` or a date in it is refused
(`NAME_HAS_FORBIDDEN_WORD`, `NAME_HAS_DATE`). A page's text starts with `## Purpose` (`PURPOSE_NOT_FIRST`), repeats no
title (`BODY_REPEATS_TITLE`) and has no metadata header (`BODY_HAS_METADATA_HEADER`), no empty section (`EMPTY_SECTION`)
and no placeholder section (`PLACEHOLDER_SECTION`). A missing Source Boundaries or Unresolved Material on a Core,
Reference or Relationship page is a warning (`SECTION_MISSING`), as is a large biography, personality, powers, wardrobe
or physical block in a Core (`CORE_OVERLOADED`, suggesting a specialist page).

**The preview** (a dry run, and every refusal) has `pack`, `packVersion`, `type`, `subject`, `mode` (`new` or
`extend`), `lifecycleStatus`, `target`, `governance` (each source's approved and current version), `tree` (each page with
its parent and its `after` / `before` neighbours), `pages` (each with its template, facts, `lastMajorRevision`, tags,
Dependencies, Related Sources, the shape of its text, the drafted `indexText`, its images), `existing` (the changes to
existing pages: a move, a rename, facts, routing lines), `assets` (each image's name and folder, the folders it
creates), `replacements`, `heldTags`, `refusals`, `warnings`, `notes`, and the job's `steps` and `writes`. A refusal
returns the first refusal's code with every refusal listed and the preview so far.

**The job.** One job (or one proposal, approved as one): first a check in the lock that the pack's governance is still
as approved (`PACK_GOVERNANCE_CHANGED` otherwise, before any write), that the character was not made by another request
since the plan (each place listed live and the tree asked by name: `CHARACTER_EXISTS`, or `DOMAIN_EXISTS` for a page
of an existing character), and that each existing page it changes is as planned; then per page the copy, its text (the
template's collection block kept), its tags, its rows and its Last Major Revision; the moves and renames of existing
pages; the images; the verify. **The verify** reads back each page's place, the six identity fields one by one, the tags
in order, every template row (none missing, none added), each link, the text, and each image's bytes (SHA-256) and
block; a difference is recorded on the job and the proposal.

**Refusals.** Setup: `PACK_NOT_ATTACHED`, `PACK_NOT_CURRENT` (with the governance state: `unapproved`, `changed`,
`rules_changed`, `unreadable`), `PACK_TEMPLATE_UNSET`, `PACK_TEMPLATE_UNKNOWN`, `TEMPLATES_NOT_READ`,
`LIFECYCLE_NOT_CONFIGURED`. The character: `CHARACTER_EXISTS` (pass `target`), `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`
(with `candidates`), `TARGET_ARCHIVED`, `DOMAIN_EXISTS`, `CHARACTER_INDEX_EXISTS`, `UPGRADE_NEEDS_TARGET`,
`UPGRADE_NOT_COMPACT`, `TEMPLATES_DIFFER`, `MONOLITH_SPLIT_UNSUPPORTED`. The gate: `IDENTITY_INCOMPLETE` (with
`fields`), `UNESTABLISHED_NEEDS_REASON`, `UNKNOWN_IDENTITY_FIELD`. The pages: `IDENTITY_PAGE_REQUIRED`,
`IDENTITY_PAGE_CONFLICT`, `DEPTH_MISMATCH`, `INVALID_DEPTH`, `UNKNOWN_ROLE`, `TOO_MANY_PAGES`, `TITLE_REQUIRED`,
`DUPLICATE_PAGE`, `BODY_REQUIRED`, `REFERENCE_TYPE_REQUIRED`, `TAG_NOT_ALLOWED`, `INVALID_NAME`, the text codes above.
Links: `LINK_TARGET_NOT_FOUND`, `LINK_TARGET_AMBIGUOUS`, `LINK_TARGET_NOT_CURRENT`. Relationships:
`RELATIONSHIP_PARTNER_REQUIRED`, `RELATIONSHIP_PARTNER_NOT_FOUND`, `RELATIONSHIP_PARTNER_AMBIGUOUS`,
`RELATIONSHIP_WITH_SELF`, `HOST_NOT_WORKING`, `HOST_HAS_NO_INDEX`. Images: `BARE_IMAGE` (no interpretation),
`IMAGE_LABEL_INVALID`, `IMAGES_NOT_HERE`, `SUBFOLDER_INVALID`, `STAGED_IMAGE_NOT_FOUND`, `STAGED_IMAGE_LEGACY`,
`STAGED_IMAGE_BUSY`, `STAGED_IMAGE_TWICE`, `IMAGE_NAME_TWICE`. **Warnings** (the agent's or the owner's to judge):
`RACE_FALLBACK`, `IDENTITY_DEBT` (an existing character's blank gated fields, with a suggested `set_facts`),
`SCOPE_MISSING`, `SECTION_MISSING`, `CORE_OVERLOADED`, `REFERENCE_TYPE_SUGGESTED`, `REFERENCE_TYPE_SUGGESTION`,
`TEMPLATE_ROW_MISSING`, `DEPTH_IGNORED`, `INDEX_TEXT_UNUSED`, `IMAGE_NAME_NUMBERED`, `PARTNER_LINK_DEFERRED`,
`ROUTING_SKIPPED`, `ROUTING_SECTION_MISSING`, `ROUTING_SECTION_AMBIGUOUS`, `UPGRADE_OVERLAP`.

**A type defined as data.** The engine is driven by the pack's rules, not by the Character type: a type whose rules
name no hook gets the generic behaviour, and a tool name that a pack's types share, other than the explicit
`arkona_create_character` and v3 F3b's `arkona_create_owner`, is served by a generic pack tool, `{prefix}{tool}` with a
`type` argument, listed while its types exist and the pack is attached. Arkona has no such type (its owner types are the
pack's owner table, behind the explicit owner tool); a test defines one in data only (`arkona_create_ward`) and runs it
through the same plan, preview, proposal and verify.

### Costs (reads and writes, measured against the mock)

Measured against the mock LegendKeeper (test/packs/costs.test.ts), every request included:

| Package                                                | Plan reads | Job reads | Job writes |
| ------------------------------------------------------ | ---------- | --------- | ---------- |
| Compact, Working, a dry run                            | 4          | 0         | 0          |
| Compact, Working                                       | 4          | 20        | 19         |
| Developed, Working: Core, Biography and a Relationship | 8          | 57        | 46         |
| An Art page with one image for an existing character   | 7          | 28        | 16         |

Three of the planning reads are the pack's governance pages (read again in the job's first check). LegendKeeper changes
one sidebar row per request, so a page's rows are most of its writes (a Compact Reference has 17). Capturing the
proposal writes nothing; the job runs when the owner approves.

## Setting packs: owners, relationships, art and the brief (v3 F3b)

v3 F3b adds four tools to the Arkona pack, on the same engine as `arkona_create_character`: the pack's rules decide the
pages, the planner computes the whole package from them and the tree, a dry run shows it, and anything else is **one
proposal** for the owner whatever the connection's scope (canonical when it makes or moves canon). On approval it runs
as one job that re-reads the pack's governance (drift stops it before it writes), checks again that nothing it relies on
appeared or moved meanwhile, writes, sets Last Major Revision on each page it made or changed, and verifies. Design:
[ADR 0052](adr/0052-arkona-pack-owners-relationships-art-and-the-brief.md), [packs.md](packs.md) and the owner-approved
[F3b design](design/F3b-owner-tools.md). The agent guide's parts are "Arkona owners" and "Arkona relationships, art and
the brief" (under "Setting packs (Arkona)").

**The AU ruling (all five tools).** A canon page of an alternate universe (Continuity Type AU) carries the status tag `AU`
in place of `CANON`; a Working or Archived page leads with its lifecycle tag, so neither appears. The owner's ruling of
16 November 2026, recorded in the pack with its date. `arkona_create_character` changed with it.

**Last Major Revision (all four write tools; ADR 0051's rule, merged from F3c).** Every page a package makes is dated
the day its job runs, whatever is asked. An existing page it changes is dated only when the owner's rule calls the change
a major revision, measured from what the planner already read (no extra read): new or rewritten text of 8 words or
more, a heading added or reworded, a real fact change (not a housekeeping key such as Reference Type, a trim or a typo),
a Dependency added or removed. A move, a new name and Related Sources alone are not (unless the owner switched names and
moves, or link collections, on for the project), so `promoteNation`'s move and a relationship's links leave the date,
while new image sections on an Art page and a gated fact filled set it. `lastMajorRevision: "set"` or `"skip"`
overrides the rule for the existing pages; the project's `lmrPackTools` switch still decides whether the rule is asked
under `"auto"`. The preview and the answer give `lastMajorRevision: { mode, newPages, existing: [{ page, set, why }] }`,
and the proposal's summary and each page's line say the same (`+ Last Major Revision → date of approval (auto: a
heading added (“…”))`, `Last Major Revision skipped: a move, not a major revision`).

**`arkona_create_owner`** `{ type, kind?, name, descriptor?, status?, continuity?, home, homeOverride?, nation?, promoteNation?, createSubindex?, createCharacterNavigation?, referenceType, scope, temporalScope, supersedes?, specialistTag?, markdown?, dependencies?, related?, lastMajorRevision?, dryRun?, preview?, operation_id?, project }`:
ONE non-character owner page, typed by the pack's owner table (19 types: Polity, Institution, Military, Culture, Event,
Place, Technology, Magic, Material, Equipment, Species, Creature, Religion, Law, Programme, Education, Ceremony,
Condition and the inter-polity Relationship; each its template, primary tag, closed specialist tags and allowed homes,
listed in [packs.md](packs.md#the-owner-table-v3-f3b)).

- **Name and place.** `{name} - {descriptor}` (the descriptor defaults to the Reference Type), `[BSRC]` in its home for
  `status: "authoritative"`, or `[BWRK]` under `[INDEX] Working` (the default; `home` is still checked, as the place it
  is promoted to). A sibling of the same name is refused, now and in the place a Working page will be promoted to.
- **Homes.** `home` (a name, id or path) must be one of the type's homes, recognised by the index's name and place:
  `<Continent> <Category>`, `<Nation> <Category>`, a nation index (an index directly in a `<Continent> Polities`
  index), `Arkonan <Category>`, `Divine Realm Cultures`, a Divine Realm index, the Bestiary, or the race roster's pages.
  A home that does not fit is `HOME_NOT_ALLOWED`, with the allowed homes and up to five suitable indexes nearby (by
  distance in the tree); `homeOverride: { reason }` places it anyway with a warning and the reason in the proposal's
  summary. The Working and Archived areas are never a home. No category index is ever made.
- **Nations.** `nation` names the nation. A nation that is only a compact Reference (`[BSRC] <Nation> - …` directly in a
  Polities index) is `NATION_NEEDS_INDEX`; `promoteNation: true` makes `[INDEX] <Nation>` from AI Index there (its
  routing text drafted), moves the Reference into it (id, links and tags kept) and places the owner beside it, in the
  same proposal; the move of canon makes it canonical. `createSubindex: "<Nation> <Category>"` makes one national
  subindex, its own step, for a category the type lives in.
- **The race roster.** `type: "Species"` with `kind`: `racialGroup` (home Races of Arkona, `<Group> - Racial Group
Reference`, tag Racial Group), `race` (home its group's Racial Group Reference or Races of Arkona, `<Race> - Core
Information`, Reference Type Race Core Reference) or `subrace` (home its race's Core Information, `<Subrace> -
Subrace Reference`). Any other species and every creature: the Bestiary. `createCharacterNavigation: true` makes the
  new race's (or group's) `[INDEX]` under `Characters` and records its Character taxonomy entry, so
  `arkona_create_character` can place its characters (a guessed singular waits for the owner's review on Repository
  Mappings).
- **Facts.** Reference Type, Scope and Temporal Scope are required (Unestablished only with the owner's reason); Subject
  is the name; Status, Continuity Type, Continuity and Inheritance follow from `status` and `continuity`; Supersedes
  "None" unless given; Last Major Revision set by the job; the rows in the template's order.
- **Text and links.** As the character tool: `## Purpose` first, Source Boundaries and Unresolved Material warned about
  when missing, no placeholder section (the template's own unfilled placeholder headings are left out). Dependencies
  name current Authoritative owners only.
- **Tags.** `CANON` (or `AU`), the primary, at most one specialist; a Working page `Working`, the primary, then the
  specialist if any (the owner, 16 November 2026: ADR 0052, F3b.1 amendment).
- **Routing lines** (v3 F3d, ADR 0053). An Authoritative owner filed directly into an existing home gets one line in the
  home's "How to Use This Index" section, in the same proposal and F3a's pattern (`- [<page name>](lk://resources/<id>):
<Scope>`, appended, never a rewrite). A home with no such section gets none, and the preview's notes say so. With
  `promoteNation`, the Polities index's line that links the nation's Reference is pointed to the new `[INDEX] <Nation>`
  (the rest of the line kept); no such line, or several: unchanged, and said. A Working owner gets no line until it is
  promoted. ADR 0051's rule decides the index's Last Major Revision.

**Refusals**: `PACK_TYPE_NOT_FOUND` (with the types), `KIND_NOT_FOR_TYPE`, `INVALID_NAME` and F3a's name, dash and text
refusals, `OWNER_FACTS_INCOMPLETE`, `UNESTABLISHED_NEEDS_REASON`, `REFERENCE_TYPE_FIXED`, `DESCRIPTOR_FIXED`,
`DESCRIPTOR_REQUIRED`, `LIFECYCLE_NOT_CONFIGURED`, `NATION_REQUIRED`, `NATION_NOT_FOUND`, `NATION_AMBIGUOUS`,
`NATION_NEEDS_INDEX`, `NATION_ALREADY_INDEXED`, `HOME_NOT_FOUND`, `HOME_AMBIGUOUS`, `HOME_NOT_ALLOWED`,
`HOME_IN_LIFECYCLE_AREA`, `OVERRIDE_NEEDS_REASON`, `SUBINDEX_NEEDS_NATION`, `SUBINDEX_NOT_ALLOWED`, `SUBINDEX_EXISTS`,
`NAVIGATION_PARENT_MISSING`, `NAVIGATION_NOT_FOR_KIND`, `OWNER_EXISTS`, `NATION_INDEX_EXISTS`, `DUPLICATE_PAGE`,
`TAG_NOT_ALLOWED`, `DEPENDENCY_NOT_AUTHORITATIVE`, `LINK_TARGET_NOT_CURRENT`, `BODY_REQUIRED`, `FACT_UNSUPPORTED`,
`PACK_TEMPLATE_UNSET`, `PACK_TEMPLATE_UNKNOWN`, `TEMPLATES_NOT_READ`, `TEMPLATE_UNREADABLE`, `PACK_NOT_CURRENT`.
**Warnings**: `HOME_OVERRIDDEN`, `HOME_OUTSIDE_NATION`, `CHARACTER_NAVIGATION_MISSING`, `TAXONOMY_SINGULAR_GUESS`,
`SECTION_MISSING`, `TEMPLATE_ROW_MISSING`. **In the job**, before its first write: `PACK_GOVERNANCE_CHANGED`,
`OWNER_EXISTS`, `NATION_INDEX_EXISTS`, `SUBINDEX_EXISTS`, `NAVIGATION_EXISTS`, `NATION_REFERENCE_MOVED`.

**`arkona_create_relationship`** `{ a, b, label?, host?, status?, scope?, markdown?, dependencies?, related?, lastMajorRevision?, dryRun?, preview?, operation_id?, project }`:
ONE joint relationship page for two existing characters, on the character tool's builder: `{a} & {b} - {label}` (both
names as their indexes give them; label "Relationship" by default) from AI Relationship, under `a`'s index (`host: "b"`
for b's), Working or canon as its host is unless `status` says otherwise, tagged `CANON` (or `AU`), Character,
Relationship, added to both characters' Related Sources and announced in the hosting index, all in one proposal.
**Refusals**: `CHARACTER_NOT_FOUND` (pointing to `arkona_create_character`), `CHARACTER_AMBIGUOUS` (with the
candidates), `RELATIONSHIP_WITH_SELF`, `RELATIONSHIP_EXISTS` (any label, either order, anywhere in the tree, naming the
page), and the character tool's refusals for the host (`TARGET_ARCHIVED`, a Working relationship under a canon
partner's index) and for the page. **Warning**: `PARTNER_LINK_DEFERRED` (a Working relationship is linked from a canon
character only after promotion). **In the job**: `RELATIONSHIP_EXISTS`.

**`arkona_add_character_art`** `{ character, outfit?, newOutfit?, images: [{ staged_id? | upload_id?, label, interpretation }], file?, scope?, markdown?, status?, lastMajorRevision?, dryRun?, preview?, operation_id?, project }`:
reference images for an existing character. **Since v3 F7** ([ADR 0070](adr/0070-v3-f7-guided-character-art.md)): ONE
call, ONE target. Without `outfit` (or null) the images are design pieces, in the character's own folder (`Characters /
<race path> / <name>`), named `<name> - <label>`. With `outfit` they are that outfit's pieces, named `<name> - <outfit> -
<label>`, and the bridge decides the folder: the character's folders are read LIVE first (one listing per folder, plus a
`getAsset` for an item gone since; a failed read refuses with `ART_FOLDERS_UNREADABLE`), then the outfit's pieces now
(its record, else its folder or the loose pieces named for it) plus those arriving make its total: an outfit with its
folder takes them there; a total of 1 goes loose in `Wardrobe`; 2 or more go in `Wardrobe / <outfit>`, found or made when
the job runs, with the loose piece moved into it in the same job (`updateAsset`, read live again before any write:
`ART_LAYOUT_CHANGED` otherwise). The outfit is matched by its name or an owner's alias (case and spacing ignored); a close
name is refused (`OUTFIT_NEAR_MATCH`, with the candidates) unless `newOutfit: true`. The job records the outfit (its
pieces and folder) in the bridge's outfit record. On the Art page (AI Character Art, made when missing): design pieces
under "Reference Images"; an outfit's under a heading naming it anywhere on the page, else a new heading under the page's
first heading holding "Wardrobe", else a new "Wardrobe" section, placed by a filler on the page as it is inside the job's
lock (nothing else changes; `unsupported` blocks stay). When a loose piece is moved, every page under the character's
index is read live when planned, and each line naming the moved piece by asset id or name is listed for the owner
(`linesForOwner`), never edited; the art layout audit handles stale folder paths. Sources: `staged_id`, `upload_id`
(`prepare_image_upload`) or ChatGPT's attached `file` (`_meta["openai/fileParams"]: ["file"]`, for ONE image: several
images from ChatGPT are staged one by one with `upload_image { stage: true }`, then named in one call); an upload or file
is staged on the bridge's server first, even on a dry run, and its `staged_id` returned. **Refusals**: `IMAGES_REQUIRED`,
`IMAGE_SOURCE_INVALID`, `BARE_IMAGE`, `IMAGE_LABEL_INVALID`, `OUTFIT_NAME_INVALID` (Wardrobe, Forms, Outfits, Details, a
"/" or a " - "), `OUTFIT_NEAR_MATCH`, `ART_FOLDERS_UNREADABLE`, `LEGACY_ART_FOLDER`, `STAGED_IMAGE_NOT_FOUND`,
`STAGED_IMAGE_BUSY`, `STAGED_IMAGE_TWICE`, `IMAGE_NAME_TWICE`, `IMAGE_ALREADY_IN_LIBRARY`, `UPLOAD_ID_UNKNOWN`,
`UPLOAD_ID_USED`, `UPLOAD_NOT_RECEIVED`, `UPLOAD_EXPIRED`, `FILE_URL_EXPIRED`, `CHARACTER_NOT_FOUND`,
`CHARACTER_AMBIGUOUS`, `TARGET_ARCHIVED`, `ART_PAGE_UNREADABLE`. **In the job**: `STAGED_IMAGE_BUSY` (an image no longer
the package's to place), `ART_LAYOUT_CHANGED`.

**`arkona_character_brief`** `{ character, live?, project }` (read): who a character is, from the bridge's own tree,
snapshots and audits, with no LegendKeeper read: the six identity fields (from the identity page's sidebar as the tree
last read it), every page of the set with its Reference Type and Scope, the relationships, the Art pages with their image
counts (from each page's newest snapshot), the Unresolved Material headings, the open audit findings, and how fresh each
part is. `live: true` re-reads the identity page's sidebar (one read). It does not read the pack's governance, so it
answers while the pack waits for approval.

**`arkona_reference_types`** `{ category?, status?, minCount?, under?, pages?, limit?, offset?, project }` (read; v3
F6a, [ADR 0076](adr/0076-v3-f6a-reference-type-vocabulary.md)): every Reference Type value in use across the AI
REPOSITORY (the Legacy Canon Archive, Design References, Working, Archived and Narratives pages left out and counted in
`excluded`), from the tree's stored sidebars, free. One row per value and primary category: `count`, `pages` (id, name,
path, category, lifecycle, coverage when not ok, `specialist`), `status` (`canonical`, `mapped`, `specialist`,
`rejected`, `open`), the `suggestion` and its `reason` (synonyms, time words moved to Temporal Scope, scope words moved
to placement or Scope), or no confident suggestion with `candidates`; the owner's `decision` and any `conflict` with the
published section. `coverage` as `query_facts`: pages read recently, stale and never read (listed in `unread`), the
oldest read, the tree's confirmation. Paged (limit up to 200). Listed while the approved pack version has a vocabulary.
The owner decides each value on the dashboard's Reference Types page; agents only report.

**`arkona_get_art`** `{ asset? | character? (outfit? | design?) | page? (document?), delivery?, limit?, cursor?, project }`
(read; v3 F7b, [ADR 0071](adr/0071-v3-f7b-seeing-character-art.md)): lets an agent SEE a character's art. Exactly one
selector: `asset` (1 to 6 asset ids or file URLs, both forms `https://assets.legendkeeper.com/<projectId>_<uuid>.webp` and
the older `…/<uuid>.webp`; a URL the asset tree lacks is checked as `write_page`'s images are, one live listing at most
every five minutes); `character` (its folders read live first, F7's G9: design pieces, then Wardrobe's loose pieces, its
outfit folders and any legacy folder), with `outfit` (its name or an alias through F7's outfit record and matcher; a near
miss is `OUTFIT_NEAR_MATCH` with the candidates, an unknown one `OUTFIT_NOT_FOUND` listing the outfits) or `design: true`
(the pieces in its own folder only); `page` (every image block on the page, in document order, each page document read
live; `document` for one). At most 6 images a call; more come with `nextCursor` (refused as `CURSOR_INVALID` for another
selection).

Each image: `assetId`, `name`, `folder` (its path), `width`, `height`, `format`, `bytes` (the original's, once downloaded),
`url` (exactly as LegendKeeper gives it), and `authority`: every page whose image block embeds the asset's URL (by its path,
so `assets` and `assets2` match), from the bridge's asset reference and full-text index (the newest snapshot; pages read
live in the call stand in for theirs), never LegendKeeper's search. Per page: `page`, `document`, `section` (the heading
path), `lifecycle`, `ownerPage` (a character's Art or Wardrobe page, by the pack's `artView`), `label` (the image's alt
text) and `text` (the blocks under the image up to the next image or heading, trimmed to 1,200 characters with
`truncated: true`). Authoritative pages first, then none, Working, Archived; owner pages first within each. Nothing
embeds it: `status: "none"` and the warning "No owner page embeds this image; it establishes nothing about canon". No
index yet: `status: "unavailable"` (never "none").

`delivery`: `"both"` (default), `"link"` (urls only, nothing downloaded, no budget) or `"inline"`. Inline: one MCP `image`
content block per image after the JSON, in order (`inline.content` is its position), resized with sharp: EXIF
orientation applied, metadata dropped, long edge at most 1,568 px (never enlarged), WebP at quality 82 (JPEG when the
source has no alpha and is smaller so), quality stepped down to 60 then the size shrunk until under 1 MB; `inline` reports
the delivered format, size and dimensions. At most 6 MB of image data a result: the rest `inlineSkipped: "result size"`.
A failed download or resize: `inline: { ok: false, reason }`, the link and authority kept. `howToView` on every result
that includes links: "Open each url with your web browsing tool, not with code: code sandboxes cannot reach this host."

Bytes come only through `downloadAsset` (the governor and the guarded transport), each download counted as one read;
the resized image is kept in the art cache (`ART_CACHE_DIR`, default `art-cache/` beside the database; `ART_CACHE_MAX_MB`,
default 500, least recently used first), so a second look is free. Cost: none for links; 1 read per image downloaded for
inline (cached); the live selection reads (a character's folders, a page's documents, an asset id the tree lacks) on top.
Refusals: `SELECTOR_REQUIRED`, `INVALID_INPUT`, `CURSOR_INVALID`, `CHARACTER_NOT_FOUND`, `CHARACTER_AMBIGUOUS`,
`ART_FOLDERS_UNREADABLE`, `OUTFIT_NEAR_MATCH`, `OUTFIT_NOT_FOUND`, `OUTFIT_NAME_INVALID`; per asset in `notFound`:
`NOT_ASSET_URL`, `ASSET_NOT_FOUND`, `NOT_AN_IMAGE`.

**The staged-image takeover (all the pack's image tools).** At scope `propose`, `upload_image` with a destination stages
the image AND proposes its placement. A package that names that staged image now takes the placement over instead of
answering `STAGED_IMAGE_BUSY`: once the package's proposal is captured, the image's own pending placement proposal is
withdrawn (rejected by `system`, reason "superseded by package prop_…", audited `proposal.superseded`) and the answer
lists it under `takenOver`. Any other activity on the image is still `STAGED_IMAGE_BUSY`, with the hint to stage art with
`upload_image { stage: true }` and no destination, which proposes nothing.

**Governance sections.** The approval now also records a digest of each pinned section the rules come from (Source
Formatting's Page Names and Templates, Nation-Centred Territorial Navigation, Approved Hierarchy and Active Template
Suite; the Tagging Standard's Exact Tag Grammar and Closed Primary Categories) and is refused when one cannot be found
(`GOVERNANCE_SECTION_MISSING`). Drift still fails closed on the document's version; `PACK_NOT_CURRENT` and the job's
`PACK_GOVERNANCE_CHANGED` now name the pinned section that changed.

### Costs (reads and writes, measured against the mock)

Measured against the mock LegendKeeper (test/packs/owner-costs.test.ts), every request included:

| Package                                      | Plan reads | Job reads | Job writes |
| -------------------------------------------- | ---------- | --------- | ---------- |
| Compact owner, a dry run                     | 4          | 0         | 0          |
| Compact owner, Working                       | 4          | 20        | 13         |
| Compact owner, Authoritative                 | 4          | 18        | 13         |
| promoteNation: index, Reference moved, owner | 7          | 31        | 16         |
| Relationship of two canon characters         | 14         | 40        | 15         |
| Art: a new Art page with one image           | 7          | 27        | 16         |
| Art: one image on an existing Art page       | 4          | 11        | 3          |
| Brief                                        | 0          | -         | -          |
| Brief, `live: true`                          | 1          | -         | -          |

Three of the planning reads are the pack's governance pages (read again in the job's first check). An owner page's ten
sidebar rows are most of its writes (LegendKeeper changes one row per request). A relationship reads both characters'
sidebars and pages to plan, and the job writes both participants' Related Sources and the hosting index's routing line.

## Setting packs: appraisal and full-text search (v3 F3c)

v3 F3c adds the read-only half of the Arkona pack: four appraisal reports and one way to act on a finding, and the
`search` tool's `content: true` now searches the bridge's own full-text index. Design:
[ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md), [packs.md](packs.md#appraisal-v3-f3c) and the
owner-approved [F3c design](design/F3c-appraisal.md). The agent guide's part is "Arkona appraisal" (under "Setting packs
(Arkona)").

**Read-only, and free.** Repository Automation: "Automations are diagnostic and read-only by default. Report detected
issues and the appropriate interactive follow-up; do not silently perform the repair." No appraisal tool writes to
LegendKeeper or makes a proposal. They read the snapshot overlay (the newest full snapshot plus every change snapshot
since, materialised in the bridge's database with its full-text index), the audits' findings, the bridge's asset tree
and its own database: **no LegendKeeper read**, unless `live: true` (A2, A3) asks for one. Every report says what it
inspected, how fresh its data was (`source.index`: the base full snapshot, the newest change snapshot and their age) and
what it could not check (`couldNotCheck`, and the blocked cases); it never guesses to fill a gap.

**Every finding** has a stable `id` (the same finding has the same id in every run), its `check`, its `group`, its
`evidence` class (Confirmed deterministic defect, Potential Maintenance Issue, Explicitly Unresolved, Inaccessible,
Incomplete, Review signal), the `rule` it comes from (`{ page, section, rule }`: the governance page and section), the
`page` (id, name, path), a `message`, `details` (with `detail: "full"`), its `source` (snapshot, live read or audit, with
its time), its `labels` (lifecycle and branch) and a **`followUp`**:

- `{ kind: "fix", tool: "arkona_appraisal_fix", args: { findingId }, change }`: a deterministic repair; the call makes ONE
  proposal (below);
- `{ kind: "judgement", tool, decide }`: no single right repair. It names the tool you would use and what has to be
  decided: ask the owner, never guess (a Purpose section needs the subject's purpose from the owner or its sources);
- `{ kind: "none", reason }`: report only (an orphan asset candidate, a blocked case).

**Long reports** come a page at a time: `limit` (default 50, at most 200), `offset`, `group` (only that group) and
`detail`. Each run is kept (the latest per tool and scope, compared with the one before: `compared`), so `runId` reads it
again a page at a time without re-running anything.

**`search`** with `content: true` (see [Finding things](#finding-things)): the index, free, with the operators; each
result labelled by `lifecycle` and `branch`, a page found through its text with its `text` hits (document, block, section
path and a snippet, the words marked «»). The Legacy Canon Archive and the Design References are left out unless
`include: ["legacy", "design"]` names them (`content.leftOut` counts them). `content: "live"` is LegendKeeper's own search
(1 read, ranked, incomplete), as `content: true` was before.

**`arkona_appraise_owner`** `{ page? | under? | all?, include?, live?, runId?, group?, offset?, limit?, detail?, project }`
(A2): one page, a branch (the page and everything beneath it) or everything (bounded at 5,000 pages, paged) against Source
Formatting, in Repository Automation's four groups: `required` defects, optional `polish`, `architectural` candidates,
`blocked` cases. The checks and their groups are the owner's (D2), each naming its rule:

| Check                                                                        | Group         | Follow-up                    |
| ---------------------------------------------------------------------------- | ------------- | ---------------------------- |
| `purpose_first`: the body does not begin with Purpose                        | required      | judgement                    |
| `title_repeated`: the page title or a metadata header at the top of the body | required      | judgement                    |
| `heading_links`: a link inside a heading                                     | required      | **fix**                      |
| `literal_markdown`: Markdown pasted as text (`**`, `# `, `- `, pipe tables)  | required      | judgement                    |
| `blank_paragraphs`: decorative blank paragraphs                              | polish        | **fix**                      |
| `em_dash_name`, `em_dash_text`: an em dash in the name, headings or prose    | required      | **fix**                      |
| `template_field_missing`, `field_improvised`: the template's sidebar fields  | required      | judgement                    |
| `completion_gate`: the six identity fields (Core and Compact only)           | required      | judgement                    |
| `boundaries_missing`: no Source Boundaries or Unresolved Material            | polish        | judgement                    |
| `dependency_noncurrent`: a Dependency on a Working or Archived page          | required      | judgement                    |
| `related_noncurrent`: one in an Authoritative page's Related Sources         | required      | **fix**                      |
| `related_empty`: an empty Related Sources (a prompt to review)               | polish        | judgement                    |
| `related_not_reciprocal`: no link back within a character's set              | polish        | judgement                    |
| `index_incomplete`: scope statement, "why open" text, Subpages collection    | required      | judgement                    |
| `sibling_order`, `tag_grammar`: the audits' findings, gathered               | required      | the audits' fix, handed over |
| `audit_finding`: any other open audit finding of the page, gathered          | by severity   | judgement                    |
| `scope_overload`, `core_holds_specialist`: a pointer for A6 (F3e)            | architectural | judgement                    |
| `block_ids_pending`: a legacy body, waiting for the block-id sweep (F3.5)    | polish        | none                         |
| `page_unreadable`, `not_in_snapshots`, `template_unavailable`, `no_body`     | blocked       | none                         |

The audits are reused, never re-checked: the page's open findings are gathered (not their own configuration notices),
and a missing row they report is not reported twice. A branch or everything leaves out the Legacy Canon Archive, the
Design References and Archived pages unless `include` names them (`legacy`, `design`, `archived`); a page named alone
is always appraised. `live: true` re-reads each page first (2 reads each, at most 25 pages; `LIVE_TOO_MANY` otherwise).

```json
{ "under": "Hollin Shore", "limit": 50 }
```

**`arkona_change_impact`** `{ page?, renameTo?, proposal?, live?, runId?, group?, offset?, limit?, detail?, project }`
(A3): everything connected to a page as it is, a planned rename (`page` + `renameTo`, the new name without its prefix) or
a pending proposal (`proposal`: each page it changes, and what it becomes), in two groups. **`proven`** breakage:
Dependencies or an Authoritative page's Related Sources pointing at a page that is (or will be) deleted, archived or
Working (`link_to_noncurrent`); mentions whose target is gone (`mention_target_gone`); for a rename, mentions showing the
old name (`mention_label_mismatch`) and chronology rows naming it (`chronology_row_mismatch`). Review **`candidates`**:
incoming links (`incoming_link`) and mentions (`incoming_mention`, including one that shows another label), chronology
rows naming the subject (`chronology_row`), and textual restatements (`restatement`: other pages' text naming it by its
name and aliases, through the index, without linking to it; never proof anything changed). Each with its page, section
and snippet. A proposal that is not pending is `PROPOSAL_NOT_FOUND`; `page` or `proposal`, not both, and `renameTo` only
with `page` (`INVALID_PARAMS`). `live: true` re-reads the subject (1 read: its name and aliases).

**`arkona_working_digest`** `{ since?, runId?, group?, offset?, limit?, detail?, project }` (A4): every Working page
(`working_page`: its Status, Scope, Last Major Revision, when the snapshots first saw it and when it last changed, with
the age), every pending or conflicted proposal (`proposal_open`), the Working sets whose package was approved but whose
pages are still `[BWRK]` (`approved_not_promoted`), and the Working pages whose Unresolved Material says "contradict",
"conflict" or "supersede" (`declared_contradiction`). Age is shown, never judged: there is no "stale" threshold (D3).
Ordered by the most recent change; `since` (`"24h"`, `"7d"`, `"2w"` or a number of days) keeps what changed in that
window.

**`arkona_visual_hygiene`** `{ page? | under?, runId?, group?, offset?, limit?, detail?, project }` (A5): every finding a
**candidate**, never a defect: an asset name with a file extension (`asset_extension`, the one with a fix), a non-WebP
image (`asset_not_webp`), an image outside its character's `Characters / <race path> / <Name>` folder or its Forms,
Outfits, Details (`asset_misplaced`), orphan candidates (`asset_orphan`: no page shows them; a whole-library run only),
image blocks whose asset is gone (`image_broken`), Art page images with no interpretation text (`art_uninterpreted`), two
images labelled as one subject's Primary Reference (`primary_conflict`). An asset whose bytes the snapshots do not hold
yet is a blocked case (`format_unknown`), never guessed. Default: the whole library; `page` or `under` narrows it to the
images those pages show.

**`arkona_appraisal_fix`** `{ findingId, project }`: the fix for ONE finding whose `followUp.kind` is `fix`. It re-reads
the page (or the asset) live and checks the finding still holds (`FIX_STALE` otherwise, with what is there now: nothing
is done). Then it follows the pack's switch for this tool (v3 F3.4, [ADR 0055](adr/0055-write-scope-review-revert-rails.md)
decision D; the Packs page): **follow the agent's scope**, the seed's default, makes the fix at once at scope `write`, as
one job (`written`, or `queued`: follow it with `bridge_job_status`; the owner reviews it afterwards on the Review page),
and one proposal at scope `propose`; **always propose** makes **one ordinary proposal** for the owner whatever the scope
(`proposal_captured`; never resubmit it, follow it with `bridge_proposal_status`). Canon, lifecycle and the safety rails
still make a proposal (with `proposedBecause` for a rail). The handed-over audit fixes (sibling order, tags) are always
proposals, as the audits make them, and the Appraisal page's **Propose a fix** always proposes.

| Finding                                      | The proposal                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `em_dash_name`                               | `update_resource`: the name's dashes replaced with ASCII hyphens, the prefix kept           |
| `em_dash_text`                               | block by block (write_page's path): only the blocks with a dash, every other character kept |
| `blank_paragraphs`                           | block by block: those paragraphs deleted                                                    |
| `heading_links`                              | block by block: each heading's text kept, its link dropped                                  |
| `asset_extension`                            | the asset renamed without its extension; refused when its folder already holds that name    |
| `related_noncurrent`                         | that one link removed from Related Sources (set_facts' plan)                                |
| `sibling_order`, `tag_grammar` (from audits) | handed over to the audit's own "Propose a fix"                                              |

**A name fix that changes a subject's name** (CR-2026-11-R3, R3-59): the dash replaced in a subject's page name changes
the subject part the bridge reads ("Gata—Lund - Polity Reference" reads as "Gata", descriptor "Lund - Polity Reference",
once it is "Gata - Lund - Polity Reference"), and the fix renames that page only. When the rename steering
([`USE_ARKONA_RENAME`](#changing-moving-deleting-and-restoring)) would judge it a subject's rename, the fix is not refused
(it is the owner's proposal, or reviewed afterwards): it says it is a plain rename, `(plain rename: the dash replaced in
this page’s name only; nothing else that names “Gata—Lund” is renamed: arkona_rename renames a subject everywhere)` in its
summary and `plainRename` in its operation, or, run at once at scope `write`, in the job's title and the journal entry.

Last Major Revision follows ADR 0051's rule: a dash, a blank paragraph or a heading's link is not a major revision, and
a name or Related Sources never counts, so the summary says `Last Major Revision skipped: …`. A finding whose follow-up
is a `judgement` or `none` is `NO_FIX` (ask the owner); an unknown finding id, or one no longer in the latest run of its
scope, is `FINDING_NOT_FOUND` (run the report again); `FIX_NOT_APPLICABLE` when the repair cannot be made as it is (the
name or asset name is already taken there, or every block concerned also holds an inline icon, which LegendKeeper's
write format cannot write back: nothing is proposed). A live read the rate budget queued instead of running is
`READ_DELAYED` (nothing proposed; try later). Batch fixes are not offered.

**Other refusals.** `PACK_NOT_ATTACHED` (the project has no Arkona pack), `NO_SNAPSHOT` (no full snapshot yet: the first
nightly snapshot makes one), `RUN_NOT_FOUND` (a `runId` that is no longer the latest of its scope), `LIVE_TOO_MANY`,
and for A3 `PROPOSAL_NOT_FOUND` and `PROPOSAL_NOT_PENDING` (only a pending proposal is analysed).

### Costs (reads and writes)

| Call                                             | Reads                                                                                                                | Writes                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `search` with `content: true`                    | 0                                                                                                                    | 0                                       |
| `search` with `content: "live"`                  | 1                                                                                                                    | 0                                       |
| `arkona_appraise_owner`                          | 0 (`live: true`: 2 a page, at most 25 pages)                                                                         | 0                                       |
| `arkona_change_impact`                           | 0 (`live: true`: 1)                                                                                                  | 0                                       |
| `arkona_working_digest`, `arkona_visual_hygiene` | 0                                                                                                                    | 0                                       |
| `arkona_appraisal_fix`                           | 1 (the re-read); then the fix's own (at once at scope `write` when the switch follows the scope, else once approved) | the fix's own, at once or once approved |

The full-text index is built and updated from the snapshot store (no LegendKeeper read). On a fixture of Arkona's size
(1,500 pages) it builds in about 2 seconds, takes a five-page change snapshot in about 40 ms, answers a phrase in about
1 ms and takes about 21 MB of the bridge's database ([ADR 0054](adr/0054-arkona-appraisal-tools-and-full-text-search.md#decision-1-the-overlay-materialised-in-the-bridges-database-with-an-fts5-index-a1)).

## Setting packs: renames, selective approval and resume (v3 F3d)

[ADR 0058](adr/0058-v3-f3d-renames-selective-approval-resume.md); the owner-approved design:
[design/F3d-renames.md](design/F3d-renames.md).

### `arkona_rename`

`{ subject, newName, given?, family?, keepOldAsAlias?, effectiveDate?, token?, from?, lastMajorRevision?, dryRun?, operation_id?, project? }`,
or `{ report, project? }`. Renames an Arkona character (any page of its set) or owner (a culture, a polity, a place, a race)
everywhere it is named, as **ONE canonical proposal**, whatever the caller's scope (ADR 0057 decision 5: renaming canon is
canon). It is **not subject to the bulk rail** (ADR 0055): one subject, one proposal the owner reads item by item.

**The plan** (A1's full-text index and A3's references find where the name is; each page or document with a planned edit
is read live): one package of **items**, each with an id, its change (`diff`) and its dependencies:

| Group                | Items                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page names           | the index, the Core or Reference, every `<Old> - …` child, every relationship naming it (either way round); ids kept; re-placed only when its place among its siblings changes |
| Identity facts       | Subject and Canonical Display Name (and any fact naming it) on each page of the set; Given and Family as supplied; the old name added to Aliases                               |
| Resource aliases     | each renamed page's old name added to its search aliases (`keepOldAsAlias`, default true)                                                                                      |
| Index routing        | a line of an index's routing section naming it in its text                                                                                                                     |
| Chronology           | each table row naming it, with its timeline event (when the bridge links them) kept in step, by the chronology tools' own path                                                 |
| Taxonomy and art     | the art folder and the asset names holding the old name; a race's Character taxonomy entry (the old plural kept as an alias)                                                   |
| Identity token       | a culture's or race's token map (a NEW pack version the owner approves; the job waits for it), and each character's fact and tag                                               |
| Textual restatements | each plain-text occurrence elsewhere, one item with its sentence (sidebar facts of other pages: one item per page)                                                             |

**Ticks (D1 (a)).** Every item starts ticked except a restatement inside quotation marks, after "formerly", "previously",
"once called" or "originally" in the same sentence, under Unresolved Material, in a chronology row dated before
`effectiveDate`, or on a page that is not current; each says why (`why`). **Never edited (D2):** Archived pages, the
Legacy Canon Archive and the Design References (`leftAsHistorical`). AU pages are included, labelled `AU`. Text in a table
cell or a code block, and a name split by formatting, are listed in `notPlanned`.

**Review only, never items (`reviewOnly`, ADR 0058 amendment B and D).** The plan (and `report` after the job) lists what
the bridge never edits and nothing approves, for the agent to bring to the owner: each occurrence of the old **given
name**, **family name** and each old **alias** on its own (a whole word, through the full-text index; not inside the full
old name; only the parts the new name no longer holds) on a current page, with its page, section and sentence, and
`sharedWith` ("this page is in Azhar al-Rashid's set") when the page belongs to another character whose name holds the
same part; and each mention whose **custom label** holds the old name (`note: "custom label: change it in the app if
wanted"`): LegendKeeper's API cannot change a mention's custom label, so no rename writes one and none fails on one. At
most 200 occurrences (`count`, `more` for the rest). The owner can ask for a follow-up rename (`from`) of specific ones.

**Refusals.** `NAME_PARTS_REQUIRED` (a given or family name in the old name but not the new one, not supplied: never
inferred), `NAME_PARTS_NOT_APPLICABLE`, `TOKEN_REQUIRED` (a token that is not the culture's or race's own name),
`NAME_TAKEN` (a renamed page would sit beside a page of that name), `NOTHING_TO_RENAME`, `FOLLOW_UP_MISMATCH`,
`SUBJECT_NOT_FOUND`, `SUBJECT_AMBIGUOUS`, `SUBJECT_ARCHIVED`, `PACK_NOT_CURRENT`, `NO_SNAPSHOT` (no full-text index yet).

**The job** (one, after the owner's approval of all or some items): one check first — the subject still has its old name
(renamed meanwhile: `SUBJECT_RENAMED`, nothing is written), each page of its set has its old name (or the new one), each
block's planned edits re-applied to it as it is (or skipped), each asset as planned (or skipped), the pack version the
owner approved maps a new token — then the approved items in dependency order (names, then facts, then everything that
points at them), Last Major Revision per page by ADR 0051's rule measured from what was approved (a name, an alias, a tag
or a fact that only swaps the name never counts; a page with nothing else has no step at all; a skipped item's write is not
measured), and the read-back of every page it touched (the skipped items left out).

**Re-placing, in sequence (CR-2026-11-R3, R3-56).** Each renamed page's move follows the names actually written, in the
job's order: once renamed, the page belongs among its siblings whose names are final (a page the rename does not touch, one
whose rename the owner left out, and one already renamed; never beside a sibling the job renames later, whose name is
still to change), and it moves only when it stands outside that place. So when the pages the rename does not touch are in
order among themselves, the parent ends in order, and a set already in order moves none of its pages. Where several pages
of one parent are renamed, each has a move that works its place out again inside its lock, from the parent's children as
planned and the renames the owner approved ("Propose these again": with those the approved part wrote); it reads the page
there and sends nothing when the page is in its place. A page the owner moved since the plan is left where it is, and a
move LegendKeeper refuses (its neighbour gone) is reported (`placement_failed`) without stopping the rename.

**The identity token, inside each tag write (CR-2026-11-R3, R3-60).** Each character's tag write judges, inside its lock,
that the pack version the owner approved still maps the new value to the new tag (the job's first check judged it once,
before any write). When the owner has approved another version meanwhile that no longer does, the tag is not written: the
character's item is skipped, saying so ("the pack version the owner approved no longer maps …"); the rest of its rename
(its fact) stands.

**Locks and conflicts (ADR 0058 amendment A).** The job holds no lock for its whole run: each write takes its own page's,
document's or asset's lock only for itself, and re-checks inside it. When a write finds its target changed (another
version or state when it reads it inside its lock, or LegendKeeper answers 412), it is **rebased**: what the item edits
must still be exactly there (a restatement's occurrence in its sentence; a fact's old value; a page's old name; a row's
text; an alias or tag list as it now is), and the same change is re-applied to the fresh content and version, at most 3
attempts, with the governor's backoff before each re-read that follows a refused send. When it is gone or changed (someone
edited that exact text meanwhile), or now appears more than once in its paragraph, the item is **skipped** ("changed
meanwhile", with a `before` and `after` excerpt) and the job carries on; three conflicts in a row skip it too. Rebasing
never widens an edit. **Core items** (the subject's own page names and the identity facts of its set) are never skipped:
their conflict stops the job, which stays resumable. Skipped items are listed on the proposal (`itemPlan.skipped`), in
`report` (`skipped`) and are proposed again with the left-out ones (**Propose these again**). Cost: a conflict seen on the
read a write makes anyway costs no extra read; one refused by LegendKeeper (412) costs one read (the re-read) and the send
again.

**What is left.** When the job ends, the full-text index is searched for the old name again (once the job's change
snapshot is in it): every occurrence still on a current page is listed with its link (`lk://resources/<id>`), with the
follow-up call that proposes exactly those: `arkona_rename { subject, newName, from: "<old name>" }` (the subject already
has the new name; only what is left is planned). `report` (a rename's id, its proposal or its job) answers the rename's
state and that list, free.

**Costs (measured against the mock).** Planning reads each page of the set and each document holding the name once, plus
the pack's three governance reads: 22 reads for the test character (seven pages, six other pages naming her, two
chronology rows); its approved job (the plan's ticks: 7 items left out) 185 requests, 46 of them writes, its check,
read-back and change snapshot included (CR-2026-11-R3: history is judged again when the job runs, one read of each page
with restatements; 177 before that, and 185 with 49 writes before the amendment, which no longer writes the two custom
labels; R3-56's moves in sequence send one move fewer, 47 writes before, and two of the moves read their page and send
nothing). The culture with six characters: 13 reads to plan, its job 95 requests, 20 of them writes (93 before R3; 98
before the amendment). `dryRun` states the plan's own estimate (`cost`). A plan whose check or read-back would hold more
than 5,000 entries in one step is refused before anything is proposed (`STEP_TOO_LARGE`).

### Selective approval (every proposal made of items)

A proposal made of items (a rename, and every F3a and F3b package: its new pages and its changes to each existing page)
carries them (`items` on the proposal: total, approved, left out). The owner approves the plan's ticks, everything, or a
selection: a selection must be **closed** (every item it keeps has what it needs), or it is refused
(`SELECTION_NOT_CLOSED`, naming each item and what it needs); the dashboard drops the dependants itself and shows them
before the owner confirms. The proposal records what was approved and what was left out, the job runs only the approved
steps (each write named by its items; shared checks and the read-back trimmed to them; references to a page left out
removed), and "propose these again" makes ONE new proposal of exactly the items left out (`reproposedAs`,
`reproposalOf`), once the approved part has run to the end (CR-2026-11-R3: not while it runs or after it failed; one at a
time, `REPROPOSE_RUNNING`), putting back the index routing lines the partial approval left out; a split's or a retag
batch's are not proposed again (`REPROPOSE_REFUSED`: split what is left, or audit again). Agents cannot approve anything.
An ordinary proposal is unchanged.

### Resume

A package or a rename that stops part-way records where (its last verified step, the step it stopped at, why). The owner
resumes it on the Jobs or Review page; an agent resumes its own direct job with `bridge_job_resume`. The job continues in
place: its own check runs again first, no succeeded step runs again, nothing is made twice, and a step that is no longer
safe is refused with its reason. Work the owner approved resumes without a new approval and is audited (`job.resume`),
only while its proposal stands (`PROPOSAL_NOT_APPROVED` once the owner rejected it). A split re-runs its destinations check
too. A job reverted, being reverted, or whose revert stopped part-way is never continued, by Resume or a step Retry
(`REVERTED`, `REVERT_RUNNING`, `REVERT_STOPPED`; CR-2026-11-R3). F2's "Finish" of a recreate uses the same mechanism (its
new proposal of what is missing, as before). Revert (ADR 0055) stays the alternative for a direct job.

## Setting packs: splits (v3 F3e)

[ADR 0059](adr/0059-v3-f3e-splits.md); the owner-approved design: [design/F3e-splits.md](design/F3e-splits.md). The
agent guide's part is "Arkona splits" (under "Setting packs (Arkona)"). Both tools need the pack version
`arkona-2026-11-18-f3e` (its split rules), approved on the Packs page; until then they refuse (`SPLIT_RULES_MISSING`, or
`PACK_NOT_CURRENT` while the new version awaits the owner's approval).

### `arkona_split_appraisal` (A6)

`{ page | under, include?, live?, limit?, offset?, group?, runId?, project? }`: `access: read`, free. The measurable
Split Triggers of Character Architecture on one page or a branch, with Anti-Fragmentation as the counterweight, from the
snapshot overlay (`live: true` re-reads each page: 2 reads a page, at most 25). The thresholds are the pack's data
(`rules.splits`, D4):

| Trigger (`check`)                                    | Fires when                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Scope Overload (`scope_overload`)                    | the Scope, or else the top-level sections, name 3 or more domains (`scopeOverload.minDomains`)          |
| Retrieval Cost (`retrieval_cost`)                    | 2,000 words or more AND 2 or more section domains (`retrievalCost`); length alone never counts          |
| Asset Ownership (`asset_ownership`)                  | a non-Art, non-visual page with 3 or more images, or a wardrobe, form or outfit section with an image   |
| Shared Ownership (`shared_ownership`)                | a section of 120 words or more about one other named character, with no relationship owner for the pair |
| Distinct Unresolved Material (`distinct_unresolved`) | 2 or more Unresolved Material items under one domain                                                    |
| Distinct Dependencies (`distinct_dependencies`)      | a Dependency on a universal owner that only one section relies on                                       |

Each finding is an **architectural candidate** (`group: "architectural"`, evidence class Potential Maintenance Issue,
`followUp: judgement` naming `arkona_split_owner`) with its trigger, its evidence (sections, counts, sizes), the page's
**draft destination map** (each section, its domain, and where it might go: a specialist page by the pack's
destinations, a relationship owner, an Art page, or `stays`) and its **Anti-Fragmentation note**. The report's
`questions` are the triggers the bridge cannot measure (Independent Retrieval, Independent Maintenance, Downstream
Dependency). `arkona_appraise_owner` carries the same candidates in its architectural group (trigger and evidence, with a
pointer to A6). Nothing is ever written.

### `arkona_split_owner` (C2)

`{ source, retire?, destinations, map, dependencies?, lastMajorRevision?, dryRun?, operation_id?, project? }`, or
`{ report, project? }`. `access: write`; **always ONE canonical proposal** at every scope (D7); not subject to the bulk
rail.

| Argument       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`       | The owner page to split (name, alias, path or id): an Authoritative or Working page, not an index or an Archived page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `retire`       | D2: archive the source once phase 1 has verified (a separate canonical proposal by the bridge). Default `false`: it survives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `destinations` | Each `{ key, kind, … }`: `new` (`role`, `title`, `referenceType`, `specialistTag` for a character's page; `type`, `name`, `descriptor`, `home`, `nation`, `temporalScope` for any other owner; `scope` and `purpose` required), `existing` (`page`, `under`), `relationship` (`page`, or `with` and `label` for a new one), `universal` (`owner`, `text`, `in`). A new owner the pack expects to carry them (`splits.sections`: on Arkona a Core, a Compact Reference, a relationship owner and any other owner; not an Art or specialist page unless its Reference Type is named; CR-2026-11-R4) also answers for the source's Source Boundaries and Unresolved Material (`sourceBoundaries`, `unresolvedMaterial`, or `notApplicable: { … : reason }`, unless items of them move there) and its Dependencies (`dependencies`, or `noDependencies: { reason }`): ADR 0059 amendment 1. |
| `map`          | Each `{ section, to }` (a heading's text or block id, or `(preamble)`; a key or `stays`), or `{ section, blocks: [{ ids, to, summary?, under? }] }` to divide a section block by block; `summary` (required for each section that leaves a surviving source) and `under`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `dependencies` | D5: each `{ page, to, keepSource? }`: a page that depends on the source, to the destination it needs (every one when `retire`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Refusals before anything is proposed** (each with its list; `refusals` holds them all, `preview` what the plan saw):
`SPLIT_COVERAGE` (`unassigned`, `twice`: block, section, excerpt, destinations), `SPLIT_DUPLICATED_AUTHORITY`
(`duplicated`), `SPLIT_VISUAL` (`blocks`), `SPLIT_UNSUPPORTED_BLOCK`, `SPLIT_UNIVERSAL_TEXT_REQUIRED`,
`SPLIT_UNIVERSAL_OWNER_REQUIRED`, `SPLIT_UNIVERSAL_OWNER_NOT_FOUND`, `SPLIT_UNIVERSAL_OWNER_NOT_UNIVERSAL`,
`SPLIT_UNIVERSAL_IN`, `SPLIT_SUMMARY_REQUIRED` (`missing`), `SPLIT_DEPENDENCIES_UNMAPPED` (`unmapped`),
`SPLIT_DEPENDENCY_NOT_INCOMING`, `SPLIT_DEPENDENCY_TO`, `SPLIT_DEPENDENCY_KEEPS_RETIRED`, `SPLIT_RETIRE_IDENTITY`,
`SPLIT_CORE_REQUIRED` (the character would have an index and several owners and no Character Core: upgrade its
Compact Character Reference first, `arkona_create_character` with `target` and `upgradeToCore`; `identity`, `owners`),
`SPLIT_SECTION_NOT_FOUND` (`headings`), `SPLIT_SECTION_AMBIGUOUS`, `SPLIT_BLOCK_NOT_IN_SECTION`, `SPLIT_MAP_ENTRY`,
`SPLIT_DESTINATION_KEY`, `SPLIT_DESTINATION_UNKNOWN`, `SPLIT_DESTINATION_EMPTY`, `SPLIT_DESTINATION_PAGE`,
`SPLIT_DESTINATION_SOURCE`, `SPLIT_DESTINATION_NOT_OWNER`, `SPLIT_LIFECYCLE_MISMATCH`, `SPLIT_UNDER_REQUIRED`,
`SPLIT_PURPOSE_REQUIRED`, `SPLIT_SCOPE_REQUIRED`, `SPLIT_SECTIONS_UNADDRESSED` (`unaddressed`: destination and section;
`fields`), `SPLIT_DEPENDENCIES_UNADDRESSED` (`destinations`, `suggested`: the source's own Dependencies),
`SPLIT_COMPLETENESS_CONFLICT` (`conflicts`), `SPLIT_OWNER_TYPE`, `SPLIT_NOT_A_RELATIONSHIP`,
`SPLIT_RELATIONSHIP_NOT_CHARACTER`, `SPLIT_RELATIONSHIP_WITH`, `SPLIT_SOURCE_INDEX`, `SPLIT_SOURCE_ARCHIVED`,
`SPLIT_SOURCE_UNCLASSIFIED`, `SPLIT_NO_PAGE_DOCUMENT`, `SPLIT_BLOCK_IDS_PENDING` (a legacy page: the block-id sweep
first), `SPLIT_IMPACT_UNAVAILABLE` (retiring needs the incoming Dependencies), `SPLIT_RULES_MISSING`, `PACK_NOT_CURRENT`,
and F3a's and F3b's own refusals for a new page (`DOMAIN_EXISTS`, `REFERENCE_TYPE_REQUIRED`, a home, a name…).
**Warnings**: `SPLIT_RELATIONSHIP_SECTION` (the relationship audit), `SPLIT_UNIVERSAL_CANDIDATE`, `SPLIT_RETIRED_CONTENT`
(what stays is archived with the source).

**The plan** (`dryRun`, and the proposal's operation): `sections` (each and where it goes), `destinations` (each with its
item, page, sections, blocks, words, images), `interfaceSummaries`, `indexEntries`, `dependencies` (`remapped`,
`unmapped`, `chronologyRows`), `items` (each with `ifLeftOut`: what leaving it out means), `blockIds`,
`lastMajorRevision`, `warnings`, `notes` and `cost` (`planReads` as made; the job's estimate). ADR 0059 amendment 1:
`completeness` (the source's own Dependencies as `suggestedDependencies`, each new owner's starting list; for each new
owner, how it addresses each section, `moved`, `supplied`, both or `not applicable` with the reason, and its
Dependencies, a count or the none with its reason; each reason is also on the destination's item, so the owner reads it)
and `nextSteps` (also in `report`): what is still owed once the split has run, each `{ page, what, tool }`: a section a
surviving source gave away whole (`write_page`), a page that depends on a surviving source and was not remapped
(`set_facts`), and each new owner's not-applicable sections and none, to revisit if they change.

**Completeness** (ADR 0059 amendment 1). When the source has Source Boundaries or Unresolved Material, each new owner
(a new owner or a new relationship owner) addresses each one: by items of it moved there (blocks moved without their
heading or an `under` go under the section's own heading), by the agent's text (`sourceBoundaries`,
`unresolvedMaterial`: Markdown, the heading added when it has none, after any moved items), or as not applicable with a
reason. The bridge never writes these sections' content itself. A new owner's Dependencies start from the source's own;
a universal owner whose application text goes there counts; an empty list needs `noDependencies: { reason }`.

**The Character Core** (CR-2026-11-R3, R3-66). A character with an index and several owners has a Character Core: a
Compact Character Reference that the split leaves at the head of several owners (new ones the split makes, or ones its
index already holds) is upgraded in place in the same proposal, as F3a's `upgradeToCore` does: renamed
`<Name> - Character Core`, Reference Type `Character Core`, the Core template recorded; its id, documents, text,
identity facts and links kept. Every new owner of the split needs that upgrade (its item), so a partial approval never
makes the character several owners without a Core. Revert leaves the upgrade to the deletion proposal of the pages the
split made (renaming an Authoritative page is canon): once the owner approves it as canon, the pages go first, then the
Core is the Compact Character Reference again (only when every page the split made is deleted).

**Items.** `dest:<key>` (a destination and its own source edit), `universal:<key>` (universal material whose text stays
in the source), `index:<id>` (a new character index), `existing:<id>` (an existing page's changes from F3a or F3b, such
as a relationship's links, or the source's move under a new index and its upgrade to the Core), `route:<id>` (a new
page's line in an existing index), `dep:<id>` (a remapped Dependency). A destination left out keeps its sections in the
source; what needs it is left out with it.

**Phase 1** (one job): the first check (`split.source`: governance, the new names still free, the source as planned:
`SPLIT_SOURCE_GONE`, `SPLIT_SOURCE_ARCHIVED`, `SPLIT_SOURCE_CHANGED`), the new owners (F3a's and F3b's steps; each
page's text its Purpose and the moved blocks verbatim with their ids), the existing owners' appends (inside the page's
lock, rebased on a conflict), the destinations check (`split.destinations`, before anything leaves the source:
`SPLIT_DESTINATIONS_UNVERIFIED`), the source's edits (a core rebase), universal material's Dependency, index lines,
remapped Dependencies, Last Major Revision per page, the pack's read-back, and the verification (`split.verify`:
`SPLIT_VERIFY_FAILED`). A stop is resumable (Resume, its destinations check run again first) and revertible (Revert: the
job puts back what it changed, whole or not at all: a target that cannot go back refuses it, `SPLIT_REVERT_NOT_WHOLE`;
the pages it made go to ONE deletion proposal once the material they took is back in the source, each only while it is
exactly as the split made it, checked again when the deletion runs). CR-2026-11-R3: "moved verbatim" is checked on each
block's whole content; an item's later appends to an existing owner are core (the job stops, resumable, rather than skip
it part-way); a source holding an inline icon is refused (`SPLIT_NOT_WRITABLE`), and so is an image assigned as universal
material (`SPLIT_VISUAL`).

**Verified** (CR-2026-11-R3, R3-67) is the job's own verification, never the split's: every read-back of the job's
writes and its final verification (a mention compared by its target, `resourceId` and `documentId`, and by its label
where the bridge wrote one: X2 showed a label sent is kept; the name, and a label LegendKeeper fills in where none was
sent, are not compared). A job that ran to its end but read back a difference makes the split `unverified`: nothing is
retired, and `report` says `verified: false` with the job to look at. A split resumed after a write that read back a
difference reads that write back again first (ADR 0061 part B decision 6): put right by hand since, it counts as
verified.

**Phase 2**: with `retire`, once phase 1 has verified and nothing was left out or skipped, the bridge proposes
archiving the source with `archive_page`'s own plan (a separate canonical proposal, owner-forced). Never a delete.
`{ report }` (a split's id, proposal or job) answers its state, its destinations and phase 2 (or why there is none), free.

**`write_page` and splits.** On a project whose approved pack has split rules, an edit that takes `splits.guardWords`
(120) words or more off a pack page (a page of a character's set, a page with a Subject fact, a pack owner) is refused
with `USE_ARKONA_SPLIT` (`hint`, `useTool: "arkona_split_owner"`, `removedWords`); nothing is written.
`plainEdit: { reason }` lets a page's own revision through; the reason is in the job's title and journal and on the
proposal. `arkona_create_character`'s `split` is refused with the same code.

### Costs (measured against the mock)

| Call                                                                                | Requests                                                                          | Writes |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| `arkona_split_appraisal`                                                            | 0 (`live: true`: 2 a page, at most 25)                                            | 0      |
| `arkona_split_owner`, a character monolith: plan (dry run)                          | 13 (10 the plan's own, 3 the pack's governance)                                   | 0      |
| the same, proposed                                                                  | 26                                                                                | 0      |
| its job (six new owners and a new index, the Core upgrade, one remapped Dependency) | 248 (estimated 175 reads)                                                         | 89     |
| `arkona_split_owner`, an owner with two domains: proposed                           | 12                                                                                | 0      |
| its job (one new owner, one existing owner, two remapped Dependencies)              | 84 (estimated 58 reads)                                                           | 22     |
| phase 2                                                                             | `archive_page`'s own (about 6 reads to propose, then about 15 reads and 8 writes) | 8      |
| a conflict on an existing owner's append (LegendKeeper answers 412)                 | one more read, and the write again                                                | 1      |

## Setting packs: retagging (v3 F3f)

[ADR 0060](adr/0060-v3-f3f-retag-audit-and-apply.md). The agent guide's part is "Arkona retagging" (under "Setting packs
(Arkona)"). Both tools need the pack version `arkona-2026-11-19-f3f` (its retag rules), approved on the Packs page; until
then they refuse (`RETAG_UNAVAILABLE`, or `PACK_NOT_CURRENT` while the pack is not approved or its governance drifted).
They build what the Controlled Native Tagging Standard asks of the Bridge: a read-only policy audit, a separately
approved guarded apply, and resumable reconciliation. One engine (src/packs/retag/engine.ts) gives every verdict, and the
audits' tag findings come from it too ([audits.md](audits.md)).

### `arkona_retag_audit`

Read-only and free (the snapshot overlay; `live: true` re-reads each page, one `getResource` each, at most 50). Input: one
of `page`, `under` or `all: true`; or `runId` (a stored run, read again with `filter`, `offset`, `limit`); or
`reconciliation: "<name>"` (starts a named reconciliation with this scope, default everything, or audits an open one
again); `detail: "full"` adds each page's inputs; `suggest: { page, primary, specialist?, reason }` records a suggested
classification for a hold (for the owner; never used by itself); v3 F5a: `suggestRuling: { page, tag, action: keep_here
| allow_everywhere, reason }` records a suggested ruling on an exception (only the owner keeps a tag on a page or allows
it everywhere, on the Tagging page).

**v3 F5a** ([ADR 0067](adr/0067-v3-f5a-supplementary-tags-rulings-bulk-actions-and-unknown-outcomes.md), pack version
`arkona-2026-11-23-f5a`): the Tagging Standard's **Approved Supplementary Tags** (Cosmology, Chronology, Setting
Framework, as the approved version lists them) are kept wherever they appear, after the grammar's slots in their
existing order (the rationale slot `supplementary`), never added and never proposed for removal; a page whose only
exception was one is a correction or compliant. A tag the owner kept on a page ("Keep this tag here") is kept the same
way while the page's tags are unchanged. Every correction is in full grammar order (status, primary, specialist, race,
culture, then the supplementary tags), so a page only out of order is a correction like any other.

Each page: `pageId`, `name`, `disposition` (`compliant`, `correction`, `hold`, `exception`; null outside the grammar),
`scope` (`grammar`, `lifecycle`, `excluded`), `current`, `proposed`, `policy` (pack version and digest), `rationale` (each
slot, `status`, `primary`, `specialist`, `race`, `culture` or `other`, with its tag and where it comes from), `holds`,
`exceptions`, `removals`, and, for a Working or Archived page, `lifecycle` (the lifecycle grammar's verdict), or for an
excluded page, `excluded` (why). The run: `runId`, `policy` (`packId`, `version`, `label`, `sources`, `digest`),
`source` (the snapshots and their age, live reads), `counts` (by disposition, lifecycle-only, excluded).

The rules: the scope is current Authoritative Main CANON owners and AU owners (the AU ruling); Working and Archived pages
only for the lifecycle grammar; the Legacy Canon Archive, Design References, navigation indexes and repository
governance never. The primary category comes from the owner's classification, else the page's own pack record, else its
current tags when they hold exactly one valid primary category its Reference Type does not contradict; otherwise a hold
("uncertain category; owner classification needed"). The specialist is on the closed list and backed the same way, else
omitted with a hold. Identity tokens (a Core, a Compact Reference, the eligible references) come from Race / Species and
Naming Culture through their own token maps, typed and de-duplicated; a missing, `Unestablished`, unmapped or
contradictory value omits its slot with a hold. No other tag is proposed; a tag outside the grammar is removed only when
the Standard's Excluded Routine Tags list it, otherwise it is an owner exception. Status and lifecycle tags are never
added or removed; a status tag present is moved first. Cost: none.

### `arkona_retag_apply`

Input: `runId` and `pages` (page ids of that run), or `reconciliation: "<name>"`. Only deterministic corrections, at most
the pack's `retag.batchSize` (25): `RETAG_NOT_DETERMINISTIC` (a hold, an exception, a compliant or excluded page),
`RETAG_BATCH_TOO_LARGE`, `RETAG_PAGE_IN_BATCH` (already in an open batch), `RETAG_POLICY_CHANGED` (the run was made under
another policy), `RUN_NOT_FOUND`. ONE proposal by the pack's switch ("always propose" in the seed), each page an item.
The job: the policy and its governance checked first (one read per source; changed: the whole job stops, "policy changed
since the audit; audit again"); per page a fresh read (conflicted, held, already compliant or inaccessible pages are
skipped and recorded), the write inside the page's lock (judged again there), and an independent read-back (the exact
array in order; name, aliases, parentage and sidebar unchanged; each page document's body at the same version, read
before and after the write, and each board, map and timeline document's content the same way: CR-2026-11-R3, fix C, and the
owner's sandbox run X6, which showed `updatedAt` does not move on a content edit). Each page's disposition is recorded:
`applied` (verified or not), `already_compliant`, `held`, `conflicted`, `inaccessible`. Last Major Revision is never set.
Resume (owner, Jobs page) and Revert (the exact prior array, only where nothing changed since: the page's tags, and since
ADR 0061 part B decision 5 its name and parent, as the job left them) work. With
`reconciliation`: stale pages marked, what remains audited afresh (free), its next batch proposed (`status`: `proposed`,
`nothing_to_propose` or `nothing_remaining`). Cost: none to propose; the job 3 reads for the governance, then 3 reads and
1 write a page.

## Setting packs: briefs and names (v3 F4a)

[ADR 0063](adr/0063-v3-f4a-governance-drift-names-and-briefs.md). The agent guide's part is "Arkona briefs and names"
(under "Setting packs (Arkona)"), and "How to decide" puts both first: a question about a subject starts with
`arkona_brief`, and every character intake and rename includes `arkona_name_check`. Both are read-only and free (the
bridge's tree and stored sidebars, the snapshots, the chronology's tables, the proposals and the findings), listed while
the Arkona pack is attached to a project the bridge serves, and neither writes anything or guesses.

### `arkona_brief`

`{ subject, include?, live?, detail? }`: the brief on any subject (a nation, polity, culture, religion, place, event,
magic system, item), generalising `arkona_character_brief`, to which a character is delegated (`delegated` says so).
`subject` is a name, alias, path or id, resolved in the default scope: a page in the Legacy Canon Archive or the Design
References only with `include` (`SUBJECT_NOT_CURRENT` otherwise); one character's pages, or an index with its own pages,
are one subject; a name the registry does not know is looked for as a page's subject ("Lumen Strand" finds "Lumen Strand -
Polity Reference"); several subjects are refused with the candidates (`AMBIGUOUS`), as `get_resource` refuses them.

| Part                                               | What it holds                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owners`                                           | the index and its pages, or the single owner: each with `lifecycle` (Authoritative, Working, Archived; `au`), Reference Type, Scope, Last Major Revision, tags, and `factsFrom`  |
| `owners[].dependencies`                            | one level, each with its lifecycle and Scope; a `flag` on a Dependency on a Working or Archived page, historical material, or a page no longer there (Project Navigation's rule) |
| `owners[].incomingDependencies`                    | the count, and the first ten (a hundred with `detail: "full"`)                                                                                                                   |
| `owners[].sourceBoundaries`, `…unresolvedMaterial` | the sections as Markdown from the snapshots, cut at 1,500 characters (20,000 full) with a `handle` for `bridge_result_page`                                                      |
| `owners[].relatedSources`                          | each with its lifecycle                                                                                                                                                          |
| `chronology`                                       | the age-table rows naming the subject (a mention, its name or an alias): age, table, date, KCY, how it matched                                                                   |
| `workInProgress`                                   | Working pages that mention or depend on it; pending proposals touching its pages                                                                                                 |
| `findings`                                         | the open audit findings on its pages                                                                                                                                             |
| `freshness`, `leftOut`                             | how old each source is; what the non-current areas held that was left out                                                                                                        |

Every item carries its lifecycle; owners and items are listed apart and never merged across lifecycles. Cost: none;
`live: true` re-reads the head owner's sidebar (1 read).

### `arkona_name_check`

`{ name?, givenName?, surname?, aliases?, namingCulture?, exclude?, detail? }`. **Namesakes**: the current characters
(Authoritative, Working and AU, each labelled; never Archived, nor in a non-current area) sharing the full name, the given
name, the surname or an alias, each with its identity page, Naming Culture, Life State and what matched. Names are
compared without case, accents or prefixes; a full name in either order ("Asagiri Miyabi" finds "Miyabi Asagiri"). An
exact full-name match is a `warning`, a partial one `info`; nothing is refused. `exclude` (names or ids) leaves
characters out. **The naming culture** (`namingCulture`, a value the owner gave): through the approved culture map to its
owner under Arkonan Cultures, that owner's naming sections (cut at 2,500 characters with a handle) and the characters
recorded with it; an unmapped value is reported as such. Every answer points to the East Asian Personal Name Presentation
Standard's tab and states the rule: **never an inference** of a culture, race or nationality from a name, and never a
proposed rename. Cost: none.

**Aliases** (since F4.1, ADR 0064 amendment 2; one parser, `splitAliases`, for the name check, the facts index,
`arkona_as_of`, `arkona_consistency`, `arkona_brief`, the character tools and the rename review): an Aliases fact is
split at semicolons, line breaks and (CR-2026-11-R4, the owner's rule) commas outside brackets ("Rita von Katzen, Yamato"
is two aliases; a comma or semicolon inside a bracket, as a note's date may hold, never splits; a piece that is only a
date is no alias), and each alias loses its trailing
bracketed notes: a date or range, "birth", "birth name", "from …", "earlier birth/family name" and the like ("Rita von
Katzen (4A 99-192); Yamato (from 4A 192)" → "Rita von Katzen", "Yamato"). A bracket that is no note ("Leopold (the
Elder)") stays part of the name.

**In `arkona_create_character` and `arkona_rename`.** A new character's name, and a character's new name (the subject
left out), are checked the same way, free. An exact full-name match is a `NAMESAKE` warning in the preview and the
answer and in the proposal the owner sees (its summary: "namesake: … already goes by this name"; a rename's operation
also lists `namesakes`); a partial match is a note. `CHARACTER_EXISTS` is unchanged.

## Setting packs: consistency and "as of a date" (v3 F4b)

[ADR 0064](adr/0064-v3-f4b-consistency-and-as-of.md), the owner-approved design
[design/F4b-consistency-and-as-of.md](design/F4b-consistency-and-as-of.md). The agent guide's part is "Arkona consistency
checks"; "How to decide" says: a character at a date → `arkona_as_of`; changing a date → `arkona_consistency` first. All
four are listed while the Arkona pack is attached and its approved version has consistency rules
(`arkona-2026-11-20-f4b` or later; `arkona-2026-11-20-f4b1` carries ADR 0064 amendment 1); none writes to LegendKeeper,
and none picks a winner.

**What is read** (pack data, `rules.consistency`: new phrasings are a new pack version, never code). Births, deaths and
the bounds of an attested life from a Temporal Scope field (each `;` clause: "Born Camue 44th, 4A 360", "attested
through 5A 931", "Attested 5A 411–5A 931", "alive … 5A 931", "birth date unestablished"), a Life State of "Deceased"
with a date, prose ("<name> was born on <date>", "<name> died in <date>", a dated line "<date> - <name> is born…") and
chronology rows (the kind and subject from the Historical Event cell, the date from the Date cell, read by its anchor);
and the identity facts Race / Species, Naming Culture, Life State, Personal / Given Name and Family / Surname where a page
whose Subject is the character restates them. A sentence is about someone only when it names them: a name, alias or
Canonical Display Name (either order); a given name alone only on the character's own pages; a name two current
characters share only on one's own pages; never a pronoun. Dates go through the calendar engine with their precision; one
the engine cannot read is reported with the calendar's reason, never guessed.

**Amendment 1** (ADR 0064, from the first live run): **rule A**, a sentence is about the name governing its verb in its
own clause (the name directly before "was / is born", "died / dies", "was killed", with only titles and appositives
between; clauses break at commas, semicolons, a spaced dash and after, when, before, until, while), never another name in
the sentence, on the identity page too; **rule B**, the date is the first date-shaped text after the verb (a day, month
or year form of the calendar; a leading place, "to <parents>" and a trailing "(… KCY)" are skipped): nothing date-shaped
is no fact, and "unreadable" is kept for a date-shaped text the engine refuses; **rule C**, a table row is never read as
its joined cells: the chronology's rows are read by their columns, attributed by rule A (a mention only when its text is
the governing name); **D**, a dateless "Deceased" is a state, "Deceased by <date>" an upper bound on death, "death date
unestablished" a gap; **E**, identity values are compared by their principal value (before the first `;`, `(` or a
spaced dash); **F**, sections (by any heading above them) and chronology rows holding a marker of
`rules.consistency.nonCurrent` ("Pre-Rewrite", "Author-Facing") are left out unless `include: ["pre-rewrite"]`, then
labelled Historical material differs (switched on in `-f4b1`, the owner's ruling). The facts are kept in the bridge's
database (`consistency_facts`, migration `3900`), read from the appraisal's overlay page by page and kept current from
the change snapshots; rebuilt when the phrasings, the characters' names, the calendar or the chronology settings change.

### `arkona_consistency`

`{ subject | under | all, include?, continuity?, live?, runId?, group?, offset?, limit?, detail? }`. For each character
in scope, in its own continuity (or `continuity`): its identity page's value first (its Core or Compact Reference; when
it records none, the first Authoritative restatement, said), then every disagreeing restatement with its page,
lifecycle, section, excerpt and precision. Two dates conflict only when their spans do not overlap (a day is that day, a
year that year, a "c." date widened by `approxMargin`, 5 years). Identity values are compared without case, accents,
punctuation or word order. A chronology row is compared with the same event on a page it mentions (or a page linking to
its table). Groups: `contradictory` (Authoritative against Authoritative, `warning`: also the audits'), `differs`
(Proposal differs from canon: a Working page, `info`), `gaps` ("Unestablished" against a value, `info`), `historical`
(Archived or a non-current area, only with `include`), `unreadable`. Attested bounds are read but never compared (a
page's Temporal Scope may be the time its source covers). AU pages are compared only within their AU; an AU without its
own identity page shows Main CANON's value labelled "inherited from Main CANON". The run is stored (`runId`, read a page
at a time). Cost: none; `live: true` re-reads the identity pages' sidebars (1 read each, at most 25).

### `arkona_as_of`

`{ characters (≤ 25), date, continuity?, window?, live? }`. `date` is a date of the calendar or `now` (the pack's
`present`, 5A 931). For each: `born` (value, precision, page, source) or "birth unestablished"; `elapsedYears`
(`{ years, exact: true }` when both dates are exact days, `{ min, max }` otherwise, "not yet born", or none when the
birth is unknown): **calendar years only, never apparent or biological age**, with the race reference linked for its
maturation rules; `state`: **Alive (recorded)** between the birth and a recorded death, or inside the attested span (from
the recorded birth, or the attestation's own start, to the latest attestation; "alive at" the present attests up to
it; since F4c, a Life State of "Alive" records the life from the birth, or from a recorded return ("Reborn <date>"),
to the present, but never across a recorded death: after the last death with no return it is **Unestablished (recorded
death; current Life State Alive)**, and, since CR-2026-11-R4, between one life's death and the next life's start
(a return, a restoration, a later life's birth) **Between lives (recorded)**, a date on a recorded death or a life's start
**Unestablished**), **Deceased (recorded)** after a recorded death with no later life, **Deceased (recorded by <date>)** at or after a Life State's "Deceased by <date>" (with `deceasedBy`; an
upper bound, never compared), **Unestablished** otherwise (an attested life never proves survival past it); in an AU
with no identity page of its own, a state decided by Main CANON's values carries `label: "inherited from Main CANON"`; `around` (the chronology rows naming it, `window` each side, default 3); and `contradictions` on its birth or
death. Since F4.1 (ADR 0064 amendment 2): a Life State whose principal part STARTS with "Alive" or "Living"
(`aliveValues`) records the character alive, and a date there ("Alive in 5A 931", "Living and immortal at 5A 931",
read by `aliveAt`) attests the life up to that date rather than the present; the Temporal Scope phrasings "living at
<date>" and "present <date>" attest the life through the date; the race reference is the Race / Species value's
principal part, through the pack's race token map, matched in the singular or the plural to a Race Core Reference under
Races of Arkona ("High Elf" → "High Elves - Core Information"). Cost: none (1 read when the chronology's calendar is not
kept yet, through the loader `calendar_date` uses); `live: true` 1 read a character.

Since CR-2026-11-R4 (ADR 0064 amendment 3): **a character with more than one life** (the pack's life phrasings: "First
life <date>–<date>", "second life born <date>", "second-life … death <date>", "restored to life … <date>", and the
returns "Reborn / born again / Returned … <date>") is read life by life, from all of its identity page's dated births,
deaths and starts whatever its Life State. The answer adds `life` (`{ position: "in a life" | "after the restoration" |
"after the death of the life", life }`, or `{ position: "between lives", after, before }`) and `lives` (each life: how it
began and ended, its attestations); `state.why` names the life ("in the second life: …"); `elapsedYears` is counted
within the life the date falls in (`counted`), and none between lives; `died` is the death of that life (with its
`life`). `born` stays the first life's birth (the coverage report counts it). A range of `elapsedYears` that may come
before the birth says so (`maybeUnborn`). In an AU, the AU's own pages come first (its birth, its deaths), else Main
CANON's resolved values, deaths, returns and attestations (its prose and chronology rows too), labelled; each `around`
row of Main CANON's chronology is labelled "inherited from Main CANON".

### `arkona_as_of_coverage`

`{ detail? }`. The current Main CANON characters, each in ONE bucket so the buckets add up to the total (`counts`: a
readable birth, a birth deliberately unestablished, attested bounds only, nothing readable; `sums` says so), with a
recorded death and an unreadable birth counted as separate flags (`flags`); those with nothing readable are listed.
**Since F4.1, read with the same resolver as `arkona_as_of`** (the identity page's Temporal Scope, Life State and its own
prose, then the chronology rows and the other Authoritative pages restating the birth or death by name or alias), so a
character is a readable birth exactly when `arkona_as_of` finds a birth; `detail: "full"` adds `byCharacter` (each
character's bucket, and the birth's value, page and source). A report, never a task list. Cost: none (1 read when the
chronology's calendar is not kept yet).

### `arkona_consistency_suggest`

`{ findingId, value, reason }` (a `cf_…` id from `arkona_consistency` or the audits): records the agent's suggestion,
shown to the owner beside the finding on the Audits page. It changes nothing and proposes nothing (access `write`: it
writes the bridge's own record). Agents can never pick.

### "Pick the right value" (the owner's, on the Audits page)

`POST /api/admin/audits/findings/:id/consistency-pick` `{ side, shown? | value, confirm: true }`, a step-up action (ADR
0062). `side` is one of the values the dashboard shows (the audit's stored values; anything else is `SIDE_NOT_FOUND`) and
`shown` its value as shown (the dashboard sends it): when the side reads otherwise now, the pick is refused with
`SIDE_CHANGED` and nothing is proposed. A typed `value` must read, whole, as ONE date of the calendar (a range, or a line
break, is `VALUE_UNREADABLE`); the calendar's own reading of it is written. The bridge makes ONE proposal of items, one
per page that disagrees with the pick: a sidebar field's date replaced inside the field (`set_facts`' plan), a sentence's
date replaced in its one text run (`write_page`'s block-by-block path), a chronology row's date through
`update_timeline_event`'s own plan (its Date and KCY cells and its timeline event together). **Each edit is placed where
the check read the value, never searched for** (CR-2026-11-R4): the sentence (or the field's `;` clause) the check read,
found exactly once on the page as it is now, the date at its place there, whole and in one text run; only that run is
edited, and every other run of the paragraph or field (a line break, bold, a link) is kept. An identity value keeps its
qualifier: only its principal part (before the first `;`, `(` or spaced dash) is replaced. Each item shows the whole
sentence or clause before and after. Not planned, and listed with why: a sentence or clause changed since the check, or
written twice; a date split by a mention or formatting; a field holding a mention; a restatement inside a quotation
(never edited, as for renames); a chronology row whose Date cell (or Historical Event) changed since the check (the newer
date is kept); a page Archived, or filed under the Archived area, the Legacy Canon Archive or the Design References, since
the check (each page's name, parent and tags are read live, and checked again inside the job's locks before it writes the
page). The side picked, and every value agreeing with it, is never touched; a gap or a value inherited from Main CANON is
listed and left. Approval (selective, as every itemized proposal), the rails (more than 10 pages asks for the step-up at
approval), Last Major Revision (the engine's rule) and Revert work as for any proposal. Audited `consistency.pick`. Cost
of the planning: 1 read per page (its name, parent and tags), plus 1 for its sidebar or each of its documents; a
chronology row about 9.

## Setting packs: fiction (v3 F4c)

[ADR 0065](adr/0065-v3-f4c-fiction.md), the owner-approved design [design/F4c-fiction.md](design/F4c-fiction.md) (E1 to
E10). The agent guide's part is "Arkona fiction". The tools are listed while the Arkona pack is attached and its APPROVED
version has narrative rules (`arkona-2026-11-20-f4c` or later); until then they are not listed (connected sessions are
told when they are). The narrative layout is pack data (`rules.narrative`): the index names (Narratives, Continuities,
Main CANON), the name patterns, the four templates by name, the tags, the fields by name, the Question Gate's values,
the dateline's separator, the placeholder patterns. Pinned governance: the Workflow's "LegendKeeper Planning and
Manuscript Structure" and the Fiction Writing Reference's "32B. Durable Chapter Persistence in LegendKeeper", both found
by their page names (any dash).

**Narrative pages** (everything under the one Narratives index): no `[BSRC]` or `[BWRK]` prefix (indexes keep
`[INDEX]`), no lifecycle (`promote_page`, `archive_page`, `unarchive_page` and `move_to_working` refuse them with
`NARRATIVE_NO_LIFECYCLE`), tagged `Narrative`, their kind (`Story`, `Story Map`, `Act`, `Act Map`, `Chapter Plan`,
`Chapter`, `Chronology Map`) and `AU` in an AU's story. Exempt from the owner body rules, the completion gate and the
split triggers (`arkona_appraise_owner` refuses one with `NARRATIVE_EXEMPT` and skips Narratives in a branch), the
tagging grammar (`arkona_retag_audit` excludes them, `narrative`), the audits' rules, tags, lifecycle and unclassified
checks. Never canon evidence: the consistency check's facts index is given the snapshots without them, and `arkona_brief`
refuses one (`NARRATIVE_NOT_AUTHORITY`) and never lists one as an owner or a source. `create_resource` under Narratives
makes a page with no prefix and the narrative tags (a `status`, a Status in `facts`, and a tag that reads as a status or
lifecycle tag, AU included, are refused: `NARRATIVE_NO_LIFECYCLE`). **Into and out of Narratives** (CR-2026-11-R4,
[ADR 0065 amendment 2](adr/0065-v3-f4c-fiction.md)): a page or subtree moved into Narratives (or created, copied or
restored there by any route but the narrative tools), or moved out of it, is a proposal at every scope, by every route;
when a page of it carries a lifecycle signal (a `[BSRC]`, `[BWRK]` or `[BARC]` prefix, a status tag, a lifecycle Status)
it needs the owner's canonical approval, and the proposal names the pages that lose (or regain) their lifecycle. No page
is given a narrative index's name (Narratives, Continuities, Main CANON), and the tools never rename the Narratives index.
A story holding a page with a lifecycle signal is left alone by the writing tools (`NARRATIVE_LIFECYCLE_PAGE`); the audit
reports the page (`narrative_lifecycle_page`). A page in Narratives whose name carries a lifecycle prefix is canon filed
there, not fiction: it stays evidence for the facts index and a known name for `arkona_chapter_check`. **The order inside Narratives**: the Story
Map (or a continuity's Chronology Map) first, then acts and chapters by number, plans under their maps by number; every
tool that places a page there and the ordering audit use it.

### Writing (E5): direct at `write`, proposals at `propose`

Each tool's switch on the Packs page is `scope` (the seed): direct at scope `write` (on the Review page, Revertible),
a proposal at scope `propose`; more than 10 pages in one call meets the bulk rail as a proposal. The owner may switch a
tool to `propose`. Templates are resolved by name through the template list; a field a tool needs that a template (or a
page) lacks is refused as `TEMPLATE_MISMATCH` naming it, any other is skipped and listed (`fieldsNotOnTemplate`).

| Tool                                                                                                                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arkona_story_create { continuity, title, acts?, span?, principalCharacters? }`                                                                                   | The story index (`[INDEX] <title>`), its Story Map (first child), and with acts one act index `Act <n> - <Title>` and one `Act <n> Map` under the Story Map per act. Refused: `UNKNOWN_CONTINUITY`, `CONTINUITY_INDEX_MISSING` (the audit proposes it), `STORY_EXISTS`, `RESERVED_WORD` ("CANON"), `NARRATIVE_INDEX_NAME` (a narrative index's name), `NAME_DASH`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `arkona_chapter_plan { story, number, act?, title?, plannedDate?, pov?, questionGate? }`                                                                          | `Chapter <n> Plan` under the act's Act Map (or the Story Map), from the template (its body: the Workflow's headings), with Story, Act, Chapter Number, Chapter, Planned Date, POV, Question Gate (a new plan: `Open`), Planning Status (`Planned`), and the working title in Subject; or the plan of that number updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `arkona_chapter_save { story, number, title?, act?, inWorldDate, place?, pov, charactersPresent, locations, draftStatus, markdown, baseVersion?, overrideGate? }` | 32B as a tool. New: `Chapter <n> - <Title>` in its act (or the story) from the Chapter template, its fields and collections, its text, linked both ways with its plan (the plan's Chapter and Planning Status `Drafted`). Existing: `baseVersion` required (else `NUMBER_TAKEN`), fresh-read, revised in place (one resource, one document). The tool writes the dateline (`<In-world Date> · <place>`) as the first line and replaces one the agent put first; the date must be read whole by the calendar engine (`DATE_UNREADABLE` lists the forms). Refused: an act that does not hold the number's position (`ACT_POSITION`), an Open Question Gate (`QUESTION_GATE_OPEN`) unless `overrideGate: { reason }`, which goes on the job's title (the Review page). A plan whose template has no Question Gate field: not enforced, and the answer says so. `readBack`: the chapter read back and compared word for word with what the job sent, to the document it sent it to (CR-2026-11-R4: a new chapter is a template copy whose documents LegendKeeper lists in no stated order, and whose kept template blocks are written with it), `compared` saying so. |
| `arkona_chapter_insert { story, at, act?, title }`                                                                                                                | Every chapter and plan numbered `at` or more renumbered up by one (names, Chapter Number), and the new chapter's plan made at `at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `arkona_chapter_move { story, from, to, act? }`                                                                                                                   | The chapter and its plan moved to `to` (and into another act when its position says so), the ones between renumbered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Renumbering is ONE job of items (one per page, F3d): each item's check (the page as planned), its rename, its move and
its Chapter Number; a proposal can be approved item by item. Mentions point at pages, so they follow; prose never
changes. Planning gives the event loop a turn every few pages (R3-64).

**The calendar on demand** (since F4.1, ADR 0065 amendment 1): every narrative tool that reads a date
(`arkona_chapter_save`, `arkona_chapter_plan` with a Planned Date, `arkona_story_create` with a span,
`arkona_chapter_context`, `arkona_chapter_check`) loads the chronology's calendar itself when the bridge has not kept it
yet: one `listCalendars` read, through the loader `calendar_date` uses. Only a calendar that truly cannot be read is
still refused, `CALENDAR_UNAVAILABLE` with its message as before and the reason in `loading`.

**Costs** (against the mock): a story with two acts: 2 template reads, about 20 writes; a plan: 1 template read, about 8
writes; a new chapter: 1 to 2 reads (the plan's gate, its sidebar), about 14 writes and 2 reads for the read-back; a
revision: 3 reads and one write per changed field plus the text; a renumbering: 1 read per page, about 2 writes each.

### Reading (E6) and promotion (E7)

| Tool                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arkona_chapter_context { chapter \| plan \| story + number, live? }`         | Free (the snapshots, the tree, the calendar): the smallest sufficient canon for drafting one chapter, as of its In-world Date (or its plan's Planned Date): `arkona_as_of` and `arkona_brief` for its POV, Characters Present and Locations, the chronology rows around the date and open contradictions (from the as-of answers), the plan's Canon Constraints and Question Gate, the previous chapter's closing state (its last section, or its last paragraphs) and its plan's Closing State; every part labelled by its evidence class (the plan and earlier chapters: narrative, never canon).                                                                                                                                                                                                                                                                                                                                                        |
| `arkona_chapter_check { chapter \| story + number, live? }`                   | Read-only (2 reads: the chapter, live; `live: false` reads the snapshots): people (not yet born, recorded deceased, nothing recording them alive at the date); `presence` (listed but not in the prose, in the prose but not listed); ages (`rules.consistency.ages`, when the pack has them) and births or deaths in the prose (the pack's prose phrasings, by name only) against the as-of values; new-lore candidates (capitalised names, never a sentence's first word, resolving to no page outside Narratives, or a page there whose name carries a lifecycle prefix; capped, `candidateCap`) and names resolving only to Archived or Legacy pages; Locations gone or only Archived. An AU chapter is read in its continuity. Each item: `Contradicts canon`, `Not in canon (candidate)` or `Unestablished in canon`. Never edits. Without a full snapshot yet (a new bridge), it and `arkona_chapter_context` refuse `NO_SNAPSHOT` (CR-2026-11-R4). |
| `arkona_promote_from_chapter { chapter, candidates: [{ candidate, as, … }] }` | Canon proposals through the existing tools, whatever the scope: `character` (`arkona_create_character`, status authoritative: its namesake warning carried), `page` (`create_resource`, authoritative), `fact` and `text` on an existing owner page (`set_facts`' and `write_page`'s plans, ONE forced proposal of items, approvable one by one). The agent supplies the content. The chapter is cited in each proposal's note (its summary) only: never a Dependency or a Related Source. Nothing is ever applied by itself.                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Orchestration (v3 F5c)

[ADR 0069](adr/0069-v3-f5c-orchestration-identity-reconcile-query-facts-workstreams.md), building H6 to H8 of the
owner-approved design [design/F5-orchestration.md](design/F5-orchestration.md): each tool does more coordinated work per
approved operation, with the approval boundaries unchanged.

### `arkona_identity_reconcile` (H6, the Arkona pack; write)

`{ items: [{ character, facts }] (at most 100), reconcileTags? (default true), dryRun?, lastMajorRevision?, workstream?,
project? }`, or `{ report: reconcileId | jobId }` (the itemised result, free). One job, one item per character: the
identity page resolved (Character Core, else Compact Character Reference, else the identity-owning Character Reference;
an [INDEX] to its Core; several characters refused with the candidates), read fresh, only the facts given set
(`set_facts`' plan, If-Match chained), the tags recomputed from the new facts by the retag engine under the approved
policy (grammar order, Approved Supplementary Tags kept, the old value's own token replaced), both read back. Allowed: the
six identity facts; `USE_ARKONA_RENAME` for a Canonical Display Name; `PROTECTED_FACT` (with the tool) for Status,
Continuity Type, Continuity and the other protected facts; `UNMAPPED_VALUE` for a Race or Naming Culture outside the
pack's maps; each refuses its item only. A Naming Culture gets `arkona_name_check`'s culture report. A hold or exception
writes no tags (`partly_done`, with why). Inside the job a character changed since it was read is skipped
(`FACTS_STALE`), a failed write fails its item only (the others carry on; the job is resumable), and a changed tag array is
never written over. At scope `write`: direct for 10 pages or fewer; the bulk rail makes more ONE proposal with an item per
character; at `propose`, a proposal (the pack's switch `scope`, in `arkona-2026-11-23-f5c`; always a proposal until the
owner approves that version). Last Major Revision by the owner's rule. When the job ends: each item `done`,
`partly_done`, `skipped`, `failed`, `not_run`, `refused` or `excluded`, with `arkona_consistency`'s findings as
follow-ups. Cost: 1 read per character to plan; per character about 4 reads and 2 writes for one fact and its tags.

Example of a dry run's preview (one item):

```json
{
  "project": "test",
  "status": "dry_run",
  "reconcileTags": true,
  "counts": { "items": 1, "planned": 1, "noChange": 0, "refused": 0, "tagsWritten": 1, "tagsHeld": 0 },
  "items": [
    {
      "character": "Al-Mansur XII",
      "page": { "id": "mkmansur", "name": "[BSRC] Al-Mansur XII - Character Core", "role": "Character Core" },
      "status": "planned",
      "facts": [
        { "key": "Naming Culture", "before": "Menkheti", "after": "Ancient Menkheti", "change": "changed" }
      ],
      "tags": {
        "status": "write",
        "current": ["CANON", "Character", "Human", "Menkheti"],
        "proposed": ["CANON", "Character", "Human", "Ancient Menkheti"],
        "disposition": "correction",
        "replaced": [
          {
            "tag": "Menkheti",
            "why": "the token of the old Naming Culture (“Menkheti”), replaced by “Ancient Menkheti”, the token of “Ancient Menkheti”"
          }
        ]
      },
      "nameCheck": {
        "value": "Ancient Menkheti",
        "mapped": true,
        "token": "Ancient Menkheti",
        "owners": [],
        "members": { "count": 0, "characters": [] },
        "namesakes": []
      }
    }
  ]
}
```

### `query_facts` (H7; read, generic)

`{ fields, type?, tag?, tagMode?, under?, kind?, lifecycle?, name?, characters?, continuity?, format?, limit?, offset?,
cursor?, live?, confirm?, project? }`. The same fields of many pages as a compact table: `columns` once, then `rows` as
arrays (`format: "csv"`: the same as CSV), paged by row (`limit` up to 500; `offset` or `nextCursor`). Fields: any sidebar
fact key, and `id`, `name`, `canonicalDisplayName`, `referenceType`, `scope`, `tags`, `parent`, `path`,
`lastMajorRevision`, `factsVersion`; `coverage` (`ok`, `stale`, `missing`, `live`) and `readAt` are always added, and
`age` gives the tree's last confirmation and the oldest read. `characters: true`: every current identity page of Main
CANON, or of an AU with `continuity`. Free (the tree's stored sidebars); `live: true` re-reads the page of rows (one read
each, an estimate first above 10), and only then is `factsVersion` filled.

```json
{
  "project": "test",
  "continuity": "Main CANON",
  "totalRows": 2,
  "offset": 0,
  "returned": 2,
  "age": {
    "source": "the repository tree’s stored sidebars",
    "tree": { "status": "ready", "confirmedAt": "2026-11-23T16:00:00.000Z", "confirmed": "2 min ago" },
    "oldestRead": "2026-11-23T16:00:00.000Z",
    "oldest": "2 min ago"
  },
  "coverage": { "ok": 2, "stale": 0, "missing": 0, "live": 0 },
  "columns": [
    "canonicalDisplayName",
    "Race / Species",
    "Naming Culture",
    "tags",
    "parent",
    "coverage",
    "readAt"
  ],
  "rows": [
    [
      null,
      "Human",
      "Ancient Menkheti",
      ["CANON", "Character", "Human", "Ancient Menkheti"],
      "Al-Mansur XII",
      "ok",
      "2026-11-23T16:00:00.000Z"
    ],
    [
      null,
      "Genie",
      "Khayali",
      ["CANON", "Character", "Genie", "Khayali", "Cosmology"],
      "Menkheti Desk",
      "ok",
      "2026-11-23T16:00:00.000Z"
    ]
  ],
  "cost": "none"
}
```

### Workstreams (H8)

Every tool that writes or proposes takes an optional `workstream` (at most 80 characters), recorded on the job, its
proposal (the approved job keeps it), each journal entry, and the tool-call log; the result echoes the label in force.
**`bridge_workstream { set? }`** sets (or with `null` clears) this connection's default label, which lapses after 12 hours
with no write using it; with no `set` it says which is in force. **`bridge_workstream_report { workstream? | since? |
principal? | jobIds? }`** (read-only, free) reports in five groups: written and verified (each page, each write with its
versions before and after and who made it, the read-back), accepted but not yet run, deliberately excluded (unticked,
skipped and why, refusals such as `FIX_STALE`), awaiting the author's judgement (pending and conflicted proposals, tags
held), residual inconsistencies (unknown outcomes and how they settled, read-backs that differed, failed jobs, open
findings on the pages touched, consistency follow-ups), and a "still to do" list drawn only from them.

```json
{
  "project": "test",
  "scope": { "workstream": "Menkheti culture split" },
  "cost": "free: the bridge’s own records; nothing was read from LegendKeeper",
  "counts": {
    "jobs": 3,
    "proposals": 2,
    "pagesChanged": 2,
    "pagesVerified": 2,
    "writes": 5,
    "acceptedNotRun": 0,
    "excluded": 1,
    "awaitingJudgement": 1,
    "unknownOutcomes": 0,
    "openFindings": 0
  },
  "groups": {
    "writtenAndVerified": [
      {
        "page": { "id": "mkazar01", "name": "[BSRC] Azar al-Nafir - Character Core" },
        "writes": [
          {
            "journalId": 12,
            "op": "updatePropertyRow",
            "what": "Naming Culture: changed",
            "tool": "arkona_identity_reconcile",
            "versionBefore": "v8",
            "versionAfter": "v9",
            "outcome": "applied",
            "by": { "principal": "pat_…" }
          },
          {
            "journalId": 13,
            "op": "updateResource",
            "what": "tags",
            "tool": "arkona_identity_reconcile",
            "outcome": "applied",
            "by": { "principal": "pat_…" }
          }
        ],
        "verified": true
      }
    ],
    "acceptedNotYetRun": [],
    "deliberatelyExcluded": [
      {
        "kind": "skipped",
        "item": "char:1",
        "why": "conflicted: FACTS_STALE: its sidebar changed since it was read …"
      }
    ],
    "awaitingJudgement": [
      {
        "kind": "proposal",
        "proposalId": "p_…",
        "state": "pending",
        "title": "arkona_identity_reconcile: 1 character (Zahira al-Rachid)"
      }
    ],
    "residualInconsistencies": {
      "unknownOutcomes": [],
      "verificationMismatches": [],
      "failedJobs": [],
      "openFindings": [],
      "consistencyFollowUps": []
    }
  },
  "stillToDo": [
    "Pending proposal p_… waits for the owner: arkona_identity_reconcile: 1 character (Zahira al-Rachid)",
    "Skipped: char:1: conflicted: FACTS_STALE: …"
  ]
}
```

## The calendar and the timelines (v2 D1)

Last Major Revision (v3 F2, v3 F3c): a chronology row added or removed, or its Date or description cell changed
(`create_timeline_event`, `update_timeline_event`, `delete_timeline_event`, `sync_timeline_event`) sets it on the
chronology page; punctuation, a typo or the KCY alone does not, nor does the count fix or a timeline event on its own.
Each of the four takes `lastMajorRevision` ([the rule](#last-major-revision-only-for-real-revisions-v3-f2-v3-f3c)).
`sync_timeline_event` renames an event only to keep a date tail the bridge wrote in step with its row's Date cell (ADR
0049 decision 1; the proposal says `name: "… – old" → "… – new"`).

Design: [ADR 0038](adr/0038-calendar-engine-and-chronology-sync.md). The calendar engine is built from the project's
LegendKeeper calendar definition alone and matches LegendKeeper on every event of the spike's oracle. A chronology event
is three things kept in step: a row of its age's table (the **authority**), an event of its age's timeline (a derived
view) and one in its age's count on the Main table.

**Before any chronology write** the owner reads and confirms the chronology on the dashboard (Chronology page): the
Universal Chronology page, its calendar, its Main document, and per age its "- Table" page, its "- Timeline" document,
that timeline's one lane and its Main row, plus how the tables write dates and KCY values (learned from the rows). Until
then, or when a confirmed document has gone, been renamed or changed type, the four event tools refuse with
`CHRONOLOGY_NOT_CONFIGURED` or `CHRONOLOGY_CHANGED`.

| Tool                    | Access | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_date`         | R      | `date` (any accepted form, in either style), `minutes` (with `detail`, `endMinutes`) or `kcy`: the form, shape and detail, minutes, KCY (and its table text), the age, and the date's text in **both styles** (`formatted`: LegendKeeper's, no thousands separator in a year; `tableFormatted`: the table's); or exactly why the date is refused. No request while the calendar is cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `create_timeline_event` | W      | `date`, `name` (timeline), `description` (table; text or `{ markdown }`), optional `age` (to confirm the date's). One job: the row in calendar order, the event (exact minutes, detail, the age's lane, `uri` to the age's table), the count +1. An identical row is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `update_timeline_event` | W      | `event` (its date with its description or name, or `row_id` / `event_id`), and a new `date`, `name` and/or `description`. Another age moves the row and the event and adjusts both counts. Refused when the row and its event have drifted apart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `delete_timeline_event` | W      | `event`, `confirm: true`. Removes the row and the event, count −1; the journal keeps both. v2 E6: with `orphan: true` and `event.event_id` (and `age`), deletes ONLY a timeline event that has no table row: no row, no count change (refused with `EVENT_HAS_ROW` or `PAIRING_AMBIGUOUS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sync_timeline_event`   | W      | `row` (its `date` with its `description` or its opening words, or its `row_id` with its `age`), optional `event_id` (to choose among candidates; remembered), `create_new` (v3 F2.1: a new event although candidates exist), `name`. Repairs the timeline for ONE row, **the table being the authority**: creates the row's event if it is missing (minutes, detail, an end for a range, the age's lane, `uri` to the age's table), or corrects the paired event's minutes, `detail`, shape and `uri` to match the row. Never touches the table or the Main count, never renames an event. A row whose event agrees: `nothing_to_do`. An ambiguous pairing is refused with the candidates. v2 E6: a qualified row's event takes its anchor; a repair that turns a range into a single date or the reverse needs `confirm_shape_change: true`; a table-only row is refused. |
| `create_timeline_lane`  | W      | `page`, `document` (a timeline), `name`, `size`, `color`. Touches only that timeline; refused on the chronology's age timelines (exactly one lane each by design).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

All five W tools take `dryRun`, `operation_id` (C2b's) and `project`, and under `propose` give ONE proposal whose page
shows the change as a Markdown diff of the rows, the count and the event.

**Accepted date forms** (from the calendar's own templates; for Kumikan): `Kumikas 1st, 1A 159` (a day), `4A 881` (a
year), `Unknown, 4A 101` (a year, stored year-only), `Zahras 4A 367` (a month), `Kumikas 19th, 4A 100 - Meshaph 10th, 4A
102` (a date range), `Jehet 11th - 18th, 4A 424` (days of one month), `Isar 20th - Pahan 31st, 4A 32` (days of one
year), `Kumikas - Azaakh, 4A 180` and `Zahras 4A 367 - Attina 4A 367` (month ranges), `4A 881 - 4A 900` (a year range).
Case, ordinal suffixes, extra spaces, the dash and year commas do not matter. `Unknown` alone is refused, as are an
unknown month or era, an impossible day, a date outside its era (before Azah 18th in 4A 1, say) and a reversed range,
each with a precise message (`DATE_*`). A row is written in the form given.

**Two date styles (v2 D1.1, [ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md)).** LegendKeeper writes a
year with **no** thousands separator on events (`Kumikas 1st, AA 1988119`, `Isar 17th, 1A 8501`); the owner's tables
write one (`Kumikas 1st, AA 1,988,119`). `calendar_date` answers both (`formatted` for LegendKeeper's, `tableFormatted`
for the table's; `text` is the table's) and reads either as input. A table Date or KCY cell is always written in the
table style (the one learned from the rows and confirmed by the owner); anything compared with an event's text is
compared in LegendKeeper's. Years under 1,000 read the same in both.

**`sync_timeline_event`: repairing drift.** The chronology check reports a table row with no timeline event
(`row_without_event`) or a row and its event that disagree about the date or shape (`date_mismatch`: a range row with a
single-day event, another year, a missing `uri`). This tool repairs ONE such row, with the table as the authority:

- **Pairing** is the check's: the bridge's own links, then the same date with the event's name the row's description (or
  its start cut short), then the same date alone when a row and an event are the only two on it (the timeline's short
  name differs from the table's description by design), then the same event with a different date (by name or by the
  same start, with no other candidate). A row with **several** possible events is refused (`PAIRING_AMBIGUOUS`, with
  the candidates) and nothing is done; pass `event_id` to choose one.
- **A missing event is created**: the row's minutes and `detail` (1 for a year-only row), an `end` for a range, the age's
  lane, `uri` to the age's table, a short name (the description, cut to 100 characters with `...`; `name` overrides it).
  **A paired event is corrected** in its `start`, `end`, `detail` and `uri`, and keeps its id and its name. A single-date
  row whose event has an end makes the event again (LegendKeeper cannot take an end away). The answer's `changes` says
  what differed.
- **It never touches the table or the Main count** (the row was already counted: that is the drift). The row is
  compared again inside the lock, so a row edited meanwhile stops the job (a proposal ends `conflicted`) and nothing is
  written.
- **Nothing to do**: a row whose event already agrees answers `status: "nothing_to_do"` and writes nothing.
- It is an ordinary edit (not canon); a job at scope `write`, ONE proposal at `propose`. The dashboard's **Propose a fix**
  on each such finding makes that proposal for the owner to approve ([dashboard.md](dashboard.md#chronology-v2-d1)).
- **Chronology II** (v2 E6, [ADR 0048](adr/0048-chronology-ii.md)). A **qualified** row (`c. 4A 563; exact date
unresolved`, `After Isar 6th and before Zarzakh 29th, 4A 610; …`) is read by its anchor
  ([chronology.md](chronology.md)): its event takes the anchor's minutes and precision (a year, a month, a range, or
  one point at the known bound of an open date) and its name is the row's opening words, then `–` and the Date cell as
  written; the cell is never rewritten. The row can be named by its Date cell as the table shows it. **Pairing** is
  scored: links, the same date (with the name, then alone), then for a row and an event that disagree the same start
  and end, the same start and shape, the name, the same start; a candidate is taken only when it is the single best on
  both sides, and a one-day row never takes a range event while a range row starts at the same minute (and the
  reverse). The answer's `pairedBy` says how. A repair that turns a range into a single date or the reverse
  (`shapeChange`: `range → single day`) is refused (`SHAPE_CHANGE_UNCONFIRMED`) until repeated with
  `confirm_shape_change: true`; a dry run shows it. A row the owner marked table-only is refused (`ROW_TABLE_ONLY`).
- **Ties** (v3 F2.1, [ADR 0048](adr/0048-chronology-ii.md)'s F2.1 amendments, [chronology.md](chronology.md#ties-v3-f21)).
  A plain row beats a qualified row anchored on the same day (`pairedBy`: `plain row preferred over qualified
anchor`); a name decides between plain rows only when it names exactly one; ranges of the same start are told apart
  by the year they end in. `PAIRING_AMBIGUOUS` names every candidate's name, date and id in its **message**.
  - `event_id` on an event that already agrees records the row–event link and answers **`linked`** (`action: "link"`,
    `pairedBy: "chosen by the caller"`): a bridge-side record, no LegendKeeper write, audited as a chronology change,
    and still ONE proposal at scope `propose` (summary `link row … to event …`). The check pairs them by the link from
    then on. On an event that disagrees, the correction records the link as before.
  - `create_new: true` makes the row's event although candidates exist; the answer and the proposal name the
    candidates passed over (`passedOver`). With `event_id`: `INVALID_PARAMS`. On a row that already has its event:
    `ROW_HAS_EVENT`.
  - `row: { date, description }`: the description may be the row's opening words, a prefix of exactly one row of that
    date (at least 20 characters, compared after trimming and collapsing whitespace); an exact match still wins. An
    ambiguous prefix: `ROW_AMBIGUOUS` (with the rows); shorter than 20 characters: `ROW_PREFIX_TOO_SHORT`; no row:
    `ROW_NOT_FOUND` (it was `EVENT_NOT_FOUND`), naming the rows of that date. A `row_id` that is not there is
    `ROW_NOT_FOUND` too.

**`delete_timeline_event` with `orphan: true`** (v2 E6). The check's `event_without_row`: a timeline event no row of its
age's table accounts for. `{ event: { event_id, age? }, orphan: true, confirm: true }` deletes only that event, never a
row and never the Main count (the count is the table's row count); without `age` every age's timeline is searched. It
is refused when the event is paired with a row after all (`EVENT_HAS_ROW`: delete both without `orphan`, or repair a
mismatch with `sync_timeline_event`) or when an unpaired row could be its own (`PAIRING_AMBIGUOUS`, v3 F2.1: "This event
is not an orphan: N rows of the table could be its own (…). Pair it with one instead of deleting it."). The check reports
such an event as `event_in_tie`, never `event_without_row`. It is also refused while the age's table has an unpaired row
whose date cannot be read and that is not marked table-only (`ORPHAN_NEAR_UNREADABLE`, naming the rows: ADR 0057
decision 2; mark the row table-only or fix its date). The answer (and `dryRun`) names the event, its date and the
three rows nearest it by date. Inside the lock
the table must still have no row for it, and the event must be as read; the journal keeps the event.

**Calendar order** in a table: by year; within a year the dated rows by their start (a range by its start), then the
year-only rows (and year ranges); a new row goes after the existing rows of the same date. The place and the new count
are decided inside the job's lock from the documents as they are then, so concurrent writes and several approved
proposals for one age all land correctly.

**Refusals** besides the date's: `AGE_MISMATCH`, `AGE_NOT_CONFIGURED`, `DUPLICATE_EVENT`, `EVENT_NOT_FOUND`,
`EVENT_AMBIGUOUS`, `PAIRING_AMBIGUOUS`, `EVENT_TAKEN`, `EVENT_MISMATCH`, `ROW_MISMATCH`, `ROW_DATE_UNREADABLE`,
`SHAPE_CHANGE_UNCONFIRMED`, `ROW_TABLE_ONLY`, `EVENT_HAS_ROW` (v2 E6), `ROW_NOT_FOUND`, `ROW_AMBIGUOUS`,
`ROW_PREFIX_TOO_SHORT`, `ROW_HAS_EVENT` (v3 F2.1), `ORPHAN_NEAR_UNREADABLE` (ADR 0057 decision 2),
`CHRONOLOGY_DRIFT` (repaired by `sync_timeline_event`), `CHRONOLOGY_INCOMPLETE` (another change of the age stopped part-way),
`CHRONOLOGY_IN_PROGRESS`, `CHRONOLOGY_RESUME_CONFLICT`, `CHRONOLOGY_TIMELINE` and `LANE_EXISTS`.

**Stopped part-way.** The answer says which writes were made. The same request again makes only what is left
(`resumes` in the answer); until then other changes of that age are refused. The owner can mark a stopped change
resolved on the Chronology page.

**Canon.** These are ordinary edits on the Authoritative chronology page, never canon-gated (ADR 0036 decision 6,
option (a)); only deleting a whole timeline document of an Authoritative page is canonical.

### Costs (reads and writes, measured against the mock)

| Call                                    | Reads | Writes |
| --------------------------------------- | ----- | ------ |
| `calendar_date` (calendar cached)       | 0     | 0      |
| `create_timeline_event`                 | 10    | 3      |
| `update_timeline_event`, same age       | 9     | 3      |
| `update_timeline_event`, another age    | 18    | 6      |
| `delete_timeline_event`                 | 12    | 3      |
| `sync_timeline_event`, a missing event  | 7     | 1      |
| `sync_timeline_event`, a correction     | 6     | 1      |
| `delete_timeline_event`, `orphan: true` | 8     | 1      |
| `create_timeline_lane`                  | 2     | 1      |

`sync_timeline_event` reads 3 to plan (the calendar, the table, one page of 100 events), then in the lock the table, the
event (and, for a new event, the lane) and 1 to verify; a proposal made from the dashboard costs the 3 planning reads
only. Add one read per 100 events of the age's timeline when an event is found by its row (update and delete). A dry run
costs the planning reads only (3 to 5). `orphan: true` reads 3 to plan (the calendar, one page of events per 100, the
table; one more page per age searched when no `age` is given), then the table and the event in the lock, the event's
journal pre-image, and 1 to verify. Since E1a every timeline write is followed by its change snapshot's re-read of the
timeline (3 reads and 1 per 100 events), not counted above.

## Maps (v2 D2)

`create_map_feature`, `update_map_feature` and `delete_map_feature` change the pins, labels, regions, paths and folders of a
**map** document of a page inside the AI REPOSITORY; `update_document` gives a map its image; `read_document` reads a map.
Design: [ADR 0040](adr/0040-map-feature-tools.md). Features are ordinary edits: **not canon-gated, even on an Authoritative
page** (ADR 0036 decision 6, option (a)); only deleting the whole map document of an Authoritative page is canonical.

| Tool                 | Access | What it does                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_map_feature` | W      | `page`, `document` (optional when the page has one map), `type`, `name`, coordinates (below), `link`, `folder`, `after` / `before`, `hidden`, `style`, `allowOutside`, `dryRun`, `operation_id`. One job: the check inside the lock, the write, the verify.                                                                                                          |
| `update_map_feature` | W      | `feature` (an id, or a name with `featureFolder`, the folder it is in now or `null` for the top level), then any of `name`, coordinates, `link` (`null` clears it), `folder` (a folder, or `null` for the top level: sent as `parentId: ""`, never `null`), `after` / `before`, `hidden`, `style`. Only what differs is sent; nothing to change answers `no_change`. |
| `delete_map_feature` | W      | `feature` (as above), `confirm: true`, `cascade`. A folder that holds features is refused (`HAS_FEATURES`) unless `cascade: true`; the answer lists everything removed and the journal keeps every removed feature in full.                                                                                                                                          |

**Coordinates.** A pin or label takes `latlng` `[lat, lng]` **or** `pixel` `{ x, y }`; a region takes `points` (one polygon, 3
or more) or `polygons` (several); a path takes `points` (2 or more); a folder none. Each point of `points` is `[lat, lng]` or
`{ x, y }`, all one kind. **Never both kinds in one request** (`COORDINATES_BOTH`).

- **Pixels** count from the image's **top-left corner** (x to the right, y downwards). They are converted with the map's live
  image, read inside the job: `pos = [north - y·(north - south)/height, west + x·(east - west)/width]` (LegendKeeper's own
  formula; the app's frame is `[-y / 2^z, x / 2^z]` with `z = ceil(log2(max(width, height) / 256))`). If the image was replaced
  between the plan and the write the job is refused (`FRAME_CHANGED`) and nothing is sent.
- **Pixels are refused on a legacy tiled map** (no single image: pixels mean nothing) **and on a map with no image**
  (`PIXEL_NEEDS_IMAGE`), with a message saying to use `latlng`.
- **Outside the image** (pixels) or the map's bounds (lat/lng) is refused (`OUT_OF_BOUNDS`, listing the points) unless
  `allowOutside: true`.

**Link.** `link` is a page by name or id, or `{ page, document }`, and becomes `lk://resources/<id>` or
`lk://resources/<id>/docs/<documentId>`. Names resolve as write targets do (C2b): an ambiguous name is an error listing each
candidate with its role, never a guess; the page (and document) is checked to exist and not be deleted (one read). A page just
created in the app can take a few seconds to become linkable. `link: null` clears the link explicitly.

**Folder.** `folder` is the parent, by name or id; a name that matches more than one folder is refused with each one's path.
Moving into another folder (or out, `folder: null`) is `update_map_feature`'s `folder`. `folder: null` works: the bridge sends
`parentId: ""`, which is how LegendKeeper moves a feature to the top level (it refuses `null`, whatever the schema's "(null =
root)" says; the owner's probe of 12 November 2026). A feature made at the top level reads back with no `parentId`, a moved one
with `""`, and both are the top level everywhere in the bridge. A folder cannot be moved into itself or
beneath itself.

**Place.** A feature goes at the **end** of its parent unless `after` or `before` names a sibling (under the same parent). The
bridge never sorts a map alphabetically: the owner orders it by hand. The rank is worked out inside the lock between the real
neighbours.

**Styles** go in `style` with LegendKeeper's names (`iconGlyph`, `iconColor`, `iconShape`, `iconSize`, `pinImage`, `color`,
`fillOpacity`, `fillStyle`, `borderStyle`, `strokeWidth`, `strokeStyle`, `strokeOpacity`, `textColor`, `textEffect`,
`textEffectColor`, `labelSize`, `labelVisibility`, `visibilityRange`), checked against its enums and `#RRGGBB` formats; one that
does not apply to the type is refused (`STYLE_NOT_FOR_TYPE`).

**`labelSize` is refused** (v2 E5.4, [ADR 0046](adr/0046-e4-owner-decisions.md) decision 14), whatever its value, with
`LABEL_SIZE_UNSUPPORTED` and the reason: LegendKeeper's `createFeature` and `updateFeature` take only `xs` to `3xl` (and
refuse the app's `small`, `medium`, `large`), while `listFeatures` returns only `small`, `medium` or `large` and refuses
(400 `VALIDATION_ERROR`, issue path `labelSize`) to list a map holding anything else. Writing any label size therefore makes
the map unreadable through the API. Set label sizes in the app. The refusal is behind one constant, `LABEL_SIZE_WRITABLE` in
`src/maps/features.ts`, to be lifted when LegendKeeper fixes the API (the sandbox assumption LS1 says when). While it is
off, the engine refuses any `createFeature` or `updateFeature` carrying a `labelSize` (from `lk_api_write` too), and the map
tools' checks, verify and compare-and-swap hash ignore it. A map LegendKeeper refuses to list is refused by the map tools,
`read_document` and `update_document` with `MAP_FEATURES_UNREADABLE` and the advice to set that feature's label size in the
app.

**The compare-and-swap.** LegendKeeper does not version features, so the bridge's own check inside the document's lock reads the
map again and judges the plan's resolved request against it; a feature edited, a folder gone, a sibling gone, a replaced image
or (for a cascade) a feature added since the plan is a conflict and nothing is sent (`VERSION_CONFLICT` with the differences;
under `propose` the proposal ends `conflicted`). **A stopped cascade is resumed, never replayed:** ask again and only what is
left is deleted.

**Map images (`update_document`).** `mapImage` is an asset of the library by id or name (`list_assets`): it sets or replaces the
image, and a **blank** document given one becomes a map. Features keep their `pos`, so a replacement with an image of a
different pixel size **needs `confirm: true` when the map has features**: without it the call is refused and nothing is written
(`CONFIRMATION_REQUIRED`, with how many features will now sit over different pixels and the old and new dimensions); with it
the call goes ahead and the warning (`FEATURES_OVER_DIFFERENT_PIXELS`) stays in the result. The same size, or a map with no
features, needs none. Under `propose` scope the proposal shows the count and sizes, and approving it is the confirmation.
**Nothing is moved automatically**. A legacy map replaced warns that its pixels cannot be compared
(`LEGACY_MAP_REPLACED`).

**Reading** (`read_document`): the header gives `width`, `height` and `bounds`, and each feature its pixel position beside its
`pos`; a legacy tiled map and a map with no image say so and show lat/lng only.

### Costs (reads and writes, measured against the mock)

| Call                                             | Reads | Writes |
| ------------------------------------------------ | ----- | ------ |
| `create_map_feature`                             | 5     | 1      |
| `update_map_feature`                             | 5     | 1      |
| `delete_map_feature`, one feature                | 6     | 1      |
| `delete_map_feature`, cascade of 6               | 11    | 6      |
| `update_document` with `mapImage` (no image yet) | 7     | 1      |
| `read_document` on a map                         | 2     | 0      |

Plan 2 (the map's settings, its features) and check 2, then 1 read to verify; a delete also reads each feature for its journal
pre-image. v2 E1a: each map write's change snapshot adds 2 reads (the page and the map's settings; the verify's feature list is
reused), so `create_map_feature` and `update_map_feature` cost 7 reads, a single delete 8. A `link` adds one read (the page, live). A dry run costs the plan's reads only.

## Images (v2 D3)

[ADR 0041](adr/0041-image-pipeline.md) has the decisions and the threat review. `upload_image` is the tool to use;
`lk_upload_image` (below) stays as it was, for raw uploads.

**A deleted image is not private** (W5, the write-scope rehearsal of 17 November 2026): LegendKeeper keeps serving a
deleted image's file at its old URL, so anyone who has that URL (a page's history, a snapshot, a copy of a page, an
agent's transcript) can still fetch it. Deleting an image takes it out of the library, not off the web. This is
LegendKeeper's behaviour; the bridge cannot change it. For an image that must not be seen again, ask LegendKeeper.

**`upload_image`** `{ data_base64 | url | file | upload_id | staged_id, name?, description?, destination?, stage?,
deduplicate?, dryRun?, waitSeconds?, operation_id?, project }`. Exactly one of the five sources:

| Source        | For                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `data_base64` | Small images inline (a `data:` URI is accepted). A 2 MB image is about 2.7 million characters, so chat assistants should prefer staging.   |
| `url`         | A public https image, through the guarded fetch (`UPLOAD_ALLOW_URL_SOURCE`).                                                               |
| `file`        | v3 F2: a ChatGPT conversation attachment, `{ download_url, file_id, mime_type?, file_name? }`, filled in by ChatGPT (see below).           |
| `upload_id`   | A file sent beforehand to the binary endpoint (`prepare_image_upload`, then its script). Same connection and project, once, within 15 min. |
| `staged_id`   | A staged image to place (from `stage: true`, or the dashboard's Staging page). `name` renames it.                                          |

What happens to the bytes: the type is decided by the file's first bytes (PNG, JPEG, GIF or WebP; a declared type and a
file name are never trusted); bytes, pixels (all frames together) and frames are capped before anything is decoded; a
truncated or corrupt file is refused with the decoder's words; a WebP is stored byte for byte; anything else becomes WebP
at quality 90, the EXIF orientation applied, every frame of an animation kept, no resize, no metadata. Then ONE job:
the missing folders in order, the upload (createImageUpload, the signed PUT, createImageAsset), a download of the stored
file compared by SHA-256 (`storedBytesVerified`; a mismatch or a failed download is reported with `unverifiedReason`, the
asset id is still returned, nothing is retried), and for a staged image `updateAsset { isHidden: true }`.

`destination` (planned, and refused if it cannot work, before anything is uploaded):

- `folder`: an asset folder id, a path from the library's root (`"Characters / Beastkin / Qishen / Mehrana al-Khalid"`;
  `Undetermined / Unknown` is one folder) or a list of names;
- `for_character { name, race?, type? }`: `Characters / Group / Race / Name` (or `Characters / Race / Name` for a race
  with no group), the folder names from the taxonomy's asset folder field, and only that exact path (ADR 0057 decision 8:
  a folder with the character's name anywhere else is never used; a path that is ambiguous or blocked by an asset that is
  not a folder is `ART_FOLDER_AMBIGUOUS`, listed); an unknown or omitted race goes to
  `Undetermined / Unknown`; a declared race that does not resolve fails (`RACE_NOT_FOUND` and the other refusals of
  `create_character`);
- `for_page`: a Core, Reference or character index page under the Characters index gives its character (the race from where
  the page is). **Since v2 E3b** a character's page that is not under the Characters index (a Working or Archived Core,
  Reference or index) or one of its specialist pages (`{name} - …`: any page whose subject, by `subjectOf`, is a
  character) leads to the character too, and the race is the character's **Race / Species** fact on its Core (else its
  Reference), read from the repository tree, else by ONE live read (`getResource` on that page; nothing is written).
  The race rules are those of `create_character`: `Unestablished` (and other unknown values) goes to
  `Undetermined / Unknown`; a race that does not resolve fails (the message says to pass `for_character` or a `folder`).
  Only when no route works does it refuse, and the message says exactly what to pass: `FOLDER_REQUIRED` (no Core or
  Reference for that subject), `CHARACTER_AMBIGUOUS` (several of the same best lifecycle state: never chosen between),
  `RACE_NOT_FOUND` (the Core has no Race / Species), each naming `for_character { name, race }` or `folder`. Any other page
  needs `folder` too (`FOLDER_REQUIRED`);
- `subfolders`: literal folders appended, created in order: a list of names, **or one path string written like the folder
  chain** (`"Wardrobe"`, `"Wardrobe / Qipao"`, Qipao inside Wardrobe). A string is split on `/` and each part trimmed; an empty
  part, `.` and `..` are refused (`INVALID_SUBFOLDER`, before anything is sent). Existing folders are reused, missing ones
  created in order, and a non-folder with the same name is a conflict, as for any folder. The dashboard's Staging page
  takes the same form and shows the full resolved path before placing.

Folders are never moved; a non-folder asset with a needed folder's name is refused (`ASSET_NAME_CONFLICT`). **Since v3
F2** ([ADR 0049](adr/0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 9) folder names are compared
byte for byte, as LegendKeeper stores them (a folder differing only in case or spacing is another folder, and the plan
says a new one will be made), and each folder is **found or created when the job runs**, not when it is planned: inside
the job, under the project's asset-folder lock (held for that step only), the parent's children are read fresh, and a
folder of exactly that name is used instead of creating another. A proposal still says "create folder …" (the plan when
it was written); the job's result (`foldersUsed`, each `found existing folder` or `created folder`) and the journal say
what happened. Two placements into one missing chain (two proposals, two jobs, or one batch) make one chain. A raw
`createAssetFolder` through `lk_api_write` keeps its plain meaning. An image is never placed in the library's root
(`DESTINATION_IS_ROOT`), and an image name already in the destination folder is numbered (`Portrait (2)`).

**ChatGPT's `file`** (v3 F2, ADR 0049 decision 11). The tool's descriptor carries `_meta: { "openai/fileParams":
["file"] }` in `tools/list`: ChatGPT then replaces a conversation attachment given to `file` with a file object (`download_url`
and `file_id` always; `mime_type` and `file_name` sometimes). The bridge downloads the bytes **during the call, at every
scope** (the link expires long before an owner approves anything: at `propose` the bytes are staged at once and only the
placement waits), through the `url` source's guarded transport whatever `UPLOAD_ALLOW_URL_SOURCE` says (ADR 0057
decision 7: `file` has its own switch, the project setting `fileSourceEnabled`, on by default; switched off, a `file` is
refused before anything is fetched, `UPLOAD_FILE_SOURCE_DISABLED`; switching it on asks for the owner's password): https only,
public addresses only, the port allow-list, the DNS answer pinned, no credentials (never the LegendKeeper key),
`UPLOAD_MAX_BYTES` enforced while streaming, a timeout, at most 3 redirects with every hop checked by the same rules.
`mime_type` is never trusted: the magic bytes decide. `name` defaults to `file_name` with its extension dropped; with
neither, `INVALID_REQUEST`. The `download_url` is a capability: never logged, stored, journalled or returned (the answer
says `file: { id, host }`; the request record hashes `file_id`). A link that answers 401, 403, 404 or 410 is
`FILE_URL_EXPIRED` (hint: call `upload_image` again with the same attachment so ChatGPT issues a fresh link; if that
fails, ask the user to attach the image again), never retried. One file per call; the source is recorded as
`chatgpt_file`. Claude ignores the `_meta`.

**Deduplication.** The same original (by its SHA-256) sent again to the same project returns the existing asset, staged
or placed, with `deduplicated: true`, and sends nothing. `deduplicate: false` uploads it again and needs a new
`operation_id`.

**Staging and `propose`** (v3 F2, ADR 0049 decision 10: unapproved images wait on the bridge's server, not in
LegendKeeper, as Arkona's Visual References standard asks). `stage: true` converts the image and keeps the WebP on the
bridge's own disk (`images/staged/`, by SHA-256) with its hashes, size, dimensions, intended destination and
extension-free name: **nothing is sent to LegendKeeper** (`onServer: true`; a new staging upload is refused with
`STAGING_DISK_LOW` below `IMAGE_STAGING_MIN_FREE_GB`). The answer has `staged_id`. Place it later with `staged_id` (the
intended destination unless another is given): ONE job finds or creates the folders, uploads the WebP straight into its
final folder with its final name (createImageUpload, the signed PUT of the server's bytes, createImageAsset), checks the
stored file's SHA-256 (`upload_image.verify`) and reads the asset back (folder, name, not hidden: `placementVerified`);
the server copy is removed once it is placed. **At scope `propose` every upload is staged** and its placement (when a
destination is given) is the proposal: the proposal holds no image bytes (the job reads them from the server when the
owner approves it). A `staged_id` placed at `propose` is a proposal too. Staged images are in no snapshot and no off-site
copy (they are unapproved). An unplaced staged image older than `IMAGE_STAGING_MAX_DAYS` (90; per project:
`imageStagingMaxDays`) is first shown on the Staging page with the date it goes, and removed from the server a week
later; one older than `IMAGE_STAGING_REPORT_DAYS` (30) is reported. Images staged in LegendKeeper before F2 still place
(moved and unhidden) until `npm run images -- migrate-staging --project <name>` moves them to the server; the image
restore of E1a still stages in LegendKeeper (its proposal names the new asset's URL).

Answers: `status` (`uploaded`, `staged`, `placed`, `proposal_captured`, `deduplicated` with the earlier asset, `queued`,
`waiting_budget`, `dry_run`), `asset { id, name, url, folderId, folderPath, hidden }`, `storedBytesVerified`, `image`
(original format and size, width, height, frames, alpha, WebP size and hash, conversion, quality, orientation applied),
`destination` (path, folders created), `staged_id`, `jobId`, `proposalId`. Put the image on a page with `write_page`:
`![alt](url)` (same-project assets only).

Codes before any job: `INVALID_REQUEST`, `UPLOAD_SOURCE_INVALID`, `UPLOAD_TOO_LARGE`, `UPLOAD_NOT_AN_IMAGE`,
`UPLOAD_URL_SOURCE_DISABLED`, `UPLOAD_URL_REFUSED`, `UPLOAD_URL_FAILED`, `FILE_URL_EXPIRED`, `UPLOAD_ID_UNKNOWN`,
`UPLOAD_NOT_RECEIVED`,
`UPLOAD_ID_USED`, `UPLOAD_EXPIRED`, `IMAGE_EMPTY`, `IMAGE_TYPE_UNSUPPORTED`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_MANY_PIXELS`,
`IMAGE_TOO_MANY_FRAMES`, `IMAGE_TRUNCATED`, `IMAGE_CORRUPT`, `IMAGE_CONVERT_TIMEOUT`, `IMAGE_CONVERTER_BUSY`,
`DESTINATION_REQUIRED`, `INVALID_DESTINATION`, `FOLDER_REQUIRED`, `PAGE_NOT_UNDER_CHARACTERS`, `ASSET_TREE_NOT_READY`,
`AMBIGUOUS_FOLDER`, `ASSET_NAME_CONFLICT`, `RACE_NOT_FOUND`, `STAGED_NOT_FOUND`, `STAGED_NOT_READY`, `ALREADY_PLACED`,
`STAGED_BUSY`, `STAGING_DISK_LOW`, `DESTINATION_IS_ROOT`; after: `UPLOAD_FAILED`, `PLACE_FAILED`.

**`prepare_image_upload`** `{ sha256, byte_length, content_type, name, project }` (scope `write` or `propose`). Not for
ChatGPT or any assistant whose code environment cannot reach the bridge: ChatGPT uses `upload_image`'s `file`. An
`upload_id`, a single-use capability (256 bits; once, 5 minutes, only that file in that project for that connection),
the endpoint (`POST <BRIDGE_PUBLIC_URL>/uploads/<upload_id>`, the capability in `Authorization: Upload <token>`, never in
the URL) and two scripts that read a local file, check its SHA-256 and send it: Python with the standard library only,
and curl. The endpoint answers `201 { "status": "received", "upload_id", "sha256", "bytes" }`, or a refusal: `403
upload_refused` for any problem with the capability (one generic answer), `413` for a body longer than prepared (declared
or not), `422` for a different SHA-256, length or magic-byte type, `408` for a body too slow, `429` past the rate limits.
Then call `upload_image` with the `upload_id` within 15 minutes. Rate limits: `IMAGE_UPLOAD_RATE_PER_PRINCIPAL` (since
v3 F7c a runaway brake: 1,000 prepares and 1,000 accepted uploads an hour per connection) and `IMAGE_UPLOAD_RATE_PER_IP`
(60 requests an hour per address that fail authentication or are refused before it; authenticated requests are not
counted).

**Reading.** `list_assets` and `browse_asset_tree` add `bridgeUpload` to an image the bridge uploaded: original format,
width, height, frames, conversion, `storedBytesVerified`, `staged` (and its `staged_id`).

**Asset deletes keep their bytes**, by any route (`lk_api_write`, `lk_api_batch`, `lk_op_deleteAsset`, the Staging
page): before `deleteAsset` is sent the file is downloaded and kept by the bridge (90 days), the journal's pre-image says
where (`keptBytes`), a folder's delete lists its children and keeps their images; if a file cannot be fetched the delete
is refused (`ASSET_BYTES_NOT_KEPT`) unless the owner allows it on the Staging page.

**Costs** (reads and writes to LegendKeeper, measured against the mock): an upload into an existing folder 2 writes, 1
read (the asset tree's re-read) and 1 download (the verification), plus the PUT on the upload tier; each folder created
1 write and 1 read more (and 1 read to find it when the job runs); staging nothing (v3 F2: it stays on the server);
placing a staged image the upload's 2 writes, 2 reads and 1 download; a
deduplicated call nothing; an image delete 1 write, 2 reads and 1 download. Conversion is local: about 3 s for a 12 MP
photo, one at a time.

## Image archives (v3 F7c)

[ADR 0075](adr/0075-v3-f7c-image-archives.md) has the decisions. A zip of images is staged entry by entry; everything is
on the bridge's own server until a placement job runs.

**`upload_image_archive`** `{ file | upload_id, character?, stageAll?, operation_id?, project }`. `file` is ChatGPT's
attachment (`_meta["openai/fileParams"]: ["file"]`); `upload_id` a zip sent to the binary endpoint
(`prepare_image_upload` with `content_type: "application/zip"`). The zip is kept under a name the bridge chooses and read
from disk one entry at a time (yauzl). Every entry is **listed** at once: `entry` (its base name), `path`, `folder`
(null at the top level), `suggestedOutfit` (the folder name with separators normalised), `size`, `format`, `width`,
`height`, `sha256`, `status`. Nothing is converted until an art call uses the entry, or `stageAll: true`.

| Status       | Meaning                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `listed`     | Read, not converted; counts against no limit.                                                                      |
| `queued`     | Asked for; waiting for a conversion slot (`queuePosition`).                                                        |
| `converting` | Being converted (through the one conversion queue: IMAGE_CONVERT_CONCURRENCY).                                     |
| `held`       | Past the hourly brake (`heldBy: "rate"`, `expectedAt`) or the staging capacity (`heldBy: "storage"`); waits.       |
| `staged`     | A staged image (`staged_id`).                                                                                      |
| `refused`    | Never stageable: unsafe path, encrypted, nested archive, not an image (by its bytes), too large, ratio over 100:1. |
| `failed`     | A conversion failed (`reason`); retried once automatically, then with `bridge_archive_status { retry }`.           |
| `duplicate`  | The same bytes as an earlier entry (`duplicateOf`).                                                                |
| `discarded`  | Its archive was discarded (or expired) first.                                                                      |

The whole archive is refused with one error only when the zip cannot be read (`ARCHIVE_UNREADABLE`), holds more than
IMAGE_ARCHIVE_MAX_ENTRIES entries (`ARCHIVE_TOO_MANY_ENTRIES`), unpacks to more than IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES
(`ARCHIVE_TOO_LARGE`), or unpacks to more than 100 times its size (`ARCHIVE_BOMB`). `__MACOSX/` and hidden files are
skipped. The same zip again (same SHA-256 in the project) is the same `archive_id` and entries; an entry whose bytes are
already staged reuses that staged image. With `character`, each distinct folder is checked against the character's
outfits (F7's matcher): `outfitMatch` `exact` (with `outfit`), `near` (with `candidates`) or `new`; top-level entries are
never classified, and a character that does not resolve is reported in `character`, not an error.

**`bridge_archive_status`** `{ archive_id?, retry?, project }` (free). The rows of one archive, or this connection's
recent archives; the three limits kept apart: `holding` (IMAGE_STAGED_MAX_BYTES), `processing` (the conversion queue) and
`brake` (IMAGE_UPLOAD_RATE_PER_PRINCIPAL); LegendKeeper's budgets are `bridge_budget`'s. `retry` (write or propose scope)
converts failed entries again; nothing already staged is redone.

**In the art tools.** `arkona_add_character_art` and `arkona_create_character`'s art pages take an image as
`{ archive: { id, entry }, label, interpretation }` instead of `staged_id`. A staged entry is used exactly like its
`staged_id`. Any other entry still stageable is asked for and given a reserved staged id: the call is planned from its
header, and the approved job waits (`waitReason.held: "waiting_staging"`) until it is staged. An entry refused, discarded
or failed is left out with its reason (`IMAGE_NOT_USED`), never the others; one discarded while the job waits is
withdrawn when the job runs (its upload steps are recorded as skipped, its blocks left off the Art page).

## Snapshots and restores (v2 E1a)

v3 F2 (ADR 0049): a restore that changes a page's text sets its Last Major Revision (v3 F3c: when the change is a major
revision, measured when it runs; `lastMajorRevision` overrides); `list_snapshots` gives a partial
snapshot's missing pieces in summary (`missing: { total, thisPage, otherPages }`); a page deleted in the app is restored
when a full or change snapshot holds it, judged by that snapshot's state; a recreate that stopped part-way is finished by
the same request again (only what is missing). Details: [snapshots.md](snapshots.md).

[ADR 0042](adr/0042-snapshots-restore-rehearsal.md) has the decisions. The bridge keeps its own copies of every page under
the AI REPOSITORY: a **full** snapshot each week (every page and the asset library), a **change** snapshot after every
bridge write (the pieces it changed), and, when the owner switches it on, a **daily** one for edits made in the app. Each
piece (a page's settings, its sidebar, each document, each image's bytes) is stored once, by the SHA-256 of its canonical
form.

**`list_snapshots`** `{ page, piece?, limit?, project }` (read, free): the snapshots of a page (a name or id; a deleted page
by its id), of its sidebar (`piece: "sidebar"`), its settings (`"settings"`) or one document (by name or id), newest first:
when, the kind (`full`, `change` and the tool that made it, `daily`), whether it is partial, and for each piece whether it
was first seen, changed, unchanged, deleted or back. No request to LegendKeeper.

**`snapshot_diff`** `{ page, piece, from, to?, project }` (read): the Markdown diff of a document, the sidebar or the
settings from snapshot `from` to snapshot `to` (free), or to the page now (`to` left out: 1 read, plus the document's own
reads). Keep regions show as one placeholder line each; `-` lines are the older state, `+` the newer.

**`restore_snapshot`** `{ page?, snapshot, scope, document?, mode?, ids?, parent?, asset?, updateReferences?, dryRun?,
lastMajorRevision?, project }` (write). **Always a proposal, whatever the scope (`write` included):** nothing is written until the owner
approves it on the dashboard; follow it with `bridge_proposal_status`. `dryRun: true` shows the plan and its diff and
proposes nothing. Scopes:

- `page`: the page's documents back to the snapshot (documents added since are left alone, and said so);
- `sidebar`: the facts property (through `set_facts`' own plan and guards), the link collections and every other
  key-value property, row by row;
- `document` (with `document`: its name or id): one document;
- `deleted`: a deleted page with its content. `mode: "undelete"` (or `auto` while LegendKeeper still keeps it, taken as
  `SNAPSHOT_SOFT_DELETE_DAYS`) restores it, and a second proposal then brings its content back to the snapshot;
  `mode: "recreate"` makes it again under its snapshot parent (`parent` when that is gone), with its **original ids**
  (`ids: "original"`, the default) where LegendKeeper takes them, else new ones (`ids: "new"`); the result maps old ids
  to new;
- `image` (with `asset`: the deleted image's old asset id; no `page`): the image comes back as a **new asset with a new
  URL**. v3 F3c ([ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 3): its bytes
  wait on the bridge's server (nothing goes to LegendKeeper, and nothing ever to `LK-Bridge staging`), and the proposal
  describes the image, its folder and its name (`image: { name, path, creates, stagedId }`; no new asset id or URL yet).
  Approved, ONE job finds or creates the folder by its path (a folder deleted since is made again), uploads the image
  straight into it, checks it, and with `updateReferences: true` rewrites the page documents and map images that showed
  the old URL to the new asset (the result lists them; anything else is listed for a hand change). A page that changed
  in the meantime is not rewritten: the job stops after the upload, the asset stays, and the job and the restore's record
  carry an `image_relink_failed` follow-up naming the pages to relink by hand; nothing is retried. The restore's record
  keeps the new asset (`plan.newAsset`).
  The deleted asset's old URL may still serve its file (W5): a restore does not make the old copy private.

What a restore cannot bring back is in its result and on the proposal, never hidden:

- **Icon names:** LegendKeeper reads an icon as `fas fa-book` but writes it as `book`; a restore or recreate writes the
  bare name (and `update_resource` and the map-feature tools take either form). A name LegendKeeper still refuses does not
  fail the restore: the write is sent again without the icon (its default applies), and the restore record lists it under
  "couldn't be restored exactly" on the Snapshots page.
- **`unsupported` blocks and inline icons** cannot be written by the API: those the live page still holds are echoed by
  id, the rest are listed under `cannotRestore` (lost); a page whose live blocks hold an inline icon is restored block by
  block around it (v2 E4, ADR 0046 decision 1): each icon paragraph stays as the page holds it now (listed when the
  snapshot held it otherwise), and a restore that would have to remove or move one is refused (`RESTORE_NOT_WRITABLE`).
- **Map features and timeline events** have no versions: their restore is checked inside the lock against the planned
  state, and a change in between stops the job instead of overwriting it.
- **Refusals:** `RESTORE_LIFECYCLE` (the restore would change a page's lifecycle state, prefix, Status or status tag: use
  the lifecycle tools first); `SNAPSHOT_NOT_FOUND`; `SNAPSHOT_PIECE_DAMAGED` (the stored piece failed its check: a finding
  on the Snapshots page); `PAGE_DELETED` (restore it with scope `deleted`); `RESTORE_PARENT_GONE`; `IMAGE_NOT_DELETED`.
  A restore that makes something canon (a Status to Authoritative, a protected Continuity change) needs the owner's
  canonical approval.

**Costs** (measured against the mock): a full snapshot about 2.2 reads a page; the change snapshot after a write adds
0 to 4 reads (`write_page` 1, `set_facts` 0, `create_document` 2, `update_document` 2, `create_map_feature` 2, a timeline
event through `lk_api_write` 4, the lifecycle tools 0): it reuses the verify step's read. Planning a restore costs 1–2
reads plus the documents' own; the restore itself is the writes it lists, with their verify reads.

## Audits (v2 E2)

[ADR 0044](adr/0044-audits.md) has the decisions. The bridge audits each project after every nightly full snapshot: it reads
the newest complete full snapshot (and the change snapshots after it), the type registry, the lifecycle records and the
chronology check's last run, and **never LegendKeeper**, so an audit costs no request. An audit **never changes
anything**; it reports. The owner sees the findings on the dashboard's Audits page.

**`audit_findings`** `{ category?, code?, severity?, page?, new?, acknowledged?, state?, limit?, offset?, detail?,
project }` (read, free): the findings, errors first, with the latest run (its snapshot, how old that snapshot is,
whether it is stale) and the counts by category. Filters: `category` and `code` (one or several), `severity`, `page` (a page
id, or a fragment of its name or path), `new` (first seen in the latest run), `acknowledged` (`hide`, the default, `only` or
`include`: the owner's acknowledged findings stay hidden while their evidence is unchanged), `state` (`open`, `gone` or
`all`). Paged: `limit` (default 25, at most 100) and `offset`; the answer gives `nextOffset`. `detail: "full"` adds each
finding's **evidence** (what was expected and what was found). Each finding says which snapshot it came from and its age in
minutes: **it may not show edits made since**. A finding that has a fix says so (`fixAvailable`); only the owner applies it,
with the dashboard's "Propose a fix".

Categories: `rules` (no rule matches a page, several do), `template` (a page's sidebar and tabs against its template's),
`tags`, `references` (missing, deleted or inaccessible links; an Authoritative page linking to an Archived one),
`unclassified`, `ordering`, `taxonomy`, `facts`, `lifecycle`, `keep_regions` (paragraphs with line breaks, inline icons,
`unsupported` blocks, collections), `chronology`, `assets`, `governance` (v3 F4a: the governance pages against the bridge:
an unknown tool or old bridge call, an external skill, a missing reference; report only, with the suggested replacement:
[audits.md](audits.md#governance-drift-category-governance-v3-f4a)) and `audit` (about the audit itself: a stale
snapshot).

**How an agent acts on a finding.** A finding is a report, not an instruction, and it may be out of date.

- Read the page (`get_resource`, `read_document`) before changing anything.
- Fix it with the ordinary tools, which go to proposals as usual: `set_facts` for a wrong fact or Reference Type, `move_resource`
  for ordering, `write_page` for text, `update_resource` for tags, `set_facts` with `links` for a link. A deleted or missing
  link target is a decision about the page, so ask.
- **Never** work around a **lifecycle** finding (`lifecycle_*`) or anything about canon: the lifecycle tools are the owner's,
  and the owner decides which of the prefix, Status, tag and place is right.
- A paragraph with a line break (`line_break_paragraph`) is kept as a keep region by `read_document`; `write_page` cannot change
  it as text. Tell the owner: the dashboard offers to split it, block by block.
- A page holding inline icons (`inline_icon_page`) is written by `write_page` block by block (v2 E4); only an edit of the icon
  paragraph itself is refused (`PAGE_NOT_WRITABLE`).
- There is no tool to run, edit or acknowledge an audit: the owner does that on the dashboard.

**Costs.** `audit_findings`: none (no request to LegendKeeper). The dashboard's "Propose a fix" re-reads its page first (a
paragraph split 2 reads, a Reference Type fix 3, a re-placement 2 plus 1 per 100 siblings, a tag fix 1) and writes
nothing until the owner approves; "Re-check now" reads the page live (1 read plus one per page document).

## Image upload (v1: `lk_upload_image`)

`lk_upload_image` runs one `upload_image` job of three steps (it needs scope `write`: uploads are not proposable in v1, so at `propose` it, and raw `createImageUpload` / `createImageAsset` calls, are refused before anything is sent; v2 D3's `upload_image` stages instead):

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

| Variable                               | Default                                            | Meaning                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REQUIRE_PROJECT_FOR_WRITES`           | `true`                                             | A write tool called without `project` is refused while the bridge serves more than one project (v2 A1)                                                                                                                                                                                                       |
| `MCP_EXPOSE_PER_OP_TOOLS`              | `false`                                            | Also register `lk_op_<operationId>` for all 89 operations                                                                                                                                                                                                                                                    |
| `MCP_RESULT_MAX_CHARS`                 | `40000`                                            | Results longer than this are stored and returned as a handle                                                                                                                                                                                                                                                 |
| `UPLOAD_MAX_BYTES`                     | `10485760` (10 MB)                                 | Largest image `lk_upload_image` accepts. The `/mcp` request body limit is sized from it (below)                                                                                                                                                                                                              |
| `UPLOAD_ALLOW_URL_SOURCE`              | `true`                                             | `false`: no `url` source; ChatGPT's `file` source has its own switch, the project setting `fileSourceEnabled` (CR-2026-11-R2, R2-45; ADR 0057 decision 7)                                                                                                                                                    |
| `UPLOAD_FETCH_TIMEOUT_MS`              | `15000`                                            | Deadline for fetching an image from a URL                                                                                                                                                                                                                                                                    |
| `UPLOAD_PUT_TIMEOUT_MS`                | `120000`                                           | Per-attempt deadline of the signed-URL PUT (5 s to 10 min), separate from the 30 s LegendKeeper request timeout                                                                                                                                                                                              |
| `OUTBOUND_EXTRA_PORTS_ALLOWLIST`       | empty                                              | Exact `host:port` pairs, comma-separated, that the image fetch, its redirects, the PUT and the CIMD fetch may use besides 443 (v1.0.1). No wildcards; a malformed entry stops the bridge at start-up, naming the entry                                                                                       |
| `IMAGE_MAX_PIXELS`                     | `100000000`                                        | v2 D3: most pixels an image may have, all frames together (sharp's `limitInputPixels`)                                                                                                                                                                                                                       |
| `IMAGE_MAX_FRAMES`                     | `300`                                              | v2 D3: most frames of an animation                                                                                                                                                                                                                                                                           |
| `IMAGE_CONVERT_TIMEOUT_MS`             | `60000`                                            | v2 D3: time limit of one conversion                                                                                                                                                                                                                                                                          |
| `IMAGE_CONVERT_CONCURRENCY`            | `1`                                                | v2 D3: conversions at once (1 to 4)                                                                                                                                                                                                                                                                          |
| `IMAGE_DATA_DIR`                       | `images/` next to `DB_PATH`                        | v2 D3: the private directory of the binary endpoint's temporary files (`upload-tmp/`) and the kept bytes (`kept-bytes/`)                                                                                                                                                                                     |
| `IMAGE_UPLOAD_RATE_PER_PRINCIPAL`      | `1000`                                             | v2 D3: prepares, and accepted binary uploads, per connection per hour; since CR-2026-11-R2 (R2-41) also every image staged on the bridge's server, from any source (the owner's own are not counted). v3 F7c (ADR 0075): a runaway brake (was 30); an archive entry past it is held, a single upload refused |
| `IMAGE_UPLOAD_RATE_PER_IP`             | `60`                                               | v2 D3: requests to `POST /uploads/*` per address per hour; since v3 F7c only those that fail authentication or are refused before it                                                                                                                                                                         |
| `IMAGE_STAGED_MAX_BYTES`               | `5368709120`                                       | v3 F7c (ADR 0075): the staging capacity, the total size staged on the server; an archive entry past it is held, a single upload refused (`STAGING_FULL`)                                                                                                                                                     |
| `IMAGE_ARCHIVE_MAX_ENTRIES`            | `300`                                              | v3 F7c: the most entries an image archive may hold; more refuses it whole                                                                                                                                                                                                                                    |
| `IMAGE_ARCHIVE_MAX_UNCOMPRESSED_BYTES` | `2147483648`                                       | v3 F7c: the most an image archive may unpack to (and its largest file); more refuses it whole                                                                                                                                                                                                                |
| `IMAGE_UPLOAD_BODY_TIMEOUT_MS`         | `120000`                                           | v2 D3: deadline for a whole binary upload body                                                                                                                                                                                                                                                               |
| `IMAGE_UPLOAD_IDLE_TIMEOUT_MS`         | `15000`                                            | v2 D3: longest silence within a binary upload body                                                                                                                                                                                                                                                           |
| `IMAGE_STAGING_REPORT_DAYS`            | `30`                                               | v2 D3: staged images older than this are reported on the dashboard (never removed)                                                                                                                                                                                                                           |
| `ASSET_BYTES_RETENTION_DAYS`           | `90`                                               | v2 D3: how long the bytes kept before an asset delete are kept                                                                                                                                                                                                                                               |
| `LK_ASSET_HOSTS`                       | `assets.legendkeeper.com,assets2.legendkeeper.com` | v2 D3: the hosts asset files are downloaded from (anonymous GET, no key): verification, kept bytes, snapshots. v2 E5.2: a download follows a redirect (at most 3, https only) only to a host on this list; a set list is used as it is, so add `assets2.legendkeeper.com` to it                              |

The governor's per-attempt timeout (30 s) also bounds the PUT.

**Request size (chunk 8).** A base64 image is a third larger than the image, inside a JSON-RPC envelope. The `/mcp`
request body limit is therefore `max(4 MiB, ceil(UPLOAD_MAX_BYTES / 3) × 4 + 256 KiB)`: about 13.6 MiB for the default
10 MiB. (Fastify's own 1 MiB `bodyLimit` does not apply to `/mcp`: the body is left for the MCP SDK, which enforces this
limit, with a `413`, only after the bearer token has been checked.) An image over `UPLOAD_MAX_BYTES` that still fits the
request is refused by the tool with `UPLOAD_TOO_LARGE`. URL sources are not limited by the request size.
