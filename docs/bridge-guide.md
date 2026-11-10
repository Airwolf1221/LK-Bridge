# The LK-Bridge guide for agents

This guide is for agents (Claude, ChatGPT) that use LK-Bridge to work with LegendKeeper worlds. Read it once, then keep
to the short version below.

**The short version**

1. Find a page with `search` or `browse_repository_tree`. Look at it with `get_resource`. Read its text with
   `read_document`.
2. Almost everything costs nothing: it is answered from the bridge's own copy of the repository. Only live reads cost
   LegendKeeper requests, and each tool says so.
3. Pages are Markdown. Read `get_markdown_guide` before you write any; write with `write_page`, passing the version you
   read as `baseVersion`.
4. Budgets are finite. Never loop on an error; wait for the time it states.
5. A write that was `queued`, `waiting_budget` or `proposal_captured` is not lost and is never retried.

## What the bridge is

LK-Bridge sits between you and LegendKeeper. It keeps a model of each world's **AI REPOSITORY** (the page tree your
tools work in), checks every write against the page's current version, protects content Markdown cannot show, records
every change in a journal, and shares each project's request budget fairly between everyone using it. You never hold a
LegendKeeper key.

## Projects

One bridge serves several LegendKeeper projects (for example `arkona`, the live world, and `test`).

- `list_projects` names them and says which is the default.
- Every tool takes an optional `project`. Reads without it use the default project. **A write must name its project**
  when the bridge serves more than one, so a forgotten argument can never land in the wrong world.
- Every result names the project it used and ends with that project's budget line.
- Each project has its own repository, its own assets and its own budget. Nothing carries over between projects.

## The repository tree

The bridge's **repository tree** is its copy of everything under the project's `AI REPOSITORY` page: every page's
name, kind, place, tags, aliases, Reference Type, Scope and documents.

- **Kinds.** `[INDEX]` pages (kind `index`) organise; `[BSRC]` pages (kind `bsrc`) hold the content; anything else
  is `unclassified` and is reported. Display names have the prefix removed: the page `[BSRC] Asagiri Miyabi` is
  "Asagiri Miyabi".
- **Status.** Every answer from the tree states its status and when it was last confirmed. `ready` means it was
  checked within the last day. `stale` means something could not be confirmed; the answer is still the best the bridge
  has, and it says so. `not_built` and `building` mean it cannot answer yet. The tools say so and spend nothing.
- **Freshness.** The tree is updated after each of the bridge's own writes, by an hourly sweep, and by a nightly full
  check. A change made in the LegendKeeper app can take up to an hour to appear in `search` and `browse_repository_tree`;
  `get_resource` and `read_document` read the page itself, live.
- **The root.** The high-level tools work **only inside the AI REPOSITORY**. A page outside it is refused with a message
  saying so. The low-level tools (`lk_api_read`, `lk_api_write`, `lk_api_batch`) can still reach it, with the same
  guards and budget.

## Finding things

| You want                               | Use                                                                  |
| -------------------------------------- | -------------------------------------------------------------------- |
| The layout of a part of the repository | `browse_repository_tree` (a path, a name or an id; `depth`, `kinds`) |
| A page by part of its name             | `search` (free: from the tree)                                       |
| Pages by tag, type, scope or place     | `search` with `tag:` `type:` `scope:` `kind:` `under:`               |
| A page by a word in its text           | `search` with `content: true` (1 read; incomplete)                   |
| The tags in use                        | `list_tags`                                                          |
| Templates, calendars                   | `list_templates`, `list_calendars`                                   |
| Image folders and images               | `browse_asset_tree`, `list_assets`                                   |

**Search syntax.** Words must all match; `"quoted phrases"` match as written; `OR`, `NOT` (or a leading `-`) and
parentheses combine terms (capitals for `OR`, `AND` and `NOT`; `NOT` binds tightest, then `AND`, then `OR`). A word
with no filter matches the display name, aliases, Canonical Display Name and Scope. Examples:

```text
foxian tag:elder -kind:index
(shrine OR temple) under:Locations
type:"Character Core" scope:Qishen
```

Results are ranked: exact name, name prefix, a word of the name, text inside the name, alias, then Scope. Each result
says why it matched. **Content search is incomplete by nature**: LegendKeeper's own search is ranked, capped at 100
results and has no operators, so a page it did not return may still contain the word. Never conclude that a word does
not appear on any page from a content search.

**Names and ids.** Wherever a tool takes a page, give a name or an id. A name must match exactly one page (display
name, full name, alias or Canonical Display Name, ignoring case). If it matches several, you get the candidates with
their paths: choose one and pass its id. The bridge never guesses.

## Reading

- `get_resource` shows the tree's data for a page (path, kind, documents, tags, Reference Type, Scope) and, from one live
  read, its whole sidebar: the facts in template order, the link collections with their items (an item can point at one
  document of a page), and the other properties (named, read-only).
- `read_document` returns a page's document as Markdown, with the document version and the list of keep regions.
  `outline: true` returns just the headings; `section: "Biography > Early Life"` just that section.
  Maps, timelines and boards come back as read-only Markdown.
- Long results are stored and returned as a **handle**: read them with `bridge_result_page`.
- Results are summaries unless you pass `detail: "full"` where a tool offers it.

## Writing pages

Pages are changed with `write_page`, in Markdown (read `get_markdown_guide` first). You send Markdown for one page
document; the bridge turns it into LegendKeeper blocks, keeps everything you did not change exactly as it was (ids,
styling, keep regions), and checks what it wrote.

