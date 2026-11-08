# MCP tools (chunk 3)

LK-Bridge exposes LegendKeeper to Claude, Claude Code and ChatGPT as a small set of MCP tools. The 89 LegendKeeper operations sit behind a few **meta-tools**, so the tool list stays short; per-operation tools are optional. Every call goes through the job engine and the rate governor, and every result ends with a one-line budget footer.

Source: `src/mcp/tools/`. Design notes: [ADR 0011](adr/0011-tool-layer.md). Authentication: [auth.md](auth.md).

## Agent guidance (the MCP server `instructions`)

> LK-Bridge gives governed access to one LegendKeeper project. Rate budget is shared and finite: every result ends with a budget line. Before a large workload (hundreds of calls) check bridge_estimate, and run multi-step work as one lk_api_batch job rather than a loop of single calls. Read before you write, and pass the version you read as params.ifMatch. Never loop on budget errors: wait until the stated retry time. Never retry a write that returned waiting_budget, queued or proposal_captured; it is not lost: follow a job with bridge_job_status and a proposal with bridge_proposal_status. Results are summaries; ask for detail "full" only when you need the whole payload, and page oversized results with bridge_result_page.

The text is `BRIDGE_INSTRUCTIONS` in `src/mcp/tools/index.ts`; a test checks it covers each point.

## How results look

Every result is one text block: compact JSON, then the budget footer on the last line.

```
{"status":"succeeded","operationId":"getDocumentBlocks","result":{"id":"d1","version":"v3","blockCount":12,"outline":[…]},"requestIds":["lkb.r….1"]}
budget: writes 87/120·min 2,410/3,000·h | all 241/300·min 5,102/6,000·h 48k/60k·d | project 9.8k/12k·h | queue P1:0 P2:14
```

