# Identity, scopes and proposals (chunk 2b)

Every connection to `/mcp` acts **for a principal under a profile**, and the profile's **scope** decides what it may do.
The owner sets both, at consent or later in the dashboard. Writes from a connection at scope `propose` become
**proposals** that the owner approves or rejects; nothing is sent to LegendKeeper until then. The design decision that
scopes are evaluated live is [ADR 0012](adr/0012-live-policy-evaluation.md).

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
- **Projects (v2 A1).** Profiles and scopes are per connection and apply to every project the bridge serves (ADR
  0023). A proposal belongs to the project its write was for: the agent tools and the dashboard show it in that project
  only, and approving it executes it against that project only. With several projects, a write (direct or proposed)
  must name its project (`REQUIRE_PROJECT_FOR_WRITES`).

## Scopes

| Scope     | Reads | Writes (every non-read operation)                                                                     |
| --------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `read`    | allow | denied: `PolicyDeniedError` saying the connection is read-only and that the owner can change it       |
| `propose` | allow | captured as a proposal; the agent gets `{ status: 'proposal_captured', proposalId, summary }`         |
| `write`   | allow | run, within every existing guard (read-only mode, pause, If-Match, unsupported blocks, cascade, etc.) |

- Member and invite administration (`inviteMember`, `removeMember`, `revokeInvite`) is refused for every agent, at any
  scope, unless `LK_ALLOW_MEMBER_ADMIN=true`: by the engine's guard (`MEMBER_ADMIN_DISABLED`), after the gate, and at
  proposal capture (so it is never captured).
- **Uploads are not proposable (v1).** At scope `propose`, `lk_upload_image`, and raw `createImageUpload` /
  `createImageAsset` calls through `lk_api_write` or `lk_api_batch`, are refused before anything is sent, with a
  message that uploads need scope `write` and that the owner can raise the profile's scope. (A proposal would have to
  hold the image bytes and a signed URL that expires within minutes.)
- The `system` principal (internal and dashboard work) is always allowed, except on an MCP origin, where it could only
  mean a tool forgot to pass the caller: denied.
- Unknown, revoked or expired principals are denied, reads included.
- **Live evaluation.** The gate reads the principal's profile and scope from the database on every engine entry
  (cached for at most one second; any change made through the bridge clears the cache at once). Changing a profile's
  scope changes what every existing connection on it can do on its very next call, with no reconnection.
- **Queued work follows too (chunk 8).** Before each new step of a job that acts for an agent, the engine asks the
  gate again (`phase: 'execute'`). If the connection has been revoked, or its scope lowered to `read` or `propose`, that
  step fails with `POLICY_DENIED` (recorded on the Errors page with the job), the rest of the job is cancelled, and the
  job ends `failed`. A step already in flight is finished and verified. Jobs the owner approved (`approvedBy`) and
  internal work are not asked again: the owner's approval wins, as below.

### Tool lists

`tools/list` is built per request: a principal at `read` sees only tools with `access: 'read'`; at `propose` and
`write` it sees every tool (at `propose`, a write tool returns the proposal result). A tool without `access` counts as
`write` unless it is annotated `readOnlyHint: true`. The list is a convenience, not the control: a hidden write tool
called directly by a `read` connection is refused at call time with the read-only message (every tool stays
registered; only `tools/list` is filtered), and the policy gate refuses the write in the engine whatever the tool says
about itself (defence in depth; `test/policy/mcp.test.ts`, `test/tools/policy-e2e.test.ts`).

**Visibility of work.** `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_result_page` and
`bridge_errors_recent` show only the caller's own jobs, stored results and errors (by principal). Another principal's
job id or handle answers exactly like an unknown one. `bridge_journal_lookup` shows every principal's entries,
read-only, with principal, profile and approver on each, because cross-checking another agent's edits is a
consistency need; job ids appear only on the caller's own entries. `bridge_info` reports the caller's profile and
scope.

