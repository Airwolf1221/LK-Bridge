# ADR 0001: Runtime and stack

Status: Accepted (chunk 0). Implements PLAN §3.1.

## Context

LK-Bridge is a single-host, single-owner service. It needs strong typing around a large API, transactional local state and a small operational footprint.

## Decision

- Node 24 LTS, TypeScript with `strict`, ESM (`NodeNext`).
- Fastify 5 for HTTP; SQLite through `better-sqlite3` in WAL mode for state; zod 4 for validation; pino for logging; Vitest for tests.
- `package.json` declares `engines.node >= 24`, and CI and `.nvmrc` use 24.

## Consequences

- No second process or external database to run.
- `better-sqlite3` is a native module, so deploys need a toolchain or a prebuilt binary for the Node version.
- Chunk 0 was authored on a Node 22 sandbox. Nothing used so far needs 24, but CI is the source of truth.
