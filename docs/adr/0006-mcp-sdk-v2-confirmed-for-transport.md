# ADR 0006: MCP SDK v2 confirmed for the transport, with our own auth gate

Status: Accepted (chunk 4). Confirms ADR 0004; does not supersede it.

## Context

Chunk 4 was asked to check npm, pick between the v2 split packages and `@modelcontextprotocol/sdk` 1.32.x, and pin the choice. On 7 November 2026 npm listed:

| Package                        | Latest | Pinned here             |
| ------------------------------ | ------ | ----------------------- |
| `@modelcontextprotocol/server` | 2.4.0  | 2.4.0 (exact)           |
| `@modelcontextprotocol/node`   | 2.1.2  | 2.1.2 (exact)           |
| `@modelcontextprotocol/client` | 2.4.0  | 2.4.0 (exact, dev only) |
| `@modelcontextprotocol/sdk`    | 1.32.2 | not used                |

PLAN §3.1 says "2.4.x" for both v2 packages. The Node adapter's newest release is 2.1.2, which declares a peer dependency on `@modelcontextprotocol/server` `^2.4.0`, so 2.1.2 is the right pairing; there is no 2.4.x adapter.

## Decision

- Keep the v2 packages at the exact versions above.
- Serve `/mcp` with `createMcpHandler(factory, { legacy: 'stateless' })`, wrapped once with `toNodeHandler` and mounted on Fastify with `reply.hijack()`. One factory builds a fresh `McpServer` per request, so the endpoint serves both the 2025-era protocol (stateless Streamable HTTP; `initialize` handshake) and the 2026-07-28 per-request protocol. Both eras were checked with the MCP Inspector CLI (`--protocol-era legacy` and `modern`).
- Leave the request body unread for `/mcp`: the SDK reads, size-limits and validates it after our authentication gate has passed.
- Do **not** use the SDK's `requireBearerAuth` / `verifyBearerToken` for the gate. Reasons:
  - `verifyBearerToken` rejects tokens without an expiry; personal access tokens may have none (requirement 12).
  - Its resource check compares strings, ignoring only a fragment and one trailing slash; requirement 6 needs the canonical comparison (lowercase scheme and host, default port removed).
  - Requirement 1 fixes the exact challenge string, and Claude's behaviour depends on 401 versus 403, so the bridge builds those responses itself (`src/auth/bearer.ts`), with tests on the exact header.
- Use `@modelcontextprotocol/client` only in tests, so the official client's OAuth code (`auth()`: discovery, DCR, CIMD, PKCE, `resource`, RFC 9207 `iss` check, refresh) is exercised against the bridge as an independent implementation.

## Consequences

- Stateless serving means `GET /mcp` answers `405`; there is no standalone server-to-client stream. Progress for long tool calls still works inside a POST response (SSE upgrade). Chunk 3 should keep to that model.
- A future SDK upgrade should re-run `test/auth/mcp.test.ts` and the Inspector check in `docs/auth.md`.
