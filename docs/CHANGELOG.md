# Changelog

## Unreleased: v2 session B1, the Markdown converter (9 November 2026)

The library every v2 Markdown read and write goes through ([docs/PLAN-v2.md](PLAN-v2.md) 4.7; decisions in
[ADR 0022](adr/0022-markdown-converter.md); the agent-facing guide is [docs/markdown.md](markdown.md)). It is a library
only: no MCP tools, no database tables, no LegendKeeper calls. No existing behaviour changes.

- **`src/markdown`.** `toMarkdown(document)` writes a page in the owner's schema (headings, paragraphs, lists, task
  lists, quotes, callouts, secret and expand blocks, code with its language, rules, simple GFM tables, images, every
  text mark, `<br>`, mentions as `[label](lk://resources/<id>)` or `…/docs/<documentId>`), and everything else as keep
  regions with a readable rendering, listed in `regions`. `fromMarkdown(markdown, base)` reads it back against the
  current page: unchanged blocks are restored verbatim (ids and every attribute), moved ones keep their ids, edited ones
  keep their ids and the settings Markdown cannot show, keep regions restore their block exactly, fenced `lk-block` JSON
  is taken as given, and `[[Name]]` goes through a resolver interface (`resolveMention`, for A3). The result is the new
  tree, a write plan (kept, changed, added, removed, moved, keep regions dropped) and warnings; an unchanged page gives
  an empty plan. `applyEdit` adds `append`, `prepend`, `replace`, `replace_section` and `append_to_section`, with
  sections addressed by heading path (`Biography > Early Life`, `Notes [2]`); `outline` and `getSection` work on
  Markdown. `renderMap`, `renderTimeline` and `renderBoard` give read-only Markdown for the other document types.
- **Refusals, never silent loss.** Typed errors (`MarkdownError`) for a missing keep region in a replace (unless named
  in `dropRegions`), the job engine's unsupported-block guard (`allowUnsupportedLoss`), unknown or repeated regions,
  unresolved or ambiguous mentions, invalid `lk-block` JSON, duplicate ids, editor limits (a documented, extensible
  list), the spec's field limits and nesting depth of 64, image URLs that are not project assets, images inside text,
  unknown HTML, and section paths that match nothing or several headings.
- **Exactness checked at run time.** Lines whose marks CommonMark would misread are written with HTML tags, and the
  whole page is parsed back before it is returned; a block that would not survive is shown as a keep region instead.
- **Parser:** micromark through `mdast-util-from-markdown`, with the GFM table, strikethrough and task-list
  extensions, plus the converter's own `[[…]]` construct (new dependencies; `fast-check` for the tests).
- **`npm run roundtrip`, with `deploy/markdown-roundtrip.sh`.** Reads every page of a project (or a subtree,
  `--root`) through the real engine at P3, read-only, about one read per page, and checks each: blocks → Markdown →
  blocks identical, and an empty plan for the unchanged write-back. It reports totals, keep regions and self-check
  fallbacks, and for each failing page the resource, the first difference and a minimal reproduction in
  `/var/lib/lk-bridge/roundtrip/`. Project selection as for the phase 0 spike (`LK_SANDBOX_*`,
  `--allow-bridge-project`).
- **Tests** (`test/markdown`): property-based tests (fast-check) that generate pages within the spec's schema and prove
  blocks → Markdown → blocks is the identity with an empty plan, that the parser reads every expressible page back as
  exactly what it shows, and that the Markdown is stable; an escaping fuzz over every Markdown-significant character in
  every position and place, nested marks, whitespace at run edges, CJK, right-to-left text, combining characters, emoji
  and 100,000-character paragraphs; fixtures modelled on the test world (a `[BSRC]` article, the Fourth Arkonan Age table
  page at about 3,000 blocks, the Main chronology page with document mentions, a page with an infobox, a collection and
  an unsupported block); a test for every error and warning; the round-trip script's dry run against the mock and its
  wrapper.
- `docs/PLAN-v2.md` is left out of the Prettier check, as `docs/PLAN.md` already was.

## Unreleased: v2 phase 0 spike (9 November 2026)

A server script that checks the assumptions in [docs/PLAN-v2.md](PLAN-v2.md) against the real test world before any v2
code is built on them (PLAN-v2, section 6, session 0). It changes no application behaviour: no file under `src/` is
touched, and nothing is deployed to the running bridge.

