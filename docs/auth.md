# Authentication and the MCP endpoint (chunk 4)

LK-Bridge is its own OAuth 2.1 authorization server and the protected resource at `/mcp`. Supported clients: Claude (web, desktop, mobile), Claude Code (OAuth or a personal access token), and ChatGPT through a Developer Mode connector (OAuth only). Design choices are in ADRs [0006](adr/0006-mcp-sdk-v2-confirmed-for-transport.md), [0007](adr/0007-oauth-authorization-server-design.md), [0008](adr/0008-chatgpt-as-a-client.md) (ChatGPT), [0009](adr/0009-refresh-token-grace-window.md) (refresh grace window), [0017](adr/0017-unsupported-client-grant-types-ignored.md) (grant types clients may list but the bridge does not issue) and [0021](adr/0021-private-key-jwt-client-authentication.md) (`private_key_jwt`, which ChatGPT uses). What to check on the live server is in [auth-live-checklist.md](auth-live-checklist.md).

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
| `POST /oauth/revoke`                                                              | RFC 7009 revocation (same client authentication)     |
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

Every other check is as strict as before: the document's `client_id` must equal its URL exactly, redirect URIs must be on the allowlist, and the fetch goes through the SSRF guard. CIMD clients use `token_endpoint_auth_method: "none"` (Claude, Claude Code) or `"private_key_jwt"` (ChatGPT; see [Client authentication](#client-authentication-none-and-private_key_jwt) below); any other method is refused.

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

## Client authentication: `none` and `private_key_jwt`

The token endpoint (both grants) and the revocation endpoint authenticate the client with the one method its registration names ([ADR 0021](adr/0021-private-key-jwt-client-authentication.md)). There is no switching: a `none` client that sends an assertion is refused, and so is a `private_key_jwt` client that sends none.

| Method                | Who                                   | What the client sends                                                                                                          |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `none`                | Claude, Claude Code, most DCR clients | `client_id` only (PKCE protects the code)                                                                                      |
| `private_key_jwt`     | ChatGPT (CIMD only)                   | `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion`, a JWT signed by its key |
| `client_secret_basic` | DCR clients that asked for a secret   | HTTP Basic                                                                                                                     |
| `client_secret_post`  | DCR clients that asked for a secret   | `client_secret` in the form                                                                                                    |

The metadata advertises `none` first (Claude chooses its metadata document only when `none` is offered), then `private_key_jwt`, and `token_endpoint_auth_signing_alg_values_supported`: RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384 and ES512. Never `none` or HS*.

