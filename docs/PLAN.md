# LK-Bridge — Development Plan (v1)

**Repository:** `github.com/Airwolf1221/LK-Bridge` (currently empty, and **public**)
**Target host:** your Ubuntu server (SSH via PuTTY)
**Upstream:** LegendKeeper REST API v3 (`https://www.legendkeeper.com/api/v3/...`), OpenAPI 3.0.0, SDK `@legendkeeper/sdk` 4.1.0
**Consumers:** Claude (claude.ai web/desktop/mobile as a custom connector) and Claude Code (CLI)
**Plan date:** 6 November 2026

---

## 0. Summary

LK-Bridge v1 is a single Node.js/TypeScript service that does four jobs:

1. **Speaks the whole LegendKeeper v3 API.** All 89 operations are wrapped, schema-validated and sent through one client.
2. **Governs the rate budget.** Every call goes through a central governor that models all six LK rate tiers, the `createMany` item budget and the upload tier. It enforces priorities and headroom, so no agent or job can exhaust the project's budget by accident.
3. **Runs work as jobs.** Multi-step or long work runs as persistent, resumable jobs, executed by a bounded pool of **concurrent writers** with per-document locking and optimistic concurrency (`If-Match`).
4. **Exposes all of this over MCP**, behind a Claude-compatible OAuth 2.1 server. A **dashboard UI** shows jobs, errors, budgets and writers. It also has placeholder pages for maintenance jobs and repository mappings, so they're ready for later work.

The low-level API surface is deliberately put behind a small set of **meta-tools**: list, describe, call. The 89 operations don't take over the agent's tool list. That leaves the "main" tool slots free for the intention-level tools you'll specify later.

The work splits into **9 Claude Code sessions (chunks)**. Section 11 gives each one's model and effort level.

---

## 1. What the LegendKeeper v3 API actually offers (established facts)

### 1.1 Basics

| Item | Fact |
|---|---|
| Base URL | `https://www.legendkeeper.com`, routes under `/api/v3` |
| Auth | `Authorization: Bearer <project API key>`. Create the key in *Project Settings → Developers → API Keys*. The secret is shown once. |
| Key scope | One key = one project. Role is `MEMBER` (default) or `ADMIN`. The key acts with the **lower** of its own role and its creator's current role. A key used on another project gets `403 WRONG_PROJECT`. |
| Plan | The project owner must be on a **paid plan** (a trial doesn't count). Otherwise every request gets `402 PAID_PLAN_REQUIRED`. |
| Response contract | A single object comes back bare. A collection comes back as `{ data, hasMore, nextCursor }`. A delete returns `204`. |
| Errors | `{ message, code, requestId, errors? }`. `code` determines the status. Branch on `code`, never on `message`. |
| Request IDs | Every response has `x-request-id`. You can supply your own if it matches `^[A-Za-z0-9._-]{1,64}$`. |
| Idempotency | Every POST accepts `Idempotency-Key` (1–255 chars, `A-Za-z0-9._-`). The response is stored for 24 h. A replay returns `Idempotent-Replay: true`. A replay while the original is still running gets `409 IN_PROGRESS`. The same key on a different body gets `409 IDEMPOTENCY_KEY_REUSED`. 400/401/403/404, 5xx, 429 and bodies over 64 KB are *not* stored. |
| Optimistic locking | Documents, boards and calendars carry an opaque `version` (also sent as `ETag`). Send it as `If-Match`. A stale version gets `412 VERSION_MISMATCH`. **A write without `If-Match` silently overwrites edits made since your read.** |
| Client-chosen IDs | `createResource`, `createLane`, `createEvent` and `createFeature` accept your own `id`: a cuid2, 8 or 24 chars, lowercase letter first. This is the real re-sync mechanism; idempotency keys expire after 24 h. |
| Field limits | Each request field declares `maxLength`/`maxItems`/`maxProperties`. Nesting is limited to 64 levels. Bodies over 1 MB get a plain-text `413`. Documents that grow too large get `422 DOCUMENT_TOO_LARGE`. |

### 1.2 Rate limits (API keys)

| Tier | Window | Limit |
|---|---|---|
| Writes (POST/PUT/PATCH/DELETE), per key | 1 min | **120** |
| Writes, per key | 1 h | **3,000** |
| All requests, per key | 1 min | **300** |
| All requests, per key | 1 h | **6,000** |
| All requests, per key | 1 day | **60,000** |
| All requests, **per project across all keys** | 1 h | **12,000** |
| `createManyResources` *items* (≤100 per call, call = 1 write) | 1 min / 1 h | **600 / 6,000** |
| Upload tier (`UPLOAD_RATE_EXCEEDED`) | ? | **Explicitly unresolved.** The spec names the tier but publishes no numbers. |

The order in which tiers are consumed is: write-minute → write-hour → key-minute → key-hour → key-day → project-hour. Reads skip the write tiers.

Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds). They report **only the tightest tier**, not all six. A `429` adds `Retry-After` (seconds). Requests refused before they're counted (400 schema errors, 401, 402, 403, 405) carry no rate headers.

**Necessary deduction:** the bridge can't learn every tier's state from the headers alone. It has to keep its own sliding-window counters for all tiers, and use the headers (and 429s) to correct them.

**What this means for Baisheng in practice.** The export holds 3,498 resources and 3,523 documents.

| Task | Cost | Minimum time at the limits |
|---|---|---|
| List the full resource tree (100 per page) | ~35 reads | Trivial |
| Read every document's blocks once | ~3,523 reads | At least 12 min (300/min), and over half the key-hour budget |
| Rewrite all 778 Character pages | ~778+ writes | At least 6.5 min (120/min) |
| Create resources in bulk with `createMany` | 100 per write | 600 items/min, 6,000/h |

### 1.3 The complete operation inventory (89 operations)

Every path is relative to `/api/v3`. `{p}` = `projects/{projectId}`, `{r}` = `resources/{resourceId}`, `{d}` = `docs/{documentId}`.

**Projects (2):** `listProjects` `GET /projects` · `getProject` `GET /{p}`

