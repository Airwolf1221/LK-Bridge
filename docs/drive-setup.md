# Setting up Google Drive for the off-site copy (one-off)

This is the one-off setup in Google Cloud that lets the bridge copy its backups, encrypted, to **your** Google Drive
(v2 E1b, [ADR 0043](adr/0043-google-drive-offsite-copy.md)). It takes about fifteen minutes and you need no Google Cloud
experience. Nothing here costs money: the Google Drive API is free, and the copy counts against your normal Drive storage.

You make your own small "app" in Google Cloud. The bridge then signs in to Drive as that app, with your permission,
through the dashboard. The app can only see the files it creates itself (the `drive.file` permission), never the rest of
your Drive.

Before you start, have to hand:

- the Google account whose Drive should hold the copy (a personal Gmail account is fine);
- the bridge's address: `https://lk.ottomoons.co.uk`;
- your password manager (you will save the client and the encryption keys there).

The redirect address you will need in step 6 is exactly:

```
https://lk.ottomoons.co.uk/admin/drive/callback
```

(For another bridge, it is the bridge's `BRIDGE_PUBLIC_URL` followed by `/admin/drive/callback`. The dashboard's
Off-site copy page shows the exact address with a copy button.)

Google renames things in its console from time to time. The names below are the ones in use in November 2026: the
OAuth set-up is called **Google Auth Platform**, with the pages **Overview**, **Branding**, **Audience**, **Clients** and
**Data access**. If a button has moved, look for the same words.