Tool handlers get `ctx.principal` (and `ctx.scope`). Every engine-backed tool builds its origin with
`mcpOrigin(ctx, tool)`, which carries the principal and the tool name, never `approvedBy`, and refuses (a
`PolicyDeniedError`) when the request has no principal, so a tool can never fall back to `system`.

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
5. **Limits (chunk 8).** A proposal keeps at most 4 MiB of pre-state in all (each operation at most 512 KB, cut by
   bytes); past that an operation keeps its version and fingerprint, which conflict detection uses, but no pre-state
   text, and its diff says it was truncated. One connection may hold at most 50 `pending` proposals; the 51st is refused
   with `POLICY_DENIED` before anything is read, until the owner decides some.

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

**Retention (v1.0.1).** `executed`, `rejected`, `expired` and `failed` proposals are deleted, with their operations and
pre-state, `POLICY_PROPOSAL_RETENTION_DAYS` (90) days after they finished, by the `proposal-prune` maintenance job
([maintenance.md](maintenance.md#proposal-prune-v101)). `pending`, `approved`, `executing` and `conflicted` proposals are
never pruned. Jobs, journal entries and audit rows keep the proposal id as text.

### Agent-facing tools

Both are read tools (`access: 'read'`, `readOnlyHint: true`) restricted to the caller's own proposals (by principal);
another principal's proposal is reported exactly as if it did not exist.

| Tool                     | Input                                          | Returns                                                                                                             |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bridge_proposal_status` | `{ proposalId, project? }`                     | state, summary, operation count, times, the rejection reason, the job id, the conflicting operation, the error text |
| `bridge_proposals_mine`  | `{ state?, limit? (1-50, def. 20), project? }` | the same, newest first                                                                                              |

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
  suggested label is preselected; otherwise "New profile" with that label. **Preselected scope (v1.0.1,
  [ADR 0019](adr/0019-consent-keeps-existing-scope.md)):** an existing profile's **current** scope, so approving
  without touching anything changes nothing; a new profile gets the default scope for new connections (`read` unless
  the owner changed it). **A change to an existing profile's scope is confirmed first:** the bridge shows a second page
  with the warning that it affects every connection on that profile (and how many there are), the change (`from` →
  `to`) and two buttons, _Change to … and approve_ and _Keep … and approve_. Only that confirmation, for exactly that
  change, applies it (audited `profile.set_scope`, `via: consent`); picking another existing profile in the list
  without choosing its scope therefore never changes it silently. A bad choice shows an error without using up the
  request; denial is unchanged.
- **PATs:** `npm run pat -- create --name "<name>" [--profile <label>] [--scope read|propose|write]`. The profile
  (default `claude-code`) is created if absent, at the default scope unless `--scope` is given; with an existing
  profile, `--scope` changes its scope (audited). `npm run pat -- list` shows each token's profile and scope. Claude
  Code's PAT profile is expected to be `claude-code` at `write`, set deliberately by the owner.

## Wiring

`src/runtime.ts` (`createRuntime`) is the one place things are built: governor and LK client, then the policy layer
(`createPolicy`), then the job engine with `policyGate: policy.gate` and `proposalSink: policy.proposals`, then
`policy.attach(engine)` once the engine has started (job outcomes, restart reconciliation, the expiry sweep, the event
stream), then the tools (chunk 3's, plus the two proposal tools with the budget footer). `createBridge` in
`src/server.ts`, which `main` runs, passes `runtime.policy` to `buildServer`, so consent, tool lists and the engine
share one policy layer (`test/tools/policy-e2e.test.ts` › boot).

`buildServer` alone (auth tests) creates a policy layer on `db` when none is passed: consent and tool lists work, and
approval needs an attached engine. It appends the proposal tools unless the given tools already include them.

## Settings

| Variable                         | Meaning                                                                                                                                                                                        | Default |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `POLICY_PROPOSAL_EXPIRY_DAYS`    | A pending proposal expires after this many days                                                                                                                                                | 14      |
| `POLICY_EXPIRY_SWEEP_SECONDS`    | How often expiry is checked                                                                                                                                                                    | 300     |
| `POLICY_PROPOSAL_RETENTION_DAYS` | Finished proposals (executed, rejected, expired, failed) older than this are deleted by the `proposal-prune` maintenance job, with their pre-state; pending and conflicted ones never (v1.0.1) | 90      |

The scope cache is fixed at one second at most (`cacheMs`, 0-1000, in code).
