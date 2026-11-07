# LK-Bridge

A LegendKeeper v3 API bridge for Claude: a rate governor, a resumable job engine with concurrent writers, an MCP surface behind OAuth 2.1, and a dashboard.

Start with [`docs/PLAN.md`](docs/PLAN.md) and [`CLAUDE.md`](CLAUDE.md). Decisions are recorded in [`docs/adr`](docs/adr).

## Development

Requires Node 24.

```bash
npm ci
npm run ci          # typecheck, lint, format, registry + drift checks, tests
npm run gen:registry  # regenerate the operation registry after changing the vendored spec
npm run test:sandbox  # opt-in; needs a sandbox LegendKeeper project (see test/sandbox/README.md)
npm run build && npm run setup:owner   # owner password hash (and optional TOTP) for the env file
npm start             # runs dist/server.js; needs the variables in .env.example
```

Connecting Claude, the OAuth endpoints and personal access tokens are described in [`docs/auth.md`](docs/auth.md).

Never commit secrets. Copy `.env.example` for local values; `.env` is git-ignored.
