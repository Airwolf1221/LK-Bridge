# Identity, scopes and proposals (chunk 2b)

Every connection to `/mcp` acts **for a principal under a profile**, and the profile's **scope** decides what it may do.
The owner sets both, at consent or later in the dashboard. Writes from a connection at scope `propose` become
**proposals** that the owner approves or rejects; nothing is sent to LegendKeeper until then. The design decision that
scopes are evaluated live is [ADR 0011](adr/0011-live-policy-evaluation.md).

Code: `src/policy/` (entry point `src/policy/index.ts`). Tests: `test/policy/`.

## The model

| Term          | What it is                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Principal** | Who a request acts for: an OAuth grant (`grant_…`, one consent for one client) or a personal access token (`pat_…`).               |
| **Profile**   | A named policy bundle (`agent_profiles`): `label` (unique), `kind` (`claude`, `chatgpt`, `claude-code`, `other`) and `scope`.      |
| **Scope**     | `read`, `propose` or `write`. Attached to the profile, never to a token.                                                           |
| **Owner**     | The only authority. Chooses profile and scope at consent; changes them, approves and rejects proposals in the dashboard (chunk 5). |

- **Identity comes from the server-issued token only.** The bearer token resolves to its grant or PAT; the grant or
  PAT points at its profile. MCP `clientInfo`, a client's registered name and the profile name a caller might claim
  are display labels and never decide anything.
- Every grant and PAT has exactly one profile (`profile_id`, migration `0300_policy_init.sql`). Refresh and access
  tokens inherit the grant's profile. Grants and PATs from before this chunk were moved to a profile named `legacy` at
  scope `read`.
- New profiles get the **default scope for new connections**, `read` unless the owner changes it
  (`setDefaultScope`).

## Scopes

| Scope     | Reads | Writes (every non-read operation)                                                                     |
| --------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `read`    | allow | denied: `PolicyDeniedError` saying the connection is read-only and that the owner can change it       |
| `propose` | allow | captured as a proposal; the agent gets `{ status: 'proposal_captured', proposalId, summary }`         |
| `write`   | allow | run, within every existing guard (read-only mode, pause, If-Match, unsupported blocks, cascade, etc.) |

- Member and invite administration (`inviteMember`, `removeMember`, `revokeInvite`) is denied for every agent, at any
  scope, unless `LK_ALLOW_MEMBER_ADMIN=true`.
- The `system` principal (internal and dashboard work) is always allowed, except on an MCP origin, where it could only
  mean a tool forgot to pass the caller: denied.
- Unknown, revoked or expired principals are denied, reads included.
- **Live evaluation.** The gate reads the principal's profile and scope from the database on every engine entry
  (cached for at most one second; any change made through the bridge clears the cache at once). Changing a profile's
  scope changes what every existing connection on it can do on its very next call, with no reconnection.

### Tool lists

`tools/list` is built per request: a principal at `read` sees only tools with `access: 'read'`; at `propose` and
`write` it sees every tool (at `propose`, a write tool returns the proposal result). A tool without `access` counts as
`write` unless it is annotated `readOnlyHint: true`. The list is a convenience, not the control: a write tool called
by a `read` connection is refused at call time, and the policy gate refuses the write in the engine whatever the tool
says about itself (defence in depth; `test/policy/mcp.test.ts`).

Tool handlers get `ctx.principal` (and `ctx.scope`). Tools that call the job engine must pass the principal as
`origin.principal`; `mcpOrigin(ctx, tool)` builds that origin and throws if the request has none.

## The proposal lifecycle

```
             capture                  approve (CAS)            re-read OK, submitted       job succeeded
 agent ──────────────▶  pending  ─────────────────▶ approved ───────────────────▶ executing ───────────▶ executed
                          │  │                         │                              │
                reject    │  │ expiry (timer)          │ a target changed             │ job failed / cancelled
                          ▼  ▼                         ▼                              ▼
                     rejected expired              conflicted                       failed
```

**Capture** (the `ProposalSink`, when the gate returns `propose`):

1. Params are validated against the registry schema.
2. The guards that do not write are dry-run: cascade confirmation, member admin, and the unsupported-block guard
   (against the current document).
