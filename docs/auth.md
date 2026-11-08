# Authentication and the MCP endpoint (chunk 4)

LK-Bridge is its own OAuth 2.1 authorization server and the protected resource at `/mcp`. Supported clients: Claude (web, desktop, mobile), Claude Code (OAuth or a personal access token), and ChatGPT through a Developer Mode connector (OAuth only). Design choices are in ADRs [0006](adr/0006-mcp-sdk-v2-confirmed-for-transport.md), [0007](adr/0007-oauth-authorization-server-design.md), [0008](adr/0008-chatgpt-as-a-client.md) (ChatGPT), [0009](adr/0009-refresh-token-grace-window.md) (refresh grace window) and [0017](adr/0017-unsupported-client-grant-types-ignored.md) (grant types clients may list but the bridge does not issue). What to check on the live server is in [auth-live-checklist.md](auth-live-checklist.md).

## Endpoints

| Path                                                                              | Purpose                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `POST/GET/DELETE /mcp`                                                            | Streamable HTTP MCP endpoint (bearer token required) |
| `GET /.well-known/oauth-protected-resource/mcp` and `/…/oauth-protected-resource` | RFC 9728 protected-resource metadata                 |
| `GET /.well-known/oauth-authorization-server` and `/…/openid-configuration`       | RFC 8414 authorization-server metadata               |
| `POST /oauth/register` (alias `/register`)                                        | RFC 7591 dynamic client registration (JSON)          |
| `GET /oauth/authorize` (alias `/authorize`)                                       | Authorization endpoint; shows login, then consent    |
| `POST /oauth/consent`                                                             | The owner's decision (CSRF-protected form)           |
| `POST /oauth/token` (alias `/token`)                                              | Token endpoint (form-encoded only)                   |
| `POST /oauth/revoke`                                                              | RFC 7009 revocation                                  |
| `GET/POST /oauth/login`, `POST /oauth/logout`                                     | Owner sign-in and sign-out                           |
| `GET /healthz`                                                                    | Liveness                                             |

## Redirect URIs

The bridge sends an authorization result only to these, whatever a client registers:

| Client                         | Redirect URI                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude (web, desktop, mobile)  | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`                                                        |
| ChatGPT                        | `https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/<id>` (`<id>` is letters, digits, `_` and `-`) |
| Claude Code (and other native) | `http://localhost/callback`, `http://127.0.0.1/callback`, on any port                                                                        |
| Anything else                  | Exact URIs listed in `OAUTH_EXTRA_REDIRECT_URIS` (comma-separated), checked at start-up                                                      |

A client's own registered (or CIMD-declared) URIs must also match. The consent page always shows the redirect host in large type. If a client tries a URI outside the list, the log line `client.registration_rejected` (or `authorize.rejected`) carries it in `redirect_uri`, ready to copy into `OAUTH_EXTRA_REDIRECT_URIS`.

Every authorization response, success or error, carries `iss` (RFC 9207), equal to the `issuer` in the metadata. The bridge advertises the scopes `mcp` and `offline_access` only; requests for others, such as `openid` or `email`, are ignored rather than refused.

## Grant types, and why a refused client is logged in full

The bridge issues two grants: `authorization_code` and `refresh_token`. Clients may ask for more. claude.ai's custom connectors do: its client metadata document (`https://claude.ai/oauth/mcp-oauth-client-metadata`) and its "Register automatically" request both list `urn:ietf:params:oauth:grant-type:jwt-bearer`, used for Enterprise Managed Auth. The bridge therefore takes the **intersection** with what it supports ([ADR 0017](adr/0017-unsupported-client-grant-types-ignored.md)):

