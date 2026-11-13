# ADR 0045: The tool review (E3) and the tool-call log

- Status: Accepted (the log and the wording); the proposals in section 3.2 of the review are **proposed**, for the owner
- Date: 14 November 2026
- Session: v2 E3 (PLAN-v2 phase E, the E3 row; E3b is the follow-up that applies the owner's evaluation results)
- Builds on: [ADR 0029](0029-discover-and-read-tools.md) (the tool list per profile, `showLowLevelTools`, "hiding is
  cosmetic"), [ADR 0033](0033-removing-connections-replace-on-reconnect-and-operation-discovery.md) (operation discovery,
  tool-list caching), [ADR 0013](0013-dashboard-and-admin-api.md) (the dashboard and its owner-only API)
- Migration: `2400_tool_calls`
- The review itself: [docs/reviews/E3-tools.md](../reviews/E3-tools.md); the owner's script:
  [docs/reviews/E3-evaluation.md](../reviews/E3-evaluation.md)

## Context

The bridge has 61 tools in a write profile (about 36,500 tokens of definitions when the session began), built over many
sessions. Each was described when it was written; nobody had looked at the whole surface from an agent's side. Known
friction: guessed operation names, claude.ai's cached tool lists, agents not building Working characters page by page,
`baseFactsVersion` going unused. Two assistants must each pick the right tool first time: ChatGPT (scope `propose`) and
Claude in claude.ai (scope `write`). There was also no way for the owner to see which tools an assistant actually called
without copying transcripts.

No live system was used in this session (not even a read through the owner's bridge connector). Measurements come from the
real server against the mock LegendKeeper.

## Decisions

1. **Measure the surface the way a client receives it.** `scripts/tool-surface.ts` starts the real server on the mock,
   connects the official MCP client once per profile (read, propose, write, each with and without "show low-level tools")
   and measures `tools/list` exactly: description and schema characters, tokens as characters ÷ 4 (an estimate, said so).
   `--inventory` writes the per-tool table of the review; `--baseline` shows before and after.
2. **What is applied now is wording only.** No tool, argument, schema type or behaviour changed: every description rewritten
   in one shape (what it does; when to use it and what to use instead; the scope behaviour; the cost line; the mistake to
   avoid); the shared argument texts shortened; the guide tools' generated description fixed; the four lifecycle tools'
   descriptions now say what `subtree` does; the server instructions made the ten-line version of the guide; the bridge
   guide restructured around tasks with "How to decide" first (the guide test now checks the structure); the Markdown guide
   corrected against the converter; steering hints and messages added to refusals that named no next step. The
   `propose` / `write` tool list went from about 146,000 to about 124,000 characters (36,500 to 31,000 tokens).
3. **Merges and hiding are proposed, not applied** ([review section 3.2](../reviews/E3-tools.md): merge `get_resources`,
   `bridge_proposals_mine` and `bridge_job_wait` into their siblings; hide `lk_upload_image` and `create_bare_resource`;
   relabel the checkbox; make `baseVersion` / `baseFactsVersion` required, to be decided from the evaluation). Each carries
   a recommendation and a blank for the owner's answer. ADR 0029's rule holds for all of them: hiding is cosmetic and never a
   permission, and nothing here removes a capability: a merge keeps both behaviours behind one tool.
4. **The guides are read by section.** `get_bridge_guide` and `get_markdown_guide` already return one section for a
   `section` argument. The bridge guide's first section is "How to decide" (five rules, a which-tool table with a "not this"
   column, what a scope means; about 1,600 tokens), and the server instructions send the agent there first. The generated
   Operations section is unchanged.
5. **Error steering is data, not new codes.** The typed engine errors that carried no hint get a one-sentence `hint` from a
   single table (`NEXT_STEP` in `src/mcp/tools/shape.ts`); the weak refusals named in the brief (`PAGE_NOT_WRITABLE`,
   `LIFECYCLE_*`, `WORKING_PARENT`, `CANONICAL_APPROVAL_REQUIRED`, `VERSION_CONFLICT`, `waiting_budget`) and their
   neighbours name the next step. Codes, statuses and which calls are refused are unchanged. A refusal never invites a retry
   of the same call.
6. **The tool-call log** (migration 2400, `src/toolcalls`):
   - **One row per call**: time, the connection (grant or PAT id, named on the page as the journal names it), the profile's
     label and scope **at the time**, the tool, the project the result named, the arguments as a summary, the outcome
     (`success`, `error` with its code, `proposal` captured, `waiting` for budget, `queued`), the job and proposal ids the
     result carried, the duration, the budget used and the size of the result.
   - **Names and sizes, never content or secrets.** The rule is deny by default (`src/toolcalls/summary.ts`): every argument
     is its name and size (`markdown: string(1204)`, `facts: object(3 keys)`); the value is kept only for booleans, numbers
     and short strings under a short allow-list of reference names (`page`, `mode`, `section`, `query`, …). `markdown`,
     `facts`, `data_base64`, `upload_id`, versions and URLs never leave the call (a test checks this).
   - **Recorded at the SDK's own `tools/call` handler** (wrapped the way `tools/list` already is), so a call the SDK refuses
     before any tool runs (an unknown tool name, arguments that do not validate: an assistant inventing arguments) is in the
     log too. Those are what the evaluation most needs to see (`TOOL_NOT_FOUND`, `INVALID_ARGUMENTS`, `READ_ONLY_CONNECTION`).
     If the SDK's internals move, the bridge says so once in its log and records nothing; no call is affected.
   - **Budget used** is how far the projects' hourly request and write counters moved while the call ran. It is approximate
     (another call in the same moment counts too) and the page says so.
   - **Retention** is the setting `toolcalls.retention_days` (a `policy_settings` value; default 7, at most 90; **0 switches
     recording off** and removes what is kept), set on the page, applied at once, audited (`policy.set_toolcalls_retention`).
     The log prunes itself at start-up and at most once an hour as calls arrive; there is no new maintenance job.
   - **Owner only, no agent access.** The API (`GET /api/admin/tool-calls`, `PUT /api/admin/tool-calls/retention`) is behind
     the owner's session like every admin route (the existing test that rejects any bearer token on every admin route covers
     it); no MCP tool reads or names the log (a test checks the tool list).
   - **Recording can never affect a call**: it runs after the result exists, every failure is swallowed and logged once.
   - **The table has no `project_id` foreign key**: a call such as `list_projects` names no project, so `project` is plain text.
