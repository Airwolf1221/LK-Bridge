# ADR 0062: Dashboard sessions for 30 days, Strict cookies, and a step-up for sensitive actions

Status: **Accepted** (the owner, 19 November 2026), with the owner's rule for the step-up: **tightening is one click,
loosening asks** (decisions 5 and 6, as decided). The owner's request after the third review (CR-2026-11-R3): the
dashboard's session ended in well under an hour, where the previous bridge kept it for 30 days.

- Amends: [ADR 0028](0028-secrets-on-the-dashboard.md) and OPS2's re-authentication (docs/auth.md: the password and
  the authenticator code within five minutes); [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) decision 1 (a raise
  still asks and a lowering is still one click; the step-up is now the code within 10 minutes, and every new personal
  access token asks, at any scope); [ADR 0046](0046-e4-owner-decisions.md) decision 3 for the off-site settings (only a
  weakening asked; now every change); chunk 8's F-08 choice of a SameSite=Lax session cookie (docs/auth.md,
  `src/admin/guard.ts`); the default session lifetime (`AUTH_SESSION_TTL_SECONDS`, 12 hours, fixed).

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
   - **a scope raised**: a profile's scope or the default scope raised, a connection moved to a higher scope or to a
     profile at scope `write` (its rails may be weaker), a profile's low-level tools shown or hidden, a safety rail
     switched off (as before; switching one on is one click), a new profile given a scope;
   - **settings**: the bridge's settings (per-operation tools, member administration, contact, journal retention,
     LegendKeeper's limits; read-only switched off), a project's settings (every key, but ChatGPT's file source switched
     off; read-only switched off; undraining), the reserve floors and the writer limit, a maintenance job's switch,
     schedule and the block-id sweep's run size, the off-site settings (every change), the tool-call log's retention,
     the connections' clean-up settings, the audits' configuration, the lifecycle and canon settings; and the bridge's
     write controls released: resuming writes and undraining;
   - **pack approval** (unchanged: approving a version, its sections, tool switches and tokens);
   - **the guarded rails**: approving a proposal that deletes anything, touches more than 10 pages, or deletes or moves
     an asset, judged by the rails' own rules at their defaults on the proposal's operations, however it came to be
     proposed (a rail, a scope, the owner's own request; "Approve selected" asks when any one of them is guarded; a
     restore counts as more than 10 pages, its set not being read there, so approving one asks too); the owner's own
     bulk changes from the dashboard (a retag batch of more than 10 pages, a reconciliation's next batch); deleting a
     restore rehearsal's throwaway root; allowing a staged image's delete (unchanged); and Revert (unchanged).
6. **What stays one click: the tightenings and the brakes** (the owner's rule): lowering a profile's scope or the
   default scope, moving a connection down (or sideways below scope `write`), switching read-only on (the bridge's or a
   project's), switching ChatGPT's file source off, pausing writes and draining (the bridge's or a project's), Sign out
   everywhere, revoking a connection or a token and removing inactive ones, cancelling or pausing a job, switching a
   maintenance job off (except the backups' jobs, unchanged), rejecting a proposal, discarding a staged image that was
   never placed. Reads, dry runs and "Run now" need none.
7. **A failed step-up keeps the owner where they are.** The bridge answers a wrong code or password with
   `401 REAUTH_FAILED` (and a wrong current password with `401 WRONG_PASSWORD`); the dashboard treated every 401 as a
   session that had ended and sent the owner to the sign-in page, losing the change. Those two codes now stay in the
   dialog with their message; any other 401 still means signed out.
8. **The live stream on 401**: when the stream is refused, the dashboard checks its session once (`GET /session`) and,
   signed out, goes to the sign-in page (coming back where it was) instead of reconnecting; the stream's own
   "unauthenticated" event does the same. Signed in (a proxy error, a restart), it opens the stream again three seconds
   later, as before.

## The owner's decisions (19 November 2026)

The rule: **tightening is one click, loosening asks**.

1. Lowering a scope, moving a connection down, switching ChatGPT's file source off and switching read-only on are one
   click again (as ADR 0057 decisions 1 and 7 had them); every off-site setting keeps the step-up.
2. Resuming writes and undraining now ask for the step-up (they release a brake); pausing and draining stay one click.
   The same rule is applied to a project's own switches: its read-only on and its draining are one click, switching
   them off asks.
3. The code alone, as built: with the authenticator set up, the step-up is its code (or a recovery code), without the
   password; without an authenticator it is the password.

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

## Amendment 1: the fourth review's session findings (CR-2026-11-R4)

- Status: **Proposed** (21 November 2026). The fixes make decisions 1, 2, 4 and 5 hold on every route; where they go
  further than the text above, the choice is marked **Chosen** and is the owner's to confirm. No migration, no new
  setting. The review's tests are `test/review/r4-sessions/` (SE-01 to SE-52).
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike, rehearsal or round-trip script. Mocks and fixtures only.

1. **The consent page asks for the step-up too** (SE-02 to SE-04b; decision 5). It is reached with the dashboard's
   session, and it applied a scope raise, a new profile's scope and a connection on a profile at scope `write` with no
   step-up, so a stolen cookie alone gave write-scope OAuth tokens that outlived Sign out everywhere. Now, unless the
   session stepped up within the window, nothing is applied and no code is issued: before a raise (after its "Confirm
   scope change" page), a new profile given a scope above the default for new connections, or a connection on a
   profile at scope `write`, the page "Confirm it’s you" asks for the authenticator code (or a recovery code), or the
   password without one, and goes on with the same pending request once it succeeds (`src/policy/consent.ts`
   `consentStepUp`, applied inside `apply`; `src/auth/routes/authorize.ts`; `src/auth/pages.ts`
   `renderConsentStepUp`). It is counted against the sign-in limits (`OwnerAuth.reauthenticate`), logged
   (`reauth.*`, `consent.step_up_asked`), audited (`owner.reauth`, `via: consent`), and holds for 10 minutes on the
   session, the dashboard included. **Chosen:** an interstitial page in the consent flow (the choice decides whether it
   is needed, and the page has no script); the field is `stepup_totp` or `stepup_password`; a wrong one answers 401 on
   the same page, too many 429 with `Retry-After`; Deny there needs none. An ordinary connection at `read` or `propose`
   and every lowering are not asked (whether every new connection should ask is the owner's decision).
2. **Approving a low-level removal asks** (SE-05 to SE-07). The approval judged a proposal's operations without the
   low-level context the deletes rail used when it made the proposal. `LivePolicyGate.approvalVerdict` now asks when
   the recorded reason (`proposedBecause`) names the deletes, bulk or assets rail, or cannot be read
   (`reasonNamesGuardedRail`: only a reason made wholly of the renames-and-moves rail's hits is let through), and when
   the operations, judged by the rails' own rules at their defaults with the proposal's recorded tool (a low-level
   tool's block and row deletes, list writes that drop entries and text taken off a pack page, read live as at entry;
   a read that fails counts), hit a guarded rail; a judgment that cannot be made asks. The entry rails and the
   approval share one judgment (`judge`); a restore still counts as more than 10 pages at approval (its set is not
   read). **Chosen:** a session already stepped up is not judged at all (no read is made).
3. **A member removal at approval** (SE-12): `removeMember` and `revokeInvite` (`MEMBER_REMOVALS`) are deletes for the
   approval's judgment. At entry they stay as before (refused unless `LK_ALLOW_MEMBER_ADMIN`); whether the deletes rail
   should catch them there too, for an agent at scope `write` with member administration on, is open for the owner.
4. **A project's chronology settings** (SE-16): `PUT /projects/:name/chronology` with `settings` asks for the step-up (a
   project's settings, which the timeline tools write by); `reset: true`, which makes the tools refuse until confirmed
   again, stays one click (a tightening).
5. **An idle open tab no longer keeps its session alive** (SE-42, SE-43; decision 1). The dashboard's own refreshes
   counted as uses. Now every request the dashboard sends without the owner's input carries `X-LKB-Background: 1`, and
   the guard checks such a request as `isLive` does: the session must be live, but its end does not move and its
   cookie is not renewed (`src/admin/guard.ts`, `OwnerAuth.peekSession`). Marked: the refresh timers (Maintenance,
   Budgets, Repository Tree, Asset Tree, Snapshots, Audits, Off-site copy, the chronology check), every reload for a
   live event (`useReloadOn`, and anything a page does in answer to an event), every reload for the stream starting
   afresh (`epoch`), and the session check after the stream drops. **Chosen:** (a) opening the live stream is never a
   use either (an EventSource cannot send a header, and the dashboard opens it again by itself after every drop); (b)
   as a safety net for what no list can name (a part of a page that appears because a refresh brought new data, and
   loads its own), a request sent more than a minute after the owner's last key, click, touch or back-forward (or the
   page's load) is the dashboard's own too (`OWNER_INPUT_MS`); (c) the checks a request makes after the guard (the
   step-up, `GET /security`) no longer count as a second use. The owner's own actions and page loads are uses, as
   before.
6. **Sign out everywhere** (SE-33; decision 4) revokes every session not yet revoked, those already past their end
   included, so none comes back if the server's clock is set back; only the live ones are counted in its answer.
7. **The bounce page is never framed** (SE-40): `X-Frame-Options: DENY` and its own Content-Security-Policy
   (`default-src 'none'`, `frame-ancestors 'none'`), as the bridge's other pages.
8. **The bounce answers top-level navigations only** (SE-49; decision 2). Another site's image, fetch or frame was
   answered with the bounce and set the marker, so the owner's own next link was not bounced. **Chosen:** a request
   that carries `Sec-Fetch-Dest` must say `document` (every browser that sends the Fetch Metadata headers sends it, and
   gives only a top-level navigation that destination, always with `Sec-Fetch-Mode: navigate`); `Sec-Fetch-Mode` is not
   read on its own, because Node's `fetch` sends `cors` whatever it is given; a request without `Sec-Fetch-Dest` is
   answered as before.
9. **A wrong current password is shown** (SE-44; decision 7): `useAction` stays quiet only for a 401 that means signed
   out (`UNAUTHENTICATED`), never for `WRONG_PASSWORD` or `REAUTH_FAILED`.

**Not changed:** resuming a job the owner paused (SE-51) stays one click, as built (decision 6 names pausing a job among
the brakes, not its release); whether releasing it asks, as resuming writes does, is the owner's decision.

**For the owner.** Confirm the choices above (1, 2, 5 (a) to (c), 8), and decide SE-51 and the entry rail for member
removals (3). Two of the review's tests, SE-42 and SE-43, also assert that the idle page sends no request at all
(`firstRequestByItself: null`); the fix makes the session's end stay where it was (`endMovedBy: 0`, the safe behaviour
the tests name), but the page still refreshes, marked, as the live dashboard must (the existing tests of live updates
expect those requests). Those two assertions are left for the reviewer and the owner.

**Tests:** `test/auth/consent-stepup.test.ts` (the consent page's step-up, both factors, the window, what is not asked,
the limits, the carried choice); `test/admin/approval-stepup.test.ts` (the approval's judgment for proposals made by
scope: low-level and high-level removals, list writes that keep or drop, recorded reasons, member removals, a session
already stepped up); `test/auth/background-requests.test.ts` and `test/ui/background.test.tsx` (what is
marked, and that a marked request is checked, not used); `test/policy/mcp.test.ts` (its raise, its new profile at
`write` and its existing `write` profile now step up on the page); `test/e2e/dashboard.spec.ts` (the token is made, and
stepped up, before the proposal is approved, so the approval of that `lk_api_write` replace that drops a block goes
through within the step-up's window).
