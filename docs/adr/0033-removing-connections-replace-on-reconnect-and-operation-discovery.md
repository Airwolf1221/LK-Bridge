# ADR 0033: Removing connections, replace on reconnect, and operation discovery without the low-level tools

Status: Accepted (hotfix, 10 November 2026; found by the owner while testing C1 and B2). Migration 1400 is this
hotfix's. Amends [ADR 0019](0019-consent-keeps-existing-scope.md) (the preselected scope) and fills a gap in
[ADR 0029](0029-discover-and-read-tools.md) (operation discovery when the low-level tools are hidden). No decision in
PLAN.md or PLAN-v2.md is changed. (There is no ADR 0032 in the repository; this number was assigned by the brief.)

## Context

The owner tested C1 (`write_page`) and the B2 "Show low-level tools" setting on 10 November and found five problems.

1. **Connections pile up.** Every approval in claude.ai or ChatGPT issues a new OAuth grant. Disconnecting in the client
   throws away the client's copy of the token, but the bridge is never told, so the old grant stays `active` until its
   family expires after 90 days. The dashboard showed three active Claude grants and two active ChatGPT grants. Revoked
   and expired rows could not be removed.
2. **The consent page misleads.** The new-profile label and kind were always visible, and the scope radios were
   preselected from the _suggested_ profile and did not follow the "Use profile" menu, so the owner concluded "Use profile
   does nothing". The server side was right (only `profile=new` creates a profile).
3. **Dates without a year.** `fmtTime` printed day, month and time only: the revoked "Claude Code (PC)" PAT read
   "created 8 Nov, expires 3 Nov". Its expiry is 3 November **2027** (360 days; confirmed from `auth_pats.expires_at` in a
   test fixture, not assumed).
4. **Operation discovery was broken when the low-level tools are hidden.** A profile that cannot see
   `lk_api_list_operations` can still run every operation, but the `UNKNOWN_OPERATION` error pointed at that tool. Claude
   guessed `appendDocumentBlocks`; the real operation is `insertBlock`.
5. **claude.ai caches a connector's tool list**, so the setting took effect only after a disconnect and reconnect.
6. (Addendum, same day.) **A conflicted proposal could not be rejected.**

## Decisions

1. **Remove by deleting, with tombstones, not by hiding rows.** Only a revoked or expired connection can be removed
   (`409 CONNECTION_ACTIVE` otherwise). One transaction deletes the credentials (a grant's `auth_token_families` row and
   every `auth_refresh_tokens`, `auth_access_tokens` and `auth_codes` row of the family, by name even where a foreign key
   would cascade; a PAT's `auth_pats` row), writes a `removed_connections` tombstone (id, type, label, client, profile id
   and label, created, revoked, expires, removed at, removed by `owner` or `system`) and the audit row
   `connection.remove` (`before`: the tombstone fields, `after`: `null`). `auth_clients` is never touched. Hiding rows was
   rejected: a hidden-but-present credential row is still a credential, still has to be pruned, and makes "revoked" mean two
   things. Deleting keeps the secret-bearing tables small, and the tombstone keeps exactly what history needs.
2. **History names removed connections from the tombstone.** The journal, proposals, jobs, errors and audit log keep the
   principal id as plain text. A single resolver (`PolicyStore.describePrincipals`: the live connection, else the
   tombstone, else "Removed connection"; `system` is "System") feeds the admin API (`principals` beside the rows of the
   journal, proposals, jobs and error responses) and `bridge_journal_lookup` (a `principal` name), which show for example
   "ChatGPT (removed 10 Nov 2026)". Nothing shows a bare id, an empty name or an error because a connection was removed.
3. **The auth prune no longer deletes grants.** It used to delete token families silently (30 days after a revocation, one
   day after an expiry), which would have left history with no tombstone and made the owner's "never" setting a lie.
   Only the owner (single, bulk) and the daily `connection-removal` maintenance sweep remove a connection.
4. **Automatic removal and staleness are settings** in `policy_settings`: `connections.auto_remove_days` (default 30,
   0 = never; the day count starts at `revoked_at`, or `expires_at` for a connection that expired without being revoked)
   and `connections.stale_after_days` (default 14, 0 = never; last use, or creation if never used). Both are owner commands
   and audited. A "stale" badge and a per-profile "Revoke stale (N)" (confirmed, audited `via: 'stale'`) make stale
   connections easy to spot and revoke.
5. **Revocation at token issue, not at approval.** The consent page lists the same application's active grants (all ticked
   by default). The ticked ids are stored on the authorisation code (`auth_codes.replaces`, a JSON array, migration
   1400). Only when the `authorization_code` grant succeeds at the token endpoint, inside the transaction that stores the
   new grant, each listed grant is re-checked (still active, still the same application) and revoked with
   `revoked_reason = 'replaced by <new family id>'`, audited `connection.revoke` with `via: 'replaced'`. If the
   exchange never happens or fails, nothing is revoked: the old connection keeps working until the new one exists. The
   access token is now signed before anything is stored, so a signing failure cannot leave a half-issued grant. The ids
   submitted by the form are intersected with those offered at approval; they are never trusted.
