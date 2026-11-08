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
| High     |     1 |     – |    – |               – |
| Medium   |     4 |     – |    – |               – |
| Low      |    12 |     – |    – |               – |
| Info     |     8 |     – |    – |               – |

(Counts are filled in as the fixes land; see the status column below.)

## 3. Findings

| Id   | Severity | Area                | Location                                                  | Summary                                                                                                                                           | Status |
| ---- | -------- | ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-01 | High     | Owner login         | `src/auth/owner.ts:79-96`                                 | The login rate limit is checked before the Argon2 verify and counted after it, so concurrent attempts all pass the check                          | Open   |
| F-02 | Medium   | Policy / jobs       | `src/jobs/engine.ts:817-860`, `:1290`                     | The gate runs only at entry: a job keeps running after its connection is revoked or its scope is lowered                                          | Open   |
| F-03 | Medium   | Data safety         | `src/jobs/op-meta.ts:173`                                 | `deleteBlock` removes the block's whole subtree, `unsupported` blocks included, with no guard                                                     | Open   |
| F-04 | Medium   | Proposals / disk    | `src/policy/proposals.ts:61`, `:374`                      | One proposal can store 500 × 512 KB of pre-state from a single read; no cap on pending proposals                                                  | Open   |
| F-05 | Medium   | Uploads / transport | `src/mcp/transport.ts:52-53`, `src/server.ts:113`         | The effective `/mcp` body limit is the SDK's 4 MiB, so base64 images over about 3 MiB never reach the tool, although `UPLOAD_MAX_BYTES` is 10 MiB | Open   |
| F-06 | Low      | Data safety         | `src/jobs/guards.ts:59`                                   | An `unsupported` block without an `id` (legacy or malformed document) is invisible to the guard                                                   | Open   |
| F-07 | Low      | Uploads / policy    | `src/mcp/tools/upload.ts:57`                              | At scope `propose`, a URL image is downloaded before the upload is refused                                                                        | Open   |
| F-08 | Low      | Dashboard           | `src/admin/guard.ts:41`                                   | Cross-site top-level GETs to `/api/admin` carry the Lax session cookie and can spend P0 budget                                                    | Open   |
| F-09 | Low      | Logging             | `src/server.ts:88-115`                                    | Every scanner hit logs three info lines (incoming, not found, completed)                                                                          | Open   |
| F-10 | Low      | Operations          | `deploy/deploy.sh`, `deploy/healthcheck.sh`               | No warning when the live env file lacks a template variable or keeps a removed one                                                                | Open   |
| F-11 | Low      | MCP surface         | `src/mcp/server.ts:236-247`                               | The hidden-tools wrapper uses SDK internals; its fallback is silent, and the legacy protocol era is untested                                      | Open   |
| F-12 | Low      | Tests               | `test/policy/no-agent-escalation.test.ts:144`             | The tool-enumeration test does not cover the 89 `lk_op_*` tools (`MCP_EXPOSE_PER_OP_TOOLS=true`)                                                  | Open   |
| F-13 | Low      | Shutdown            | `src/jobs/engine.ts:217`, `:595`                          | `engine.stop()` does not release `bridge_job_wait` callers, which can hold `app.close()` up to 25 s                                               | Open   |
| F-14 | Low      | Governor            | `src/lk/governor/governor.ts`                             | Tier counters are in memory only; right after a restart the bridge believes the minute and hour are empty                                         | Open   |
| F-15 | Low      | Consent             | `src/policy/consent.ts:3`                                 | Re-approving a connection with the preselected `read` lowers an existing profile for every connection on it                                       | Open   |
| F-16 | Low      | Retention           | `src/policy/proposals.ts`                                 | Finished proposals (and their pre-states) are never pruned                                                                                        | Open   |
| F-17 | Low      | Supply chain        | `deploy/deploy.sh:161`                                    | `npm ci` and the build run as `lkbridge`, which can read the env file                                                                             | Open   |
| F-18 | Info     | systemd             | `deploy/lk-bridge.service:20-23`                          | The comment on `NODE_OPTIONS` misstates systemd's precedence; memory values reviewed                                                              | Open   |
| F-19 | Info     | SSRF                | `src/auth/safe-fetch.ts`, `src/mcp/tools/upload-http.ts`  | Outbound fetches allow any port on a public host                                                                                                  | Open   |
| F-20 | Info     | Durability          | `src/db/open.ts:17`                                       | `synchronous=NORMAL` under WAL can lose the last commits on power loss                                                                            | Open   |
| F-21 | Info     | Tools               | `src/mcp/tools/bridge.ts:37-73`                           | `bridge_info`'s shared lookup records its errors against whichever caller triggered it                                                            | Open   |
| F-22 | Info     | Secrets             | git history                                               | Whole-history scan: no real secret found                                                                                                          | Pass   |
| F-23 | Info     | Dependencies        | `package-lock.json`                                       | `npm audit --omit=dev`: 0; dev: 10 moderate (one `minimatch` advisory, no fix published)                                                          | Open   |
| F-24 | Info     | Auth                | `src/auth/tokens.ts`, `bearer.ts`, `pats.ts`, `crypto.ts` | Access-token and PAT checks reviewed in full                                                                                                      | Pass   |
| F-25 | Info     | Auth                | `src/auth/cimd.ts`, `clients.ts`                          | The CIMD/DCR grant-type leniency (ADR 0017) cannot widen what a client may do                                                                     | Pass   |

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

