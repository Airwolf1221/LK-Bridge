# ADR 0073: v3 F8: every setting on the dashboard: the settings registry, dashboard → environment → default, bootstrap settings read-only, secrets never shown, and "Restart the bridge"

- Status: **Proposed** (v3 F8, 24 November 2026). Built and tested against the mock LegendKeeper only; nothing in this
  session touched a live system (no LegendKeeper, no bridge connector, no dashboard, no sandbox run). Where the brief
  was silent the choice is marked **chosen**.
- Design: `LK-Bridge-F8-settings-design.md`, APPROVED 23 November 2026, both open calls "yes": the precedence
  (dashboard → environment → default) and the restart button.
- The gap: about 80 settings were defined in `src/config/*.ts` (tools 28, the main schema 25, auth 18, admin,
  maintenance and policy 3 each), but the Settings page exposed six. The owner had to change an image limit by hand.
- Amends: PLAN §8 page 9 (Settings: every setting, not five); [ADR 0062](0062-dashboard-sessions-and-step-up.md)'s
  inventory (three new routes, each asks for the step-up); the runbook's systemd section (an optional drop-in line).
- No migration: dashboard values are rows of the existing `runtime_settings` table.

## Decision 1: one registry, its bounds read from the schemas

`src/config/registry.ts` has one entry per configuration key: `key`, `group`, `label`, `description` (British
English), `type`, a display `unit` (`src/config/units.ts`: bytes as MB or GB, milliseconds as seconds, seconds as
minutes or days, fractions as %, counts as they are), `default`, `min`, `max` or `enum`, `applies` (`now`,
`next_start`, `bootstrap`), `secret`, and `editedOn` (`settings`, `projects`, `server`).

`default`, `min`, `max`, `enum` and whether a number must be whole are **read from the zod schema** that parses the
variable (`describeField`), never written twice. The schemas are now exported (`MAIN_ENV_SCHEMA`, `TOOLS_ENV_SCHEMA`,
`AUTH_ENV_SCHEMA`, `ADMIN_ENV_SCHEMA`, `MAINTENANCE_ENV_SCHEMA`, `POLICY_ENV_SCHEMA`) and every one is written with the
shared helpers of `src/config/schema-helpers.ts` (`intFrom`, `bool`, `fraction`, `numberFrom`), which replace the three
private copies of `intFrom` and the hand-written `z.coerce.number().int().min().max().default()` of the admin,
maintenance and policy schemas. No default or range changed (the unit test freezes every numeric one as of F8).
Only `AUTH_MCP_ALLOWED_ORIGINS` states its default in the registry, because the schema's lives in a transform; the test
checks it against the schema too.

Groups (**chosen**, adjusted from the brief): General 2; Images and uploads 16; Art 1; Jobs and engine 4; Governor and
budgets 6; Proposals and policy 3; Audits and automation 3; Snapshots, backups and the journal 7; MCP and tools 2;
Dashboard and auth 11; Per-project settings 30; Server (bootstrap) 19; Secrets 8. In all 112 entries: 81 environment
variables (one of them, `LK_PROJECT_<NAME>_API_KEY`, stands for every project's key), one dashboard-only setting (the
contact email) and 30 per-project settings. The brief's **Narrative** group is not there: no configuration key belongs
to it (the narrative rules are the pack's, not settings). **General** (the log level, the contact email), **Proposals
and policy** (the three `POLICY_*`) and **Secrets** were added, because no listed group fitted them.

## Decision 2: dashboard values and the precedence

A value saved on the page is stored in `runtime_settings` under `dash.cfg.<KEY>`, as the JSON of a plain value in the
setting's base unit. Precedence (the owner's): **dashboard value → environment → default**, applied where the
configuration is loaded: `src/server.ts` validates the environment alone first (a file the bridge would refuse still
stops it, as before), opens the database and runs the migrations, then loads every loader again on the environment
with the dashboard's values on top (`loadEffectiveConfiguration`, `src/config/effective.ts`). Every component then sees
the effective value with no change of its own.

- A row for a bootstrap or secret key, or a key the registry does not know, is ignored: the dashboard can never move
  the database, the listen address, an allow-list or a key.
- A value is validated when it is saved: its type, its schema field (range, choices, format), then every loader that
  reads it with the environment and the other saved values, so a rule between settings holds (for example
  `AUTH_REFRESH_FAMILY_MAX_SECONDS ≥ AUTH_REFRESH_TOKEN_TTL_SECONDS`). Only issues the value itself brings count.
- If the environment changes later so that a saved value no longer loads, that value is **left out** at the start
  (named on stderr and at the top of the Settings page, never its value) rather than stop the bridge (**chosen**).