7. **The evaluation is the owner's.** [E3-evaluation.md](../reviews/E3-evaluation.md): 30 scenarios on test-world pages only
   (new pages start with `E3 Eval`; nothing touches Arkona), the expected first tools, what to watch for, where to look on
   the Tool calls page, and a results template. The owner runs it in both assistants and sends it back; **E3b** applies it.

## Consequences

- After deploying: ChatGPT users open Plugins, the bridge, and use **Refresh**; claude.ai needs a disconnect and reconnect
  (both keep their own copy of the tool list, ADR 0033). A new chat is not enough.
- Migration 2400 adds the table. Deploy normally; `--update-self` is not needed.
- One thing found and **not** changed: the converter reads `text[^1]` with a `[^1]: note` line as a link, with no warning.
  The Markdown guide now says footnotes are unsupported; refusing or warning is for E4 or E3b.
- The `propose` / `write` list is still about 31,000 tokens. Wording took 15% off; most of what is left is the 61 schemas.
  Merging and hiding (P1 to P5) would save about 1,700 more; the rest needs fewer tools, which is the owner's call.
- Tests: `test/tools/toolcalls.test.ts` (what is summarised and what never is; real calls through the real server; invented
  arguments, unknown tools and read-only refusals recorded; filters, paging, budget, retention), `test/admin/toolcalls.test.ts`
  (the API, the retention audit, no agent tool), `test/ui/toolcalls.test.tsx` (the page), `test/discover/guides.test.ts`
  (the guide's structure and "How to decide").
