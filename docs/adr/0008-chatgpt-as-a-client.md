# ADR 0008: ChatGPT as a supported client

Status: Accepted (chunk 4 follow-up, 7 November 2026). Amends PLAN (amendment 1) and supersedes the redirect-URI and client-pruning parts of ADR 0007.

## Context

ChatGPT, through a Developer Mode custom connector, is now a supported client alongside Claude. It connects with OAuth only: it cannot send API keys or custom headers, so personal access tokens do not help it. It registers through Dynamic Client Registration (or identifies itself with a Client ID Metadata Document), sends PKCE S256 and the RFC 8707 `resource` parameter on both the authorization and the token request, authenticates as a public client (`none`), and returns to a chatgpt.com callback. It registers once per connection and then reuses that client.

## Decisions

1. **Redirect URIs.** Besides the Claude and loopback URIs, the bridge accepts `https://chatgpt.com/connector_platform_oauth_redirect` exactly, and any URI matching `^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]+$`. The dots are literal: the pattern as first written (`chatgpt.com`, unescaped) would also have matched hosts such as `chatgptXcom`.
2. **`OAUTH_EXTRA_REDIRECT_URIS`** (comma-separated) adds exact URIs without a code change, so the owner can add whatever callback ChatGPT shows. It replaces chunk 4's testing-only `AUTH_EXTRA_REDIRECT_URIS`, which was never deployed. Each entry is validated at start-up: absolute, `https` (plain `http` only on loopback), no credentials, no fragment, no wildcard, and written in normalised form (because redirect URIs are compared as exact strings, a value such as `https://ChatGPT.com/cb` could never match; the error names the form to use). Loopback entries keep RFC 8252's any-port matching. Refused registrations log the full redirect URI, so the owner can copy it.
3. **RFC 9207.** The metadata advertises `authorization_response_iss_parameter_supported: true`, and every authorization response (code, `access_denied`, and every error redirect, including `login_required` and `consent_required`) carries `iss`, equal to the metadata `issuer`. Errors that cannot be redirected (unknown client, unregistered redirect URI) are error pages, as RFC 6749 requires, and so carry no `iss`.
4. **Scopes.** The bridge advertises only `mcp` and `offline_access`, never `openid` or `email`. Requested scopes the bridge does not support are ignored, at the authorization endpoint (as before) and now also on refresh, where they used to cause `invalid_scope`. A supported scope beyond the original grant is still refused on refresh.
5. **Client retention.** Client registrations, DCR and CIMD, are never expired or garbage-collected; only explicit deletion removes them. Chunk 4 had pruned DCR clients unused for 24 hours; that is removed. Registration stays rate-limited (30 an hour per address), which bounds growth. Codes, tokens, grants and sessions are still pruned when they expire.
6. **`/mcp` Origin allowlist** now includes `https://chatgpt.com` by default. ChatGPT's servers normally send no `Origin`; this only matters if a browser-side request ever appears.
7. **No per-tool auth metadata.** ChatGPT's per-tool `securitySchemes` and `_meta["mcp/www_authenticate"]` exist for servers that mix public and authenticated tools. Every bridge tool needs authentication and `/mcp` answers 401 before any tool runs, so neither is implemented.
8. **Tool annotations** (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) pass through the tool seam to `tools/list`. Both Claude and ChatGPT use them to decide what needs confirmation; chunk 3 sets them (PLAN amendment 2).

## Consequences

- Tests in `test/auth/chatgpt.test.ts` follow ChatGPT's documented behaviour; ChatGPT itself was not reachable from the build environment, and neither was its documentation site. The live check in `docs/auth-live-checklist.md` §9 records the real callback and client identity.
- The database keeps every client ever registered until the owner deletes it (dashboard, chunk 5).
