# ADR 0012: Policy attaches to profiles and is evaluated live

Status: Accepted (chunk 2b, 7 November 2026). Adds to PLAN §8 page 8 and §9.6; no PLAN decision is changed.

## Context

PLAN v1 had one kind of connection: anything that completed OAuth consent or held a PAT could do everything the bridge
offers. With ChatGPT added (amendment 1) and more than one agent working on the same LegendKeeper project, the owner
needs to say what each connection may do, change it later, and have agents propose writes rather than make them.

Two places could hold the permission: the token (a claim or a column on the token row, fixed at issue) or something
the token points to and that is read on every call.

## Decision

1. **Identity comes from the server-issued token only.** A bearer token resolves to its grant (OAuth token family) or
   PAT; `clientInfo`, client names and any profile name the caller supplies are labels only.
2. **Policy attaches to a profile**, not to a token. Every grant and PAT points at one profile; refresh and access
   tokens inherit the grant's. The owner picks the profile and its scope at consent (or with the PAT command), and can
   change either later.
3. **Evaluated live.** The engine's policy gate reads the principal's profile and scope on every entry, reads
   included, with a cache of at most one second that any change made through the bridge clears at once. Tool lists are
   built per request in the same way. Nothing about permissions is baked into a token.
4. Three scopes: `read`, `propose` (writes become proposals the owner approves in the dashboard), `write`. New
   connections default to `read`.
5. Approving a proposal runs its operations with the proposer as principal and an internal, single-use approval token
   that only the owner command layer can obtain; the owner's approval wins over the proposer's current scope.

## Consequences

- Lowering a scope (or revoking) takes effect on the next call of every existing connection, without waiting for
  access tokens to expire (up to an hour) or for clients to reconnect. Raising one does too.
- A changed scope applies to every connection on the profile; the consent screen says so.
- One indexed read per call (or per second per principal). Negligible next to a LegendKeeper call.
- A change made outside the bridge process (the PAT CLI, a manual SQL edit) is seen within one second.
- Tokens issued before this chunk keep working, under a `legacy` profile at `read` (migration 0300).
- Tests: `test/policy/gate.test.ts` (scope matrix from the registry, live changes), `test/policy/mcp.test.ts`
  (an existing token's tool list and gate decision change after a scope change).
