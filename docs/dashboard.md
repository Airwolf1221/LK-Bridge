# The owner dashboard and admin API (chunk 5)

A single-page app at `/ui` and the JSON API behind it at `/api/admin`, with one live stream. They are for the owner
only. Code: `src/admin/` (API, stream, static files), `ui/` (the React app), `src/config/admin.ts` (settings). Tests:
`test/admin/`, `test/ui/`, and an opt-in browser smoke test in `test/e2e/`. Design choices are in
[ADR 0013](adr/0013-dashboard-and-admin-api.md) and [ADR 0014](adr/0014-auth-pages-referrer-policy.md).

## Running it

| What                  | How                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build (server and UI) | `npm run build` (also runs `npm run build:ui`, which writes `ui/dist`)                                                                                                                       |
| Serve                 | `npm start`; the bridge serves `ui/dist` at `/ui`. Without a build, `/ui` says so (503) and the API still works                                                                              |
| UI development        | `npm run dev` (bridge on 8787), then `npm run dev:ui` (Vite on 5173, proxying `/api/admin` and `/oauth`); sign in on 8787 first                                                              |
| Unit, component, API  | `npm test` (part of `npm run ci`)                                                                                                                                                            |
| Browser smoke test    | `npm run test:e2e` (builds the UI, starts a real bridge on a mock LegendKeeper, drives Chromium). Not in CI. If Playwright cannot find its browser, set `CHROMIUM_PATH` to a Chromium binary |

## Security model

- **Only the owner session.** The credential is the cookie set by the owner sign-in (chunk 4). OAuth access tokens and
  personal access tokens are never read on `/api/admin` (the `Authorization` header is ignored), so a token that works at
  `/mcp` does nothing here. Unauthenticated API requests get a 401 JSON body with no `WWW-Authenticate` header.
- **Unauthenticated `/ui`** requests are redirected (303) to `/oauth/login?return_to=…` and come back afterwards. No
  dashboard bytes are served first. A session that ends while the page is open sends the page to sign-in (a 401 from the
  API, or the `unauthenticated` stream event).
- **CSRF.** Every state-changing request (anything but GET, HEAD, OPTIONS) needs the `Origin` header to equal the
  bridge's public URL (a missing or foreign one is refused: browsers always send it on `fetch` POSTs) **and**
  `X-CSRF-Token`, the HMAC bound to the session (`GET /api/admin/session` returns it). Neither is checked on reads.
