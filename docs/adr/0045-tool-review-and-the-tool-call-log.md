# ADR 0045: The tool review (E3) and the tool-call log

- Status: Accepted (the log and the wording). The proposals in section 3.2 of the review were **answered by the owner on
  15 November 2026 and applied in E3b** (section "E3b" below).
- Date: 14 November 2026 (E3); E3b: 15 November 2026
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
3. **Merges and hiding were proposed, not applied, in E3; E3b applied the owner's answers** ([review section 3.2](../reviews/E3-tools.md): merge `get_resources`,
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

## E3b: the owner's evaluation and the changes it led to (15 November 2026)

The owner ran scenarios 1 to 8 in both assistants and then a shortlist (9, 10, 11, 13, 14, 16, 18, 21, 26, 28, 29); every
run ended right. The table is [reviews/E3-results.md](../reviews/E3-results.md). Again nothing here was run against a live
system: no call to the owner's LegendKeeper bridge connector, not even a read; every test and measurement uses the mock.

### Decisions on the review's proposals (P1 to P11)

| #   | Owner's answer | What was done                                                                                                                                                                                                                                      |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Apply          | `get_resources` merged into `get_resource`: `resource` (one) or `resources` (up to 25, one job, the estimate above 10 live reads, `confirm`, `detail`); exactly one of the two (`RESOURCE_REQUIRED`).                                              |
| P2  | Apply          | `bridge_proposals_mine` merged into `bridge_proposal_status`: with `proposalId` one proposal; without it yours, newest first (`state`, `limit`). Another connection's proposal still looks like one that does not exist.                           |
| P3  | Apply          | `bridge_job_wait` merged into `bridge_job_status`: `wait_seconds` (1 to 25) with a `jobId` waits, then answers (`done`); `JOB_ID_REQUIRED` without one.                                                                                            |
| P4  | Apply          | `lk_upload_image` hidden by default (`lowLevel`).                                                                                                                                                                                                  |
| P5  | Apply          | `create_bare_resource` hidden by default; the evaluation showed it is never needed first.                                                                                                                                                          |
| P6  | Apply          | The checkbox reads "Show low-level and rarely used tools" (Clients & Access, the docs, the consent text where it names it). The setting, its column and its audit action are unchanged.                                                            |
| P7  | Not applied    | `create_many_resources` stays visible.                                                                                                                                                                                                             |
| P8  | Not applied    | `lk_api_batch` stays visible (the evaluation used the low-level fallback correctly and never `lk_api_batch`).                                                                                                                                      |
| P9  | Not applied    | `baseVersion` and `baseFactsVersion` stay optional: agents passed them every time. **Instead**, the Tool calls page flags (and filters) "write without a base version": a `write_page` or `set_facts` call that edits existing content without it. |
| P10 | Not applied    | The two guides stay separate tools.                                                                                                                                                                                                                |
| P11 | Not applied    | The map-feature `style` schema stays as it is.                                                                                                                                                                                                     |

**Merges keep both behaviours behind one tool, and the old names fail helpfully.** For one release `get_resources`,
`bridge_proposals_mine` and `bridge_job_wait` stay registered but are **never listed** (`retired` on the tool provider,
`renamedTool` in `src/mcp/tools/define.ts`). A call, from a client's cached tool list, accepts any arguments, does nothing and
answers `TOOL_RENAMED`: "get_resources was renamed to get_resource. Pass `resources` …", with a hint to refresh the connector. The
tool-call log records it like any call, so the owner sees a stale client. They are removed in the release after.

**Counts.** A `propose` or `write` profile sees **56** tools (61 before: -3 merged, -2 hidden); a `read` profile **25** (28
before). With the setting on: 61 and 28. See the measurements in [reviews/E3-tools.md](../reviews/E3-tools.md) (section 6,
generated by `scripts/tool-surface.ts`).

### Fixes for the patterns the evaluation showed

1. **Guide sections are matched loosely** (`src/mcp/tools/guide-sections.ts`; both guides). Six or more `SECTION_NOT_FOUND`,
   mostly ChatGPT, each self-corrected but wasting calls ("find pages", "Read a page's text (or one section)", "Promote", and
   three more). An exact heading (any case) is matched first, as before. A miss is scored: case, punctuation and spacing are
   ignored; the key words of a heading count, weighted by how few headings share them (so "page" and "text" count for little);
   synonym groups lead "promote", "promotion", "lifecycle" and "archive" to the lifecycle section, and "find", "search",
   "read" and "look" to finding and reading, and so on; the labels of the "Which tool?" table are aliases of the section they
   point to (ChatGPT copied one as a section name). **One clear match** (the best score at least 1.5 times the runner-up) is
   returned with `matched` naming the exact name; **several** return `SECTION_AMBIGUOUS` and the candidates; **none** returns
   `SECTION_NOT_FOUND` with `sections`, every exact section name (the title is not one). The bias is deliberately towards
   "several" over a wrong guess. "How to decide" lists the exact names to ask for.
