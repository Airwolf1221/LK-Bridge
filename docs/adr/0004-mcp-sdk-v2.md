# ADR 0004: MCP SDK: v2 split packages

Status: Accepted (chunk 0). Resolves the choice left open in PLAN §3.1.

## Context

PLAN §3.1 allows the v2 split packages or `@modelcontextprotocol/sdk` 1.32.x "if v2 adapters are awkward".

## Spike

A throwaway Fastify 5 server (not committed) mounted `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node` 2.1.2 with `McpServer` from `@modelcontextprotocol/server` 2.4.0. It used `reply.hijack()` and `transport.handleRequest(req.raw, reply.raw, req.body)`, with one registered tool and a stateless transport. A real `initialize` POST returned `200` and a valid result.

## Decision

Use the v2 packages, pinned exactly: `@modelcontextprotocol/server@2.4.0` and `@modelcontextprotocol/node@2.1.2`. They are the maintained line, `@legendkeeper/sdk` already depends on `@modelcontextprotocol/core` 2.4.0, and the adapter is not awkward.

## Consequences

- Bearer verification helpers (`requireBearerAuth`, protected-resource metadata builders) exist in the server package. Chunk 4 should evaluate them but must still meet every PLAN §9.6 requirement with its own tests.
- If a v2 bug blocks chunk 4, falling back to 1.32.x needs a new ADR.
