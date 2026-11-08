# ADR 0017: Grant types the bridge does not issue are ignored, not refused

Status: Accepted (hotfix, 8 November 2026). Supersedes the grant-type and response-type checks for Client ID Metadata Documents and Dynamic Client Registration that ADR 0007 put in place with chunk 4. Recorded in PLAN amendment 5.

## Context

Chunk 4 refused any client, CIMD or DCR, that listed a grant type other than `authorization_code` and `refresh_token`. claude.ai's custom connector then failed on the live server through both of its options:

- **"Use Claude's published identity"** presents `https://claude.ai/oauth/mcp-oauth-client-metadata`, which lists `authorization_code`, `refresh_token` and `urn:ietf:params:oauth:grant-type:jwt-bearer` (RFC 7523, used for Claude's Enterprise Managed Auth). The consent page said: "The application could not be verified: client metadata document requests an unsupported grant type."
- **"Register automatically"** asks for the same three grants in its RFC 7591 request, and was refused with `invalid_client_metadata`.

Claude Code's document lists only the two supported grants, so it was not affected.

Listing a grant type is a statement of what a client is able to use, not a demand that a server issue it. RFC 7591 §3.2.1 lets the server register values different from those requested, provided the response says what was registered. The same reasoning applies to a metadata document: refusing it gains nothing, because the token endpoint already refuses any grant the bridge does not implement.

## Decision

1. **CIMD.** A document is accepted if its `grant_types` include `authorization_code` and its `response_types`, when present, include `code`. Other values are ignored. The stored registration holds the intersection with what the bridge supports (`authorization_code`, `refresh_token`; `code`).
2. **DCR.** The client is registered with the intersection of the requested and supported grant types (both, if none are requested), and the registration response returns those values. The request is refused only if `authorization_code` is not in the intersection. `response_types` stays strict (`["code"]`), as before.
3. **Token endpoint.** Unchanged. Only `authorization_code` and `refresh_token` are accepted; everything else, the JWT bearer grant included, gets `unsupported_grant_type`. A client can never use a grant it was not registered for.
4. **Logging.** Ignored values are logged at info level (`client.grant_types_ignored`). Every refusal of a client document or registration logs the `field` and the offending `value` (JSON, at most 300 characters) with the `client_id` (or `client_name` for DCR) on one line. Secret values are never logged.
5. **Everything else is as strict as before:** exact `client_id` match, the redirect-URI allowlist, the SSRF-guarded fetch, `token_endpoint_auth_method: "none"` for CIMD, and the DCR authentication methods.

## Consequences

- claude.ai connects through either option. If Anthropic adds another grant type to its document, nothing breaks, and the log says it was ignored.
- The bridge still never issues a grant beyond the two it implements; the ignored values cannot widen what a client can do.
- A client that relies on an ignored grant finds out at the token endpoint (`unsupported_grant_type`), or from the registration response for DCR.
- Supporting the JWT bearer grant (Enterprise Managed Auth) would be a separate decision, with its own ADR.
