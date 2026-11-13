# ADR 0043: The encrypted Google Drive copy (v2 E1b)

- Status: Accepted
- Date: 13 November 2026
- Session: v2 E1b (PLAN-v2 section 1 "Backups", 4.11 "Off-server copy", the E1b row, the owner-only secrets table item 4)
- Builds on: ADR 0042 (the snapshot store; **its layout is this ADR's contract**), ADR 0028 (the encrypted secret store
  and re-authentication), ADR 0015 and 0020 (the deployment layout, two users, units installed by `deploy.sh`), ADR 0003
  (outbound calls)
- Amends: PLAN-v2 4.11 ("the encryption password goes in the env file": it goes in the encrypted secret store instead,
  with the Google client and token, entered on the dashboard; the owner keeps a copy off the server either way)

## Context

E1a keeps every page's history in a content-addressed store on the server's disk, and `backup.sh` keeps 14 nightly
database copies beside it. One disk failure or a lost server loses both. PLAN-v2 asks for an **encrypted copy on Google
Drive**, made by **rclone** from a **separate systemd timer**, independent of the bridge process, with the Google
connection made **through the dashboard** (Google's sign-in flow) and its token kept in the **encrypted secret store**,
and a **download-and-verify drill**, because an off-site copy nobody has restored is not a backup.

The owner runs the bridge alone, on one Ubuntu 24.04 server, and has never used Google Cloud Console. Nothing in this
session touched a live system: every test runs against a mock Google and a fake `rclone`; the owner does the live checks.

## Decision 1: the owner's own Google app, `drive.file` only, published

The owner creates a small Google Cloud project (docs/drive-setup.md): the Drive API on, Branding filled in, Audience
**External** and **published** ("In production"), Data access with the one scope `drive.file`, and a **Web application**
OAuth client whose only redirect URI is `<BRIDGE_PUBLIC_URL>/admin/drive/callback`.

- **`drive.file`** lets the app see only the files it created. It is Google's non-sensitive, recommended Drive scope, so a
  published app needs no verification and the consent page asks for nothing else. The bridge cannot read the rest of the
  owner's Drive even if it is compromised.
- **Published, not Testing:** in Testing, Google expires refresh tokens 7 days after consent, so the copy would stop every
  week. The bridge still detects that (decision 4), but publishing is the fix.
- **A Web application client** (not "Desktop"): the redirect goes to the bridge itself, over HTTPS, so the code never
  passes through a loopback or a copy-and-paste in normal use.
- **Consequence:** `drive.file` access belongs to that Google Cloud project. A new project cannot see the old files. The
  setup guide says to keep the project and to store the client in the password manager; if the project is lost anyway,
  the runbook's recovery uses rclone's own client with full Drive access on another machine (the keys are what matter).

## Decision 2: the sign-in, in the bridge, bound to the owner's session

- `POST /api/admin/offsite/connect` (re-authentication within 5 minutes) makes a **PKCE** pair (S256, a 43-character
  verifier from 32 random bytes) and a **`state`** (32 random bytes), keeps them **in memory**, keyed by the SHA-256 of
  the state and bound to the hash of the dashboard session that asked, for **10 minutes**, and returns Google's
  authorisation URL: `scope=drive.file`, `access_type=offline`, `prompt=consent` (so Google issues a refresh token every
  time), `code_challenge_method=S256`.
- `GET /admin/drive/callback` lives outside `/api/admin`: Google's redirect is a cross-site top-level navigation, which the
  admin API refuses by design (`Sec-Fetch-Site`); it carries the session cookie (SameSite=Lax). It is refused, changing
  nothing, when there is **no owner session**, when the **state is unknown or belongs to another session**, or when it has
  **expired**; each state works **once**. Then the code is swapped (with the verifier) for tokens; a grant without
  `drive.file` is revoked and refused; the refresh token is stored; `about.get` with `fields=user` (which `drive.file`
  alone may call) names the account; the browser is sent on with a 303 to the Off-site copy page, with
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. A reconnect revokes the previous token.
- A restart forgets pending sign-ins: the owner clicks Connect again. Nothing about a sign-in is written to disk.

## Decision 3: what is stored, and where

| What                                 | Where                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| Client ID, client secret             | secret store, scope `offsite` (secret's last 4 shown)         |
| Refresh token                        | secret store, scope `offsite`                                 |
| Crypt password and salt (password2)  | secret store, scope `offsite`; never shown after confirmation |
| Account name and email, dates, state | `offsite_state` (migration 2100)                              |
| Settings (schedule, folder, limits)  | `offsite_state.settings_json`, edited on the dashboard        |
| Runs, findings, folders              | `offsite_runs`, `offsite_findings`, `offsite_folders`         |

The `secrets` table is rebuilt by migration 2100 to accept the five new purposes (SQLite cannot change a CHECK in place);
every existing row is copied as it is and still opens (its associated data is scope and purpose). Access tokens are never
stored. Saving the client, connecting, disconnecting, setting keys, deleting an old folder and adopting a folder all need
the dashboard's re-authentication (ADR 0028 decision 7).

## Decision 4: health that cannot go unnoticed

A token refresh that Google refuses (`invalid_grant`: revoked, expired in Testing, a password change; `invalid_client`)
marks the connection **broken** with a plain reason: the card turns red with **Reconnect**, and the **Overview** shows a
red card. The Overview also turns red when the **last good copy is older than `staleAfterDays`** (default 2 days) or the
**last verify found problems**, and amber for a failed or refused copy or an unfinished set-up. **Disconnect** revokes the
token at Google and deletes it from the store (if Google cannot be reached, it is still deleted, and the dashboard says to
remove the app's access in the Google account).

## Decision 5: the keys

rclone **crypt** with `password` and `password2` (the salt), **`filename_encryption = standard`** and
**`directory_name_encryption = true`**: Drive shows only encrypted names, so nothing about the setting (page names,
project ids, snapshot ids) is visible.

- **Generated** on the dashboard (32 random bytes each, base64url, 43 characters), **shown once** with the warning
  "without these, the Drive copy cannot be restored; keep them somewhere other than this server", held in memory for 15
  minutes bound to the session, and **saved only when the owner types back the last 6 characters of both**. Or the
  owner **enters their own** (each at least 16 characters, different, typed twice).
- **Changing keys after a copy exists** starts a **new Drive folder** (`<folder>/copy-<n+1>`): a fresh full upload. The
  owner confirms that first (the API refuses without `acknowledgeNewFolder`). The old folder is **kept** and listed until
  the owner deletes it from the dashboard (to Drive's bin). Changing the folder setting after a copy works the same way.
- The keys reach rclone only in its **obscured** form, made by rclone itself from standard input (`rclone obscure -`):
  never on a command line, never in an environment variable.

## Decision 6: the runner is a separate service

`lk-bridge-offsite.service` (oneshot, `lkbridge`) runs `deploy/offsite.sh run`, which runs the compiled Node entry
`dist/offsite/cli.js` with the private Node, as `lk-run.sh` does. It is started by:

- **`lk-bridge-offsite.timer`**, every quarter hour. The schedule itself is in the database (daily copy at 04:45 London by
  default, after the 04:15 database copy; monthly verify on day 1 at 05:30): a run starts when nothing of its kind has
  started since its latest scheduled time, so a missed time is caught up and changing the schedule needs no unit change;
- **`lk-bridge-offsite.path`**, which watches `/var/lib/lk-bridge/offsite/requests/*.json`. The bridge writes a request
  file for "Copy now", "Verify now", deleting an old folder, and **after each weekly full snapshot completes**
  (`SnapshotService.afterFull`). The runner takes (reads and deletes) every request first; a request left while it runs
  starts it again afterwards. There is no shared process and no sudo rule.

A run: refuse unless rclone is installed and **at least 1.60** (decision 8); read the client, token and keys from the
secret store (with `SECRETS_MASTER_KEY` read from the env file by the runner itself: the unit has no `EnvironmentFile`, so
nothing secret is in any environment); refresh the access token; write the **temporary config** (decision 7); then:

1. `copy objects/ → store/objects` (new pieces);
2. `sync manifests/ → store/manifests --min-age <seconds since the run began>`: only manifests written **before** the run
   began, whose objects were therefore already on disk when step 1 listed them, so every manifest on Drive has all its
   objects there first (ADR 0042: objects before manifests); a manifest written during the run waits for the next one;
3. `sync objects/ → store/objects`: removes the pieces E1a's collector removed, **after** the manifests that named them
   are gone from Drive (removals manifests-first, additions objects-first);
4. `copyto STORE.json`;
5. `sync /var/lib/lk-bridge/backups → database` (only `nightly-*` and `pre-deploy-*` copies).

Each `sync` uses **`--backup-dir deleted/<date>/…`** on the same crypt remote, so whatever it replaces or removes stays on
Drive; the runner then **purges** `deleted/<date>` folders older than **`deletedRetentionDays`** (30) with
`--drive-use-trash=false`. A failing step stops the run (nothing after it runs). Flags: `--transfers` and `--bwlimit`
(settings), `--fast-list`, `--drive-stop-on-upload-limit`, `--use-json-log` (the runner reads rclone's final stats for
bytes and files).

**`--checksum` is not used.** The crypt backend has no hashes (it encrypts with a random nonce per file), so rclone would
fall back to comparing sizes only, which is weaker than its default size and modification time. The store's files are
write-once and named by their content's hash, and the verify job re-hashes what it downloads, which is the real check.

Guards: a local store with **no manifests** is never mirrored over Drive (a wiped disk would otherwise move the whole copy
into `deleted/`); a folder that already holds something this database never copied into (a recovery from a fresh
database) is refused until the owner **adopts** it on the dashboard.

The run is recorded in `offsite_runs` (start, end, bytes, files, errors, rclone's exit code and version, each step); the
bridge only reads it. A run left `running` by a dead process is marked `interrupted` at the next start. If rclone renewed
the token during a long run and Google issued a new refresh token with it, the runner reads it back from the config and
stores it; so does a refresh at the start that returns a new one.

**Resources:** `Nice=15`, `CPUWeight=20`, `IOSchedulingClass=idle`, `MemoryHigh=640M`, `MemoryMax=768M` (the bridge has
1536M), `TimeoutStartSec=12h`, and the bridge's hardening (`ProtectSystem=strict`, `PrivateTmp`, `ReadWritePaths=/var/lib/
lk-bridge`). `deploy.sh --update-self` installs the three units (and now the backup units too) when they differ or are
missing, backs up an installed copy, reloads systemd and enables the timer and the path unit, without restarting the
bridge when nothing else changed.

## Decision 7: the temporary config

A directory from `mkdtemp` under the unit's **PrivateTmp** (0700), `rclone.conf` inside it (**0600**): a `drive` remote
(`scope = drive.file`, the owner's client ID and secret, the token with its expiry) and a `crypt` remote over
`<folder>/copy-<n>` with the obscured keys. It is removed in a `finally` after every run, also when rclone crashes or the
run throws; a stop (SIGTERM) ends rclone and exits, and the process's exit handler removes any directory still listed;
and if even that is skipped (SIGKILL), the private `/tmp` goes when the unit stops. rclone is started with a minimal
environment (`PATH`, `HOME` and `TMPDIR` in that directory, `LANG`): none of the runner's variables.

## Decision 8: rclone from rclone.org, at least 1.60

Ubuntu 24.04's `apt install rclone` gives **1.60.1** (November 2022). Everything the runner uses exists there (`drive` with
`scope = drive.file` and a supplied token, `crypt` with name encryption, `obscure -`, `copy`, `copyto`, `sync` with
`--backup-dir`, `--min-age`, `--files-from`, `lsjson`, `lsf`, `purge`, `--use-json-log` stats, `--bwlimit`, `--transfers`,
`--fast-list`, `--drive-stop-on-upload-limit`), so **1.60.0 is the minimum** the runner accepts. But that package has
missed four years of fixes, several of them security releases (1.74.4, 1.75), and the Drive backend changes as Google's
API does. **Decision: rclone's official current release**, installed from its `.deb`:

```bash
curl -fsSL -o /tmp/rclone.deb "https://downloads.rclone.org/rclone-current-linux-$(dpkg --print-architecture).deb" && sudo apt install -y /tmp/rclone.deb
```

The runner refuses with a clear message when rclone is missing or older than 1.60, and the dashboard shows the version
each run used.

## Decision 9: the verify job and the recovery

**Verify** (dashboard button, request file; monthly by default): list the remote store; download and decrypt **every
manifest** plus a **sample of the objects** (`verifySamplePercent`, 1%, at least `verifySampleMin`, 50) into the private
temporary directory; **re-hash** each sampled object against its name; check every piece every manifest names is
**present**; download the **newest database copy** and run SQLite's `integrity_check` on it (and check it has
`schema_migrations`). Findings (`missing`, `corrupt`, `manifest_unreadable`, `database_bad`, `database_missing`,
`store_missing`) are kept per run and shown in red.

**Recovery** (`deploy/offsite-restore.sh`, the runbook's disaster-recovery section): on a new server with the bridge
installed and its env file (with `SECRETS_MASTER_KEY`) back, the client, connection and keys are entered on the dashboard,
or with `offsite.sh set-client`, `connect` (paste the address Google sent the browser to) and `set-keys` when the
dashboard is not up; the script pulls `objects/`, then `manifests/`, then `STORE.json`, then the newest database copy into
a new directory, checks **every** object against its name, every manifest's pieces, and the database copy, and prints the
commands that move them into place. It never touches the live files.

E1a's rehearsal proves a snapshot restores into LegendKeeper; this verify proves the Drive copy is complete and readable.
Together they are the backup proof.

## Threat review

| Threat                                                    | What stops it, or limits it                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Refresh token stolen from the database**                | Sealed (AES-256-GCM under `SECRETS_MASTER_KEY`, which is not in the database). A database backup alone reveals nothing. With the env file too, the thief gets `drive.file` access to the backup folder only, which holds ciphertext; the crypt keys are also sealed, so with the env file they are exposed as well (as every other secret is, ADR 0028). Disconnect revokes it at Google.                                     |
| **Token stolen in transit or from logs**                  | Only HTTPS to Google's fixed endpoints. Never logged: errors pass through `redactSecrets` (access, refresh and code shapes, client secrets, the exact values in hand); rclone's log lines are redacted the same way before they are kept. Tests scan the logs, responses, audit rows and the database file (after a WAL checkpoint) for every token, code, secret and key.                                                    |
| **A forged or replayed callback** (login CSRF, code swap) | `state` is 256 random bits, bound to the session that started the sign-in, single-use, 10 minutes; no session, another session, unknown or expired: refused before Google is asked. PKCE S256 ties the code to the verifier, which never leaves the bridge. The callback needs no CSRF token because it changes nothing without a matching state.                                                                             |
| **The redirect** (open redirect, code leaking)            | The redirect URI is fixed (`<public URL>/admin/drive/callback`) and registered at Google, which refuses any other. The callback only ever redirects to `/ui/offsite` with a fixed status code; it sends `no-referrer` and `no-store`, and its code is used immediately. Caddy logs no query strings unless the owner turns logging on (the Caddyfile notes it).                                                               |
| **Scope creep**                                           | Only `drive.file` is requested, and a grant without it is revoked and refused. The app sees only files it created; it can neither read nor delete the rest of the owner's Drive.                                                                                                                                                                                                                                              |
| **A stolen dashboard session**                            | It can request copies and verifies (harmless) and change the schedule. Saving the client, connecting, disconnecting, setting keys, deleting a folder and adopting one need the password (and code) again. Keys are never shown again after their confirmation.                                                                                                                                                                |
| **The temporary config**                                  | 0600 in a 0700 directory in the unit's private `/tmp`, owned by `lkbridge`; removed after success, failure, a crash of rclone or a stop; gone with PrivateTmp in the worst case. The keys in it are obscured (rclone's reversible encoding, so it is protected by the file mode, not by the obscuring). No key on a command line or in an environment.                                                                        |
| **The keys**                                              | Generated with 256 bits each; shown once; confirmed by their last characters, so a copy that was not saved is noticed before the copy depends on it; stored sealed. Losing them makes the Drive copy unreadable: the setup guide and the dashboard say to keep them with `SECRETS_MASTER_KEY` and the recovery codes, off the server. Changing them never re-encrypts in place: a new folder, the old one kept until deleted. |
| **Google, or a thief of the Google account**              | Sees encrypted files with encrypted names and sizes. Could delete them: the local store and database copies are untouched, and the next copy uploads everything again. The monthly verify notices a damaged copy.                                                                                                                                                                                                             |
| **A wiped local disk or a fresh database**                | An empty store is never mirrored over Drive; a folder this database never copied into is refused until adopted; whatever a sync replaces or removes is kept in `deleted/<date>` for 30 days.                                                                                                                                                                                                                                  |
| **The runner disturbing the bridge**                      | A separate process with idle I/O, low CPU weight and a memory ceiling under half the bridge's; `--bwlimit` and `--transfers` are settings; `--drive-stop-on-upload-limit` stops at Google's daily upload quota instead of retrying for hours.                                                                                                                                                                                 |
| **Global `fetch` outside the governor**                   | The repository bans global `fetch` to keep LegendKeeper behind the governor (ADR 0003). `src/offsite/google.ts` uses it for Google's fixed endpoints only, with one marked lint exception; nothing in `src/offsite` can reach LegendKeeper.                                                                                                                                                                                   |

## Consequences

- The owner sets the copy up once (docs/drive-setup.md, then the dashboard) and keeps four things off the server:
  `SECRETS_MASTER_KEY`, the recovery codes, the Drive keys, and the Google client.
- The Overview turns red when the backup is broken or stale, so it cannot quietly stop.
- No new env variables. The runner reads the env file itself; `LKB_RCLONE` (environment) overrides the rclone binary.
- **To verify live (the owner):** the Google setup and Connect; the first copy's size and time; Verify now; a pull with
  `offsite-restore.sh` into a scratch directory on the server; and that `drive.file` alone lets `about.get` name the
  account (the mock assumes it, following Google's documentation).
- Tested (`test/offsite/`, `test/ui/offsite.test.tsx`, the deploy tests): PKCE and state (mismatch, another session,
  expiry, reuse, no session), the scope check, encrypted storage, refresh and rotation, `invalid_grant` turning the card
  and the Overview red, disconnect revoking and deleting (also when Google cannot be reached), re-authentication for every
  sensitive action, no secret in any output; keys generated, shown once, confirmed, own keys, a new folder after a copy;
  the runner with the fake rclone (the config's mode and removal after success, a crash, an exception and SIGTERM; the
  order; `--min-age`; `--backup-dir` and the purge; a renewed token kept; the status recorded; rclone missing or too old;
  the foreign-folder and empty-store guards; the schedule and the requests); verify (complete, missing, corrupt, bad
  database, no store); `offsite-restore.sh` end to end; the units' content and `systemd-analyze verify`; `deploy.sh`
  installing them.
