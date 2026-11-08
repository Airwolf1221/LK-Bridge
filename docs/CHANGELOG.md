# Changelog

## Unreleased

### Chunk 7a: deployment files and the runbook

No application behaviour changed. Everything is under `deploy/`, `docs/`, `test/unit/` and the CI file.

- **`deploy/`**: `install-node.sh` (private Node 24 LTS under `/opt/lk-bridge/runtime/node`, version pinned and
  overridable, SHA-256 checked against `SHASUMS256.txt`, idempotent), `lk-bridge.service` (hardened, `TimeoutStopSec=45`
  for the engine's 20 s drain), `Caddyfile.lk-bridge` (one site block; `flush_interval -1`; no redirects, rewrites,
  `encode` or headers), `deploy.sh` (stop-to-drain, pre-deploy backup, fast-forward only, `npm ci`, build, migrate, start,
  health check; `--current` for rollback), `backup.sh` with `lk-bridge-backup.service` and `.timer` (04:15 Europe/London,
  integrity-checked, gzip, 14 nightly copies kept), `healthcheck.sh`, `sudoers.lk-bridge` (four `systemctl` commands for
  `lk-bridge`), `env.template`, and helpers `lib.sh`, `lk-run.sh` (runs the owner CLIs with the private Node and
  `DB_PATH`) and `sandbox-test.sh`.
- **`npm run test:sandbox` cannot read the bridge's env file** (vitest loads no env files, and the file is not safe to
  `source`). `deploy/sandbox-test.sh` reads only `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID`, exports only those, prints
  neither, and refuses to run if they equal the production key or project id.
