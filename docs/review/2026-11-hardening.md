# Hardening review, November 2026 (chunk 8)

An independent review of LK-Bridge as merged on `main` at `5d77b7a` (8 November 2026), before version 1.0.0. The
reviewer did not write the code and did not treat earlier reports, the changelog or the ADRs as evidence: each claim
below was checked by reading the code and, where a test could settle it, by running one. Nothing here was run against
the real LegendKeeper API or the live server.

Status values: **Open** (not fixed; the recommendation stands), **Fixed** (changed on `chunk-8-hardening`, with a test),
**Accepted** (no change; the reason is given), **Pass** (checked, nothing to change).

## 1. Threat model

### Assets

| Asset                                                            | Where it lives                                                                                               | Worth to an attacker                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| The LegendKeeper API key (ADMIN role)                            | `/etc/lk-bridge/lk-bridge.env` (root:lkbridge 0640), the process environment, the SDK client                 | Full read and write of the project, member administration, the shared rate budget                      |
| Owner credentials (password hash, TOTP secret)                   | The env file; the password itself only in the owner's head and password manager                              | The dashboard: every scope, every proposal, every token                                                |
| Session, CSRF and JWT keys (`SESSION_SECRET`, `JWT_SIGNING_KEY`) | The env file; HKDF-derived keys in memory                                                                    | Forged access tokens (with a matching database row) and CSRF tokens                                    |
| OAuth tokens (codes, access, refresh) and PATs                   | Hashes in SQLite (`auth_*`); plaintext only in transit and, for refresh, up to 10 s in memory (grace window) | Acting as Claude, ChatGPT or Claude Code at whatever scope their profile has                           |
| Owner sessions                                                   | `__Host-lkb_session` cookie; hash in SQLite                                                                  | The dashboard                                                                                          |
| The LegendKeeper project content                                 | LegendKeeper; copies in the bridge's journal pre-images, proposal pre-states, stored results and backups     | The world itself; `unsupported` blocks cannot be recreated through the API, so their loss is permanent |
| The rate budget                                                  | LegendKeeper's counters, modelled by the governor                                                            | Denial of service to every client of the project, including the old ChatGPT bridge                     |
| Backups                                                          | `/var/lib/lk-bridge/backups` (0600)                                                                          | Token hashes, proposals, journal content                                                               |

### Actors

| Actor                                   | Trust                                                   | Reaches                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner                               | Full                                                    | Dashboard (`/ui`, `/api/admin`), consent, the server shell                                                                                                |
| Claude (claude.ai web, desktop, mobile) | As its profile's scope                                  | `/mcp` with an OAuth access token; `/oauth/*` for discovery, registration, tokens                                                                         |
| ChatGPT (Developer Mode connector)      | As its profile's scope; must keep working               | Same as Claude                                                                                                                                            |
| Claude Code                             | As its profile's scope (PAT or OAuth)                   | Same, plus a loopback redirect                                                                                                                            |
| A malicious or confused agent           | Holds a valid token; may send anything its tools accept | Every MCP tool, at its scope; indirectly the rate budget, LegendKeeper and the bridge's disk                                                              |
| A compromised client (a stolen token)   | As the token's profile until revoked                    | Same as the agent                                                                                                                                         |
| An internet attacker                    | None                                                    | Every public route: `/mcp` (401), `/.well-known/*`, `/oauth/*` (registration, login form, token endpoint), `/ui` (redirect); scanners hit everything else |
| A supply-chain attacker                 | Code in a dependency                                    | Whatever the build user or the service user can read                                                                                                      |

### Trust boundaries

1. **Internet → Caddy → bridge (127.0.0.1:8787).** TLS ends at Caddy; the bridge trusts `X-Forwarded-For` only from
   loopback (`TRUST_PROXY=loopback`). Caddy replaces any client-sent `X-Forwarded-For`.
2. **Unauthenticated → authenticated at `/mcp`.** The bearer guard (`src/auth/bearer.ts`) runs before the MCP SDK reads
   the body.
3. **Token → principal → profile → scope.** Identity comes only from the server-issued token; the scope is read live
   (≤ 1 s cache) at every engine entry.
4. **Agent → owner.** Only the owner's browser session (cookie, Origin, CSRF) reaches `/api/admin`; approvals happen only
   there. Bearer tokens are never read on admin routes.
5. **Bridge → LegendKeeper.** Every call goes through the governor (`src/lk/governor`); writes go through the job
   engine's guards.
6. **Bridge → arbitrary hosts.** Three outbound paths leave the LegendKeeper origin: the CIMD document fetch (owner
   signed in), the image URL fetch (an agent with scope `write`) and the signed-URL PUT (a host named by LegendKeeper).
   All go through the address policy (`src/auth/ip.ts`) with the check inside the connection's DNS lookup.
7. **Service user → secrets.** `lkbridge` can read the env file; so can anything that runs as `lkbridge`, including
   `npm ci` and the build during a deploy.

## 2. Summary

| Severity | Found | Fixed | Open | Accepted / pass |
| -------- | ----: | ----: | ---: | --------------: |
| Critical |     0 |     0 |    0 |               0 |
| High     |     1 |     1 |    0 |               0 |
| Medium   |     4 |     4 |    0 |               0 |
| Low      |    13 |     9 |    4 |               0 |
| Info     |     8 |     1 |    3 |               4 |
| **All**  |    26 |    15 |    7 |               4 |

Every Critical, High and Medium finding is fixed, with a test that fails without the fix. The open items are Low or Info,
each with a recommendation below; none is a vulnerability reachable by an internet attacker.

## 3. Findings