### F-03 (Medium): `deleteBlock` drops `unsupported` blocks without a guard

LegendKeeper's `deleteBlock` "removes the block and its subtree". Block deletes cannot be restored through the API, and
`unsupported` blocks cannot be created, so content under a deleted container is gone for good. The unsupported-block
guard covers only `replaceDocumentBlocks` and `replaceBlock`. CLAUDE.md says "NEVER drop `unsupported` blocks".

**Fix.** Give `deleteBlock` the block guard: the pre-image read it already makes is checked, and a delete that would
remove an `unsupported` block (the block itself or any descendant) is refused with `UNSUPPORTED_BLOCK_LOSS` unless
`allowUnsupportedLoss: true`. This extends PLAN §4 rule 2 in the direction of CLAUDE.md; it is stricter, not a change of
decision.

### F-04 (Medium): proposal capture amplifies one read into hundreds of megabytes

Capture reads each distinct target once (a `seen` map) but stores the pre-state, capped at 512 KB, in every operation row.
A batch of 500 operations on one large document stores about 256 MB from one read. There is no limit on how many pending
proposals a principal may hold, and finished proposals are never pruned (F-16). The cap is applied with `String.slice`, so
it counts characters, not bytes.

**Scenario.** A propose-scope agent (malicious, or a loop) fills `/var/lib/lk-bridge`; SQLite then fails every write,
including the journal and token issuance.

**Fix.** A per-proposal pre-state budget (4 MiB in all; later operations keep the fingerprint and version, which conflict
detection uses, but not the pre-state text), a byte-correct cut, and at most 50 pending proposals per principal.

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

### F-06 (Low): `unsupported` blocks without an id are not seen by the guard

`unsupportedBlockIds` only collects `unsupported` blocks with a string `id`. The spec requires the id, but legacy documents
are described as having blocks that "lack ids" until `assignBlockIds`. If one ever comes back without an id, a replace would
drop it silently, because it cannot be echoed.

**Fix.** Count id-less `unsupported` blocks as always lost (`(no id) #n` in `blockIds`) and say to run `assignBlockIds`.

### F-07 (Low): a propose-scope agent can make the bridge fetch URLs

`lk_upload_image` resolves the image (downloading a URL source, up to `UPLOAD_MAX_BYTES`) before `engine.submit`, where the
gate refuses uploads at scope `propose`. docs/policy.md says such uploads are refused "before anything is sent". The fetch
is limited to public addresses, so the harm is bandwidth and an outbound request on the bridge's address.

**Fix.** Refuse at scope `propose` before resolving the image, with the same message the gate gives.

### F-08 (Low): cross-site navigations reach admin GET routes