- **[docs/runbook-deploy.md](runbook-deploy.md)**: the step-by-step deployment for this server, with every `sudo` step marked.
  [ADR 0015](adr/0015-deployment-layout.md) records the departures from PLAN §9 (private Node, `/opt/lk-bridge/app`,
  stop-to-drain because the admin API accepts only the owner's browser session).
- **Tests:** `test/unit/deploy-env-template.test.ts` derives the variables the config loaders read and require from the
  zod schemas and checks `env.template` has them all, holds only the documented production defaults and no secret;
  `test/unit/deploy-files.test.ts` checks the scripts (strict mode, executable, shellcheck when installed), the sudoers rule,
  the units (and `systemd-analyze verify` when available) and the Caddy block. CI runs `shellcheck -x deploy/*.sh`.

### Chunk 5: dashboard, admin API and live stream

- **Dashboard** at `/ui` (`ui/`, Vite + React, TypeScript strict, light and dark, bundled with no external fonts or
  scripts): Overview, Jobs (live progress, history, filters by status, origin, profile and principal, detail with steps,
  attempts, request ids, artefacts and the `uncertain` flag, controls), Errors (grouped, detail with the full LegendKeeper
  body and a request-id copy button, mark resolved), Request Budgets (a gauge per tier, upload as "reactive only", 24 h
  sparklines, observed-against-modelled drift, queue depth, editable reserve floors), Concurrent Writers (slots, locks,
  waits, `WRITERS_MAX`, pause, drain, writes per minute), Proposals (readable diffs, approve, reject with a reason, bulk,
  conflicted proposals reject-only), Clients & Access (profiles, scopes with a confirmation when raising, default scope,
  grants and PATs by profile with last use and revoke, PAT creation shown once), Journal (view only), Settings (every
  change confirmed and audited), and placeholder pages for Maintenance and Repository Mappings ("Coming in a later chunk").
- **Admin API** `/api/admin/*` and the **live stream** `/api/admin/stream` (`src/admin/`,
  [docs/dashboard.md](dashboard.md), [ADR 0013](adr/0013-dashboard-and-admin-api.md)). Owner session only (OAuth tokens
  and PATs are never accepted), Origin and CSRF on every state-changing request, strict CSP and security headers on `/ui`,
  every change through the owner commands, engine controls or runtime settings functions (audited, evented), secrets
  redacted. The stream has heartbeats, `Last-Event-ID` replay and `resync`.
- `npm run build` now builds the UI too (`ui/dist`, served at `/ui` with an SPA fallback); `npm run test:e2e` is an opt-in
  Chromium smoke test; `typecheck` also covers `ui/` and `test/ui/`. React, Vite and the test tooling are dev
  dependencies.
- **Interim budget sampler** (`src/admin/sampler.ts`): every 10 s `engine.recordBudgetSample(governor.snapshot())`,
  stopped on shutdown. Chunk 6 replaces it with the `budget-sampler` job.
- New settings `ADMIN_STREAM_HEARTBEAT_SECONDS`, `ADMIN_STREAM_REPLAY_EVENTS`, `ADMIN_BUDGET_PUSH_SECONDS`,
  `ADMIN_BUDGET_SAMPLE_SECONDS` (`src/config/admin.ts`).
- **Changes outside chunk 5's own files** (all small and additive unless noted):
  - `src/auth/http.ts`, `src/auth/pages.ts`: `Referrer-Policy: same-origin` on the sign-in, consent and sign-out pages.
    **Bug fix:** under `no-referrer` a browser sends `Origin: null` on form POSTs, so owner sign-in was refused in a real
    browser ([ADR 0014](adr/0014-auth-pages-referrer-policy.md)).
  - `src/lk/governor/governor.ts`: `setReserveFloors()` (floors change live; `settings` is now a getter).
  - `src/jobs/journal.ts`: an optional `id` filter on `journalLookup` (the journal detail view).
  - `src/runtime.ts`: applies stored dashboard settings, starts and stops the sampler, exposes `config` and `envConfig`.
  - `src/server.ts`: mounts the admin plugin (`admin` option), `loadAdminConfig` at start-up.
  - `src/config/index.ts`: one export line. `tsconfig.json`, `vitest.config.ts`, `package.json`, `.gitignore`,
    `.prettierignore`: UI build, typecheck and test wiring.
- **Known issue found, not fixed (chunk 3):** `bridge_info` calls `getProject` and `listMembers` with `{ path: … }`
  parameters, which the registry rejects (`INVALID_PARAMS`), so it always reports an unknown role and no project name.
  The dashboard's own health check calls them with `{}` and works.

### Chunk 2b: identity, scopes and proposals

- **Integration with chunk 3** (merged from `main`):
  - `createRuntime` builds the policy layer and passes the live gate and the proposal sink to the engine
    (`policy.attach(engine)` after start); new `createBridge()` in `src/server.ts` is the boot path `main` runs, so the
    runtime and the HTTP server share one policy layer. Every engine-backed tool uses `mcpOrigin(ctx, tool)` (chunk 3's
    placeholder `principalFor` is gone).
  - Visibility: `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_result_page` and
    `bridge_errors_recent` show only the caller's own work; another principal's id answers like an unknown one.
    `bridge_journal_lookup` shows every principal's entries with principal, profile, approver and `mine`; job ids on
    your own entries only.
  - Uploads are not proposable: at `propose`, `lk_upload_image` and raw `createImageUpload` / `createImageAsset`
    are refused before anything is sent.
  - `UPLOAD_PUT_TIMEOUT_MS` (default 120000, 5000-600000, validated at start-up): the signed-URL PUT's own per-attempt
    deadline; `governor.execute` takes an optional `timeoutMs` (**interface addition** in `src/lk`).
  - `bridge_info` reports the caller's `profile`, `scope` and `canWriteAs`.
  - Hidden write tools stay callable so a direct call gets the read-only message; only `tools/list` is filtered.
  - Member admin is refused by the engine guard (`MEMBER_ADMIN_DISABLED`), not the gate, so agents see that code.
  - List summaries over 24,000 characters reduce items to id, name, type and parent: `listResources` at limit 100
    stays inline (it had become a stored handle). Measured default results: getDocumentBlocks on a 3,000-block page
    about 2,300 tokens, listResources at 100 about 3,900, search at 100 about 1,100 (`test/tools/result-size.test.ts`).
  - The proposal tools return compact JSON with the budget footer, like every tool; `proposal_captured` results
    carry the summary and point to `bridge_proposal_status`.
  - ADR renumbered: live policy evaluation is ADR 0012 (chunk 3's tool layer keeps 0011).

- `src/policy` ([docs/policy.md](policy.md), [ADR 0012](adr/0012-live-policy-evaluation.md)): profiles
  (`agent_profiles`: label, kind `claude` · `chatgpt` · `claude-code` · `other`, scope), scopes `read` · `propose` ·
  `write`, the default scope for new connections (`read`), and the audit log. Migration `0300_policy_init.sql` adds
  the tables and a `profile_id` on auth codes, grants and PATs; grants and PATs from before this chunk move to a
  `legacy` profile at `read`.
- The real `PolicyGate` (`LivePolicyGate`), evaluated live (≤ 1 s cache, cleared on any change): `read` denies writes
  with a clear message, `propose` turns writes into proposals, `write` allows; member admin refused unless
  `LK_ALLOW_MEMBER_ADMIN=true`; `system` allowed except on MCP origins; unknown, revoked or expired principals denied.
- The real `ProposalSink` (`ProposalService`): capture with validation, dry-run guards and governed reads of each
  target (version, fingerprint, pre-state); one proposal per request; compare-and-set states (`pending`, `approved`,
  `rejected`, `conflicted`, `expired`, `executing`, `executed`, `failed`); approval re-reads and detects conflicts,
  then submits a `batch_ops` job (stop on error) as the proposer with `approvedBy: 'owner'` and a single-use approval
  token bound to the proposal, so approval never loops and cannot be forged; restart reconciliation; expiry timer
  (`POLICY_PROPOSAL_EXPIRY_DAYS`, `POLICY_EXPIRY_SWEEP_SECONDS`); rejection with a reason.
- Owner command layer (`createPolicy().commands`, `actor: 'owner'`): profiles, scopes, default scope, connections
  (list, move, revoke), proposals (list, detail with diff data, approve, reject, bulk). Audited and evented; not
  reachable from MCP.
- Agent tools `bridge_proposal_status` and `bridge_proposals_mine` (read; own proposals only).
- Auth: the consent screen offers profile and scope (suggested from the redirect host; `read` preselected; the client
  name marked untrusted); grants and their tokens inherit the profile; `CallerIdentity.principalId`;
  `npm run pat -- create --profile <label> [--scope …]` and the profile in `list`.
- MCP: `McpToolProvider.access` (`read` | `write`), `ctx.principal` / `ctx.scope` in tool handlers, per-principal
  `tools/list`, call-time refusal of write tools for `read` connections; `buildServer({ policy })`.
- **Interface changes (src/jobs):** `JobOrigin.approval` (opaque), `ProposalCaptured.summary`, sink `JobsError`s are
  passed through, `policy` and `proposal` events on `JobEngineEvents`.
- Config: `src/config/policy.ts` (`loadPolicyConfig`).
- Tests: `test/policy/` (scope matrix over all 89 operations, live changes, capture without writes, exactly-once
  approval including double approval and crash/restart, conflicts, the unsupported-block guard at execution, partial
  failure, expiry, read-only and paused approval, forged approvals, tool lists per scope, consent, the `legacy`
  migration, PAT profiles, and an escalation test over every registered MCP tool). Chunk 4 tests updated for the
  consent fields and per-scope tool lists.

### Chunk 3: operation coverage, MCP tools, result shaping and image upload

- **Tools** (`src/mcp/tools/`, reference in `docs/tools.md`, ADR 0011): `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_read`, `lk_api_write`, `lk_api_batch`, `lk_api_paginate_all`, `lk_upload_image`, and `bridge_info`, `bridge_budget`, `bridge_estimate`, `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_errors_recent`, `bridge_journal_lookup`, `bridge_result_page`; optional `lk_op_<operationId>` (89) with `MCP_EXPOSE_PER_OP_TOOLS=true`. Every tool has an `access` tag and annotations; reads are `readOnlyHint: true`, writes `false` (`lk_api_write` and `lk_api_batch` are `destructiveHint: true`).
- Result shaping: budget footer on every result; summaries by default and `detail: "full"`; results over `MCP_RESULT_MAX_CHARS` (40,000) become artefact handles paged by `bridge_result_page`; typed errors. The MCP server `instructions` carry the agent guidance.
- Image upload: new job kind `upload_image` (createImageUpload, signed-URL PUT, createImageAsset) with one custom step type; SSRF-guarded PUT and URL source; `UPLOAD_MAX_BYTES`, `UPLOAD_ALLOW_URL_SOURCE`, `UPLOAD_FETCH_TIMEOUT_MS`; crash recovery.
- Wiring: `src/runtime.ts` builds governor, LK client, engine (restart-resume before the endpoint opens) and tools; `src/server.ts` uses it, passes the MCP `instructions`, and drains the engine before closing HTTP and the database on SIGTERM.
- **Interface changes outside the tool layer** (flagged for review): `src/jobs`: `SubmitRequest` gains `UploadImageSubmit`; `createJobEngine({ customSteps })`; `engine.recordResult(...)`; `UPLOAD_PUT_STEP` and the custom step types are exported; `JobsRepo.setStepParams` and `stepResult`. `src/lk`: `defaultTransport` is exported (the platform fetch under the governor). `src/mcp/server.ts`: optional `access?: 'read' | 'write'` on `McpToolProvider`. `.env.example`: the new setting names.
- Tests (`test/tools/`): all 89 operations through `lk_api_read` / `lk_api_write` against a mock LK answering from the OpenAPI spec; the official MCP client end to end with a PAT; read/write refusals and engine guards; uploads (success, SSRF, size and type, backoff, crash and resume); tool counts with per-operation tools off and on. `npm run test:sandbox` has an opt-in smoke script (`test/sandbox/`), dry-run against the mock in `test/tools/sandbox-dryrun.test.ts`.

### Chunk 2 follow-up: principals, policy hooks and batch-create recovery

- Principals: `origin.principal` (`{ principalId, profile, label }`, default `SYSTEM_PRINCIPAL`) and optional
  `origin.approvedBy`. `principal_id` and `profile` are stored on jobs, errors and journal rows (`approved_by` on jobs
  and journal rows; migration `0200_jobs_init.sql` edited in place, as it was never deployed), shown in views, the
  `step` event and writer slots, and filterable in `listJobs`, `listErrors`, `listErrorGroups` and `journalLookup`.
- Policy hooks (no policy store or proposal workflow yet): an injectable `PolicyGate` (`allow` / `deny` / `propose`;
  default allows everything) asked about every operation, reads included, at entry of `run` and `submit`, before
  anything is queued. Batches are evaluated up front (any deny denies the batch; any propose makes one proposal).
  Deny throws `PolicyDeniedError` and records an error with classification `policy`; propose calls an injectable
  `ProposalSink` and returns `{ status: 'proposal_captured', proposalId }` (the default sink treats propose as deny).
  A gate that throws counts as a deny.
- **Interface change:** `engine.submit` is now async and may resolve with `proposal_captured`.
- `createManyResources` recovery: LK's batch create is not atomic, so after an ambiguous outcome every minted id is
  verified and only the missing items are re-submitted, with their same ids, as a new step inserted to run next. The
  step is `uncertain` only when verification cannot complete (it was: first and last item checked, partial =
  uncertain). A budget wait during verification now parks the step and keeps it ambiguous.
- ADR 0010: answers to the request-id and block-version questions from LK's spec (to be confirmed by chunk 3's sandbox
  script); batch recovery updated.
- Tests: `test/jobs/policy.test.ts`, `test/jobs/batch-recovery.test.ts` (including a batch half-created at a crash);
  the stateful LK model can fail a batch part-way.

### Chunk 2: persistence, job engine, writers, locks, journal and guards

- `src/jobs`: the job engine (`createJobEngine`). Every LK call runs as a persisted step through `lk.call` /
  `governor.execute` (one request per call, `jobId` passed for fair round-robin). Job kinds `single_op`, `batch_ops`
  (`stopOnError` or `continue`) and `paginate_all` (one governed call per page, items in a pageable artefact with
  item, page and size caps). Interface in `src/jobs/README.md`.
- `engine.run(op, params, { priority, origin })`: single reads inline (not recorded), single writes inline as one-step
  jobs; queued with `{ jobId, status: 'queued', eta }` when the estimate exceeds 20 s or writes are paused.
  `engine.wait(jobId, ms)` is bounded at 25 s.
- Idempotency keys `lkb.{jobId}.{stepNo}.{attempt0}`, reused across retries and restarts. Client ids (cuid2 shape) are
  minted for every create that accepts one and persisted before the first send.
- Restart-resume with verify-before-resend for each operation family; `governor.execute` `verify` hooks for 412,
  `DUPLICATE_ID` and `NOT_FOUND` after ambiguous retries. New step status `uncertain` (job ends `failed` with
  `uncertain: true`) when an outcome cannot be established without risking a duplicate (ADR 0010).
- `BudgetWaitError` parks a job in `waiting_budget` with a persisted resume time; resumes automatically, also after a
  restart. `waiting_lock` while a step waits for its lock.
- Writer pool (`WRITERS_MAX` 1–8, live and persisted), in-process FIFO locks per document, resource, parent, calendar
  and asset, with lock-before-slot ordering (no deadlock).
- Guards (PLAN §4): `If-Match` read immediately before versioned writes (caller versions honoured; 412 is a typed
  `VersionConflictError` with the current version, never retried); the unsupported-block guard on
  `replaceDocumentBlocks` / `replaceBlock` (nested included, `allowUnsupportedLoss: true` to override), sharing one read
  with the version and the journal pre-image; cascade confirmation; member-admin refusal; read-only mode with a
  persisted runtime override.
- Write journal with pre-images, `journalLookup(filter)` and `pruneJournal` (30 days or 2 GB). No rollback in v1.
- Controls: pause all writes (persisted), drain, cancel, pause and resume a job, retry a failed step.
- Errors table (every failed call with status, LK code, `errors[]`, `requestId`, retryable, classification), grouped by
  fingerprint with count, first and last seen and a resolved flag. Event emitter and query layer for chunk 5;
  `recordBudgetSample(snapshot)` for chunk 6's sampler.
- `src/config/jobs.ts` (`jobsSettingsFrom`, `defaultJobsSettings`), exported from the config index. Migration
  `0200_jobs_init.sql`: `jobs`, `steps`, `job_artifacts` (+ `job_artifact_items`), `errors`, `budget_samples`,
  `write_journal`, `runtime_settings`.
- Per-operation engine metadata for all 89 operations (`src/jobs/op-meta.ts`). The generated registry already carries
  `risk`, `concurrency` and `versioned` for every operation, so no registry overlay was needed.
- Test support outside `src/jobs`: chunk 1's mock LK takes an optional `respond` state model (`test/contract/mock-lk.ts`;
  default behaviour unchanged, and LK's rule that 400/401/403/404 and 5xx are not stored for idempotency replay is now
  applied); `vitest.config.ts` includes `test/jobs`.
