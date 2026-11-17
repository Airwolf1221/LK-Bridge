# ADR 0035: The page lifecycle: Working, Authoritative and Archived pages, the four lifecycle tools and their guard

Status: Accepted (v2 session C2c, 10 November 2026). Implements the owner's decisions of 10 November 2026 on the page
lifecycle, on C2b's tools (ADR 0034), C2a's canon guard and proposal groundwork (ADR 0032), C1's engine hooks (ADR
0031), A3's registry, resolver and placement (ADR 0026) and A2's tree (ADR 0025). Migration 1600 is this session's.
PLAN-v2 gains the C2c session (between C2b and the mid-point review, whose scope now covers it) and a
lifecycle-consistency audit for E2. No other decision in PLAN.md or PLAN-v2.md is changed; the choices below fill the
gaps the owner's brief left.

Decision 8's tags (and decisions 9 and 10's) are unchanged on every project except one whose approved setting pack says
the lifecycle tag leads, or carries the AU ruling: [ADR 0053](0053-v3-f3d-lifecycle-tag-leads-au-in-the-lifecycle-routing-lines.md)
(v3 F3d, 17 November 2026).

## Context

The owner works with three kinds of page: the current canon (`[BSRC]`, Status Authoritative), material being worked on
(`[BWRK]`, Status Working, under `[INDEX] Working`) and retired designs kept for provenance (`[BARC]`, Status Archived,
under `[INDEX] Archived`). Until now an agent could make a page Working or Archived, or take one out of canon, by any
route that changes a Status, a name or a parent, and nothing kept the four signals (prefix, Status, tag, place) in step
or remembered how to reverse a change. The owner decided that a page changes state only through dedicated tools, each
with the owner's canonical approval, and that every other route is refused.

## Decisions

1. **Three states, per-project settings** (src/lifecycle/settings.ts). Authoritative (`[BSRC]`, `Authoritative`,
   `CANON`, its normal place), Working (`[BWRK]`, `Working`, `Working`, directly under `[INDEX] Working`, flat,
   alphabetical) and Archived (`[BARC]`, `Archived`, `Archived`, directly under `[INDEX] Archived`, flat,
   alphabetical). The Status values, tags, fact names (Status, Continuity Type, Scope, Temporal Scope, Last Major
   Revision), Continuity Types (CANON, AU, NON-CURRENT) and archive texts are per-project settings with the owner's
   values as defaults, edited on the dashboard and audited (`project.set_lifecycle`). An invalid stored value falls back
   to the defaults with the reason.
2. **The two indexes are found by name and confirmed by the owner.** The tree is searched for exactly one index of
   each configured name (never a fixed id or position); the dashboard shows what it finds (found, missing, ambiguous
   with candidates) and the owner confirms both ids. Until both are confirmed, and whenever a confirmed index has gone,
   been renamed or stopped being an index, or the two are the same page or nested, the four tools and every Working
   create refuse (`LIFECYCLE_NOT_CONFIGURED`, `LIFECYCLE_INDEX_MISSING`, `LIFECYCLE_INDEX_CHANGED`) with what the owner
   must do. Rejected: using whatever the lookup finds at call time; a renamed index would silently send pages elsewhere.
3. **Two new kinds** (`bwrk`, `barc`) everywhere a kind is used: the tree's classification (exactly one prefix, then the
   display name, as for `[BSRC]`), the sibling order (`[INDEX]` first, then the three page kinds together,
   alphabetical), `search kind:`, `browse_repository_tree`, `get_resource`, the resolver and the dashboard. SQLite cannot
   widen a CHECK in place, so migration 1600 rebuilds `tree_nodes` and its two child tables exactly as they were apart
   from the CHECK. An existing tree re-derives every node's kind from its stored raw name once, keyed by a
   classification version in the catalogue key, so pages already named `[BWRK]` or `[BARC]` stop being `unclassified`
   without a walk of LegendKeeper.
4. **Which page a name means.** Among matches of the same subject the resolver prefers the current page (`[BSRC]`, or an
   index), then `[BWRK]`, then `[BARC]`, then A3's character-role order; matches of different subjects stay ambiguous,
   each candidate with its role. This applies to mentions and to page arguments.
