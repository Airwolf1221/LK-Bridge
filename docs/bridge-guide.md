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
6. Make pages with the creation tools (`create_character`, `create_resource`, `create_index`, …), never by hand; pass an
   `operation_id` when you might have to repeat a call.

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

- **Kinds.** `[INDEX]` pages (kind `index`) organise; `[BSRC]` pages (kind `bsrc`, Authoritative), `[BWRK]` pages
  (kind `bwrk`, Working) and `[BARC]` pages (kind `barc`, Archived) hold the content (see
  [The page lifecycle](#the-page-lifecycle)); anything else is `unclassified` and is reported. Display names have the
  prefix removed: the page `[BSRC] Asagiri Miyabi` is "Asagiri Miyabi". When a name matches several pages of the same
  subject, the current `[BSRC]` page (or an index) is preferred, then `[BWRK]`, then `[BARC]`.
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

## Editing facts and links

A page's **facts** are the key-value rows of its sidebar property `PROPERTIES` (Reference Type, Scope, Status, …); its
**links** are its link collections (Dependencies, Related Sources). Change both with `set_facts`.

1. **Read first.** `get_resource` shows the page's facts and links as they are now, and their `factsVersion`. **Pass
   it back as `baseFactsVersion`** whenever a value is based on what you read, above all when you rewrite or replace an
   existing value: if anything in the sidebar changed since, nothing is written (`VERSION_CONFLICT`, listing what
   changed) and you redo the change on what is there now.
2. **Facts:** `facts` maps a key to its new value. A plain string is written exactly as text. For formatting or a
   mention of another page, send `{ "markdown": "…" }`: inline Markdown only (`**bold**`, `*italic*`, links, `<br>`,
   `[[Page Name]]`). `null` removes the row. Keys match without case, and an existing fact keeps its place.
3. **New facts** go where the page's template puts them (between the template's neighbours); a fact the template does
   not have goes at the bottom.
4. **Links:** `links` maps a collection's title to `{ "add": [...], "remove": [...] }`. Each entry is a page name or id,
   or `{ "page": "…", "document": "…" }` for one document of a page. Existing links keep their order and the
   collection's filter; added ones go at the end; a page already linked is reported, not added twice.
5. **Try it first when unsure.** `dryRun: true` shows what would change and writes nothing.

```json
{
  "project": "test",
  "page": "Asagiri Miyabi",
  "facts": {
    "Scope": "Foxian shrine maiden",
    "Sister": { "markdown": "[[Asagiri Kaede]]" },
    "Old Note": null
  },
  "links": { "Dependencies": { "add": ["Fourth Age - Table"] } }
}
```

**The result** lists the facts added, changed and removed, the links added, removed and already there, and whether the
bridge **verified** the change by reading the sidebar back. An edit that changes nothing writes nothing (`no_change`).

**A conflict (`VERSION_CONFLICT`) wrote nothing:** the sidebar changed after you read it. Read the page again and redo
the change; never send the same call again. **"written but not as planned"** means the change was made but the sidebar
read back differs (usually someone edited it at the same moment): read the page and tell the person. `WRITTEN_IN_PART`
lists the changes that were made before something stopped the rest: read the page before doing anything else.

**Mentions of a character.** A character often has several pages with its name: its `[INDEX]`, its Character Core,
perhaps a Compact Character Reference. `[[Name]]` matching several pages of ONE character links its **Core**, else its
**Reference**, else its **index**, and the result's `mentions` says which page was chosen and why. If the matches belong
to different subjects, or one of them is not a character page, the mention stays ambiguous: name the page by id. This
never applies to the page you write to: a `page` that matches several pages is refused with each candidate and its role.

Other refusals name what to fix: `MENTION_AMBIGUOUS` (the candidates are listed: use a more exact name or the id),
`MENTION_NOT_FOUND`, `FACT_VALUE_NOT_INLINE` (one line of inline text only), `FACT_KEY_DUPLICATED` (the page has two
rows with that key: tell the owner), `LINK_COLLECTION_NOT_FOUND` (the page's collections are listed),
`DOCUMENT_NOT_FOUND`.

## Canon and approval

Some facts are **protected canon**. By default:

- setting a page's `Status` to `Authoritative`, or changing it from `Authoritative` to anything else;
- changing an existing `Continuity Type` or `Continuity` (for example `CANON` to `AU`, or one AU to another). Setting
  them where they are empty, as on a new page, is fine;
- **deleting** a page whose `Status` is `Authoritative` (with `cascade`, any page under it that is). Restoring a deleted
  page needs no approval;
- **deleting** an Archived `[BARC]` page, and deleting a map, timeline or board of an Authoritative page (two rules the
  owner can switch off per project);
- **every lifecycle change**: creating an Authoritative page, and `archive_page`, `unarchive_page`, `move_to_working`
  and `promote_page` (below).

**No connection can make these changes on its own, whatever its scope.** A write that would make one (through
`set_facts`, `lk_api_write`, `lk_api_batch` or any other tool) becomes a **proposal**: the result is
`proposal_captured` with `requiresCanonicalApproval: true` and the `reason`, and nothing is written. Only the owner can
accept it, with a separate "Approve and accept as canon". Never retry such a write or look for another way to make it:
tell the person it is waiting for the owner, and follow it with `bridge_proposal_status`. Only the owner makes a page
`Authoritative`; the page-creation tools make Working pages unless you pass `status: "authoritative"`.

**An approval covers only what it listed.** The owner approves exactly the pages a proposal shows. If, by the time it
runs, a page it would touch was added (for example a new page under a page being deleted with `cascade`, or under a set
being archived), removed or moved, it does not run: the proposal becomes `conflicted` and nothing is written. Read the
pages again and propose afresh.

## Creating and changing pages

All of these work inside the AI REPOSITORY only, put a new or moved page in its alphabetical place (indexes first) in
the same write, never move or reclassify anything else, verify what they did, and take `dryRun: true` to show the plan
(pages, names, parents, places, facts) without writing. Under scope `propose` each call is one proposal; the ids of its
new pages are fixed in the proposal.

**New pages are Working by default.** Every page create takes `status`: `"working"` (the default) makes a `[BWRK]`
page directly under `[INDEX] Working` (leave `parent` out), with Status `Working` and the `Working` tag;
`"authoritative"` makes a `[BSRC]` page in its normal place (give `parent`), with Status `Authoritative` and the
`CANON` tag, and is always a proposal for the owner. Write new material as Working; the owner promotes it.

- **A character:** `create_character` `{ kind: "core" | "compact", name, race?, status?, facts?, links? }`. Working
  (the default): a Core gets its own `[INDEX] {name}` under `[INDEX] Working` with `[BWRK] {name} - Character Core`
  beneath it; a compact page goes directly under `[INDEX] Working`. Authoritative: the Core's `[INDEX] {name}` (an
  existing one is reused) under the race, or `{name} - Character Reference` directly under the race. An existing Core
  or Reference, Working or not, is **returned, not duplicated** (`status: "existing"`). The bridge writes Reference
  Type, Subject, Canonical Display Name, Race / Species (exactly as you give it; `Unestablished` when the race is
  unknown or omitted) and Status, then your facts. The race is always checked: an unknown or omitted race means
  `Undetermined / Unknown`; a race given that does not resolve is refused, never guessed or created. If another
  request for the same character is still under way (from you or another agent), you get `DUPLICATE_REQUEST` naming it:
  follow that one.
- **A page from a template:** `create_resource` `{ name, template, parent?, status?, facts?, links? }` (see
  `list_templates`).
- **An index:** `create_index` `{ name, parent }`, or `{ name, type, category }` (for example a category of a race). An
  index has no status, and none is made under `[INDEX] Working` or `[INDEX] Archived`.
- **Many pages at once:** `create_many_resources` `{ items }` (up to 100; nest them with `key` and `parent_key`; each
  item has its own `status`; Working items are flat, so nothing goes under one).
- **A page with no template:** `create_bare_resource` `{ name, parent?, status? }`, the name with its prefix:
  `[BWRK] …` (Working), `[BSRC] …` (Authoritative) or `[INDEX] …`.
- **Rename, tags, aliases, icon, banner, hidden, locked:** `update_resource` (a rename keeps the prefix and re-places
  the page). **Move:** `move_resource` `{ page, to }`.
- **Delete:** `delete_resource` `{ page, confirm: true }` (and `cascade: true` for a page with pages under it; the result
  lists every page removed). **Undo a delete:** `restore_resource` `{ page: "<id>" }`.
- **Maps, timelines, boards:** `create_document`, `update_document` (settings only) and `delete_document`.

**`operation_id`.** Every create tool takes an optional `operation_id` of your own. If a call times out or you are not
sure it went through, send the SAME request with the SAME `operation_id`: you get the first call's result
(`repeated: true`), and nothing is created twice. The same id with a different request is refused
(`OPERATION_ID_REUSED`): use a new id for a new request.

**A failed job is never replayed.** `WRITTEN_IN_PART` lists what was written, what was not, and the journal entries.
Read the pages, then make a new, smaller request for what is missing. `OUTCOME_UNKNOWN` lists under `uncertain` a write
whose answer was lost: it may have been made, so read the pages before anything else and never repeat it blindly.

## The page lifecycle

A page is in one of three states, and its prefix, Status, status tag and place always agree:

| State         | Prefix   | Status          | Tag        | Where                                   |
| ------------- | -------- | --------------- | ---------- | --------------------------------------- |
| Authoritative | `[BSRC]` | `Authoritative` | `CANON`    | its normal place                        |
| Working       | `[BWRK]` | `Working`       | `Working`  | directly under `[INDEX] Working`, flat  |
| Archived      | `[BARC]` | `Archived`      | `Archived` | directly under `[INDEX] Archived`, flat |

(The one exception to "flat": a whole set kept together, below.)

**Four tools change a page's state, and nothing else can.** Each one is always a proposal that only the owner can
accept as canon, whatever your scope: you get `proposal_captured` with `requiresCanonicalApproval`. Never retry it;
follow it with `bridge_proposal_status`. `dryRun: true` shows the whole plan (new name and place, every fact before and
after, the tags, the archive note) and proposes nothing.

- **`archive_page`** `{ page }`: retires an Authoritative or Working page to `[INDEX] Archived` as `[BARC]`, adds a
  dated note at the top of its main page document, and sets Status `Archived`, Continuity Type `NON-CURRENT`, Scope,
  Temporal Scope and Last Major Revision. Use it when a design is retired, not `delete_resource`.
- **`unarchive_page`** `{ page }`: puts an archived page back as it was, from the bridge's record: its old place,
  prefix, facts and tag. The note is removed if it was not edited. If the old place has gone, give `destination`; a
  page archived by hand needs `previousState`, `restore` and (for an Authoritative page) `destination`.
- **`move_to_working`** `{ page }`: takes an Authoritative page back to Working for rework (`[INDEX] Working`,
  `[BWRK]`, Status `Working`). The bridge remembers where it was.
- **`promote_page`** `{ page, destination }`: makes a Working page Authoritative under `destination` (`[BSRC]`, Status
  `Authoritative`, Last Major Revision today). Without `destination` you are told where it was before
  `move_to_working`, if anywhere. A Working character's index goes with its Core.

**Whole sets: `subtree: true`.** A set is a page and every page beneath it; the usual one is a character (its
`[INDEX] {name}`, Core and specialist pages). Pass `subtree: true` to any of the four tools to change the whole set as
ONE proposal (the owner accepts it as canon once). The set stays together: its root moves as a group (under
`[INDEX] Archived` or `[INDEX] Working`, or to `destination` for `promote_page`, or back to its old place for
`unarchive_page`) and nothing beneath it moves. Each content page gets the single-page treatment by its own previous
state; an `[INDEX]` page stays `[INDEX]` with no Status, only its status tag changes, and archiving adds a short note at
its top. A set must be all in one state, at most 100 pages, with no unclassified, inconsistent or half-changed page
(refused with `SET_NOT_ELIGIBLE`, listing each page). Use `dryRun: true` first: it shows every page's plan, the page
count and the estimated reads and writes. Changing ONE page of a set takes it out of the set; unarchiving one page alone
from inside an archived set needs `destination`.

**Related pages.** `archive_page` and `move_to_working` list the pages that link to or mention the page (from the
bridge's link index, with how fresh it is, and one text search marked "may be incomplete"); for a set, every page's,
leaving out links between pages of the set. They are never edited: tell the person, or change them yourself where a
page should no longer depend on this one.

**Side routes are refused.** Changing Status to or from `Working` or `Archived` (or `Working` to `Authoritative`) with
`set_facts` or any low-level tool, renaming a page to or from `[BWRK]` or `[BARC]`, and moving a page into, out of or
between `[INDEX] Working` and `[INDEX] Archived` are all refused (`POLICY_DENIED`), naming the tool to use instead.
**The status tags are guarded too**: adding or removing `CANON`, `Working` or `Archived` (in any case or spelling) with
`update_resource`, a low-level tool or a create body is refused, naming the lifecycle tool to use. Other changes to
Working and Archived pages (their text, other facts, links, other tags) work as usual.

**Stopped part-way.** If a lifecycle job stops part-way, the result says which steps ran. Call the same tool on the
same page again (for a set: on its root, with `subtree: true`): it plans what is left and proposes only that. Until then
another lifecycle tool on that page, or on any page of the set, is refused (`LIFECYCLE_INCOMPLETE`). Before the owner has confirmed the project's two indexes, the tools and Working creates are
refused (`LIFECYCLE_NOT_CONFIGURED`): tell the person.

## Dates and the chronology

The Universal Chronology has, for each age, a **table** (`Historical Event | Date | KCY`, in calendar order), a
**timeline** (one lane, "Historical Events") and a **count** on its Main table. **The table is the authority**; the
timeline is a view of it. Never edit them separately (with `write_page` or `lk_api_*`): use the timeline tools, which
keep all three in step in one job.

**Dates.** Write them in the chronology's forms: `Kumikas 1st, 1A 159` (a day), `4A 881` (a year), `Unknown, 4A 101`
(a year whose day is unknown), `Zahras 4A 367` (a month), `Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102` (a range),
`Jehet 11th - 18th, 4A 424` (days of one month), `Kumikas - Azaakh, 4A 180` or `Zahras 4A 367 - Attina 4A 367`
(months), `4A 881 - 4A 900` (years). `Unknown` alone is refused. The Archon Age (`AA`) counts down: `AA 5` is five
years before 1A. Each age begins mid-year (4A begins on Azah 18th, so `Kumikas 1st, 4A 1` does not exist). **Check a
date with `calendar_date` first**: it answers the age, the KCY as the table writes it, LegendKeeper's text, or exactly
why the date is refused. It costs nothing. `calendar_date` also turns minutes or a KCY into dates. **Two styles:** LegendKeeper writes a year with no thousands
separator on events (`AA 1988119`), the tables with one (`AA 1,988,119`); `calendar_date` gives both (`formatted` and
`tableFormatted`) and reads either, and the tools always write the table's style into a table cell.

**The tools.**

- `create_timeline_event { date, name, description }`: `name` is short (the timeline), `description` is the full text
  (the table). The age comes from the date. The row goes in calendar order (after rows of the same date; a year-only
  row after the dated rows of its year), the event links to the age's table, and the count goes up by one. An
  identical row is refused (`DUPLICATE_EVENT`).
- `update_timeline_event { event, date?, name?, description? }`: `event` names it by its `date` with its `description`
  or `name`, or by `row_id` / `event_id`. A date in another age moves it there (both counts change).
- `delete_timeline_event { event, confirm: true }`.
- `sync_timeline_event { row: { date, description } | { row_id, age } }` repairs the timeline for ONE table row, the
  table being the authority: it creates the row's missing event, or corrects the paired event's minutes, `detail`, shape
  and `uri` to match the row. It never touches the table or the count and never renames an event; a row whose event
  already agrees answers `nothing_to_do`. If several events could be the row's it refuses with the candidates
  (`PAIRING_AMBIGUOUS`): tell the person, or pass `event_id` to choose one. Use it for what the chronology check
  reports (a row without an event, a row and event that disagree about the date).
- `create_timeline_lane` adds a lane to an ordinary timeline; the chronology's age timelines have exactly one lane and
  refuse more.

If a table row and its event no longer agree, the other tools refuse (`CHRONOLOGY_DRIFT`): repair it with
`sync_timeline_event` (the weekly chronology check reports it, and the owner's dashboard offers "Propose a fix"). If a change stops part-way, send **the same request again**: it does
only what is left; other changes of that age wait for it (`CHRONOLOGY_INCOMPLETE`). Before the owner has confirmed the
chronology, the tools refuse (`CHRONOLOGY_NOT_CONFIGURED`): tell the person. These are ordinary edits, not canon, even on
an Authoritative page.

## Images

`upload_image` stores an image as a LegendKeeper image asset: converted to WebP at quality 90 (dimensions, orientation,
transparency and every animation frame kept; a WebP is stored as it is; metadata dropped), checked after storing
(`storedBytesVerified`), and filed in the right folder. Give exactly **one source**:

1. **`data_base64`**: fine for small images. A chat cannot pass a large one: a 2 MB image is about 2.7 million
   characters. For an image the person has in hand, ask them to upload it on the dashboard's **Staging** page and give
   you its staged id.
2. **`url`**: a public https image.
3. **`upload_id`**: if you have a shell or sandbox. Call `prepare_image_upload` with the file's `sha256`, `byte_length`,
   `content_type` and `name`; run the Python or curl script it returns with the file's path (it checks the hash and sends
   the file; it answers "received"); then call `upload_image` with the `upload_id` within 15 minutes. The capability in
   the script works once, for 5 minutes, for that file only: never put it in a URL or a page.
4. **`staged_id`**: place an image that is already staged.

`destination` says where it goes; the bridge plans it from the asset tree and refuses rather than guesses:
`for_character { name, race }` (a folder named after the character is reused wherever it is; otherwise
`Characters / Group / Race / Name`, created as needed; an unknown race goes to `Undetermined / Unknown`; a race that does
not resolve fails), `for_page` (a character page gives its character's folder; any other page needs a `folder` too),
`folder` (an id or a path such as `Characters / Beastkin / Qishen / Mehrana al-Khalid`), plus `subfolders`. Check with
`dryRun: true` first if unsure.

**Staging.** `stage: true` uploads and verifies the image but keeps it hidden in the staging folder; place it later with
`staged_id` (and a `destination`, or the one you gave when staging). With a `propose` connection every upload is staged
and the placement is a proposal for the owner: do not retry it. The same image sent again returns the existing asset
(`deduplicated: true`); never upload a copy to "move" an image.

**Using it.** Put an image on a page with `write_page`: `![alt text](asset url)` (only this project's assets). It can
also go in an image block (an `lk-block`), as a map pin's image, or as a map's image (`update_document`'s settings).
`list_assets` and `browse_asset_tree` show what the bridge knows of images it uploaded (`bridgeUpload`). Deleting an
asset keeps its bytes in the bridge first; if they cannot be kept the delete is refused until the owner allows it.

## Budget rules

- Each project has its own request budget, shared by everyone using it. Every result ends with that budget line.
- Reads from the tree cost nothing. A live read costs one request. A tool says what it costs.
- Before a workload of hundreds of calls, ask `bridge_estimate`, and run multi-step work as one `lk_api_batch` job
  rather than a loop of single calls.
- **Never loop on a budget error.** `BUDGET_EXHAUSTED` names the time to retry: wait until then.
- Several pages at once: `get_resources` reads up to 25 as one job, and shows an estimate first when it is large.

## Tool lists and the Operations list

The tools you are shown depend on your profile. The owner can show or hide the low-level tools
(`lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, `lk_op_*`), and a profile's scope decides
whether the write tools are shown. Hiding is cosmetic: you can still run any operation through `lk_api_read`,
`lk_api_write` and `lk_api_batch`, and policy decides what is allowed. If you do not have the low-level tools, the
**Operations** section at the end of this guide lists every operation id, with its kind and risk. Use an id exactly as
listed: an unknown id is refused with up to five close suggestions. `lk_api_describe_operation` gives an operation's
schema when you can see it; either way `getBlock` and `getDocumentBlocks` show the current shape of real data.

**Tool-list caching (for the person using the connector).** claude.ai keeps its own copy of a connector's tool list. On
10 November 2026 a change to tool visibility (the "Show low-level tools" checkbox, or a scope change that hides or shows
the write tools) appeared in claude.ai only after the connector was disconnected and reconnected in claude.ai's
settings; new chats alone were not enough. (Observed, not a guarantee.) In ChatGPT, use Plugins, then the bridge, then
Refresh.

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
| `requiresCanonicalApproval`              | The change touches protected canon: it waits for the owner. Never retry it.            |
| `DUPLICATE_REQUEST`                      | Another request for the same character is under way. Follow it (its job or proposal).  |
| `OPERATION_ID_REUSED`                    | That `operation_id` was used for a different request. Use a new id.                    |
| `WRITTEN_IN_PART`                        | Some writes were made, then it stopped. Read the pages; make a new, smaller request.   |
| `OUTCOME_UNKNOWN`                        | A write may or may not have been made (`uncertain`). Read the pages; do not repeat it. |
| `OWNER_APPROVED_JOB`                     | The owner approved that job; only the owner can cancel it.                             |
| `HAS_CHILDREN`                           | The page has pages under it: add `cascade: true` to delete them all.                   |

`bridge_errors_recent` lists recent failures with LegendKeeper's request ids when you need to report one.