1. **Read first.** `read_document` gives the page's Markdown and its `version`. Change the Markdown you read; do not
   write a page you have not read.
2. **Pass `baseVersion`.** Give `write_page` the version you read. If the page changed since, a whole-page edit is
   refused, and a section edit goes ahead only if that section is still exactly as you read it.
3. **Prefer the section modes.** `append_to_section` and `replace_section` touch one section (`section: "Biography >
Early Life"`) and nothing else, so they survive edits made elsewhere on the page at the same time. Use `replace`
   (the whole page) only when you mean it: every keep region must be in it.
4. **Try it first when unsure.** `dryRun: true` returns what would change and the Markdown diff, and writes nothing.

| Mode                | What it does                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| `append`            | Adds your Markdown at the end of the page.                                     |
| `prepend`           | Adds it at the start.                                                          |
| `replace`           | Replaces the whole page (keep every keep region, or name it in `dropRegions`). |
| `replace_section`   | Replaces one section; start with its heading to change the heading too.        |
| `append_to_section` | Adds to the end of one section.                                                |

```json
{
  "project": "test",
  "page": "Asagiri Miyabi",
  "mode": "append_to_section",
  "section": "Biography",
  "markdown": "She became head maiden in 4A 900.",
  "baseVersion": "v12"
}
```

**The result** says what changed (blocks kept, changed, added and removed; keep regions kept), the new `version` (use it
as the `baseVersion` of your next edit), whether the bridge **verified** the write by reading the page back, and the job
id. `detail: "full"` adds the Markdown diff. An edit that changes nothing writes nothing (`no_change`).

**A conflict (`VERSION_CONFLICT`) wrote nothing.** Never send the same call again: someone else changed the page.
Read it again (the error gives the current version, and for a section edit the section's current text in
`currentSection`), redo your change on what it holds now, and pass the new version.

**"written but not as planned"** means the write was made, but the page read back afterwards differs from what was
sent (usually someone edited it at the same moment). It is not retried. Read the page and tell the person; the journal
entry named in the result holds the page as it was before.

Other refusals name what to fix: `KEEP_REGIONS_MISSING` (put the regions back, or name them in `dropRegions`),
`UNSUPPORTED_BLOCK_LOSS` (content the API cannot show is never deleted by `write_page`), `SECTION_NOT_FOUND` and
`SECTION_AMBIGUOUS` (the headings or options are listed), `MENTION_NOT_FOUND` and `MENTION_AMBIGUOUS`,
`WRONG_TOOL_FOR_DOCUMENT` (maps, timelines and boards have their own tools), `PAGE_NOT_WRITABLE` (the page holds
something LegendKeeper's API would not take back; tell the owner).

**What a proposal is.** If your connection proposes rather than writes (scope `propose`), `write_page` returns
`proposal_captured`: nothing was written. The owner sees exactly your change, as a Markdown diff of the page, and
approves or rejects it. If the page changes before they approve, the proposal becomes **conflicted** instead of being
applied, and you can propose again from the current page. Never submit a proposal twice; follow it with
`bridge_proposal_status`.

The other write tools (for resources, facts and links, maps and timelines) are being added; until they are in your
tool list, the low-level `lk_api_write` and `lk_api_batch` are the way to make those changes, with every guard in place.

## Budget rules

- Each project has its own request budget, shared by everyone using it. Every result ends with that budget line.
- Reads from the tree cost nothing. A live read costs one request. A tool says what it costs.
- Before a workload of hundreds of calls, ask `bridge_estimate`, and run multi-step work as one `lk_api_batch` job
  rather than a loop of single calls.
- **Never loop on a budget error.** `BUDGET_EXHAUSTED` names the time to retry: wait until then.
- Several pages at once: `get_resources` reads up to 25 as one job, and shows an estimate first when it is large.

## Proposals and the owner

The bridge owner controls what each connection may do. A connection with scope `read` can only read. One with scope
`propose` can ask for a write, which is held as a **proposal** for the owner to approve on the dashboard.

- A write that returns `proposal_captured` was not made. Tell the person it is waiting for approval; follow it with
  `bridge_proposal_status`. Never submit it again.
- `queued` and `waiting_budget` mean the write is accepted and will run. Follow a job with `bridge_job_status` or
  `bridge_job_wait`. Never submit it again.
- You cannot approve your own proposals, change your scope, or see other connections' jobs.

## When something goes wrong

Every refusal has a code and a plain message. The common ones:

| Code                                     | Meaning                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `AMBIGUOUS`                              | A name matched several pages (listed with paths). Pass the id of the one you mean.     |
| `NOT_FOUND`, `NOT_IN_REPOSITORY`         | No such page inside the AI REPOSITORY (it may be outside the root: use `lk_api_read`). |
| `TREE_NOT_READY`, `TREE_NOT_CONFIGURED`  | The repository tree cannot answer yet. Nothing was spent. Tell the owner.              |
| `SEARCH_SYNTAX`                          | The search query is malformed; the message says where.                                 |
| `SECTION_AMBIGUOUS`, `SECTION_NOT_FOUND` | A section path matched several headings, or none. The options are listed.              |
| `BUDGET_EXHAUSTED`                       | Wait until `retryAt`. Do not retry in a loop.                                          |
| `PROJECT_REQUIRED`                       | A write did not name its project. Pass `project`.                                      |
| `VERSION_CONFLICT`                       | The page changed since you read it. Nothing was written: read again and redo the edit. |

`bridge_errors_recent` lists recent failures with LegendKeeper's request ids when you need to report one.