- Tests: `test/jobs/` (crash-resume with no duplicates for creates, deletes, versioned and key-only writes; guards;
  locks and slots; controls; budget waits across restarts; job kinds; metadata for all 89 operations).
- ADR 0010 (verification families, the 23-hour window, `uncertain`, write holds, lock keys).

### Chunk 4 follow-up: ChatGPT support and review fixes

- ChatGPT is a supported client (OAuth only; ADR 0008). Redirect allowlist adds `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<id>`. `OAUTH_EXTRA_REDIRECT_URIS` adds exact URIs without a code change (validated at start-up; replaces the never-deployed `AUTH_EXTRA_REDIRECT_URIS`). Refused and registered redirect URIs are logged in full. `https://chatgpt.com` joins the default `/mcp` Origin allowlist.
- RFC 9207: `iss` is on every authorization response (success, denial and every error redirect) and equals the metadata `issuer`; tested for each kind.
- Scopes: `openid` and `email` are never advertised; requesting them is ignored at the authorization endpoint and now also on refresh (previously `invalid_scope`).
- DCR (and CIMD) client registrations are never expired or pruned; only explicit deletion removes them (was: unused DCR clients pruned after 24 hours).
- Tool seam: explicit `McpToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); `title` also sent as `annotations.title`; contradictory hints refused; `bridge_info` fully annotated as read-only.
- Refresh-token grace window (`AUTH_REFRESH_GRACE_SECONDS`, default 10; ADR 0009): a just-rotated token presented again within the window gets the same successor tokens; outside it reuse still revokes the grant.
- `TRUST_PROXY` (default `loopback`): `request.ip`, the login rate limit and the logs use the real client address from `X-Forwarded-For`; trusting every address is refused.
- Tests: `test/auth/chatgpt.test.ts` (ChatGPT-style DCR and CIMD flows, `iss` everywhere), `test/auth/grace.test.ts`, TRUST_PROXY and annotation tests, five-year client retention.
- `npm audit` triaged (`docs/dependency-audit.md`): one dev-only `minimatch` advisory via ESLint, unreachable, no non-breaking fix; production has none.
- Docs: ADRs 0008 and 0009 (ADR 0007 marked partly superseded), ChatGPT sections in `docs/auth.md` and `docs/auth-live-checklist.md`, PLAN amendments (7 November 2026).
- Rebased onto `main` after chunk 1.

### Chunk 4: MCP transport and OAuth 2.1 authorization server

- `/mcp`: Streamable HTTP through the MCP TypeScript SDK v2 (`createMcpHandler` + `toNodeHandler`), serving the 2025-era stateless protocol and the 2026-07-28 protocol. A bearer gate answers `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, never redirects, validates `Origin`, and accepts OAuth access tokens or personal access tokens from the `Authorization` header only.
- Tool seam (`src/mcp/server.ts`): `McpToolProvider`, `registerTools(server, deps)`, and a stub `bridge_info` tool. Chunk 3 passes its tools to `buildServer({ tools })`.
- Authorization server (`src/auth`): RFC 9728 and RFC 8414 metadata (both paths each), Dynamic Client Registration, Client ID Metadata Documents fetched through an SSRF-hardened HTTPS client with HTTP-cache lifetimes, authorization with mandatory PKCE S256, RFC 8707 `resource` with canonical audiences, RFC 9207 `iss`, form-encoded token endpoint, rotating refresh tokens with reuse detection, `401 invalid_client` for unknown clients, RFC 7009 revocation.
- Owner login and consent: Argon2id password, optional TOTP, `__Host-` session cookie, CSRF tokens, `Origin` checks, login rate limits. The consent page shows the client, the scopes and the redirect host, with a warning for loopback-only clients.
- Personal access tokens (shown once, stored hashed) and `npm run pat`; `npm run setup:owner` prints the owner hash and optional TOTP secret.
- Auth audit events in the log, with no tokens, codes or passwords.
- `src/config/auth.ts`: zod-validated auth environment (`BRIDGE_PUBLIC_URL`, `OWNER_*`, `SESSION_SECRET`, `JWT_SIGNING_KEY`, optional `AUTH_*`).
- New shared infrastructure: `src/db/open.ts`, the migration runner `src/db/migrate.ts` (`npm run db:migrate`), migration `0100_auth_init.sql` (`auth_*` tables), and the composition root `src/server.ts` (`npm start`, `npm run dev`).
- Tests (`test/auth`, 200+ cases): a scripted OAuth client end to end, negative tests for every requirement, a real HTTPS CIMD server, and the official MCP SDK client's OAuth flow. The MCP Inspector CLI completed both PAT and OAuth flows.
- Docs: `docs/auth.md`, `docs/auth-live-checklist.md`, ADRs 0006 and 0007.

