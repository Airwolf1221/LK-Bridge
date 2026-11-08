# ADR 0013: Dashboard, admin API and live stream

Status: Accepted (chunk 5, 8 November 2026). Adds to PLAN §8; one deviation is flagged below.

## Context

PLAN §8 describes the owner dashboard and its API. Chunks 2, 2b and 4 left the pieces: engine queries and controls,
owner commands, the owner session and CSRF. Chunk 5 puts a UI and a JSON API on top and had to settle how.

## Decisions

1. **One plugin, three surfaces.** `adminPlugin` serves `/api/admin` (JSON), `/api/admin/stream` (SSE) and `/ui` (static),
   all behind the owner session cookie. It is registered by `buildServer` only when given the runtime, so the auth tests
   are unchanged.
2. **Owner session only; bearer tokens are never read.** Chosen over "accept a PAT with an admin scope" because a
   token that agents can hold must not be able to change policy. The tests run every route with a valid OAuth token and a
   valid PAT and expect 401.
3. **CSRF = Origin equals the public URL, plus a session-bound token.** Reuses chunk 4's `OwnerAuth.csrfToken` with its
   own purpose (`admin`). A missing Origin is refused (stricter than chunk 4's forms): the only caller is the dashboard's
   `fetch`, which always sends it.
4. **All writes through `actions.ts`.** Routes validate and call one function each; each goes through `policy.commands`,
   an engine control or the settings functions and adds an audit row where the command does not. Chosen so "audited and
   evented" is checkable in one place and by one table-driven test.
5. **SSE, with replay.** One stream per dashboard, ids `<boot>-<n>`, a 500-event buffer, `resync` when a position cannot
   be honoured, heartbeat events (not comments) so the page can detect a dead connection, and a session re-check on each
   heartbeat. Chosen over WebSockets (no second protocol, works through Caddy as plain HTTP) and over polling (live, and
   cheap when nobody is looking).
6. **Static React bundle, strict CSP.** Vite builds to `ui/dist`; no inline script or style, nothing external. Charts and
   gauges are SVG attributes, so no `style-src` relaxation. React and the toolchain are dev dependencies (the bundle is
   built at deploy time), so the production install is unchanged and `npm audit --omit=dev` stays clean.
7. **Redaction before anything leaves.** `redactDeep` runs on every payload and every stream event.
8. **Interim budget sampler** in `src/admin/sampler.ts`, clearly marked for chunk 6 to replace.

## Deviation to flag: some settings apply at the next start

PLAN §8 page 9 lists per-operation tool exposure, member administration, journal retention and tier limit overrides as
audited settings. Those values are built into components at construction (the tool list, the policy gate, the engine's
settings, the governor's windows), and making each hot-swappable would mean changes in chunks 1–4's code. They are
stored, audited, shown as _pending restart_, and applied by `applyStoredSettings` when the runtime is next built. Read-only
mode, `WRITERS_MAX` and the reserve floors apply at once (the last needed one small additive method,
`Governor.setReserveFloors`). If live application of the other four matters, it is a separate, small change per component.

## Consequences

- The dashboard needs no new secrets or processes.
- The settings page is honest about what needs a restart; a deploy (chunk 7) applies them.
- A new admin route is covered by the auth and CSRF tests automatically (the route list comes from Fastify).