**Resources (10):** `listResources` `GET /{p}/resources` (cursor, limit 1–100, default 50; `parentId`) · `createResource` `POST /{p}/resources` · `createManyResources` `POST /{p}/resources/batch` · `getResource` `GET /{p}/{r}` · `updateResource` `PATCH /{p}/{r}` · `deleteResource` `DELETE /{p}/{r}` (`cascade`) · `moveResource` `POST /{p}/{r}/move` · `restoreResource` `POST /{p}/{r}/restore` · `createResourceFromTemplate` `POST /{p}/resources/from-template` · `saveResourceAsTemplate` `POST /{p}/{r}/save-as-template`

**Templates (1):** `listTemplates` `GET /{p}/templates`

**Documents (9):** `listDocuments` · `createDocument` · `getDocument` · `updateDocument` · `deleteDocument` · `restoreDocument` · `assignBlockIds` · `getDocumentBlocks` `GET …/{d}/blocks` · `replaceDocumentBlocks` `PUT …/{d}/blocks`

**Blocks (19):**
- Single blocks: `insertBlock` · `getBlock` · `replaceBlock` · `updateBlock` · `deleteBlock` · `moveBlock`
- Key-value rows on a block: `listBlockRows` · `createBlockRow` · `updateBlockRow` · `deleteBlockRow`
- Infobox properties: `listBlockProperties` · `createBlockProperty` · `getBlockProperty` · `updateBlockProperty` · `deleteBlockProperty`
- Infobox property rows: `listBlockPropertyRows` · `createBlockPropertyRow` · `updateBlockPropertyRow` · `deleteBlockPropertyRow`

**Properties, the sidebar (9):** `listProperties` · `createProperty` · `getProperty` · `updateProperty` · `deleteProperty` · `listPropertyRows` · `createPropertyRow` · `updatePropertyRow` · `deletePropertyRow`

**Timelines (10):** `listLanes` · `createLane` · `getLane` · `updateLane` · `deleteLane` · `listEvents` (paged) · `createEvent` · `getEvent` · `updateEvent` · `deleteEvent`

**Map features (5):** pins, labels, regions, paths and folders. `listFeatures` (`type` filter) · `createFeature` · `getFeature` · `updateFeature` · `deleteFeature`

**Boards (6, tldraw 3.9 records):** `getBoardContent` · `replaceBoardContent` · `listBoardShapes` (`pageId`) · `createBoardShapes` · `updateBoardShapes` · `deleteBoardShapes` (`POST …/board/shapes/delete`)

**Assets (7):** `listAssets` (paged, `folderId`) · `createAssetFolder` · `createImageUpload` (step 1: signed `uploadUrl`) · `createImageAsset` (step 2: `uploadKey`) · `getAsset` · `updateAsset` · `deleteAsset`

**Calendars (4):** `listCalendars` · `createCalendar` · `updateCalendar` (PUT = replace; built-in calendars refuse it) · `deleteCalendar`

**Tags (1):** `listTags` · **Search (1):** `search` (`q` up to 500 chars, `limit` up to 100, default 32, one page only)

**Members and invites (5):** `listMembers` · `inviteMember` · `removeMember` · `listInvites` · `revokeInvite`

**Not in v3, so the bridge can't offer them:** webhooks or change feeds, bulk export, history or revisions.

**Necessary deduction:** every "what changed?" capability, such as maintenance sweeps or mapping refreshes, has to come from polling and from the bridge's own write journal.

### 1.4 Details that matter for correctness

- A new resource starts with one `blank` document named `Main`. The first write decides its type: blocks make it a page, features make it a map, board records make it a board, a lane makes it a timeline.
- **`unsupported` blocks** are content the block model can't express. They must be echoed back by `id` in `replaceDocumentBlocks`, **or they're deleted.** The bridge must enforce this; it's the single biggest data-loss risk.
- Legacy documents need one `assignBlockIds` call before their blocks can be addressed. Duplicate ids in legacy documents give `409 AMBIGUOUS`.
- Images only accept the `url` of an image asset **in the same project**. `data:` and `blob:` URIs are rejected. Uploading takes two steps plus a `PUT` to a signed URL, which isn't an LK API call.
- `deleteResource` returns `409 HAS_CHILDREN` unless you pass `cascade=true`. Deletes are soft, and `restoreResource`/`restoreDocument` exist.
- Templates live under the reserved virtual parent `templates`. Only ADMIN can create there.
- **Necessary deduction:** the bridge's key should be ADMIN, created by you as owner. A MEMBER key can't touch templates, top-level content or members.
- `INSUFFICIENT_SCOPE` and `FEATURE_UNAVAILABLE` exist in the error catalogue, but no scopes are documented. **Explicitly unresolved.** Handle them as non-retryable and surface them clearly.

---

## 2. Requirements → design mapping

| Your requirement | Where it lives |
|---|---|
| Support everything LK offers at low level | §4 Operation Registry. All 89 ops are generated from the OpenAPI spec, with a CI drift check. |
| Contextual awareness of LK rate limits | §5 Rate Governor, plus a budget footer on every MCP result, plus `bridge_budget` / `bridge_estimate` tools |
| Low-level calls available but not the main calls | §7 MCP tool surface: low-level ops sit behind the `lk_api_*` meta-tools. The main tools are reserved for future intention-level work. |
| UI: active jobs, errors, budgets, concurrent writers (**priority**) | §8 pages 1–4, fully functional in v1 |
| UI: maintenance jobs, repository mappings (**future**) | §8 pages 5–6: data model, API and empty-state UI only |
| GitHub repo | §10, chunk 0 |
| Deploy to your Ubuntu server, and let Claude use it | §9 deployment runbook, chunk 7 |
| Chunking, plus model and effort per chunk | §11 |

---

## 3. Architecture