5. **`status` on the creation tools; Working by default** (owner). `create_resource`, `create_bare_resource`,
   `create_many_resources` (per item) and `create_character` take `status: "working" | "authoritative"`, default
   `working`, which changes C2b's behaviour (CHANGELOG). Choices where the brief left room:
   - a single Working create goes **directly under `[INDEX] Working`**: `parent` may be left out or name that index,
     anything else is `WORKING_PARENT`; in `create_many_resources` a Working item may also go under a character index
     directly under Working, and nothing goes under a Working item (flat);
   - `create_bare_resource`'s prefix must agree with `status` (`[BWRK] ` for Working, `[BSRC] ` for Authoritative);
     `[BARC] ` is refused (only `archive_page` archives); an `[INDEX] ` name takes no status;
   - a Status given in `facts` must agree with `status` (`INVALID_FACTS`), so a create can never smuggle another state;
   - **an index has no lifecycle state and gets no Status** (C2b gave a new index Status Working), and no index is made
     under a lifecycle index except a Working character's own index by `create_character`;
   - the project's `agentDefaultStatus` (C2a's "Status of pages agents create") is superseded by the lifecycle Status
     values and removed from the dashboard; the API still accepts it, unused;
   - no lifecycle record is written for a create (the record is for changes of state); an Authoritative create is a
     canonical proposal through the lifecycle marker (decision 11) as well as the canon guard.
6. **Working characters** (planCharacterPlacement with `working`): a Core gets its own `[INDEX] {name}` directly under
   `[INDEX] Working` (reused when it exists) with `[BWRK] {name} - Character Core` beneath it; a compact page goes
   directly under Working. The race is still resolved and validated, and Race / Species written. Return-existing and
   the duplicate check look under both the race and Working (an Authoritative plan is given Working through
   `lookUnder`). When the race already holds an `[INDEX] {name}`, a Working Core is refused (`CHARACTER_INDEX_ELSEWHERE`):
   promoting it later would clash with that index.
7. **Four tools, one job each, always canonical** (src/mcp/tools/lifecycle.ts). `archive_page`, `unarchive_page`,
   `move_to_working` and `promote_page` plan with reads only, answer `dryRun` with the full plan, and submit one
   `batch_ops` job carrying the lifecycle marker with `canonical: true`: at every scope it becomes a canonical proposal
   (the plan shows the move and new name, a facts table, the tags, the note as a Markdown diff, flags and, for the two
   tools that take a page out of canon, the related pages). A duplicate request for the same page while one waits or
   runs is refused (claim key `lifecycle:<pageId>`). Choices: a page with pages under it is refused (`HAS_SUBPAGES`,
   listed: a lifecycle change moves one page; Working and Archived are flat); a page whose prefix and Status disagree
   is refused (`LIFECYCLE_INCONSISTENT`) rather than guessed; a page already in the target state answers
   `NOTHING_TO_DO`; a name taken in the destination is `NAME_TAKEN`.
