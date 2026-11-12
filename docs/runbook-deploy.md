# Deployment runbook: lk.ottomoons.co.uk

Step by step, for **this** server: Ubuntu 24.04 LTS, Caddy already installed and serving other sites, the system Node
left alone. Design reasons are in [ADR 0015](adr/0015-deployment-layout.md) and, for the separate build user (v1.0.1),
[ADR 0020](adr/0020-separate-build-user.md); what the bridge does once it is up is in [PLAN §9](PLAN.md) and
[auth-live-checklist.md](auth-live-checklist.md).

> **Upgrading a server that already runs 1.0.0?** Do not follow the fresh-install steps. Go to
> [Migrating an existing install to v1.0.1](#migrating-an-existing-install-to-v101).

**Two users (v1.0.1).** `lkbuild` owns the checkout and builds it; it cannot read the secrets or the database.
`lkbridge` runs the service; it reads the secrets and the app and writes only `/var/lib/lk-bridge`, never the app. The
deploy runs as root from a root-owned copy (`sudo /opt/lk-bridge/bin/deploy.sh`) and drops to the right user for each
step.

## How to read this

- **🔒 sudo** marks every command that needs `sudo` (including `sudo -u lkbridge …` and `sudo -u lkbuild …`, which are
  `sudo` too). A block with no mark runs as any user and changes nothing.
- Commands run as your administrator account unless a block says otherwise. `sudo -u lkbridge` runs a command as the
  service user, `sudo -u lkbuild` as the build user.
- **✋ Owner** marks a step only you can do: it involves a secret, a password, or an account on GitHub, LegendKeeper,
  Claude or ChatGPT. If a Claude Code session is following this runbook for you, it must stop at those steps and let you
  do them. **Never paste an API key, a secret or the owner password into a chat or a command line**; secrets go into the
  dashboard's write-only key field (OPS2) or into the env file through an editor (`sudoedit`).
- Every path and name below is the real one; there is nothing to substitute except where a `<placeholder>` is shown.

## The order, in one list

Prerequisites (DNS, packages, checks) → users and directories → deploy key and clone → private Node → first build →
env file ✋ → `setup:owner` ✋ → systemd units, the sudo rule and the deploy script → start and check locally → Caddy
block → health check → sandbox script ✋ → connect Claude and ChatGPT ✋ → go live ✋. These are sections 1 to 14 below,
in that order.

Afterwards: [updating](#updating), [updating the env file](#updating-the-env-file), [backups and restore](#backups-and-restore), [rollback](#rollback),
[logs](#logs-and-useful-commands), [the soak test](#soak-test-), [the v2 phase 0 spike](#v2-phase-0-spike-),
[the browser smoke test](#browser-smoke-test),
[memory](#memory), [moving to several projects (v2 A1)](#moving-to-several-projects-v2-a1),
[managing projects from the dashboard (OPS2)](#managing-projects-from-the-dashboard-ops2) (and
[rotating the master key](#rotating-the-master-key)),
[migrating an existing install to v1.0.1](#migrating-an-existing-install-to-v101).

## What is where

| Path                                     | What                                                                                   | Owner / mode          |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| `/opt/lk-bridge`                         | the three directories below                                                            | `root`, 0755          |
| `/opt/lk-bridge/app`                     | the git checkout and build output; readable by all, writable only by `lkbuild`         | `lkbuild`, 0755       |
| `/opt/lk-bridge/bin`                     | the installed `deploy.sh`, `lib.sh`, `env-sync.sh`, `env-sync.mjs`, run as root        | `root`, 0755          |
| `/opt/lk-bridge/runtime/node`            | symlink to the private Node 24 (`node-v24.x.y-linux-x64` beside it)                    | `root`, 0755          |
| `/var/lib/lk-bridge`                     | `bridge.db` and its WAL files; the only place the service may write                    | `lkbridge`, **0700**  |
| `/var/lib/lk-bridge/backups`             | `nightly-*.db.gz` (newest 14) and `pre-deploy-*.db.gz` (newest 5)                      | `lkbridge`, 0700      |
| `/etc/lk-bridge/lk-bridge.env`           | every setting and secret (and `lk-bridge.env.bak.<time>`, env-sync's backups)          | `root:lkbridge`, 0640 |
| `/etc/systemd/system/lk-bridge.service`  | the service                                                                            | `root`, 0644          |
| `/etc/systemd/system/lk-bridge-backup.*` | the nightly backup service and timer                                                   | `root`, 0644          |
| `/etc/sudoers.d/lk-bridge`               | lets `lkbridge` start, stop, restart and show the status of `lk-bridge` — nothing else | `root`, 0440          |
| `/etc/caddy/Caddyfile`                   | one block appended                                                                     | unchanged otherwise   |
| `/home/lkbuild/.ssh`                     | the read-only GitHub deploy key (v1.0.1; it was in `/home/lkbridge/.ssh` before)       | `lkbuild`, 0700       |
| `/home/lkbuild`, `/home/lkbridge`        | the users' homes (npm cache, SSH config); neither can read the other's                 | each its own, 0750    |

`lkbuild` has no login shell, no password and no sudo rights, and is not in group `lkbridge`.

The scripts, all in `deploy/`: `install-node.sh`, `deploy.sh`, `backup.sh`, `restore.sh` (chunk 8), `healthcheck.sh`,
`lk-run.sh` (runs a command with the private Node and `DB_PATH` set), `sandbox-test.sh`, `soak-sandbox.sh` (chunk 8), `spike-v2.sh` (v2 phase 0),
`migrate-to-build-user.sh` (v1.0.1, once), `env-sync.sh` with `env-sync.mjs` (OPS1: keeps the env file in step with
`env.template`), plus `lib.sh` (shared helpers) and the files the steps install: `lk-bridge.service`,
`lk-bridge-backup.service`, `lk-bridge-backup.timer`, `Caddyfile.lk-bridge`, `sudoers.lk-bridge`, `env.template`.
`deploy.sh`, `lib.sh`, `env-sync.sh` and `env-sync.mjs` are also installed into `/opt/lk-bridge/bin` (step 8).

---

## 1. Prerequisites

**✋ Owner, outside the server**

- **DNS.** An `A` record `lk.ottomoons.co.uk` → this server's public IPv4 address. Claude's connectors are IPv4-only and
  reject names that resolve to private or CGNAT addresses. Do **not** add an `AAAA` record unless this server's IPv6 is
  fully working. Check from your own computer: `dig +short A lk.ottomoons.co.uk`.
- **LegendKeeper.** An API key (ADMIN role) for each project the bridge will serve: the test world's to start with
  (v2 A1: one bridge serves several projects, each with its own key; [projects.md](projects.md)). Project ids are not
  needed: the bridge learns each project's id from its key. Keep the keys somewhere you can copy from in step 6; do not
  email or message them.
- **GitHub.** You will add a deploy key to the repository in step 3 (repository _Settings → Deploy keys_).

**🔒 sudo, on the server**

```bash
# Packages: git for the checkout, sqlite3 for backups, xz-utils to unpack Node, openssl to make secrets, curl for checks.
sudo apt update
sudo apt install -y git curl xz-utils sqlite3 openssl ca-certificates dnsutils
```

Check the starting point (none of these changes anything). Write down the Node version: it must be the same afterwards.

```bash
node --version || echo "no system node"       # note it; this runbook never changes it
caddy version
systemctl is-active caddy                     # active
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile   # must pass BEFORE we touch it  (🔒 sudo)
sudo ss -ltnp | grep -E ':(80|443|8787)\s'    # 80 and 443 belong to caddy; nothing may be on 8787  (🔒 sudo)
id lkbridge 2>&1 | head -1                    # "no such user" is what we want
id lkbuild 2>&1 | head -1                     # the same
df -h /opt /var | cat                         # a few hundred MB free is plenty
timedatectl | grep -i synchronized            # "System clock synchronized: yes" (tokens and TOTP depend on it)
```

If `caddy validate` already fails, stop: fix that first, or you will not know whether a later failure is ours.

`npm ci` installs two native modules, `better-sqlite3` and `argon2`. Both normally arrive prebuilt; if step 5 fails with
`node-gyp` or compiler errors, install the build tools (`sudo apt install -y build-essential python3`) and run it again.

## 2. The users and the directories

🔒 sudo

```bash
sudo useradd --system --create-home --home-dir /home/lkbridge --shell /bin/bash --user-group lkbridge
sudo useradd --system --create-home --home-dir /home/lkbuild --shell /usr/sbin/nologin --user-group lkbuild
sudo chmod 0750 /home/lkbridge /home/lkbuild

sudo install -d -o root     -g root     -m 0755 /opt/lk-bridge /opt/lk-bridge/runtime /opt/lk-bridge/bin
sudo install -d -o lkbuild  -g lkbuild  -m 0755 /opt/lk-bridge/app
sudo install -d -o lkbridge -g lkbridge -m 0700 /var/lib/lk-bridge /var/lib/lk-bridge/backups
sudo install -d -o root     -g lkbridge -m 0750 /etc/lk-bridge

id lkbuild                                     # groups: lkbuild only — never lkbridge, sudo or adm
```

The service needs `/var/lib/lk-bridge` to exist before it starts (the unit's `ReadWritePaths=` points at it). Neither
account has a password or a way to log in remotely; you reach them only through `sudo -u lkbridge` and `sudo -u lkbuild`.
`lkbuild` owns the checkout and builds it; it is deliberately **not** in group `lkbridge`, so it cannot read
`/etc/lk-bridge` or `/var/lib/lk-bridge` ([ADR 0020](adr/0020-separate-build-user.md)).

Run the commands in the rest of this runbook from a directory the service user can read, for example:

```bash
cd /opt/lk-bridge
```

## 3. The deploy key and the clone

The repository is private. The server reads it over SSH with a **read-only deploy key** that belongs to `lkbuild`.

🔒 sudo

```bash
sudo -u lkbuild install -d -m 0700 /home/lkbuild/.ssh
sudo -u lkbuild ssh-keygen -t ed25519 -N '' -C 'lk-bridge deploy key (lk.ottomoons.co.uk)' -f /home/lkbuild/.ssh/lk_bridge_deploy
sudo cat /home/lkbuild/.ssh/lk_bridge_deploy.pub        # the PUBLIC half; safe to copy
```

**✋ Owner:** on GitHub open the repository → _Settings → Deploy keys → Add deploy key_. Title it
`lk.ottomoons.co.uk (read-only)`, paste the public key, and leave **Allow write access unticked**.

Tell SSH to use that key for github.com, and pin GitHub's host key after checking its fingerprint.

🔒 sudo

```bash
sudo -u lkbuild tee /home/lkbuild/.ssh/config >/dev/null <<'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/lk_bridge_deploy
    IdentitiesOnly yes
EOF
sudo -u lkbuild chmod 0600 /home/lkbuild/.ssh/config

sudo -u lkbuild sh -c 'ssh-keyscan -t ed25519 github.com > /home/lkbuild/.ssh/known_hosts.candidate 2>/dev/null && ssh-keygen -lf /home/lkbuild/.ssh/known_hosts.candidate'
```

The line printed must contain GitHub's published ed25519 fingerprint, `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.
Confirm it against <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>
(do not trust this page alone). If it matches:

```bash
sudo -u lkbuild mv /home/lkbuild/.ssh/known_hosts.candidate /home/lkbuild/.ssh/known_hosts
sudo -u lkbuild ssh -T git@github.com       # "Hi Airwolf1221/LK-Bridge! You've successfully authenticated, but GitHub does not provide shell access."
sudo -u lkbuild git -C / ls-remote git@github.com:Airwolf1221/LK-Bridge.git HEAD && echo "good: lkbuild can read the repository"
sudo -u lkbuild sh -c 'umask 022 && git clone git@github.com:Airwolf1221/LK-Bridge.git /opt/lk-bridge/app'
sudo -u lkbuild git -C /opt/lk-bridge/app log --oneline -3
```

Judge `ssh -T` by its **message** only: GitHub ends it with exit status 1 even when the key is accepted. For a yes/no
answer (exit status 0 when the key works) use the `git ls-remote` line, which is also what the migration script checks.

The checkout is on `main`. (To deploy another branch, clone with `--branch <name>` and prefix `DEPLOY_BRANCH=<name>` to
the `deploy.sh` commands.)

## 4. The private Node 24

🔒 sudo

```bash
sudo /opt/lk-bridge/app/deploy/install-node.sh
/opt/lk-bridge/runtime/node/bin/node --version      # v24.x.y (pinned in the script, currently v24.22.2)
node --version || true                              # the system Node: unchanged from step 1
```

The script downloads the official tarball and `SHASUMS256.txt` from nodejs.org, checks the SHA-256, unpacks it beside
the old version and switches the `node` symlink in one step. Running it again is harmless. To use another 24.x release:
`sudo NODE_VERSION=v24.x.y /opt/lk-bridge/app/deploy/install-node.sh`.

The checksum guards against a corrupt download; it comes from the same host as the tarball. If you also want the
release signature checked, verify `SHASUMS256.txt.sig` against the Node.js release keys listed at
<https://github.com/nodejs/node#release-keys> (optional).

## 5. The first build

🔒 sudo (as `lkbuild`, with an empty environment, exactly as `deploy.sh` does it later)

```bash
sudo -u lkbuild env -i HOME=/home/lkbuild PATH=/opt/lk-bridge/runtime/node/bin:/usr/bin:/bin \
  bash -c 'umask 022 && cd /opt/lk-bridge/app && npm ci --no-audit --no-fund && npm run build'
ls /opt/lk-bridge/app/dist/server.js /opt/lk-bridge/app/ui/dist/index.html
```

`env -i` starts from an empty environment, so nothing from your shell reaches the build; `umask 022` keeps everything
it writes readable by `lkbridge` and writable only by `lkbuild`.

## 6. The env file ✋

🔒 sudo

```bash
sudo install -m 0640 -o root -g lkbridge /opt/lk-bridge/app/deploy/env.template /etc/lk-bridge/lk-bridge.env
sudo ls -l /etc/lk-bridge/                    # -rw-r----- 1 root lkbridge
```

**✋ Owner:** edit it by hand. `sudoedit` keeps the file's owner and mode.

```bash
sudoedit /etc/lk-bridge/lk-bridge.env
```

Fill in:

| Variable                            | Value                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LK_PROJECTS`                       | the projects, comma-separated; the template has `test` (the test world). Add a name, and its key line, for each further project |
| `LK_PROJECT_TEST_API_KEY`           | the test world's key from LegendKeeper; one `LK_PROJECT_<NAME>_API_KEY` per listed project, the name upper-cased                |
| `LK_DEFAULT_PROJECT`                | where reads go when an agent names no project (`test`); required once there are two projects                                    |
| `SESSION_SECRET`, `JWT_SIGNING_KEY` | two **different** random values: run `openssl rand -base64 48` twice in another terminal and copy each output                   |
| `OWNER_PASSWORD_HASH`               | step 7 gives you this line                                                                                                      |

`LK_API_KEY`, `LK_PROJECT_ID` (the v1 single-project form) and `LK_SANDBOX_API_KEY`, `LK_SANDBOX_PROJECT_ID` are no longer
used in a new file ([projects.md](projects.md)). An existing file moves to the new form as in
[Moving to several projects (v2 A1)](#moving-to-several-projects-v2-a1).

Already set for production: `BRIDGE_PUBLIC_URL=https://lk.ottomoons.co.uk`, `TRUST_PROXY=loopback`,
`LK_READ_ONLY=true` (the first boot is read-only), `WRITERS_MAX=1`, `HOST=127.0.0.1`, `PORT=8787`,
`DB_PATH=/var/lib/lk-bridge/bridge.db`. Leave them. Rules for the file: one `NAME=value` per line, no `export`, no spaces
around `=`; a value containing `$` (the owner hash) stays inside single quotes.

Check that nothing required is still blank, **without printing any value**:

```bash
sudo grep -E '^(LK_PROJECT_[A-Z0-9_]+_API_KEY|SESSION_SECRET|JWT_SIGNING_KEY|OWNER_PASSWORD_HASH)=$' /etc/lk-bridge/lk-bridge.env
# prints only the names still empty (OWNER_PASSWORD_HASH is expected until step 7); prints nothing when all are set
sudo -u lkbridge test -r /etc/lk-bridge/lk-bridge.env && echo "lkbridge can read it"
sudo -u lkbuild test -r /etc/lk-bridge/lk-bridge.env && echo "WRONG: lkbuild must not read it" || echo "good: lkbuild cannot read it"
```

## 7. The owner password ✋

**✋ Owner:** this prompts for the password (hidden) and offers an authenticator app (TOTP). It writes nothing to disk;
it prints lines for you to paste.

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run setup:owner
```

Paste the printed `OWNER_USERNAME=…` and `OWNER_PASSWORD_HASH='…'` lines (and `OWNER_TOTP_SECRET=…` if you enrolled
TOTP) into the env file with `sudoedit`, replacing the commented `# OWNER_PASSWORD_HASH=` line and keeping the single
quotes. Keep the password and the TOTP secret in your password manager; the bridge cannot recover them, only replace
them. Since OPS2 this is only the first password: at the first start it moves into the encrypted store, and from then on
you change it (and set up the authenticator app) on the dashboard's **Account** page
([The password and the authenticator](#the-password-and-the-authenticator)).

## 8. systemd units, the sudo rule and the deploy script

🔒 sudo

```bash
cd /opt/lk-bridge/app/deploy
sudo install -m 0644 lk-bridge.service lk-bridge-backup.service lk-bridge-backup.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/lk-bridge.service /etc/systemd/system/lk-bridge-backup.service /etc/systemd/system/lk-bridge-backup.timer
sudo systemctl daemon-reload
```

`verify` should print nothing. Then the sudo rule, validated **before** it goes live (the installed name must contain no
dot, or sudo ignores it):

```bash
sudo install -m 0440 -o root -g root sudoers.lk-bridge /etc/sudoers.d/lk-bridge.new
sudo visudo -cf /etc/sudoers.d/lk-bridge.new && sudo mv /etc/sudoers.d/lk-bridge.new /etc/sudoers.d/lk-bridge
sudo -u lkbridge sudo -n -l          # lists exactly: systemctl restart|stop|start|status lk-bridge
sudo -u lkbridge sudo -n /usr/bin/systemctl restart caddy && echo "WRONG: this must be refused" || echo "good: refused"
```

If `visudo -cf` reports an error, remove the `.new` file (`sudo rm /etc/sudoers.d/lk-bridge.new`) and stop; a broken file
in `/etc/sudoers.d` can lock you out of `sudo`.

`lkbuild` gets **no** sudo rule. Check:

```bash
sudo sudo -l -U lkbuild                # "User lkbuild is not allowed to run sudo on …"
```

Then install the deploy script where only root can change it (v1.0.1). It runs as root, so it must never be run from
the checkout, which `lkbuild` can change; it refuses to.

```bash
sudo install -o root -g root -m 0755 /opt/lk-bridge/app/deploy/deploy.sh /opt/lk-bridge/bin/deploy.sh
sudo install -o root -g root -m 0644 /opt/lk-bridge/app/deploy/lib.sh /opt/lk-bridge/bin/lib.sh
sudo install -o root -g root -m 0755 /opt/lk-bridge/app/deploy/env-sync.sh /opt/lk-bridge/bin/env-sync.sh
sudo install -o root -g root -m 0644 /opt/lk-bridge/app/deploy/env-sync.mjs /opt/lk-bridge/bin/env-sync.mjs
ls -l /opt/lk-bridge/bin                # all root root, none group- nor world-writable
```

From then on `deploy.sh` keeps these four files up to date itself, when you ask it to (`--update-self`, see
[Updating](#updating)).

## 9. Start it and check it locally

🔒 sudo

```bash
sudo systemctl enable --now lk-bridge
sudo systemctl status lk-bridge --no-pager
sudo journalctl -u lk-bridge -n 40 --no-pager
curl -s http://127.0.0.1:8787/healthz           # {"ok":true,"version":"1.0.1"}
sudo systemctl enable --now lk-bridge-backup.timer
systemctl list-timers lk-bridge-backup.timer --no-pager
```

What you should see in the journal: `LK-Bridge listening` with the MCP URL `https://lk.ottomoons.co.uk/mcp`. If it
fails instead:

| Journal shows                                         | Cause                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration: - LK_PROJECT_TEST_API_KEY: …` | a variable is blank or malformed; the message names the **variable**, never the value                                         |
| `Another LK-Bridge process (pid … on …) is serving`   | a second bridge process on the same database (exactly one may serve it, ADR 0023); stop the other one                         |
| `project stopped` (the bridge keeps running)          | that project's key was refused or belongs to another project; the Overview and Projects pages show why. The others are served |
| `status=226/NAMESPACE`                                | `/var/lib/lk-bridge` does not exist (step 2)                                                                                  |
| `status=203/EXEC`                                     | the private Node is missing or not executable (step 4)                                                                        |
| `EADDRINUSE`                                          | something else is on port 8787; find it with `sudo ss -ltnp \| grep 8787`                                                     |
| `Cannot find module …/dist/server.js`                 | the build did not run (step 5)                                                                                                |
| `unable to open database file`                        | `/var/lib/lk-bridge` is not owned by `lkbridge` or `DB_PATH` was changed to outside it                                        |

After editing the env file, apply it with `sudo systemctl restart lk-bridge`.

Make a first backup by hand to prove the path works:

```bash
sudo systemctl start lk-bridge-backup.service
sudo journalctl -u lk-bridge-backup -n 5 --no-pager
sudo ls -l /var/lib/lk-bridge/backups/
```

## 10. The Caddy site block

Caddy already serves other sites. We **append one block** and change nothing else. Make sure the DNS record from step 1
exists first, or Caddy cannot get the certificate (it will keep retrying, harmlessly).

🔒 sudo

```bash
dig +short A lk.ottomoons.co.uk                 # this server's public IPv4, and only that

sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
ls -l /etc/caddy/Caddyfile.bak-*

# Append the block (a blank line first). Nothing else in the file is modified.
sudo sh -c 'printf "\n" >> /etc/caddy/Caddyfile && cat /opt/lk-bridge/app/deploy/Caddyfile.lk-bridge >> /etc/caddy/Caddyfile'

sudo -u caddy caddy validate --config /etc/caddy/Caddyfile
```

If `validate` fails, put the backup back and stop:

```bash
sudo cp -a /etc/caddy/Caddyfile.bak-<the file you just made> /etc/caddy/Caddyfile
```

If it passes:

```bash
sudo systemctl reload caddy
sudo journalctl -u caddy -n 30 --no-pager        # look for: certificate obtained successfully (for lk.ottomoons.co.uk)
```

`reload` is graceful: the other sites keep serving. Before the reload, also look at the file once (`sudo less
/etc/caddy/Caddyfile`) and check that no shared snippet that turns on `encode` is imported into the new block; the block
as shipped imports nothing. If you ever need to undo this step, restore the backup and `reload` again.

## 11. Health check

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/healthcheck.sh        # 🔒 sudo
```

It first waits for the bridge to answer on `127.0.0.1:8787/healthz` (retrying every second for up to 30 seconds, so a
check straight after a restart does not report false failures) and prints one line saying how long it waited, for
example `Waited 3 s for the bridge to answer on 127.0.0.1:8787 (ready).` `--wait SECONDS` or `LKB_HEALTH_WAIT` changes the
30 seconds; `0` does not wait. A bridge that never answers is reported by the first check below.

Expected: twelve lines starting `PASS` and `All checks passed.`:

- the bridge answers on `127.0.0.1:8787/healthz`;
- six permission checks (v1.0.1): `lkbuild exists and is not in group lkbridge`, `lkbuild cannot read the secrets`,
  `lkbuild cannot read the database`, `lkbridge cannot write the app`, `lkbridge can read the app and the env file`,
  `the private Node … is root's and writable by neither user`. A FAIL names the path and the fix; an ACL on
  `/etc/lk-bridge` or `/var/lib/lk-bridge` is a FAIL too (check it by hand with `getfacl`);
- `POST https://lk.ottomoons.co.uk/mcp` gives **401** (not a redirect) with exactly
  `WWW-Authenticate: Bearer resource_metadata="https://lk.ottomoons.co.uk/.well-known/oauth-protected-resource/mcp"`;
- `/mcp/` does not redirect either;
- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` are 200 and JSON;
- `/ui` redirects to `/oauth/login`.

If the public checks cannot connect, but `curl -I https://lk.ottomoons.co.uk/ui` works from your own computer, the
server probably cannot reach its own public address; run it with `--via-loopback`. To check only the local port (for
example before step 10): `--local-only`.

Then, from **another machine**, work through section 1 of [auth-live-checklist.md](auth-live-checklist.md) (DNS,
no redirect on `/mcp`, discovery documents, latency, the client address in the log, `curl http://<public-ip>:8787/healthz`
must **fail**, the firewall, the clock) and sign in at <https://lk.ottomoons.co.uk/oauth/login> and
<https://lk.ottomoons.co.uk/ui>. Keep a second terminal on `sudo journalctl -u lk-bridge -f` throughout.

## 12. The sandbox script ✋

The sandbox script writes to LegendKeeper, so it runs only against a project **marked as a sandbox** in the bridge's
database: the test world, never Arkona or Baisheng. Mark it once, after the bridge has started and checked its key (step 9;
the Projects page then shows it). The flag can only be set here, from the server's shell, and the change is audited:

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- sandbox test on
```

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test
```

It needs no workaround (C2d, 11 November 2026): `lkbridge` cannot write to `node_modules` (the build user owns it), so
the sandbox config is loaded in memory (`--configLoader runner`) and Vitest's file caches are off; nothing is written
there. It no longer warns that `SECRETS_MASTER_KEY` is not set (the sandbox runtimes keep no secrets of their own).

The suite finds the project's key exactly as the bridge does (OPS2): the key kept in the bridge's encrypted store,
opened with `SECRETS_MASTER_KEY` from the env file, or, only when nothing is stored for the project, the env file's
`LK_PROJECT_TEST_API_KEY`. So it works after `env-sync.sh --retire-imported-keys` has commented the key lines out. The
wrapper exports only `DB_PATH` and the env file's path, never a key, and nothing prints one. The suite refuses a project
that is not marked as a sandbox, one with a key in neither place (add it on the dashboard's **Projects** page), and a key
whose own project (from `listProjects`) is not that project's stored id.

It uses its own temporary database, not the production one, and does not need the service stopped. Read the report at the
end (PASS / FAIL / INCONCLUSIVE / SKIPPED per item; see `test/sandbox/README.md`).

The sandbox files run **one after another** (`fileParallelism: false`, the owner's run of 12 November 2026: in parallel
they shared the test project's 120 writes a minute), and every script waits for a write the governor parks for budget or
queues, its clean-up included, rather than reporting it failed. The image pipeline alone (v2 D3; it writes, then deletes
what it made):

````bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- images
``` Keep the output for chunk 8's review.
This is the same as `npm run test:sandbox`, which on its own cannot read `/etc/lk-bridge/lk-bridge.env`: vitest does not
load env files and the file is not safe to `source`.

## 13. Connect Claude and ChatGPT ✋

Everything you check while connecting is listed in [auth-live-checklist.md](auth-live-checklist.md) (sections 2 to 9). The
short version:

**claude.ai (web, desktop, mobile)**

1. _Customize → Connectors → Add custom connector_.
2. URL `https://lk.ottomoons.co.uk/mcp` (exactly; it must not redirect). Authentication _Sign in now_.
3. OAuth client: _Use Claude's published identity_ (CIMD) or _Register automatically_ (DCR); the bridge supports both.
4. Your browser opens the bridge's sign-in and consent page. Sign in as owner. The page shows **claude.ai** as the
   destination, the profile (`claude`) and the scope; leave the scope at **read** for now. Approve.
5. In a chat, ask Claude to call `bridge_info`. Mobile can use the connector once it is added on web or desktop; it cannot
   add one.

**Claude Code**

```bash
# Option A, OAuth: add it, then run /mcp inside Claude Code and sign in.
claude mcp add --transport http lk-bridge https://lk.ottomoons.co.uk/mcp --scope user

# Option B, personal access token. Create the token on the server (shown once), then add it.
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run pat -- create --name "Claude Code" --profile claude-code --scope read   # 🔒 sudo
claude mcp add --transport http lk-bridge https://lk.ottomoons.co.uk/mcp --scope user -H "Authorization: Bearer <the token>"
````

The consent page for OAuth from Claude Code shows `localhost (this computer)` and a warning that the application only
accepts sign-ins on your own computer: that is expected. Treat a PAT like a password.

**ChatGPT** (Developer Mode, OAuth only): follow [auth.md › ChatGPT](auth.md#chatgpt-developer-mode), then section 9 of
the checklist. If registration is refused with "invalid redirect URI", the journal line `client.registration_rejected`
holds the exact URI: add it to `OAUTH_EXTRA_REDIRECT_URIS` in the env file, restart, and create the connector again.

Raise a profile's scope (to `propose` or `write`) on the dashboard under _Clients & Access_ when you are ready; section 10
of the checklist walks through it against the sandbox project.

## 14. Going live ✋

Follows PLAN §9.7. The bridge starts read-only (`LK_READ_ONLY=true`, `WRITERS_MAX=1`).

1. Run the sandbox script and the checklist sections against the **test** project first (agents pass
   `project: "test"`; with one project they may leave it out).
2. Add the real project as a further project ([Adding a project](#adding-a-project)) and switch on its **Read-only** flag
   on the Projects page while ChatGPT finishes its maintenance on the repository. Two writers on one project would contend
   for versions and for the shared project rate tier; and never give one project's key to two bridges (ADR 0023).
3. When that maintenance is over, revoke the old bridge's LegendKeeper key, then set `LK_READ_ONLY=false` in the env file
   and `sudo systemctl restart lk-bridge`, and switch the project's own Read-only flag off. Keep `WRITERS_MAX=1` for the
   first week.

---

## Updating

As root, from the installed copy (v1.0.1; `sudo -u lkbridge …/deploy.sh` was the 1.0.0 way and now refuses):

```bash
sudo /opt/lk-bridge/bin/deploy.sh          # 🔒 sudo
```

Root only orchestrates; every step runs as the user it needs, with an empty environment (`runuser … env -i`): git,
`npm ci` and the build as **`lkbuild`**; the backup, the migrations and the health check as **`lkbridge`**; the stop and
start through `lkbridge`'s sudo rule. What it does, in order (it stops at the first problem and says what to do):

1. **Pre-flight, nothing changed yet:** it runs as root from `/opt/lk-bridge/bin` (root's, not writable by others), both
   users exist, `lkbuild` owns the app, is not in group `lkbridge` and **cannot read the env file**, the private Node is
   root's, `lkbridge` can read the env file, the checkout has **no local changes or untracked files** (otherwise it
   refuses and lists them), the sudo rule works, and `origin/main` is a **fast-forward** of what is checked out
   (otherwise it refuses). Then two comparisons with the release it is about to deploy (OPS1):
   - **the installed deploy scripts** (`deploy.sh`, `lib.sh`, `env-sync.sh`, `env-sync.mjs` in `/opt/lk-bridge/bin`)
     against the release's own copies. If they differ it shows the difference in full (these files hold no secrets) and
     stops, so an outdated script is never used for a release that needs the new one. Read the difference, then run the
     same command again with `--update-self`: it asks, installs the release's copies (root:root, 0755 and 0644) and
     runs the new `deploy.sh` with the same options. With `--current` (a rollback, usually to an older commit) a
     difference is only a warning, so a rollback never downgrades the scripts by surprise.
   - **the env file** against the release's `deploy/env.template`, with `env-sync.sh --check` (names only, never a
     value). If they differ it stops and prints the exact command to run: the same deploy with `--sync-env`. A secret
     only you can supply (a new key, say) always stops it with **`ACTION NEEDED`**; see
     [Updating the env file](#updating-the-env-file).

   If there is nothing new it says so and exits (`--force` redeploys anyway).

2. **Drains and stops** the service: `systemctl stop lk-bridge` (as `lkbridge`, through sudo). This is the drain. SIGTERM makes the bridge stop
   taking new work and give running jobs up to 20 seconds to finish; the unit allows 45 seconds before killing it. A job
   still unfinished then is picked up again by the engine's start-up recovery when the service starts. (The admin API could
   drain without stopping, but it accepts only your browser session and a script has none; see ADR 0015. For a gentler
   hand-over, press _Drain_ on the dashboard's Writers page before you start.)
3. Takes a **`pre-deploy` backup** of the database (kept: the newest 5), as `lkbridge`.
4. As `lkbuild`: `git merge --ff-only`, `npm ci`, `npm run build`; then checks that **nothing in the app is writable by
   `lkbridge`**. With `--sync-env`, env-sync updates the env file now (backup first). Then the **boot check**: the new
   build's own configuration check (`npm run config:check`) on the env file, as `lkbridge`, with no database and no
   network. If it fails, an env-sync edit is undone from its backup and the deploy stops **before** the migrations and
   the start. Then, as `lkbridge`, the **database migrations**.
5. **Starts** the service (as `lkbridge`, through sudo) and waits up to 60 seconds for `/healthz`.
6. Runs `healthcheck.sh` as `lkbridge` (with the permission checks) and prints **`DEPLOY SUCCEEDED`** or
   **`DEPLOY FAILED`**.

Expect about a minute of downtime. If a step fails **before the checkout changes** (a dirty tree, a failed backup), the
previous version is started again for you. If it fails after, the service stays **stopped** and the message gives the exact
rollback command. If only a check **after** the start fails (the health check), the new version keeps running and the
message says so.

Options: `--current` (deploy the checked-out commit without fetching; used for rollback), `--force`, `--local-health`
(skip the public checks), `--sync-env` (update the env file instead of stopping), `--update-self` (install the release's
deploy scripts, and the systemd unit, instead of stopping), `--yes` (answer the questions `--sync-env` and
`--update-self` ask).

**The systemd unit with `--update-self`.** If `/etc/systemd/system/lk-bridge.service` differs from the release's
`deploy/lk-bridge.service`, `--update-self` shows the difference and asks. On a yes, just before the service is started
again (after the migrations, so a deploy that fails earlier leaves the unit as it was), it backs the installed unit up
as `lk-bridge.service.bak.<UTC time>` beside it, installs the release's (`root:root`, `0644`), and runs
`systemctl daemon-reload`; the deploy's own start then uses the new unit. If the code is already at `origin/main` but
the unit differs, the service is still restarted to apply it. A unit that is not installed is not installed by the
deploy. Without `--update-self` the script only warns at the end, as before.

**Env drift warnings (chunk 8).** `healthcheck.sh` still compares the env file with the checkout's `deploy/env.template`
by name and prints a `WARNING:` line (never a value; never a failure) for each difference; since v2 A1 the project
variables follow their own rules there too. `deploy.sh` no longer prints these warnings: it runs env-sync against the
release being deployed instead (above).

The sudoers file, the Caddy block and the backup unit and timer are **not** updated by `deploy.sh` (the main unit
`lk-bridge.service` is, with `--update-self`: above). If a release changes one, the
script warns after a successful deploy ("… differs from deploy/…"); an administrator then repeats step 8 (and
`sudo systemctl restart lk-bridge`) or step 10 for that file. To upgrade Node:
`sudo NODE_VERSION=v24.x.y /opt/lk-bridge/app/deploy/install-node.sh`, then `sudo systemctl restart lk-bridge`.

## Updating the env file

`/etc/lk-bridge/lk-bridge.env` is kept in step with each release's `deploy/env.template` by **env-sync** (OPS1,
[ADR 0024](adr/0024-env-sync.md)), so nobody edits secrets by hand except to paste one only they have. Every deploy
checks it (`--check`, above); you can also run it on its own (🔒 sudo):

```bash
sudo /opt/lk-bridge/bin/env-sync.sh --check
```

```bash
sudo /opt/lk-bridge/bin/env-sync.sh
```

The first only reports (exit status 0 in step, 1 changes needed, 2 error). The second shows the same summary and asks
before it writes. Each variable in the template carries a marker that says what env-sync may do when your file lacks it:

| Marker                | What env-sync does when the variable is missing                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@default`            | adds it with the template's value and comment                                                                                                                                                                                       |
| `@generate:<enc>:<n>` | adds it with a new random value (`SESSION_SECRET`, `JWT_SIGNING_KEY`, `SECRETS_MASTER_KEY`), and fills a blank line in; never shown. A new `SECRETS_MASTER_KEY` is refused while the database holds secrets sealed with the old one |
| `@secret`             | adds a commented-out placeholder and prints **`ACTION NEEDED: fill in X`**; it never invents one                                                                                                                                    |
| `@optional`           | adds it commented out, with its default                                                                                                                                                                                             |
| (no longer listed)    | a variable your file sets that the template no longer lists is commented out with a dated note; never deleted                                                                                                                       |

A value already in your file is **never changed** (only `--migrate-projects`, below, moves the key to its new name;
OPS2's `--retire-imported-keys` comments out values the bridge keeps in its encrypted store, and `--rotate-master-key`
moves the master key aside: [Managing projects from the dashboard](#managing-projects-from-the-dashboard-ops2)). The
summary names variables only, never a value: not one it read, moved or generated. Before writing, it makes a backup
beside the file (`lk-bridge.env.bak.<UTC time>`, same owner, group and mode), writes the new file beside it and renames
it over the old one, keeping `root:lkbridge 0640`. Then it runs the bridge's own configuration check as `lkbridge`; if
the edit made the file invalid, it puts the backup back and says so. Restart to use the new settings
(`sudo systemctl restart lk-bridge`); a deploy with `--sync-env` does that for you.

**ACTION NEEDED.** For a secret only you can supply, env-sync adds a commented-out line at the end of the file, for
example `# LK_PROJECT_ARKONA_API_KEY=`. Open the file with `sudoedit /etc/lk-bridge/lk-bridge.env`, remove the `# ` and
paste the value after the `=`. A required secret stops every deploy until it is filled in; an optional one (the TOTP
secret, say) stops only the deploy that first adds its placeholder.

Old backups are not removed automatically; once a change has proved itself, delete the ones you no longer need (🔒 sudo):

```bash
sudo ls -l /etc/lk-bridge/
```

## Backups and restore

- **What:** `lk-bridge-backup.timer` runs `deploy/backup.sh nightly` at **04:15 Europe/London** (a missed run happens
  after the next boot). `sqlite3 .backup` takes a consistent snapshot while the bridge is running, the copy must pass
  `PRAGMA integrity_check`, and it is compressed to `/var/lib/lk-bridge/backups/nightly-<UTC time>.db.gz` (mode 0600). The
  **newest 14** are kept. `deploy.sh` adds `pre-deploy-…` copies (newest 5, separate, so deploys never push out nightlies).
- **Check:**

  ```bash
  systemctl list-timers lk-bridge-backup.timer --no-pager
  sudo journalctl -u lk-bridge-backup -n 20 --no-pager
  sudo ls -lh /var/lib/lk-bridge/backups/
  sudo systemctl start lk-bridge-backup.service        # a backup right now
  ```

````

- **Off the server:** the backups sit on the same disk as the database. Copy them somewhere else now and then, from your
  own computer: `scp` or `rsync` of `/var/lib/lk-bridge/backups/` (they are readable only by `lkbridge` and root, so copy
  with `sudo`, or add a pull job under your own account). They hold token hashes and the proposals and journal data:
  treat them as sensitive.
- **Test a backup without touching production** (as `lkbridge`):

  ```bash
  sudo -u lkbridge sh -c 'gunzip -c /var/lib/lk-bridge/backups/<file>.db.gz > "$HOME/restore-test.db" && sqlite3 "$HOME/restore-test.db" "PRAGMA integrity_check; SELECT count(*) FROM schema_migrations;"; rm -f "$HOME/restore-test.db"'
  ```

- **Restore** (the bridge must be stopped; this replaces the live database, and anything written since the backup is
  lost). `restore.sh` (chunk 8) does the steps below in the safe order and is covered by a test
  (`test/unit/backup-restore.test.ts` backs up a live WAL database, restores it, and checks it):

  ```bash
  sudo systemctl stop lk-bridge
  sudo ls -l /var/lib/lk-bridge/backups/                                              # choose the file
  sudo -u lkbridge /opt/lk-bridge/app/deploy/restore.sh /var/lib/lk-bridge/backups/<file>.db.gz
  sudo systemctl start lk-bridge
  sudo -u lkbridge /opt/lk-bridge/app/deploy/healthcheck.sh
  ```

  It refuses while the service is running; unpacks the backup and checks it (`integrity_check`, and that it is a bridge
  database) **before** touching anything; moves the current `bridge.db` **and** its `-wal` and `-shm` files into
  `/var/lib/lk-bridge/restore-aside-<UTC time>/` (a stale `-wal` next to a restored database would corrupt it); then puts
  the backup in place with mode 0600. Nothing is deleted: remove the `restore-aside-…` directory when you are sure. A
  backup from an older release is fine: the bridge applies the missing migrations when it starts.

## Rollback

Each deploy prints the previous commit. To go back (🔒 sudo):

```bash
sudo -u lkbuild git -C /opt/lk-bridge/app log --oneline -10                  # find the commit to return to
sudo -u lkbuild git -C /opt/lk-bridge/app checkout --detach <commit>
sudo /opt/lk-bridge/bin/deploy.sh --current --force
```

This builds and starts exactly that commit, with the same drain, backup and health checks. To move forward again:
`sudo -u lkbuild git -C /opt/lk-bridge/app checkout main`, then run `deploy.sh` as usual (while the checkout is on a
detached commit, plain `deploy.sh` refuses and says why). The installed copy in `/opt/lk-bridge/bin` is the one that
runs, so rolling back to a commit from before v1.0.1 still deploys with the two users; that release's health check simply
has no permission checks.

**Migrations are not reversed.** If the release you are leaving changed the database schema, an older build may refuse to
start on it. Then restore the `pre-deploy-…` backup taken just before that release (see "Restore"; changes made since
are lost), and deploy the older commit.

Release 1.0.0 (chunk 8) adds one migration, `0201_journal_every_write.sql`: new indexes and one new table, nothing
removed or renamed. An older build runs on a 1.0.0 database unchanged (it ignores the table and indexes), so rolling
back from 1.0.0 needs **no** restore; the journal entries 1.0.0 wrote for non-destructive writes simply stay.

Release 1.0.1 adds one migration, `0500_governor_counters.sql`: one new table (the governor's saved counts), nothing
removed or renamed. 1.0.0 ignores it, so rolling back from 1.0.1 needs **no** restore either. (1.0.1's
`proposal-prune` job deletes old finished proposals; a rollback does not bring them back.)

v2 A1 adds `0600_projects.sql`, which **rebuilds** every table holding LegendKeeper data with a required `project_id`.
Releases before it cannot run on the result, so rolling back from v2 A1 **needs the restore** of the `pre-deploy` backup
taken just before it (put the env file's single-project lines back first: [Moving to several projects
(v2 A1)](#moving-to-several-projects-v2-a1), "Going back").

## Logs and useful commands

The bridge logs JSON lines (pino) to the journal. Reading the journal needs `sudo` or membership of the
`systemd-journal` group.

```bash
sudo journalctl -u lk-bridge -f                              # follow
sudo journalctl -u lk-bridge -n 200 --no-pager               # the last 200 lines
sudo journalctl -u lk-bridge --since "1 hour ago" --no-pager
sudo journalctl -u lk-bridge -p warning --no-pager           # warnings and errors only
sudo journalctl -u lk-bridge -o cat | grep '"auth '          # sign-in and token events
sudo journalctl -u lk-bridge -o cat | grep -E 'lkb_(rt|ac|pat|cs)_|eyJ[A-Za-z0-9_-]+\.eyJ'   # must print nothing (no secret in the log)
sudo journalctl -u lk-bridge --list-boots | tail -3
sudo journalctl -u caddy -n 100 --no-pager                   # certificates, proxy errors
sudo journalctl -u lk-bridge-backup -n 20 --no-pager         # the nightly backup

sudo systemctl status lk-bridge --no-pager
sudo systemctl restart lk-bridge
sudo systemctl reset-failed lk-bridge                        # after five quick failures systemd stops retrying
systemctl show lk-bridge -p MainPID -p MemoryCurrent -p NRestarts
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run pat -- list
```

Caddy's own log goes to its journal. The bridge's request log keeps paths only (no query strings, no headers): one
`request completed` line per request it serves, at info. Requests for paths it does not serve (the internet scanners
probing `/info.php`, `/actuator/env`, `/wp-login.php`…) get a plain 404 and are logged at **debug** only, so they do not
appear with the default `LOG_LEVEL=info` (chunk 8). Auth events keep their levels.

| Symptom                                                      | Look at                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `502` from the public URL                                    | the bridge is down: `systemctl status lk-bridge`, then its journal                                                                              |
| Certificate error on the new name                            | DNS not pointing here yet, or ports 80/443 blocked: `journalctl -u caddy`                                                                       |
| Claude cannot connect, "redirect" or "401 without header"    | `healthcheck.sh` (a failing line names the cause); then checklist section 1                                                                     |
| Everyone locked out of sign-in at once                       | the log shows `127.0.0.1` as the client: `TRUST_PROXY` or Caddy's forwarding (checklist 1.7)                                                    |
| Dashboard live data stalls                                   | something is buffering `/api/admin/stream`: the Caddy block must be exactly as shipped (no `encode`)                                            |
| `deploy.sh` says the checkout has local changes              | something edited files under `/opt/lk-bridge/app`; `sudo -u lkbuild git -C /opt/lk-bridge/app status`, then restore or remove them as `lkbuild` |
| `deploy.sh` says "Run this as root, from the installed copy" | since v1.0.1: `sudo /opt/lk-bridge/bin/deploy.sh` (not `sudo -u lkbridge …`, not the copy in the checkout)                                      |
| a health-check permission line FAILs                         | it names the path and the fix; then run the health check again                                                                                  |

## Soak test ✋

PLAN §9.7 and §10: about 1,000 writes and a matching mix of reads against the **test world**, through the bridge's real
engine and governor, to show that the pacing holds and LegendKeeper never answers 429. Run it before go-live and after any
change to the governor. It takes about 20 to 25 minutes for 1,000 writes: the governor allows 120 writes a minute, but
stretches to one every 1.2 s (50 a minute) while the hour is on course for more than 3,000 (PLAN §5.2), which a soak
always is after its first minute.

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/soak-sandbox.sh --project test --writes 100   # a quick run first (about 3 minutes)
sudo -u lkbridge /opt/lk-bridge/app/deploy/soak-sandbox.sh --project test                # the full soak, about 1,000 writes
```

- `--project` names a project the bridge serves **and that is marked as a sandbox** (step 12: `npm run projects -- sandbox
test on`); the soak refuses any other, and any key whose own project (from `listProjects`) is not that project's stored
  id. The key is found as for step 12 (the encrypted store first, the env file's key only when nothing is stored); the
  wrapper exports only `DB_PATH` and the env file's path, and nothing prints a key. Note (ADR 0020): this and
  `sandbox-test.sh` still run Vitest and tsx (development tools) as `lkbridge`, which can read the whole env file; run them
  only when you mean to.
- The bridge serves the same project with the same key, so the soak and the bridge share that project's rate budget: run
  the soak while nothing else is using the test project, or a busy bridge would slow the soak and could cost it the
  zero-429 result. Other projects' budgets are not touched. (`--allow-bridge-project`, `LK_SANDBOX_API_KEY` and
  `LK_SANDBOX_PROJECT_ID` are gone since v2 A1.)
- Everything is created under **one** throwaway root resource (`lk-bridge soak <time>`), which is deleted (cascade) at
  the end, whatever happens; if that fails the report names the root to delete by hand in LegendKeeper. It uses its own
  temporary database, never `bridge.db`, and does not need the service stopped.
- The report: total time, the write phase and **writes per minute** achieved, HTTP responses by status, **429 responses
  (target 0)**, retries, budget waits, job steps succeeded or failed, **peak memory** (RSS, V8 heap, buffers) and the
  clean-up. Exit code 0 means PASS (no 429, no failed step, cleaned up). Keep the output for the next review.
- Without the wrapper: `DB_PATH=… LK_PROJECT_TEST_API_KEY=… npm run soak:sandbox -- --project test --writes 100`, or
  `LKB_ENV_FILE=<env file>` in place of the key to find it as the bridge does (from a
  checkout with dependencies installed and a database that has the project marked as a sandbox; never on a shared
  screen).

## v2 phase 0 spike ✋

A one-off check of the assumptions in `docs/PLAN-v2.md` against the **test world** (PLAN-v2, section 6, session 0): the
results settle its "to verify" items before any v2 code is built on them. Run it after deploying this version, send the
report back, then you will not need it again. It makes roughly 100 to 250 LegendKeeper requests (about 35 of them list
the whole project; the asset folder walk is the unknown, one request per folder at most, capped at 600) and takes
about 2 to 5 minutes. Only the first check writes, three or four requests, under one throwaway resource that is
deleted at the end.

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/spike-v2.sh --project test
```

- `--project` names a project marked as a sandbox, as for the soak (step 12); it **refuses** any other, and any key whose
  own project is not that project's stored id. The key is found as for step 12 (the encrypted store first); nothing
  prints it. It shares that project's rate budget with the bridge (its reads run at the lowest priority, but run it
  while the bridge is quiet).
- **What it writes:** the report on screen (stdout; progress is on stderr), and the same report to
  `/var/lib/lk-bridge/spike/spike-v2-<timestamp>.md`, with the calendar oracle beside it as
  `spike-v2-<timestamp>-oracle.json`. Send back the `.md` file (and the `.json`). Nothing goes to `bridge.db`; the script uses a temporary
  database.
- **Writes:** check 1 creates one resource named `lk-bridge spike <time>` with three children under it, and deletes it
  (cascade) at the end of the check. If the delete fails the report says **NOT DELETED** with the id to delete by
  hand, and the exit code is 1. `--skip 1` makes the whole run read-only.
- Useful flags (after the wrapper's own): `--skip 1,3` leaves checks out, `--sample-lines 80` allows longer samples,
  `--rare-query TEXT` and `--common-query TEXT` choose check 2's queries, and `--root`, `--chronology`, `--main-doc`,
  `--table-doc`, `--timeline-doc` and `--calendar` replace the known test-world ids. `npm run spike:v2 -- --help` lists them
  all. Ctrl-C stops after the current call and still deletes the throwaway resource.
- Exit code: 0 when the report was produced (a FAIL is a finding, not a fault), 1 when the clean-up failed or the report
  file could not be written, 2 when it refused to run.

## Browser smoke test

`npm run test:e2e` drives the real dashboard in Chromium against a real bridge on a **mock** LegendKeeper, with throwaway
secrets (docs/dashboard.md). It does not use the live server or its database, so run it on your own computer, not on the
server (which has no browser and should not get one):

```bash
git clone git@github.com:Airwolf1221/LK-Bridge.git && cd LK-Bridge && npm ci
npx playwright install chromium        # once
npm run test:e2e                       # four checks: sign-in under the CSP, live pages, a proposal diff, a phone layout
```

If Playwright cannot find its browser, point it at any Chromium with `CHROMIUM_PATH=/path/to/chrome npm run test:e2e`.
Running these checks against the live dashboard is not practical: they sign in with a test password, create proposals
and tokens, and start jobs, which must not happen on the real database. Check the live dashboard by hand instead (sign
in, open each page, watch a job on the Jobs page).

## Memory

The unit sets `MemoryHigh=1400M` (the kernel starts reclaiming), `MemoryMax=1536M` (the hard ceiling) and
`NODE_OPTIONS=--max-old-space-size=700` (the V8 heap ceiling, so a runaway fails inside Node with a clear "heap out of
memory" error and a restart, before the kernel kills it). They are consistent: 700 MB of heap plus young generation, code
and buffers outside the heap (image uploads), plus one image conversion (v2 D3: sharp works in native memory outside the
heap, about 0.5 GiB at its peak for an image at the 100-megapixel limit, `IMAGE_MAX_PIXELS`; conversions run one at a
time) stays under 1400 MB. They were 900M and 1G before v2 D3; a normal deploy installs the new unit (the deploy script
compares it, backs up the old one and runs `daemon-reload`). The bridge needs far less (see the review report,
docs/review/2026-11-hardening.md, item 15, for the soak measurement), so the ceilings are generous on purpose; leave them
unless the measurements below say otherwise.

Watch the real use:

```bash
systemctl show lk-bridge -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax      # bytes; MemoryPeak since start
sudo journalctl -u lk-bridge --since "7 days ago" | grep -iE 'heap out of memory|oom' # must print nothing
ps -o rss=,vsz= -p "$(systemctl show lk-bridge -p MainPID --value)"                   # RSS in KiB, right now
```

If `MemoryPeak` over a busy week (with images converted) stays well below 1 GB, there is no need to change anything. If
it approaches 1400 MB, look for a cause before raising anything; lowering `IMAGE_MAX_PIXELS` (for example to 50000000)
lowers a conversion's peak in proportion.

## Images (v2 D3)

[ADR 0041](adr/0041-image-pipeline.md); tools in [tools.md](tools.md#images-v2-d3); the Staging page in
[dashboard.md](dashboard.md#staging-v2-d3).

**What the server needs: nothing beyond a normal deploy.**

- **sharp** (0.35.5, pinned) comes with `npm ci` as `lkbuild`: its prebuilt binary for linux-x64 (`@img/sharp-linux-x64`
  and `@img/sharp-libvips-linux-x64`, glibc 2.26 or later; Ubuntu has it) is an optional dependency in the lockfile, the
  package has no install script, so no compiler, no build tools and no extra download host are needed. Check it after a
  deploy with:

  ```bash
  sudo -u lkbridge /opt/lk-bridge/runtime/node/bin/node -e "console.log(require('/opt/lk-bridge/app/node_modules/sharp').versions)"
  ```

- **The image directory** is `images/` next to the database the bridge is running on
  (`/var/lib/lk-bridge/images`, mode 0700, owned by `lkbridge`, files 0600, inside the unit's only writable path). It is
  created on first use, not at start-up (ADR 0041, the image directory), so it does not exist until the first binary upload
  or kept file: `upload-tmp/` (the binary endpoint's temporary files: emptied at every start, swept every minute, a file lives
  at most 15 minutes) appears with the first upload, `kept-bytes/` (the bytes of deleted assets, 90 days) with the first
  deleted image. `IMAGE_DATA_DIR` moves it (it must stay inside
  `ReadWritePaths`). It is not in the nightly SQLite backup; E1's backups will take `kept-bytes/`.
- **The memory limits** of the unit are raised (above, "Memory"); the deploy installs them.
- **New settings**, all optional with sensible defaults (env.template, "Images"): `IMAGE_MAX_PIXELS`, `IMAGE_MAX_FRAMES`,
  `IMAGE_CONVERT_TIMEOUT_MS`, `IMAGE_CONVERT_CONCURRENCY`, `IMAGE_DATA_DIR`, `IMAGE_UPLOAD_RATE_PER_PRINCIPAL`,
  `IMAGE_UPLOAD_RATE_PER_IP`, `IMAGE_UPLOAD_BODY_TIMEOUT_MS`, `IMAGE_UPLOAD_IDLE_TIMEOUT_MS`,
  `IMAGE_STAGING_REPORT_DAYS`, `ASSET_BYTES_RETENTION_DAYS`, `LK_ASSET_HOSTS`; and one project setting,
  `imageStagingFolder` (Projects page). `env-sync` adds them to the env file commented out, as usual.
- **Caddy: no change.** The site block proxies every path, `POST /uploads/*` included, and sets no `request_body`
  limit, so a large binary upload reaches the bridge as it is; the bridge applies its own limits on that route (the
  declared length, the time limits). `flush_interval -1` is fine for it. Caddy's access log records the path
  (`/uploads/upl_…`, an id, not a secret); the capability travels in the `Authorization` header, which Caddy does not
  log by default. If the Caddyfile ever gains a `request_body { max_size … }`, it must allow at least `UPLOAD_MAX_BYTES`
  on `/uploads/*`.
- **Outbound:** the bridge now also downloads asset files from `assets.legendkeeper.com` (anonymous GET, port 443) to
  verify uploads and to keep bytes before deletes. Nothing to open if outbound https already works.

After the deploy, refresh ChatGPT's tools (Plugins → the bridge → Refresh) and disconnect and reconnect the connector on
claude.ai: two new tools, `upload_image` and `prepare_image_upload`.

## Moving to several projects (v2 A1)

Since v2 A1 one bridge serves several LegendKeeper projects, each with its own key ([projects.md](projects.md),
[ADR 0023](adr/0023-project-model.md)). The release adds migration **`0600_projects.sql`**, which gives every stored row a
project and assigns all existing rows (jobs, journal, proposals, errors, budget history, mappings, maintenance runs, the
governor's saved counts) to the project the bridge serves today: the one in `LK_PROJECT_ID`, named `test` (or
`LK_PROJECT_NAME` if your file sets it). So **deploy first, with the env file as it is, then migrate the file.** Since
OPS1, env-sync migrates it for you; nothing below prints a key, and nobody copies one by hand.

The live file today has the single-project form: `LK_API_KEY` and `LK_PROJECT_ID` (the test world, PLAN amendment 6), and
`LK_SANDBOX_API_KEY` / `LK_SANDBOX_PROJECT_ID`.

1. **Deploy** as usual (🔒 sudo). `deploy.sh` takes its `pre-deploy` backup, then migrates the database.

   ```bash
   sudo /opt/lk-bridge/bin/deploy.sh
   ```

   An installed deploy script from before OPS1 deploys as it always did and ends with a warning that the installed
   `deploy.sh` and `lib.sh` differ: install the new ones in step 2. (The migration reads `LK_PROJECT_ID` and
   `LK_PROJECT_NAME`, those two names only, from the env file if the script does not pass them, and says so.) An
   installed script from OPS1 on checks the env file first: the single-project form is only a note there, not a stop;
   if it stops for anything else, run what it prints (the same command with `--sync-env`). The bridge starts in the
   single-project form and logs a warning that names the variables to move to.

2. **Install the deploy scripts, the first time only** (🔒 sudo). They run as root, so read them first. From then on,
   `deploy.sh` compares them with each release itself and installs new ones with `--update-self`.

   ```bash
   diff /opt/lk-bridge/bin/deploy.sh /opt/lk-bridge/app/deploy/deploy.sh
   ```

   ```bash
   diff /opt/lk-bridge/bin/lib.sh /opt/lk-bridge/app/deploy/lib.sh
   ```

   ```bash
   less /opt/lk-bridge/app/deploy/env-sync.sh /opt/lk-bridge/app/deploy/env-sync.mjs
   ```

   ```bash
   sudo install -o root -g root -m 0755 /opt/lk-bridge/app/deploy/deploy.sh /opt/lk-bridge/bin/deploy.sh
   ```

   ```bash
   sudo install -o root -g root -m 0644 /opt/lk-bridge/app/deploy/lib.sh /opt/lk-bridge/bin/lib.sh
   ```

   ```bash
   sudo install -o root -g root -m 0755 /opt/lk-bridge/app/deploy/env-sync.sh /opt/lk-bridge/bin/env-sync.sh
   ```

   ```bash
   sudo install -o root -g root -m 0644 /opt/lk-bridge/app/deploy/env-sync.mjs /opt/lk-bridge/bin/env-sync.mjs
   ```

3. **Migrate the env file** (🔒 sudo):

   ```bash
   sudo /opt/lk-bridge/bin/env-sync.sh --migrate-projects
   ```

   It shows what it will do, by name, and asks first:

   | Change                                                                 | Line(s)                                                                     |
   | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
   | **moves** the key: the line is renamed in place, its value untouched  | `LK_API_KEY=…` becomes `LK_PROJECT_TEST_API_KEY=…`                          |
   | **adds**, just above it                                                | `LK_PROJECTS=test`, `LK_DEFAULT_PROJECT=test`                               |
   | **comments out**, with a "migrated" note (the id is now learned from the key and stored; the sandbox settings are retired) | `LK_PROJECT_ID`, `LK_PROJECT_NAME`, `LK_SANDBOX_API_KEY`, `LK_SANDBOX_PROJECT_ID` |

   If your file sets `LK_PROJECT_NAME`, that name (lower-cased) is used instead of `test`. In the same pass it brings
   the rest of the file in step with the template, as in [Updating the env file](#updating-the-env-file) (for example
   `# REQUIRE_PROJECT_FOR_WRITES=true`, commented out). It backs the file up first, then runs the bridge's configuration
   check as `lkbridge` (which also checks the moved key's format, without calling LegendKeeper); if that fails it puts
   the backup back. It **refuses**, changing nothing, if the file is in a mixed or unexpected state: both forms at once
   (`LK_PROJECTS` and `LK_API_KEY`), a `LK_PROJECT_<NAME>_API_KEY` line without `LK_PROJECTS`, a variable set twice,
   an empty key, or an `LK_DEFAULT_PROJECT` that names another project; the message says which. Running it again
   changes nothing. Check by name only (🔒 sudo):

   ```bash
   sudo grep -oE '^LK_[A-Z0-9_]+=' /etc/lk-bridge/lk-bridge.env
   ```

   It should list `LK_PROJECTS=`, `LK_DEFAULT_PROJECT=`, `LK_PROJECT_TEST_API_KEY=`, `LK_READ_ONLY=` and
   `LK_ALLOW_MEMBER_ADMIN=`, and none of `LK_API_KEY=`, `LK_PROJECT_ID=`, `LK_SANDBOX_…`.

4. **Restart and check** (🔒 sudo):

   ```bash
   sudo systemctl restart lk-bridge
   ```

   ```bash
   sudo -u lkbridge /opt/lk-bridge/app/deploy/healthcheck.sh
   ```

   The journal no longer shows the single-project warning, and the health check's drift check is quiet about project
   variables. On the dashboard, **Projects** shows `test` as default, key valid, active, with the same LegendKeeper id as
   before (the key proved it); its jobs, journal and proposals are all there under the project switcher's `test`. If the
   project shows **stopped**, the reason says why; the bridge keeps running.

5. **Mark the test world as the sandbox** (once; the sandbox, soak and spike scripts refuse every other project;
   🔒 sudo):

   ```bash
   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- sandbox test on
   ```

   From now on the scripts take `--project test` (sections 12, [Soak test](#soak-test-), [v2 phase 0
   spike](#v2-phase-0-spike-)); `--allow-bridge-project` is gone.

6. In Claude or ChatGPT, `list_projects` shows `test`. With one project, agents may leave `project` out; once a second
   project is added, every write must name its project.

**Going back.** Until step 3 nothing in the env file has changed. After it, env-sync's backup is beside the file
(`ls -l /etc/lk-bridge/`): put it back and restart, and you are at step 1's state (the single-project form still works):

```bash
sudo install -o root -g lkbridge -m 0640 /etc/lk-bridge/lk-bridge.env.bak.<time> /etc/lk-bridge/lk-bridge.env
```

Going back to a release before A1 needs the `pre-deploy` backup of step 1 (see [Rollback](#rollback)).

### Adding a project (the env-file way)

Since OPS2 the dashboard is the way to add a project ([Managing projects from the dashboard](#managing-projects-from-the-dashboard-ops2)):
nothing to edit, nothing to restart. The env-file way still works; a key added this way is imported into the encrypted
store at the next start.

1. Choose a name (a lowercase letter, then lowercase letters, digits or `_`), for example `arkona`.
2. In the env file add the name to `LK_PROJECTS` (`LK_PROJECTS=test,arkona`) and a line `LK_PROJECT_ARKONA_API_KEY=` with
   its key (or add only the name, then let `sudo /opt/lk-bridge/bin/env-sync.sh` add a commented-out placeholder for the
   key and say `ACTION NEEDED`). With two projects `LK_DEFAULT_PROJECT` is required: reads without `project` go there.
3. `sudo systemctl restart lk-bridge`. The bridge checks the new key, learns and stores the project's id, and shows it on
   the Projects page. Switch its **Read-only** flag on there first if it should not be written to yet.
4. Never mark a live world as a sandbox, and never put one project's key in two bridges' env files (ADR 0023).

## Managing projects from the dashboard (OPS2)

Since OPS2 ([ADR 0028](adr/0028-secrets-on-the-dashboard.md)) projects, their API keys, the owner password and the
authenticator app are managed on the dashboard. The keys are kept **encrypted in the bridge's database**
(AES-256-GCM) under `SECRETS_MASTER_KEY`, which env-sync generates; the env file keeps only the bootstrap secrets
(`SESSION_SECRET`, `JWT_SIGNING_KEY`, `SECRETS_MASTER_KEY`). Adding, replacing or removing a key, and changing the
password or the authenticator, ask for your password (and authenticator code) again if you have not confirmed it in the
last five minutes.

### The first deploy of this release ✋

1. **Deploy, letting env-sync add the master key** (🔒 sudo). env-sync generates `SECRETS_MASTER_KEY` (never shown).
   It refuses to make a new one if the database already holds encrypted secrets, so it can never lock existing ones
   away.

   ```bash
   sudo /opt/lk-bridge/bin/deploy.sh --sync-env
   ```

   (If the deploy first says its installed scripts differ, read the difference, then run the same command with
   `--update-self` too.) At its first start the bridge imports every key in the env file
   (`LK_PROJECT_<NAME>_API_KEY`), and `OWNER_PASSWORD_HASH` and `OWNER_TOTP_SECRET`, into the encrypted store, once.
   The log names each variable imported, never a value:

   ```bash
   sudo journalctl -u lk-bridge --since "10 min ago" | grep -i imported
   ```

2. **Turn on the authenticator app.** Sign in to `https://<host>/ui`, open **Account**, choose **Set up the
   authenticator**, confirm your password, scan the QR code with your phone's authenticator app (or type the secret it
   shows), and enter the code it gives. Save the ten **recovery codes** it then shows, offline: they are shown once, and
   each signs you in once if you lose the phone. From now on sign-in asks for a code. (If `OWNER_TOTP_SECRET` was already
   set, it was imported: Account shows it as on; make recovery codes there with **New recovery codes**.)
3. **Confirm the imported keys.** On **Projects**, each project's key column says **Encrypted store · ends XXXX**, its
   status is **active**, and no row shows a note that the env file differs. The Overview shows no warning about the
   env file or the store.
4. **Retire the env keys** (🔒 sudo). env-sync asks the bridge (as `lkbridge`) to compare each key line, and the owner
   hash and TOTP lines, with its encrypted store, and comments out only those it found equal (or that you have since
   replaced on the dashboard). It prints names, never a value; anything it refuses is named with the reason.

   ```bash
   sudo /opt/lk-bridge/bin/env-sync.sh --retire-imported-keys
   ```

   ```bash
   sudo systemctl restart lk-bridge
   ```

   The lines stay in the file, commented out with a dated note (and the backup beside it holds them too). Once every
   project's key line is retired, `LK_PROJECTS` is commented out as well: the projects live in the database now.
   After the restart, check the Projects page again: every project active, keys from the encrypted store.

### Adding a project

1. In LegendKeeper, open the project, then **Project Settings → Developers → API Keys**, and create a key with the
   **ADMIN** role. Copy it.
2. On the dashboard, **Projects → Add a project**. Give it a name for this bridge (a letter, then letters, digits or
   `_`; agents name the project with it) and paste the key into the key field (write-only: it is never shown again).
3. **Check the key.** Confirm your password if asked. The bridge asks LegendKeeper which project the key belongs to and
   shows its name, its LegendKeeper id, the key's role and the key's last four characters. Nothing is stored yet.
4. If that is the project you meant, **Add the project**. It is served at once, with its own request budget; no restart.
   Switch its **Read-only** flag on first if it should not be written to yet. With two projects or more, every write
   must name its project.

A project whose LegendKeeper project was served before and removed comes back only under its old name.

### Replacing a key

**Projects → Replace key…** on the project's row, paste the new key, **Check the key**. A key of any other
LegendKeeper project is refused and nothing changes. Confirm, and the new key is used at once (a request already on its
way finishes with the old one). Then **revoke the old key in LegendKeeper** (the page reminds you, with its last four
characters): the bridge no longer uses it, but it works until revoked. If the old key is still in the env file, the
Projects page notes it until you retire it with `env-sync.sh --retire-imported-keys`.

### Removing a project

**Projects → Remove…**. A project with unfinished jobs or open proposals cannot be removed: the dialog offers **Pause and
drain** instead. A draining project takes no new work (agents get `PROJECT_UNAVAILABLE`, saying why); its running jobs
finish; decide its proposals on the Proposals page; then remove it. Removal deletes its stored key and stops serving it;
its history (jobs, journal, errors, proposals) stays, read-only, under its name in the project switcher. **Resume** undoes
a pause. Revoke the key in LegendKeeper too if nothing else uses it.

### The password and the authenticator

**Account → Password**: the current password, then the new one twice (at least 12 characters). Every other dashboard
session is signed out; this one stays. **Account → Authenticator app**: set it up (above), make new recovery codes (the
old ones stop working), or remove it (asks for a code). Lost the phone? Sign in with a recovery code in the code field.

### If the master key is missing or wrong

The bridge still starts. Each project whose key cannot be opened is **stopped** with the reason (the others are served),
and the Overview and Account pages say what is wrong. If the owner password was imported, the sign-in page says
sign-in is not possible and why. Put the right `SECRETS_MASTER_KEY` back from env-sync's backup beside the env file,
then restart (🔒 sudo):

```bash
sudo ls -l /etc/lk-bridge/
```

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run secrets -- status
```

`status` lists what is stored (projects by name, the last four characters, which master key sealed each), never a value.
If the key is truly lost, the stored keys are lost with it: add the projects again with their keys. To get back in, run
`npm run setup:owner` (step 7), put its `OWNER_PASSWORD_HASH` line in the env file, then clear the stored owner
credentials, which is audited, and restart:

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run secrets -- reset-owner --yes
```

### Rotating the master key

Rotate `SECRETS_MASTER_KEY` if it may have been exposed (the env file or one of its backups was read by someone it
should not have been). Every stored secret is re-encrypted; nothing else changes.

1. Stop the bridge (🔒 sudo):

   ```bash
   sudo systemctl stop lk-bridge
   ```

2. Move the key aside and generate a new one. env-sync makes a backup of the env file first, then the old key becomes
   `SECRETS_MASTER_KEY_PREVIOUS` and a new `SECRETS_MASTER_KEY` is generated; neither is shown.

   ```bash
   sudo /opt/lk-bridge/bin/env-sync.sh --rotate-master-key
   ```

3. Re-encrypt. This takes a checked backup of the database first (`/var/lib/lk-bridge/backups/pre-rotation-<time>.db`),
   then re-encrypts every secret with the new key, in one transaction. It refuses while the bridge runs, and changes
   nothing if a secret opens with neither key. Running it twice is harmless.

   ```bash
   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run secrets -- rotate-master-key
   ```

4. Start the bridge and check the Account page's **Encrypted secret store** card (working, nothing sealed with the
   previous key):

   ```bash
   sudo systemctl start lk-bridge
   ```

Keep `SECRETS_MASTER_KEY_PREVIOUS` as long as you keep database backups from before the rotation: they need it. A
later rotation comments it out (kept in the file) before moving the current key there.

## Migrating an existing install to v1.0.1

For the server that already runs 1.0.0, where `lkbridge` owns and builds the checkout and holds the deploy key. v1.0.1
moves the checkout and the key to a new build user, `lkbuild`, that cannot read the secrets (review finding F-17,
[ADR 0020](adr/0020-separate-build-user.md)). `deploy/migrate-to-build-user.sh` does the whole change once; it is safe to
run again, it has a read-only `--check` mode, and it stops with a message at anything it does not expect. The bridge is
down for about a minute at the end (step 6), as for any deploy. Nothing in `/var/lib/lk-bridge` or the env file's
contents changes.

**0. ✋ Owner:** merge the v1.0.1 pull request into `main` on GitHub, and note the merge commit's id.

**1. Look at the starting point** (🔒 sudo for the `sudo` lines; nothing changes):

```bash
systemctl is-active lk-bridge                                  # active
curl -s http://127.0.0.1:8787/healthz                          # {"ok":true,"version":"1.0.0"}
sudo -u lkbridge git -C /opt/lk-bridge/app status --short      # nothing: the checkout must be clean
sudo ls -l /home/lkbridge/.ssh/                                 # config, known_hosts, lk_bridge_deploy, lk_bridge_deploy.pub
id lkbuild                                                     # "no such user"
```

**2. Update the checkout only, the 1.0.0 way** (🔒 sudo; the running bridge is not touched, it keeps its old build):

```bash
sudo -u lkbridge git -C /opt/lk-bridge/app fetch origin main
sudo -u lkbridge git -C /opt/lk-bridge/app merge --ff-only origin/main
sudo -u lkbridge git -C /opt/lk-bridge/app log --oneline -1   # the merge commit from step 0
```

**3. ✋ Owner:** check that the commit printed is the one you merged, and read the script you are about to run as root:
`less /opt/lk-bridge/app/deploy/migrate-to-build-user.sh`.

**4. Copy the script out of the checkout, owned by root** (🔒 sudo). The checkout is still `lkbridge`'s, so the script
refuses to run from there.

```bash
sudo install -o root -g root -m 0700 /opt/lk-bridge/app/deploy/migrate-to-build-user.sh /root/migrate-to-build-user.sh
```

**5. Dry run** (🔒 sudo; changes nothing):

```bash
sudo /root/migrate-to-build-user.sh --check
```

On the 1.0.0 layout the `would:` lines are, roughly: create system user `lkbuild`; create `/home/lkbuild/.ssh` and copy
the key, its public half, the SSH config and `known_hosts`; check `lkbuild` reaches GitHub, then remove `lkbridge`'s
copies; `/opt/lk-bridge/app` to `lkbuild:lkbuild` with nothing group- or world-writable; create `/opt/lk-bridge/bin` and
install `deploy.sh` and `lib.sh` there from the commit of step 2; possibly `/home/lkbridge` to 0750. The sudoers file is
unchanged in v1.0.1, so it should say `up to date`. If it **STOPPED** instead, it says why and what to do; fix that and
run `--check` again.

**6. Migrate** (🔒 sudo). Add `--local-health` if the public checks cannot run from the server (see step 11).

```bash
sudo /root/migrate-to-build-user.sh
```

It does steps 1 to 4 as the dry run listed, then **5. verifies as each user** (eleven `PASS` lines: `lkbuild` cannot read
the env file, the data directory, the database or `lkbridge`'s home, and cannot write the Node; `lkbridge` cannot write
anything in the app or the Node, and can read the env file and write the data directory), then **6. runs a normal
deploy** with `--force`, so `lkbuild` rebuilds the app from scratch and the bridge restarts. It ends with
`DEPLOY SUCCEEDED` and `MIGRATION FINISHED`.

If the key check fails ("lkbuild cannot read the repository"; git's own message is printed above it), nothing has been
removed from `lkbridge`. Run the command the message gives (`git ls-remote … HEAD` as `lkbuild`, in the deploy's
environment): it must print one line ending in `HEAD` and exit 0. Fix what git says (usually the key or `known_hosts`),
then run the script again. (1.0.1's first version checked with `ssh -T`, which GitHub ends with exit status 1 even on
success, so that check always failed; fixed by the v1.0.1 hotfix.) If it says there is no key to move, follow
[A new deploy key](#a-new-deploy-key) below and run it again.

**7. Check by hand** (🔒 sudo; the script has done this, but see it yourself):

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/healthcheck.sh     # twelve PASS lines (step 11 of the install lists them)
sudo -u lkbuild test -r /etc/lk-bridge/lk-bridge.env && echo WRONG || echo "good: lkbuild cannot read the secrets"
sudo -u lkbridge touch /opt/lk-bridge/app/x 2>/dev/null && echo WRONG || echo "good: lkbridge cannot write the app"
ls -ld /opt/lk-bridge/app /opt/lk-bridge/bin                  # lkbuild lkbuild … app; root root … bin
sudo ls -l /home/lkbridge/.ssh/ /home/lkbuild/.ssh/            # the key is only in lkbuild's
sudo -u lkbuild git -C / ls-remote git@github.com:Airwolf1221/LK-Bridge.git HEAD   # one line: <commit id>  HEAD (exit 0)
curl -s http://127.0.0.1:8787/healthz                         # {"ok":true,"version":"1.0.1"}
```

**8. From now on, deploy with** `sudo /opt/lk-bridge/bin/deploy.sh` (🔒 sudo). The old command,
`sudo -u lkbridge /opt/lk-bridge/app/deploy/deploy.sh`, now stops and says so.

**9. Tidy up** (🔒 sudo, optional): `sudo rm /root/migrate-to-build-user.sh`. `lkbridge`'s old npm cache is no longer
used: `sudo rm -r /home/lkbridge/.npm` if you want the space back.

**10. ✋ Owner, optional: rotate the deploy key.** The key moved; it was not regenerated. It is read-only and only reads
this repository, but if you think `lkbridge` could ever have been compromised, make a new one for `lkbuild` as below,
add it on GitHub, then delete the old one there (_Settings → Deploy keys_).

### A new deploy key

Needed only if the script says there is no key to move, or for step 10. 🔒 sudo, then ✋ Owner on GitHub.

```bash
sudo install -d -o lkbuild -g lkbuild -m 0700 /home/lkbuild/.ssh
sudo -u lkbuild ssh-keygen -t ed25519 -N '' -C 'lk-bridge deploy key (lk.ottomoons.co.uk)' -f /home/lkbuild/.ssh/lk_bridge_deploy
sudo cat /home/lkbuild/.ssh/lk_bridge_deploy.pub              # the PUBLIC half
```

**✋ Owner:** add it on GitHub as in [step 3](#3-the-deploy-key-and-the-clone) (read-only), then create
`/home/lkbuild/.ssh/config` and pin `known_hosts` exactly as step 3 does, with `lkbuild` in place of `lkbridge`. Check
with `sudo -u lkbuild git -C / ls-remote git@github.com:Airwolf1221/LK-Bridge.git HEAD` (it must print one line and exit
0), then run the migration again.

### Going back to the 1.0.0 layout

Only if v1.0.1 must be abandoned (🔒 sudo throughout). The database needs no restore (see [Rollback](#rollback)).

```bash
sudo systemctl stop lk-bridge
sudo chown -R lkbridge:lkbridge /opt/lk-bridge/app
sudo install -d -o lkbridge -g lkbridge -m 0700 /home/lkbridge/.ssh
sudo sh -c 'for f in lk_bridge_deploy lk_bridge_deploy.pub config known_hosts; do install -o lkbridge -g lkbridge -m 0600 /home/lkbuild/.ssh/$f /home/lkbridge/.ssh/$f; done'
sudo -u lkbridge git -C /opt/lk-bridge/app checkout --detach <the 1.0.0 commit>
sudo -u lkbridge /opt/lk-bridge/app/deploy/deploy.sh --current --force
```

Then, once it runs: `sudo userdel -r lkbuild` and `sudo rm -r /opt/lk-bridge/bin`.
````
