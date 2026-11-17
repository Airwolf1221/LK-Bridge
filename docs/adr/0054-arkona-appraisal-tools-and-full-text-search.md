# ADR 0054: Arkona appraisal tools and full-text search

- Status: **Proposed** (v3 F3c, 17 November 2026). Every decision is implemented and tested against the mock
  LegendKeeper with fixtures built from the shapes the design quotes (a Salahad slice, Races of Arkona, a character set
  with its Core, Art, Biography and Relationship pages, one page per A2 defect and a clean page, an asset tree with each
  A5 case), never fetched. Where the design left room, the choice is marked **chosen**; where the build differs from the
  design's words, **departure**, with the reason.
- Carries out: the owner-approved design [design/F3c-appraisal.md](../design/F3c-appraisal.md) (approved 17 November
  2026: D1 to D4 as written, with the owner's addition, section F, "Propose a fix").
- Builds on: [ADR 0044](0044-audits.md) (the audits: the snapshot overlay, the findings store, "Propose a fix"),
  [ADR 0042](0042-snapshots-restore-rehearsal.md) (the snapshots), [ADR 0029](0029-discover-and-read-tools.md) (the
  `search` tool), [ADR 0050](0050-setting-packs-and-the-arkona-character-tool.md) and
  [ADR 0052](0052-arkona-pack-owners-relationships-art-and-the-brief.md) (the pack's rules as data: identity fields,
  placeholders, roles, templates, headings, the overload heuristic), [ADR 0046](0046-e4-owner-decisions.md) decision 1
  (block-by-block writes) and [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) (Last Major
  Revision only for real revisions).
- Migration: **`3200_appraisal.sql`**: the materialised overlay and its FTS5 table, the references and images, the
  index's state, and the stored runs and their findings. 3100 is left free: F3.3 (still running) may need one, and
  migrations are applied in version order with gaps allowed.
- Numbered 0054: F3.3 (the lifecycle tag position, AU in the lifecycle tools, routing lines; its branch commits as
  "F3d") takes 0053.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script.

## Context

Repository Automation sets the boundary: "Automations are diagnostic and read-only by default. Report detected issues
and the appropriate interactive follow-up; do not silently perform the repair." The design asks for five read-only
tools (A1 to A5) that cost no API reads, read the nightly snapshot plus the change snapshots since (as the audits do),
say what they inspected, how fresh it was and what they could not check, and never guess. The owner's addition
(section F) asks for clean ways to act on what they find, like the audits' "Propose a fix", without the appraisal ever
writing: a fix is a separate, explicit request that becomes one ordinary proposal.

## Decision 1: the overlay materialised in the bridge's database, with an FTS5 index (A1)

The audits lay every change snapshot over the newest full snapshot at each run (ADR 0044 decision 1). The appraisal
answers per request, so the same overlay is **materialised** once and kept current (`src/appraisal/overlay.ts`):

- **built** from the newest full snapshot and the change snapshots after it, with the audits' own rules (a change
  snapshot's page entry replaces the pieces it took and keeps the rest; a page it records as deleted leaves);
- **updated** from each later change snapshot, page by page: only the pages it took are re-indexed;
- **rebuilt** when a newer full snapshot exists (the snapshot service's `afterFull` hook starts it at once), and when a
  change snapshot turns up older than one already laid over (two jobs indexed out of order are never merged out of
  order);
- **caught up** first by every call that reads it (`ensure`), so an answer is complete as of the newest snapshot. It
  reads the snapshot store only, never LegendKeeper.

Per page it keeps its place in the snapshot's tree and its pieces' hashes, its **text units** (the name, each alias,
each sidebar row's value by key, each block of text with its document, block and section path; a table row is one
unit, a mention reads as its label), its **references** (every mention and collection item, with where it is and the
text around it) and its **images** (each image block with the label heading above it and whether interpretation text
follows). Per project: the templates' sidebars and the state (base snapshot, newest snapshot laid over, counts,
timings, size).

The FTS5 table uses `unicode61 remove_diacritics 2` (case and accents ignored). **Chosen: no prefix index.** A word
already matches as a prefix (`fox` finds "Foxians"); the widest prefix query measured (two letters, over 90,000 units)
takes about 30 ms without one, and a `prefix = '2 3'` index cost 4.3 MB more and 15% more build time on the same
fixture. It can be added by a later migration if real queries need it.

**Departure: a partial full snapshot is accepted as the base.** The audits use the newest _complete_ full snapshot. A
full snapshot is partial when a piece could not be taken (an image whose bytes answered 404, for example); refusing it
would leave the appraisal a day behind for one missing image. The pieces the snapshot lacks are listed: the pages
concerned are **blocked cases** (Incomplete or Inaccessible), never guessed.

**Measured** on a fixture of Arkona's size (`test/appraisal/scale.test.ts`): 1,500 Arkona-shaped pages (a 17-row
sidebar with Dependencies and Related Sources, a Main document of about 40 blocks and 600 words with headings, mentions
and a table, an alias), their pieces canonical and gzipped in a real snapshot store on disk, as a nightly snapshot leaves
them; 90,000 text units and 12,000 references.

