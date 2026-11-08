# Deployment runbook: lk.ottomoons.co.uk

Step by step, for **this** server: Ubuntu 24.04 LTS, Caddy already installed and serving other sites, the system Node
left alone. Design reasons are in [ADR 0015](adr/0015-deployment-layout.md); what the bridge does once it is up is in
[PLAN §9](PLAN.md) and [auth-live-checklist.md](auth-live-checklist.md).

## How to read this

- **🔒 sudo** marks every command that needs `sudo` (including `sudo -u lkbridge …`, which is `sudo` too). A block with
  no mark runs as any user and changes nothing.
- Commands run as your administrator account unless a block says otherwise. `sudo -u lkbridge` runs a command as the
  service user.
- **✋ Owner** marks a step only you can do: it involves a secret, a password, or an account on GitHub, LegendKeeper,
  Claude or ChatGPT. If a Claude Code session is following this runbook for you, it must stop at those steps and let you
  do them. **Never paste an API key, a secret or the owner password into a chat or a command line**; secrets go into the
  env file through an editor (`sudoedit`).
- Every path and name below is the real one; there is nothing to substitute except where a `<placeholder>` is shown.

## The order, in one list

Prerequisites (DNS, packages, checks) → user and directories → deploy key and clone → private Node → first build →
env file ✋ → `setup:owner` ✋ → systemd units and the sudo rule → start and check locally → Caddy block → health check →
sandbox script ✋ → connect Claude and ChatGPT ✋ → go live ✋. These are sections 1 to 14 below, in that order.