6. **"The same application".** A Client ID Metadata Document client is one application: the same `client_id`. Any other
   client (a DCR registration gets a new `client_id` each time) is the same application when its redirect origin matches
   the origin of the verified redirect URI of the request. The client's self-reported name never decides it. A loopback
   address (Claude Code) compares scheme and host and ignores the ephemeral port, as the redirect rules do (RFC 8252
   §7.3): comparing ports would never match two Claude Code sessions. (This is the one place the brief's "origin" is read
   as "origin, with the loopback port ignored"; the owner can untick any connection.)
7. **The `keep` scope.** The first scope radio is "Keep the chosen profile's current scope" (`keep`), preselected whichever
   profile is chosen. On the server `keep` is the chosen existing profile's current scope, or the default scope for a new
   profile, so it never differs from the profile and never asks for the F-15 confirmation; choosing read, propose or write
   explicitly still does. CSRF, the F-15 token and the "profile still exists" re-check are unchanged. The new-profile
   fields are shown only when "New profile…" is selected, with CSS `:has()` inside `@supports selector(:has(*))`; the auth
   pages run under a CSP with no script and no nonce mechanism (ADR 0014), so no script was added, and a browser without
   `:has()` shows the fields under "Only for New profile…".
8. **Dates carry the year when it is not the current one** (`fmtTime`: "3 Nov 2027, 02:12:35"; British English, 24-hour,
   `en-GB`). The server-rendered pages always show it (consent connection list, "removed 10 Nov 2026").
9. **A generated Operations section.** `get_bridge_guide` (and the MCP resource) appends, at serve time, an "Operations"
   section generated from the registry: every operation id grouped by tag with kind and risk, one line each, no schemas.
   It cannot go stale, and a test checks all 89. `UNKNOWN_OPERATION` (in `lk_api_read`, `lk_api_write`,
   `lk_api_describe_operation`, `lk_api_paginate_all` and `lk_api_batch`, which now refuses the whole batch up front,
   naming the call) suggests up to 5 close ids by verb (the same verb, or a synonym: append, add, create → insert; edit,
   set → update; remove → delete; fetch → get or list), shared nouns and case-insensitive edit distance, and names
   `lk_api_list_operations` / `lk_api_describe_operation` only when the caller's profile shows the low-level tools; otherwise
   it points at `get_bridge_guide` (Operations) and Clients & Access. E3 (the tool review) still makes the final decision on
   which tools are visible; this hotfix only closes the discovery gap the hidden tools left.
10. **Tool-list caching is documented, as observed.** On the Clients & Access page beside the checkbox and scope selector,
    in `docs/policy.md` and in the bridge guide: claude.ai needs a disconnect and reconnect for a visibility change (observed
    on 10 November 2026, not a guarantee); ChatGPT uses Plugins, the bridge, Refresh.
11. **Rejecting conflicted proposals (addendum).** `ProposalService.reject` accepts `pending` or `conflicted` as one
    compare-and-set from those two states; the audit row's `before` records the actual state; any other state is refused with
    "Proposal … is X; only pending or conflicted proposals can be rejected"; `bulkReject` follows. A rejected conflicted
    proposal keeps its `conflict` details, gets the reason, `decided_by: 'owner'` and `finished_at`, appears in History, and is
    prunable after the retention like any rejected proposal. It was stuck before: the dashboard told the owner to reject it,
    `reject` allowed only `pending`, and `proposal-prune` never deletes `conflicted`.

## Consequences

- A reconnect can replace the old connection in one click, and dead ones can leave the dashboard, automatically after 30
  days by default, without making history anonymous.
- Existing connections that the old prune already deleted have no tombstone and read "Removed connection" (the profile is
  still shown next to it).
- Migration 1400: `removed_connections` and `auth_codes.replaces`. Deploy normally; `--update-self` is not needed (no change
  to `deploy/lib.sh` or the unit file).
- New audit actions: `connection.remove`, `connection.revoke` with `via: 'replaced'` or `'stale'`,
  `policy.set_auto_remove_days`, `policy.set_stale_after_days`. New maintenance job `connection-removal` (daily, 04:00).
- Tests: `test/policy/connections.test.ts`, `test/policy/replace.test.ts`, `test/policy/mcp.test.ts` (consent),
  `test/tools/discovery.test.ts`, `test/ui/units.test.ts`, `test/policy/proposals.test.ts`, `test/pages/proposals.test.ts`,
  `test/maintenance/jobs.test.ts`.
