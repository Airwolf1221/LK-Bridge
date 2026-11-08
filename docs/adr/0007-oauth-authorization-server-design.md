# ADR 0007: OAuth authorization server design choices

Status: Accepted (chunk 4). Implements PLAN §9.4 to §9.6; records the choices the plan leaves open and the places where this chunk reads the plan in a particular way. Partly superseded: redirect URIs, `AUTH_EXTRA_REDIRECT_URIS` and DCR client pruning by [ADR 0008](0008-chatgpt-as-a-client.md); the strict no-grace-window rule by [ADR 0009](0009-refresh-token-grace-window.md); the refusal of clients that list unsupported grant types by [ADR 0017](0017-unsupported-client-grant-types-ignored.md).

## Decisions

**Endpoints.** As PLAN §3: `/oauth/authorize`, `/oauth/token`, `/oauth/register`, plus `/oauth/consent`, `/oauth/revoke` (RFC 7009), `/oauth/login`, `/oauth/logout`. The 2025-03-26 default paths `/authorize`, `/token` and `/register` are aliases, for clients that skip metadata discovery. Metadata is served at both RFC 9728 paths and at both `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`. The second carries the same RFC 8414 document: the bridge is not an OpenID provider and does not claim to be (no `jwks_uri`, no ID tokens).

**Access tokens** are HS256 JWTs (`typ: at+jwt`, RFC 9068 claims: `iss`, `sub`, `aud`, `client_id`, `scope`, `jti`, `iat`, `exp`), signed with a key derived by HKDF from `JWT_SIGNING_KEY`. Every token also has a row in `auth_access_tokens`, checked on each `/mcp` request, so tokens can be listed and revoked before they expire. Lifetime: 1 hour.

**Refresh tokens** are opaque random strings, stored as SHA-256. Each authorization creates a grant ("family"). Every refresh rotates the token; presenting a rotated token, or presenting a token with the wrong client, revokes the whole family (OAuth 2.1 §4.3.1 reuse detection). There is no grace window: two concurrent refreshes with one token revoke the grant, and the user signs in again. Refresh tokens last 30 days from their issue, the family at most 90 days.

**Refresh tokens are issued whenever the client registered the `refresh_token` grant**, whether or not it asked for `offline_access`. Claude appends `offline_access` when advertised, so in practice both agree.

**Scopes.** Two: `mcp` (use the tools) and `offline_access`. Unknown requested scopes are ignored rather than refused (RFC 6749 §3.3), and `mcp` is always granted, because a token without it is useless at the only resource. The consent page lists exactly what is granted. A refresh may narrow scope but never widen it (`invalid_scope`).

**Resource (RFC 8707).** Absent `resource` means the MCP URL. Present values are compared in canonical form; the bare origin is accepted as an alias. Tokens always carry the canonical MCP URL as `aud`.

**Clients.** DCR follows RFC 7591, including its default `token_endpoint_auth_method` of `client_secret_basic` when a client sends none; Claude registers as `none`. Confidential clients may authenticate with Basic or POST. DCR registrations that were never used are pruned after 24 hours. Registration is rate-limited per address (30 an hour).

**Client ID Metadata Documents.** The document is fetched only at the authorization endpoint, and only once the owner is signed in (a fresh cached document may be used before), so no anonymous visitor can make the bridge fetch a URL. Fetches go through `src/auth/safe-fetch.ts`: HTTPS only, no redirects followed, every resolved address must be globally routable (and the socket uses an address that was checked), a 4-second deadline and an 8 KiB cap. Freshness comes from `Cache-Control`/`Expires` (default 10 minutes, at most 24 hours). A fetch failure fails closed, with no stale fallback. `client_id` URLs with a query string are refused (the draft says SHOULD NOT; refusing keeps comparisons simple). The token endpoint uses the stored registration and never fetches. The consent page names the host of the `client_id` URL first and the self-asserted `client_name` second.

**Redirect URIs.** Exactly the four from PLAN §9.6, loopback ones matched with any port; nothing else, for any client. `AUTH_EXTRA_REDIRECT_URIS` (empty by default) exists only as a testing aid. The MCP Inspector does not need it: pass `--callback-url http://127.0.0.1:<port>/callback`.

**Owner login.** One owner; username from `OWNER_USERNAME` (default `owner`), Argon2id PHC hash from `OWNER_PASSWORD_HASH`, optional RFC 6238 TOTP from `OWNER_TOTP_SECRET` with replay protection. `npm run setup:owner` prints these lines and writes nothing. Sessions are random ids stored hashed, in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax; Lax so that arriving from claude.ai shows the consent page without signing in again). CSRF tokens are HMACs bound to the session and the pending request; form POSTs also check `Origin`. Login is limited to 5 failures per address and 30 overall per 15 minutes. Pending consents live in memory for 10 minutes; a restart just means starting again from Claude.

**`/mcp` Origin check.** A present `Origin` must be the bridge itself, `https://claude.ai`, `https://claude.com` (configurable) or loopback; otherwise `403`. Claude's servers and Claude Code send no `Origin`.

**Composition root and migrations.** Chunk 0 left neither, so chunk 4 adds `src/server.ts` (builds Fastify, registers the auth plugin and the MCP transport, takes `tools`) and `src/db/migrate.ts` (numbered `.sql` files, checksums, any-order application). Chunks reserve migration ranges: auth uses `0100`-`0199`.

## Consequences

- Rotating `JWT_SIGNING_KEY` invalidates all access tokens (clients refresh). Rotating `SESSION_SECRET` invalidates CSRF tokens only. Stored hashes do not depend on either secret, so PATs and refresh tokens survive both.
- The dashboard (chunk 5) reuses `OwnerAuth` for its login and `AuthStore`/`PatService` for page 8 instead of building its own.