- An amount in the display unit must convert exactly to the base unit (1.5 MB is 1,572,864 bytes; 0.0001 seconds is
  not a whole number of milliseconds and is refused, never rounded).

## Decision 3: which settings apply at once

A `now` setting is read on each use: the tool settings object the components share gets a getter per `now` key
(`liveToolsSettings`, `src/config/live.ts`), which returns the built value while the dashboard value is the one the
bridge started with, and otherwise works the value out again as the loader would (cached until the next change). Each
consumer was checked to read through that shared object on each use.

Became `now` in F8 (17): `UPLOAD_FETCH_TIMEOUT_MS`, `UPLOAD_PUT_TIMEOUT_MS`, `IMAGE_MAX_PIXELS`, `IMAGE_MAX_FRAMES`,
`IMAGE_CONVERT_TIMEOUT_MS`, `IMAGE_UPLOAD_BODY_TIMEOUT_MS`, `IMAGE_UPLOAD_IDLE_TIMEOUT_MS`, `IMAGE_STAGING_REPORT_DAYS`,
`IMAGE_STAGING_MAX_DAYS`, `IMAGE_STAGING_MIN_FREE_GB`, `ASSET_BYTES_RETENTION_DAYS`, `SNAPSHOT_MIN_FREE_GB`,
`SNAPSHOT_KEEP_FULL_DAYS`, `SNAPSHOT_KEEP_WEEKLY`, `SNAPSHOT_KEEP_DAYS`, `SNAPSHOT_SOFT_DELETE_DAYS`,
`MCP_RESULT_MAX_CHARS`. Already at once before F8 and unchanged: read-only mode, `WRITERS_MAX`, the reserve floors, the
contact email.

Stays `next_start`, because it is built into something at start: `UPLOAD_MAX_BYTES` (it sizes the request body limits
of `/mcp` and of the Staging upload, fixed when the routes are registered; the very limit the owner changed by hand
stays a restart, which the restart button now makes one click); `UPLOAD_ALLOW_URL_SOURCE` (the tool descriptions say
which sources there are); `IMAGE_CONVERT_CONCURRENCY` and the upload rate limits (the queue and the limiters are built
with them); `ART_CACHE_MAX_MB`; the governor's spacing and tier limits; the auth lifetimes; the admin stream, the
maintenance scheduler and the policy timers; the log level; per-operation tools and member administration (as before).

## Decision 4: the six settings that existed before F8

Read-only mode, per-operation tools, member administration, journal retention, tier limits and the contact email (and
the reserve floors and writer slots, which the Budgets and Writers pages also edit) join the registry with their own
stored keys (`dash.expose_per_op_tools`, `dash.allow_member_admin`, `dash.journal_retention`, `dash.tier_limits`,
`dash.contact_email`, `dash.reserve_floors`, `jobs.read_only_override`, `jobs.writers_max`), their routes, their apply
mode and their audit lines: an edit through the registry's route calls the same admin action. A journal or floor
setting is one part of its stored object; the others keep their stored value. Existing stored values keep working
(tested with rows written before the runtime starts). The read-only card (on is one click, off asks) and the tier limit
table stay on the page as they were.

## Decision 5: the bootstrap list

Read-only on the page ("Change on the server: the env file, via env-sync"); the API refuses an edit
(`SETTING_BOOTSTRAP`), and the start ignores a stored row for one. Decided from the code and `deploy/`:

