# ADR 0019: Consent keeps an existing profile's scope unless the owner confirms a change

Status: Accepted (v1.0.1, 8 November 2026; decided by the owner). Amends [ADR 0012](0012-live-policy-evaluation.md)
decision 4 and the chunk 2b consent rule in [docs/policy.md](../policy.md) ("the preselected scope is always `read`").
Closes review finding F-15 ([docs/review/2026-11-hardening.md](../review/2026-11-hardening.md)).

## Context

The consent page preselected `read` for every choice. A profile's scope applies to every connection on it (ADR 0012),
so re-approving a connection on an existing profile at `write` (for example when ChatGPT reconnects) and pressing
Approve without touching the selector lowered that profile, and every other connection on it, to `read`. Fail-safe but
surprising, and it hid a profile-wide change behind a default.

The auth pages run under a CSP with no script (ADR 0014), so the page cannot move the scope selector when the owner
picks another profile in the list: whatever is preselected for the suggested profile is what a browser submits for any
profile unless the owner changes it.

## Decision

1. **An existing profile's current scope is preselected.** When the suggested profile exists, the page selects it and
   checks its current scope, marked "(its current scope)". Approving without touching anything changes nothing and
   writes no audit row.
2. **A new profile still starts at the configured default scope** (`read` out of the box; `setDefaultScope` changes
   it). New connections therefore still default to `read`, as ADR 0012 decision 4 says, unless the owner chooses
   otherwise.
3. **Any change to an existing profile's scope is confirmed on a second page.** If the submitted scope differs from the
   chosen existing profile's current scope, nothing is changed: the bridge answers with a confirmation page that shows
   the warning that the change affects every connection on that profile (with the number of active connections), names
   the change (`from` → `to`, raise or lowering), and offers **Change to … and approve** or **Keep … and approve**.
   Only a form carrying `confirm_scope_change=<profileId>:<current scope>:<new scope>` for exactly that change applies
   it (audited `profile.set_scope`, `via: consent`, as before). The token names the scope the profile has now, so a
   profile changed elsewhere in the meantime asks again. The authorisation request is not used up until the owner
   decides.
4. The confirmation covers the case decision 1 cannot: the owner picks a different existing profile in the list and
   leaves the scope as preselected for the suggested one. That never changes the other profile silently.

## Consequences

- Reconnecting ChatGPT or Claude keeps their profile's scope without any extra step.
- Raising or lowering a profile at consent takes one more click, on a page that says exactly what changes.
- The confirmation is an ordinary form post to `/oauth/consent` with the same CSRF token; no script is needed and the
  CSP is unchanged. The auth log gains `consent.scope_change_confirm` (ids and scope names only).
- Tests: `test/policy/mcp.test.ts` › "consent keeps an existing profile's scope unless the owner confirms a change"
  (untouched re-approval unchanged and unaudited; explicit lower and raise confirmed and audited; stale or foreign
  confirmation tokens ask again; "Keep" changes nothing; switching profiles never carries the scope over; a new profile
  defaults to `read` and follows the configured default).