8. **`archive_page`** (owner's texts). The note is **one plain paragraph block inserted as the first block** of the
   page's main page document (the page document named Main, else the first), so nothing else in the document moves or
   changes; a page with no page document is refused. `{date}` is today's ISO date on the Europe/London clock (the
   owner's clock, as the maintenance schedules); `{source}` is the page's display name. Scope is the prefix, one space
   and the original Scope, or the prefix alone when the original is empty. Missing fact rows are added in the
   template's order. Only the **outgoing status tag** is removed (`CANON` or `Working`), `Archived` added, other tags
   untouched.
9. **`unarchive_page` restores from the lifecycle record.** The record holds the page's previous state, parent, rank,
   name, prefix, the five facts, the tags and the note's block id and exact content. A fact that was absent before
   archiving is removed again; Last Major Revision becomes today. The note is removed only if the block is still
   exactly as inserted (compared as stored blocks), otherwise kept and flagged; a Scope edited since archiving is
   flagged and the recorded original restored. A previous parent that is gone, the root, outside the repository or in a
   lifecycle area needs `destination`. A page archived by hand (no record) needs `previousState`, `restore` and, for an
   Authoritative page, `destination` (`NO_LIFECYCLE_RECORD` names what is missing); no note is removed for it.
10. **`move_to_working` and `promote_page`.** `move_to_working` takes only `[BSRC]` pages; its record keeps the parent,
    which `promote_page` offers as `suggestedDestination` (never used unless passed: the owner decides where canon
    goes). A Character Core under its own character index moves **alone** (flagged): moving the index would take the
    character's other pages out of canon too. `promote_page` requires `destination`; Last Major Revision today;
    Continuity Type kept when CANON or AU, otherwise CANON; a Working character's Core or compact page under its own
    `[INDEX] {name}` under Working takes that index with it (one more move), and other pages under the index keep their
    state and are listed.
11. **The lifecycle guard** (src/lifecycle/guard.ts), combined with the canon guard in the engine (`combineGuards`), on
    every request and write: a Status change to or from Working or Archived (so Working to Authoritative too), a rename
    that adds, removes or changes `[BWRK]` / `[BARC]`, a page created with one, and a move into, out of or between the
    lifecycle indexes (or a page created under one) are refused with `POLICY_DENIED` naming the tool, at every scope
    (refused, not proposed). It runs at entry (sidebar writes simulated as the canon guard does; names and places from
    the tree), at execution of an approved proposal, and inside the lock before each rename, move or sidebar write; a
    row write chained from the job's own earlier write (`ifMatch`, no in-lock read) is left to LegendKeeper's version
    check, as for the canon guard. The tools' own steps pass only through `BatchSubmit.lifecycle`, a **marker** set by
    bridge code, stored with the job and the proposal's job options, never read from an agent's body, and naming exactly
    the pages, prefixes, Status values and places the job may change; approved work that lacks it is refused at
    execution. Before the indexes are confirmed the guard still judges Status and prefix changes, but cannot tell a
    move across an index it does not know.
12. **Ordering, failures and resuming.** Steps are ordered so that a failure never leaves a misleading page: leaving
    canon (archive from Authoritative, move to Working) renames and retags first, then facts, note and move; entering a
    state (unarchive, promote) moves first, then facts and note, then renames and retags. Every write goes through the
    page's job-level lock, If-Match, the verify step and the journal. The job writes the record itself (`bridge.record`
    steps: `begin` before the first write, `complete` after the verify step); a job that stops leaves the record
    `incomplete`, and the answer says which steps ran. **Calling the same tool again resumes**: the plan is made again
    from the page as it is now towards the recorded target, and only what is left is proposed (a new canonical
    proposal; nothing is replayed). Another lifecycle tool on that page is refused (`LIFECYCLE_INCOMPLETE`) until then.
    Rejected: retrying the stopped job (it was approved for the page as it was).
13. **Two recommended canon rules, switchable** (owner: recommend, let the owner switch). `delete-archived` (kind
    `deleteKind`, `kinds: ["barc"]`) and `delete-document-authoritative` (kind `deleteDocument`, Status Authoritative,
    maps, timelines and boards) make those deletes canonical proposals, by the canon guard's machinery on every path,
    re-checked in the lock. Every rule gains `enabled` (default true); the dashboard switches a rule off and on.
    Migration 1600 adds both rules, on, to every project that stores its own rule list.
14. **The lifecycle record** (`lifecycle_records`): one row per change, never pruned, with page, action, date,
    principal, approver, the job ids (a resume adds its job), the proposal, complete or incomplete, and everything
    decision 9 needs. The dashboard's Archive and lifecycle page lists it, linked to the journal.
15. **Related pages from a link index** (`link_index`, `link_sweeps`): from-page, to-page, kind (collection or
    mention), via (the collection title or the document), when seen, and the source. An engine write observer keeps it
    in step with the bridge's own writes; the `link-sweep` maintenance job (daily 01:15 London, P3, background, waits
    while P1 or P2 work is queued, resumable after every page) refreshes it from LegendKeeper. `archive_page` and
    `move_to_working` report related pages with "link index as of …" plus the hits of one content search not already
    known, marked "found by text search (may be incomplete)"; `unarchive_page` and `promote_page` do not (a page
    returning to a state has nothing depending on it wrongly). Related pages are never edited.

## Costs

Measured against the mock (test/lifecycle/costs.test.ts): `archive_page` 5–6 reads to capture, then about 15 reads and
8 writes when accepted; `unarchive_page` 4, then 15 and 7; `move_to_working` 3, then 11 and 3; `promote_page` 2, then
11 and 5 (one more write for a character index). (C2c measured 19, 19, 15 and 15 job reads; the mid-point review,
CR-2026-11, took 4 off each without dropping a check.) The link sweep reads about one resource per page and index plus one
document per page document: about 2,500–2,900 reads a pass on the test world, 6,500–7,000 on Arkona, at P3 only.

## Consequences

- Pages created without a status land under `[INDEX] Working`: callers that relied on C2b's placement must pass
  `status: "authoritative"` (a canonical proposal) or promote later.
- Legacy pages whose prefix, Status, tag and place disagree have no tool path until the owner makes them agree; E2's
  lifecycle-consistency audit will report them (it never fixes).
- The guard closes every side route, including the owner's own agents at scope `write`; the owner changes states with
  the tools (and their canonical approval) or by hand in LegendKeeper.

