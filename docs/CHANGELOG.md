# Changelog

## Unreleased

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