| Setting                                                 | Why                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PATH`                                               | Read before the database opens (dashboard values live in it); systemd lets the service write only under `/var/lib/lk-bridge` (`ReadWritePaths`).                      |
| `IMAGE_DATA_DIR`, `ART_CACHE_DIR`, `SNAPSHOT_DIR`       | Directories: `ProtectSystem=strict` and `ReadWritePaths=/var/lib/lk-bridge` decide what the service can write; a path it cannot write stops the feature or the start. |
| `HOST`                                                  | Caddy reaches the bridge there; a wrong value cuts the dashboard off, so it could not be put back from there.                                                         |
| `PORT`                                                  | `deploy/Caddyfile.lk-bridge` forwards to it; a different or busy port stops the bridge being reached, or starting.                                                    |
| `BRIDGE_PUBLIC_URL`                                     | The OAuth issuer, every token's audience and the address Caddy and DNS serve: changing it signs every client out and needs the proxy changed with it.                 |
| `NODE_ENV`                                              | The deployment mode the env file sets for the service.                                                                                                                |
| `LK_BASE_URL`                                           | Every project's API key is sent there: an outbound target a dashboard session must never be able to redirect.                                                         |
| `LK_ASSET_HOSTS`, `OUTBOUND_EXTRA_PORTS_ALLOWLIST`      | Outbound allow-lists (the SSRF guard): kept with the server, so a dashboard session alone can never widen them.                                                       |
| `AUTH_MCP_ALLOWED_ORIGINS`, `OAUTH_EXTRA_REDIRECT_URIS` | Allow-lists of which websites may call `/mcp` and where sign-in codes may be sent (**chosen**: treated like the outbound allow-lists).                                |
| `TRUST_PROXY`                                           | Depends on the reverse proxy on the server; a wrong value lets any client forge its address (rate limits, logs).                                                      |
| `OWNER_USERNAME`                                        | The sign-in name, read by the sign-in service at start; a mistake locks the owner out of the page that could correct it (**chosen**).                                 |
| `LK_PROJECTS`, `LK_DEFAULT_PROJECT`                     | Which keys to read from the env file at start; projects and the default are managed on the Projects page (linked).                                                    |
| `LK_PROJECT_ID`, `LK_PROJECT_NAME`                      | Read by the database migrations before anything else (`migrationContextFromEnv`).                                                                                     |

## Decision 6: secrets are never shown

Secret (8 entries): `SESSION_SECRET`, `JWT_SIGNING_KEY`, `SECRETS_MASTER_KEY`, `SECRETS_MASTER_KEY_PREVIOUS` (env-sync),
`OWNER_PASSWORD_HASH`, `OWNER_TOTP_SECRET` (the Account page; the recovery codes are managed there too), `LK_API_KEY`
and every `LK_PROJECT_<NAME>_API_KEY` (the Projects page). The page shows the name, _set_ or _not set_ (and whether in
the env file or the encrypted store), and a link to where each is managed; the view never reads a secret's value. The
off-site copy's OAuth client secret is not a configuration key (it lives in the encrypted store, on the Off-site copy
page), so it is not in the registry. A test walks every GET route the admin plugin registers, and the settings edits,
under a test configuration holding every secret, and fails if any response contains a secret's value.

## Decision 7: "Restart the bridge" (owner-approved)

The unit has `Restart=on-failure` (`deploy/lk-bridge.service`), so a clean exit would not come back. The button (step-up,
then a confirmation) runs the SIGTERM stop the bridge already has (CR-2026-11-R3 fix A: no new requests or tool calls,
each running job parked at its next step boundary, waits ended, HTTP and the database closed, every stage bounded, a
watchdog at 25 s), then exits with the dedicated code **75** (`EX_TEMPFAIL`), which systemd restarts.

- It is the owner's request, not a failure: the bridge logs "restart requested by the owner" (info) before the exit;
  a marker written first (`dash.restart_requested`) makes the next start record `bridge.restarted` ("restarted at the
  owner's request") in the audit and the log, and the Settings page shows the last such restart.
- Outside systemd (no `INVOCATION_ID` in the bridge's environment) the button is disabled and says why; the route
  answers `409 RESTART_UNAVAILABLE`.
- The page shows "N settings pending a restart" with the button.
- `deploy/lk-bridge.service` is not changed. The optional line, as a drop-in: `RestartForceExitStatus=75`; the button
  works without it under `on-failure`. A restart counts towards `StartLimitBurst=5` in 300 s like any start.

## Decision 8: the API and the step-up

`GET /api/admin/settings/config` (every entry with its value, source, range, unit, apply mode and pending flag; the
pending count; the restart status), `PUT /api/admin/settings/config/:key` (`{ value }` in the base unit, or
`{ amount, unit }` in the display unit; `confirm: true`), `POST /api/admin/settings/config/:key/reset` and
`POST /api/admin/bridge/restart`. The three changes **ask** for the step-up (classified in
`test/review/r4-sessions/routes-inventory.test.ts`, as F7's were). A change is audited `settings.config` or
`settings.config_reset` with its old and new value and source; Recent changes shows both.

## Decision 9: kept that way automatically

`test/unit/config-registry.test.ts` fails when a key in any config schema (or one `projectsFrom` reads) has no entry,
an entry names a key that does not exist, `.env.example` or `deploy/env.template` lacks a non-secret key or lists one
the registry does not know, or an entry's default or range disagrees with its schema; and when a bootstrap entry gives
no reason, a credential-shaped name is not secret, a `now` setting is not read live, or a pre-F8 stored key changes.
`.env.example` gained the image and snapshot variables it lacked; `deploy/env.template` already listed them all.
CLAUDE.md: "Every new setting goes in `src/config/registry.ts` (it then appears on the Settings page); secrets and
bootstrap settings are marked so."

## Left out

- `BACKUP_DIR` (read by the snapshot service from the process environment, set by `deploy/backup.sh`) and the scripts'
  own variables (`LKB_ENV_FILE`, `LKB_RCLONE`, `TMPDIR`) are not in any config schema, so not in the registry.
- No range was guessed: every range is the schema's. Variables without one (strings, lists, the per-project names) are
  shown without a range.
