# ADR 0021: private_key_jwt client authentication for metadata-document clients

Status: Accepted (hotfix, v1.0.2, 8 November 2026). Supersedes the rule that a Client ID Metadata Document must use `token_endpoint_auth_method: "none"` (ADR 0007, "Client ID Metadata Documents", and ADR 0017, decision 5). Recorded in PLAN amendment 7.

## Context

ChatGPT's custom connector was refused on the live server with "The application could not be verified: client metadata document must use token_endpoint_auth_method "none"". Its document, `https://chatgpt.com/oauth/client.json`, says:

```json
{
  "token_endpoint_auth_method": "private_key_jwt",
  "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
  "token_endpoint_auth_signing_alg": "RS256",
  "jwks_uri": "https://chatgpt.com/oauth/jwks.json"
}
```

(plus the usual name, URIs, `authorization_code` and `refresh_token`). ChatGPT authenticates at the token endpoint with a client assertion signed by its own key (RFC 7523 §2.2), and chooses from the intersection of its methods with what the server advertises. Its redirect URI, `https://chatgpt.com/connector_platform_oauth_redirect`, is already on the allowlist; because that URI is shared by every ChatGPT connector, RFC 9207 `iss` (ADR 0008) stays essential.

`token_endpoint_auth_methods_supported` is an authorization-server metadata name, not a client metadata field. Treating it as "this client may also use none" would let anyone present ChatGPT's `client_id` without a key, which is exactly what the assertion prevents.

Claude (claude.ai and Claude Code) uses `none` and chooses CIMD only when `none` is advertised. It must not notice this change.

## Decision

1. **Metadata.** `token_endpoint_auth_methods_supported` (and the revocation equivalent) become `none`, `private_key_jwt`, `client_secret_post`, `client_secret_basic`, with `none` first. `token_endpoint_auth_signing_alg_values_supported` (and the revocation equivalent) list asymmetric algorithms only: RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512. Never `none`, never HS*: an HMAC assertion would need a shared secret, and a public document has none.
2. **CIMD validation.** `token_endpoint_auth_method` may be `none` or `private_key_jwt`; anything else is refused with the existing `client.metadata_rejected` line (field and value). A `private_key_jwt` document must carry exactly one of `jwks_uri` (an https URL without credentials or a fragment) or an inline `jwks` (public RSA or EC keys only; a set with private members is refused; symmetric keys are ignored). If it names `token_endpoint_auth_signing_alg`, that must be one of the algorithms above, and assertions must use exactly that algorithm. `token_endpoint_auth_methods_supported` in a client document is ignored. Dynamic Client Registration is unchanged and still refuses `private_key_jwt`: an anonymous registrant could otherwise make the bridge fetch a URL of its choosing at the token endpoint.
3. **The method is fixed by the registration.** A `private_key_jwt` client must send `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion`, and no secret; it never falls back to `none`. A `none` or secret client that sends an assertion is refused. This holds at the token endpoint (both grants) and at the revocation endpoint. Every failure is `401 invalid_client` (RFC 6749 §5.2).
4. **Verification** (in this order; the `jti` is recorded only once everything else has passed):
   - the header's `alg` is a supported asymmetric algorithm, and the declared one if the document names one;
   - the key is chosen by `kid`. An unknown `kid` refetches the key set once, at most once a minute per `jwks_uri`, then fails. Without a `kid`, every key that fits the algorithm is tried (at most five);
   - the signature verifies (jose; RSA keys under 2048 bits are not used);
   - `iss` and `sub` both equal the `client_id` URL;
   - `aud` contains the issuer or the advertised token endpoint, compared canonically (lower-case host, no default port, no trailing slash). The `/token` alias and the MCP URL are not accepted;
   - `exp` is present, not more than 60 seconds in the past, and not more than 5 minutes (plus 60 seconds of skew) ahead; `nbf` and `iat`, when present, are not more than 60 seconds in the future;
   - `jti` is present (at most 256 characters) and not seen before for this client. Seen `jti`s are kept in SQLite (migration `0101_client_assertion_jti.sql`, table `auth_client_assertion_jtis`) until `exp` plus the skew allowance, then pruned, so a restart does not reopen the window.
5. **Key-set fetch.** Through the same SSRF guard as the document: https, port 443 unless `host:port` is in `OUTBOUND_EXTRA_PORTS_ALLOWLIST`, globally routable addresses only (pinned), no redirects, the document fetch's deadline (`AUTH_CIMD_TIMEOUT_MS`, 4 s), a 64 KiB cap, `User-Agent: LK-Bridge/<version> (OAuth client key fetcher)` and `Accept: application/jwk-set+json, application/json`. Freshness follows `Cache-Control`/`Expires` (5 minutes when neither is sent), never more than 1 hour, so a withdrawn key stops working within the hour, and never less than 30 seconds, so that a `no-store` answer cannot turn every unauthenticated token request into an outbound fetch (rotation is still picked up by the unknown-`kid` refetch). A failure (an HTML challenge page, a 403, HTML labelled JSON, a timeout) fails closed, with no stale fallback, and further attempts within 5 seconds fail with the same reason without fetching. The set is fetched at the token endpoint, never at the authorization endpoint, and only for a client the signed-in owner has already accepted, so an anonymous caller cannot choose what is fetched. Key sets live in memory; a restart fetches again.
6. **Logging.** `client.assertion_rejected` (warning) gives the `client_id`, the `endpoint`, the registered `auth_method`, a `reason` code and a `detail` sentence, plus what helps: `alg`, `kid`, `declared_alg`, `known_kids`, `refetched`, `iss`, `sub`, `aud`, `exp`, `now`, `jti`, `fetch_reason`, `jwks_uri`, `sent`. Reasons: `no_assertion`, `wrong_assertion_type`, `secret_not_allowed`, `assertion_not_allowed`, `malformed_assertion`, `alg_not_allowed`, `wrong_alg`, `unknown_kid`, `no_matching_key`, `bad_signature`, `wrong_iss`, `wrong_sub`, `wrong_aud`, `no_exp`, `expired`, `exp_too_far`, `not_yet_valid`, `iat_in_future`, `no_jti`, `replayed_jti`, `jwks_fetch_failed`, `jwks_invalid`, `no_keys_configured`. The assertion itself is never logged. Successes log `client.jwks_fetched` (key count, `kid`s, cache lifetime) and `client.assertion_accepted` (`alg`, `kid`, key source); `client.metadata_fetched` now carries `auth_method`, `jwks_uri` and `signing_alg`.

## Consequences

- ChatGPT connects through its metadata document. Claude and Claude Code are unaffected: `none` is still first, their documents are validated as before, and they never trigger a key fetch.
- If chatgpt.com blocks the bridge's key fetch, the token exchange fails and the log says how (`jwks_fetch_failed` with `fetch_reason` `bad_status` or `bad_content_type`, and the status or content type received).
- A key rotation that ChatGPT starts using within a minute of the bridge's last fetch can fail for up to that minute; the next request after it succeeds.
- Each successful assertion adds one small row, kept for at most about 7 minutes.
- Supporting `private_key_jwt` for DCR clients, `client_secret_jwt`, or EdDSA would each be a separate decision.