2. **Steering towards the Core.** Claude read a character's `[INDEX]` first for its facts or Scope (scenarios 5, 9 and 11) and
   found none. `AMBIGUOUS` for one character's pages lists each with its role and adds "a character's facts and Scope live on its
   Character Core (or Character Reference for a compact character)"; `get_resource` on a character's `[INDEX]` adds a `character`
   note naming the Core (or Reference) with its id and the same sentence; the guide says it in finding and reading. A Working or
   Archived character's index counts as a character index here (the registry's own rule knows only those under the type's root:
   `characterRoleOf` in `src/mcp/tools/repo.ts`). Writes stay strict: a name that matches several pages is never resolved.
3. **`upload_image` destinations for Working, Archived and specialist pages.** Scenario 21 got `FOLDER_REQUIRED` and then
   `PAGE_NOT_UNDER_CHARACTERS`. A character's page outside the Characters index (a Core or Reference, its index) or a
   specialist page (`{name} - …`, any page whose subject is the character, found with `subjectOf`: its Subject row, else the
   name before " - ") now leads to the character (`characterOfPage` in the registry). The race is the character's **Race /
   Species** fact on its Core, else its Reference: from the repository tree, else one live `getResource` of that page
   (`RACE_NOT_READ` asks the tool for it; nothing is written). The latest snapshot is **not** consulted: the tree is read from
   the same pages and is never older than a snapshot, so a snapshot adds nothing the tree lacks. The D3 race rules are unchanged
   (`Unestablished` goes to `Undetermined / Unknown`; a race that does not resolve fails). Only when neither route works does it
   refuse, and the message names what to pass: `for_character { name, race }` or a `folder` (`FOLDER_REQUIRED`,
   `CHARACTER_AMBIGUOUS` for several Cores of one best lifecycle state, `RACE_NOT_FOUND` for a Core with no Race / Species).

### The evaluation helper

The manual run was tedious, so the Tool calls page now runs it. The scenarios are data
([docs/reviews/scenarios.json](../reviews/scenarios.json); the markdown stays the human copy): id, title, assistants, the exact
prompt and the preamble, the expected tools and the tools that would be a mistake, dependencies and a `core` flag (the owner's
shortlist plus 1, 4, 5, 6, 7 and 8). The **Evaluation** panel on the Tool calls page: choose the set (core or all) and the
assistant (ChatGPT or Claude); each scenario shows its prompt with a Copy button and Start; the owner pastes the prompt into a
fresh chat and clicks Done; the bridge attributes every tool call of that assistant's connections between Start and Done. An
auto-grade is a **hint** (expected tools present, mistake tools present, error codes seen); the owner confirms Right, Partly or
Wrong with one click and an optional note. Runs are saved (date, assistant, the set, the bridge version, the per-scenario
results), a results table in the owner's format can be copied, and a run can be compared with an earlier one. Owner only, with no
agent access (the existing check that rejects any bearer token on every admin route covers it, and no MCP tool names or reads
it); scenario prompts never name a tool (a test checks). The details, the migration and the route list are in
[dashboard.md](../dashboard.md) (Tool calls, Evaluation).

**"Write without a base version"** (`src/toolcalls/flag.ts`, column `tool_calls.no_base_version`, decided at record time from the
argument names): a `write_page` with no `baseVersion`, or a `set_facts` with no `baseFactsVersion` (and at least one fact or
link), that is not a `dryRun`. Calls the MCP layer refused before the tool ran (invalid arguments, read-only connection) do not
count. The page has a filter and a badge reading exactly "write without a base version". Which connections are ChatGPT and which
are Claude (`src/evaluation/classify.ts`): the OAuth redirect host, then the client, token or profile name; a signal naming both
is ignored, and the panel lets the owner choose connections by hand. A scenario's window is the calls above the newest log id at
Start up to the newest at Done, by those connections; each result keeps its own compact calls, so runs survive the log's
pruning. Start is refused while recording is off.

### Consequences

- After deploying: refresh both assistants' tool lists (ChatGPT: Plugins, the bridge, **Refresh**; claude.ai: disconnect and
  reconnect). Until then an assistant holding the old list calls `get_resources` and friends and gets `TOOL_RENAMED`.
- E5 reruns the core evaluation on Arkona's read-only tasks after the move ([PLAN-v2](../PLAN-v2.md)).
- Tests: `test/tools/e3b.test.ts` (merges, the renamed names, hidden tools still callable, steering),
  `test/discover/guide-sections.test.ts` (every miss from the table, several, none, through the tools),
  `test/images/destinations.test.ts` (a Working Core, a specialist page, an Archived page, the cases that still refuse), and the
  existing tool-list tests with their counts.