| Id   | Severity | Area                | Location                                                  | Summary                                                                                                                                           | Status   |
| ---- | -------- | ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-01 | High     | Owner login         | `src/auth/owner.ts:79-96`                                 | The login rate limit is checked before the Argon2 verify and counted after it, so concurrent attempts all pass the check                          | Fixed    |
| F-02 | Medium   | Policy / jobs       | `src/jobs/engine.ts:817-860`, `:1290`                     | The gate runs only at entry: a job keeps running after its connection is revoked or its scope is lowered                                          | Fixed    |
| F-03 | Medium   | Data safety         | `src/jobs/op-meta.ts:173`                                 | `deleteBlock` removes the block's whole subtree, `unsupported` blocks included, with no guard                                                     | Fixed    |
| F-04 | Medium   | Proposals / disk    | `src/policy/proposals.ts:61`, `:374`                      | One proposal can store 500 × 512 KB of pre-state from a single read; no cap on pending proposals                                                  | Fixed    |
| F-05 | Medium   | Uploads / transport | `src/mcp/transport.ts:52-53`, `src/server.ts:113`         | The effective `/mcp` body limit is the SDK's 4 MiB, so base64 images over about 3 MiB never reach the tool, although `UPLOAD_MAX_BYTES` is 10 MiB | Fixed    |
| F-06 | Low      | Data safety         | `src/jobs/guards.ts:59`                                   | An `unsupported` block without an `id` (legacy or malformed document) is invisible to the guard                                                   | Fixed    |
| F-07 | Low      | Uploads / policy    | `src/mcp/tools/upload.ts:57`                              | At scope `propose`, a URL image is downloaded before the upload is refused                                                                        | Fixed    |
| F-08 | Low      | Dashboard           | `src/admin/guard.ts:41`                                   | Cross-site top-level GETs to `/api/admin` carry the Lax session cookie and can spend P0 budget                                                    | Fixed    |
| F-09 | Low      | Logging             | `src/server.ts:88-115`                                    | Every scanner hit logs three info lines (incoming, not found, completed)                                                                          | Fixed    |
| F-10 | Low      | Operations          | `deploy/deploy.sh`, `deploy/healthcheck.sh`               | No warning when the live env file lacks a template variable or keeps a removed one                                                                | Fixed    |
| F-11 | Low      | MCP surface         | `src/mcp/server.ts:236-247`                               | The hidden-tools wrapper uses SDK internals; its fallback is silent, and the legacy protocol era is untested                                      | Fixed    |
| F-12 | Low      | Tests               | `test/policy/no-agent-escalation.test.ts:144`             | The tool-enumeration test does not cover the 89 `lk_op_*` tools (`MCP_EXPOSE_PER_OP_TOOLS=true`)                                                  | Fixed    |
| F-13 | Low      | Shutdown            | `src/jobs/engine.ts:217`, `:595`                          | `engine.stop()` does not release `bridge_job_wait` callers, which can hold `app.close()` up to 25 s                                               | Fixed    |
| F-14 | Low      | Governor            | `src/lk/governor/governor.ts`                             | Tier counters are in memory only; right after a restart the bridge believes the minute and hour are empty                                         | Fixed    |
| F-15 | Low      | Consent             | `src/policy/consent.ts:3`                                 | Re-approving a connection with the preselected `read` lowers an existing profile for every connection on it                                       | Fixed    |
| F-16 | Low      | Retention           | `src/policy/proposals.ts`                                 | Finished proposals (and their pre-states) are never pruned                                                                                        | Fixed    |
| F-17 | Low      | Supply chain        | `deploy/deploy.sh:161`                                    | `npm ci` and the build run as `lkbridge`, which can read the env file                                                                             | Open     |
| F-26 | Low      | Logging             | `src/server.ts` (Fastify default `routeNotFound`)         | Fastify's not-found log line carried the raw URL, query string included                                                                           | Fixed    |
| F-18 | Info     | systemd             | `deploy/lk-bridge.service:20-23`                          | The comment on `NODE_OPTIONS` misstates systemd's precedence; memory values reviewed                                                              | Fixed    |
| F-19 | Info     | SSRF                | `src/auth/safe-fetch.ts`, `src/mcp/tools/upload-http.ts`  | Outbound fetches allow any port on a public host                                                                                                  | Fixed    |
| F-20 | Info     | Durability          | `src/db/open.ts:17`                                       | `synchronous=NORMAL` under WAL can lose the last commits on power loss                                                                            | Accepted |
| F-21 | Info     | Tools               | `src/mcp/tools/bridge.ts:37-73`                           | `bridge_info`'s shared lookup records its errors against whichever caller triggered it                                                            | Fixed    |
| F-22 | Info     | Secrets             | git history                                               | Whole-history scan: no real secret found                                                                                                          | Pass     |
| F-23 | Info     | Dependencies        | `package-lock.json`                                       | `npm audit --omit=dev`: 0; dev: 10 moderate (one `minimatch` advisory, no fix published)                                                          | Open     |
| F-24 | Info     | Auth                | `src/auth/tokens.ts`, `bearer.ts`, `pats.ts`, `crypto.ts` | Access-token and PAT checks reviewed in full                                                                                                      | Pass     |
| F-25 | Info     | Auth                | `src/auth/cimd.ts`, `clients.ts`                          | The CIMD/DCR grant-type leniency (ADR 0017) cannot widen what a client may do                                                                     | Pass     |

### F-01 (High): the owner login rate limit can be bypassed with concurrent requests

`OwnerAuth.login` reads both limiters (`retryAfterMs`), then awaits `verifyPassword` (Argon2id, tens of milliseconds on
the threadpool), and only afterwards records the failure (`hit`). Every request that arrives while earlier ones are
still verifying sees the old count.

**Scenario.** An internet attacker opens 2,000 concurrent POSTs to `/oauth/login` with a valid login CSRF pair (one GET
gives the nonce cookie and token). All 2,000 pass the check, all are verified, and only then is the address locked out
for 15 minutes. Repeated every 15 minutes this is about 190,000 guesses a day instead of 480 (per-address) or 2,880
(global); with TOTP off, a weak password falls to a dictionary. It also queues 2,000 Argon2 computations on four
threads, delaying sign-in for the owner.

