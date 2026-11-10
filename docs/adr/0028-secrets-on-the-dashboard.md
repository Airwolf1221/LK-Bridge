# ADR 0028: Projects, keys and the owner's sign-in are managed on the dashboard, kept in an encrypted store

Status: Accepted (OPS2, 10 November 2026). Amends [ADR 0023](0023-project-model.md) decision 1 (keys no longer live
only in the env file) and decision 2 (a project can be added and removed at runtime), [ADR 0024](0024-env-sync.md)
decision 2 (env-sync gains two value-moving operations besides `--migrate-projects`) and decision 1 (the owner hash and
the project variables become optional in the template), and [ADR 0013](0013-dashboard-and-admin-api.md) (some admin
routes now need a recent re-authentication). The owner-login design of [ADR 0007](0007-oauth-authorization-server-design.md)
otherwise stands. Number 0028 was assigned to this session; A3 and A4 ran alongside.

## Context

Adding a LegendKeeper project, replacing a key, changing the owner's password or enrolling an authenticator meant
editing `/etc/lk-bridge/lk-bridge.env` on the server, as root, near every other secret, then restarting the bridge.
env-sync (OPS1) removed the hand edits for settings and generated secrets, but not for these: only the owner has them.
The owner wants to do all of this from the dashboard, leaving the env file with the bootstrap secrets only.

That moves secrets over the web and into the database, so the design has to answer: how are they stored, what happens
when the key that protects them is wrong or lost, how does a stolen dashboard session not become a stolen key, and how
do the values already in the env file move across without anyone typing them again.

## Decisions

1. **An encrypted secret store in the database** (`src/secrets/`, migration 1000, table `secrets`). Each value is sealed
   with **AES-256-GCM** under a key derived (HKDF-SHA256) from **`SECRETS_MASTER_KEY`**, a new env variable that env-sync
   generates (`@generate:base64:32`). Every value gets a **fresh random 96-bit nonce**, and the row's **scope** (the
   LegendKeeper project id, or `*` for the owner) and **purpose** (`lk_api_key`, `owner_password_hash`,
   `owner_totp_secret`) are the **associated data**: a ciphertext copied into another row, another project's or another
   purpose's, fails to authenticate. Each row records a **key id** (a separate HKDF output, so it names the master key
   without revealing anything about the AES key), which tells a wrong master key apart from a damaged row. API keys
   keep their **last four characters** in clear (`hint`), the only part ever shown again. Recovery codes are stored as
   SHA-256 hashes (they carry 100 random bits; an unkeyed hash is enough, and survives a key rotation).
2. **A missing or wrong master key never stops the bridge.** The bridge reads `SECRETS_MASTER_KEY` leniently (a warning,
   never a start-up error; `npm run config:check` reports a short one, so a deploy or env-sync edit cannot introduce
   it). Without a usable key nothing can be written, and each stored secret that cannot be opened is reported for what
   it is: its project is **stopped** with the reason (the others are served), the Overview and the Account page say
   what is wrong and how to fix it, and the sign-in page says so for the owner's own credentials. A stored secret that
   cannot be read is **never replaced by the env file's value**: that may be the old key the dashboard replaced, or the
   authenticator the owner removed, so the bridge fails closed. Without any stored secret (a pre-OPS2 database) the
   env file's values are used as before.
3. **Rotation** is two steps, each with its own safety: `env-sync.sh --rotate-master-key` (root) moves the current key
   to `SECRETS_MASTER_KEY_PREVIOUS` (the value text moved, never read out; an older previous key is commented out, kept)
   and generates a new one; then `npm run secrets -- rotate-master-key` (the service user, the bridge stopped) takes a
   checked SQLite backup first, then re-seals every row in one transaction. It refuses while the bridge's heartbeat is
   fresh, and changes nothing if any row opens under neither key. Until it has run, the bridge can still read rows
   sealed with the previous key, and says some are pending. env-sync also **refuses to generate a new master key over a
   database that already holds secrets** (it asks the bridge, as the service user, how many there are).
4. **Projects on the dashboard, at runtime.** The projects served are those the env file lists plus those stored with a
   key and not archived. **Adding** is two requests: a check (the key is sent once, from a write-only field; the bridge
   asks LegendKeeper through a throwaway governor of its own, `listProjects` then `listMembers`, and shows the project's
   name, id and the key's role, and the key's last four characters), then a confirmation that names the check (held
   server-side for five minutes, bound to the session, used once), never the key again. Only then is the key stored and
   the project served, with **a new governor of its own, without a restart**. **Replacing** a key accepts only a key
   whose check proves the **same LegendKeeper project**; the stored value is replaced in one statement and the project's
   client is swapped at once (a call already sent finishes with the old key), keeping the **same governor**, so its
   counts, above all the project tier every key of a project shares, carry on. The response reminds the owner to revoke
   the old key in LegendKeeper. **Removing** is refused while the project has unfinished jobs (queued, running,
   waiting, paused) or open proposals (pending, approved, executing); **pause and drain** first makes the project take
   no new work (MCP and dashboard alike) while its running jobs finish. Removal **archives** the project row (its
   history stays readable, read-only, on the dashboard; its name stays taken), deletes its stored key and closes its
   governor. A removed project comes back only under its old name, with a key of the same LegendKeeper project.
