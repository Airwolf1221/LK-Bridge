# ADR 0003: All LegendKeeper traffic goes through the governor

Status: Accepted (chunk 0). Implements PLAN §3.1 and §5.

## Decision

- The LK client is `@legendkeeper/sdk` 4.1.x built with a custom `fetch` that routes through `src/lk/governor`, with `maxRetries: 0` and `idempotencyKeys: false`. The governor owns pacing, retries, header capture and idempotency keys.
- Enforced mechanically, not just by convention (`eslint.config.js`):
  - `fetch` is banned in `src/**` outside `src/lk/`, and inside `src/lk/` outside `src/lk/governor/`.
  - String literals naming the LegendKeeper host are banned in `src/**` outside `src/lk/`.
- The default base URL lives in `src/lk/constants.ts`.

## Consequences

- The signed-URL image `PUT` is not an LK API call but needs upload-tier backoff, so it also lives in the governor.