**Fix.** Reserve the attempt in both limiters before the expensive check and release the reservation on success, so
in-flight attempts count. Test: many concurrent wrong passwords; no more than the limit reach the verifier.

**Status: fixed** (`src/auth/owner.ts`, `src/auth/rate-limit.ts`). Test: `test/auth/owner.test.ts` › counts concurrent attempts before verifying them (25 concurrent wrong passwords against a production-cost hash: 3 verified, 22 refused; all 25 were verified before the fix).

### F-02 (Medium): jobs outlive a revoked connection or a lowered scope

`JobEngine.authorize` puts every operation to the policy gate when work is submitted. `runJob` never asks again. A batch
of 500 writes submitted at scope `write` keeps sending after the owner revokes the connection or lowers the profile to
`read`; ADR 0012 promises that "lowering a scope (or revoking) takes effect on the next call", which is true for calls but
not for queued work. The owner can cancel the job by hand, if they notice.

**Scenario.** A confused agent starts a large rewrite; the owner sees it on the dashboard and revokes the connection,
expecting it to stop. It does not.

**Fix.** Before each step that is not being recovered, re-ask the gate for jobs that act for an agent and were not
approved by the owner (an owner approval wins over the proposer's scope, as documented). Anything but `allow` fails that
step with `POLICY_DENIED` and cancels the rest of the job. A step already in flight is still verified and finished.

**Status: fixed** (`src/jobs/engine.ts` `recheckPolicy`, `src/jobs/policy.ts` `phase`). Tests: `test/policy/live-jobs.test.ts` (revoked, lowered to read, lowered to propose, lowered between steps, unchanged, internal work); `test/jobs/policy.test.ts` › is asked again before each step. Four of the six fail without the fix.

### F-03 (Medium): `deleteBlock` drops `unsupported` blocks without a guard

LegendKeeper's `deleteBlock` "removes the block and its subtree". Block deletes cannot be restored through the API, and
`unsupported` blocks cannot be created, so content under a deleted container is gone for good. The unsupported-block
guard covers only `replaceDocumentBlocks` and `replaceBlock`. CLAUDE.md says "NEVER drop `unsupported` blocks".

**Fix.** Give `deleteBlock` the block guard: the pre-image read it already makes is checked, and a delete that would
remove an `unsupported` block (the block itself or any descendant) is refused with `UNSUPPORTED_BLOCK_LOSS` unless
`allowUnsupportedLoss: true`. This extends PLAN §4 rule 2 in the direction of CLAUDE.md; it is stricter, not a change of
decision.

**Status: fixed** (`src/jobs/op-meta.ts`). Test: `test/jobs/guards.test.ts` › refuses a deleteBlock whose subtree holds an unsupported block. Tool descriptions and docs/tools.md updated.

### F-04 (Medium): proposal capture amplifies one read into hundreds of megabytes

Capture reads each distinct target once (a `seen` map) but stores the pre-state, capped at 512 KB, in every operation row.
A batch of 500 operations on one large document stores about 256 MB from one read. There is no limit on how many pending
proposals a principal may hold, and finished proposals are never pruned (F-16). The cap is applied with `String.slice`, so
it counts characters, not bytes.

**Scenario.** A propose-scope agent (malicious, or a loop) fills `/var/lib/lk-bridge`; SQLite then fails every write,
including the journal and token issuance.

**Fix.** A per-proposal pre-state budget (4 MiB in all; later operations keep the fingerprint and version, which conflict
detection uses, but not the pre-state text), a byte-correct cut, and at most 50 pending proposals per principal.

**Status: fixed** (`src/policy/proposals.ts`). Tests: `test/policy/proposals.test.ts` › keeps at most 4 MiB of pre-state per proposal; › refuses a 51st pending proposal. Both fail without the fix.

### F-05 (Medium): `/mcp` refuses large base64 uploads before the tool runs

The transport plugin replaces Fastify's content-type parsers with one that leaves the body unread, so Fastify's 1 MiB
`bodyLimit` never applies to `/mcp`; the MCP SDK reads the body with its own default of 4 MiB (`toNodeHandler` and
`createMcpHandler` both). Base64 adds a third, so an image larger than about 3 MiB sent as base64 gets HTTP 413 from the
SDK; `UPLOAD_MAX_BYTES` (10 MiB) and the tool description promise more. (The brief assumed the 1 MiB limit applied; it does
not, but the mismatch is real.) URL sources are not affected.

**Fix (chosen).** Size the `/mcp` body limit from the configured maximum: `max(4 MiB, ceil(UPLOAD_MAX_BYTES / 3) × 4 + 256
KiB)`, passed to both SDK entry points. Authentication runs before the body is read, so only a token holder can send a
large body. Lowering the maximum instead would make URL uploads smaller for no reason. Tests: an image just under
`UPLOAD_MAX_BYTES`, as base64, reaches the tool and uploads; one just over is refused by the tool with `UPLOAD_TOO_LARGE`;
a body over the transport limit gets 413.

**Status: fixed** (`src/mcp/transport.ts` `mcpMaxBodyBytes`, `src/server.ts`). Tests: `test/tools/upload.test.ts` › the /mcp body limit fits UPLOAD_MAX_BYTES as base64 (an image 1 KiB under 10 MiB uploads end to end; one just over gets `UPLOAD_TOO_LARGE` from the tool; 15 MiB gets 401 unauthenticated and 413 authenticated). Measured before the fix: 4,000,119 bytes reached the tool, 4,300,119 got the SDK's 413.

### F-06 (Low): `unsupported` blocks without an id are not seen by the guard

`unsupportedBlockIds` only collects `unsupported` blocks with a string `id`. The spec requires the id, but legacy documents
are described as having blocks that "lack ids" until `assignBlockIds`. If one ever comes back without an id, a replace would
drop it silently, because it cannot be echoed.

**Fix.** Count id-less `unsupported` blocks as always lost (`(no id) #n` in `blockIds`) and say to run `assignBlockIds`.

**Status: fixed** (`src/jobs/guards.ts`, `src/jobs/errors.ts`). Test: `test/jobs/guards.test.ts` › counts an unsupported block without an id as lost.

### F-07 (Low): a propose-scope agent can make the bridge fetch URLs

`lk_upload_image` resolves the image (downloading a URL source, up to `UPLOAD_MAX_BYTES`) before `engine.submit`, where the
gate refuses uploads at scope `propose`. docs/policy.md says such uploads are refused "before anything is sent". The fetch
is limited to public addresses, so the harm is bandwidth and an outbound request on the bridge's address.

**Fix.** Refuse at scope `propose` before resolving the image, with the same message the gate gives.

**Status: fixed** (`src/mcp/tools/upload.ts`). Test: `test/tools/policy-e2e.test.ts` › uploads under propose scope (a URL source now answers `POLICY_DENIED`; before the fix it tried to fetch and answered `UPLOAD_URL_FAILED`).

### F-08 (Low): cross-site navigations reach admin GET routes

The session cookie is `SameSite=Lax` (deliberately, for the consent page), so a top-level navigation from another site
carries it. Admin GETs need no CSRF token. `GET /api/admin/overview?refresh=true` re-checks LegendKeeper, and
`GET /api/admin/mappings/sets/:id/preview?resourceId=…` makes up to 33 reads at P0, which may use the whole remaining budget.
A page the owner visits could open such URLs repeatedly. Nothing is written and nothing is disclosed (the response goes to
the owner's own tab), so this is budget abuse only.

**Fix.** Refuse `/api/admin` requests whose `Sec-Fetch-Site` is `cross-site` or `same-site` (browsers send it; the
dashboard's own requests are `same-origin`, and an address typed into the bar is `none`).

**Status: fixed** (`src/admin/guard.ts`). Test: `test/admin/auth.test.ts` › refuses requests a browser marks as coming from another site. The browser smoke test (real Chromium) still passes.

### F-09 (Low): unmatched routes are logged at info level, three lines each

Fastify's default request logging writes "incoming request", "Route GET:/info.php not found" and "request completed" at
info for every scanner hit, which buries the auth events the runbook greps for.

**Fix.** Fastify's own request logging off; one compact `request completed` line (method, path without query, status,
time, client address) at info for matched routes; unmatched 404s at debug. Auth events are logged by `src/auth/events.ts`
and keep their levels. No request body is ever logged.

**Status: fixed** (`src/server.ts` `CompactRequestLog`). Test: `test/auth/logging.test.ts` (scanner paths log nothing at info; one compact line per request without the query; auth events keep their level).

### F-10 (Low): env drift is invisible

A release that adds a setting to `deploy/env.template`, or removes one, gives the owner no hint.

**Fix.** `env_drift_report` in `deploy/lib.sh`, called by `deploy.sh` (after pre-flight) and `healthcheck.sh`: it warns, by
name only, about template variables (set or commented) that the live file does not mention, and live variables that are
neither in the template nor read by the bridge. It never prints a value and never fails the run.

**Status: fixed** (`deploy/lib.sh` `env_drift_report`, called by `deploy.sh` and `healthcheck.sh`). Test: `test/unit/deploy-files.test.ts` › env drift check (quiet on the shipped template; names only, never values; never fails). shellcheck passes.

### F-11 (Low): the hidden-tools mechanism

How it works: every tool is registered on each per-request `McpServer`, then the SDK's `tools/list` handler in its private
`_requestHandlers` map is wrapped to filter the result. If the map or the handler is missing, the factory falls back to a
server with only the visible tools ("not found" for hidden ones).

- **Call-time enforcement is independent of it.** `registerTools` checks `toolVisible(access, scope)` inside each tool's
  callback, before the handler, using the request's live scope; the engine's gate refuses writes again. Neither depends on
  the list wrapper. A `null` policy (unknown or revoked principal) sees and can call read tools only, and those then fail in
  `mcpOrigin`.
- **If the SDK changes:** a renamed map or handler gives the strict fallback (safe). A change in the handler's signature or
  in how a protocol era dispatches `tools/list` could list hidden tools (a visibility leak, not an escalation). The SDK is
  pinned exactly, so this can only arrive with a deliberate upgrade.
- **Gaps:** the fallback is silent, and the tests list tools only through the official client's default era.

**Fix.** Log a warning once when the fallback is used; add a test that lists tools through a raw 2025-era (legacy)
JSON-RPC request as well as through the client.

**Status: fixed** (`src/mcp/server.ts`). Tests: `test/policy/mcp.test.ts` › the hidden-tools wrapper and its fallback; `test/tools/policy-e2e.test.ts` › the 2025-era (stateless legacy) tools/list hides write tools too. The design stays: it is fail-closed, call-time enforcement does not depend on it, and the SDK is pinned exactly. Re-run these tests on every SDK upgrade (ADR 0006).

### F-12 (Low): the escalation test misses the per-operation tools

`test/policy/no-agent-escalation.test.ts` calls every tool of the default runtime; with `MCP_EXPOSE_PER_OP_TOOLS=true` the
89 `lk_op_*` tools are registered too and are not exercised.

**Fix.** Run the same attack against a runtime with per-operation tools on, and assert the list has every registered tool.

**Status: fixed** (`test/policy/no-agent-escalation.test.ts`). The new run found that the name check `/revoke|…/` matched `lk_op_revokeInvite`, a LegendKeeper invite operation (refused unless `LK_ALLOW_MEMBER_ADMIN=true`), not bridge policy: the check was too broad for per-operation tools, so they must now be exactly `lk_op_<registry operation id>` instead. Nothing was weakened: every one of the 105 tools is still called with every hostile argument set and the policy tables must not change.

### F-13 (Low): shutdown can wait for long polls

`bridge_job_wait` waits up to 25 s on an engine timer. `engine.stop()` does not release those waiters, so `app.close()`
can wait for them after the 20 s drain: 45 s in the worst case, exactly `TimeoutStopSec`.

**Fix.** `stop()` resolves every pending `wait` with the job as it stands.

**Status: fixed** (`src/jobs/engine.ts`). Test: `test/jobs/controls.test.ts` › stop answers a pending wait at once.

### F-26 (Low, fixed): the not-found log line kept the query string

Found while fixing F-09. Fastify's default `routeNotFound` logged `Route GET:/path?query not found` with the raw URL, so a
mistyped OAuth callback or a probe carrying a token in its query would have put it in the journal. The bridge's own
request serializer already stripped queries; this one line bypassed it. Fixed with F-09: the line is now the path only,
at debug.

### F-14 (Low, open): the governor forgets its counters on restart

Windows are in memory. After a restart the bridge starts from zero although LegendKeeper still counts the last minute and
hour; the first responses correct only the tightest tier. A restart in the middle of heavy writing can meet a 429 (which the
governor then honours). **Recommendation:** persist a compact snapshot of the write tiers on shutdown (or from the 10-second
budget samples) and seed the windows from it at start, conservatively. Not done here: the governor is chunk 1's core and the
gain is small.

**Status: fixed in v1.0.1** (`src/lk/governor/persist.ts`, `governor.ts`; migration `0500_governor_counters.sql`). Every
tier's recent counts (not only the write tiers) are saved as compact buckets stamped with the latest time in each, so the
restored model can only over-count; at most every 10 s while they change and on shutdown; restored at start with stale
buckets dropped, future ones clamped, totals capped at the limit and an active 429 block kept. A missing, corrupt or
unreadable record starts empty with a warning. The governor's public interface is unchanged (one optional constructor
option). Tests: `test/unit/governor-persist.test.ts` (a full write-minute across a restart makes the next write wait until
the minute has passed; stale data ignored; corrupt and missing records; save timing; the SQLite store).

### F-15 (Low, open): re-consent lowers an existing profile

The consent page always preselects `read` (a documented decision). Choosing an existing profile at `write` and approving
without touching the selector sets that profile to `read` for every connection on it. Fail-safe, but surprising, for
example when ChatGPT reconnects. **Recommendation:** for an existing profile, preselect its current scope (never raising it),
or warn on the page that the profile will be lowered. Left open because it changes a documented consent decision; it needs
the owner's call.

**Status: fixed in v1.0.1** (owner's decision, [ADR 0019](../adr/0019-consent-keeps-existing-scope.md); `src/policy/consent.ts`,
`src/auth/pages.ts`, `src/auth/routes/authorize.ts`). An existing profile's current scope is preselected; a new profile
gets the configured default (`read`); any change to an existing profile's scope is applied only after a confirmation page
that shows the profile-wide warning. Tests: `test/policy/mcp.test.ts` › "consent keeps an existing profile's scope unless
the owner confirms a change" (six tests).

### F-16 (Low, open): proposals are never pruned

`expired`, `rejected`, `executed`, `failed` and `conflicted` proposals, with their pre-states, stay for ever.
**Recommendation:** a `proposal-prune` maintenance job (for example: drop pre-states of finished proposals after 30 days,
rows after 180), matching `journal-prune`.

**Status: fixed in v1.0.1** (`ProposalService.pruneFinished` in `src/policy/proposals.ts`, job `proposal-prune` in
`src/maintenance/jobs.ts`). Daily at 03:45 (London), the job deletes `executed`, `rejected`, `expired` and `failed`
proposals that finished more than `POLICY_PROPOSAL_RETENTION_DAYS` (default 90) days ago, with their operations and
pre-state; `pending`, `approved`, `executing` and `conflicted` proposals are never pruned (the owner chose to keep
conflicted ones). Jobs, journal entries and audit rows keep the proposal id as text. Tests: `test/maintenance/jobs.test.ts`
› "proposal-prune" (a real executed proposal and one of each other state; inside and past the retention; job and journal
kept; never the open states; the configured retention).

### F-17 (Low, open): the deploy builds as the service user

`deploy.sh` runs `npm ci` (dev dependencies included) and `npm run build` as `lkbridge`, which can read
`/etc/lk-bridge/lk-bridge.env`. npm 11 already skips unapproved install scripts (the native modules load from their
prebuilds), but build-time code (TypeScript, Vite and their plugins) still runs with access to the LegendKeeper key.
**Recommendation:** build as a separate user without read access to `/etc/lk-bridge`, or in CI, and deploy the built
artefacts; at least keep `package-lock.json` reviewed on every dependency change.

### F-18 (Info): systemd memory settings

The unit says the env file "is read after this line, so NODE_OPTIONS there would replace it". systemd applies
`EnvironmentFile=` over `Environment=` whatever their order; the conclusion is right, the reason is not.

The values are consistent: a 700 MB V8 old space plus young generation, code and external memory (upload buffers live
outside the heap) stays under `MemoryHigh=900M`, which throttles before `MemoryMax=1G` kills. What the bridge needs is far
less (see the soak measurement in section 4, item 15). Recommendation in section 4.

**Status: fixed** (the comment in `deploy/lk-bridge.service`). Values unchanged; measurements and recommendations in section 4, item 15.

### F-19 (Info, open): any port

The CIMD fetcher and the image fetcher accept any port on a public address, so an agent with scope `write` can make the
bridge open TLS connections to arbitrary ports of public hosts. **Recommendation:** allow only 443 for image URLs, if the
owner never needs other ports.

**Status: fixed in v1.0.1** (`src/auth/ports.ts`, used by `src/auth/safe-fetch.ts` and `src/mcp/tools/upload-http.ts`).
All three outbound paths (the CIMD document, the image source URL and every redirect hop, the signed-URL PUT) allow port
443 only, unless the exact `host:port` is in the new setting `OUTBOUND_EXTRA_PORTS_ALLOWLIST` (default empty; parsed at
start-up, a malformed entry stops the bridge). The check is part of each guard's URL check, which every hop passes, and
`guardedRequest` checks again before DNS or connect. Tests: `test/unit/outbound-ports.test.ts`; `test/auth/cimd.test.ts` ›
allows only port 443 unless host:port is listed (no DNS lookup happens); `test/tools/upload.test.ts` › "outbound ports"
(refused and listed image URLs, redirect hops to unlisted ports refused and never sent, a listed hop followed, a signed PUT
on an unlisted port never contacted).

### F-20 (Info, accepted): `synchronous=NORMAL`

Under WAL, NORMAL can lose the last transactions on power loss (not on a process crash) but never corrupts the database. A
lost "running" marker means a step is sent again with the same idempotency key and verified; acceptable.

### F-21 (Info, open): `bridge_info` lookup attribution

The 10-minute project lookup is shared; if it fails, the error is recorded against the principal whose call triggered it.
Cosmetic.

**Status: fixed in v1.0.1** (`src/mcp/tools/bridge.ts`, `BRIDGE_INFO_LOOKUP_ORIGIN`). The lookup's `getProject` and
`listMembers` reads run as the bridge's own work (origin kind `system`, no principal, P1), so their errors are recorded
against `system`; the tool still checks that the caller has a principal and still reports the caller's profile and scope.
Test: `test/tools/info.test.ts` › records the lookup's errors against the system principal (fails without the fix).

### F-22 (Info, pass): secrets in the git history

`git log --all -p` over every reachable commit (18 commits on `main` and the session branch) was searched for known key
formats (GitHub, OpenAI, AWS, Google, Slack, PEM private keys), JWTs, Argon2 hashes, `otpauth` secrets, `lkb_*` tokens,
assignments of every secret variable name in `.env.example`, and high-entropy string literals. Only test fixtures were
found (`mock-key-not-real`, `e2e-password-not-a-secret`, `sandbox-only-*`, `lkb_pat_SECRETSECRET…`, a 1-pixel PNG). No
`.env`, key or certificate file was ever committed. `deploy/env.template` and `.env.example` hold names, blanks and
non-secret defaults only (also enforced by `test/unit/deploy-env-template.test.ts`). Limit: refs not fetched here (closed
pull-request heads on GitHub) were not scanned; enable GitHub secret scanning for the repository to cover them.

### F-23 (Info, open): dependency audit

`npm audit --omit=dev`: **0 vulnerabilities**. Full: 10 moderate, all one advisory (`minimatch` < 11, GHSA-g3hv-75wg-m249)
through ESLint and typescript-eslint, which are lint-only and already at their newest releases (eslint 10.14.0,
typescript-eslint 8.72.1; ESLint still requires `minimatch ^10`). Unchanged since docs/dependency-audit.md; same action.
Security-relevant runtime pins (exact in `package-lock.json`): fastify 5.12.8, @fastify/cookie 11.1.5, jose 6.2.15,
argon2 0.45.2, better-sqlite3 13.0.3, zod 4.6.7, @modelcontextprotocol/server 2.4.0 and node 2.1.2 (exact in
`package.json` too); each is the newest published.

### F-24 (Info, pass): the hand-written access-token check (ADR 0006)

Checked in `src/auth/tokens.ts`, `bearer.ts`, `pats.ts`, `crypto.ts`:

- **Signature and algorithm:** `jwtVerify` with `algorithms: ['HS256']`, so `none` and asymmetric confusion are refused;
  the key is HKDF-derived from `JWT_SIGNING_KEY` with a purpose label. `typ` must be `at+jwt`; `iss` must equal the issuer.
- **Expiry:** `exp` required and checked (5 s tolerance); `iat`, `jti`, `aud` required.
- **Audience:** every `aud` value is canonicalised (lowercase scheme and host, default port dropped, trailing slash and
  fragment removed) and compared with the canonical MCP URL.
- **Revocation:** a database row per token (`auth_access_tokens`) is required and must not be revoked; revoking a grant
  revokes its access tokens; deleting a client cascades (foreign keys are on).
- **PATs:** looked up by SHA-256 of the presented token (high entropy, so an unkeyed hash is right; the lookup leaks nothing
  useful through timing), refused when revoked or expired; tokens over 200 characters are refused before hashing.
- **Timing:** PKCE, client secrets and CSRF tokens are compared with `safeEqual` (hash then `timingSafeEqual`).
- **Header parsing:** only `Authorization`, RFC 6750 b64token syntax, length-capped; never from the query or body.

### F-25 (Info, pass): OAuth server and the CIMD leniency

PKCE S256 only (43-character challenge, verifier syntax checked, single-use code consumed atomically, reuse revokes the
grant); `resource` canonical on both requests; redirect URIs must be both registered and on the allowlist (the ChatGPT
pattern has escaped dots; loopback any port; extra URIs validated at start-up); RFC 9207 `iss` on every redirect; refresh
rotation with reuse detection, and the grace window keyed by the rotated token's hash, same client only, in memory only.

The ADR 0017 leniency: a document or registration **without** `authorization_code` is refused; a CIMD document whose
`token_endpoint_auth_method` is anything but `none` is refused, as is one carrying `client_secret`; `response_types` must
include `code` (DCR: exactly `["code"]`). Only the intersection with the supported grants is stored, and the token endpoint
checks the stored grants, so an ignored grant can never be used. The CIMD fetch happens only for a signed-in owner, through
the SSRF guard (decimal, octal and hex IPv4 forms are normalised by the URL parser before the check; IPv4-mapped, NAT64,
6to4 and Teredo IPv6 forms are refused; redirects refused; 4 s; 8 KiB).

## 4. The sixteen review areas

Verdicts: **Pass** (checked; nothing to change), **Pass after fixes** (the findings named were fixed), **Open** (a
finding remains open, with its recommendation).

| #   | Area                                                                             | Verdict           | Findings                           |
| --- | -------------------------------------------------------------------------------- | ----------------- | ---------------------------------- |
| 1   | The hand-written access-token check (ADR 0006)                                   | Pass              | F-24                               |
| 2   | The OAuth server, redirect allowlists, CIMD/DCR leniency                         | Pass              | F-25 (F-19 open, Info)             |
| 3   | Policy gate, approval token, visibility, tool enumeration                        | Pass after fixes  | F-02, F-04, F-07, F-12 (F-15 open) |
| 4   | The hidden-tools mechanism                                                       | Pass after fixes  | F-11                               |
| 5   | SSRF (CIMD fetch, image fetch, signed PUT)                                       | Pass              | F-07 (F-19 open, Info)             |
| 6   | Dashboard and admin API                                                          | Pass after fixes  | F-01, F-08                         |
| 7   | Secrets: history, logs, templates                                                | Pass after fixes  | F-22, F-26 (F-17 open)             |
| 8   | `npm audit` and pinned versions                                                  | Open (no fix yet) | F-23                               |
| 9   | Governor under load, after restarts, retries, parking                            | Pass, one open    | F-14 open; soak below              |
| 10  | Crash-resume, verify, the unsupported-block guard, If-Match, createMany recovery | Pass after fixes  | F-03, F-06                         |
| 11  | The proposal approval path end to end                                            | Pass after fixes  | F-02, F-04 (F-16 open)             |
| 12  | Body limit against `UPLOAD_MAX_BYTES`                                            | Pass after fixes  | F-05                               |
| 13  | Logging noise                                                                    | Pass after fixes  | F-09, F-26                         |
| 14  | Env drift                                                                        | Pass after fixes  | F-10                               |
| 15  | systemd hardening and memory                                                     | Pass              | F-18                               |
| 16  | Graceful shutdown, backups and restore, rollback                                 | Pass after fixes  | F-13, F-20                         |

Notes per area, beyond the findings:

1. **Access tokens.** See F-24. Also confirmed: a deleted client's tokens stop working (the foreign keys cascade, and
   they are enforced), and revoking a grant revokes its refresh and access tokens in one transaction.