3. Each operation's target is read through the engine, so through the governor at the caller's priority, and its
   LegendKeeper version, a SHA-256 fingerprint and the pre-state (up to 512 KB, for the diff) are stored. Creates with
   a client id have no target. Nothing but these reads reaches LegendKeeper.
4. The ordered operations are stored as **one** proposal, however many there are. It expires after 14 days
   (`POLICY_PROPOSAL_EXPIRY_DAYS`); a timer (`POLICY_EXPIRY_SWEEP_SECONDS`, default 5 minutes) expires due proposals.

**Approve** (owner only):

1. Refused, leaving the proposal `pending`, while the bridge is read-only, writes are paused or it is draining; and
   for an expired proposal.
2. Compare-and-set `pending → approved`: a double click or a retry cannot approve twice.
3. Every target is read again and compared with the capture (the version where there is one, else the fingerprint).
   Any difference ends `conflicted`, naming the operation; nothing is executed.
4. The operations go to the engine as one `batch_ops` job, stop on error, with the **proposer** as principal,
   `approvedBy: 'owner'` and an internal approval token. A versioned write whose captured version is known, and that no
   earlier operation of the same proposal touches first, is pinned to that version as `If-Match`, so LegendKeeper
   refuses it if the document changed after the re-read. Every guard runs again at execution.
5. The proposal follows its job: `executed`, or `failed` with the job id and progress (a partial failure leaves the
   earlier steps applied, as any stop-on-error batch does; the job and journal show which).

**Approval cannot loop.** The engine asks the gate about every entry, so the proposer's `propose` scope would turn
the approved batch into a new proposal. The proposal service therefore attaches an **approval token** to that one
submission. The gate allows an operation only if the token was minted by `src/policy/approval.ts` (checked by object
identity, so look-alikes are worthless), has not been used or expired, belongs to the same principal, and covers
exactly that step (operation id and params hash, in order) of a proposal that is now `approved`. The owner's explicit
approval wins even if the proposer's scope has since been lowered; member-admin refusal and read-only mode still apply.
`approvedBy`, or a token the gate does not recognise, arriving from anyone else is refused outright. The token minting
function is not exported from `src/policy/index.ts`.

**After a crash.** On start, a proposal left `approved` either reached the engine (its job is found by the origin it
was submitted with, `detail: proposal:<id>`, and the proposal follows it; the engine resumes the job itself) or did
not (it returns to `pending`; nothing was sent; the owner approves again). A proposal left `executing` follows its job.

**Reject** (owner only) takes an optional reason, which the agent can read.

### Agent-facing tools

Both are read tools (`access: 'read'`, `readOnlyHint: true`) restricted to the caller's own proposals (by principal);
another principal's proposal is reported exactly as if it did not exist.

| Tool                     | Input                                | Returns                                                                                                             |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `bridge_proposal_status` | `{ proposalId }`                     | state, summary, operation count, times, the rejection reason, the job id, the conflicting operation, the error text |
| `bridge_proposals_mine`  | `{ state?, limit? (1-50, def. 20) }` | the same, newest first                                                                                              |

No MCP tool can change a scope, approve or reject a proposal, or create or revoke a token
(`test/policy/no-agent-escalation.test.ts` calls every registered tool with hostile arguments and checks).

## Owner commands

`createPolicy(...).commands` (`src/policy/commands.ts`): plain functions for chunk 5's dashboard routes, which must
authenticate the owner (session cookie and CSRF) first. Each takes `actor: 'owner'` as its first argument (typed, and
checked at run time). Every change writes an `audit_log` row (`at`, `actor`, `action`, `target`, `before`, `after`) and
emits a `policy` event on the engine's event emitter; proposal state changes also emit `proposal` events.

