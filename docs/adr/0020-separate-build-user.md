# ADR 0020: A separate build user, and a deploy that runs as root and drops to each user

Status: Accepted (v1.0.1, 8 November 2026). Amends [ADR 0015](0015-deployment-layout.md) decisions 2 (layout), 3 (who
holds the deploy key) and the "Updates" line of PLAN §9.3; decisions 1, 4, 5, 6 and 7 stand. Closes review finding F-17
([docs/review/2026-11-hardening.md](../review/2026-11-hardening.md)).

## Context

The deploy built as `lkbridge`, the service user, which can read `/etc/lk-bridge/lk-bridge.env` (the LegendKeeper
ADMIN key, the session and JWT secrets, the owner's password hash) and write the database. `npm ci` installs about 200
packages, most of them development tools (TypeScript, Vite, ESLint, Vitest and their plugins), and `npm run build` runs
some of them. npm 11 skips unapproved install scripts, but build-time code still ran with access to every secret.

## Decision

1. **Two users.**
   - `lkbuild` (new; system user, no login shell, no sudo rights, home `/home/lkbuild` 0750) **owns
     `/opt/lk-bridge/app`** (checkout, `node_modules`, `dist`) and holds the read-only GitHub deploy key. It is **not**
     in group `lkbridge`, so it cannot enter `/etc/lk-bridge` (root:lkbridge 0750) or `/var/lib/lk-bridge` (lkbridge
     0700), and it cannot read `/home/lkbridge` (0750).
   - `lkbridge` (unchanged) runs the service. It can **read and execute** the app (everything there is 0644/0755,
     owned by `lkbuild`) but write none of it; it reads the env file and writes only `/var/lib/lk-bridge`.
   - The private Node in `/opt/lk-bridge/runtime` stays root's and writable by neither user (ADR 0015 decision 1); the
     migration and the health check now verify that.
2. **The deploy runs as root, from a root-owned copy, and drops to the right user for each phase.** It is invoked as
   `sudo /opt/lk-bridge/bin/deploy.sh`. **Not** as `sudo /opt/lk-bridge/app/deploy/deploy.sh`: the checkout belongs to
   `lkbuild`, so code that runs during a build (a hostile dependency, say) could rewrite that file and be run as root on
   the next deploy, which would undo the whole separation. So `deploy.sh` and its `lib.sh` are installed into
   `/opt/lk-bridge/bin` (root:root, 0755 and 0644) by an administrator, like the unit files; the script refuses to run
   from inside the checkout, or if its own files are not root's or are writable by others. After each deploy it warns
   when the release's `deploy/deploy.sh` or `deploy/lib.sh` differs from the installed copy, so the administrator can
   review the difference and reinstall.
3. **Root only orchestrates.** It never runs git, npm, node or a script from the checkout itself, and never sources
   anything from it. Each phase uses `runuser -u <user> -- env -i HOME=… PATH=<private Node>:/usr/bin:/bin …`, so no
   variable (and no secret) is inherited:
   - as `lkbuild`, with umask 022: `git status`, `git fetch`, `git merge --ff-only`, `npm ci`, `npm run build`;
   - as `lkbridge`: the `pre-deploy` backup, the database migrations and the health check;
   - the stop and start of the service: as `lkbridge`, through its existing narrow sudoers rule
     (`sudo -n /usr/bin/systemctl stop|start lk-bridge`), unchanged, so that rule keeps being exercised.
     Root itself only reads files (the env file for `PORT` and `DB_PATH`, the template for the drift report, unit files
     to compare), runs `curl` against `127.0.0.1` and `systemctl is-active`.
4. **Checks before and after.** Pre-flight refuses if `lkbuild` is in group `lkbridge`, can read the env file, or does
   not own the app, or if the private Node is not root's. After the build, nothing in the app may be writable by
   `lkbridge`. `healthcheck.sh` gains six PASS/FAIL permission checks (the build user cannot read the secrets or the
   database and is not in the service group; the service user cannot write the app and can read it and the env file;
   the runtime is root's), judged from owners, groups and modes, so they run without privileges, exactly for the write
   check when run as `lkbridge` (`find -writable`), and a POSIX ACL on the secrets' paths is a FAIL to check by hand.
5. **Sudo rules: no new rule.** `lkbridge` keeps exactly `systemctl start|stop|restart|status lk-bridge`
   (`deploy/sudoers.lk-bridge`, unchanged). `lkbuild` gets **none**, and the migration and pre-flight check that. The
   administrator already has full sudo, so a rule letting them run the deploy without a password would add nothing but
   a second way in. The migration still installs the sudoers file through `visudo -cf` if it differs.
6. **An existing install is migrated by a one-off, idempotent script**, `deploy/migrate-to-build-user.sh`, run as root
   from a root-owned copy outside the checkout (the checkout is still `lkbridge`'s when it starts). It creates
   `lkbuild`, moves the deploy key (only after `lkbuild` has authenticated to GitHub with it; with no key to move it
   stops and says how to add a new one), fixes ownership and modes, installs `/opt/lk-bridge/bin`, validates the
   sudoers file, verifies the separation as each user with `runuser`, then runs a normal deploy (built by `lkbuild`) and
   the health check. `--check` reports what it would change and changes nothing. Each step looks before it acts, so it
   is safe to run again; anything unexpected stops it with a message.

## Consequences

- Development dependencies and build tooling no longer run where the secrets are readable. **Runtime** dependencies
  still run as `lkbridge` with the secrets, as they must; and since `lkbuild` produces the code `lkbridge` runs, a
  compromised build can still change what the service does next. The separation keeps secrets away from the build, and
  keeps the service from rewriting its own code; it does not make an untrusted dependency safe at run time. Keep
  reviewing `package-lock.json` changes.
- Deploying needs root (`sudo`), not `sudo -u lkbridge`. The old command now stops with a message pointing here.
- `lk-run.sh` (`setup:owner`, `pat`, `db:migrate`), `backup.sh`, `restore.sh` and the backup timer still run as
  `lkbridge`: they run the built bridge, which needs the secrets anyway. `sandbox-test.sh` and `soak-sandbox.sh` also
  still run as `lkbridge` and run Vitest and tsx (development tools) there; they are opt-in and run by the owner only.
  Moving them to `lkbuild`, with only the two sandbox variables handed over by root, is a follow-up.
- Two more things live on the server: the `lkbuild` user and `/opt/lk-bridge/bin`. `deploy.sh` warns when the
  installed copy is older than the release's, as it already does for the unit files.
- Tested here: shellcheck; the static and helper tests in `test/unit/deploy-files.test.ts` (the permission helper is
  checked against the kernel with `runuser -u nobody`); and a rehearsal of the whole deploy flow (fetch, fast-forward,
  `npm ci` and the build under `env -i`, backup, migrations, start, health check) under a scratch prefix with the
  user switch and systemctl stubbed. Not run here: the migration against real `lkbridge` and `lkbuild` accounts and
  GitHub, which needs the server (the runbook's migration section says what to look for).