5. **The env file's values move across once.** On the first start with a master key, each `LK_PROJECT_<NAME>_API_KEY`
   (once its project id is known), `OWNER_PASSWORD_HASH` and `OWNER_TOTP_SECRET` is imported, recorded in
   `secret_imports` with a domain-separated SHA-256 of the value, logged and audited by name only. A variable is never
   imported twice: after a key is replaced, a project removed or the authenticator removed on the dashboard, the env
   line no longer counts. **When the env file and the store disagree, the stored value wins**, and the dashboard says so
   (`keyConflict`, the Overview's warnings). `LK_PROJECTS`, the per-project keys and `OWNER_PASSWORD_HASH` become
   optional; a listed project without an env key is a warning, not an error.
6. **`env-sync.sh --retire-imported-keys`** comments out the env lines the store now holds. The comparison is the
   bridge's own (`dist/secrets/env-tool.js compare`, run as the service user with an empty environment, as the boot
   check is): `equal` (the stored value decrypts and equals the env value) and `superseded` (the value first imported,
   which the dashboard has since replaced or removed) are retired; `differs`, `not_stored` and `unreadable` are refused
   and named. LK_PROJECTS goes too once no listed project keeps a key line. Only names ever reach the output. Root
   never opens the database or decrypts anything.
7. **Re-authentication for sensitive actions.** Adding, replacing or removing a key, changing the password, and
   enrolling, confirming or removing the authenticator (and new recovery codes) need the owner's password, and the
   authenticator code when one is on, **within the last five minutes** on this session (`auth_owner_sessions.reauth_at`),
   even when signed in; otherwise 403 `REAUTH_REQUIRED`, and the dashboard asks in a dialog and retries. Every such
   request still passes the session, Origin and CSRF checks of every admin change. Re-authentication is counted against
   **the same limits as sign-in** (per address and overall), so it is no way around them.
8. **The owner's account.** The password is changed on the dashboard (the current password is required as well as a
   fresh re-authentication; Argon2id as before); every other dashboard session is signed out, the current one kept. The
   authenticator is enrolled with a QR code drawn **in the browser** (`qrcode-generator`, bundled; inline SVG, no image
   request, no outside service) and the secret shown as text; it is enabled only after a code from the app is checked.
   Ten recovery codes are shown once; each signs in once in place of a code. Removal needs re-authentication with a
   code. The Overview recommends the authenticator strongly while it is off.
9. **Audit and secrecy.** Every action is audited (actor, action, project, the key's last four characters, outcome; never
   a value), including refused key checks and failed re-authentications. Only two responses ever carry a secret, each
   once and marked `shownOnce`: the authenticator secret when enrolment starts, and recovery codes when made.

## Consequences

- The owner adds, re-keys and removes projects, and changes the password and authenticator, without the server's shell;
  the env file keeps the bootstrap secrets (`SESSION_SECRET`, `JWT_SIGNING_KEY`, `SECRETS_MASTER_KEY`) and settings.
- The database now holds encrypted keys. A database backup without the env file reveals none of them; a backup together
  with the env file (or its backups in `/etc/lk-bridge`) reveals everything, as the env file alone did before. Database
  backups taken before a rotation need `SECRETS_MASTER_KEY_PREVIOUS` (kept commented in the env file).
- A stolen dashboard session alone can no longer change a key or the sign-in: it needs the password (and code) again.
  It can still pause and drain a project, which takes no secret and is reversible.
- Losing `SECRETS_MASTER_KEY` loses the stored keys (put the env file's backup back, or add the keys again) and the
  stored password: sign-in then refuses until the key is restored, or until the owner runs `npm run setup:owner`, puts
  its hash line in the env file and runs `npm run secrets -- reset-owner --yes` (audited). The runbook says so.
- `env-sync.mjs` still imports Node built-ins only, never reads a value out and never touches the database; the new
  comparison runs in the bridge, as the service user, like the boot check. The template's markers test now checks the
  master key's marker.
- PLAN-v2 E1: the Google Drive connection for off-server backups should be made through the dashboard (Google's sign-in
  flow) and its token kept in this store, rather than by configuring rclone by hand.
- Tested (`test/secrets/`, `test/ui/account.test.tsx`, env-sync's tests): encryption at rest (the database file, its WAL
  and shared memory scanned for every test secret), associated data, a missing and a wrong master key, the rotation
  round trip with its backup and refusals, add/replace/remove at runtime with governor isolation, refused replacements
  and removals, re-authentication (needed, expiring, rate-limited, CSRF and Origin), the password change signing other
  sessions out, the authenticator with recovery codes, import and stored-key-wins across restarts, no secret in logs,
  responses, events, the audit log, the error table or the HTML, and `--retire-imported-keys` (no value printed,
  mismatches refused).
