# ADR 0029: The Discover and Read tools, the guides, and hiding the low-level tools per profile

Status: Accepted (v2 session B2, 10 November 2026). Implements the Discover and Read rows of PLAN-v2 section 5 on
the services of A2 (repository tree), A3 (registry and resolver), A4 (asset tree) and B1 (Markdown converter). Migration
1100 is this session's.

## Context

Agents need a few tools that are cheap, safe and hard to misuse: to find pages, look at one, and read its text. The
services already exist; this session exposes them. Three questions needed a decision: what a tool does when the tree
cannot answer, how a search that mixes the tree with LegendKeeper's own (incomplete) search stays honest, and how the
raw LegendKeeper tools are hidden without changing what policy allows.

## Decisions

1. **Twelve new read tools**, each `access: read`, `readOnlyHint: true`, with the project argument and the budget footer:
   `browse_repository_tree`, `browse_asset_tree`, `search`, `get_resource`, `get_resources`, `list_tags`,
   `list_templates`, `list_calendars`, `list_assets`, `read_document`, `get_markdown_guide` and `get_bridge_guide`.
   Almost all cost nothing: they answer from the stored trees. The ones that read from LegendKeeper say so in their
   descriptions: `get_resource(s)` (1 read per page), `read_document` (1 read; a timeline 2 plus 1 per 100 events),
   `list_calendars` (1), `list_templates` (only when the bridge holds no copy), and `search` with `content: true` (1).
2. **Confinement.** The high-level tools work only inside the project's AI REPOSITORY root: the tree holds nothing
   else, so a page it does not hold is refused (`NOT_FOUND`, or `NOT_IN_REPOSITORY` for something shaped like an id)
   with a message saying the low-level tools (`lk_api_read`) can still reach it. The refusal is made from the tree, with
   no request. **The asset library is not confined**: it has no AI REPOSITORY equivalent (the plan's root is a page),
   so `browse_asset_tree` and `list_assets` cover the whole library. Templates sit outside the root by design, and
   `list_templates` lists them.
3. **The tree's status is part of every answer.** Each answer from the tree carries `tree: { status, confirmedAt,
confirmed ("5 h ago"), note }`. `ready` and `stale` answer (stale says so); `not_configured`, `not_built` and
   `building` are refused (`TREE_NOT_CONFIGURED`, `TREE_NOT_READY`) with nothing spent. The one **live fallback** is a
   plain-text `content: true` search: LegendKeeper returns each hit's ancestry, so the hit can be confined to the root
   without the tree, for one read. Operators need the tree. `get_resource` and `read_document` do not fall back: from an
   id alone, root membership would cost a read per ancestor.
4. **Search syntax and semantics** are a small pure module (`src/discover/search.ts`) with its own tests. NOT binds
   tightest, then AND (the default), then OR; operators are operators only in capitals. A bare term is a case-folded
   substring of the display name, aliases, Canonical Display Name or Scope; each term may match a different field.
   Ranking is exact name, name prefix, a word of the name, text inside the name (added: a tier between "word" and
   "alias" so `khal` finds `al-Khalid`), alias or Canonical Display Name, then Scope; the score of a result is the sum of
   its terms' tiers, ties by name and path. `type:` and `scope:` match whole words (`type:character` finds both
   Character Core and Compact Character Reference); `tag:` and `kind:` are exact; `under:` resolves a page like any
   name (ambiguity lists candidates) and means "below it, not itself". A malformed query is refused with a position.
5. **Content search is merged, never trusted.** With `content: true` the bridge sends LegendKeeper only the positive
   free-text words (no operators: it has none), once, takes up to 100 hits, drops those outside the root and
   duplicates (LegendKeeper repeats a resource per matching document), and then applies the operators to the combined
   set: for a page LegendKeeper returned, each positive word counts as met, while filters and negated words are still
   checked on the tree (page text cannot satisfy a NOT). Pages found only by their text are marked and rank below every
   name, alias and scope match, in LegendKeeper's order. The answer and the tool description say content search is
   incomplete by nature.
6. **`get_resource`** combines the tree node with one live `getResource`: facts in the order returned, link
   collections with items (each item names its page and, for a document-level link, the document), and other properties
   named and marked read-only (`unsupported` ones too). **Finding to carry forward:** LegendKeeper's `getResource` answer
   carries no version for a sidebar property (only `listProperties` / `getProperty` do). The tool includes a property's
   `version` where the response has one; C2's `set_facts` must read it itself.
7. **`get_resources`** (at most 25) runs one `batch_ops` job of `getResource` steps at interactive priority, waits up to
   25 seconds and reads the step results (a new `JobEngine.stepResults`). A page that cannot be resolved is reported in
   its own entry. More than 10 live reads return an estimate (reads, time, tightest tier) and run on `confirm: true`.
   Results are summaries unless `detail: "full"`.
8. **`read_document`** uses B1 unchanged (`toMarkdown`, `outline`, `getSection`, `renderMap`, `renderTimeline`,
   `renderBoard`); a converter problem is reported, not worked around. Size follows the tool layer's rule: a result over
   `MCP_RESULT_MAX_CHARS` is stored and returned as a handle (with a preview) for `bridge_result_page`. Every tool that
   can return a long answer goes through the same rule.
9. **Guides** are the files `docs/markdown.md` and the new `docs/bridge-guide.md`, read on every request (the server
   runs from a checkout, so the docs folder is there), served as tools and as MCP resources
   (`lk-bridge://guides/markdown`, `…/bridge`). The server instructions shrink to a few sentences that point to
   `get_bridge_guide`.
10. **`showLowLevelTools`** is a column on `agent_profiles` (migration 1100, default off), set by an owner command
    (`profile.set_low_level_tools`, audited with before and after), by `PUT /api/admin/clients/profiles/:id/low-level-tools`
    and by a checkbox on Clients & Access. It is read live with the profile's scope. A tool marked `lowLevel`
    (`lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, every `lk_op_*`) is left out of
    `tools/list` for a profile without it. **Hiding is cosmetic:** every tool is still registered, and the call-time
    checks (the read-only refusal in the tool registry, the policy gate, the engine's guards) are untouched, so a hidden
    tool that is called anyway is refused or allowed exactly as before. `lk_api_read`, `lk_api_write`, `lk_api_batch` and
    `lk_upload_image` stay visible; the final list is E3's decision.

## Consequences

- A change made in the LegendKeeper app shows in `search` and `browse_repository_tree` only after the next sweep (an
  hour by default); `get_resource` and `read_document` read live. Said in the bridge guide.
- ChatGPT keeps its own copy of the tool list: after this change the owner uses Plugins, the bridge, Refresh.
- No write tool is added here (C1, C2). The write tools the guide mentions are described as coming.