- **Summaries by default.** Lists become `{ count, hasMore, nextCursor, items }` with scalar fields only (ids, names, versions; nested values become counts). A block tree becomes `{ version, blockCount, outline[…], unsupportedBlockIds }`. Pass `detail: "full"` for whole payloads.
- **Handles for big results.** A result over `MCP_RESULT_MAX_CHARS` (default 40,000 characters, far below Claude Code's 25,000-token cut-off) is stored as a job artefact (a succeeded one-step job) and comes back as `{ "status": "stored", "handle": "art_…", "preview": … }`. Page it with `bridge_result_page`.
- **Typed errors.** A failure is `{ "error": { "code", "message", … } }` with `isError: true`. Codes include `WRONG_TOOL_FOR_OPERATION`, `UNKNOWN_OPERATION`, `INVALID_PARAMS`, `VERSION_CONFLICT` (with `currentVersion`), `UNSUPPORTED_BLOCK_LOSS` (with `blockIds`), `CASCADE_CONFIRM_REQUIRED`, `READ_ONLY`, `MEMBER_ADMIN_DISABLED`, `POLICY_DENIED`, `BUDGET_EXHAUSTED` (with `retryAt`), `LK_ERROR` (with `lkCode`, `status`, `requestId`) and the upload codes below.
- **Not errors:** `queued`, `waiting_budget` and `proposal_captured` mean the write is accepted or waiting. Never retry it; follow it with `bridge_job_status`.

## Tool reference

`access` (`read` or `write`) is what the policy layer filters on: a connection whose profile has scope `read` sees only `read` tools, and a direct call to a hidden `write` tool is refused with the read-only message; the engine's policy gate refuses the write in any case ([policy.md](policy.md)). Annotations are what Claude and ChatGPT use to decide what to auto-approve: read tools are `readOnlyHint: true`; write tools are `readOnlyHint: false`.

| Tool                        | Access | Annotations (read-only / destructive / idempotent / open-world) | Cost                              |
| --------------------------- | ------ | --------------------------------------------------------------- | --------------------------------- |
| `lk_api_list_operations`    | read   | true / false / true / false                                     | none                              |
| `lk_api_describe_operation` | read   | true / false / true / false                                     | none                              |
| `lk_api_read`               | read   | true / false / true / false                                     | 1 read                            |
| `lk_api_write`              | write  | false / **true** / false / false                                | 1 write (+ items for createMany)  |
| `lk_api_batch`              | write  | false / **true** / false / false                                | sum of its steps, at job priority |
| `lk_api_paginate_all`       | read   | true / false / true / false                                     | 1 read per page of 100            |
| `lk_upload_image`           | write  | false / false / false / **true**                                | 2 writes (+ upload-tier backoff)  |
| `bridge_info`               | read   | true / false / true / false                                     | up to 2 cached reads (10 min)     |
| `bridge_budget`             | read   | true / false / true / false                                     | none                              |
| `bridge_estimate`           | read   | true / false / true / false                                     | none                              |
| `bridge_job_status`         | read   | true / false / true / false                                     | none                              |
| `bridge_job_wait`           | read   | true / false / true / false                                     | none (waits at most 25 s)         |
| `bridge_job_cancel`         | write  | false / false / true / false                                    | none                              |
| `bridge_errors_recent`      | read   | true / false / true / false                                     | none                              |
| `bridge_journal_lookup`     | read   | true / false / true / false                                     | none                              |
| `bridge_result_page`        | read   | true / false / true / false                                     | none                              |
| `bridge_proposal_status`    | read   | true / false / true / false                                     | none                              |
| `bridge_proposals_mine`     | read   | true / false / true / false                                     | none                              |
| `lk_op_<operationId>` (89)  | per op | derived from the operation, see below                           | that of the operation             |

`lk_api_write` is annotated `destructiveHint: true` because it covers the destructive operations; clients therefore ask before each write.

### Low-level layer

**`lk_api_list_operations`** `{ tag?, kind?, risk? }`: the 89 operations with kind (`read` / `write` / `upload`), risk (`safe` / `destructive` / `admin`), cost class, one-line summary, `versioned`, `paged`.

**`lk_api_describe_operation`** `{ operationId }`: the input JSON Schema (with only the `$defs` it uses), risk, concurrency, whether it is versioned and which read gives the version, rate costs, and the guards that apply. A very large schema (the block model) comes back as a handle.

**`lk_api_read`** `{ operationId, params?, detail? }`: runs ONE operation whose kind is `read`. A write operation is refused with `WRONG_TOOL_FOR_OPERATION` (`useTool: "lk_api_write"`) and costs nothing.

```json
{ "operationId": "getDocumentBlocks", "params": { "path": { "resourceId": "r1", "documentId": "d1" } } }
```

`params` is `{ path?, query?, ifMatch?, body? }`; `projectId` is supplied by the bridge.

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

**Per-operation tools.** With `MCP_EXPOSE_PER_OP_TOOLS=true` the bridge also registers `lk_op_<operationId>` for all 89 operations (105 tools in all, 107 with the policy layer’s two proposal tools). Each takes the operation's own input (`path`, `query`, `ifMatch`, `body`) plus `detail` (and `allowUnsupportedLoss` / `confirm` on writes), runs through exactly the same path, and records its own name as the job's tool. `access` equals the operation's kind. Annotations come from the operation: reads are read-only and idempotent; writes are `destructiveHint: true` when the operation's risk is `destructive` or `admin`, and `idempotentHint: true` for PUT, DELETE, move, restore, assign-block-ids and delete-shapes. This lists about 600 KB of schemas, which is why it is off by default.

### Bridge awareness

**`bridge_info`**: version; project id and name; the key's role (`ADMIN`, `MEMBER` or `unknown`; inferred from `listMembers`, because LK shows member emails to ADMIN keys only); read-only flag (effective, configured, overridden); whether writes are paused or draining, and `canWrite`; writer pool; the calling connection, its profile and its live scope (`read`, `propose` or `write`), and `canWriteAs` (`direct`, `proposal (the owner approves)` or `no (read-only)`). The project name and role come from one lookup shared by every caller and cached for 10 minutes; it runs as the bridge's own work (`system` principal, v1.0.1), so a failure there shows on the dashboard's Errors page under `system`, not in a caller's `bridge_errors_recent`.

**`bridge_budget`**: every tier (used, limit, remaining, seconds to reset, any block after a 429, drift), queue depth per priority, write pacing.

**`bridge_estimate`** `{ reads?, writes?, createManyItems?, priority? }`: projected wall-clock time, the tightest tier, whether it fits today's request budget, with advice. Call it before large workloads.

**Your own work only.** `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_result_page` and `bridge_errors_recent` show only the calling connection's jobs, stored results and errors; another connection's job id or handle answers exactly like one that does not exist. `bridge_journal_lookup` shows every connection's writes (so agents can cross-check each other), each with its principal, profile and approver; job ids appear only on your own entries, and a `jobId` filter matches only your own jobs.

**`bridge_job_status`** `{ jobId?, steps?, status?, limit? }`: one job (status, progress, last error, result, failed steps), or recent jobs when `jobId` is omitted. Signed-URL material is redacted.

**`bridge_job_wait`** `{ jobId, seconds? }`: waits at most 25 seconds, then returns the job as it stands (`done: true` when finished).

**`bridge_job_cancel`** `{ jobId }`: the step in flight finishes; nothing further is sent; finished steps are not undone.

**`bridge_errors_recent`** `{ grouped?, limit?, sinceMinutes?, jobId? }`: failures grouped by operation, code and path (default), or one row each, with LegendKeeper `requestId`s.

**`bridge_journal_lookup`** `{ resourceId?, documentId?, targetId?, operationId?, jobId?, principalId?, profile?, outcome?, withPreImage?, before?, sinceMinutes?, limit?, includePreImage? }`: the write journal, newest first. Since chunk 8 it holds **every** write the bridge sends (creates, inserts, patches, deletes), each with operation, target, time, outcome (`applied`, `not_applied`, `unknown`, `pending`), principal, profile and approver; destructive writes also keep their pre-image. `targetId` also matches every resource a `createManyResources` created. Pages hold `limit` entries (default 10, at most 100); when a page is full, `nextBefore` is the cursor for the next, older page (`before`).

**`bridge_proposal_status`** `{ proposalId }` and **`bridge_proposals_mine`** `{ state?, limit? }`: your own proposals (writes at scope `propose`, waiting for the owner): state, summary, the rejection reason, the conflicting operation and the job once executed ([policy.md](policy.md)).

**`bridge_result_page`** `{ handle, offset?, limit?, detail? }`: for a paginate handle `offset` and `limit` count items (the page is trimmed to the output budget; use `nextOffset`); for a stored oversized result `offset` counts characters of the JSON text and slices must be concatenated in order.

## Image upload

`lk_upload_image` runs one `upload_image` job of three steps (it needs scope `write`: uploads are not proposable in v1, so at `propose` it, and raw `createImageUpload` / `createImageAsset` calls, are refused before anything is sent):

1. `createImageUpload` (an LK call through the governor, with an idempotency key);
2. `upload_image.put`, a custom step: a `PUT` of the file to the signed `uploadUrl` with exactly the headers LK returned. This is **not** an LK API call and goes to another host, but it still runs inside `governor.execute`, on the reactive-only `upload` tier;
3. `createImageAsset` with the `uploadKey` (an LK call, with an idempotency key).

The source is **base64** (a `data:` URI is accepted) or a **public https URL** (switch off with `UPLOAD_ALLOW_URL_SOURCE=false`). At scope `propose` the tool is refused before anything is fetched or sent. The bytes are checked before any job exists: size at most `UPLOAD_MAX_BYTES` (10 MB by default), and the first bytes must be a PNG, JPEG, GIF or WebP image that agrees with any `contentType` given.

Network rules for both the URL fetch and the PUT (the address policy of chunk 4, `src/auth/ip.ts`, enforced inside the connection's DNS lookup as in `src/auth/safe-fetch.ts`):

- https only, no credentials in the URL;
- private, loopback, link-local, CGNAT and other non-public addresses are refused, whether literal or by DNS (`UPLOAD_URL_REFUSED`, `UPLOAD_TARGET_REFUSED`);
- URL fetches follow at most 3 redirects, each hop checked; they time out after `UPLOAD_FETCH_TIMEOUT_MS`;
- each PUT attempt has its own deadline, `UPLOAD_PUT_TIMEOUT_MS` (default 120 s), not the governor's 30-second LegendKeeper request timeout;
- the PUT is retried with backoff on 502/503/504 and connection errors; a `429` from the storage host becomes `UPLOAD_RATE_EXCEEDED`, so the governor blocks the upload tier and honours `Retry-After`;
- the signed URL is never logged, put in an error message, or shown by a tool, and the storage host's error body is replaced.

**Crash recovery.** The two LK steps use idempotency keys, so a restart replays them. The PUT is idempotent and is simply sent again. The image bytes live in the PUT step's stored params and are discarded once the PUT succeeds. If the signed URL has expired by the time a resumed job reaches the PUT, the job fails with `UPLOAD_URL_EXPIRED`; upload again.

Codes: `UPLOAD_SOURCE_INVALID`, `UPLOAD_TOO_LARGE`, `UPLOAD_NOT_AN_IMAGE`, `UPLOAD_URL_SOURCE_DISABLED`, `UPLOAD_URL_REFUSED`, `UPLOAD_URL_FAILED` (before any job), and in the job `UPLOAD_TARGET_REFUSED`, `UPLOAD_URL_EXPIRED`, `UPLOAD_BYTES_DISCARDED`.

## Settings

| Variable                  | Default            | Meaning                                                                                                         |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `MCP_EXPOSE_PER_OP_TOOLS` | `false`            | Also register `lk_op_<operationId>` for all 89 operations                                                       |
| `MCP_RESULT_MAX_CHARS`    | `40000`            | Results longer than this are stored and returned as a handle                                                    |
| `UPLOAD_MAX_BYTES`        | `10485760` (10 MB) | Largest image `lk_upload_image` accepts. The `/mcp` request body limit is sized from it (below)                 |
| `UPLOAD_ALLOW_URL_SOURCE` | `true`             | `false`: base64 only                                                                                            |
| `UPLOAD_FETCH_TIMEOUT_MS` | `15000`            | Deadline for fetching an image from a URL                                                                       |
| `UPLOAD_PUT_TIMEOUT_MS`   | `120000`           | Per-attempt deadline of the signed-URL PUT (5 s to 10 min), separate from the 30 s LegendKeeper request timeout |

The governor's per-attempt timeout (30 s) also bounds the PUT.

**Request size (chunk 8).** A base64 image is a third larger than the image, inside a JSON-RPC envelope. The `/mcp`
request body limit is therefore `max(4 MiB, ceil(UPLOAD_MAX_BYTES / 3) × 4 + 256 KiB)`: about 13.6 MiB for the default
10 MiB. (Fastify's own 1 MiB `bodyLimit` does not apply to `/mcp`: the body is left for the MCP SDK, which enforces this
limit, with a `413`, only after the bearer token has been checked.) An image over `UPLOAD_MAX_BYTES` that still fits the
request is refused by the tool with `UPLOAD_TOO_LARGE`. URL sources are not limited by the request size.