```
                    ┌─────────────────────────────── Ubuntu server ───────────────────────────────┐
 claude.ai / ──TLS──▶ Caddy (443, auto-HTTPS) ──▶ LK-Bridge (Node 24 LTS, 127.0.0.1:8787)          │
 Claude Code        │   /mcp            ─────────▶ MCP transport (Streamable HTTP)                 │
                    │   /.well-known/*  ─────────▶ OAuth 2.1 AS + protected-resource metadata      │
 You (browser) ─────▶   /oauth/*        ─────────▶ authorize / token / register / login            │
                    │   /ui, /api/admin ─────────▶ Dashboard (SPA + admin JSON API + SSE stream)   │
                    │                                   │                                          │
                    │        ┌──────────────────────────┴───────────────────────────┐              │
                    │        │ Tool layer  →  Job Engine  →  Writer Pool + Doc Locks │              │
                    │        │                     ↓                                 │              │
                    │        │            Operation Registry (89 ops, zod-validated) │              │
                    │        │                     ↓                                 │              │
                    │        │   LK Client (SDK, custom fetch) → Rate Governor ──────┼──HTTPS──▶ LegendKeeper
                    │        └───────────────┬──────────────────────────────────────┘              │
                    │                        ▼                                                     │
                    │       SQLite (WAL) /var/lib/lk-bridge/bridge.db                              │
                    │       jobs · steps · errors · budget_samples · write_journal · oauth · config │
                    └─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Stack choices (with reasons)

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node 24 LTS**, TypeScript (strict), ESM | The LK SDK needs Node ≥ 20. One language across the bridge, UI and SDK. |
| HTTP server | **Fastify 5** | Fast, schema-first, good plugin model for the separate `/mcp`, `/oauth`, `/ui` and `/api/admin` areas |
| MCP | Official MCP TypeScript SDK: the v2 split packages (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`, 2.4.x), or `@modelcontextprotocol/sdk` 1.32.x if v2 adapters are awkward. Chunk 0 pins one. | Streamable HTTP transport, maintained by the protocol authors |
| LK client | **`@legendkeeper/sdk` 4.1.x**, built with a **custom `fetch`** routed through the governor, `maxRetries: 0`, `idempotencyKeys: false` (the bridge supplies its own keys) | Typed params and block builders for free. The governor, not the SDK, owns retries, pacing and header capture. (The SDK doesn't expose rate headers on successful calls, so the custom `fetch` is required anyway.) |
| Validation | zod 4. Operation input schemas are generated from `openapi.json`. | Agents get precise errors before spending budget |
| Storage | **SQLite** via `better-sqlite3`, WAL mode | Single-host, zero-ops, transactional. Ample for a single-owner bridge. |
| UI | React + Vite SPA, built to static files and served by the bridge. Live updates over **Server-Sent Events**. | Simple to deploy (no second process), live without polling |
| Reverse proxy and TLS | **Caddy** | Automatic Let's Encrypt, a two-line config, no redirect surprises |
| Process | **systemd** unit, dedicated `lkbridge` user | Restart on failure, journald logs |
| Logging | pino (JSON) → journald. Errors are also persisted to SQLite for the UI. | |

### 3.2 Repository layout

```
LK-Bridge/
├─ CLAUDE.md                     # standing instructions for every Claude Code session
├─ docs/
│  ├─ PLAN.md                    # this file
│  ├─ adr/                       # architecture decision records (one per major choice)
│  └─ runbook-deploy.md
├─ spec/
│  └─ legendkeeper-openapi.json  # vendored, pinned copy (from @legendkeeper/sdk)
├─ scripts/
│  ├─ gen-registry.ts            # openapi.json → src/lk/registry.generated.ts
│  └─ check-spec-drift.ts        # CI: fails if the SDK spec has ops the registry lacks
├─ src/
│  ├─ config/                    # env parsing (zod), defaults
│  ├─ lk/                        # client factory, governor, error mapping, registry
│  ├─ jobs/                      # engine, steps, writer pool, doc locks, journal
│  ├─ mcp/                       # transport, tool definitions, result shaping
│  ├─ auth/                      # OAuth 2.1 AS, PATs, owner login, sessions
│  ├─ admin/                     # admin JSON API + SSE
│  ├─ maintenance/               # registry + scheduler (v1: framework only)
│  ├─ mappings/                  # data model + API (v1: framework only)
│  ├─ db/                        # migrations, repositories
│  └─ server.ts
├─ ui/                           # Vite + React dashboard
├─ test/                         # unit, contract (mock LK), integration (sandbox LK)
├─ deploy/
│  ├─ lk-bridge.service          # systemd unit
│  ├─ Caddyfile.example
│  └─ deploy.sh                  # git pull → npm ci → build → migrate → restart
├─ .env.example                  # names only, never values
└─ .github/workflows/ci.yml
```

---

## 4. Operation Registry (the low-level layer)

**Goal:** one generated table describes every LK operation. Everything else (MCP tools, validation, budget classification, UI labels) reads from it.

Each entry holds:
- `operationId`, `method`, `pathTemplate`, `tag` (Resources, Blocks…)
- `inputSchema` (zod, from path, query and body parameters)
- `kind`: `read` | `write` | `upload`
- `costs`: the tiers it draws on. `createManyResources` also draws `items = body.resources.length`.
- `concurrency`: `none` | `document` (needs the doc lock: every block, row, infobox, board and document-content write) | `resource` (resource-level writes such as move, delete, update)
- `versioned`: whether it accepts `If-Match`, so the bridge auto-supplies it
- `paged`: whether it takes `cursor`/`limit`
- `risk`: `safe` | `destructive` (deletes, `replaceDocumentBlocks`, `replaceBoardContent`, `updateCalendar`) | `admin` (members, invites)

**Guard rules the registry enforces centrally:**
1. **`If-Match` is mandatory** on every versioned write that goes through the bridge. The bridge does read → modify → write itself if the caller didn't supply a version. On `412` it re-reads and returns a clear conflict to the caller; it never blindly overwrites.
2. **Unsupported-block preservation.** Before any `replaceDocumentBlocks` or `replaceBlock`, the bridge diffs the incoming tree against the current one. If any `unsupported` block id would vanish, the write is **refused** unless the caller passes `allowUnsupportedLoss: true`.
3. **Destructive ops** are journalled with a pre-image (§6.4). `deleteResource` with `cascade` also needs an explicit `confirm: "cascade"`.
4. **Admin ops** (`inviteMember`, `removeMember`, `revokeInvite`) are **disabled by default** (config flag `LK_ALLOW_MEMBER_ADMIN=false`). They're still registered, so coverage is complete, but they refuse until you enable them.
5. **Image upload** is exposed both as the two raw ops and as one composite `upload_image`. The composite performs the signed `PUT`, which isn't an LK API call but still needs the upload-tier backoff.
6. **Read-only mode** (`LK_READ_ONLY=true`): every write refuses. Use this for the first live connection to Baisheng (see §9.7).

**Coverage guarantee:** `check-spec-drift.ts` runs in CI. It compares the operation ids in the installed SDK's `openapi.json` with the registry and fails the build on any difference. When LK adds an endpoint, CI tells you.

---

## 5. Rate Governor (the heart of v1)

### 5.1 Model

- One **sliding-window counter per tier**: the six documented tiers, plus `createMany` items (minute and hour), plus `upload`, whose numbers are unknown and so handled reactively only.
- **Tier limits live in config, not code.** The defaults are the published numbers, so a change by LK is a config edit.
- Before dispatch, the governor checks every tier the op draws on (§4 `costs`). The call proceeds only if all have room *after* the reserves in §5.2.
- **Correction from the server:** after every response, the governor reads `X-RateLimit-*` (the tightest tier) and snaps the matching local counter to the server's `Remaining`/`Reset`. On a `429` it marks that tier exhausted until `Retry-After`.
- **Shared project tier:** the project-hour tier (12,000) is shared by *every* key on the project, so another client (for example your old ChatGPT bridge, if its key is still live) silently consumes it. The governor's local count will under-estimate. That's why server headers always win, and why the UI shows "observed vs. modelled" drift. **Recommendation:** revoke the old bridge's key once ChatGPT's maintenance finishes.

### 5.2 Priorities and reserves

Calls are queued by **priority class**, highest first:

| Class | Who | Reserve behaviour |
|---|---|---|
| `P0 admin` | Dashboard actions, health checks | May use the full remaining budget |
| `P1 interactive` | An agent's direct MCP call | May use the budget down to the **interactive reserve floor** (default: keep 10% of each tier) |
| `P2 job` | Multi-step job steps | Stops at the **job floor** (default 25% left), so agents stay responsive while a big job runs |
| `P3 maintenance` | Scheduled maintenance (future) | Stops at the **maintenance floor** (default 50% left), and only runs when no P1/P2 work is queued |

Within a class, the queue is FIFO with fair-share across jobs: round-robin by job id, so one huge job can't starve the others.

**Pacing:** writes are spaced at least 500 ms apart by default (LK's own guidance). The spacing stretches to 1.2 s automatically once the projected hourly write count would cross 3,000.

### 5.3 Retries (owned by the governor, aligned with LK guidance)

| Situation | Action |
|---|---|
| `429` with `Retry-After` ≤ 30 s | Wait and retry, using the same idempotency key for POST |
| `429` with longer `Retry-After` | Park the step (job → `waiting_budget`) and resume after reset. For P1 calls, return a structured "budget exhausted, retry at T" result. |
| `502/503/504`, timeout, connection error on GET/PUT/PATCH/DELETE | Exponential backoff (250 ms → 8 s, with jitter, 3 tries) |
| Same on POST | Retry **only** with the same `Idempotency-Key`. Then **verify**: re-read by client-chosen id where possible. |
| `409 IN_PROGRESS` | Retry after a short backoff, same key |
| `412` after a retried versioned write | Re-read; if the content already matches the intent, treat it as success |
| `404` / `409 ALREADY_DELETED` after a retried DELETE | Re-read; treat as success if it's gone |
| `500 INTERNAL`, other 4xx | Never retry. Record the error with `requestId`. |

**Idempotency keys** are deterministic: `lkb.{jobId}.{stepNo}.{attempt0}`. A step retried after a bridge restart replays, rather than duplicating. For entities that accept client ids (resources, lanes, events, features), the bridge **always mints the cuid2 id itself** and stores it in the step before sending. That makes re-sync safe beyond the 24 h idempotency window.

### 5.4 Agent-facing budget awareness

- **Every MCP tool result** ends with a compact footer, for example:
  `budget: writes 87/120·min 2,410/3,000·h | all 241/300·min 5,102/6,000·h 48k/60k·d | project 9.8k/12k·h | queue P1:0 P2:14`
- **`bridge_budget`** returns the full table, reset times and queue depths.
- **`bridge_estimate`** takes a planned workload, such as `{ reads: 3500, writes: 800, createManyItems: 0 }`. It returns the projected wall-clock time, the tightest tier and whether the work fits within today's day cap. Agents call this *before* proposing big operations.

---

## 6. Jobs, Writers and Safety

### 6.1 Job model

- **Job:** `id`, `kind`, `title`, `origin` (MCP client + tool, or UI), `priority`, `status` (`queued` · `running` · `waiting_budget` · `waiting_lock` · `paused` · `succeeded` · `failed` · `cancelled`), progress (`stepsDone/stepsTotal`), timestamps, last error.
- **Step:** one LK operation, or one composite such as an image upload. Holds the op id, a hash of the params, a ref to the params blob, the idempotency key, client-minted ids, status, attempts, `requestId`s and the result summary.
- Everything is **persisted in SQLite**. On restart, `running` steps are re-examined (verify-then-resume) and the jobs continue.
- **When does an MCP call become a job?**
  - Single reads run inline.
  - A single write runs inline, but is still recorded as a one-step job, so it shows in the UI and journal.
  - Anything with more than one step, or an estimate above 20 s, returns `{ jobId, status: "queued", eta }` immediately. The agent polls `bridge_job_status` or waits with `bridge_job_wait` (bounded long-poll, at most 25 s).
- v1 job kinds: `single_op`, `batch_ops` (an ordered list of registry calls submitted by an agent, with `stopOnError` or `continue`), `upload_image`, `paginate_all` (follow every cursor of a paged list into a stored result set the agent can page through).

### 6.2 Concurrent writers

- **Writer pool:** `N` writer slots (config `WRITERS_MAX`, **default 2**, adjustable live from the UI between 1 and 8). Only a writer slot may execute write steps. Reads don't need a slot.
- Why so few: the 120 writes/min cap means more than 2–3 parallel writers adds contention, not throughput. Slots exist for **isolation and fairness**: two jobs progress together, and a stuck job can't block everything.
- **Per-document lock:** a write step on document *D* must hold `lock(D)`. Per-resource locks apply to resource-level ops. The locks are in-process mutexes with a wait queue, and the job shows `waiting_lock` while it waits. This removes 412 storms between the bridge's own writers. 412s from *outside* edits (you in the LK app) are still handled by §4 rule 1.
- **Kill switch:** **Pause all writes** from the UI or `POST /api/admin/writes/pause`. In-flight steps finish; nothing new starts.
- **Drain mode:** finish running jobs, accept no new jobs. Use it before deploying.

### 6.3 Errors

- Every failed call is recorded: time, op, job/step, HTTP status, LK `code`, `message`, `errors[]` paths, **`requestId`**, retryable flag and the bridge's classification: `user_fixable` (400s), `conflict` (409/412), `auth` (401/402/403), `budget` (429), `upstream` (5xx/connection) or `bridge` (internal bug).
- Errors are grouped by fingerprint (op + code + path) so repeats collapse into one row with a count.

### 6.4 Write journal (cheap undo insurance)

Versioned writes already read the current state first, so the bridge stores the **pre-image** before destructive ops: previous blocks JSON for replaces, the previous board for board replaces, resource metadata for updates and moves, and ids for deletes. Retention is configurable (default 30 days or 2 GB).

In v1 the journal is **view-only in the UI**, plus a `bridge_journal_lookup` tool. Automated rollback is a future maintenance job. This matters for a 3,500-resource repository: LK has no revision history in the API.

---

## 7. MCP tool surface (v1)

The tool names below are proposals; treat them as such.

**Low-level layer, deliberately *not* the main tools:**

| Tool | Purpose |
|---|---|
| `lk_api_list_operations` | Lists the 89 ops (filter by tag or kind) with a one-line summary and cost class |
| `lk_api_describe_operation` | Full input schema, risk level, versioning and rate costs for one op |
| `lk_api_call` | Executes one op by `operationId` with validated params, through the governor, writers and locks. Returns the result plus the budget footer. |
| `lk_api_batch` | Submits an ordered list of calls as a job; returns a `jobId` |
| `lk_api_paginate_all` | Follows every cursor of a paged list as a job; returns a handle to page through |
| `lk_upload_image` | Composite three-step image upload from a URL or base64 |

**Bridge awareness tools:** `bridge_budget` · `bridge_estimate` · `bridge_job_status` · `bridge_job_wait` · `bridge_job_cancel` · `bridge_errors_recent` · `bridge_journal_lookup` · `bridge_info` (version, project, role, read-only flag, writers).

**Optional per-operation tools.** With `MCP_EXPOSE_PER_OP_TOOLS=true`, the bridge also registers `lk_op_<operationId>` for all 89 ops. It's off by default, to keep the claude.ai tool list small.

**Reserved namespace:** intention-level tools you define later will live at the top level (no `lk_api_` prefix). They'll be built *on top of* the job engine and registry, never on raw HTTP.

**Result shaping:**
- Large payloads (document block trees, board content, long lists) are summarised by default, with `detail: "full"` to opt in.
- Anything over ~40k characters is stored as a job artefact and returned as a handle with paging. Claude Code warns at 10k tokens and truncates MCP output at 25k tokens by default.
- Tool descriptions state the rate cost and risk, so the model can see them.

---

## 8. Dashboard UI

The dashboard is served at `https://<bridge-host>/ui`. It's protected by **owner login** (username + Argon2id-hashed password, with optional TOTP), a secure HttpOnly session cookie and CSRF protection on admin POSTs. It's a separate session from MCP OAuth, but the same owner account approves OAuth consent. Live data arrives over one SSE stream (`/api/admin/stream`).

| # | Page | v1 status | Content |
|---|---|---|---|
| 1 | **Overview** | ✅ Full | Health (LK reachable, key role, plan OK), read-only flag, writes paused or running, headline gauges, active job count, errors in the last hour |
| 2 | **Jobs** | ✅ Full | Active, queued and waiting jobs with live progress bars and the current step. Recent history. Filters by status and origin. Detail view: steps, attempts, `requestId`s, artefacts. Actions: cancel, pause, resume, retry the failed step. |
| 3 | **Errors** | ✅ Full | Grouped error list (fingerprint, count, first/last seen), detail with the full LK error body and `requestId` (copy button for LK support), links to the job/step, mark-resolved |
| 4 | **Request Budgets** | ✅ Full | One gauge per tier (8 incl. createMany items, upload shown as "reactive only"), each showing used/limit, reset countdown and a 24 h sparkline (from `budget_samples`, one per 10 s). "Observed vs. modelled" drift for the project tier. Queue depth per priority class. Reserve floors (editable). |
| 5 | **Concurrent Writers** | ✅ Full | Slot cards (idle, or busy with job and current op and doc), held document locks and wait queues, `WRITERS_MAX` control, **Pause all writes** and **Drain** buttons, writes/min live rate |
| 6 | **Maintenance Jobs** | 🟡 Scaffold | Registry table (name, description, schedule, enabled toggle, last run, next run, budget class P3). v1 ships the scheduler plus one harmless built-in, `budget-sampler`, and placeholders listed as *Not implemented*: `assign-block-ids-sweep`, `journal-prune`, `tree-snapshot`, `orphan-and-link-audit`, `tag-audit`. The toggles only work for implemented jobs. |
| 7 | **Repository Mappings** | 🟡 Scaffold | Data model and empty-state UI for the future "intelligent mapping": *mapping sets* (e.g. "Baisheng taxonomy"), *type rules* (LK subtree / template / tag → semantic type such as Character, Nation, Species), *field maps* (semantic field → property, infobox row or block). Read and edit forms for records. No inference engine in v1. |
| 8 | **Clients & Access** | ✅ Full (small) | Connected OAuth clients (claude.ai, Claude Code), active tokens with last use and revoke. Personal access tokens (create, revoke, shown once). |
| 9 | **Settings** | ✅ Full (small) | Read-only mode, per-op-tool exposure, member-admin enable, journal retention, tier limit overrides. Every change is audited. |

---

## 9. Deployment & connecting Claude

### 9.1 Prerequisites (do these first)

1. **A domain or subdomain** for the bridge, e.g. `lk.yourdomain.tld`, with a DNS **A record** pointing at the server's **public IPv4**.
   - Claude's connectors are **IPv4-only**, and reject hostnames that resolve to private or CGNAT addresses.
   - If your old ChatGPT bridge already uses a hostname on this server, use a **new** subdomain so the two can coexist during migration.
2. **Ports 80 and 443 open** to the internet (Caddy needs port 80 for the certificate challenge). SSH stays as it is.
3. **A LegendKeeper API key** with **ADMIN** role, created by you as owner (the owner plan must be paid). Strongly recommended: a **second, sandbox LK project** with its own key, for integration tests.
4. **The repository is public.** Either make it private (recommended), or accept that it's open-source and be strict that no secrets ever enter it. The plan is safe either way: secrets live only in `/etc/lk-bridge/lk-bridge.env` on the server.

### 9.2 Server layout

| Path | Purpose | Owner / mode |
|---|---|---|
| `/opt/lk-bridge` | Git checkout, build output | `lkbridge` |
| `/var/lib/lk-bridge/bridge.db` | SQLite database | `lkbridge`, 0700 dir |
| `/etc/lk-bridge/lk-bridge.env` | Secrets | `root:lkbridge`, 0640 |

The secrets file holds `LK_API_KEY`, `LK_PROJECT_ID`, `BRIDGE_PUBLIC_URL`, `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `JWT_SIGNING_KEY`, and so on.

The service runs as systemd `lk-bridge.service` with `Restart=on-failure`, `NoNewPrivileges`, `ProtectSystem=strict` and `ReadWritePaths=/var/lib/lk-bridge`.

### 9.3 Install steps (the runbook chunk 7 produces, abbreviated)

```bash
# as your sudo user, over PuTTY
sudo apt update && sudo apt install -y git curl ufw sqlite3
# Node 24 LTS via NodeSource (or nvm for the service user)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
# Caddy from its official apt repo (see caddyserver.com/docs/install)
sudo adduser --system --group --home /opt/lk-bridge lkbridge
sudo -u lkbridge git clone https://github.com/Airwolf1221/LK-Bridge /opt/lk-bridge
cd /opt/lk-bridge && sudo -u lkbridge npm ci && sudo -u lkbridge npm run build
sudo install -d -o lkbridge -g lkbridge -m 0700 /var/lib/lk-bridge
sudo install -d -m 0750 -g lkbridge /etc/lk-bridge   # then create lk-bridge.env (0640)
sudo -u lkbridge npm run setup:owner                  # interactive: sets owner password hash
sudo cp deploy/lk-bridge.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now lk-bridge
# Caddyfile:  lk.yourdomain.tld { reverse_proxy 127.0.0.1:8787 }
sudo systemctl reload caddy
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

**Updates:** `sudo -u lkbridge /opt/lk-bridge/deploy/deploy.sh`. The script drains, pulls, runs `npm ci`, builds, migrates, restarts and health-checks. A GitHub Actions deploy can come later.

**Backups:** a nightly `sqlite3 bridge.db ".backup …"` via a systemd timer, keeping 14 copies.

### 9.4 Connecting claude.ai (web, desktop, mobile)

1. Go to *Customize → Connectors → Add custom connector*.
2. For the URL, enter `https://lk.yourdomain.tld/mcp`. Use this exact URL; it must not redirect.
3. Authentication: **Sign in now**. OAuth client: **Use Claude's published identity** (CIMD), or **Register automatically** (DCR). The bridge supports both.
4. Your browser opens the bridge's login and consent page. Sign in as owner and approve.

Mobile can then *use* the connector, but you can't add new connectors from mobile.

### 9.5 Connecting Claude Code

- **Option A, OAuth:** `claude mcp add --transport http lk-bridge https://lk.yourdomain.tld/mcp --scope user`, then run `/mcp` inside Claude Code and log in.
- **Option B, personal access token (simplest):** create a PAT in the UI under *Clients & Access*, then run
  `claude mcp add --transport http lk-bridge https://lk.yourdomain.tld/mcp --scope user -H "Authorization: Bearer <PAT>"`.

### 9.6 Auth requirements the bridge must meet

Your previous bridge's OAuth handshake failed with claude.ai. These are the documented requirements; each one becomes an automated acceptance test in chunk 4.

- An unauthenticated `/mcp` request returns **`401`** with `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource/mcp"`. Claude ignores a `WWW-Authenticate` header on a `200`.
- Protected-resource metadata (RFC 9728) is served at both `/.well-known/oauth-protected-resource/mcp` and the root. Its `resource` equals the exact MCP URL. `authorization_servers[0]` is the bridge itself, because Claude uses **only the first entry**.
- Authorization-server metadata is served at `/.well-known/oauth-authorization-server`. It advertises:
  - `code_challenge_methods_supported: ["S256"]`
  - `registration_endpoint` (DCR)
  - `client_id_metadata_document_supported: true` **and** `"none"` in `token_endpoint_auth_methods_supported` (both are required for CIMD)
  - `offline_access` in `scopes_supported`
- **PKCE S256** is mandatory. The `resource` parameter (RFC 8707) is honoured, and token `aud` is checked against the *canonical* URL (lowercase host, no trailing slash).
- The token endpoint accepts **`application/x-www-form-urlencoded`**. `/register` accepts JSON. Both respond in **well under 10 s**.
- **Refresh tokens rotate.** An invalid refresh returns `invalid_grant`. A deleted DCR client returns `401 invalid_client`, which tells Claude to re-register.
- The allowed redirects are `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`, plus the **loopback** redirects `http://localhost/callback` and `http://127.0.0.1/callback` with **any port** (for Claude Code). The consent page shows the redirect hostname.
- **No `3xx` on the MCP URL**, because Claude drops `Authorization` on redirects. **No WAF** blocking Anthropic's egress range (`160.79.104.0/21`).

The static "Request headers" connector option in claude.ai is in limited beta, so the plan doesn't depend on it. The PAT path still works for Claude Code.

### 9.7 Go-live sequence

1. Deploy against the **sandbox** LK project. Run the integration suite and a soak test.
2. Switch the key to **Baisheng in read-only mode** (`LK_READ_ONLY=true`) while ChatGPT finishes its maintenance on the repository. Two writers on one project would contend for both versions and the shared project rate tier.
3. After that maintenance ends, **revoke the old bridge's LK key**, set `LK_READ_ONLY=false`, and keep `WRITERS_MAX=1` for the first week.

---

## 10. Testing strategy

| Layer | What | Where |
|---|---|---|
| Unit | Governor windows, priority queue, reserve floors, header correction, retry matrix (§5.3), unsupported-block guard, id minting, idempotency-key derivation | `test/unit`, run by Vitest in CI |
| Contract | Every registry op against a **mock LK** generated from the vendored OpenAPI spec (Prism, or a hand-rolled Fastify mock). It simulates 429s with `Retry-After`, 412s, 409 `IN_PROGRESS`, 5xx, and the rate headers. | `test/contract`, CI |
| Drift | `check-spec-drift.ts` | CI |
| Auth conformance | Scripted OAuth flows: DCR, CIMD, PKCE, refresh rotation, 401 shape, loopback any-port. Plus the MCP Inspector, and `@modelcontextprotocol/conformance` if it fits. | `test/auth`, CI |
| Integration | Real LK **sandbox** project: create/read/update/delete for each entity family, image upload, a template round-trip, board shapes, timeline events and map features | `npm run test:sandbox`, manual or nightly, never in public CI logs |
| Soak | A synthetic job of about 1,000 sandbox writes, checking that pacing holds below 120/min and nothing gets a 429 | Chunk 8 |

---

## 11. Implementation chunks, and the model and effort for each Claude Code session

**Yes, the project divides cleanly.** The seams are: client and governor; jobs and writers; operation coverage; MCP and auth; UI; scaffolds; deployment; and an independent review.

Chunk 4 (auth) only depends on chunk 0, so it can run **in parallel** with chunks 1–3 in a separate git worktree or branch.

```
 0 ──▶ 1 ──▶ 2 ──▶ 3 ──┐
 │                      ├──▶ 5 ──▶ 6 ──▶ 7 ──▶ 8
 └──────────▶ 4 ────────┘
```

**Model availability on your plan.** The models below are the ones Claude Code offers as of today:
- `opus` = Opus 5.5 (the default on Pro and Max)
- `sonnet` = Sonnet 5.5
- `haiku` = Haiku 5.5

Effort levels are `low`, `medium`, `high`, `xhigh` and `max`. The default for Opus 5.5 and Sonnet 5.5 is `medium`. Set the model with `/model` and the effort with `/effort`, or use `claude --model opus --effort high`.

**Fable isn't recommended for any chunk.** It isn't needed for this work, and it can bill to usage credits rather than your plan's included limits. **On Pro**, Opus at `xhigh` uses up your limits quickly. If you start before Max, the cheaper fallback is listed for each chunk.

| # | Chunk | Recommended model / effort | If on Pro, economise with | Why this level |
|---|---|---|---|---|
| **0** | **Repo bootstrap and spec ingestion.** Scaffold, TS/ESLint/Vitest, CI, `CLAUDE.md`, ADRs 1–5, vendored spec, `gen-registry.ts` + `check-spec-drift.ts`, config loader, pin the MCP SDK choice | **Sonnet 5.5 · medium** | Same | Conventional setup; the generator is moderately tricky but well specified |
| **1** | **LK client and Rate Governor.** Custom-fetch SDK client, error mapping, all tier counters, header correction, priority queue and reserves, pacing, retry matrix, budget footer and `bridge_estimate` maths, full unit tests | **Opus 5.5 · xhigh** | Opus 5.5 · high | Concurrency and timing logic where subtle bugs burn your real budget or lose writes. This is the core everything else trusts. |
| **2** | **Persistence, Job Engine and Writers.** SQLite schema and migrations, job/step model, restart-resume with verify, writer pool, doc and resource locks, write journal with pre-images, unsupported-block guard, read-only mode, pause and drain | **Opus 5.5 · high** | Opus 5.5 · medium | Crash-safety and data-loss guards need careful reasoning, but the design is fully specified above |
| **3** | **Full operation coverage and MCP low-level tools.** Wire all 89 ops through registry → jobs → governor, the `lk_api_*` meta-tools, optional per-op tools, result shaping and artefacts, the composite image upload, mock-LK contract tests for every op | **Sonnet 5.5 · high** (or `opusplan`) | Sonnet 5.5 · medium | Large but repetitive. Breadth matters more than depth; `opusplan` lets Opus plan and Sonnet grind. |
| **4** | **MCP transport and OAuth 2.1 server.** Streamable HTTP `/mcp`, protected-resource and AS metadata, DCR + CIMD, PKCE, rotation, owner login and consent, PATs, every §9.6 requirement as a test *(parallel to 1–3)* | **Opus 5.5 · xhigh** | Opus 5.5 · high (don't drop to Sonnet) | Security-critical, and exactly where your last bridge failed. Spec-compliance detail is unforgiving. |
| **5** | **Dashboard UI and Admin API.** Admin JSON endpoints, the SSE stream, React pages 1–5 and 8–9 fully working, budget sparklines, writer controls | **Sonnet 5.5 · medium** | Same | Standard full-stack UI work against a defined API |
| **6** | **Future scaffolds.** Maintenance registry and scheduler with `budget-sampler`, placeholder job entries, the mappings data model, CRUD API and pages 6–7 empty states | **Sonnet 5.5 · low–medium** | Haiku 5.5 · medium | Thin, well-specified framework code. Small enough to merge into chunk 5 if you prefer. |
| **7** | **Deployment and connection.** systemd unit, Caddyfile, `deploy.sh`, backup timer, a detailed runbook, then a live deploy and connecting claude.ai and Claude Code | **Sonnet 5.5 · medium** | Same | Mostly operational. Running Claude Code **on the server itself** (installed in your PuTTY session) lets it execute and verify each step directly. |
| **8** | **Independent hardening review.** A *fresh* session, without the earlier sessions' context: security review (auth, secrets, CSRF, headers), sandbox soak test, failure injection, docs pass, v1.0.0 tag | **Opus 5.5 · high** | Opus 5.5 · medium | A separate reviewer that didn't write the code catches what the builders normalised |

**Per-session discipline:**
- Start every session with "read `CLAUDE.md` and `docs/PLAN.md`, then chunk *N*".
- Work on a branch per chunk and open a PR; review it before merging.
- Each chunk ends with green CI plus an updated `docs/CHANGELOG.md`.

### 11.1 Acceptance criteria per chunk (definition of done)

- **0:** `npm test` and the CI pass. The registry generates 89 entries. Drift check passes. `CLAUDE.md` is in place.
- **1:** A simulated 1,000-call workload against the mock never exceeds any tier. An injected 429 is honoured. The retry matrix tests (§5.3) all pass. The footer string is produced.
- **2:** Killing the process mid-job and restarting resumes without duplicates (verified against the mock). The unsupported-block guard refuses a lossy replace. Pause and drain work.
- **3:** Every one of the 89 ops has at least one passing contract test via `lk_api_call`. Oversized results return handles.
- **4:** Every §9.6 bullet has a passing test. The MCP Inspector completes the OAuth flow. A local claude.ai-equivalent flow works through a tunnel.
- **5:** Pages 1–5 and 8–9 update live while a mock job runs. Writer count changes take effect without a restart.
- **6:** Maintenance and mappings pages render, with CRUD where specified. `budget-sampler` populates the sparklines.
- **7:** claude.ai connects and calls `bridge_info`. Claude Code connects (OAuth and PAT). The UI is reachable over HTTPS. A backup file exists.
- **8:** The review findings are fixed or ticketed. The soak test shows zero 429s. v1.0.0 is tagged.

---

## 12. Starter `CLAUDE.md` (for the repo)

```markdown
# LK-Bridge — standing instructions
- Read docs/PLAN.md before any work. Follow its decisions; propose an ADR to change one.
- TypeScript strict, ESM, Node 24. Fastify 5. SQLite via better-sqlite3. Vitest.
- NEVER call LegendKeeper except through src/lk/governor (no raw fetch to legendkeeper.com).
- NEVER write a versioned LK entity without If-Match. NEVER drop `unsupported` blocks.
- NEVER commit secrets or real API keys; this repo may be public. Use .env.example names only.
- Tests: unit + contract (mock LK) must pass before finishing. Sandbox tests are opt-in (npm run test:sandbox).
- Work on a branch named chunk-N-<slug>; end with a summary of what changed and what's left.
- British English in docs and UI copy.
```

---

## 13. Open items (for you to decide; none block chunk 0)

| # | Item | Status | Default if undecided |
|---|---|---|---|
| 1 | Bridge hostname | Needed by chunk 7 | — |
| 2 | Make the repo private? | Recommended | Stays public, with strict secret hygiene |
| 3 | Sandbox LK project for tests | Strongly recommended | Contract tests only (riskier) |
| 4 | Does the old ChatGPT bridge's key stay live after 9 Nov? | Affects the shared project tier | The plan assumes it's revoked at go-live |
| 5 | Upload-tier numbers | **Explicitly unresolved** (unpublished by LK) | Handled reactively |
| 6 | `INSUFFICIENT_SCOPE` / key scopes | **Explicitly unresolved** (code exists, scopes undocumented) | Treated as non-retryable auth errors |
| 7 | Using a second LK key to raise per-key ceilings (the project tier still caps at 12k/h) | **Proposal** for later | Single key in v1 |
| 8 | Your further goals (intention-level tools, intelligent mapping) | Next phase | Namespace and data model reserved |

---

## 14. Sources

- LegendKeeper Developers: https://www.legendkeeper.com/developers/
- LegendKeeper OpenAPI v3 spec: https://www.legendkeeper.com/api/v3/openapi.json (operation inventory extracted from the copy bundled in `@legendkeeper/sdk` 4.1.0)
- LegendKeeper SDK guide: https://www.legendkeeper.com/developers/guide/
- Claude connector authentication: https://claude.com/docs/connectors/building/authentication
- Claude connector troubleshooting: https://claude.com/docs/connectors/building/troubleshooting
- Adding custom connectors: https://claude.com/docs/connectors/custom
- Claude Code model configuration: https://code.claude.com/docs/en/model-config
- Claude Code MCP: https://code.claude.com/docs/en/mcp

## Amendments (7 November 2026)

1. ChatGPT is a supported client (OAuth only). Redirect URIs, RFC 9207 and the ChatGPT checks are in docs/auth.md.
2. Chunk 3: split `lk_api_call` into `lk_api_read` and `lk_api_write` (batch and paginate_all follow the same split), and set tool annotations, so users can auto-approve reads and keep confirmations on writes in both Claude and ChatGPT.
3. Chunk 7: add a ChatGPT connection test.
4. Chunk 4 added a refresh-token grace window and a TRUST_PROXY setting.