| What                                                  | Measured      |
| ----------------------------------------------------- | ------------- |
| Building the index from the full snapshot             | about 2.0 s   |
| Updating it from one change snapshot of five pages    | about 37 ms   |
| A phrase query                                        | about 1 ms    |
| The widest prefix query (two letters, every page)     | about 30 ms   |
| The index's size (its tables and indexes, `dbstat`)   | about 21 MB   |
| The database file's growth (with SQLite's free pages) | about 25.5 MB |

A real page's text varies, so read these as a size: the index grows with the text (about 14 KB a page here).

## Decision 2: `search` with `content: true` uses the index; `content: "live"` keeps LegendKeeper's (A1, D1)

- `content: true` now searches the bridge's full-text index, **free**, with the existing operators. Each term is
  answered as the set of pages whose text holds it, so words (all must match), `"phrases"`, `OR`, `NOT` and brackets
  combine whole pages exactly as they combine names. A page found through its text carries `text` hits (document,
  block, section path, a snippet with the words marked «»), and every result of such a search its `lifecycle`
  (Authoritative, Working, Archived) and `branch` (the top-level index it sits under). The answer's `content` note names the index's base full
  snapshot, its newest change snapshot and their age, and says it is discovery evidence, never proof on its own.
- `content: "live"` is LegendKeeper's own search, unchanged (1 read, ranked, incomplete by nature).
- With no full snapshot yet, `content: true` searches names, aliases and Scope only and says so.
- **Scope (D1)**: the project's repository root. The **Legacy Canon Archive** and the **Design References** are left
  out unless `include: ["legacy", "design"]` names them; the answer counts what was left out. Each area is an index
  found by its name anywhere in the repository (never a hard-coded id), as the lifecycle indexes are; the design area
  also takes every index the owner lists as "Authoritative without CANON" (E5.3's lifecycle setting). **Chosen:** the
  exclusion applies to `content: true` only, so a name search without it answers exactly as before.

This changes what `content: true` costs and means, and supersedes that part of PLAN-v2 section 5's `search` row
("`content: true` also uses LegendKeeper's search"): an agent that wants LegendKeeper's search now says
`content: "live"`. The tool's description, the guide and [tools.md](../tools.md#finding-things) say so.

## Decision 3: `arkona_appraise_owner` (A2, D2)

One page (`page`), a branch (`under`) or everything (`all: true`), bounded (5,000 pages) and paged, in Repository
Automation's four groups: **required defects**, **optional polish**, **architectural candidates**, **blocked cases**.
Every check of the design's table, in its stated group, naming its rule (governance page and section) and its evidence
class (`src/appraisal/rules.ts`, the catalogue the reports, the dashboard and the docs share):

| Check                                                                    | Group         | Follow-up                        |
| ------------------------------------------------------------------------ | ------------- | -------------------------------- |
| `purpose_first`: the body does not begin with Purpose                    | required      | judgement (`write_page`)         |
| `title_repeated`: the title or a metadata header at the top              | required      | judgement (`write_page`)         |
| `heading_links`: a link inside a heading                                 | required      | **fix**                          |
| `literal_markdown`: Markdown pasted as text                              | required      | judgement (`write_page`)         |
| `blank_paragraphs`: decorative blank paragraphs                          | polish        | **fix**                          |
| `em_dash_name`, `em_dash_text`: an em dash in the name, or the body      | required      | **fix**                          |
| `template_field_missing`, `field_improvised`: the template's fields      | required      | judgement (`set_facts`)          |
| `completion_gate`: the six identity fields (Core and Compact only)       | required      | judgement (`set_facts`)          |
| `boundaries_missing`: Source Boundaries or Unresolved Material           | polish        | judgement (`write_page`)         |
| `dependency_noncurrent`: a Dependency on a Working or Archived page      | required      | judgement (`set_facts`)          |
| `related_noncurrent`: one in an Authoritative page's Related Sources     | required      | **fix**                          |
| `related_empty`: an empty Related Sources (a prompt to review)           | polish        | judgement (`set_facts`)          |
| `related_not_reciprocal`: no link back within a character's set          | polish        | judgement (`set_facts`)          |
| `index_incomplete`: scope statement, "why open" text, Subpages           | required      | judgement (`write_page`)         |
| `sibling_order`, `tag_grammar`: the audits' findings, gathered           | required      | the audits' own fix, handed over |
| `scope_overload`, `core_holds_specialist`: a pointer for A6              | architectural | judgement                        |
| `page_unreadable`, `not_in_snapshots`, `template_unavailable`, `no_body` | blocked       | none                             |

The rules come from the pack's own data (the identity fields, placeholders, roles, templates, first heading and
overload heuristic its creation tools use), so one change to the pack changes both. **Chosen** where the design left
room:

