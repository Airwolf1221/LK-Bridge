# ADR 0062: Dashboard sessions for 30 days, Strict cookies, and a step-up for sensitive actions

Status: **Proposed** (19 November 2026), built for the owner to confirm. The owner's request after the third review
(CR-2026-11-R3): the dashboard's session ended in well under an hour, where the previous bridge kept it for 30 days.

- Amends: [ADR 0028](0028-secrets-on-the-dashboard.md) and OPS2's re-authentication (docs/auth.md: the password and
  the authenticator code within five minutes); [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) decision 1 (the
  re-authentication of scope raises, now of every scope change) and decision 7 (switching ChatGPT's file source off,
  one click, now a setting like the others); [ADR 0046](0046-e4-owner-decisions.md) decision 3 for the off-site
  settings (only a weakening asked for it; now every change); chunk 8's F-08 choice of a SameSite=Lax session cookie
  (docs/auth.md, `src/admin/guard.ts`); the default session lifetime (`AUTH_SESSION_TTL_SECONDS`, 12 hours, fixed).

## Context

The owner signs in on the dashboard and keeps it open. The shipped session lasted a fixed 12 hours from sign-in; the
owner's ended within the hour (an `AUTH_SESSION_TTL_SECONDS` set lower in the env file is the likely reason: sessions are
kept in the database under a plain SHA-256 of the token, so a restart does not end them). When it ended, the dashboard's
live stream kept reconnecting every three seconds and was refused each time (`401`, from 17:00:51 in the owner's log),
with nothing on the screen saying to sign in again. Meanwhile the sensitive actions asked for the password and the
authenticator code within five minutes, but only some of them did.

## Decision

1. **A sliding 30-day session.** A session lasts 30 days from its last use (`AUTH_SESSION_TTL_SECONDS`, default now
   2,592,000; still 5 minutes to 30 days): each signed-in request of the dashboard (its API, its pages) and of the
   consent page moves its end to 30 days ahead (at most once a minute, with its "last seen"), and the cookie's `Max-Age`
   is renewed with it. The live stream's periodic check does not count as a use, so an idle open tab does not keep a
   session alive by itself. There is no other end but sign-out, "Sign out everywhere", a password change (the other
   sessions) or 30 days unused. An explicit, lower `AUTH_SESSION_TTL_SECONDS` in the env file still wins: remove it to
   get 30 days.
2. **The cookie**: `HttpOnly`, `Secure` (and the `__Host-` prefix: this exact host, path `/`, HTTPS), and now
   **`SameSite=Strict`** (was `Lax`). A cross-site navigation does not carry a Strict cookie, and three pages are reached
   that way: the OAuth consent page (Claude's redirect to `/oauth/authorize`), the Google Drive sign-in's return
   (`/admin/drive/callback`) and a link to the dashboard from another site. Each answers such a navigation that arrives
   without the cookie with a tiny page of the bridge's own that opens the same address again, from the bridge (a
   same-origin navigation, which carries it): the owner signed in sees the page as before, never signed out by it. A
   page with no session even then asks to sign in, as before. The sign-in form's own cookie is Strict too. Never twice in
   a row: the bounce sets a 30-second `SameSite=Lax` marker (`__Host-lkb_bounced`), and a request that carries it is
   answered as it would have been without the bounce, so a browser that still called the second navigation cross-site
   cannot loop (at worst it shows the sign-in page).
3. **Sessions are kept on the server** (as before: `auth_owner_sessions`, the token's SHA-256, never the token): they
   survive a restart, and each can be revoked. The Account page shows how many are active.
4. **"Sign out everywhere"** (the Account page; `POST /api/admin/security/sessions/revoke-all`): every owner session ends,
   this one included, and the dashboard goes to the sign-in page. It removes access only, so it needs no step-up
   (CSRF and Origin, as every change). Event `logout.everywhere`; audit `owner.sessions_revoked`.
5. **A step-up for sensitive actions**: the authenticator code (TOTP; or a recovery code) on this session within the
   last **10 minutes** (was the password and the code, within 5), or the password when no authenticator is set up.
   With the authenticator set up, the password alone is refused. Asked in a dialog when an action needs it, which then
   goes on (`403 REAUTH_REQUIRED`; the dashboard's API layer now asks for every change, not only those its pages
   wrapped, and changes refused together wait for one dialog). The step-up is counted against the sign-in limits (5 an
   address and 30 in all per 15 minutes), as before. Required for:
   - **keys and secrets**: a project's API key (add, replace, check, remove), a personal access token (at any scope),
     the off-site copy's keys and Google client, the owner's password and authenticator (unchanged; the password change
     still asks for the current password too);
   - **scope changes**: a profile's scope (any change, a lowering too), its low-level tools and safety rails, a new
     profile given a scope, a connection moved to another profile (up, sideways or down), the default scope;
   - **settings**: the bridge's settings (read-only, per-operation tools, member administration, contact, journal
     retention, LegendKeeper's limits), a project's settings (every key, ChatGPT's file source included), its read-only
     and draining switches, the reserve floors and the writer limit, a maintenance job's switch, schedule and the
     block-id sweep's run size, the off-site settings (every change), the tool-call log's retention, the connections'
     clean-up settings, the audits' configuration, the lifecycle and canon settings;
   - **pack approval** (unchanged: approving a version, its sections, tool switches and tokens);
   - **the guarded rails**: approving a proposal that deletes anything, touches more than 10 pages, or deletes or moves
     an asset, judged by the rails' own rules at their defaults on the proposal's operations, however it came to be
     proposed (a rail, a scope, the owner's own request; "Approve selected" asks when any one of them is guarded; a
     restore counts as more than 10 pages, its set not being read there, so approving one asks too); the owner's own
     bulk changes from the dashboard (a retag batch of more than 10 pages, a reconciliation's next batch); deleting a
     restore rehearsal's throwaway root; allowing a staged image's delete (unchanged); and Revert (unchanged).
6. **What stays one click** (they take access or work away, and are the owner's brakes): Sign out everywhere; revoking a
   connection or a token and removing inactive ones; the bridge's write controls (pause, resume, drain, undrain);
   cancelling or pausing a job; switching a maintenance job off (except the backups' jobs, unchanged); rejecting a
   proposal; discarding a staged image that was never placed. Reads, dry runs and "Run now" need none.
7. **A failed step-up keeps the owner where they are.** The bridge answers a wrong code or password with
   `401 REAUTH_FAILED` (and a wrong current password with `401 WRONG_PASSWORD`); the dashboard treated every 401 as a
   session that had ended and sent the owner to the sign-in page, losing the change. Those two codes now stay in the
   dialog with their message; any other 401 still means signed out.
8. **The live stream on 401**: when the stream is refused, the dashboard checks its session once (`GET /session`) and,
   signed out, goes to the sign-in page (coming back where it was) instead of reconnecting; the stream's own
   "unauthenticated" event does the same. Signed in (a proxy error, a restart), it opens the stream again three seconds
   later, as before.

## For the owner to confirm

- **Lowering is asked for too.** Your list said "scope changes" and "settings", so lowering a scope, moving a connection
  down, switching ChatGPT's file source off, switching read-only on and every off-site setting now ask for the code,
  where ADR 0057 decisions 1 and 7 and ADR 0046 decision 3 had kept them one click as safety actions. The immediate
  brakes (pause writes, revoke a connection, Sign out everywhere) stay one click. If you want the lowerings one click
  again, say so: it is one condition per route.
- **Resuming writes and undraining stay one click** (operational controls, not settings).
- **The code alone.** With the authenticator set up, the step-up is its code (or a recovery code), without the
  password, as you asked; without an authenticator it is the password.

## Alternatives

- A fixed 30-day session (no sliding): the owner would be signed out mid-work once a month. Not chosen.
- Keep `SameSite=Lax`: the cookie would ride on any top-level navigation from another site (a link); the owner asked
  for `SameSite=Strict`. The bounce keeps the three cross-site entries working without it.
- A step-up of the password and the code (as OPS2): stronger only against someone holding the authenticator but not
  the password, and slower for every sensitive action. The owner asked for the code.

## Consequences

No migration (`expires_at` is updated in place). Tests: `test/auth/sessions-r3.test.ts` (sliding, the env file's lower
lifetime, survival of a restart, the cookie, Sign out everywhere, the step-up's factors and window, what needs it and
what stays one click, guarded and plain approvals, the bounces) and the dashboard's own (`test/ui/sessions.test.tsx`:
the refused stream, the dialog, Sign out everywhere; `test/ui/live.test.tsx`: the refused stream in the whole
dashboard) and, in a real browser, `test/e2e/dashboard.spec.ts` ("ADR 0062: a link from another site opens the
dashboard signed in": Chromium sends no Strict cookie on the cross-site arrival, which is bounced once, and sends it on
the bounce's same-origin one; the writer limit and a new token ask for the step-up in the dialog). The tests that
asserted the old rules (a lowering one click, five minutes, SameSite=Lax, 12 hours) now assert these. docs/auth.md,
docs/dashboard.md and `.env.example` say so.