- **Headers on `/ui`:** `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'
data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none';
base-uri 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, plus
  `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`. The bundle has no inline script or style and loads
  nothing from another host.
- **Every change is audited and evented.** Routes validate input and call `src/admin/actions.ts`, which goes through the
  owner command layer (`policy.commands`), an engine control, or the runtime settings functions
  (`src/admin/runtime-settings.ts`). Each leaves an `audit_log` row (actor `owner`) and a `policy` event on the stream.
  No route touches the database or the engine itself.
- **No secrets shown or logged.** A new PAT is in the response to its creation only (`201`, `shownOnce: true`); only its
  hash is stored and nothing else returns it. Signed upload URLs, upload keys, headers, image bytes and credential-shaped
  fields are replaced by `[redacted]` in every job, step, artefact, error, journal, proposal and stream payload
  (`src/admin/redact.ts`); very long values are shortened. Request logging keeps the path only (no query string).

## Admin API

All under `/api/admin`, JSON in and out, errors as `{ "error": { "code", "message" } }`.

| Area      | Routes                                                                                                                                                                                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session   | `GET /session` (user, CSRF token, version)                                                                                                                                                                                                                                                                                  |
| Overview  | `GET /overview` (health, controls, job and error counts, pending proposals, headline gauges; `?refresh=true` re-checks LegendKeeper, otherwise cached for a minute)                                                                                                                                                         |
| Jobs      | `GET /jobs` (`view=active\|history`, `status`, `origin`, `principalId`, `profile`, `kind`, `before`, `limit`), `GET /jobs/:id` (steps, attempts, request ids, `uncertain`, retry advice), `GET /jobs/:id/artifacts/:artifactId`, `POST /jobs/:id/cancel\|pause\|resume`, `POST /jobs/:id/steps/:stepNo/retry` (`{ force }`) |
| Errors    | `GET /errors` (`resolved=false\|true\|all`), `GET /errors/group?fingerprint=`, `POST /errors/resolve`                                                                                                                                                                                                                       |
| Budgets   | `GET /budgets` (snapshot, 24 h history in at most 288 buckets, drift, floors), `PUT /budgets/reserve-floors`                                                                                                                                                                                                                |
| Writers   | `GET /writers` (slots, locks, waits, rate), `PUT /writers/max`, `POST /writes/pause\|resume\|drain\|undrain`                                                                                                                                                                                                                |
| Journal   | `GET /journal` (filters; metadata only), `GET /journal/:id` (with the pre-image). View only                                                                                                                                                                                                                                 |
| Proposals | `GET /proposals` (`group` or `state`, `principalId`, `profile`), `GET /proposals/counts`, `GET /proposals/:id` (diff data), `POST /proposals/:id/approve`, `POST /proposals/:id/reject`, `POST /proposals/bulk`                                                                                                             |
| Access    | `GET /clients`, `POST /clients/profiles`, `PUT /clients/profiles/:id/scope`, `PUT /clients/default-scope`, `PUT /clients/connections/:id/profile`, `POST /clients/connections/:id/revoke`, `POST /clients/pats`                                                                                                             |
| Settings  | `GET /settings`, `PUT /settings/read-only\|expose-per-op-tools\|member-admin\|journal-retention\|tier-limits`, `GET /audit`                                                                                                                                                                                                 |
| Stream    | `GET /stream` (Server-Sent Events)                                                                                                                                                                                                                                                                                          |

Confirmations are part of the contract, not only the UI: raising a scope without `confirmRaise: true` is a `409
CONFIRMATION_REQUIRED`, and every settings and reserve-floor change needs `confirm: true`. `WRITERS_MAX` outside 1–8 is a 400.

### Retrying a step

`retry` on each step says whether it may be retried and whether it is _ambiguous_ (it may already have reached
LegendKeeper). A normal retry re-checks first and cannot duplicate; `force: true` re-runs it as new work. The dashboard
shows the warning and asks twice before forcing.

## Stream

`GET /api/admin/stream` carries the engine's events (`job`, `step`, `lock`, `writers`, `error`, `controls`), the policy
layer's (`policy`, `proposal`), the governor's (`throttled`, `budget-wait`) and a `budget` snapshot every 2 seconds. Each
frame's data is `{ "at": <ms>, "data": … }`.

- **Heartbeats** are real `heartbeat` events every 15 s (`ADMIN_STREAM_HEARTBEAT_SECONDS`), so a page can tell a dead
  connection from a quiet one. Each tick also re-checks the session: a signed-out dashboard gets `unauthenticated` and the
  stream ends.
- **Reconnection.** Replayable events have ids `<boot>-<n>`; the last 500 are kept (`ADMIN_STREAM_REPLAY_EVENTS`). A
  browser that reconnects sends `Last-Event-ID`: if that position is still held, it gets `hello` with `resumed: true`
  and the missed events; otherwise `resync` (after a restart, or too long away), and the page reloads what it shows.
  `budget` and `heartbeat` carry no id and are not replayed. The page also reopens a stream that missed three heartbeats.

## Settings and when they apply

| Setting                                                                                     | Applies                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Read-only mode (follow environment, on, off)                                                | At once (the engine's own override)                                |
| `WRITERS_MAX`, pause, drain                                                                 | At once                                                            |
| Reserve floors                                                                              | At once (`governor.setReserveFloors`); also applied at every start |
| Per-operation tool exposure, member administration, journal retention, tier limit overrides | **At the next start.**                                             |

The last group is built into components when the bridge starts (the tool list, the policy gate, the governor's windows).
They are stored in `runtime_settings` (`dash.*` keys) and applied by `applyStoredSettings` when the runtime is built; the
Settings page shows _pending restart_ until they match what is running. Clearing a stored value goes back to the
environment's. A stored value that no longer validates is ignored.

## The interim budget sampler

Every 10 seconds `engine.recordBudgetSample(governor.snapshot())` stores one sample for the sparklines
(`src/admin/sampler.ts`, started in `createRuntime`, stopped on shutdown; `ADMIN_BUDGET_SAMPLE_SECONDS=0` disables it).
**Chunk 6 replaces it** with the maintenance scheduler's `budget-sampler`; delete the file and its one call in
`src/runtime.ts` then (both write the same rows, so run only one).

## Settings (environment)

| Variable                         | Default | Meaning                                                  |
| -------------------------------- | ------- | -------------------------------------------------------- |
| `ADMIN_STREAM_HEARTBEAT_SECONDS` | 15      | Heartbeat interval of the stream                         |
| `ADMIN_STREAM_REPLAY_EVENTS`     | 500     | Events kept for reconnection                             |
| `ADMIN_BUDGET_PUSH_SECONDS`      | 2       | How often a budget snapshot is pushed to open dashboards |
| `ADMIN_BUDGET_SAMPLE_SECONDS`    | 10      | Interim sampler interval (0 disables)                    |

## Behind Caddy

The stream sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`; Caddy's `reverse_proxy` streams without
buffering by default. Chunk 7's runbook should keep it that way (no `encode` of `text/event-stream`).

## Tests

- `test/admin/auth.test.ts`: every registered route rejects no credentials, an OAuth token and a PAT (both valid at
  `/mcp`), and every state-changing route rejects a missing or wrong CSRF token and a foreign or missing Origin.
  The route list is collected from Fastify, so a new route is covered automatically.
- `test/admin/actions.test.ts`: each action reaches its command or control and leaves one audit row and one event.
- `test/admin/stream.test.ts`: events arrive; replay, resync, heartbeats, sign-out, no secrets in events.
- `test/admin/ui.test.ts`, `data.test.ts`: redirect and return, headers, static files and traversal, every read route,
  redaction, sampler, PAT shown once and never logged.
- `test/ui/`: each page with mock data; live job progress from the stream; `WRITERS_MAX` live; approve, reject, bulk and
  conflicted proposals; scope-raise and settings confirmations; a PAT shown once; and `e2e.test.tsx`, the real bridge
  with the real dashboard code in jsdom while a mock job runs.
- `test/e2e/`: Chromium against the built dashboard under the real CSP (sign-in and return, live pages, proposal diff, a
  token, a phone-sized dark layout).