The session cookie is `SameSite=Lax` (deliberately, for the consent page), so a top-level navigation from another site
carries it. Admin GETs need no CSRF token. `GET /api/admin/overview?refresh=true` re-checks LegendKeeper, and
`GET /api/admin/mappings/sets/:id/preview?resourceId=…` makes up to 33 reads at P0, which may use the whole remaining budget.
A page the owner visits could open such URLs repeatedly. Nothing is written and nothing is disclosed (the response goes to
the owner's own tab), so this is budget abuse only.

**Fix.** Refuse `/api/admin` requests whose `Sec-Fetch-Site` is `cross-site` or `same-site` (browsers send it; the
dashboard's own requests are `same-origin`, and an address typed into the bar is `none`).

### F-09 (Low): unmatched routes are logged at info level, three lines each

Fastify's default request logging writes "incoming request", "Route GET:/info.php not found" and "request completed" at
info for every scanner hit, which buries the auth events the runbook greps for.

**Fix.** Fastify's own request logging off; one compact `request completed` line (method, path without query, status,
time, client address) at info for matched routes; unmatched 404s at debug. Auth events are logged by `src/auth/events.ts`
and keep their levels. No request body is ever logged.

### F-10 (Low): env drift is invisible

A release that adds a setting to `deploy/env.template`, or removes one, gives the owner no hint.

**Fix.** `env_drift_report` in `deploy/lib.sh`, called by `deploy.sh` (after pre-flight) and `healthcheck.sh`: it warns, by
name only, about template variables (set or commented) that the live file does not mention, and live variables that are
neither in the template nor read by the bridge. It never prints a value and never fails the run.

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

### F-12 (Low): the escalation test misses the per-operation tools

`test/policy/no-agent-escalation.test.ts` calls every tool of the default runtime; with `MCP_EXPOSE_PER_OP_TOOLS=true` the
89 `lk_op_*` tools are registered too and are not exercised.

**Fix.** Run the same attack against a runtime with per-operation tools on, and assert the list has every registered tool.

### F-13 (Low): shutdown can wait for long polls

`bridge_job_wait` waits up to 25 s on an engine timer. `engine.stop()` does not release those waiters, so `app.close()`
can wait for them after the 20 s drain: 45 s in the worst case, exactly `TimeoutStopSec`.

**Fix.** `stop()` resolves every pending `wait` with the job as it stands.

### F-14 (Low, open): the governor forgets its counters on restart

Windows are in memory. After a restart the bridge starts from zero although LegendKeeper still counts the last minute and
hour; the first responses correct only the tightest tier. A restart in the middle of heavy writing can meet a 429 (which the
governor then honours). **Recommendation:** persist a compact snapshot of the write tiers on shutdown (or from the 10-second
budget samples) and seed the windows from it at start, conservatively. Not done here: the governor is chunk 1's core and the
gain is small.

### F-15 (Low, open): re-consent lowers an existing profile

The consent page always preselects `read` (a documented decision). Choosing an existing profile at `write` and approving
without touching the selector sets that profile to `read` for every connection on it. Fail-safe, but surprising, for
example when ChatGPT reconnects. **Recommendation:** for an existing profile, preselect its current scope (never raising it),
or warn on the page that the profile will be lowered. Left open because it changes a documented consent decision; it needs
the owner's call.

### F-16 (Low, open): proposals are never pruned

`expired`, `rejected`, `executed`, `failed` and `conflicted` proposals, with their pre-states, stay for ever.
**Recommendation:** a `proposal-prune` maintenance job (for example: drop pre-states of finished proposals after 30 days,
rows after 180), matching `journal-prune`.

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

### F-19 (Info, open): any port

The CIMD fetcher and the image fetcher accept any port on a public address, so an agent with scope `write` can make the
bridge open TLS connections to arbitrary ports of public hosts. **Recommendation:** allow only 443 for image URLs, if the
owner never needs other ports.

### F-20 (Info, accepted): `synchronous=NORMAL`

Under WAL, NORMAL can lose the last transactions on power loss (not on a process crash) but never corrupts the database. A
lost "running" marker means a step is sent again with the same idempotency key and verified; acceptable.

### F-21 (Info, open): `bridge_info` lookup attribution

The 10-minute project lookup is shared; if it fails, the error is recorded against the principal whose call triggered it.
Cosmetic.

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

To be completed as the fixes land.

## 5. Required changes A to E

To be completed as the work lands.

## 6. Ideas noted, not built

To be completed.