Afterwards: [updating](#updating), [backups and restore](#backups-and-restore), [rollback](#rollback),
[logs](#logs-and-useful-commands).

## What is where

| Path                                     | What                                                                                   | Owner / mode          |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| `/opt/lk-bridge/app`                     | the git checkout and build output                                                      | `lkbridge`, 0755      |
| `/opt/lk-bridge/runtime/node`            | symlink to the private Node 24 (`node-v24.x.y-linux-x64` beside it)                    | `root`, 0755          |
| `/var/lib/lk-bridge`                     | `bridge.db` and its WAL files; the only place the service may write                    | `lkbridge`, **0700**  |
| `/var/lib/lk-bridge/backups`             | `nightly-*.db.gz` (newest 14) and `pre-deploy-*.db.gz` (newest 5)                      | `lkbridge`, 0700      |
| `/etc/lk-bridge/lk-bridge.env`           | every setting and secret                                                               | `root:lkbridge`, 0640 |
| `/etc/systemd/system/lk-bridge.service`  | the service                                                                            | `root`, 0644          |
| `/etc/systemd/system/lk-bridge-backup.*` | the nightly backup service and timer                                                   | `root`, 0644          |
| `/etc/sudoers.d/lk-bridge`               | lets `lkbridge` start, stop, restart and show the status of `lk-bridge` — nothing else | `root`, 0440          |
| `/etc/caddy/Caddyfile`                   | one block appended                                                                     | unchanged otherwise   |
| `/home/lkbridge/.ssh`                    | the read-only GitHub deploy key                                                        | `lkbridge`, 0700      |

The scripts, all in `deploy/`: `install-node.sh`, `deploy.sh`, `backup.sh`, `healthcheck.sh`, `lk-run.sh` (runs a command
with the private Node and `DB_PATH` set), `sandbox-test.sh`, plus `lib.sh` (shared helpers) and the files the steps
install: `lk-bridge.service`, `lk-bridge-backup.service`, `lk-bridge-backup.timer`, `Caddyfile.lk-bridge`,
`sudoers.lk-bridge`, `env.template`.

---

## 1. Prerequisites

**✋ Owner, outside the server**

- **DNS.** An `A` record `lk.ottomoons.co.uk` → this server's public IPv4 address. Claude's connectors are IPv4-only and
  reject names that resolve to private or CGNAT addresses. Do **not** add an `AAAA` record unless this server's IPv6 is
  fully working. Check from your own computer: `dig +short A lk.ottomoons.co.uk`.
- **LegendKeeper.** The production API key (ADMIN role) and project id, and the **sandbox** project's own key and id.
  Keep them somewhere you can copy from in step 6; do not email or message them.
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
df -h /opt /var | cat                         # a few hundred MB free is plenty
timedatectl | grep -i synchronized            # "System clock synchronized: yes" (tokens and TOTP depend on it)
```

If `caddy validate` already fails, stop: fix that first, or you will not know whether a later failure is ours.

`npm ci` installs two native modules, `better-sqlite3` and `argon2`. Both normally arrive prebuilt; if step 5 fails with
`node-gyp` or compiler errors, install the build tools (`sudo apt install -y build-essential python3`) and run it again.

## 2. The user and the directories

🔒 sudo

```bash
sudo useradd --system --create-home --home-dir /home/lkbridge --shell /bin/bash --user-group lkbridge

sudo install -d -o root     -g root     -m 0755 /opt/lk-bridge /opt/lk-bridge/runtime
sudo install -d -o lkbridge -g lkbridge -m 0755 /opt/lk-bridge/app
sudo install -d -o lkbridge -g lkbridge -m 0700 /var/lib/lk-bridge /var/lib/lk-bridge/backups
sudo install -d -o root     -g lkbridge -m 0750 /etc/lk-bridge
```

The service needs `/var/lib/lk-bridge` to exist before it starts (the unit's `ReadWritePaths=` points at it). The
`lkbridge` account has no password and no way to log in remotely; you reach it only through `sudo -u lkbridge`.

Run the commands in the rest of this runbook from a directory the service user can read, for example:

```bash
cd /opt/lk-bridge
```

## 3. The deploy key and the clone

The repository is private. The server reads it over SSH with a **read-only deploy key** that belongs to `lkbridge`.

🔒 sudo

```bash
sudo -u lkbridge install -d -m 0700 /home/lkbridge/.ssh
sudo -u lkbridge ssh-keygen -t ed25519 -N '' -C 'lk-bridge deploy key (lk.ottomoons.co.uk)' -f /home/lkbridge/.ssh/lk_bridge_deploy
sudo cat /home/lkbridge/.ssh/lk_bridge_deploy.pub        # the PUBLIC half; safe to copy
```

**✋ Owner:** on GitHub open the repository → _Settings → Deploy keys → Add deploy key_. Title it
`lk.ottomoons.co.uk (read-only)`, paste the public key, and leave **Allow write access unticked**.

Tell SSH to use that key for github.com, and pin GitHub's host key after checking its fingerprint.

🔒 sudo

```bash
sudo -u lkbridge tee /home/lkbridge/.ssh/config >/dev/null <<'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/lk_bridge_deploy
    IdentitiesOnly yes
EOF
sudo -u lkbridge chmod 0600 /home/lkbridge/.ssh/config

sudo -u lkbridge sh -c 'ssh-keyscan -t ed25519 github.com > /home/lkbridge/.ssh/known_hosts.candidate 2>/dev/null && ssh-keygen -lf /home/lkbridge/.ssh/known_hosts.candidate'
```

The line printed must contain GitHub's published ed25519 fingerprint, `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.
Confirm it against <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>
(do not trust this page alone). If it matches:

```bash
sudo -u lkbridge mv /home/lkbridge/.ssh/known_hosts.candidate /home/lkbridge/.ssh/known_hosts
sudo -u lkbridge ssh -T git@github.com       # "Hi Airwolf1221/LK-Bridge! You've successfully authenticated, but GitHub does not provide shell access."
sudo -u lkbridge git clone git@github.com:Airwolf1221/LK-Bridge.git /opt/lk-bridge/app
sudo -u lkbridge git -C /opt/lk-bridge/app log --oneline -3
```

The checkout is on `main`. (Before this chunk is merged, clone with `--branch chunk-7a-deploy` and prefix
`DEPLOY_BRANCH=chunk-7a-deploy` to the `deploy.sh` commands.)

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

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm ci
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run build
ls /opt/lk-bridge/app/dist/server.js /opt/lk-bridge/app/ui/dist/index.html
```

`lk-run.sh` puts the private Node first on `PATH` and runs the command in the app directory.

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

| Variable                                      | Value                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `LK_API_KEY`, `LK_PROJECT_ID`                 | the production key and project id from LegendKeeper                                                                 |
| `SESSION_SECRET`, `JWT_SIGNING_KEY`           | two **different** random values: run `openssl rand -base64 48` twice in another terminal and copy each output       |
| `LK_SANDBOX_API_KEY`, `LK_SANDBOX_PROJECT_ID` | the **sandbox** project's key and id (used only by the sandbox script, step 12). Leave blank until then if you wish |
| `OWNER_PASSWORD_HASH`                         | step 7 gives you this line                                                                                          |

Already set for production: `BRIDGE_PUBLIC_URL=https://lk.ottomoons.co.uk`, `TRUST_PROXY=loopback`,
`LK_READ_ONLY=true` (the first boot is read-only), `WRITERS_MAX=1`, `HOST=127.0.0.1`, `PORT=8787`,
`DB_PATH=/var/lib/lk-bridge/bridge.db`. Leave them. Rules for the file: one `NAME=value` per line, no `export`, no spaces
around `=`; a value containing `$` (the owner hash) stays inside single quotes.

Check that nothing required is still blank, **without printing any value**:

```bash
sudo grep -E '^(LK_API_KEY|LK_PROJECT_ID|SESSION_SECRET|JWT_SIGNING_KEY|OWNER_PASSWORD_HASH)=$' /etc/lk-bridge/lk-bridge.env
# prints only the names still empty (OWNER_PASSWORD_HASH is expected until step 7); prints nothing when all are set
sudo -u lkbridge test -r /etc/lk-bridge/lk-bridge.env && echo "lkbridge can read it"
```

## 7. The owner password ✋

**✋ Owner:** this prompts for the password (hidden) and offers an authenticator app (TOTP). It writes nothing to disk;
it prints lines for you to paste.

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run setup:owner
```

Paste the printed `OWNER_USERNAME=…` and `OWNER_PASSWORD_HASH='…'` lines (and `OWNER_TOTP_SECRET=…` if you enrolled
TOTP) into the env file with `sudoedit`, replacing the blank `OWNER_PASSWORD_HASH=` line and keeping the single quotes.
Keep the password and the TOTP secret in your password manager; the bridge cannot recover them, only replace them
(run this step again).

## 8. systemd units and the sudo rule

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

## 9. Start it and check it locally

🔒 sudo

```bash
sudo systemctl enable --now lk-bridge
sudo systemctl status lk-bridge --no-pager
sudo journalctl -u lk-bridge -n 40 --no-pager
curl -s http://127.0.0.1:8787/healthz           # {"ok":true,"version":"0.1.0"}
sudo systemctl enable --now lk-bridge-backup.timer
systemctl list-timers lk-bridge-backup.timer --no-pager
```

What you should see in the journal: `LK-Bridge listening` with the MCP URL `https://lk.ottomoons.co.uk/mcp`. If it
fails instead:

| Journal shows                            | Cause                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `Invalid configuration: - LK_API_KEY: …` | a variable is blank or malformed; the message names the **variable**, never the value  |
| `status=226/NAMESPACE`                   | `/var/lib/lk-bridge` does not exist (step 2)                                           |
| `status=203/EXEC`                        | the private Node is missing or not executable (step 4)                                 |
| `EADDRINUSE`                             | something else is on port 8787; find it with `sudo ss -ltnp \| grep 8787`              |
| `Cannot find module …/dist/server.js`    | the build did not run (step 5)                                                         |
| `unable to open database file`           | `/var/lib/lk-bridge` is not owned by `lkbridge` or `DB_PATH` was changed to outside it |

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

Expected: six lines starting `PASS` and `All checks passed.`:

- the bridge answers on `127.0.0.1:8787/healthz`;
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

Needs `LK_SANDBOX_API_KEY` and `LK_SANDBOX_PROJECT_ID` in the env file (step 6; **sandbox project only**). The script
reads just those two from the file, exports only them, prints neither, and refuses to run if either equals the
production key or project id.

🔒 sudo (as `lkbridge`)

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh
```

It uses its own temporary database, not the production one, and does not need the service stopped. Read the report at the
end (PASS / FAIL / INCONCLUSIVE / SKIPPED per item; see `test/sandbox/README.md`). Keep the output for chunk 8's review.
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
```

The consent page for OAuth from Claude Code shows `localhost (this computer)` and a warning that the application only
accepts sign-ins on your own computer: that is expected. Treat a PAT like a password.

**ChatGPT** (Developer Mode, OAuth only): follow [auth.md › ChatGPT](auth.md#chatgpt-developer-mode), then section 9 of
the checklist. If registration is refused with "invalid redirect URI", the journal line `client.registration_rejected`
holds the exact URI: add it to `OAUTH_EXTRA_REDIRECT_URIS` in the env file, restart, and create the connector again.

Raise a profile's scope (to `propose` or `write`) on the dashboard under _Clients & Access_ when you are ready; section 10
of the checklist walks through it against the sandbox project.

## 14. Going live ✋

Follows PLAN §9.7. The bridge starts read-only (`LK_READ_ONLY=true`, `WRITERS_MAX=1`).

1. Run the sandbox script and the checklist sections against the **sandbox** project first (set `LK_API_KEY` and
   `LK_PROJECT_ID` to the sandbox's temporarily if you want to exercise writes through the connectors; put the real ones
   back afterwards and restart).
2. Point the bridge at the real project in **read-only** mode while ChatGPT finishes its maintenance on the repository.
   Two writers on one project would contend for versions and for the shared project rate tier.
3. When that maintenance is over, revoke the old bridge's LegendKeeper key, then set `LK_READ_ONLY=false` in the env file
   and `sudo systemctl restart lk-bridge`. Keep `WRITERS_MAX=1` for the first week.

---

## Updating

As the service user, from anywhere:

```bash
sudo -u lkbridge /opt/lk-bridge/app/deploy/deploy.sh          # 🔒 sudo
```

What it does, in order (it stops at the first problem and says what to do):

1. **Pre-flight, nothing changed yet:** it is not root, the private Node is present, the env file is readable, the
   checkout has **no local changes or untracked files** (otherwise it refuses and lists them), the sudo rule works, and
   `origin/main` is a **fast-forward** of what is checked out (otherwise it refuses). If there is nothing new it says so and
   exits (`--force` redeploys anyway).
2. **Drains and stops** the service: `sudo systemctl stop lk-bridge`. This is the drain. SIGTERM makes the bridge stop
   taking new work and give running jobs up to 20 seconds to finish; the unit allows 45 seconds before killing it. A job
   still unfinished then is picked up again by the engine's start-up recovery when the service starts. (The admin API could
   drain without stopping, but it accepts only your browser session and a script has none; see ADR 0015. For a gentler
   hand-over, press _Drain_ on the dashboard's Writers page before you start.)
3. Takes a **`pre-deploy` backup** of the database (kept: the newest 5).
4. `git merge --ff-only`, `npm ci`, `npm run build`, then the **database migrations**.
5. **Starts** the service (`sudo systemctl start lk-bridge`) and waits up to 60 seconds for `/healthz`.
6. Runs `healthcheck.sh` and prints **`DEPLOY SUCCEEDED`** or **`DEPLOY FAILED`**.

Expect about a minute of downtime. If a step fails **before the checkout changes** (a dirty tree, a failed backup), the
previous version is started again for you. If it fails after, the service stays **stopped** and the message gives the exact
rollback command.

Options: `--current` (deploy the checked-out commit without fetching; used for rollback), `--force`, `--local-health`
(skip the public checks).

The unit files, the sudoers file and the Caddy block are **not** updated by `deploy.sh`. If a release changes one, the
script warns after a successful deploy ("installed unit differs from deploy/…"); an administrator then repeats step 8
(and `sudo systemctl restart lk-bridge`) or step 10 for that file. To upgrade Node: `sudo NODE_VERSION=v24.x.y
/opt/lk-bridge/app/deploy/install-node.sh`, then `sudo systemctl restart lk-bridge`.

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

- **Off the server:** the backups sit on the same disk as the database. Copy them somewhere else now and then, from your
  own computer: `scp` or `rsync` of `/var/lib/lk-bridge/backups/` (they are readable only by `lkbridge` and root, so copy
  with `sudo`, or add a pull job under your own account). They hold token hashes and the proposals and journal data:
  treat them as sensitive.
- **Test a backup without touching production** (as `lkbridge`):

  ```bash
  sudo -u lkbridge sh -c 'gunzip -c /var/lib/lk-bridge/backups/<file>.db.gz > "$HOME/restore-test.db" && sqlite3 "$HOME/restore-test.db" "PRAGMA integrity_check; SELECT count(*) FROM schema_migrations;"; rm -f "$HOME/restore-test.db"'
  ```

- **Restore** (the bridge must be stopped; this replaces the live database, and anything written since the backup is
  lost):

  ```bash
  sudo systemctl stop lk-bridge
  sudo -u lkbridge mkdir -p /var/lib/lk-bridge/restore-aside
  sudo -u lkbridge sh -c 'mv /var/lib/lk-bridge/bridge.db* /var/lib/lk-bridge/restore-aside/'   # the db AND its -wal/-shm files
  sudo -u lkbridge sh -c 'gunzip -c /var/lib/lk-bridge/backups/<file>.db.gz > /var/lib/lk-bridge/bridge.db && chmod 600 /var/lib/lk-bridge/bridge.db'
  sudo -u lkbridge sqlite3 /var/lib/lk-bridge/bridge.db 'PRAGMA integrity_check;'      # ok
  sudo systemctl start lk-bridge
  sudo -u lkbridge /opt/lk-bridge/app/deploy/healthcheck.sh
  ```

  Moving the old `-wal` and `-shm` files away matters: a stale one next to a restored database corrupts it. Delete
  `restore-aside` when you are sure.

## Rollback

Each deploy prints the previous commit. To go back (🔒 sudo):

```bash
sudo -u lkbridge git -C /opt/lk-bridge/app log --oneline -10                  # find the commit to return to
sudo -u lkbridge git -C /opt/lk-bridge/app checkout --detach <commit>
sudo -u lkbridge /opt/lk-bridge/app/deploy/deploy.sh --current --force
```

This builds and starts exactly that commit, with the same drain, backup and health checks. To move forward again:
`sudo -u lkbridge git -C /opt/lk-bridge/app checkout main`, then run `deploy.sh` as usual (while the checkout is on a
detached commit, plain `deploy.sh` refuses and says why).

**Migrations are not reversed.** If the release you are leaving changed the database schema, an older build may refuse to
start on it. Then restore the `pre-deploy-…` backup taken just before that release (see "Restore"; changes made since
are lost), and deploy the older commit.

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

Caddy's own log goes to its journal. The bridge's request log keeps paths only (no query strings, no headers).

| Symptom                                                   | Look at                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `502` from the public URL                                 | the bridge is down: `systemctl status lk-bridge`, then its journal                                   |
| Certificate error on the new name                         | DNS not pointing here yet, or ports 80/443 blocked: `journalctl -u caddy`                            |
| Claude cannot connect, "redirect" or "401 without header" | `healthcheck.sh` (a failing line names the cause); then checklist section 1                          |
| Everyone locked out of sign-in at once                    | the log shows `127.0.0.1` as the client: `TRUST_PROXY` or Caddy's forwarding (checklist 1.7)         |
| Dashboard live data stalls                                | something is buffering `/api/admin/stream`: the Caddy block must be exactly as shipped (no `encode`) |
| `deploy.sh` says the checkout has local changes           | something edited files under `/opt/lk-bridge/app`; `git status`, then `git restore`/remove them      |