- **CIMD.** A document is accepted if its `grant_types` include `authorization_code` and its `response_types`, if present, include `code`. Anything else listed is ignored. The stored registration has only the supported values.
- **DCR.** The client is registered with the requested grants that the bridge supports (both, if it asks for none), and the registration response returns those adjusted values (RFC 7591 §3.2.1). The request is refused with `invalid_client_metadata` only if `authorization_code` is not among them.
- **Token endpoint.** Unchanged: any `grant_type` other than `authorization_code` or `refresh_token` gets `unsupported_grant_type`, whatever the client listed.
- Ignored values are logged at info level as `client.grant_types_ignored` (`client_id`, `kind`, `ignored_grant_types`, the registered `grant_types`, and `ignored_response_types` if any).

Every other check is as strict as before: the document's `client_id` must equal its URL exactly, redirect URIs must be on the allowlist, the fetch goes through the SSRF guard, and CIMD clients must use `token_endpoint_auth_method: "none"`.

When a client is refused, one log line says why. `client.metadata_rejected` (CIMD) and `client.registration_rejected` (DCR) carry the `client_id` (CIMD) or `client_name` (DCR), the `reason`, the `field` at fault and its offending `value` (JSON, cut to 300 characters). For example:

```json
{
  "level": 40,
  "component": "auth",
  "event": "client.metadata_rejected",
  "client_id": "https://claude.ai/oauth/mcp-oauth-client-metadata",
  "reason": "client metadata document must allow the authorization_code grant",
  "field": "grant_types",
  "value": "[\"refresh_token\",\"urn:ietf:params:oauth:grant-type:jwt-bearer\"]"
}
```

