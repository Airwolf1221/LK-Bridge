# ADR 0009: Refresh-token grace window

Status: Accepted (chunk 4 follow-up, 7 November 2026). Supersedes the "no grace window" clause of ADR 0007. Recorded in PLAN amendment 4.

## Context

ADR 0007 made refresh-token reuse detection strict: presenting a rotated refresh token revoked the whole grant. Claude refreshes both proactively (up to five minutes before expiry) and reactively (on a 401), so two refreshes carrying the same token are realistic. Under the strict rule the slower one revokes the grant and the user has to sign in again.

## Decision

- `AUTH_REFRESH_GRACE_SECONDS` (default 10, range 0 to 60; 0 disables the window).
- When a refresh rotates a token, the bridge keeps the response it issued (the new access token and the new refresh token) **in process memory only**, keyed by the hash of the rotated-out token, for the grace window. The entry is created synchronously in the same tick as the rotation, so a concurrent request always finds it.
- Within the window, presenting the rotated token returns that **same** response, so both callers hold the same successor and the grant stays intact. Only if the same client presents it, and neither the grant nor the successor has been revoked in the meantime. Logged as `token.refresh_replayed`.
- Outside the window, or from another client, reuse still revokes the whole grant (`token.reuse_detected`) and answers `invalid_grant`.
- Nothing extra is written to the database: plaintext tokens never touch disk, and they stay in memory for at most the window. A restart inside the window forgets the entry, so a replay just after a restart is treated as reuse.

## Consequences

- A stolen refresh token used within ten seconds of the legitimate rotation, by the legitimate client id, would receive the same tokens the legitimate client received, and would not trigger revocation. Public clients make the client id guessable, so this narrows reuse detection to replays more than ten seconds apart. That is the accepted trade-off; set the window to 0 to restore strict detection.
- Tests: `test/auth/grace.test.ts` (concurrent and delayed replays, revocation outside the window, another client, a revoked grant, window disabled).