- **Purpose first**: the first block that is not blank, after at most three repeated title or metadata blocks, must be a
  heading reading the pack's first heading (`Purpose`). A repeated title is a heading or paragraph reading the page's
  display name, its full name, its subject or its Canonical Display Name; a metadata header is what the pack's own
  `looksLikeMetadata` recognises (a `Status:` line and the like).
- **Pasted Markdown**: `**`, a leading `# `, a leading `- ` and pipe-table rows in text runs (never a code block).
- **Decorative blank paragraphs**: every top-level paragraph with no visible text; a page made only of them is left to
  its Purpose finding.
- **Dashes**: an em dash, or an en dash used as a separator, in the name's display part, the headings and the prose
  (never code), the same characters the pack's own name rule replaces (ADR 0050 decision 7).
- **The template's fields**: compared with the template's sidebar from the overlay (a content page that is not a
  character's is compared with the pack's `general` template); a missing row the audits already report is gathered,
  not reported twice.
- **Source Boundaries and Unresolved Material**: only where the page's role lists them (the pack's `warnMissing`), and
  polish ("where applicable" is a judgement).
- **Reciprocal links**: within one character's set (the pages under its index), both ways.
- **An index**: a scope statement (its index-scope row, not a placeholder), "why open" text (any real text under
  Purpose), and a Subpages collection (a collection block in the body). The lifecycle indexes are exempt.
- **Scope overload**: a Core or Compact page whose headings cover three or more of the pack's overload domains; **a
  Core holding a specialist block**: one domain's section at least the pack's `minChars` long. Pointers only: A6 (the
  split appraisal) comes with F3e.
- **The audits, gathered, never re-checked**: every open finding of the page from the audits' store, except those about
  the audits' own configuration (`rules`, `audit`) and the tooling notices (`collection_blocks`, `unsupported_blocks`,
  `inline_icon_page`: about what the bridge can write back, not the page's quality). Grouped by severity (`info` is
  polish, the rest required; an inaccessible target is Inaccessible). F3.3's new lifecycle findings are gathered like
  the others once it lands; its "lifecycle tag not leading" fix only reorders tags, so it is handed over like the tag
  fixes (decision 8).
- **Chosen: a branch or everything leaves out the non-current areas** (the Legacy Canon Archive, the Design References,
  and Archived pages) unless `include` names them (`legacy`, `design`, `archived`), as D1 does for the search. A page
  named on its own is always appraised.

`live: true` re-reads the pages first (2 reads each: the page and its main document), at most 25 pages.

## Decision 4: `arkona_change_impact` (A3)