`field` can also be `(document)` (not a JSON object), `(fetch)` (the document could not be fetched; `value` is the fetcher's reason, such as `timeout` or `blocked_address`), or `client_id` (a malformed `client_id` URL, or a document whose `client_id` differs). A `client_secret` in a document is refused with `field: "client_secret"` and no value; DCR never logs a value from a field whose name contains `secret`, or from `contacts`. `authorize.rejected` repeats `field`, `value` and the message as `detail`.

## Settings

All optional; defaults in brackets. Names are also in `.env.example`.

| Variable                                                                                             | Meaning                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                                                                                        | Whose `X-Forwarded-For` to believe, so the login rate limit and the logs see the real client IP. `loopback` (Caddy on the same host), `none`, or a list of addresses and CIDR ranges. Trusting everyone is refused. [`loopback`] |
| `AUTH_REFRESH_GRACE_SECONDS`                                                                         | Within this many seconds, presenting a just-rotated refresh token again returns the same successor instead of revoking the grant; 0 disables. [10]                                                                               |
| `OAUTH_EXTRA_REDIRECT_URIS`                                                                          | Extra exact redirect URIs. [none]                                                                                                                                                                                                |
| `AUTH_MCP_ALLOWED_ORIGINS`                                                                           | Browser origins allowed at `/mcp`, besides the bridge itself and loopback. [`https://claude.ai,https://claude.com,https://chatgpt.com`]                                                                                          |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_FAMILY_MAX_SECONDS` | Token lifetimes. [1 hour, 30 days, 90 days]                                                                                                                                                                                      |

Client registrations (DCR and CIMD) never expire and are never cleaned up automatically: ChatGPT registers once per connection and reuses that client. Only an explicit delete removes one.

## Sign-in limits and request logging (chunk 8)

- **Sign-in limit.** At most 5 attempts per client address and 30 in all per 15 minutes. Each attempt is counted
  **before** the password is checked and given back if it succeeds, so a burst of concurrent attempts cannot exceed the
  limit (before chunk 8 every attempt in a burst passed the check while earlier ones were still being verified).
- **Request log.** One line per request at info (`request completed`: method, path without the query string, status,
  time, client address). Requests for paths the bridge does not serve (internet scanners probing `/info.php`,
  `/actuator/env`, WordPress paths) get a plain JSON 404 and are logged at debug only, so they never bury the `auth …`
  events, which keep their levels (`login.failed`, `mcp.rejected` and so on are warnings).

## Setting up the owner

```bash
npm run build
npm run setup:owner
```

It asks for the password twice (hidden), offers TOTP enrolment (scan the `otpauth://` link, then type a code to confirm), and prints lines such as `OWNER_PASSWORD_HASH='$argon2id$…'`. Paste them, single quotes included, into `/etc/lk-bridge/lk-bridge.env` and restart. Nothing is saved anywhere else. `SESSION_SECRET` and `JWT_SIGNING_KEY` are two different outputs of `openssl rand -base64 48`.

## Personal access tokens

The dashboard's **Clients & Access** page creates, lists and revokes them (shown once). The command line does the same:

```bash
DB_PATH=/var/lib/lk-bridge/bridge.db npm run pat -- create --name "Claude Code on my laptop" --profile claude-code --expires-days 365
DB_PATH=/var/lib/lk-bridge/bridge.db npm run pat -- list
DB_PATH=/var/lib/lk-bridge/bridge.db npm run pat -- revoke pat_XXXXXXXXXXXX
```

The token is printed once; only its SHA-256 is stored. Every PAT acts under a policy profile (default `claude-code`,
created at the default scope `read` if absent; `--scope read|propose|write` sets it). `list` shows each token's
profile and scope. See [policy.md](policy.md).

## Consent and profiles (chunk 2b)

After sign-in the consent page also asks which **profile** the connection acts under (an existing one, or a new one
with a label and kind) and that profile's **scope** (`read` preselected). The suggestion comes from the redirect host:
claude.ai and claude.com → `claude`, chatgpt.com → `chatgpt`, loopback → `claude-code`. The client's self-reported name
is shown HTML-escaped with an _untrusted name_ badge. The grant, and every refresh and access token issued from it,
acts under the chosen profile; the scope is evaluated live on every call ([ADR 0012](adr/0012-live-policy-evaluation.md)).
Grants and PATs from before chunk 2b are on a `legacy` profile at `read`.

## For chunk 3: adding tools

Tools plug in without touching `src/auth` or `src/mcp/transport.ts`. Implement `McpToolProvider` (`src/mcp/server.ts`): `name`, `title`, `description` (state the rate cost and risk), a `zod` object `inputSchema`, `annotations`, and a `handler(input, ctx)` returning `{ content: [{ type: 'text', text } | { type: 'image', data, mimeType }], isError? }`. `ctx.caller` says which OAuth client or PAT is calling; `ctx.principal` is who the call acts for (from the token; pass it as `origin.principal`, or use `mcpOrigin(ctx, tool)` from `src/policy`), `ctx.scope` its live scope; `ctx.signal` aborts on cancellation. Set `access: 'read' | 'write'` on every tool: `tools/list` hides `write` tools from `read`-scoped connections (see [policy.md](policy.md)). Pass the list to `buildServer({ tools })` in `src/server.ts`, replacing the `bridge_info` stub. `registerTools(server, { tools, log })` accepts any `McpServerLike` (`Pick<McpServer, 'registerTool'>`).

`annotations` takes `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` (booleans), and `title` is also sent as `annotations.title` for older clients. They appear in `tools/list` exactly as given; a tool marked both read-only and destructive is refused at start-up. Claude and ChatGPT use them to decide what to ask the user about, so (PLAN amendment 2) mark every read tool `readOnlyHint: true, destructiveHint: false`, and every write tool `readOnlyHint: false` with an honest `destructiveHint`. The stub `bridge_info` is `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.

ChatGPT's per-tool `securitySchemes` and `_meta["mcp/www_authenticate"]` are not used: they exist for servers that mix public and authenticated tools, and every bridge request is authenticated before any tool runs.

## ChatGPT (Developer Mode)

ChatGPT connects with OAuth only; it cannot send an API key or custom headers, so personal access tokens are not an option for it.

1. **Turn on Developer Mode.** In ChatGPT on the web: _Settings → Apps & Connectors → Advanced settings → Developer mode_ (exact labels vary between ChatGPT releases, and the plan must offer Developer Mode).
2. **Create the connector.** _Settings → Apps & Connectors → Create_ (or _Add custom connector_): name `LK-Bridge`, MCP server URL `https://<host>/mcp`, authentication **OAuth**. ChatGPT discovers the bridge from the 401, registers itself (DCR) or presents its client metadata document (CIMD), and opens the bridge's sign-in and consent page.
3. **Record the redirect URI.** If ChatGPT shows a callback or redirect URL (often under advanced OAuth settings), note it exactly. The bridge's log shows what was really used: `client.registered` lists `redirect_uris`; for CIMD, `client.metadata_fetched` gives the `client_id` URL. If the URL is not one of the two ChatGPT forms above, registration fails with `invalid_redirect_uri`, and `client.registration_rejected` logs the URI: add it to `OAUTH_EXTRA_REDIRECT_URIS` and restart.
4. **Consent.** The page shows **chatgpt.com** as the destination and the scopes `mcp` and `offline_access`. Approve.
5. **Read check.** In a new chat with the connector enabled, ask ChatGPT to call `bridge_info`. It should run without a confirmation prompt (it is annotated read-only; ChatGPT may still ask the first time) and return the version and `caller.kind: "oauth"`.
6. **Write-confirmation check** (once chunk 3's write tools exist). Ask for a harmless write against the sandbox project, such as creating and then deleting a test resource. ChatGPT must ask for confirmation before each write tool call (they are `readOnlyHint: false`), while read tools stay unprompted. If writes run without confirmation, check the tool annotations in `tools/list`. Until chunk 3 lands, record this step as not yet applicable.

## Requirement traceability

Every requirement has automated tests in `test/auth/` (run with `npm test`).

| #   | Requirement                                                                                 | Tests                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 401 with the exact `WWW-Authenticate` on unauthenticated `/mcp`                             | `discovery.test.ts` › requirement 1 (POST/GET/DELETE, bad and query-string tokens, case-insensitive scheme); config normalisation case                                                            |
| 2   | Protected-resource metadata at both paths; `resource`, first AS, scopes                     | `discovery.test.ts` › requirement 2                                                                                                                                                               |
| 3   | AS metadata at both paths with every field                                                  | `discovery.test.ts` › requirement 3                                                                                                                                                               |
| 4   | DCR and CIMD (exact `client_id`, redirect validation, caching, SSRF)                        | `registration.test.ts`; `cimd.test.ts` (real HTTPS document server, cache headers, refusals, SSRF, timeout, size cap, TLS); `unit.test.ts` › CIMD rules and SSRF policy; `mcp.test.ts` › SDK CIMD |
| I   | Unsupported client grant types ignored (CIMD and DCR); refusals logged with field and value | `cimd.test.ts` › claude.ai's published client_id, and the refused-field log line; `registration.test.ts` › supported grants only, and refused registrations; `unit.test.ts` › CIMD rules          |
| 5   | PKCE S256 mandatory                                                                         | `flow.test.ts` › requirement 5 (missing, plain, missing method, malformed, wrong or missing verifier)                                                                                             |
| 6   | `resource` honoured; canonical `aud`, validated canonically                                 | `flow.test.ts` › requirement 6; `unit.test.ts` › canonical resource URI                                                                                                                           |
| 7   | Form-encoded token endpoint, JSON `/register`, answers well under 10 s                      | `flow.test.ts` › requirement 7 and timing assertions; `registration.test.ts` › takes JSON only; `discovery.test.ts` › timing; `cimd.test.ts` › slow document server                               |
| 8   | Rotation, `invalid_grant` on reuse or invalid refresh, 401 `invalid_client`                 | `flow.test.ts` › the claude.ai-equivalent flow and requirement 8                                                                                                                                  |
| 9   | Redirect allowlist, loopback any port, consent shows host, loopback warning                 | `flow.test.ts` › requirement 9; `unit.test.ts` › redirect URI policy; `owner.test.ts` › consent screen                                                                                            |
| 10  | `/mcp` never answers 3xx                                                                    | `discovery.test.ts` › requirement 10                                                                                                                                                              |
| 11  | Owner login: Argon2id, setup script, TOTP, cookie, CSRF, rate limit, consent                | `owner.test.ts`; `unit.test.ts` › TOTP vectors, Argon2id                                                                                                                                          |
| 12  | PATs: create, revoke, shown once, hashed, accepted at `/mcp`                                | `pat.test.ts`                                                                                                                                                                                     |
| 13  | Streamable HTTP with the official SDK                                                       | `mcp.test.ts` (official client, both OAuth variants); Inspector check below                                                                                                                       |
| 14  | Tool seam                                                                                   | `mcp.test.ts` › the tool seam                                                                                                                                                                     |
| 15  | Secrets from env, validated by zod with clear errors; none committed                        | `unit.test.ts` › auth configuration; tests generate every secret at run time                                                                                                                      |
| 16  | Auth events logged without tokens, codes or passwords                                       | `flow.test.ts` › requirement 16 (scans every log line for every secret the run produced)                                                                                                          |
| A   | ChatGPT redirect URIs; `OAUTH_EXTRA_REDIRECT_URIS` validated at start-up; host on consent   | `chatgpt.test.ts`; `unit.test.ts` › redirect URI policy and auth configuration                                                                                                                    |
| B   | RFC 9207: advertised, and `iss` on every authorization response, equal to `issuer`          | `chatgpt.test.ts` › RFC 9207 (success, denial, seven error kinds, `consent_required`)                                                                                                             |
| C   | `openid` and `email` neither advertised nor fatal when requested (authorize and refresh)    | `chatgpt.test.ts` › discovery and DCR flows; `unit.test.ts` › scopes                                                                                                                              |
| D   | DCR clients never expire or get pruned                                                      | `registration.test.ts` › keeps DCR registrations indefinitely (five simulated years); `chatgpt.test.ts` › reuse after 400 days                                                                    |
| E   | Tool `title` and annotations reach `tools/list`; `bridge_info` read-only                    | `mcp.test.ts` › the tool seam                                                                                                                                                                     |
| F   | ChatGPT-style flows: DCR and CIMD, `resource` on both requests, PKCE S256, `none`           | `chatgpt.test.ts`                                                                                                                                                                                 |
| G   | Refresh grace window; reuse outside it revokes the grant                                    | `grace.test.ts`; `flow.test.ts` › the claude.ai-equivalent flow                                                                                                                                   |
| H   | `TRUST_PROXY`; the login limit keys on the real client IP                                   | `owner.test.ts` › TRUST_PROXY; `unit.test.ts` › auth configuration                                                                                                                                |

## MCP Inspector check (manual)

Run against a local build with throwaway values (`BRIDGE_PUBLIC_URL=http://127.0.0.1:8799`, dummy `LK_*`, fresh secrets, a hash from `setup:owner`), then:

```bash
npx @modelcontextprotocol/inspector@2.14.0 --cli http://127.0.0.1:8799/mcp --transport http \
  --header "Authorization: Bearer <PAT>" --method tools/list
```

Add `--protocol-era modern` to exercise the 2026-07-28 protocol. For the Inspector's own OAuth flow, give it a callback the bridge accepts, and complete sign-in and consent in a browser when it prints the URL (the Inspector needs a terminal for this):

```bash
npx @modelcontextprotocol/inspector@2.14.0 --cli http://127.0.0.1:8799/mcp --transport http \
  --callback-url http://127.0.0.1:6276/callback --method tools/list
```

Result on 7 November 2026 (chunk 4): PAT `tools/list` and `tools/call bridge_info` succeeded in both protocol eras; the interactive OAuth flow (DCR, PKCE S256, `resource`, `mcp offline_access`, consent, loopback callback, token exchange) completed and listed the tools.
