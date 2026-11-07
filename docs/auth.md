# Authentication and the MCP endpoint (chunk 4)

LK-Bridge is its own OAuth 2.1 authorization server and the protected resource at `/mcp`. Design choices are in [ADR 0006](adr/0006-mcp-sdk-v2-confirmed-for-transport.md) and [ADR 0007](adr/0007-oauth-authorization-server-design.md). What to check on the live server is in [auth-live-checklist.md](auth-live-checklist.md).

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

## Setting up the owner

```bash
npm run build
npm run setup:owner
```

It asks for the password twice (hidden), offers TOTP enrolment (scan the `otpauth://` link, then type a code to confirm), and prints lines such as `OWNER_PASSWORD_HASH='$argon2id$…'`. Paste them, single quotes included, into `/etc/lk-bridge/lk-bridge.env` and restart. Nothing is saved anywhere else. `SESSION_SECRET` and `JWT_SIGNING_KEY` are two different outputs of `openssl rand -base64 48`.

## Personal access tokens

Until the dashboard (chunk 5) has a page for them:

```bash
DB_PATH=/var/lib/lk-bridge/bridge.db npm run pat -- create --name "Claude Code on my laptop" --expires-days 365
DB_PATH=/var/lib/lk-bridge/bridge.db npm run pat -- list
DB_PATH=/var/lib/lk-bridge/bridge.db npm run pat -- revoke pat_XXXXXXXXXXXX
```

The token is printed once; only its SHA-256 is stored.

## For chunk 3: adding tools

Tools plug in without touching `src/auth` or `src/mcp/transport.ts`. Implement `McpToolProvider` (`src/mcp/server.ts`): `name`, `description` (state the rate cost and risk), a `zod` object `inputSchema`, and a `handler(input, ctx)` returning `{ content: [{ type: 'text', text } | { type: 'image', data, mimeType }], isError? }`. `ctx.caller` says which OAuth client or PAT is calling; `ctx.signal` aborts on cancellation. Pass the list to `buildServer({ tools })` in `src/server.ts`, replacing the `bridge_info` stub. `registerTools(server, { tools, log })` accepts any `McpServerLike` (`Pick<McpServer, 'registerTool'>`).

## Requirement traceability

Every requirement has automated tests in `test/auth/` (run with `npm test`).

| #   | Requirement                                                                  | Tests                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 401 with the exact `WWW-Authenticate` on unauthenticated `/mcp`              | `discovery.test.ts` › requirement 1 (POST/GET/DELETE, bad and query-string tokens, case-insensitive scheme); config normalisation case                                                            |
| 2   | Protected-resource metadata at both paths; `resource`, first AS, scopes      | `discovery.test.ts` › requirement 2                                                                                                                                                               |
| 3   | AS metadata at both paths with every field                                   | `discovery.test.ts` › requirement 3                                                                                                                                                               |
| 4   | DCR and CIMD (exact `client_id`, redirect validation, caching, SSRF)         | `registration.test.ts`; `cimd.test.ts` (real HTTPS document server, cache headers, refusals, SSRF, timeout, size cap, TLS); `unit.test.ts` › CIMD rules and SSRF policy; `mcp.test.ts` › SDK CIMD |
| 5   | PKCE S256 mandatory                                                          | `flow.test.ts` › requirement 5 (missing, plain, missing method, malformed, wrong or missing verifier)                                                                                             |
| 6   | `resource` honoured; canonical `aud`, validated canonically                  | `flow.test.ts` › requirement 6; `unit.test.ts` › canonical resource URI                                                                                                                           |
| 7   | Form-encoded token endpoint, JSON `/register`, answers well under 10 s       | `flow.test.ts` › requirement 7 and timing assertions; `registration.test.ts` › takes JSON only; `discovery.test.ts` › timing; `cimd.test.ts` › slow document server                               |
| 8   | Rotation, `invalid_grant` on reuse or invalid refresh, 401 `invalid_client`  | `flow.test.ts` › the claude.ai-equivalent flow and requirement 8                                                                                                                                  |
| 9   | Redirect allowlist, loopback any port, consent shows host, loopback warning  | `flow.test.ts` › requirement 9; `unit.test.ts` › redirect URI policy; `owner.test.ts` › consent screen                                                                                            |
| 10  | `/mcp` never answers 3xx                                                     | `discovery.test.ts` › requirement 10                                                                                                                                                              |
| 11  | Owner login: Argon2id, setup script, TOTP, cookie, CSRF, rate limit, consent | `owner.test.ts`; `unit.test.ts` › TOTP vectors, Argon2id                                                                                                                                          |
| 12  | PATs: create, revoke, shown once, hashed, accepted at `/mcp`                 | `pat.test.ts`                                                                                                                                                                                     |
| 13  | Streamable HTTP with the official SDK                                        | `mcp.test.ts` (official client, both OAuth variants); Inspector check below                                                                                                                       |
| 14  | Tool seam                                                                    | `mcp.test.ts` › the tool seam                                                                                                                                                                     |
| 15  | Secrets from env, validated by zod with clear errors; none committed         | `unit.test.ts` › auth configuration; tests generate every secret at run time                                                                                                                      |
| 16  | Auth events logged without tokens, codes or passwords                        | `flow.test.ts` › requirement 16 (scans every log line for every secret the run produced)                                                                                                          |

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
