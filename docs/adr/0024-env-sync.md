# ADR 0024: env-sync keeps the env file in step with the template; the deploy checks itself and the env file first

Status: Accepted (OPS1, 10 November 2026). Builds on [ADR 0015](0015-deployment-layout.md) and
[ADR 0020](0020-separate-build-user.md); amends ADR 0020 decision 2 (the installed deploy script is now updated by
`deploy.sh --update-self`, after the administrator has seen the difference, instead of only by hand) and ADR 0020
decision 3 (root now also runs one more root-owned script with the private Node: env-sync's planner). Carries out the
env-file part of [ADR 0023](0023-project-model.md)'s move to the multi-project form.

## Context

Every release that added or retired a setting meant editing `/etc/lk-bridge/lk-bridge.env` by hand with `sudoedit`: the
drift check (chunk 8) only warned. v2 A1 made it worse: moving to the multi-project form meant renaming the line that
holds the LegendKeeper key, adding two lines and removing four, by hand, on the server, near secrets. The deploy script
installed in `/opt/lk-bridge/bin` was also only compared with the release after a successful deploy, so a release that
needed a new deploy script was deployed by the old one first.

## Decisions

1. **The template says what may be done with each variable.** Every variable line in `deploy/env.template`, set or
   commented out, has exactly one marker on the line directly above it: `@default` (add it with the template's value),
   `@generate:<encoding>:<bytes>` (create a random value: `crypto.randomBytes`, 16 to 256 bytes, base64, base64url or
   hex; `SESSION_SECRET` and `JWT_SIGNING_KEY` are `@generate:base64:48`, the same strength as the runbook's
   `openssl rand -base64 48`), `@secret` (only the owner can supply it: the LegendKeeper keys, `OWNER_PASSWORD_HASH`,
   `OWNER_TOTP_SECRET`, and later the rclone password; an active `NAME=` line means required, a commented one
   optional), or `@optional` (commented out with its default). A test derives every variable the config loaders read
   (both project forms) and requires exactly one marker for each, no value on any `@secret` or `@generate` line, and
   `@secret` or `@generate` on every credential-shaped name.
2. **env-sync** (`deploy/env-sync.sh`, with its planner in `deploy/env-sync.mjs`) compares the live file with a
   template and: adds missing `@default` and `@generate` variables with the template's comment; fills a **blank**
   `@generate` line in place (a blank secret is not a value, and the bridge refuses it anyway); adds a commented-out
   placeholder for a missing `@secret` and reports `ACTION NEEDED: fill in X`, never inventing one; adds missing
   `@optional` variables commented out; comments out, with a dated "removed in vX.Y.Z" note, a variable the template no
   longer lists. **Existing values are never changed**, with the one exception of `--migrate-projects`. Additions go in
   a dated block at the end of the file; a variable the owner has commented out counts as present.
3. **The project variables follow the project rules, not the markers**, as in the drift check: in the multi-project
   form each listed project needs its `LK_PROJECT_<NAME>_API_KEY` (a placeholder and `ACTION NEEDED` otherwise),
   `LK_DEFAULT_PROJECT` is added when one project is listed and asked for when several are; in the single-project form
   nothing is added and env-sync says how to migrate; the single-project names are never added. A file with neither form
   (a new one) gets the template's project lines like any other.
4. **`--migrate-projects`** renames the `LK_API_KEY` line to `LK_PROJECT_<NAME>_API_KEY` **in place, with its value text
   untouched** (the planner never reads the value out; it moves the rest of the line), adds `LK_PROJECTS` and
   `LK_DEFAULT_PROJECT` above it (`<name>` from `LK_PROJECT_NAME`, lower-cased, or `test`), and comments out
   `LK_PROJECT_ID`, `LK_PROJECT_NAME`, `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID` with a "migrated" note. It
   refuses, changing nothing, any state that is not a clean single-project form: both forms, a new-form key without
   `LK_PROJECTS`, an empty `LK_PROJECTS` line, a variable set twice, an empty key, an invalid name, or a default that
   names another project. On a file already in the multi-project form it does nothing. It must run after the release
   with migration 0600 is deployed, because that migration takes the project id from `LK_PROJECT_ID`; the runbook's
   order (deploy, then migrate) and the boot check (which needs a build from this release) enforce that in practice.
5. **Secrets.** The planner prints names only. Values exist only in the new text, which goes to one temporary file
   created beside the env file (`O_EXCL`, 0600, in root's `/etc/lk-bridge`) and renamed over it. The planner runs with an
   empty environment, imports Node built-ins only, and turns any exception into a fixed message, so not even a stack
   trace can carry a value. Every test of the shell scripts scans stdout and stderr for every test secret, every value
   in the file, and every generated value.
6. **Every edit:** a timestamped backup beside the file (`lk-bridge.env.bak.<UTC time>`, `cp --preserve` of owner, group,
   mode and times), then the new file written beside it, given the old file's owner, group and mode
   (`chown`/`chmod --reference`), and renamed over it. A symbolic link, or a directory writable by group or others, is
   refused. Without `--yes` it shows the summary and asks; no answer means no.
7. **The boot check.** `npm run config:check` (`src/config/check.ts`, the only `src/` change) runs every loader
   `src/server.ts` runs at start-up on an env file, plus a format check of each project key (an RFC 6750 bearer token of
   at least 16 characters; no network, no database), and prints one `issue:` line per problem, naming the variable;
   any credential value that might still appear is replaced with `[redacted]`. After an edit, env-sync runs it as the
   service user with the built app. If it fails, env-sync runs it on the backup too: when the edit introduced any new
   problem (or the check could not run at all), the backup is put back and env-sync fails; when every problem was there
   before (a new install still missing its keys), the edit is kept with a warning. Without a build that has the check,
   env-sync refuses to edit (except with `--no-boot-check`, for a file no build reads yet).
8. **In the deploy.** After fetching, `deploy.sh` reads the release's `deploy/env.template` and `package.json` out of
   git as the build user (`git show`, into root's 0700 scratch directory, as text) and runs the installed env-sync with
   `--check`. A missing secret stops the deploy with `ACTION NEEDED` before anything changes (with `--sync-env`, after
   adding only the inert placeholder lines). Any other difference stops it with the exact command to run, the same
   deploy with `--sync-env`, which asks once up front and applies the update **after the build**, while the service is
   stopped, so that the new build's own check judges the result. Then, on every deploy, the new build's boot check runs
   before the database migrations and the start; a failure stops the deploy there, with the database untouched. The
   build user still never reads or writes the env file.
9. **The deploy checks itself first.** After fetching, `deploy.sh` compares the installed `deploy.sh`, `lib.sh`,
   `env-sync.sh` and `env-sync.mjs` with the copies in the commit being deployed. Any difference (a missing file
   included) is shown in full (these files hold no secrets) and stops the deploy, so an outdated installed script is
   never used for a release that needs the new one. `--update-self` asks, installs the release's copies (root:root,
   0755 or 0644, each written beside its target and renamed), and re-executes the new `deploy.sh` with the same
   arguments (once: a second difference stops it). With `--current`, which is how a rollback to an older commit is
   deployed, a difference is only a warning, so a rollback never silently downgrades the scripts that run as root.
10. **Defence in depth against a hostile template.** The template comes from the checkout, which the build user can
    change. env-sync refuses a template that would set a name that changes how Node, the dynamic loader, TLS or proxies
    behave (`NODE_*` other than `NODE_ENV`, `LD_*`, `PATH`, the `*_PROXY` variables, `SSL_*`, `OPENSSL_*`, and a few
    more), any line that is not a comment, a marker or `NAME=value`, and any variable without a marker. This does not
    make a compromised build safe (it already produces the code the service runs, ADR 0020), but it keeps the env file
    from becoming a second way in.

## Consequences

- A release that adds a setting no longer needs a hand edit: the deploy stops, says what it would add, and
  `--sync-env` does it with a backup and a check. Only a secret still needs the owner, and the deploy says which.
- The single-project to multi-project move is one command, `env-sync.sh --migrate-projects`, run after the A1 deploy.
- Backups accumulate in `/etc/lk-bridge` (they hold the same secrets, with the same owner and mode); the owner deletes
  old ones by hand.
- The installed deploy scripts are four files now, and the deploy keeps them current on request. The first install of
  this release's scripts is still by hand (the old script does not know `--update-self`).
- Tested here: shellcheck; the planner's unit tests; env-sync end to end on a fake server (each marker, removed
  variables, idempotency, the migration and each refusal, backup and restore around the boot check, owner/group/mode,
  `--check` exit codes, and no secret in any output); and `deploy.sh` end to end on a fake server with a real git origin
  and checkout (in step, stop with the command, `--sync-env`, `ACTION NEEDED`, restore on a failed boot check, a refused
  file without an edit, the self-check, `--update-self` re-running the new script, a missing installed file, and
  `--current`). Not run here: the server itself (real users, `runuser`, systemd), which the runbook's steps exercise.