2. **OAuth.** See F-25. The ChatGPT pattern's dots are escaped; `OAUTH_EXTRA_REDIRECT_URIS` entries are validated at
   start-up; DCR is rate-limited per address behind `TRUST_PROXY`; the grace window keeps no plaintext on disk.
3. **Policy.** Identity comes only from the token; `mcpOrigin` never carries `approvedBy` or an approval; the approval
   token is an in-process object checked by identity, bound to one proposal, principal and the exact operations and
   params hashes in order, valid for 120 s, consumed after submission, and honoured only while the proposal is `approved`;
   `approvedBy` without it is refused. Jobs, stored results, errors and proposals are filtered by principal and a foreign
   id answers exactly like an unknown one; the journal is shared by design (now for every write). The enumeration test
   calls every registered tool, now including the 89 `lk_op_*` tools (F-12).
4. **Hidden tools.** See F-11: the list wrapper relies on SDK internals but fails closed, and call-time enforcement
   (`registerTools` and the engine's gate) is independent of it.
5. **SSRF.** Both fetchers check every resolved address inside the connection's own DNS lookup (no rebinding window);
   decimal, octal and hex IPv4 forms are normalised by the WHATWG URL parser before the literal check; IPv4-mapped, NAT64,
   6to4, Teredo and every non-`2000::/3` IPv6 address are refused; CIMD follows no redirect, the image fetch at most 3,
   each re-checked; deadlines and byte caps on both; the PUT only to a host LegendKeeper named, with its error body
   replaced. Ports were not restricted (F-19, fixed in v1.0.1: 443 only unless listed).
6. **Dashboard.** `__Host-` cookie, HttpOnly, Secure, SameSite=Lax; state-changing requests need the bridge's own `Origin`
   and a session-bound HMAC token; cross-site requests are now refused (F-08); the CSP has no inline script or style;
   ADR 0014's `same-origin` referrer on the auth pages is sound (nothing is sent to other sites, and it is what makes the
   form `Origin` check work in browsers). `TRUST_PROXY=loopback` with Caddy replacing client-sent `X-Forwarded-For` keys the
   sign-in limit on the real address; F-01 closes the concurrency hole. No admin route reads `Authorization` (the test
   that enumerates the routes runs every one with a valid OAuth token and a valid PAT). TOTP has replay protection.