For a page as it is (`page`), a planned rename (`page` + `renameTo`) or a pending proposal (`proposal`: each page it
changes, and what it will become: archived, Working, Authoritative, deleted or renamed), from the overlay's references, the
chronology's tables and the full-text index:

- **proven breakage**: Dependencies, or an Authoritative page's Related Sources, pointing at a page that is (or will
  be) deleted, archived or Working; mentions whose target is (or will be) gone; for a rename, the mentions showing the
  old name and the chronology rows naming it (in a mention or in plain text): their displayed text will no longer match;
- **review candidates**: every other incoming Dependency, Related Sources link and mention (a mention showing another
  label does not depend on the name); chronology rows naming the subject; and **textual restatements**: other pages'
  text naming the subject (its name and aliases, through the index) without linking to it. Only ever candidates:
  "a resource change is not proof every document changed substantively". Text that already links to the subject is
  listed as the mention, not again; the subject's own page is never its own restatement.

Each with its page, section and snippet. A proposal that is no longer pending is `PROPOSAL_NOT_FOUND`; nothing is
decided. `live: true` re-reads the subject's resource (1 read: its name and aliases; the linking pages are the
snapshots').

## Decision 5: `arkona_working_digest` (A4, D3)

Every Working page (`[BWRK]`) with its Status, Scope, Last Major Revision, when the snapshots first saw it and when it
last changed; every **pending or conflicted** proposal; **approved but not promoted** (a pack tool's package approved
and executed whose pages are still `[BWRK]`, found from the job's change snapshot); **declared contradictions** (Working
pages whose Unresolved Material says "contradict", "conflict" or "supersede"). Age is shown, never judged: no "stale"
threshold or group (D3). Ordered by the most recent change; `since` (`24h`, `7d`, `2w` or days) keeps what changed in
that window. Age comes from the snapshots' own history (**chosen**: LegendKeeper's `updatedAt` is not kept in the
pieces, ADR 0042).

## Decision 6: `arkona_visual_hygiene` (A5)

From the bridge's asset tree and the snapshots (the images each page shows, the library's stored bytes), every finding a
**candidate**, never a defect: an asset name with a file extension (the one with a fix: a rename); a non-WebP image
(its format read from the first bytes the snapshot store holds; an asset whose bytes it does not hold yet is a blocked
case, never guessed); an image outside its character's `Characters / <race path> / <Name>` folder (or its Forms,
Outfits, Details), worked out as the pack's art tool works it out; orphan candidates (no page shows them); image blocks
whose asset is gone; Art page images with no interpretation text after them; two images labelled as one subject's
Primary Reference. **Chosen**: orphans need the whole library, so a run narrowed with `page` or `under` says so in
`couldNotCheck` instead of listing them.

## Decision 7: reports, follow-ups and stored runs (D4)

Every finding has a stable `id` (a fingerprint: the same finding has the same id in every run), its `tool`, `check`,
`group`, `evidence`, `rule` (`{ page, section, rule }`), `page` (id, name, path), `message`, `details`, `source` (the
snapshot, the live read or the audit it came from, with its time), `labels` (lifecycle and branch) and a **`followUp`**
(section F): `fix` (the exact tool and arguments, `arkona_appraisal_fix { findingId }`, and a one-line description of
the change), `judgement` (the tool an agent would use and what has to be decided) or `none` (report only). Every report
says what it inspected, how fresh its data was and what it could not check.

Answers are paged (`limit`, default 50, at most 200; `offset`; `group`; `detail: "full"` for the evidence); `runId`
reads a stored run again without re-running it. The bridge keeps **the latest run per tool and scope** in its own
database, compared with the one before (new, still present, gone), as the audits compare runs. Nothing is written to
LegendKeeper.

## Decision 8: "Propose a fix" (section F)