## Open for the owner

- Whether `unarchive_page` and `promote_page` should also list related pages. **Decided by the owner on 11 November 2026: no.** Related pages stay listed only by `archive_page` and `move_to_working`, the two tools that take a page out of canon.
- Whether a page with pages under it should be archivable as a subtree (refused for now). **Decided by the owner on 11 November 2026: yes**, in session C2d ("Subtree lifecycle", [PLAN-v2](../PLAN-v2.md)): archiving a whole character (its index, Core and specialist pages) needs one canonical approval for the set, with the index archived too. Until C2d is built, the refusal stands.
- Whether the Working index should allow sub-indexes other than a character's own (flat for now, as decided).

## Amendments (CR-2026-11, 11 November 2026)

The mid-point review ([docs/reviews/CR-2026-11.md](../reviews/CR-2026-11.md)) closed side routes decision 11 meant to
close and did not: a caller's `If-Match` skipped the in-lock check; an `onError: "continue"` batch could blind the entry
check; moves were judged from the repository tree only; the two lifecycle indexes themselves could be renamed, moved or
deleted (which disabled the tools and could move pages out of their area); a template copy without a name or id, or
with its children, was half judged; a Status could be written as a page mention; and look-alike prefixes (`[barc]`,
fullwidth or Cyrillic letters, a missing space) were not read as prefixes. Each is now refused (decision 11's rule,
unchanged). One addition is proposed to the owner in [ADR 0036](0036-cr-2026-11-owner-decisions.md): a page made
`[BSRC]` by a create or rename that no tool declares is a canonical proposal (decision 5 applied to every route).

## Amendment (C2d.1, 12 November 2026)

The owner's live test of 12 November built a Working character with `create_character` (a Core under its own index) and
then made two specialist pages with `create_resource`. Decision 5's rule for a single Working create (`parent` is
`[INDEX] Working` or nothing) put them flat beside the character's index, while `create_many_resources` could place a
Working item under a character index, so a Working character's set could not be built up one page at a time, and the
set promotion later took only the index and the Core. Decided by the owner and built in C2d.1 (no new decision is
overturned; decision 5's single-create rule is widened and the C2d layout rule applied to it):

- **Decision 5, widened.** A single Working create (`create_resource`, `create_bare_resource`) takes a `parent` that is
  `[INDEX] Working` itself (the default, unchanged) or an `[INDEX]` page inside a Working set: a character's index
  directly under `[INDEX] Working`, or any index within a Working set kept together (ADR 0037 decision 10). The page is
  placed alphabetically among that index's children. Any other parent, including every `[BWRK]` page, a normal-tree
  index and anything in the Archived area, is `WORKING_PARENT`, whose message and `allowedParents` name the allowed
  ones. `create_many_resources` follows the same rule (it was "a character index directly under Working"); a Working
  item is still never under another item (`parent_key`). `create_index` is unchanged: no index is made under a lifecycle
  index, so a Working set's index is a character's (`create_character`) or one the owner moved there.
- **Decision 11, clarified.** The guard already judges a move by the area of its source and its destination, so a move
  inside one area has always been allowed; the owner confirmed that it is meant to be. **Within the Working area** a
  `[BWRK]` page (or a Working set's `[INDEX]`, with its pages) moves between `[INDEX] Working` and an `[INDEX]` inside a
  Working set, and back; **within the Archived area** a `[BARC]` page, or an archived set's `[INDEX]` together with its
  pages, moves between `[INDEX] Archived` and an `[INDEX]` inside an archived set, and back. These are ordinary moves
  by `move_resource`: no lifecycle change, no marker, no canonical approval; prefix, Status and tags never change. A
  move into or out of either area, or between the two, is refused as before (`POLICY_DENIED`, naming the lifecycle
  tool). A page still cannot go under a content page (`PARENT_NOT_INDEX`).
- **Decision 9, clarified.** A move writes no lifecycle record, so each page's record keeps its original previous place
  and `unarchive_page` returns it there, not to where it was moved within the archive. One addition: a formerly
  Working page now goes back to the `[INDEX]` inside a Working set that its record names when that index is still in the
  Working area (a Working specialist page archived on its own returns to its character's index), else to
  `[INDEX] Working` as before; a Working set's root likewise (ADR 0037 decision 10). Authoritative pages are unchanged.
- **For agents.** The bridge guide and the `create_resource`, `create_character` and `move_resource` descriptions say
  how to build a Working character: `create_character` (Working), then `create_resource` (Working) with `parent` = the
  character's index.