**The document.** A `private_key_jwt` document must give exactly one of `jwks_uri` (https) or an inline `jwks` (public RSA or EC keys). If it names `token_endpoint_auth_signing_alg`, only that algorithm is accepted (ChatGPT's says RS256). A `token_endpoint_auth_methods_supported` list in a client document is not a client metadata field and is ignored: ChatGPT's lists `none`, but its `token_endpoint_auth_method` is `private_key_jwt`, and that is what is enforced. DCR still refuses `private_key_jwt`.

**The assertion** must be signed with a key from the client's key set (chosen by `kid`), with `iss` and `sub` equal to the `client_id` URL, `aud` containing the issuer or the token endpoint (`https://<host>/oauth/token`), an `exp` no more than 5 minutes ahead (60 seconds of clock skew allowed on `exp`, `nbf` and `iat`), and a `jti` used only once. Used `jti`s are kept in the database (table `auth_client_assertion_jtis`, migration 0101) until they expire, so a restart does not let an assertion be replayed. Failures are `401 invalid_client`.

**The key set** is fetched from `jwks_uri` when an assertion first arrives, through the same SSRF guard as the document (https, port 443 unless allowlisted in `OUTBOUND_EXTRA_PORTS_ALLOWLIST`, public addresses only, no redirects, 4-second deadline, 64 KiB cap), with `User-Agent: LK-Bridge/<version> (OAuth client key fetcher)`. It is cached per `Cache-Control`/`Expires` (5 minutes if neither is sent), for at most an hour and at least 30 seconds (so a `no-store` key set cannot make every token request a fetch). An assertion with an unknown `kid` refetches it once, at most once a minute. A response that is not JSON (for example a bot-challenge HTML page) is a failure, logged with the status or content type received; for 5 seconds after a failure the bridge does not fetch again.

**The log.** Every refusal is one warning line, `client.assertion_rejected`, with the `client_id`, `endpoint` (`token` or `revocation`), `auth_method`, a `reason` and a `detail` sentence, and never the assertion. For example, a ChatGPT request with no assertion:

```json
{
  "level": 40,
  "component": "auth",
  "event": "client.assertion_rejected",
  "client_id": "https://chatgpt.com/oauth/client.json",
  "endpoint": "token",
  "auth_method": "private_key_jwt",
  "reason": "no_assertion",
  "detail": "this client is registered for private_key_jwt (its metadata document says so) and must send client_assertion; it sent client_id only",
  "sent": "client_id only"
}
```

| `reason`                                     | Meaning                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no_assertion`                               | A `private_key_jwt` client sent no `client_assertion`; `sent` says what it sent instead                                                                |
| `wrong_assertion_type`, `secret_not_allowed` | Wrong `client_assertion_type`; a secret sent alongside the assertion                                                                                   |
| `assertion_not_allowed`                      | A `none` (or secret) client sent an assertion                                                                                                          |
| `malformed_assertion`                        | Not a compact signed JWT, or claims that are not JSON                                                                                                  |
| `alg_not_allowed`, `wrong_alg`               | `none`, HS* or another unsupported `alg`; or not the document's declared algorithm (`declared_alg`)                                                    |
| `unknown_kid`, `no_matching_key`             | The `kid` is not in the key set (`refetched`: `yes`, `rate_limited` or `no`; `known_kids`); no key fits                                                |
| `bad_signature`                              | The signature does not verify                                                                                                                          |
| `wrong_iss`, `wrong_sub`, `wrong_aud`        | The claim (logged) is not the `client_id`, or `aud` names neither the issuer nor the token endpoint                                                    |
| `no_exp`, `expired`, `exp_too_far`           | `exp` missing, past (beyond 60 s of skew), or more than 5 minutes ahead (`exp` and `now` logged)                                                       |
| `not_yet_valid`, `iat_in_future`             | `nbf` or `iat` more than 60 seconds in the future                                                                                                      |
| `no_jti`, `replayed_jti`                     | No `jti`, or one already used                                                                                                                          |
| `jwks_fetch_failed`, `jwks_invalid`          | The key set could not be fetched (`fetch_reason`: `bad_status`, `bad_content_type`, `invalid_json`, `timeout`, `blocked_port`, …) or has no usable key |
| `no_keys_configured`                         | The stored registration has no usable `jwks_uri` or `jwks`                                                                                             |

Successes log `client.jwks_fetched` (the key count, `kid`s and cache lifetime) and `client.assertion_accepted` (`alg`, `kid`, key source). `token.rejected` still follows every refused token request, with `error: "invalid_client"`.

## Settings

All optional; defaults in brackets. Names are also in `.env.example`.

| Variable                                                                                             | Meaning                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                                                                                        | Whose `X-Forwarded-For` to believe, so the login rate limit and the logs see the real client IP. `loopback` (Caddy on the same host), `none`, or a list of addresses and CIDR ranges. Trusting everyone is refused. [`loopback`] |
| `AUTH_REFRESH_GRACE_SECONDS`                                                                         | Within this many seconds, presenting a just-rotated refresh token again returns the same successor instead of revoking the grant; 0 disables. [10]                                                                               |
| `OUTBOUND_EXTRA_PORTS_ALLOWLIST`                                                                     | Exact `host:port` pairs (comma-separated) the CIMD document and key-set fetches, and the image upload's fetches, may use besides port 443 (v1.0.1). [none: 443 only]                                                             |
| `OAUTH_EXTRA_REDIRECT_URIS`                                                                          | Extra exact redirect URIs. [none]                                                                                                                                                                                                |
| `AUTH_MCP_ALLOWED_ORIGINS`                                                                           | Browser origins allowed at `/mcp`, besides the bridge itself and loopback. [`https://claude.ai,https://claude.com,https://chatgpt.com`]                                                                                          |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_FAMILY_MAX_SECONDS` | Token lifetimes. [1 hour, 30 days, 90 days]                                                                                                                                                                                      |
| `AUTH_SESSION_TTL_SECONDS`                                                                           | The dashboard session's lifetime from its last use (ADR 0062: sliding; 5 minutes to 30 days). [30 days]                                                                                                                          |

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

OPS2: this sets only the **first** password. At the first start with `SECRETS_MASTER_KEY`, `OWNER_PASSWORD_HASH` (and
`OWNER_TOTP_SECRET`, if set) are imported into the encrypted secret store, once; after that the password and the
authenticator are managed on the dashboard (below), the store's values win over the env file's, and env-sync's
`--retire-imported-keys` can comment the env lines out. `OWNER_PASSWORD_HASH` is optional in the env file from then on.

## Managing the owner account from the dashboard (OPS2)

The dashboard's **Account** page ([ADR 0028](adr/0028-secrets-on-the-dashboard.md)). Code: `src/auth/credentials.ts`,
`src/auth/owner.ts`, `src/admin/routes/security.ts`, `ui/src/pages/account.tsx`. Tests: `test/secrets/owner.test.ts`,
`test/ui/account.test.tsx`.

- **Where the credentials live.** The Argon2id hash and the TOTP secret are kept in the encrypted secret store (AES-256-GCM
  under `SECRETS_MASTER_KEY`; scope `*`). Recovery codes are kept as SHA-256 hashes (`owner_recovery_codes`). Without a
  usable store and with nothing stored, the env file's values are used, as before. A stored value that cannot be read
  (a wrong or missing master key) is **not** replaced by the env file's: sign-in fails closed and the sign-in page says
  why (`login.unavailable` in the log). `npm run secrets -- reset-owner --yes` (as the service user; audited) clears the
  stored owner credentials so the env file's `OWNER_PASSWORD_HASH` applies again.
- **Re-authentication: the step-up** ([ADR 0062](adr/0062-dashboard-sessions-and-step-up.md), the owner's request after
  CR-2026-11-R3). Sensitive actions need a step-up on the session **within the last ten minutes**
  (`POST /api/admin/security/reauth`; the time is `auth_owner_sessions.reauth_at`), even when signed in: the
  **authenticator code** (or a recovery code) when the authenticator is set up, and then the password alone is refused;
  the **password** when it is not. They are: keys and secrets (a project's API key, a personal access token at any
  scope, the off-site copy's keys and Google client, the password, the authenticator and its recovery codes); every
  scope change (a profile's scope either way, its low-level tools and rails, a connection moved to another profile, the
  default scope); the settings (the bridge's, a project's, the budgets' floors and writer limit, a maintenance job's
  switch, schedule and run size, the off-site copy's, the retention of the tool-call log, the connections' clean-up, the
  audits', the canon and lifecycle settings); pack approval; and the guarded rails (approving a proposal that deletes,
  touches more than 10 pages, or deletes or moves an asset; the owner's own retag batch of more than 10 pages; a
  rehearsal's root deleted; a staged image's delete allowed; Revert). The brakes stay one click: Sign out everywhere,
  revoking a connection or a token, pausing or resuming writes, cancelling a job, switching most maintenance jobs off,
  rejecting a proposal. Otherwise the answer is `403 REAUTH_REQUIRED`, and the dashboard asks in a dialog (once for
  changes refused together), then sends the change again; a wrong code (`401 REAUTH_FAILED`) stays in the dialog. Every
  such request also passes the Origin, CSRF and `Sec-Fetch-Site` checks of every admin change. Step-up attempts count
  against the **same limits as sign-in** (5 per address and 30 in all per 15 minutes), in both directions. Log events:
  `reauth.succeeded`, `reauth.failed`, `reauth.rate_limited`; audit: `owner.reauth` (success and failure). (OPS2 asked
  for the password and the code within five minutes, and of fewer actions.)
- **Sessions** (ADR 0062). A session lasts **30 days from its last use** (`AUTH_SESSION_TTL_SECONDS`, default 2,592,000;
  an explicit lower value in the env file still wins): each use of the dashboard moves its end 30 days on, at most once
  a minute, and renews the cookie's `Max-Age`. The cookie is `__Host-lkb_session`: `HttpOnly`, `Secure`,
  **`SameSite=Strict`** (chunk 8 had `Lax`), path `/`. Sessions are kept in `auth_owner_sessions` under the token's
  SHA-256, so they survive a restart and can be revoked. A cross-site navigation carries no Strict cookie, so the three
  pages reached that way (the consent page `/oauth/authorize`, Google Drive's return `/admin/drive/callback`, a link to
  `/ui`) answer one that arrives without it with a small page of the bridge's own (no script) that opens the same
  address again from the bridge, which carries it. The Account page shows how many sessions are active and has **Sign
  out everywhere** (`POST /api/admin/security/sessions/revoke-all`, `confirm: true`; no step-up: it only takes access
  away): every owner session ends, this one included. Event `logout.everywhere`; audit `owner.sessions_revoked`.
- **Password.** `POST /api/admin/security/password` with the current password and the new one (at least 12 characters).
  Hashed with Argon2id (64 MiB, t=3, p=4), stored encrypted. Every **other** owner session is signed out; the current one
  is kept. Event `password.changed`; audit `owner.password_change` (how many sessions were signed out, never a value).
- **Authenticator app.** `POST …/totp/enrol` makes a 160-bit secret, held in memory for ten minutes for this session, and
  returns it once (`shownOnce`) with its `otpauth://` URI; the dashboard draws the QR code itself, as inline SVG, so the
  secret never goes to another service. `POST …/totp/confirm` with a code from the app enables it (the code's time step
  is used up, like a sign-in code) and returns **ten recovery codes**, once. From then on sign-in and re-authentication
  ask for a code; the code field also takes a recovery code (`ABCDE-FGHIJ-KLMNO-PQRST`, any case, spaces or hyphens),
  each usable once (`recovery_code.used`, a warning). `POST …/recovery-codes` replaces them (the old ones stop working).
  `POST …/totp/remove` removes the secret and the codes; an `OWNER_TOTP_SECRET` still in the env file is then ignored, not
  imported again. The Overview recommends the authenticator strongly while it is off.

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
with a label and kind) and that profile's **scope** ("Keep the chosen profile's current scope" preselected: an existing profile's current scope, a new
one's default `read`; an explicit different scope for an existing profile is confirmed on a second page,
[ADR 0019](adr/0019-consent-keeps-existing-scope.md), [ADR 0033](adr/0033-removing-connections-replace-on-reconnect-and-operation-discovery.md)).
The page also offers to **replace** the same application's existing connections, revoked only when the new code is
exchanged ([policy.md](policy.md#consent-and-pats)). The suggestion comes from the redirect host:
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

**How it identifies itself (v1.0.2).** ChatGPT presents its Client ID Metadata Document, `https://chatgpt.com/oauth/client.json`. It returns to `https://chatgpt.com/connector_platform_oauth_redirect` (on the default allowlist; the URI is shared by every ChatGPT connector, which is why `iss` is on every authorization response) and authenticates at the token endpoint with **`private_key_jwt`**: a JWT signed RS256 with a key from `https://chatgpt.com/oauth/jwks.json`. ChatGPT supports `none` too and picks from what the bridge advertises, but its document names `private_key_jwt`, and that is the method the bridge enforces. Before v1.0.2 the bridge refused the document ("client metadata document must use token_endpoint_auth_method "none""). See [Client authentication](#client-authentication-none-and-private_key_jwt) for the checks and the log lines.

1. **Turn on Developer Mode.** In ChatGPT on the web: _Settings → Apps & Connectors → Advanced settings → Developer mode_ (exact labels vary between ChatGPT releases, and the plan must offer Developer Mode).
2. **Create the connector.** _Settings → Apps & Connectors → Create_ (or _Add custom connector_): name `LK-Bridge`, MCP server URL `https://<host>/mcp`, authentication **OAuth**. ChatGPT discovers the bridge from the 401, presents its client metadata document (CIMD; `client.metadata_fetched` with `auth_method: "private_key_jwt"`), or registers itself (DCR), and opens the bridge's sign-in and consent page.
3. **Record the redirect URI.** If ChatGPT shows a callback or redirect URL (often under advanced OAuth settings), note it exactly. The bridge's log shows what was really used: `client.registered` lists `redirect_uris`; for CIMD, `client.metadata_fetched` gives the `client_id` URL. If the URL is not one of the two ChatGPT forms above, registration fails with `invalid_redirect_uri`, and `client.registration_rejected` logs the URI: add it to `OAUTH_EXTRA_REDIRECT_URIS` and restart.
4. **Consent.** The page shows **chatgpt.com** as the destination and the scopes `mcp` and `offline_access`, and suggests the `chatgpt` profile (new, at the default scope `read`, or the existing `chatgpt` profile at its current scope). Approve. ChatGPT then exchanges the code with a signed assertion: the bridge fetches its key set (`client.jwks_fetched`), accepts the assertion (`client.assertion_accepted`) and issues tokens (`token.issued`). If the exchange fails, `client.assertion_rejected` says why in one line.
5. **Read check.** In a new chat with the connector enabled, ask ChatGPT to call `bridge_info`. It should run without a confirmation prompt (it is annotated read-only; ChatGPT may still ask the first time) and return the version and `caller.kind: "oauth"`.
6. **Write-confirmation check** (once chunk 3's write tools exist). Ask for a harmless write against the sandbox project, such as creating and then deleting a test resource. ChatGPT must ask for confirmation before each write tool call (they are `readOnlyHint: false`), while read tools stay unprompted. If writes run without confirmation, check the tool annotations in `tools/list`. Until chunk 3 lands, record this step as not yet applicable.

## Requirement traceability

Every requirement has automated tests in `test/auth/` (run with `npm test`).

| #   | Requirement                                                                                                                                                                                                                                                                                        | Tests                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 401 with the exact `WWW-Authenticate` on unauthenticated `/mcp`                                                                                                                                                                                                                                    | `discovery.test.ts` › requirement 1 (POST/GET/DELETE, bad and query-string tokens, case-insensitive scheme); config normalisation case                                                            |
| 2   | Protected-resource metadata at both paths; `resource`, first AS, scopes                                                                                                                                                                                                                            | `discovery.test.ts` › requirement 2                                                                                                                                                               |
| 3   | AS metadata at both paths with every field                                                                                                                                                                                                                                                         | `discovery.test.ts` › requirement 3                                                                                                                                                               |
| 4   | DCR and CIMD (exact `client_id`, redirect validation, caching, SSRF)                                                                                                                                                                                                                               | `registration.test.ts`; `cimd.test.ts` (real HTTPS document server, cache headers, refusals, SSRF, timeout, size cap, TLS); `unit.test.ts` › CIMD rules and SSRF policy; `mcp.test.ts` › SDK CIMD |
| I   | Unsupported client grant types ignored (CIMD and DCR); refusals logged with field and value                                                                                                                                                                                                        | `cimd.test.ts` › claude.ai's published client_id, and the refused-field log line; `registration.test.ts` › supported grants only, and refused registrations; `unit.test.ts` › CIMD rules          |
| 5   | PKCE S256 mandatory                                                                                                                                                                                                                                                                                | `flow.test.ts` › requirement 5 (missing, plain, missing method, malformed, wrong or missing verifier)                                                                                             |
| 6   | `resource` honoured; canonical `aud`, validated canonically                                                                                                                                                                                                                                        | `flow.test.ts` › requirement 6; `unit.test.ts` › canonical resource URI                                                                                                                           |
| 7   | Form-encoded token endpoint, JSON `/register`, answers well under 10 s                                                                                                                                                                                                                             | `flow.test.ts` › requirement 7 and timing assertions; `registration.test.ts` › takes JSON only; `discovery.test.ts` › timing; `cimd.test.ts` › slow document server                               |
| 8   | Rotation, `invalid_grant` on reuse or invalid refresh, 401 `invalid_client`                                                                                                                                                                                                                        | `flow.test.ts` › the claude.ai-equivalent flow and requirement 8                                                                                                                                  |
| 9   | Redirect allowlist, loopback any port, consent shows host, loopback warning                                                                                                                                                                                                                        | `flow.test.ts` › requirement 9; `unit.test.ts` › redirect URI policy; `owner.test.ts` › consent screen                                                                                            |
| 10  | `/mcp` never answers 3xx                                                                                                                                                                                                                                                                           | `discovery.test.ts` › requirement 10                                                                                                                                                              |
| 11  | Owner login: Argon2id, setup script, TOTP, cookie, CSRF, rate limit, consent                                                                                                                                                                                                                       | `owner.test.ts`; `unit.test.ts` › TOTP vectors, Argon2id                                                                                                                                          |
| 12  | PATs: create, revoke, shown once, hashed, accepted at `/mcp`                                                                                                                                                                                                                                       | `pat.test.ts`                                                                                                                                                                                     |
| 13  | Streamable HTTP with the official SDK                                                                                                                                                                                                                                                              | `mcp.test.ts` (official client, both OAuth variants); Inspector check below                                                                                                                       |
| 14  | Tool seam                                                                                                                                                                                                                                                                                          | `mcp.test.ts` › the tool seam                                                                                                                                                                     |
| 15  | Secrets from env, validated by zod with clear errors; none committed                                                                                                                                                                                                                               | `unit.test.ts` › auth configuration; tests generate every secret at run time                                                                                                                      |
| 16  | Auth events logged without tokens, codes or passwords                                                                                                                                                                                                                                              | `flow.test.ts` › requirement 16 (scans every log line for every secret the run produced); OPS2: `test/secrets/no-leak.test.ts`                                                                    |
| K   | OPS2: owner credentials in the encrypted store; the step-up (the code, or the password without one; 10 minutes, ADR 0062; rate-limited with sign-in, CSRF/Origin); 30-day sliding sessions, Strict cookie, Sign out everywhere; password change signs out other sessions; TOTP with recovery codes | `test/secrets/owner.test.ts`, `test/auth/sessions-r3.test.ts`, `test/ui/sessions.test.tsx`, `test/secrets/import.test.ts`, `test/ui/account.test.tsx`                                             |
| A   | ChatGPT redirect URIs; `OAUTH_EXTRA_REDIRECT_URIS` validated at start-up; host on consent                                                                                                                                                                                                          | `chatgpt.test.ts`; `unit.test.ts` › redirect URI policy and auth configuration                                                                                                                    |
| B   | RFC 9207: advertised, and `iss` on every authorization response, equal to `issuer`                                                                                                                                                                                                                 | `chatgpt.test.ts` › RFC 9207 (success, denial, seven error kinds, `consent_required`)                                                                                                             |
| C   | `openid` and `email` neither advertised nor fatal when requested (authorize and refresh)                                                                                                                                                                                                           | `chatgpt.test.ts` › discovery and DCR flows; `unit.test.ts` › scopes                                                                                                                              |
| D   | DCR clients never expire or get pruned                                                                                                                                                                                                                                                             | `registration.test.ts` › keeps DCR registrations indefinitely (five simulated years); `chatgpt.test.ts` › reuse after 400 days                                                                    |
| E   | Tool `title` and annotations reach `tools/list`; `bridge_info` read-only                                                                                                                                                                                                                           | `mcp.test.ts` › the tool seam                                                                                                                                                                     |
| F   | ChatGPT-style flows: DCR and CIMD, `resource` on both requests, PKCE S256, `none`                                                                                                                                                                                                                  | `chatgpt.test.ts`                                                                                                                                                                                 |
| G   | Refresh grace window; reuse outside it revokes the grant                                                                                                                                                                                                                                           | `grace.test.ts`; `flow.test.ts` › the claude.ai-equivalent flow                                                                                                                                   |
| H   | `TRUST_PROXY`; the login limit keys on the real client IP                                                                                                                                                                                                                                          | `owner.test.ts` › TRUST_PROXY; `unit.test.ts` › auth configuration                                                                                                                                |
| J   | `private_key_jwt` for CIMD clients (ChatGPT): metadata, validation, assertion checks, `jti` replay across restarts, key-set fetch and rotation, no method switching, Claude unchanged                                                                                                              | `private-key-jwt.test.ts`; `unit.test.ts` › CIMD rules                                                                                                                                            |

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