- **`npm run spike:v2`**, with the wrapper `deploy/spike-v2.sh`. Ten checks, each reported PASS, FAIL or INFO with its
  evidence: (1) whether `createManyResources` accepts a parent minted in the same batch (and, if not, whether three
  ordered calls work); (2) search with limit 100 and 50 on a rare, a broad and a very common query, repeats per matching
  document and any hidden cap; (3) downloading three image assets through the bridge's outbound fetch guard (host,
  authentication, status, content type, length, SHA-256); (4) the Fourth Arkonan Age timeline's lanes, the first 30
  events, the raw fields of five samples and how year-only, month-range and date-range events are stored, plus the event
  schema's field list from the vendored OpenAPI spec; (5) the calendar (months, eras, formats) and LegendKeeper's own
  minute values and formatted text for sampled events, the date engine's test data; (6) the structure of the age table
  page and the Main page's index table (block kinds, header cells, run structure of a row, multi-paragraph cells, rows
  around a year-only and a range row); (7) map images and features, and whether the documented pixel formula reproduces
  the reported bounds; (8) a preview of the AI REPOSITORY tree (kinds, depth, outside count, sidebar properties of five
  articles, sibling order); (9) the Characters index, its children and grandchildren, the templates, and whether exactly
  one `[INDEX] Undetermined / Unknown` exists; (10) the asset folder tree under `Characters`.
- **Same safety rules as the soak.** It reads only `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID`, refuses unless the
  key's own project is exactly the sandbox project, needs `--allow-bridge-project` while the bridge serves the test
  world, uses a temporary database, and prints no secret. Every LegendKeeper call goes through the real job engine and
  governor at priority P3. **Only check 1 writes**, under one throwaway root resource that is deleted (cascade) at the
  end of the check, with a second attempt as a last safety net; the rule is enforced in code (no write outside check 1,
  only `createResource`, `createManyResources` and `deleteResource`, only under the throwaway tree), and `--skip 1` makes
  the whole run read-only.
- **Output.** The Markdown report on stdout (progress goes to stderr) and in
  `/var/lib/lk-bridge/spike/spike-v2-<timestamp>.md`, with the calendar oracle beside it as
  `spike-v2-<timestamp>-oracle.json`. Every sample is capped at 40 lines (`--sample-lines`).
- **Tests.** `test/tools/spike-v2-dryrun.test.ts` runs the whole script against the mock LegendKeeper with a stateful
  test world (`test/tools/spike-world.ts`): the guard, all ten checks and the report, the write rules, a refused nested
  batch, the clean-up after a forced failure (check 1 stopping with an error, and a failing fallback), a hidden search
  cap, and the outbound guard refusing a port or an address. `test/tools/spike-wrapper.test.ts` runs the wrapper against
  a temporary env file. CI runs both (an explicit step, as well as `npm test`), and shellchecks the wrapper with the
  other deploy scripts.

## 1.0.2 (8 November 2026): ChatGPT's `private_key_jwt` client authentication

ChatGPT's custom connector was refused at the consent page ("The application could not be verified: client metadata
document must use token_endpoint_auth_method "none""). Its client metadata document (`https://chatgpt.com/oauth/client.json`)
authenticates at the token endpoint with `private_key_jwt` (RFC 7523), signed RS256 with keys at its `jwks_uri`. The
bridge now supports that ([ADR 0021](adr/0021-private-key-jwt-client-authentication.md)). No tag is pushed from here.

**Upgrading:** deploy as usual; migration `0101_client_assertion_jti.sql` (new table `auth_client_assertion_jtis`) is
applied at start. No settings change. To fetch ChatGPT's key set the server needs outbound HTTPS to `chatgpt.com:443`,
which the document fetch already uses.

- **Metadata.** `token_endpoint_auth_methods_supported` (and the revocation equivalent) now list `private_key_jwt` after
  `none`, which stays first so Claude keeps choosing its metadata document. New
  `token_endpoint_auth_signing_alg_values_supported` (and revocation): RS256, RS384, RS512, PS256, PS384, PS512, ES256,
  ES384, ES512; never `none` or HS*.
- **CIMD validation.** `token_endpoint_auth_method` may be `none` or `private_key_jwt`. A `private_key_jwt` document needs
  exactly one of an https `jwks_uri` or an inline `jwks` of public keys; a declared `token_endpoint_auth_signing_alg` must
  be a supported asymmetric algorithm and is then the only one accepted. The non-standard
  `token_endpoint_auth_methods_supported` in a client document is ignored: it cannot make ChatGPT's client a `none`
  client. Other methods are refused with the same `client.metadata_rejected` line as before. DCR is unchanged.
