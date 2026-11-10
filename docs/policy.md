# Identity, scopes and proposals (chunk 2b)

Every connection to `/mcp` acts **for a principal under a profile**, and the profile's **scope** decides what it may do.
The owner sets both, at consent or later in the dashboard. Writes from a connection at scope `propose` become
**proposals** that the owner approves or rejects; nothing is sent to LegendKeeper until then. The design decision that
scopes are evaluated live is [ADR 0012](adr/0012-live-policy-evaluation.md).

Code: `src/policy/` (entry point `src/policy/index.ts`). Tests: `test/policy/`.

## The model

| Term          | What it is                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Principal** | Who a request acts for: an OAuth grant (`grant_…`, one consent for one client) or a personal access token (`pat_…`).                                       |
| **Profile**   | A named policy bundle (`agent_profiles`): `label` (unique), `kind` (`claude`, `chatgpt`, `claude-code`, `other`), `scope` and (v2 B2) `showLowLevelTools`. |
| **Scope**     | `read`, `propose` or `write`. Attached to the profile, never to a token.                                                                                   |
| **Owner**     | The only authority. Chooses profile and scope at consent; changes them, approves and rejects proposals in the dashboard (chunk 5).                         |

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
                                                       ▲                              │
                                                       └── v2 C1: a page write whose ─┘
                                                           in-lock version check refused it
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