`arkona_appraisal_fix { findingId }` (and the dashboard's button) for the deterministic set only. It re-reads the target
live (one read: the page, its document or the asset), checks the finding still holds (`FIX_STALE` otherwise, with what
is there now, and nothing is proposed), and makes **one ordinary proposal** for the owner, whatever the caller's scope
(`forceProposal`). Nothing is ever applied without the owner's approval.

| Finding                                       | The proposal                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| An em dash in the name                        | `updateResource` with the dashes replaced, the prefix kept, re-placed alphabetically if needed     |
| An em dash in the headings or prose           | write_page's block-by-block path: only those blocks replaced, every other character kept           |
| Decorative blank paragraphs                   | the same path: those blocks deleted                                                                |
| A link inside a heading                       | the same path: the heading's text kept, the link dropped                                           |
| An asset name with an extension               | `updateAsset` without the extension; refused when the folder already holds that name               |
| A Working or Archived page in Related Sources | that one link removed (set_facts' own plan)                                                        |
| Sibling order; tags                           | handed over to the audits' own "Propose a fix" (by the audit fix's kind), with the caller's origin |

Removing a **Dependency** on a Working page stays a `judgement` (the owner may need replacing rather than dropping).
**Last Major Revision** follows ADR 0051's rule like any edit: the engine measures the change from the fix's read. A
dash, a blank paragraph or a heading's link is punctuation or nothing, so the date is skipped; names and Related
Sources never count. **Chosen** to make that hold: the measure now reads a mention's label as text (before, a mention
read as empty, so a heading whose link was dropped looked reworded); this applies to every tool's measure and makes it
more exact. The audits' fix (ADR 0044) takes the caller's origin, so a handed-over fix is recorded as the agent's or
the dashboard's. **Chosen**: the asset rename's collision check uses the bridge's asset tree (the folder's names, kept
current by the bridge), not a second live read. Batch fixes are not built (section F, item 3).

## Decision 9: the dashboard's Appraisal page (D4)

A new page, **Appraisal**, in the navigation's **Quality** group (the route-coverage test checks it): the full-text
index (its base and newest snapshots, freshness, pages, units, size, build and update timings, and which non-current
areas were found), a form to run A2 to A5 on a page or branch (or everything), the report in its groups with each
finding linking to the page in LegendKeeper, **Propose a fix** only where the follow-up is `fix` (asks first, then says
it is a proposal for the Proposals page), a judgement's decision shown as text, and the latest runs (opening one shows
its stored report). Its admin API (`/appraisal`, `/appraisal/run`, `/appraisal/runs/:id`,
`/appraisal/findings/:id/propose-fix`, `/appraisal/index/rebuild`) reads only the bridge's own data; only "Propose a
fix" reads LegendKeeper (one read) and it writes nothing but a proposal. **Unverified**: the link's URL pattern
(`https://www.legendkeeper.com/app/{project}/{page}/`) is one constant (`LK_PAGE_URL`, `ui/src/pages/appraisal.tsx`);
this session could not open LegendKeeper to confirm it.

## Decision 10: costs

No LegendKeeper read for the search (`content: true`), A2, A3, A4 or A5, except `live: true` (A2: 2 reads a page, at
most 25; A3: 1 read). "Propose a fix": 1 read, then the proposal's own cost when the owner approves it.

## Consequences

- An agent finds page text completely as of the newest snapshot, for free; LegendKeeper's ranked search stays one word
  away. Edits made in LegendKeeper since the newest snapshot are not in the index until the next snapshot takes them.
- The owner can appraise a page or branch in one free call, read a report in Repository Automation's terms, and turn a
  deterministic finding into a proposal in one click. Nothing about the appraisal writes.
- The bridge's database grows by about the size of the index (about 21 MB for Arkona's size).
- Left for later: batch fixes (with F3d's selective approval), A6 (with F3e), more fixes as they prove safe (each with
  its own rule), a prefix index if real queries need one, and confirming the dashboard's LegendKeeper link.

## Tests

`test/appraisal/`: `fulltext.test.ts` (phrases, OR, NOT, brackets; the exclusion and `include`; freshness; an
incremental update; `content: "live"`), `owner.test.ts` (each check against its fixture page, the clean page silent,
groups, evidence and rules, the audits gathered and not duplicated, branch paging and stored runs), `impact.test.ts`,
`digest-visual.test.ts`, `fixes.test.ts` (each proposal exactly, stale findings, Last Major Revision skipped for the
dash and blank-paragraph fixes, the handovers, no button for a judgement), `no-writes.test.ts` (no tool writes),
`scale.test.ts` (the figures above); `test/ui/appraisal.test.tsx` and the sidebar's Quality group.
