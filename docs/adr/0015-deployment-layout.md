# ADR 0015: Deployment on the shared server (private Node, `/opt/lk-bridge/app`, stop-to-drain)

Status: Accepted (chunk 7a, 8 November 2026). Amends PLAN §9.2 and §9.3 for the actual server; the rest of §9 stands.

## Context

PLAN §9 was written before the server was known. It assumed a fresh machine: Node 24 from NodeSource, the checkout
directly in `/opt/lk-bridge`, a public repository, and an update script that drains through the admin API. The real
server already runs Caddy with other sites (another MCP bridge, Foundry VTT), may have services that depend on the
system Node, and the repository is now private.

## Decisions

1. **A private Node 24, not the system one.** `deploy/install-node.sh` unpacks the official tarball (version pinned in the
   script, checksum checked against `SHASUMS256.txt`) under `/opt/lk-bridge/runtime/node`. The unit and every script use
   that binary by absolute path or by putting it first on `PATH`; `apt` and the system Node are never touched. Replaces the
   NodeSource step of §9.3.
2. **Layout.** `/opt/lk-bridge/app` is the checkout (owner `lkbridge`), `/opt/lk-bridge/runtime` the private Node (owner
   `root`, so the service cannot rewrite its own interpreter), `/var/lib/lk-bridge` the data (0700), `/etc/lk-bridge` the
   env file (0640, `root:lkbridge`). The checkout moved from `/opt/lk-bridge` to `/opt/lk-bridge/app` so that the runtime
   can sit beside it. The service user's home is `/home/lkbridge` (SSH deploy key, npm cache); the unit uses
   `ProtectHome=yes`, so the running service cannot see it.
3. **Read-only deploy key.** The server clones over SSH with a GitHub deploy key (no write access) that belongs to the
   service user. No token is stored.
4. **Deploy drains by stopping the service**, not through the admin API. `/api/admin` accepts only the owner's browser
   session (ADR 0013), so a script would need the owner's password or cookie stored on the server. `systemctl stop` sends
   SIGTERM, which already runs the engine's drain (up to 20 s); the unit waits 45 s before SIGKILL. The price is about a
   minute of downtime per deploy; the benefit is that no credential exists for scripts to misuse.
5. **A narrow sudo rule.** `lkbridge` may run exactly `systemctl start|stop|restart|status lk-bridge` without a password
   (`deploy/sudoers.lk-bridge`). Unit files, Caddy and everything else stay with the administrator.
6. **Forward-only code, database and rollback.** `deploy.sh` fast-forwards only and refuses a dirty checkout. It takes a
   `pre-deploy` backup before migrating. Rolling back means checking out the earlier commit and deploying it with
   `--current`; migrations are not reversed, so a release with a schema change is rolled back by restoring that backup.
7. **Caddy gets one site block and no new behaviour.** Plain `reverse_proxy` with `flush_interval -1`; no `encode`,
   `redir`, `rewrite` or `header`, for the reasons in `deploy/Caddyfile.lk-bridge`.

## Consequences

- Nothing on the server outside `/opt/lk-bridge`, `/var/lib/lk-bridge`, `/etc/lk-bridge`, the three unit files, one
  sudoers file and one Caddy site block is created or changed.
- Upgrading Node is `NODE_VERSION=v24.x.y sudo deploy/install-node.sh`, then a restart; the previous version is kept for
  one rollback.
- Not verified here (no server): the units were checked with `systemd-analyze verify` and the scripts with shellcheck, but
  nothing has run on Ubuntu 24.04 yet. The first deployment is the real test; the runbook says what to look for.