- **Token and revocation endpoints.** A `private_key_jwt` client must send a valid `client_assertion` (both grants, and
  revocation) and cannot fall back to `none`; a `none` client cannot send one. Checks: signature against the client's key
  set chosen by `kid` (an unknown `kid` refetches the set once, at most once a minute), the declared algorithm, `iss` and
  `sub` equal to the `client_id`, `aud` the issuer or the token endpoint (canonical), `exp` present and at most 5 minutes
  ahead with 60 seconds of skew, `nbf` and `iat`, and a single-use `jti` kept in SQLite until it expires (so a restart
  does not allow a replay). Failures are `401 invalid_client`.
- **Key-set fetch** through the existing SSRF guard (https, port 443 unless allowlisted, public addresses, no redirects,
  4-second deadline), 64 KiB cap, cached per `Cache-Control`/`Expires` for at least 30 seconds and at most an hour,
  `User-Agent: LK-Bridge/1.0.2 (OAuth client key fetcher)`. A non-JSON answer (an HTML challenge) fails closed and is
  logged with the status or content type received. The SSRF fetcher's content-type refusal now names the type it got.
- **Logging.** `client.assertion_rejected` gives the specific reason (`no_assertion`, `bad_signature`, `wrong_alg`,
  `alg_not_allowed`, `wrong_aud`, `expired`, `exp_too_far`, `replayed_jti`, `unknown_kid`, `jwks_fetch_failed`, …),
  never the assertion. `client.jwks_fetched` and `client.assertion_accepted` record successes; `client.metadata_fetched`
  carries `auth_method`, `jwks_uri` and `signing_alg`.
- **Tests** (`test/auth/private-key-jwt.test.ts`): ChatGPT's real document shape with a local HTTPS key-set server on an
  allowlisted port and per-run RSA and EC keys; the full flow (authorise with `iss`, consent with the `chatgpt` profile,
  code exchange, refresh, revocation); every refusal; replay across a restart on the same database; key rotation; an
  HTML key-set response; Claude's and Claude Code's real documents still working with `none`.
- Docs: [auth.md](auth.md) (client authentication, ChatGPT), [auth-live-checklist.md](auth-live-checklist.md) §9,
  PLAN amendment 7.

## v1.0.1 follow-up hotfix, shipped in 1.0.2 (8 November 2026)