**High-level operations (v2 C1, [ADR 0031](adr/0031-write-page.md)).** A proposal made by a high-level tool
(`write_page`) also stores the operation itself (`proposals.operation`): page, document, mode, section, the agent's
Markdown, its `baseVersion`, and the page's Markdown before and after. The capture reuses the read the tool planned on
(and refuses one made on another version). `getProposal` adds `operationDetail`, `markdownDiff` (the page before and
after, line by line, keep regions as labelled placeholders, in hunks) and, once the job ran, `execution` (whether the
read after the write matched); lists carry `operation`, briefly. The expansion keeps the step's `verifyAfterWrite` and
`journalOperation` options, never a re-planner: the owner approves exactly what was shown. If the job of such a proposal
fails with `VERSION_CONFLICT` before any step succeeded (the compare-and-swap inside the document's lock caught a change
made after the approval's re-read), the proposal becomes `conflicted` (`executing → conflicted`), not `failed`: nothing
was written. v1 proposals are unchanged.

**Multi-page groundwork (v2 C2a, [ADR 0032](adr/0032-set-facts-and-canon.md)).** A proposal stores a **list** of
high-level operations (`proposals.operations`; C1's single `operation` stays as the first), each naming the page it
affects and, optionally, its `pageParts`. Every client id the expansion needs is **minted at capture** and stored (a
planner mints the ids it cross-references itself; capture mints any still missing, for example a `createResource`
proposed through `lk_api_write`), so a child "under" a new index and a link "to" a new page are fixed in the proposal,
and approval runs with exactly those ids. Every proposal has a **page-level summary** (`page_summary`, made at capture):
its operations grouped by the page they affect, in plain labels such as `Asagiri Miyabi: sidebar, 3 facts changed, 1
link added`; the dashboard shows it first. An expansion may hold the bridge's own steps (`bridge.expect`, the check
inside the lock; `bridge.verify`, the generic verify) and a job-level lock (`job_options`); approval submits it with
both. What the verify step found is kept on the proposal (`verification`) as well as on the job.

**Reject** (owner only) takes an optional reason, which the agent can read.

## Protected canonical facts (v2 C2a)

**The rule** (decided by the owner; PLAN-v2 10.3 as refined): canon never changes without the owner's explicit
canonical approval, by any route. It is configuration, per project (Projects page, _Canon_; audited as
`project.set_canonical_rules`), a list of rules seeded with these defaults:

| Rule                       | Protected                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Status` = `Authoritative` | Both directions: setting a page's Status TO Authoritative, or changing it FROM Authoritative to anything else (removing it too). |
| `Continuity Type`          | CHANGING an existing non-empty value (for example CANON ↔ AU). Setting it where it is empty (as on a new page) is allowed.       |
| `Continuity`               | CHANGING an existing non-empty value (for example one AU to another). Setting it where it is empty is allowed.                   |

Facts are every key-value row of the page's sidebar; keys match without case and with spaces trimmed, `value` rules
match values without case, a `change` rule compares a value's text and the pages it mentions (marks do not count). A
second value added next to an existing one is a change. The Status of pages agents create is `Working`
(`agentDefaultStatus`, kept for C2b's creation tools); templates carry no fact defaults (the owner confirmed), so
nothing is inherited.

**What happens.** A write that would make a protected change becomes a **proposal flagged
`requiresCanonicalApproval`, whatever the caller's scope** (`write` or `propose`), and the agent's result says
`requiresCanonicalApproval: true` with the reason. A `read` connection is refused as before. Writes that touch nothing
protected behave exactly as before. The dashboard shows such a proposal with a banner listing the protected changes;
the only approval is **"Approve and accept as canon"** (`approveAsCanon`, `POST /api/admin/proposals/:id/approve-as-canon`
with `{ confirm: true }`), a separate action audited as `proposal.approve_as_canon` that records `canonicalApprovedBy`
(and when). The ordinary Approve, and bulk approval, are refused for it (`CANONICAL_APPROVAL_REQUIRED`); "accept as
canon" is refused for a proposal that is not canonical (`NOT_CANONICAL`). Reject works as normal.

**Where it is enforced.** In the job engine, on every request and every write, not in each tool (src/facts/canonical.ts,
the engine's write guard, src/jobs/write-guard.ts):

1. **At entry**, once per `run` / `submit`, after the policy gate let every operation through: the request's sidebar
   writes are simulated in order on the page's sidebar as it is now (the tool's own read when it made one, else one
   `listProperties`), and the facts after each write are compared with those before it. A batch is judged as the
   sequence it is, so a protected change made in two harmless-looking steps is caught. A sidebar that cannot be read
   counts as protected (refuse rather than guess).
2. **At execution of an approved proposal**: the approved batch passes the same entry check. With a canonical approval
   token (minted only by "Approve and accept as canon") it runs; without one, an expansion that carries a protected
   change is refused there, the proposal fails, and **nothing is written** (a forged or stale expansion).
3. **Inside the lock**, before each sidebar write is sent: the check is made again on what is there now (the read the
   engine makes there, or one more read when the write touches a protected fact). A job that does not carry canonical
   approval is refused (`CANONICAL_APPROVAL_REQUIRED`); nothing is sent. A versioned row write sent with an `If-Match`
   the bridge did not read there is left to LegendKeeper's version check, which refuses it if the rows changed since.
4. **The system principal** (the bridge's own work, the dashboard) is refused a protected change too: the bridge never
   makes one on its own.

**Every write path that can reach sidebar facts, and its guard:**

| Path                                                                                                                                                    | Guarded by                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `set_facts`                                                                                                                                             | entry (with the plan's own read), execution, inside the lock                                           |
| `lk_api_write` with `createProperty`, `updateProperty` (rows), `deleteProperty`                                                                         | entry, execution, inside the lock                                                                      |
| `lk_api_write` with `createPropertyRow`, `updatePropertyRow` (key or value), `deletePropertyRow`                                                        | entry, execution, inside the lock (or LegendKeeper's If-Match, see above)                              |
| `lk_api_batch` with any of those, in any order                                                                                                          | entry (the whole sequence), execution, inside the lock                                                 |
| `lk_op_createProperty`, `lk_op_updateProperty`, `lk_op_deleteProperty`, `lk_op_createPropertyRow`, `lk_op_updatePropertyRow`, `lk_op_deletePropertyRow` | entry, execution, inside the lock                                                                      |
| `createResourceFromTemplate` (any tool): it copies the template's properties                                                                            | entry (the template's facts are read and judged as a new page's)                                       |
| C2b's tools (resources, documents, characters)                                                                                                          | the same engine guard, whatever they submit; `assessFactChange` for their own checks before they write |
| An approved proposal's batch                                                                                                                            | execution (canonical approval token required for a protected change), inside the lock                  |

Operations that cannot write sidebar facts are not checked: `createResource` and `createManyResources` (their bodies
carry no properties), `updateResource` (name, tags, aliases, icon, flags), `saveResourceAsTemplate` (it copies a page
into a template; the page does not change, and a template's facts are judged when a page is made from it), block and
infobox operations (page content, not the sidebar), and `deleteResource` / `restoreResource` (they remove or bring
back a page whole, without changing its facts; whether deleting or restoring an Authoritative page should need
canonical approval is an open question for the owner, ADR 0032).

**The shared function.** `assessFactChange(rules, before, after)` (src/facts/index.ts) is pure: given a page's facts
before and after a change, it lists the protected changes. C2b's tools call it to tell an agent in a dry run; the engine
guard enforces it whatever they call.

**Retention (v1.0.1).** `executed`, `rejected`, `expired` and `failed` proposals are deleted, with their operations and
pre-state, `POLICY_PROPOSAL_RETENTION_DAYS` (90) days after they finished, by the `proposal-prune` maintenance job
([maintenance.md](maintenance.md#proposal-prune-v101)). `pending`, `approved`, `executing` and `conflicted` proposals are
never pruned. Jobs, journal entries and audit rows keep the proposal id as text.

### Agent-facing tools

Both are read tools (`access: 'read'`, `readOnlyHint: true`) restricted to the caller's own proposals (by principal);
another principal's proposal is reported exactly as if it did not exist.

| Tool                     | Input                                          | Returns                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge_proposal_status` | `{ proposalId, project? }`                     | state, summary, operation count, times, the rejection reason, the job id, the conflicting operation, the error text; since v2 C2a the pages affected and `requiresCanonicalApproval` with `canonicalReason` |
| `bridge_proposals_mine`  | `{ state?, limit? (1-50, def. 20), project? }` | the same, newest first                                                                                                                                                                                      |

No MCP tool can change a scope, approve or reject a proposal, or create or revoke a token
(`test/policy/no-agent-escalation.test.ts` calls every registered tool with hostile arguments and checks).

## Owner commands

`createPolicy(...).commands` (`src/policy/commands.ts`): plain functions for chunk 5's dashboard routes, which must
authenticate the owner (session cookie and CSRF) first. Each takes `actor: 'owner'` as its first argument (typed, and
checked at run time). Every change writes an `audit_log` row (`at`, `actor`, `action`, `target`, `before`, `after`) and
emits a `policy` event on the engine's event emitter; proposal state changes also emit `proposal` events.

| Command                                                      | What it does                                                                                            | Audit action                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `listProfiles(actor)`                                        | Profiles with their count of active connections                                                         | –                                                |
| `createProfile(actor, { label, kind, scope? })`              | New profile (default scope unless given)                                                                | `profile.create`                                 |
| `setScope(actor, profileId, scope)`                          | Changes a profile's scope; applies at once to its connections                                           | `profile.set_scope`                              |
| `getDefaultScope(actor)`, `setDefaultScope(actor, scope)`    | The scope new profiles get                                                                              | `policy.set_default_scope`                       |
| `listGrantsAndPats(actor)`                                   | Every grant and PAT with profile, scope, last use, expiry and revocation                                | –                                                |
| `setConnectionProfile(actor, id, profileId)`                 | Moves a grant or PAT to another profile (for example out of `legacy`)                                   | `connection.set_profile`                         |
| `revoke(actor, id)`                                          | Revokes a grant (its refresh and access tokens) or a PAT                                                | `connection.revoke`                              |
| `listProposals(actor, filter?)`                              | By state, principal, profile, before; newest first                                                      | –                                                |
| `getProposal(actor, id)`                                     | With each operation's params, pre-state, proposed state, changes, lost unsupported blocks               | –                                                |
| `approve(actor, id)`                                         | As above; resolves with the proposal (`executing` or `conflicted`). Refused for a canonical proposal    | `proposal.approve` (then `proposal.executed`, …) |
| `approveAsCanon(actor, id)` (v2 C2a)                         | "Approve and accept as canon": the only approval of a canonical proposal; records `canonicalApprovedBy` | `proposal.approve_as_canon`                      |
| `reject(actor, id, reason?)`                                 |                                                                                                         | `proposal.reject`                                |
| `bulkApprove(actor, ids)`, `bulkReject(actor, ids, reason?)` | One at a time, in order; a result per id                                                                | as above                                         |
| `listAudit(actor, filter?)`                                  | The audit log, newest first                                                                             | –                                                |

The system writes its own rows with actor `system`: `proposal.conflicted`, `proposal.executed`, `proposal.failed`,
`proposal.expired`, `proposal.approval_reverted` and `proposal.approval_interrupted`. Read-only commands are not
audited.

Errors are `PolicyError` with a stable `code`: `NOT_OWNER`, `INVALID_INPUT`, `PROFILE_EXISTS`, `PROFILE_NOT_FOUND`,
`CONNECTION_NOT_FOUND`, `PROPOSAL_NOT_FOUND`, `INVALID_TRANSITION`, `PROPOSAL_EXPIRED`, `BRIDGE_READ_ONLY`,
`WRITES_PAUSED`, `DRAINING`, `NO_ENGINE`, `REREAD_FAILED`, `CANONICAL_APPROVAL_REQUIRED` and `NOT_CANONICAL` (v2 C2a).

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

## Hiding the low-level tools (v2 B2)

A profile's **show low-level tools** setting (`showLowLevelTools`, default off, migration 1100) decides whether its
connections are _shown_ `lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all` and every `lk_op_*`
in `tools/list`. The owner changes it on Clients & Access (`PUT /api/admin/clients/profiles/:id/low-level-tools`),
no confirmation is asked, and it is audited as `profile.set_low_level_tools` with the old and new value. It is read live
with the scope, so the next `tools/list` follows it. **It is not a permission.** Every tool stays registered, so a call
to a hidden tool is refused or allowed exactly as before: a `read` profile still gets the read-only refusal for a hidden
write tool, a `propose` profile still gets a proposal, and the engine's guards apply as ever
([ADR 0029](adr/0029-discover-and-read-tools.md)).