7. **Secrets.** See F-22 and F-26. Logs: the request serializer and the new request lines keep paths only; auth events
   never carry tokens or codes (`test/auth/flow.test.ts` scans every line); refused client metadata never logs a secret
   field; signed upload URLs never reach an error, the journal (now redacted there too) or a tool result.
8. **Dependencies.** See F-23.
9. **Governor.** The 1,000-call contract workload (published and tight limits, another key draining the project tier, an
   injected 429) never makes the mock refuse; every retry-matrix row and budget-wait parking (across restarts) is tested.
   F-14 remains. The soak against the mock with the real pacing is in section 5.
10. **Job engine.** Crash-resume verifies before re-sending per operation family; versioned writes always carry `If-Match`
    (the governor refuses one without it); `createManyResources` verifies every minted id and re-sends only the missing
    ones. The guard misses were F-03 and F-06.
11. **Approval.** Compare-and-set transitions (double approval cannot run twice), a re-read of every target with conflict
    on any change, versions pinned as `If-Match`, crash reconciliation by the job's origin. A lowered scope mid-approval
    does not stop owner-approved work (documented, kept). F-04 limited capture; F-16 is open.
12. **Body limit.** See F-05: the 1 MiB Fastify limit in the brief never applied to `/mcp`; the SDK's 4 MiB did.
13. **Logging.** See F-09 and F-26.
14. **Env drift.** See F-10.
15. **systemd and memory.** The hardening is appropriate for a Node service (no `MemoryDenyWriteExecute`, which V8's JIT
    cannot run under; `SystemCallFilter` deliberately left for a tested change). Measured here: the full bridge (HTTP,
    auth, MCP, dashboard, engine, with an in-process mock LegendKeeper and the tsx loader) used **139 MB** RSS idle and
    **153 MB** after 900 requests; the 1,000-write soak peaked at **225 MB** RSS (69 MB of V8 heap), with the mock in the
    same process (section 5). `MemoryHigh=900M`, `MemoryMax=1G` and a
    700 MB heap are consistent with each other and leave about four times the observed peak; a maximum-size base64 upload adds
    about 60 to 80 MB for its duration. **Recommendation:** keep them for now; after a busy week on the server, if
    `MemoryPeak` stays under 300 MB, `MemoryHigh=500M`, `MemoryMax=640M` and `--max-old-space-size=400` would still be
    generous. How to watch: docs/runbook-deploy.md, "Memory".
