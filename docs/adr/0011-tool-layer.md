# ADR 0011: The MCP tool layer, stored results and the upload job

Status: Accepted (chunk 3, 7 November 2026). Records how chunk 3 reads PLAN §4, §6 and §7 where they leave room; no PLAN decision is changed.

## Decisions

1. **One path for every operation.** `lk_api_read`, `lk_api_write`, the optional `lk_op_*` tools and `lk_api_batch` all call the job engine (`run` / `submit`), so validation, policy, version handling, the unsupported-block guard, cascade confirmation, member-admin refusal and read-only mode are applied in one place. The read/write mismatch is refused in the tool, before the engine, so it spends nothing and records nothing.
2. **Oversized results are stored as a job artefact.** Reads are normally not recorded as jobs (PLAN §6.1). When a shaped result still exceeds `MCP_RESULT_MAX_CHARS`, `engine.recordResult` stores the whole value as a `result` artefact of a succeeded one-step `single_op` job, and the tool returns the artefact id as the handle. `bridge_result_page` pages `items` artefacts (paginate_all) by item, and `result` artefacts by characters of their JSON text.
3. **The upload PUT stays under the governor.** `upload_image` is a job kind of three steps; the middle one is a custom step type (`upload_image.put`, `src/jobs/custom-steps.ts`). Its handler calls `governor.execute({ kind: 'upload', costs: { tiers: ['upload'] } })` and `lk.fetch`. The governor's transport is a host router (`createUploadTransport`): the LegendKeeper origin goes to the platform transport, every other host goes through the SSRF guard (chunk 4's `isPublicAddress`, checked in the connection's DNS lookup). This keeps retries, backoff and the upload tier in the governor. The storage host's 429 is rewritten to `UPLOAD_RATE_EXCEEDED`, and its other error bodies are replaced, so nothing derived from the signed URL leaks.
4. **Image bytes are stored with the PUT step** (a `params` artefact) so a restart can send them again, and are discarded once the PUT succeeds. The URL source is fetched before the job exists, so a crash there loses nothing but a retry.
5. **The upload key is bound just before step 3 runs**, from step 1's persisted result (`bindUploadStep`), so it survives a crash between the steps.
6. **Placeholder principal.** `principalFor` (`src/mcp/tools/shape.ts`) maps the OAuth client or PAT to `{ principalId, profile: 'default' }` and is the only thing chunk 2b replaces. The MCP tool name goes into `origin.tool`.
7. **`bridge_info` infers the key's role** from `listMembers` (LK shows member emails to ADMIN keys only), cached for 10 minutes with the project name, and degrades to `unknown` rather than failing when the budget is short.
8. **Tool settings parse separately** (`src/config/tools.ts`, as `loadAuthConfig` does), leaving the main config schema untouched.
9. **`createRuntime`** (`src/runtime.ts`) wires governor, LK client, engine and tools in dependency order and runs the engine's restart-resume before the HTTP endpoint exists. SIGTERM drains the engine (bounded at 20 s), stops it, stops HTTP, then closes the database.

## Consequences and limits

- A proposal captured for `upload_image` holds the two LK operations but not the image bytes. Chunk 2b must decide how an approved upload is run (for example by re-submitting the upload with the bytes kept in the proposal).
- `bridge_job_status` and `bridge_result_page` do not yet filter by principal; chunk 2b's profiles decide who may see whose jobs.
- The PUT shares the governor's 30 s per-attempt timeout, which a 10 MB upload over a slow link could exceed.