---

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in with the Google account that will hold the copy.
2. If Google asks you to accept the terms of service, accept them.
3. Click the project picker at the top of the page (it says **Select a project**, or shows a project's name), then
   **New project**.
4. **Project name:** anything you will recognise, for example `LK-Bridge backups`. Leave **Location** as it is
   (**No organisation** for a personal account).
5. Click **Create**, wait for the notification, then make sure the project picker shows your new project. Every step
   below happens inside this project.

Keep this project for as long as you keep the copy. Google gives an app's `drive.file` access to the files **that app**
created; a different project cannot see them (see "If the project is lost" at the end).

## 2. Turn on the Google Drive API

1. In the search bar at the top, type **Google Drive API** and choose it (under _Marketplace_ or _APIs & Services_).
2. Click **Enable**. After a moment the page shows **API enabled** (or a **Manage** button).

## 3. Branding

1. In the search bar, type **Google Auth Platform** and open it. If it shows **Google Auth Platform not configured
   yet**, click **Get started**: the first screens ask for the same things as below.
2. Open **Branding** (left-hand menu) and fill in:
   - **App name:** for example `LK-Bridge backups`. You will see this name when you sign in, so choose one you
     recognise.
   - **User support email:** your own address (pick it from the list).
   - **Developer contact information → Email addresses:** your own address again.
   - **Application home page:** `https://<bridge address>/about` (for the owner, `https://lk.ottomoons.co.uk/about`).
   - **Application privacy policy link:** `https://<bridge address>/privacy` (for the owner,
     `https://lk.ottomoons.co.uk/privacy`).
   - **Authorised domains:** click **Add domain** and enter the bridge's registrable domain, the part you bought, without
     `lk.` (for the owner, `ottomoons.co.uk`). That also covers the redirect address on `lk.` in step 6.
   - Leave the logo empty.

   Both pages are served by the bridge itself, with no sign-in, so Google can reach them. Open them in a private window
   first to check.

   **These are required to publish.** Google will not switch an external app to **In production** until it has a valid
   app name, support email, home page, privacy policy link and authorised domains that cover every link and the
   redirect address. Without them, **Publish app** in step 4 stays greyed out, and the reason appears **only in the
   tooltip** you see when you hover over that button on the **Audience** page ("To publish your app, you must complete
   your configuration on the Branding page").

3. Click **Save** (or **Next** and then **Create**, if you came through **Get started**).

## 4. Audience: External, then publish

1. Open **Audience**.
2. **User type** must be **External**. (A personal Google account can only choose External. If you use a Google
   Workspace account and see **Internal**, External still works; Internal also stops the expiry described below, but
   only for accounts in your Workspace.)
3. Under **Publishing status** it will say **Testing**. Click **Publish app**, then **Confirm**. The status must now
   read **In production**.

**Why this matters.** While an app is in **Testing**, Google lets anything it signs in to keep working for **7 days**
only: the refresh token the bridge keeps expires a week after you connect. The copy would then stop without anyone
touching it. The bridge would notice (the Off-site copy card and the Overview turn red with **Reconnect**), but you
would have to reconnect every week. In production the token does not expire on its own.

**Google does not review these pages** unless you ask it to verify the app, and `drive.file` does not need that. They
only have to be real, reachable pages on a domain you listed.

**Already published with a temporary link?** If you got past this with another address (for example the dashboard's
sign-in page as the home page and privacy policy), nothing breaks. Change the two links to `/about` and `/privacy` in
**Branding** when convenient and save; changing them later does not change the published status.

**No verification is needed.** The app asks for one permission only, `drive.file`, which Google classes as
**non-sensitive**. Publishing an app that uses only non-sensitive permissions needs no review by Google; the Audience page
may still mention verification, which you can ignore. (If you later add a sensitive or restricted permission, Google
would require verification. Do not add any.)

**What you will see when you sign in** (step 7): Google's usual sign-in page, then a consent page saying that
`LK-Bridge backups` (your app name) wants to **"See, edit, create and delete only the specific Google Drive files you use
with this app"**. That is `drive.file`. You will **not** be asked for access to all your Drive, your email or anything
else. Because the app is yours and not verified, Google may show its email address or the line "Google hasn't verified
this app" on some accounts; it is your own app, so you can continue (**Advanced → Go to LK-Bridge backups**). You will not
see a 100-user warning or any review notice: only you sign in.

## 5. Data access: one permission

1. Open **Data access**.
2. Click **Add or remove scopes**.
3. In the list, tick **`.../auth/drive.file`** (the Google Drive API's "See, edit, create, and delete only the specific
   Google Drive files you use with this app"). If it is not listed, paste this into **Manually add scopes** and click
   **Add to table**:

   ```
   https://www.googleapis.com/auth/drive.file
   ```

4. Make sure **nothing else** is ticked (in particular not `.../auth/drive`, which would be all your Drive), then click
   **Update**, then **Save**.

`drive.file` appears under **Your non-sensitive scopes**. The bridge asks for exactly this one permission; if the list
here differs, Google may show extra warnings.

## 6. Clients: a Web application client

1. Open **Clients**, then **Create client**.
2. **Application type:** **Web application**.
3. **Name:** for example `LK-Bridge server` (only you see it).
4. Leave **Authorised JavaScript origins** empty.
5. Under **Authorised redirect URIs**, click **Add URI** and paste exactly:

   ```
   https://lk.ottomoons.co.uk/admin/drive/callback
   ```

   No trailing slash, `https`, the bridge's own host name. Google compares it character by character; a difference
   gives "Error 400: redirect_uri_mismatch" when you connect.

6. Click **Create**. A box shows the **Client ID** (ending `.apps.googleusercontent.com`) and the **Client secret**
   (starting `GOCSPX-`).
7. Copy both into your password manager now, in one entry named for example "LK-Bridge Google Drive client". Google
   shows the secret again only on the client's page, and newer accounts may show it **only once**; if you lose it, add
   a new secret on the client's page and paste that into the dashboard instead.

Changes to the redirect URI can take a few minutes to apply at Google.

## 7. On the dashboard

1. Open the dashboard: `https://lk.ottomoons.co.uk/ui`, then **Off-site copy** in the menu.
2. On the **Google Drive** card, paste the **Client ID** and **Client secret**, then **Save the client**. The dashboard
   asks for the step-up (your authenticator code, or your password without one; ADR 0062) if you have not given it in
   the last ten minutes. The secret is
   kept in the bridge's encrypted secret store, never in the env file, and is never shown again.
3. Click **Connect Google Drive**. Google's sign-in page opens: choose the account from step 1 and allow the access
   described in step 4. Google sends you back to the dashboard, which shows **Connected** and the Google account's name
   and email address.
4. Then set the encryption keys (**Encryption keys** card: generate them, save them in your password manager, and type
   back the last characters to confirm), and press **Copy now**. The runbook's
   [Off-site copy](runbook-deploy.md#off-site-copy-to-google-drive-v2-e1b) section has the full order, including
   installing rclone.

## Keep these off the server

Store all of these together in your password manager. Without them, the Drive copy cannot be restored after losing the
server:

| What                                            | Where it comes from                               |
| ----------------------------------------------- | ------------------------------------------------- |
| `SECRETS_MASTER_KEY`                            | the env file (`/etc/lk-bridge/lk-bridge.env`)     |
| The authenticator's recovery codes              | the Account page, when you made them              |
| The Drive encryption password and salt          | the Off-site copy page, shown once when generated |
| The Google client ID and secret (this document) | step 6                                            |
| The Google account that holds the copy          | step 1                                            |

The encryption keys matter most: Google, or anyone who gets into the Drive account, sees only encrypted files with
encrypted names; without the keys nobody, you included, can read them.

## If something goes wrong

- **"Error 400: redirect_uri_mismatch"**: the redirect URI in step 6 differs from the one on the Off-site copy page.
  Fix it in **Clients → (your client) → Authorised redirect URIs**, wait a few minutes, then connect again.
- **"Access blocked: … has not completed the Google verification process"** or **"Error 403: access_denied"** while the
  app is in Testing: publish it (step 4), or add your own address under **Audience → Test users**. Publishing is the fix
  that lasts.
- **The card turned red: "Reconnect"**: Google refused the bridge's refresh token. Usual reasons: the app was still in
  Testing (7 days passed), you removed the app's access in your Google account (**Security → Your connections to
  third-party apps & services**), you changed the Google password on an account where that revokes tokens, or the client
  secret was reset. Check step 4, then press **Reconnect**.
- **"Error 401: invalid_client"** when connecting: the client ID or secret was mistyped or the secret was reset. Paste
  them again (**Save the client**).

## If the project is lost

Google gives `drive.file` access per app (per Google Cloud project). If you delete this project, a new project's client
cannot see the old copy, even with the same Google account. The files are still in your Drive, and they are still
encrypted with your keys, so they can be recovered with rclone's own Google client (which asks for full Drive access) on
any computer: the runbook's disaster-recovery section explains how. Keeping this project avoids that detour.