16. **Shutdown, backups, rollback.** SIGTERM drains (20 s), stops the engine (now releasing long polls, F-13), closes HTTP
    and the database; `TimeoutStopSec=45` covers it. Backups use `sqlite3 .backup` with an integrity check; restore is now a
    script that checks the backup first and moves the live files aside, tested end to end on a live WAL database
    (`test/unit/backup-restore.test.ts`). Rollback steps are sound; 1.0.0's only migration is additive, so rolling back from
    it needs no restore (runbook, "Rollback").

## 5. Required changes A to E

| Change                 | Status | Where                                                                                                                             |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| A. Journal every write | Done   | `src/jobs/step-exec.ts`, `src/jobs/journal.ts`, migration `0201`, `bridge_journal_lookup`, `GET /api/admin/journal`, Journal page |
| B. Soak test           | Done   | `npm run soak:sandbox`, `deploy/soak-sandbox.sh`, `test/sandbox/soak.ts`, dry run `test/tools/soak-dryrun.test.ts`                |
| C. Browser smoke test  | Done   | `npm run test:e2e`: 4 of 4 pass here (with `CHROMIUM_PATH`); runbook "Browser smoke test"                                         |
| D. Version 1.0.0       | Done   | `package.json`, `package-lock.json`, `docs/CHANGELOG.md`; no tag pushed                                                           |
| E. PLAN amendment      | Done   | `docs/PLAN.md`, amendment 6, verbatim; nothing else in the file changed                                                           |