### Chunk 1: LegendKeeper client and Rate Governor

- `src/lk/governor`: the single gateway to LegendKeeper. Exact sliding-window counters for all eight counted tiers
  (write, key and project tiers plus `createManyResources` items), reactive-only upload tier, priority classes
  P0 to P3 with configurable reserve floors, FIFO per job with round-robin across jobs, write pacing (500 ms,
  stretching to 1.2 s past a projected 3,000 writes/hour), header capture on every response with snapping of
  the reported tier, 429 handling with Retry-After, refunds for requests LK never counted, and an in-flight cap.
- Retry matrix from PLAN §5.3 as a pure, tested function, including `verify` hooks for ambiguous retried writes
  and `BudgetWaitError { tier, retryAtMs }` for long waits.
- `BridgeLkError` with LK `code`, `requestId`, `errors[]`, `retryable`, `ambiguous` and a classification; the
  whole LK error catalogue is mapped by code.
- `createLkClient`: `@legendkeeper/sdk` 4.1 on the governed fetch (`maxRetries: 0`, `idempotencyKeys: false`),
  plus a registry-aware `call`. Guards: no LK request outside `execute`, one request per call, `If-Match`
  required on versioned writes.
- `governor.estimate(...)`, `formatBudgetFooter(...)`, `governor.snapshot()` and `sample` / `throttled` /
  `budget-wait` events. Injectable clock (`FakeClock` for tests).
- `idempotencyKeyFor(jobId, stepNo, attempt0)` and `costSpecFor(op, input)`.
- `src/config/lk.ts`: governor settings derived from the existing env config, plus code-level retry defaults.
- Tests: unit tests for every part above; a Fastify mock LK and contract tests (1,000-call workload at published
  and tight limits with an injected 429, a harness self-check, and fault injection through the real SDK).
- Interface documented in `src/lk/README.md`.

### Chunk 0: repository bootstrap and spec ingestion

- Scaffold: TypeScript strict ESM, ESLint (type-checked), Prettier, Vitest, `.nvmrc`, `.gitignore`, `.env.example` (names only).
- CI (`.github/workflows/ci.yml`): typecheck, lint, format, registry up-to-date, spec drift, tests, build.
- Vendored LegendKeeper OpenAPI spec (SDK 4.1.0) and `scripts/gen-registry.ts`, which generates the 89-operation registry.
- `scripts/check-spec-drift.ts`.
- Config loader (`src/config`) covering the PLAN defaults, with strict env parsing.
- ESLint guards for the governor-only rule (no raw `fetch`, no LK host literals outside `src/lk`).
- ADRs 0001 to 0005, including the MCP SDK pin (v2).