- **Fixed: `migrate-to-build-user.sh` always stopped at the deploy-key check** ("lkbuild cannot authenticate to
  GitHub"), even with a working key. It piped `ssh -T git@github.com` into `grep` under `set -o pipefail`, and GitHub
  ends `ssh -T` with exit status 1 even when it accepts the key. The check is now `git ls-remote <origin> HEAD`, run as
  `lkbuild` in exactly the environment `deploy.sh` uses for git (same clean environment, `PATH`, key and SSH options);
  exit status 0 passes, and on failure git's own error is printed. Nothing is removed from `lkbridge` unless it passes,
  as before. Running the script again after this fix is safe: it picks up where it stopped (the key is then already in
  `lkbuild`'s home; it completes a partly copied SSH set-up, checks the key, and only then removes the key, its SSH
  config and `known_hosts` from `lkbridge`'s home, the same files a first run removes).
- `deploy.sh` now runs git as `lkbuild` with `GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=15'`, so a deploy
  fails at once instead of waiting for an SSH prompt; the migration's check uses the same setting.
- Runbook: the manual key checks use `git ls-remote … HEAD` (meaningful exit status) and say that `ssh -T` is to be read
  by its message only. Nothing else in `deploy/` used `ssh`.
- Tests (`test/unit/deploy-files.test.ts`): the script's own check runs against a stub GitHub whose `ssh -T` exits 1
  with the success message and whose upload-pack serves a real repository (passes; the old pipe fails against the same
  stub); a refused key fails with git's message; the check's environment must match `deploy.sh`'s `as_build`; no script
  relies on `ssh -T`.

## 1.0.1 (8 November 2026)

The open items of the chunk 8 hardening review ([docs/review/2026-11-hardening.md](review/2026-11-hardening.md)): F-14,
F-15, F-16, F-17, F-19 and F-21 are fixed. No tag is pushed from here; the owner creates the release.

**Upgrading the live server needs a one-off migration** (the deploy now uses a separate build user): follow
[runbook › Migrating an existing install to v1.0.1](runbook-deploy.md#migrating-an-existing-install-to-v101). From then on
deploy with `sudo /opt/lk-bridge/bin/deploy.sh`.

**Security and operations**

- **F-17: a separate build user** ([ADR 0020](adr/0020-separate-build-user.md)). `lkbuild` owns the checkout and the
  read-only deploy key and cannot read `/etc/lk-bridge` or `/var/lib/lk-bridge`; `lkbridge` can read and run the app but
  not write it. `deploy.sh` runs as root from a root-owned copy in `/opt/lk-bridge/bin` (it refuses to run from the
  checkout) and drops to `lkbuild` for git, `npm ci` and the build, and to `lkbridge` for the backup, migrations, health
  check and restart, each with `runuser` and an empty environment. New `deploy/migrate-to-build-user.sh` (idempotent,
  `--check` mode) moves an existing install. `healthcheck.sh` gains six PASS/FAIL permission checks. No new sudo rule:
  `lkbridge` keeps exactly start, stop, restart and status; `lkbuild` has none.
- **F-19: outbound port 443 only.** The CIMD document fetch, the image source fetch (every redirect hop) and the signed
  upload PUT refuse any other port, before DNS or connecting, unless the exact `host:port` is listed in the new setting
  `OUTBOUND_EXTRA_PORTS_ALLOWLIST` (default empty; a malformed entry stops the bridge at start-up).
- **F-14: the governor keeps its counts across restarts.** Every tier's recent counts (compact buckets, stamped late so
  they can only over-count) and any active 429 block are saved at most every 10 s while they change and on shutdown, and
  restored at start without anything older than the tier's window. Missing or corrupt data starts empty with a warning.
  Migration `0500_governor_counters.sql` (one new table). The governor's interface is unchanged apart from one optional
  constructor option (`persistence`); `src/lk/README.md` documents it.

**Policy and retention**

- **F-15: consent keeps an existing profile's scope** ([ADR 0019](adr/0019-consent-keeps-existing-scope.md), the owner's
  decision). An existing profile's current scope is preselected; a new profile still starts at the default (`read`). A
  change to an existing profile's scope is applied only after a confirmation page that shows the warning that it affects
  every connection on the profile, and is audited as before.
- **F-16: `proposal-prune`.** A new daily maintenance job (03:45 London, after `journal-prune` at 03:30) deletes
  executed, rejected, expired and failed proposals that finished more than `POLICY_PROPOSAL_RETENTION_DAYS` (new, default 90) days ago, with their stored pre-state. Pending, approved, executing and conflicted proposals are never pruned. Jobs,
  journal entries and audit rows keep the proposal id as text.
- **F-21:** `bridge_info`'s shared, cached project lookup now runs as the bridge's own work, so a failure there is
  recorded against `system`, not against the caller that happened to refresh it.

**Behaviour you will notice**

- Deploying is `sudo /opt/lk-bridge/bin/deploy.sh`; `sudo -u lkbridge …/deploy.sh` stops with a message. The health
  check prints twelve PASS lines instead of six. After a failed health check the deploy now says the new version is
  still running (it used to say "stopped").
- Re-approving a connection on an existing profile no longer lowers it to `read`; changing its scope asks for a second
  confirmation.
- Image URLs, their redirects, signed upload URLs and client metadata documents on a port other than 443 are refused
  (`UPLOAD_URL_REFUSED`, `UPLOAD_TARGET_REFUSED`, or a refused CIMD client) unless allowlisted.
- The Maintenance Jobs page lists `proposal-prune` (enabled); finished proposals older than 90 days disappear from the
  Proposals page and from `bridge_proposal_status` (they answer as unknown ids). One `proposal.pruned` audit row per run
  that removed anything.
- Straight after a restart the governor may make a call wait that it used to send at once (the counts it now remembers).
  The budget page shows the remembered counts at once.
- New env names (optional, commented in `deploy/env.template`): `OUTBOUND_EXTRA_PORTS_ALLOWLIST`,
  `POLICY_PROPOSAL_RETENTION_DAYS`. The env drift check mentions them until they are copied across.

**Tests changed, and why** (none weakened)

- `test/policy/mcp.test.ts`: the existing "pick an existing profile and set its scope" test now goes through the
  confirmation page, which is the new rule; six new tests cover F-15.
- `test/tools/policy-e2e.test.ts`: "every tool sends the real principal" allows exactly one exception, `bridge_info`'s
  two cached reads with the fixed system origin (F-21); every other tool is checked as before.
- `test/auth/cimd.test.ts`, `test/tools/upload.test.ts`: their local HTTPS servers listen on random ports, so their
  guards now list those exact `host:port` pairs, as `OUTBOUND_EXTRA_PORTS_ALLOWLIST` would; the address checks are
  unchanged and new tests cover the port rule.
- `test/unit/deploy-files.test.ts`: "deploy.sh refuses to run as root" became "runs only as root, from the installed
  copy" (the new design), with new tests for the per-step users and the migration script.
- `test/maintenance/*`: the registry has five implemented jobs; `test/policy/defaults.test.ts` lists migration 0500.

## 1.0.0 (8 November 2026)

The first versioned release: everything below, from chunk 0 to the hotfix, plus chunk 8's review. The owner creates the
release and its tag on GitHub; no tag is pushed from here.

### Chunk 8: independent hardening review

Findings, threat model and statuses: [docs/review/2026-11-hardening.md](review/2026-11-hardening.md). Decisions that
extend earlier ones: [ADR 0018](adr/0018-chunk-8-hardening-decisions.md). PLAN amendment 6 (the bridge stays on the test
world).

**Security and data safety**

- **F-01 (High): owner sign-in limit.** Each attempt is counted before the Argon2 check and given back on success; a burst
  of concurrent wrong passwords used to be verified in full before the limit noticed.
- **F-02: queued work follows the live scope.** Before each new step of a job acting for an agent the policy gate is asked
  again (`phase: 'execute'`); a revoked connection or a lowered scope stops the job (`POLICY_DENIED`, rest cancelled).
  Owner-approved and internal work is not asked again.
- **F-03: `deleteBlock` is guarded** against removing `unsupported` blocks in its subtree (`allowUnsupportedLoss` overrides).
  **F-06:** an `unsupported` block without an id always counts as lost (run `assignBlockIds`).
- **F-04: proposal limits.** At most 4 MiB of pre-state per proposal (cut by bytes) and 50 pending proposals per principal.
- **F-05: the `/mcp` body limit fits `UPLOAD_MAX_BYTES` as base64** (about 13.6 MiB for the default 10 MiB; it was the MCP
  SDK's 4 MiB, so base64 images over about 3 MiB never reached the tool). Fastify's 1 MiB limit never applied to `/mcp`.
- **F-07:** at scope `propose`, `lk_upload_image` is refused before a URL source is downloaded.
- **F-08:** `/api/admin` refuses requests a browser marks `Sec-Fetch-Site: cross-site` or `same-site`, reads included.
- **F-13:** `engine.stop()` releases pending `bridge_job_wait` calls, so a shutdown never waits for a long poll.

**Required changes**

- **A: the journal records every write**, not only destructive ones: operation, target (a create's new entity), resource
  and document, principal, profile, approver, job, time, capped params (upload keys redacted) and outcome. Pre-images stay
  with the destructive writes. Migration `0201_journal_every_write.sql` (indexes on `(column, id)`, and
  `write_journal_targets` for `createManyResources`). `bridge_journal_lookup` gains `principalId`, `profile`, `outcome`,
  `withPreImage` and the `before` cursor (`nextBefore`); so does `GET /api/admin/journal`; the Journal page pages with
  **Older** / **Newest** and filters by outcome and destructive writes.
- **B: the sandbox soak**, `npm run soak:sandbox [-- --writes N]` and `deploy/soak-sandbox.sh`: about 1,000 writes and a
  matching mix of reads through the real engine and governor under one throwaway root (deleted at the end), with a report
  of time, writes per minute, 429s (target zero), retries, budget waits and peak memory. Refuses unless the key's project
  is `LK_SANDBOX_PROJECT_ID`; the wrapper also refuses the bridge's own project without `--allow-bridge-project`.
- **C: the browser smoke test** runs again (`npm run test:e2e`, all four checks pass); how to run it is in the runbook.
- **D: version 1.0.0.**

**Operations**

- **F-09: request logging.** One compact `request completed` line per served request (method, path without query, status,
  time, address) through a `LogController` subclass; unmatched paths (scanner probes) get a plain JSON 404 and are logged at
  debug only. Auth events keep their levels; Fastify's error logging is unchanged.
- **F-10: env drift.** `deploy.sh` and `healthcheck.sh` warn, by variable name only, when the env file lacks a template
  variable, misses a new optional one, or keeps a removed one.
- **Restore is a script:** `deploy/restore.sh` checks the backup first, moves the live database and its WAL files aside
  (never deletes), and puts the backup in place; `test/unit/backup-restore.test.ts` backs up a live WAL database and
  restores it. The runbook gains "Soak test", "Browser smoke test" and "Memory" sections and a rollback note for 1.0.0.
- **F-18:** the systemd comment on `EnvironmentFile=` precedence is corrected (values unchanged).

**Tests changed, and why** (none weakened)

- `test/jobs/policy.test.ts` recorded every gate call; the gate is now also asked at execution, so the recorder separates
  the two phases, and a new test pins the execution calls.
- `test/policy/defaults.test.ts` lists every migration applied after 0200; it now includes 0201.
- `test/policy/no-agent-escalation.test.ts` also runs with all 89 `lk_op_*` tools (F-12). Its "no tool administers policy"
  name check matched `lk_op_revokeInvite` (a LegendKeeper invite operation, refused unless `LK_ALLOW_MEMBER_ADMIN=true`);
  per-operation tools must instead be exactly `lk_op_<registry operation id>`.

### Hotfix: claude.ai's grant types (CIMD and DCR)

claude.ai's custom connector was refused through both "Use Claude's published identity" (CIMD) and "Register
automatically" (DCR), because it lists `urn:ietf:params:oauth:grant-type:jwt-bearer` alongside `authorization_code`
and `refresh_token` ([ADR 0017](adr/0017-unsupported-client-grant-types-ignored.md)).

- **CIMD:** a document is accepted if its `grant_types` include `authorization_code` and its `response_types`, if
  present, include `code`. Other values are ignored and logged at info level (`client.grant_types_ignored`); the
  stored registration holds only the supported ones.
- **DCR:** the client is registered with the intersection of the requested and supported grant types, and the
  registration response returns the adjusted values (RFC 7591 §3.2.1). Only a request without `authorization_code`
  is refused. Requests listing, for example, `implicit` beside `authorization_code` were refused before and are now
  registered with `authorization_code` only.
- **Token endpoint:** unchanged; the JWT bearer grant, like any other, gets `unsupported_grant_type`.
- **Diagnosable refusals:** `client.metadata_rejected`, `client.registration_rejected` and `authorize.rejected` now
  carry the `field` at fault and its offending `value` (cut to 300 characters; never a secret) beside the `client_id`
  or `client_name`. DCR refusals other than redirect URIs were not logged at all before.
- Every other check is unchanged: exact `client_id`, redirect allowlist, SSRF guard, `token_endpoint_auth_method`.
- **Tests:** a fixture with claude.ai's and Claude Code's published documents, verbatim
  (`test/auth/fixtures/claude-client-metadata.ts`); claude.ai's document accepted through consent, token issuance and
  refresh, with the JWT bearer grant still refused at the token endpoint; documents and registrations without
  `authorization_code` still refused; the DCR intersection; and the new log fields.
- **Docs:** [docs/auth.md](auth.md) (grant types and refusal logging), the live checklist, PLAN amendment 5, and
  ADR 0007's status line.

### Chunk 6: maintenance framework, repository mappings, two fixes

- **Maintenance framework** (`src/maintenance/`, [docs/maintenance.md](maintenance.md), [ADR 0016](adr/0016-maintenance-and-mappings-choices.md)):
  a registry (id, name, description, schedule, enabled, implemented, last and next run) and a scheduler that keeps its
  state in SQLite. Schedules are a fixed interval or a daily time on the Europe/London clock (23 or 25 hours apart across
  the clocks change). No backlog: at most one overdue run per job after a restart. Every run goes through the job engine
  at P3 as the `system` principal with an origin naming the job; jobs that write to LegendKeeper are skipped, and the skip
  recorded, under read-only mode or a writes pause. Owner commands (enable, disable, change schedule, run now) are
  audited and evented.
  - Implemented: `budget-sampler` (every 10 s; replaces chunk 5's interim sampler, sparklines unchanged),
    `journal-prune` (daily 03:30), `proposal-expiry` (every 5 minutes; the proposal service's own timer is now off),
    `sqlite-optimise` (weekly).
  - Placeholders, not implementable: `assign-block-ids-sweep`, `tree-snapshot`, `orphan-and-link-audit`, `tag-audit`.
  - New settings `MAINTENANCE_ENABLED`, `MAINTENANCE_DEFER_SECONDS`, `MAINTENANCE_HISTORY_RUNS`
    (`src/config/maintenance.ts`). **Removed:** `ADMIN_BUDGET_SAMPLE_SECONDS` and `AdminSettings.budgetSampleMs`.
- **Repository mappings** (`src/mappings/`, [docs/mappings.md](mappings.md)): mapping sets (at most one active), type rules
  (subtree, template or tag → semantic type, with priority), field maps (sidebar property, infobox row, or heading/block
  → expected kind), notes and timestamps; owner CRUD (audited, evented); versioned JSON export and validated import;
  a readable summary; a read-only preview through the governor at P0. No inference engine and no MCP tool.
- **Pages:** Maintenance Jobs and Repository Mappings replace chunk 5's placeholders. Admin routes under
  `/api/admin/maintenance` and `/api/admin/mappings` keep chunk 5's owner-session, Origin and CSRF rules.
- Migration `0400_maintenance_mappings.sql`.
- **Fix: `bridge_info`** called `getProject` and `listMembers` with `{ path: … }`, which the registry rejects, so it always
  reported an unknown role and no project name. It now calls them with `{}` like the dashboard's health check
  (`test/tools/info.test.ts`).
- **Fix: member and invite operations under `propose` scope.** Checked end to end for every member and invite operation at
  every scope, with and without `LK_ALLOW_MEMBER_ADMIN` (`test/policy/member-admin.test.ts`): with it off, the three
  administrative operations were already refused with `MEMBER_ADMIN_DISABLED` at capture (the dry-run of the engine's
  guards), never captured as a proposal; the matrix now pins that. It did find a real bug with it **on**: capturing a
  proposal for `removeMember`, `revokeInvite` (and calendar writes) failed with `INVALID_PARAMS`, because the target read was
  sent with an empty `path` object. Fixed in `src/policy/proposals.ts`.
- **Changes outside chunk 6's own files** (all small; each commented in the code):
  - `src/runtime.ts`: builds and starts the maintenance scheduler and the mappings layer, stops it on shutdown, removes the
    interim sampler. `src/server.ts`: `loadMaintenanceConfig` at start-up and a `maintenanceSettings` option.
  - `src/admin/sampler.ts` deleted; `src/admin/index.ts`, `src/config/admin.ts`: sampler export and setting removed.
  - `src/admin/plugin.ts`, `types.ts`, `http.ts`: the two route groups, `maintenance` and `mappings` on `AdminRuntime`,
    status codes for the two new error types.
  - `src/jobs/engine.ts`: `recordResult` takes an optional `failure` (a failed maintenance run is a `failed` job).
  - `src/policy/proposals.ts`, `src/policy/index.ts`: the `externalExpirySweep` option; the empty-`path` fix above.
  - `src/mcp/tools/bridge.ts`: the `bridge_info` fix.
  - `src/config/index.ts`: one export line. `vitest.config.ts`: the two new test directories.
  - Tests: `test/admin/helpers.ts` (scheduler off by default, `maintenance` option), `test/admin/data.test.ts` (interim
    sampler tests removed; the job is tested in `test/maintenance/`), `test/policy/helpers.ts` (`externalExpirySweep`),
    `test/policy/defaults.test.ts` (migration 0400 is applied too), `test/ui/pages.test.tsx` and `test/e2e/dashboard.spec.ts`
    (the placeholder expectations), `test/e2e/server.ts`.
  - `ui/src/app.tsx` (routes, nav), `ui/src/pages/placeholder.tsx` deleted, `ui/src/styles.css` (one rule).
  - Docs: `docs/dashboard.md`, `.env.example`, and `deploy/env.template` (chunk 7a's test requires it to list every
    `.env.example` variable: `ADMIN_BUDGET_SAMPLE_SECONDS` out, the three `MAINTENANCE_*` in).

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
- **Known issue found, fixed in chunk 6:** `bridge_info` called `getProject` and `listMembers` with `{ path: … }`
  parameters, which the registry rejects (`INVALID_PARAMS`), so it always reported an unknown role and no project name.

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