| Command                                                      | What it does                                                                              | Audit action                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `listProfiles(actor)`                                        | Profiles with their count of active connections                                           | –                                                |
| `createProfile(actor, { label, kind, scope? })`              | New profile (default scope unless given)                                                  | `profile.create`                                 |
| `setScope(actor, profileId, scope)`                          | Changes a profile's scope; applies at once to its connections                             | `profile.set_scope`                              |
| `getDefaultScope(actor)`, `setDefaultScope(actor, scope)`    | The scope new profiles get                                                                | `policy.set_default_scope`                       |
| `listGrantsAndPats(actor)`                                   | Every grant and PAT with profile, scope, last use, expiry and revocation                  | –                                                |
| `setConnectionProfile(actor, id, profileId)`                 | Moves a grant or PAT to another profile (for example out of `legacy`)                     | `connection.set_profile`                         |
| `revoke(actor, id)`                                          | Revokes a grant (its refresh and access tokens) or a PAT                                  | `connection.revoke`                              |
| `listProposals(actor, filter?)`                              | By state, principal, profile, before; newest first                                        | –                                                |
| `getProposal(actor, id)`                                     | With each operation's params, pre-state, proposed state, changes, lost unsupported blocks | –                                                |
| `approve(actor, id)`                                         | As above; resolves with the proposal (`executing` or `conflicted`)                        | `proposal.approve` (then `proposal.executed`, …) |
| `reject(actor, id, reason?)`                                 |                                                                                           | `proposal.reject`                                |
| `bulkApprove(actor, ids)`, `bulkReject(actor, ids, reason?)` | One at a time, in order; a result per id                                                  | as above                                         |
| `listAudit(actor, filter?)`                                  | The audit log, newest first                                                               | –                                                |

The system writes its own rows with actor `system`: `proposal.conflicted`, `proposal.executed`, `proposal.failed`,
`proposal.expired`, `proposal.approval_reverted` and `proposal.approval_interrupted`. Read-only commands are not
audited.

Errors are `PolicyError` with a stable `code`: `NOT_OWNER`, `INVALID_INPUT`, `PROFILE_EXISTS`, `PROFILE_NOT_FOUND`,
`CONNECTION_NOT_FOUND`, `PROPOSAL_NOT_FOUND`, `INVALID_TRANSITION`, `PROPOSAL_EXPIRED`, `BRIDGE_READ_ONLY`,
`WRITES_PAUSED`, `DRAINING`, `NO_ENGINE`, `REREAD_FAILED`.

## Consent and PATs

- **Consent** (chunk 4's screen): after sign-in the owner sees the redirect host in large type, the client's
  self-reported name marked _untrusted name_ (HTML-escaped), and chooses an existing profile or a new one (label and
  kind) and its scope. The suggestion comes from the redirect host only: `claude.ai` and `claude.com` → `claude`,
  `chatgpt.com` → `chatgpt`, loopback → `claude-code`, anything else → `other`. An existing profile with the
  suggested label is preselected; otherwise "New profile" with that label. The preselected scope is always `read`.
  Choosing a scope for an existing profile changes that profile (audited, `via: consent`). A bad choice shows an error
  without using up the request; denial is unchanged.
- **PATs:** `npm run pat -- create --name "<name>" [--profile <label>] [--scope read|propose|write]`. The profile
  (default `claude-code`) is created if absent, at the default scope unless `--scope` is given; with an existing
  profile, `--scope` changes its scope (audited). `npm run pat -- list` shows each token's profile and scope. Claude
  Code's PAT profile is expected to be `claude-code` at `write`, set deliberately by the owner.

## Wiring

```ts
const policy = createPolicy({
  db,
  settings: loadPolicyConfig(),
  allowMemberAdmin: config.lk.allowMemberAdmin,
});
const engine = createJobEngine({ db, lk, settings, policyGate: policy.gate, proposalSink: policy.proposals });
policy.attach(engine); // follows job outcomes, reconciles after a crash, runs the expiry sweep, joins the event stream
const { app } = await buildServer({ authConfig, db, policy, tools }); // consent, tool lists, the proposal tools
```

`buildServer` creates a policy layer on `db` when none is passed (consent and tool lists work; approval needs an
attached engine). It appends `policy.tools` to the tools it is given.

## Settings

| Variable                      | Meaning                                         | Default |
| ----------------------------- | ----------------------------------------------- | ------- |
| `POLICY_PROPOSAL_EXPIRY_DAYS` | A pending proposal expires after this many days | 14      |
| `POLICY_EXPIRY_SWEEP_SECONDS` | How often expiry is checked                     | 300     |

The scope cache is fixed at one second at most (`cacheMs`, 0-1000, in code).