**A.** Every write the engine sends gets an entry before it is sent (outcome `pending`, then `applied`, `not_applied` or
`unknown`), with operation, target (for a create, the new entity: its client id or the id LegendKeeper returns), resource,
document, principal, profile, `approvedBy`, job and step, and time. Pre-images are kept only where PLAN §6.4 keeps them
(the destructive writes, and the updates and moves it lists). Volume: every filter has a `(column, id)` index, `since`
becomes an id bound, and pages use an id cursor (`before` / `nextBefore`), so a page is an index range scan with no sort
(`test/jobs/journal.test.ts` checks the query plans); `createManyResources` lists all its targets; pruning cascades to them.
Tests: `test/jobs/journal.test.ts`, `test/tools/policy-e2e.test.ts` (one agent's create seen by another), `test/ui/pages.test.tsx`.

**B. The soak against the mock LegendKeeper, with the real pacing** (the mock enforces the published limits and counts any
429 it really had to send), run here with `--writes 1000` and the default two writers:

| Measure           | Result                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Result            | PASS                                                                                     |
| Writes            | 1,002 (250 pages × 4, plus the root's create and delete); 1,000 job steps, all succeeded |
| Reads             | 1,251 (the engine's version and pre-image reads, page reads, read-backs)                 |
| Total time        | 20 min 37 s                                                                              |
| Writes per minute | 48.6                                                                                     |
| 429 responses     | **0** (the mock's own count of 429s it had to send: 0)                                   |
| Retries           | 0                                                                                        |
| Budget waits      | 0 (governor), 0 jobs parked                                                              |
| Peak memory       | RSS 225 MB, V8 heap 69 MB, buffers 18 MB                                                 |
| Clean-up          | OK (the throwaway root deleted with cascade)                                             |

48.6 writes a minute is the plan's pacing working as designed, not a shortfall: writes go out every 500 ms (120 a minute)
until the trailing minute projects more than 3,000 an hour, then every 1.2 s (50 a minute) (PLAN §5.2), which a soak
reaches within its first minute. A real run on the test world should look the same; the owner's run on the server is the
acceptance test (PLAN §11.1, chunk 8: "the soak test shows zero 429s"). The peak memory includes the mock LegendKeeper
and the tsx loader in the same process, so the bridge's own share is lower.

The dry run (`test/tools/soak-dryrun.test.ts`, in `npm test`) checks the guard (nothing written for a foreign project),
the workload, the clean-up (exactly one cascade delete, of the root it made) and the report, with the pacing set to zero.

**C.** `npm run test:e2e` had not been run since chunk 6. It needed only `CHROMIUM_PATH` here (the installed Playwright
expects a different browser build, as docs/dashboard.md says); all four checks pass, including after the chunk 8 changes
to the Journal page and the cross-site check.

## 6. Ideas noted, not built

Noted for later chunks; none was started here.

- **Undo from the journal.** Now that every write is journalled with its target and pre-images are kept for destructive
  writes, a "restore this pre-image" owner action (a proposal the owner approves) is a small step.
- **Stored-result retention** alongside `journal-prune` (proposal retention is done: `proposal-prune`, v1.0.1, F-16).
- **A per-agent activity view** on the dashboard, built on the journal's principal and profile filters: what Claude and
  ChatGPT each changed today.
- **A tree index** (the deferred `tree-snapshot` job) would let the journal show page names, not only ids.
- **Consent that keeps an existing profile's scope** (F-15), once the owner decides.
