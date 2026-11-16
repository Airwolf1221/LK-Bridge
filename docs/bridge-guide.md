# The LK-Bridge guide for agents

This guide is for agents (Claude, ChatGPT) that use LK-Bridge to work with LegendKeeper worlds. **Read "How to decide" first**
(it is short: `get_bridge_guide` with `section: "How to decide"`), then the section for your task before you do it. The
tasks come first and the reference after. The last section, **Operations**, lists every LegendKeeper operation id.

## How to decide

**Five rules**

1. **Use the high-level tool, not `lk_api_*`.** Every common job has a tool that knows the repository (ordering, templates,
   canon, lifecycle, versions). The `lk_api_*` tools are the fallback for the rare job none of them does ([When the
   low-level tools are right](#when-the-low-level-tools-are-right)).
2. **Read, then write, and pass the version you read back.** `write_page` takes `baseVersion` (from `read_document`);
   `set_facts` takes `baseFactsVersion` (from `get_resource`). A stale version writes nothing. Never write a page you have not read.
3. **Never retry a write that came back `proposal_captured`, `queued` or `waiting_budget`.** It is not lost. Follow a job
   with `bridge_job_status`, a proposal with `bridge_proposal_status`. After a refusal, do the one step the message names, once.
4. **Canon and lifecycle belong to the owner.** Making a page canon, archiving it, bringing it back or deleting an
   Authoritative page is always a proposal only the owner can accept as canon, whatever your scope. New pages are
   **Working** until the owner promotes them.
5. **Do not invent.** Names and ids come from `search`, `browse_repository_tree` and `get_resource`; dates from
   `calendar_date`; operation ids from the Operations list. A name that matches several pages is never guessed: pass the id.

**Which tool?**

| You want to…                                        | Use                                                                     | Not                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| Find a page when you know part of its name or a tag | `search`                                                                | `browse_repository_tree` of the whole root        |
| See how a part of the repository is laid out        | `browse_repository_tree`                                                | many `get_resource` calls                         |
| Look at one page's facts, links, tags               | `get_resource` (`resources` for several, up to 25)                      | `read_document`, `lk_api_read`                    |
| Read a page's text (or one section)                 | `read_document` (`outline`, `section`)                                  | `lk_api_read` `getDocumentBlocks`                 |
| Change a page's text                                | `write_page`, section modes                                             | `replace` of the whole page, `lk_api_write`       |
| Change facts or links                               | `set_facts` (all changes in one call)                                   | `lk_api_write` on properties                      |
| Rename, tag, alias, hide, lock                      | `update_resource`                                                       | `lk_api_write`                                    |
| Make a character                                    | `create_character` (Working), then `create_resource` for its pages      | `create_many_resources`                           |
| Make an Arkona character, or add pages to one       | `arkona_create_character` (one package; projects with the pack)         | `create_character` and `create_resource` calls    |
| Make any other Arkona owner page (polity, race…)    | `arkona_create_owner` (one package; its home checked)                   | `create_resource` and `set_facts` calls           |
| Relate two Arkona characters, or add art to one     | `arkona_create_relationship`, `arkona_add_character_art`                | separate creates; `upload_image` to a destination |
| Recall who an Arkona character is                   | `arkona_character_brief` (free: the bridge's own records)               | many `get_resource` and `read_document` calls     |
| Make any other page                                 | `create_resource` (template), `create_index` for a category             | `create_bare_resource` (rare: see Create a page)  |
| Move a page                                         | `move_resource`                                                         | `lk_api_write` `moveResource`                     |
| Retire a page or a whole character                  | `archive_page` (`subtree: true` for a set)                              | `delete_resource`, `move_resource` to the archive |
| Make Working work canon                             | `promote_page` (`subtree: true` for a set)                              | `set_facts` Status                                |
| Delete (and undo)                                   | `delete_resource`, `restore_resource`                                   | `lk_api_write`                                    |
| Check or convert a date                             | `calendar_date`                                                         | working it out yourself                           |
| Add, change, remove a chronology event              | `create_`, `update_`, `delete_timeline_event`                           | `write_page` on a table; `lk_api_*`               |
| Add or move a map pin, region, path                 | `create_map_feature`, `update_map_feature` (pixels from the image)      | `lk_api_write` `createFeature`                    |
| Put an image in the library                         | `upload_image` (staged first at `propose`)                              | `lk_upload_image` (older; usually not shown)      |
| See older states of a page and bring one back       | `list_snapshots`, `snapshot_diff`, `restore_snapshot` (always proposal) | rewriting the text with `write_page`              |
| See what the audits found                           | `audit_findings`                                                        | scanning pages yourself                           |
| Know how much budget is left, or if work fits       | `bridge_budget`, `bridge_estimate`                                      | reading pages to find out                         |
| Know what happened to a proposal or job             | `bridge_proposal_status`, `bridge_job_status` (`wait_seconds` waits)    | repeating the write                               |
| Do something none of the above does                 | the `lk_api_*` tools, with an id from Operations                        |                                                   |

**What your scope means.** The tools you are shown depend on your connection's scope. `read` shows read tools only.
`propose` shows every tool, but a write becomes a **proposal**: nothing is written, the owner sees exactly your change on the
dashboard and approves or rejects it. `write` writes directly, except for the always-proposal changes in rule 4 and
`restore_snapshot`. `bridge_info` tells you which you have. Every result names its project and ends with that project's
budget line.

**Sections to ask for.** `get_bridge_guide` takes `section`. Ask for one of these exact names (a near miss is matched
loosely, but only a clear match is returned, and each miss costs a call):

- `How to decide` (this section)
- `Find and read a page`
- `Edit a page's text`
- `Change facts and links`
- `Create a page or a character (Working first)`
- `Setting packs (Arkona)` (the Arkona pack's five tools), and under it `Arkona characters`, `Arkona owners`,
  `Arkona relationships, art and the brief`
- `Rename, move, delete and restore`
- `The page lifecycle` (promote, archive, unarchive, move to Working)
- `Dates and the chronology`
- `Maps`
- `Images`
- `Snapshots and restores`
- `Audit findings`
- `Budgets, jobs and proposals`
- `Canon and approval`
- `When the low-level tools are right`
- `Reference`, and under it `What the bridge is`, `Projects`, `The repository tree`, `The tools you are shown`,
  `When something goes wrong`
- `Operations` (every LegendKeeper operation id)

## Find and read a page

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
their paths: choose one and pass its id. The bridge never guesses. A character often has several pages with its name (its
`[INDEX]`, its Core, perhaps a Reference): **a character's facts and Scope live on its Character Core (or Character
Reference for a compact character), not on its `[INDEX]`.** When you read or write "the character", go to the Core by id.
An `AMBIGUOUS` answer for one character's pages lists each with its role and says so; `get_resource` on a character's
`[INDEX]` adds a `character` note naming the Core (or Reference) and its id.

**Reading.**

- `get_resource` shows the tree's data for a page (path, kind, documents, tags, Reference Type, Scope) and, from one live
  read, its whole sidebar: the facts in template order, the link collections with their items (an item can point at one
  document of a page), the other properties (named, read-only) and the `factsVersion`. Pass `resources` (up to 25
  names or ids) instead of `resource` to do several pages as one job.
- `read_document` returns a page's document as Markdown, with the document version and the list of keep regions.
  `outline: true` returns just the headings; `section: "Biography > Early Life"` just that section. Use them on long pages.
  Maps, timelines and boards come back as read-only Markdown.
- Long results are stored and returned as a **handle**: read them with `bridge_result_page`. Results are summaries unless
  you pass `detail: "full"` where a tool offers it.

## Edit a page's text

Pages are changed with `write_page`, in Markdown (read `get_markdown_guide` first). You send Markdown for one page
document; the bridge turns it into LegendKeeper blocks, keeps everything you did not change exactly as it was (ids,
styling, keep regions), and checks what it wrote.

Major revisions update Last Major Revision automatically (8 words or more of text, a heading, a real fact change, a
Dependency, a chronology row's date or description; not trims, punctuation or typo fixes); don't set it yourself. Pass
`lastMajorRevision: "set"` or `"skip"` only when the person asks; the answer says what was decided.

1. **Read first.** `read_document` gives the page's Markdown and its `version`. Change the Markdown you read.
2. **Pass `baseVersion`.** If the page changed since, a whole-page edit is refused, and a section edit goes ahead only if
   that section is still exactly as you read it.
3. **Prefer the section modes.** `append_to_section` and `replace_section` touch one section (`section: "Biography >
Early Life"`) and nothing else, so they survive edits made elsewhere on the page. Use `replace` (the whole page) only
   when you mean it: every keep region must be in it.
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
`WRONG_TOOL_FOR_DOCUMENT` (maps, timelines and boards have their own tools), `PAGE_NOT_WRITABLE` (your edit would
change, remove or re-send a block LegendKeeper's API cannot write back, such as the paragraph with an inline icon itself:
edit another section, or tell the owner; `get_resource` and `set_facts` still work on it).

**A page with an inline icon** is written block by block: only the blocks your edit changes are sent, one by one, and the
answer says so (`blockwise`). Everything else works as usual (baseVersion, sections, the verify). If such a write stops
part-way the bridge undoes what it wrote, provided the page is still exactly as it left it; the answer says what happened
(`undo`). Do not try to edit the icon paragraph itself.

## Change facts and links

A page's **facts** are the key-value rows of its sidebar property `PROPERTIES` (Reference Type, Scope, Status, …); its
**links** are its link collections (Dependencies, Related Sources). Change both with `set_facts`.

1. **Read first.** `get_resource` shows the page's facts and links as they are now, and their `factsVersion`. **Pass
   it back as `baseFactsVersion`** whenever a value is based on what you read, above all when you rewrite or replace an
   existing value: if anything in the sidebar changed since, nothing is written (`VERSION_CONFLICT`, listing what
   changed) and you redo the change on what is there now.
2. **One call for all the changes.** `facts` maps a key to its new value. A plain string is written exactly as text. For
   formatting or a mention of another page, send `{ "markdown": "…" }`: inline Markdown only (`**bold**`, `*italic*`,
   links, `<br>`, `[[Page Name]]`). `null` removes the row. Keys match without case, and an existing fact keeps its place.
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
  "links": { "Dependencies": { "add": ["Fourth Age - Table"] } },
  "baseFactsVersion": "fv2_…"
}
```

**The result** lists the facts added, changed and removed, the links added, removed and already there, and whether the
bridge **verified** the change by reading the sidebar back. An edit that changes nothing writes nothing (`no_change`).

**A conflict (`VERSION_CONFLICT`) wrote nothing:** the sidebar changed after you read it. Read the page again and redo
the change; never send the same call again. **"written but not as planned"** means the change was made but the sidebar
read back differs (usually someone edited it at the same moment): read the page and tell the person. `WRITTEN_IN_PART`
lists the changes that were made before something stopped the rest: read the page before doing anything else.

**Mentions of a character.** `[[Name]]` matching several pages of ONE character links its **Core**, else its
**Reference**, else its **index**, and the result's `mentions` says which page was chosen and why. If the matches belong
to different subjects, or one of them is not a character page, the mention stays ambiguous: name the page by id. This
never applies to the page you write to: a `page` that matches several pages is refused with each candidate and its role.

Other refusals name what to fix: `MENTION_AMBIGUOUS` (the candidates are listed: use a more exact name or the id),
`MENTION_NOT_FOUND`, `FACT_VALUE_NOT_INLINE` (one line of inline text only), `FACT_KEY_DUPLICATED` (the page has two
rows with that key: tell the owner), `LINK_COLLECTION_NOT_FOUND` (the page's collections are listed),
`DOCUMENT_NOT_FOUND`.

## Create a page or a character (Working first)

All the creation tools work inside the AI REPOSITORY only, put a new or moved page in its alphabetical place (indexes
first) in the same write, never move or reclassify anything else, verify what they did, and take `dryRun: true` to show the
plan (pages, names, parents, places, facts) without writing. Under scope `propose` each call is one proposal; the ids of its
new pages are fixed in the proposal.

**New pages are Working by default.** Every page create takes `status`: `"working"` (the default) makes a `[BWRK]`
page under `[INDEX] Working` (leave `parent` out) or, with `parent`, under an `[INDEX]` page inside a Working set (a
Working character's own index, below), with Status `Working` and the `Working` tag; `"authoritative"` makes a `[BSRC]`
page in its normal place (give `parent`), with Status `Authoritative` and the `CANON` tag, and is always a proposal for the
owner. Write new material as Working; the owner promotes it.

**A character, step by step** (the usual task):

1. `create_character` `{ kind: "core", name, race?, facts? }` (Working by default). It makes `[INDEX] {name}` under
   `[INDEX] Working` with `[BWRK] {name} - Character Core` beneath it. `kind: "compact"` makes one
   `[BWRK] {name} - Character Reference` directly under `[INDEX] Working`, with no index.
2. For each specialist page (Art, Relationship, …), call `create_resource` (Working) with its `template` and `parent` =
   that character's `[INDEX]` (its name, or the id the result gave). One page at a time is fine. Each page lands
   alphabetically among the index's children, so the character is one set from the start.
3. To make the whole set canon, `promote_page` with `subtree: true` on the index and a `destination` (normally the race
   index): one proposal, one approval. To retire it, `archive_page` with `subtree: true`.

A Working page's `parent` is `[INDEX] Working` itself (the default) or an `[INDEX]` inside a Working set; any other parent
is refused (`WORKING_PARENT`, naming the allowed ones), and nothing goes under a `[BWRK]` page. `create_bare_resource` and
the items of `create_many_resources` follow the same rule. Do not leave a character's specialist pages flat under
`[INDEX] Working`: a set promotion would not take them (its dry run lists them as `outsiders`; bring them in with
`move_resource`, then promote).

- **`create_character` details.** Authoritative: the Core's `[INDEX] {name}` (an existing one is reused) under the race, or
  `{name} - Character Reference` directly under the race. An existing Core or Reference, Working or not, is **returned,
  not duplicated** (`status: "existing"`). The bridge writes Reference Type, Subject, Canonical Display Name, Race / Species
  (exactly as you give it; `Unestablished` when the race is unknown or omitted) and Status, then your facts. The race is
  always checked: an unknown or omitted race means `Undetermined / Unknown`; a race given that does not resolve is refused,
  never guessed or created: ask the person. If another request for the same character is still under way (from you or
  another agent), you get `DUPLICATE_REQUEST` naming it: follow that one.
- **A page from a template:** `create_resource` `{ name, template, parent?, status?, facts?, links? }` (see
  `list_templates`).
- **An index:** `create_index` `{ name, parent }`, or `{ name, type, category }` (for example a category of a race). An
  index has no status, and none is made under `[INDEX] Working` or `[INDEX] Archived`.
- **Many pages at once:** `create_many_resources` `{ items }` (up to 100; nest them with `key` and `parent_key`; each
  item has its own `status`; Working items are flat, so nothing goes under one).
- **A page with no template** is rare, and `create_bare_resource` is not in the usual tool list (the owner shows it with
  "Show low-level and rarely used tools"; it still works when called). `{ name, parent?, status? }`, the name with its
  prefix: `[BWRK] …` (Working), `[BSRC] …` (Authoritative) or `[INDEX] …`. Every templated page, a character's
  specialist pages included, is `create_resource`.

**`operation_id`.** Every create tool takes an optional `operation_id` of your own. If a call times out or you are not
sure it went through, send the SAME request with the SAME `operation_id`: you get the first call's result
(`repeated: true`), and nothing is created twice. The same id with a different request is refused
(`OPERATION_ID_REUSED`): use a new id for a new request.

**A failed job is never replayed.** `WRITTEN_IN_PART` lists what was written, what was not, and the journal entries.
Read the pages, then make a new, smaller request for what is missing. `OUTCOME_UNKNOWN` lists under `uncertain` a write
whose answer was lost: it may have been made, so read the pages before anything else and never repeat it blindly.

## Setting packs (Arkona)

A **setting pack** is one world's own rules, held by the bridge as data: its page sets, names, templates, homes and tags,
taken from the world's governance pages and approved by the owner. A pack's tools carry its prefix and are in your list
only when the bridge serves a project the pack is attached to; on any other project they refuse (`PACK_NOT_ATTACHED`,
naming the projects they work on). The Arkona pack has five tools. Ask for the part you need:

| You want                                          | Use                          | Part to ask for                           |
| ------------------------------------------------- | ---------------------------- | ----------------------------------------- |
| Make an Arkona character, or add pages to one     | `arkona_create_character`    | `Arkona characters`                       |
| Make any other Arkona owner page                  | `arkona_create_owner`        | `Arkona owners`                           |
| Relate two existing Arkona characters             | `arkona_create_relationship` | `Arkona relationships, art and the brief` |
| Add art to an existing Arkona character           | `arkona_add_character_art`   | `Arkona relationships, art and the brief` |
| Recall who an Arkona character is (free, no read) | `arkona_character_brief`     | `Arkona relationships, art and the brief` |

**What every pack tool does the same way.**

- **Preview first, then one proposal.** `dryRun: true` (or `preview: true`) writes nothing and returns the whole plan:
  pages, places, templates, facts, tags, links, images, warnings and refusals. Fix what it refuses, tell the person about
  any warning that is a judgement call, then call again without `dryRun`. That call is **one proposal** for the owner,
  whatever your scope. Never resubmit it: follow it with `bridge_proposal_status`. Once approved it runs as one job,
  which checks again before its first write that nothing it relies on changed meanwhile, and verifies what it wrote.
- **Tags are computed, never typed.** A canon page leads with `CANON`, or with `AU` when it belongs to an alternate
  universe (Continuity Type AU: the owner's ruling of 16 November 2026); a Working page leads with `Working`. A tag you
  type is refused (`TAG_NOT_ALLOWED`); one the rules hold back is reported (`heldTags`).
- **Ask the owner, don't guess.** A required fact that is missing is refused, naming it. Never invent a value or borrow
  one from a similar page: ask, then call again. Only when the owner says a fact is deliberately left open, give
  `{ "value": "Unestablished", "reason": "…" }`; the reason is written into the page's Unresolved Material.
- **Images: stage them with no destination.** `upload_image` with `stage: true` and NO destination stages an image on the
  bridge's server and proposes nothing; give its `staged_id` to the pack tool, which places it. An image you already
  uploaded with a destination at scope `propose` is taken over: its own placement proposal is withdrawn ("superseded by
  package prop_…"). An image in another package's proposal is refused (`STAGED_IMAGE_BUSY`).
- **Last Major Revision.** Every page a pack tool makes is dated the day its job runs. An existing page it changes is dated
  only for a major revision by the owner's rule: 8 or more words of new or rewritten text, a heading, a real fact change,
  a Dependency. A move, a new name or Related Sources alone are not, so a relationship's links and a nation's moved
  Reference keep their date, while new images on an Art page and a filled-in fact set it. `lastMajorRevision: "set"` or
  `"skip"` overrides that for the existing pages (only when the person asks); the preview's `lastMajorRevision` says what
  applies to each page and why.
- **When the pack is not current.** The pack records the versions of Arkona's governance pages that the owner approved
  (and of the sections its rules come from). If one has changed since, or the pack's rules were edited, nothing is
  computed and every call is refused with `PACK_NOT_CURRENT`, naming what changed, until the owner checks the rules and
  approves again on the dashboard. Tell the person; there is nothing to retry.

### Arkona characters

**Use it instead of separate creates.** On a project with the Arkona pack, make every new character with
`arkona_create_character`, and add new pages to an existing character with it too (`target`, below). One package
describing the character becomes the right set of linked pages: only the pages you give, each from its template, named
and placed by Arkona's Character Architecture, its sidebar filled in template order, its tags **computed** from the facts
(never typed), every link resolved to an exact page, staged images placed in the character's asset folder, and the whole
set verified after the write. `create_character` followed by `create_resource` and `set_facts` calls does part of this,
page by page, and none of the checks. The tool never rewrites a page that exists: edit those with `write_page` and
`set_facts`.

**Preview first, then one proposal.** `dryRun: true` (or `preview: true`) writes nothing and returns the whole plan: the
page tree (names, parents, positions), each page's template, facts, tags, Dependencies and Related Sources, the asset
folders, every dash replaced, the tag slots held back, the warnings and the refusals. Fix what it refuses, tell the person
about any warning that is a judgement call, then call again without `dryRun`. That call is **one proposal** for the owner,
whatever your scope (`status: "authoritative"` makes it a canonical one). Never resubmit it: follow it with
`bridge_proposal_status`. Once approved it runs as one job, and the verify reads back the six identity fields one by
one, the tags in order, every template row, each page's place, each link and each image.

**The package.**

- `name`: the Canonical Display Name, without a prefix.
- `depth`: `"compact"` makes one Compact Character Reference (a minor character, directly under its race index);
  `"developed"` makes an `[INDEX] {name}` with a Character Core and one page per domain you give.
- `status`: `"working"` (the default) makes `[BWRK]` pages under `[INDEX] Working`, to promote later as one set
  (`promote_page` with `subtree: true`); `"authoritative"` makes canon in the character's place under its race.
- `identity`: the six gated fields `givenName`, `surname`, `race`, `namingCulture`, `lifeState` and `temporalScope`,
  and, if you have them, `subject`, `canonicalDisplayName`, `aliases` and `supersedes`.
- `pages`: only the domains with real content. Each has a `role`, a one-line `scope`, its `markdown`, and optional
  `dependencies` and `related` (names or ids of current pages). The roles: `core` (developed) or `compact` (compact), the
  identity page, exactly one for a new character; `specialist`, with a `title` such as `"Biography"` (the page is
  `{name} - {title}`), an optional `referenceType` (one is suggested) and at most one `specialistTag` (Biography,
  Personality, Relationship, Character Art, Visual Reference, Wardrobe, Magic or Equipment); `art`, with `images` (each a
  `staged_id` from `upload_image` with `stage: true` and no destination, a `label` `"{Visual Role} - {Descriptor}"`, its `interpretation`,
  what the image establishes, and an optional `subfolder` such as `"Outfits / Court Dress"`); and `relationship`, with
  `with` (the other character), an optional `label` and `host` (`"self"`, the default, or `"other"`). The relationship
  is added to both characters' Related Sources (a Working relationship
  is linked from a canon character only after promotion: the warning `PARTNER_LINK_DEFERRED` says to add it then).
- `index`: `{ "markdown": "…" }`, the index text. Left out, a minimal one is drafted and shown in the preview.
- `operation_id`: as for every create; `project`: the project's name.

Every page's text starts with `## Purpose`: no title and no metadata header (LegendKeeper shows the name, the sidebar
holds the facts), no empty or placeholder section. A Core, Reference or Relationship page should end with
`## Source Boundaries` and `## Unresolved Material` (a warning names a missing one). Page names come from the rules, so
never write a prefix. An em dash or en dash used as a separator anywhere in the package is replaced by an ASCII hyphen,
and each replacement is listed (`replacements`); "CANON" or a date in a page name is refused. Last Major Revision: see the
shared rules above.

A compact background character:

```json
{
  "name": "Asagiri Ren",
  "depth": "compact",
  "identity": {
    "givenName": "Ren",
    "surname": "Asagiri",
    "race": "Foxian",
    "namingCulture": "Fujimatsuan",
    "lifeState": "Alive at 5A 931",
    "temporalScope": "5A 900 - 5A 931"
  },
  "pages": [
    {
      "role": "compact",
      "scope": "Shrine guard of the Hollow Court",
      "markdown": "## Purpose\n\nThe compact reference for Asagiri Ren, a shrine guard.\n\n## Identity\n\nA Foxian guard of the Hollow Court shrine.\n\n## Source Boundaries\n\nIdentity and role only.\n\n## Unresolved Material\n\nNone yet.\n"
    }
  ],
  "dryRun": true,
  "project": "test"
}
```

A developed character, with a Biography, an Art page and a relationship with an existing character:

```json
{
  "name": "Kurosawa Aoi",
  "depth": "developed",
  "identity": {
    "givenName": "Aoi",
    "surname": "Kurosawa",
    "race": "Foxian",
    "namingCulture": "Fujimatsuan",
    "lifeState": "Alive at 5A 931",
    "temporalScope": "5A 902 - 5A 931",
    "aliases": "The Gate Archer"
  },
  "pages": [
    {
      "role": "core",
      "scope": "Identity and routing",
      "markdown": "## Purpose\n\nThe identity of Kurosawa Aoi and the way to her sources.\n\n## Identity\n\nA Foxian archer of the Hollow Court.\n\n## Source Boundaries\n\nIdentity only; her life is in her Biography.\n\n## Unresolved Material\n\nHer teacher is not decided.\n"
    },
    {
      "role": "specialist",
      "title": "Biography",
      "specialistTag": "Biography",
      "scope": "Her life to 5A 931",
      "markdown": "## Purpose\n\nThe life of Kurosawa Aoi.\n\n## Early Life\n\nRaised at the Hollow Court, she took the bow at twelve.\n"
    },
    {
      "role": "art",
      "scope": "Her approved visual references",
      "markdown": "## Purpose\n\nThe approved visual references for Kurosawa Aoi.\n",
      "images": [
        {
          "staged_id": "the id upload_image gave",
          "label": "Primary Reference - Character Portrait",
          "interpretation": "Establishes her face, her hair and her court robes."
        }
      ]
    },
    {
      "role": "relationship",
      "with": "Asagiri Miyabi",
      "scope": "Their bond at the shrine",
      "markdown": "## Purpose\n\nThe bond of Kurosawa Aoi and Asagiri Miyabi.\n\n## Bond\n\nMiyabi taught Aoi the shrine's rites.\n\n## Source Boundaries\n\nThe relationship only.\n\n## Unresolved Material\n\nNone yet.\n"
    }
  ],
  "dryRun": true,
  "project": "test"
}
```

**The gate: ask the owner, don't guess.** A new character needs all six gated fields, never blank and never a
placeholder ("TBD", "unknown", "?"). If one is missing the tool refuses with `IDENTITY_INCOMPLETE`, naming the fields.
**Do not invent a value or borrow one from a similar character: ask the owner**, then call again with the answer. Only
when the owner says a field is deliberately left open, give `{ "value": "Unestablished", "reason": "…" }` with the owner's
reason; the reason is written into the page's Unresolved Material. The race decides the place: a race with no race index
puts the character under `[INDEX] Undetermined / Unknown`, with a warning (`RACE_FALLBACK`). A race or naming culture
with no approved tag token leaves that tag out and reports it (`heldTags`). Never add a tag yourself: tags are computed,
and a typed one is refused (`TAG_NOT_ALLOWED`).

**An existing character: `target`.** A character is never made twice: a new package with an existing character's name is
refused (`CHARACTER_EXISTS`, naming it), and so is a job that finds the character was made by another request in the
meantime. To add pages, pass `target` (its name, an alias or its id) with only the new pages; `depth` is ignored and the
identity page is not given again. The new pages take the character's standing: Working beside a Working character,
canon beside a canon one, its continuity kept (an AU character's pages stay AU and carry `AU` in place of `CANON`). `status: "working"` instead drafts them
flat under `[INDEX] Working`, to promote into the character's place later. A Compact Reference that gains sibling pages
gets its own index in its place (the Reference moves under it and keeps its id); `upgradeToCore: true` renames the
Compact Reference to its Character Core (its text kept). New pages are announced in the index's "How to Use This Index"
section. The tool refuses a name that matches several characters (`TARGET_AMBIGUOUS`, with the candidates: pass the
id), an Archived character (`TARGET_ARCHIVED`: it is unarchived first, by the owner), a domain the character already has
(`DOMAIN_EXISTS`: edit that page with `write_page`) and splitting an existing page (`MONOLITH_SPLIT_UNSUPPORTED`).
Blank gated fields on the existing character are a warning (`IDENTITY_DEBT`): ask the owner, then give the values in
`identity` to fix them in the same proposal.

### Arkona owners

**Use it for every owner page that is not a character.** On a project with the Arkona pack, make a polity, institution,
military, culture, event, place, technology, magic, material, equipment, species (a race too), creature, religion, law,
programme, education, ceremony, condition or inter-polity relationship with `arkona_create_owner`: ONE page, its
template, name, home, sidebar (in template order), computed tags and links by Arkona's rules, verified after the write.
`create_resource` followed by `set_facts` does part of this and none of the checks. The tool never rewrites a page that
exists: edit those with `write_page` and `set_facts`.

**The package.**

- `type`: one of the types below. `kind` is for the race roster only (below).
- `name`: the Subject, without a prefix; the page is `{name} - {descriptor}`, the `descriptor` defaulting to the
  Reference Type. A sibling of the same name is refused (`OWNER_EXISTS`).
- `home`: **required**, the index the page goes in, by name, id or path (`"Salahad / Salahad Polities"`). See below.
- `status`: `"working"` (the default) drafts `[BWRK] …` under `[INDEX] Working`, to promote into its home later;
  `"authoritative"` makes canon in its home (a canonical proposal).
- `referenceType`, `scope` and `temporalScope`: **required** (`OWNER_FACTS_INCOMPLETE` names a missing one: ask the
  owner). Subject is the name; Status, Continuity Type, Continuity and Inheritance follow from `status` and `continuity`
  (`"Main"`, the default, or an alternate universe's name, which makes the page AU); `supersedes` is "None" unless given;
  Last Major Revision is set when the job runs.
- `specialistTag`: at most one of the type's specialist tags (a Working page carries `Working`, its primary tag, then
  the specialist: `Working, Culture, Language`).
- `markdown`: `## Purpose` first, then its sections, then `## Source Boundaries` and `## Unresolved Material`. The
  template's own placeholder headings you do not fill are left out.
- `dependencies`: current Authoritative owners only (`DEPENDENCY_NOT_AUTHORITATIVE` for a Working or Archived page or an
  index). `related`: any current pages.
- `nation`, `promoteNation`, `createSubindex`, `createCharacterNavigation`, `homeOverride`: below. `operation_id` and
  `project` as for every create.

**The types and their homes.** `<Continent>` is a continent's name (`Salahad Polities`), `<Nation>` a nation's
(`Menkhet Institutions`); a nation index is a nation's own `[INDEX]` in its continent's Polities index.

| `type`                                         | Template                  | Homes                                                                                                                                          | Specialist tags                             |
| ---------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Polity                                         | AI Polity and Institution | `<Continent> Polities`; a nation index                                                                                                         | Government                                  |
| Institution                                    | AI Polity and Institution | `<Continent> Institutions`; a nation index; `<Nation> Institutions`; `<Nation> Government & Administration`                                    | Government, Religion                        |
| Military                                       | AI Polity and Institution | a nation index; `<Nation> Institutions`                                                                                                        |                                             |
| Culture                                        | AI General Source         | `<Continent> Cultures`; `<Nation> Cultures`; `Arkonan Cultures`; `Divine Realm Cultures`                                                       | Language, Naming                            |
| Event                                          | AI General Source         | `<Continent> Historical Events` or `Conflicts`; `Arkonan Historical Events` or `Conflicts`; `<Nation> Historical Events` or `<Nation> History` | Conflict                                    |
| Place                                          | AI Place and Divine Realm | `<Continent> Regions`; `<Continent> Settlements & Locations`; `<Nation> Settlements & Locations`; a Divine Realm index                         | Continent, Region, Settlement, Divine Realm |
| Technology, Magic, Material, Equipment         | AI Magic and Technology   | `<Continent> Unique Magic & Technologies`; `<Nation> Unique Magic & Technologies`; a nation index                                              | Equipment: Sacred Blade                     |
| Species                                        | AI Creature and Species   | the Bestiary; with `kind`, the race roster (below)                                                                                             | a racial group: Racial Group                |
| Creature                                       | AI Creature and Species   | the Bestiary                                                                                                                                   |                                             |
| Religion                                       | AI General Source         | `<Continent> Religions`; `<Nation> Religions`; `Arkonan Religions`; a nation index                                                             |                                             |
| Law, Programme, Education, Ceremony, Condition | AI General Source         | the matching continental or national index (`Laws`, `Programmes`, `Education`, `Ceremonies`, `Conditions`); a nation index                     |                                             |
| Relationship (between polities)                | AI General Source         | `<Continent> Institutions`                                                                                                                     |                                             |

**Homes.** The tool checks `home` against the type's homes. A home that does not fit is refused (`HOME_NOT_ALLOWED`),
listing the allowed homes and up to five suitable indexes nearby: choose one. Only when the owner has decided on another
home, give `homeOverride: { "reason": "…" }` with the owner's reason: the page goes there with a warning, and the reason
is printed in the proposal. A home in the Working or Archived area is always refused (`HOME_IN_LIFECYCLE_AREA`). The tool
never makes a category index (`<Continent> Laws`, say): if the right one is missing, tell the person.

**Nations.** `nation` names the nation an owner belongs to. A nation that is still only a compact Reference in its
Polities index (`[BSRC] Kingdom of Saba - Historical Polity Reference`, say) has no index to hold its owners, and the tool
refuses (`NATION_NEEDS_INDEX`), describing the change. With `promoteNation: true` (and the nation as `home`) the same
proposal makes `[INDEX] <Nation>` in that Polities index, moves the Reference into it (its id, links and tags kept) and
places the new owner beside it. Moving canon makes the proposal canonical. `createSubindex: "<Nation> <Category>"` makes
one national subindex for the owner (`"Kingdom of Saba Institutions"`, its name also as `home`), only for a category the
type lives in; subindexes are never made otherwise.

**The race roster.** A race, racial group or subrace is a `Species` with `kind`:

- `racialGroup`: home Races of Arkona; the page is `<Group> - Racial Group Reference`.
- `race`: home its group's `<Group> - Racial Group Reference` (or Races of Arkona for a race of no group); the page is
  `<Race> - Core Information`.
- `subrace`: home its race's `<Race> - Core Information`; the page is `<Subrace> - Subrace Reference`; give its
  `referenceType`.

Any other species, and every creature, goes in the Bestiary. A new race or racial group has no character navigation yet
(`Characters / <Group> / <Race>`), so `arkona_create_character` cannot place its characters: the tool warns
(`CHARACTER_NAVIGATION_MISSING`), and `createCharacterNavigation: true` adds its index in the same proposal. When the
bridge has to guess the race's singular (`TAXONOMY_SINGULAR_GUESS`), the owner checks it on Repository Mappings before a
character of that race can be placed.

A compact polity in its continent's Polities index:

```json
{
  "type": "Polity",
  "name": "Kingdom of Saba",
  "descriptor": "Historical Polity Reference",
  "home": "Salahad Polities",
  "referenceType": "Historical Polity Reference",
  "scope": "A highland kingdom of southern Salahad",
  "temporalScope": "3A 410 - 4A 12",
  "markdown": "## Purpose\n\nThe reference for the Kingdom of Saba, a compact polity of southern Salahad.\n\n## Government\n\nA hereditary queenship advised by a council of terrace-holders.\n\n## Source Boundaries\n\nThe polity only; its institutions have their own pages.\n\n## Unresolved Material\n\nThe date of its founding is not settled.\n",
  "dryRun": true,
  "project": "test"
}
```

An institution of a nation that is still a compact Reference, giving the nation its index in the same proposal:

```json
{
  "type": "Institution",
  "name": "Diwan of Tarim",
  "descriptor": "Institution Reference",
  "nation": "Sultanate of Tarim",
  "promoteNation": true,
  "home": "Sultanate of Tarim",
  "status": "authoritative",
  "referenceType": "Institution Reference",
  "scope": "The council of the sultan's ministers",
  "temporalScope": "4A 100 - 4A 400",
  "markdown": "## Purpose\n\nThe reference for the Diwan, the council of the Sultanate of Tarim.\n\n## Membership\n\nThe sultan's ministers, sitting each new moon.\n\n## Source Boundaries\n\nThe council only.\n\n## Unresolved Material\n\nNone yet.\n",
  "dryRun": true,
  "project": "test"
}
```

### Arkona relationships, art and the brief

**A relationship of two existing characters: `arkona_create_relationship`.** `{ "a": "…", "b": "…", "scope": "…",
"markdown": "…" }` makes `<a> & <b> - <label>` (`label` defaults to "Relationship") from AI Relationship under `a`'s
index (`host: "b"` for b's), with both names as their indexes give them, Working or canon as its host is (or `status`), and adds it to both characters' Related
Sources in the same proposal (a Working relationship is linked from a canon character only after promotion:
`PARTNER_LINK_DEFERRED` says so). Both characters must exist (`CHARACTER_NOT_FOUND`: make the character first with
`arkona_create_character`); a pair that already has a relationship page, under any label and in either order, is refused
(`RELATIONSHIP_EXISTS`, naming it: edit that page with `write_page`). For a relationship of a character you are making
now, give a `relationship` page in its `arkona_create_character` package instead.

**Art for an existing character: `arkona_add_character_art`.** `{ "character": "…", "images": [{ "staged_id": "…",
"label": "Outfit Reference - Ceremonial Robes", "interpretation": "…", "subfolder": "Outfits / Ceremonial Robes" }] }`.
Each image goes in the character's asset folder (`Characters / <race path> / <name>`, with `Forms / <form>`,
`Outfits / <outfit>` or `Details` subfolders, found or made when the job runs) as `<name> - <label>` (no file extension;
numbered when the name is taken), and on the character's Art page with its label and interpretation: the Art page is
made when it is missing, or extended under its "Reference Images" section, nothing else on it changed. Every image needs
its `interpretation`, what it establishes (`BARE_IMAGE` otherwise). Sources: `staged_id` (staged with no destination),
`upload_id` (from `prepare_image_upload`), or in ChatGPT the attached `file` for one image; an upload or file is staged
first, even on a dry run, and its `staged_id` is in the answer.

**Recall who a character is: `arkona_character_brief`.** `{ "character": "…" }` answers from the bridge's own records,
free: the six identity fields, every page of their set with its Reference Type and Scope, their relationships, their Art
pages with image counts, open audit findings and Unresolved Material, each with how fresh it is. `live: true` re-reads the
identity fields (one read). Use it before you write about a character, and tell the person who is under discussion.

## Rename, move, delete and restore

- **Rename, tags, aliases, icon, banner, hidden, locked:** `update_resource` (a rename keeps the prefix and re-places
  the page; give the name without a prefix).
- **Move:** `move_resource` `{ page, to }`. Within a lifecycle area it is an ordinary move ([below](#the-page-lifecycle)).
- **Delete:** `delete_resource` `{ page, confirm: true }` (and `cascade: true` for a page with pages under it; the result
  lists every page removed). To retire a page, use `archive_page`, not a delete. Deleting an Authoritative page is protected
  canon. **Undo a delete:** `restore_resource` `{ page: "<id>" }` (the id is in the delete's result and in the journal).
- **Maps, timelines, boards (the documents themselves):** `create_document`, `update_document` (settings only) and
  `delete_document`.

## The page lifecycle

A page is in one of three states, and its prefix, Status, status tag and place always agree:

| State         | Prefix   | Status          | Tag        | Where                                   |
| ------------- | -------- | --------------- | ---------- | --------------------------------------- |
| Authoritative | `[BSRC]` | `Authoritative` | `CANON`    | its normal place                        |
| Working       | `[BWRK]` | `Working`       | `Working`  | directly under `[INDEX] Working`, flat  |
| Archived      | `[BARC]` | `Archived`      | `Archived` | directly under `[INDEX] Archived`, flat |

(The exception to "flat": a whole set kept together, below. A Working page may also sit under an `[INDEX]` inside a
Working set, and an archived page under an `[INDEX]` inside an archived set.)

The owner may list indexes whose pages are Authoritative **without** `CANON` (for example `[INDEX] Design References`):
a page beneath one is `[BSRC]` and `Authoritative` with no `CANON` tag, and the tools below, and creates with
`status: "authoritative"`, add none there. Do not add `CANON` to such a page yourself.

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
  `move_to_working`, if anywhere. A Working character's index goes with its Core; if any other page is under that index
  (an Art or Relationship page, say), promoting the Core alone is refused (`SET_HAS_OTHER_PAGES`): promote the whole set
  with `subtree: true` on the index, or move the other pages out first.

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

**Moves within a lifecycle area are ordinary moves** (`move_resource`; no lifecycle change, no canonical approval; the
page's prefix, Status and tags never change). In the Working area: a `[BWRK]` page (or a Working set's `[INDEX]` with its
pages) between `[INDEX] Working` and an `[INDEX]` inside a Working set, and back. In the Archived area: a `[BARC]` page,
or an archived set's `[INDEX]` together with its pages, between `[INDEX] Archived` and an `[INDEX]` inside an archived
set, and back. The lifecycle record keeps each page's ORIGINAL previous place, so `unarchive_page` still returns it to
where it came from, not to where it was moved within the archive. A move into or out of either area, and between the
two, is still refused (`POLICY_DENIED`, naming the lifecycle tool).

**Promoting, archiving and moving a set to Working: outsiders.** The dry run (and the proposal) of `promote_page`,
`archive_page` and `move_to_working` with `subtree: true` lists under `outsiders` any Working page of the same subject
(`subjectOf`: its Subject row, else the name before " - ") that sits flat under `[INDEX] Working` outside the set, so the owner
does not approve a partial change by accident: a promotion or an archive would leave it behind, still Working. Bring it in
first with `move_resource` (to the set's index) when the set is Working; a Working page cannot be moved into an Authoritative
set, so for one of those archive each such page with `archive_page` as well. After `move_to_working`, bring them in with
`move_resource` once the set is Working. `unarchive_page` lists none.

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
another lifecycle tool on that page, or on any page of the set, is refused (`LIFECYCLE_INCOMPLETE`). Before the owner has
confirmed the project's two indexes, the tools and Working creates are refused (`LIFECYCLE_NOT_CONFIGURED`): tell the person.

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
why the date is refused. It costs nothing, and it also turns minutes or a KCY into dates. **Two styles:** LegendKeeper
writes a year with no thousands separator on events (`AA 1988119`), the tables with one (`AA 1,988,119`);
`calendar_date` gives both (`formatted` and `tableFormatted`) and reads either, and the tools always write the table's
style into a table cell.

**Qualified dates.** Some rows give their date with its declared precision: `c. 4A 563; exact date unresolved`,
`After Isar 6th and before Zarzakh 29th, 4A 610; …`, `By 4A 623; …`, `Approximately House Year 8 (c. 4A 578); …`. They
are the owner's on purpose: **never rewrite one into a plain date**. The bridge reads such a cell by its **anchor** (the
calendar date it is pinned to) for pairing and for the row's timeline event, and keeps the rest as the qualifier; a
cell it cannot read with certainty (a relative offset such as `about nine months after Isar 1st, 4A 623`) stays
unreadable, and the check says why. Name such a row by its `row_id`, or by its Date cell exactly as the table shows it.
The full list of forms is in docs/chronology.md.

**The tools.**

- `create_timeline_event { date, name, description }`: `name` is short (the timeline), `description` is the full text
  (the table). The age comes from the date. The row goes in calendar order (after rows of the same date; a year-only
  row after the dated rows of its year), the event links to the age's table, and the count goes up by one. An
  identical row is refused (`DUPLICATE_EVENT`).
- `update_timeline_event { event, date?, name?, description? }`: `event` names it by its `date` with its `description`
  or `name`, or by `row_id` / `event_id`. A date in another age moves it there (both counts change).
- `delete_timeline_event { event, confirm: true }`.
- `delete_timeline_event { event: { event_id, age? }, orphan: true, confirm: true }` deletes ONLY a timeline event that
  no table row accounts for (the check's "event without a row"): no row is deleted and the count does not change. It
  is refused when the event has a row after all (`EVENT_HAS_ROW`) or an unpaired row could be its own
  (`PAIRING_AMBIGUOUS`: it is not an orphan; pair it with `sync_timeline_event` and `event_id` instead). The check
  reports such an event as an "event in a tie", never as an event without a row. `dryRun` shows the event and the
  three rows nearest it by date. The journal keeps the event.
- `sync_timeline_event { row: { date, description } | { row_id, age } }` repairs the timeline for ONE table row, the
  table being the authority: it creates the row's missing event, or corrects the paired event's minutes, `detail`, shape
  and `uri` to match the row. It never touches the table or the count and never renames an event; a row whose event
  already agrees answers `nothing_to_do`. `description` may be the row's opening words (at least 20 characters, the
  start of exactly one row of that date); no such row is `ROW_NOT_FOUND`. If several events could be the row's it
  refuses (`PAIRING_AMBIGUOUS`) naming each candidate's name, date and id: tell the person, then pass `event_id` to pair
  it with one (an event that already agrees is linked: `linked`, no LegendKeeper write, and the choice is remembered),
  or `create_new: true` to make a new event instead. Use it for what the chronology check
  reports (a row without an event, a row and event that disagree about the date). A repair that turns a range event
  into a single date, or the reverse, is refused (`SHAPE_CHANGE_UNCONFIRMED`, saying `range → single day`) until you
  have checked with the person and repeat it with `confirm_shape_change: true`. A qualified row's event takes its
  anchor (a year, a month, a range, or one point at the known bound of `After …` / `Before …`) and its name is the
  row's opening words, then `–` and the Date cell as written. A row the owner marked **table-only** is never given
  an event (`ROW_TABLE_ONLY`).
- `create_timeline_lane` adds a lane to an ordinary timeline; the chronology's age timelines have exactly one lane and
  refuse more.

If a table row and its event no longer agree, the other tools refuse (`CHRONOLOGY_DRIFT`): repair it with
`sync_timeline_event` (the weekly chronology check reports it, and the owner's dashboard offers "Propose a fix"). If a
change stops part-way, send **the same request again**: it does only what is left; other changes of that age wait for it
(`CHRONOLOGY_INCOMPLETE`). Before the owner has confirmed the chronology, the tools refuse
(`CHRONOLOGY_NOT_CONFIGURED`): tell the person. These are ordinary edits, not canon, even on an Authoritative page.

## Maps

A map is a document of a page. Read it with `read_document` (the page, and the document by name or id); change it with
`create_map_feature`, `update_map_feature` and `delete_map_feature`; give it an image with `update_document` (`mapImage`).

**Reading a map.** The header gives the image's `width`, `height` and `bounds` (`[[south, west], [north, east]]`), and every
feature its type, name, position and link, with a folder's features nested under it. When the map has an image each
position is given twice: as `(lat, lng)`, which is what LegendKeeper stores, and as `pixel (x, y)`, counted from the image's
**top-left corner** (x to the right, y downwards). A region's or path's points are listed in pixels when there are six or
fewer, and summarised as a pixel box when there are more (`detail: "full"` lists every point).

**Pixels or lat/lng.** Give a feature's coordinates in ONE system per request: `pixel` (`{ x, y }`) or `latlng`
(`[lat, lng]`); never both. A pin or label takes one position; a region takes `points` (a polygon of 3 or more) or
`polygons` (several); a path takes `points` (2 or more); each point is `[lat, lng]` or `{ x, y }`, all one kind. **Use pixels
when you are working from the image** (the numbers you read off `read_document` are the numbers you write back): the bridge
converts them with the map's live image, so a pin you place at pixel (1024, 512) is at pixel (1024, 512) in LegendKeeper.
Anything outside the image is refused unless `allowOutside: true`. A **legacy tiled map** has no single image and a map with
no image has none yet: pixels are refused on both (use `latlng`; set an image with `update_document` for pixels).

**Adding and changing features.** `create_map_feature` takes `type` (`pin`, `label`, `region`, `path` or `folder`), `name`
and the coordinates; `folder` names the parent folder; `after` or `before` names a sibling to put it beside; `style` takes
LegendKeeper's style fields (`iconShape`, `iconColor`, `color`, `fillStyle`…). A feature goes at the **end** of its parent
unless you place it: the bridge never sorts a map alphabetically, because the owner orders it by hand. `update_map_feature`
finds a feature by its id, or by its name (with `featureFolder`, the folder it is in now, when the name occurs more than
once: an ambiguous name is refused with each candidate); only what you give changes, and a change that changes nothing is
`no_change`.

**Label sizes cannot be set.** `style.labelSize` is refused, whatever its value (`LABEL_SIZE_UNSUPPORTED`). LegendKeeper's
API contradicts itself: its writes take only `xs` to `3xl`, but `listFeatures` then refuses to return a map holding one, so
the whole map would become unreadable through the API. Tell the person to set label sizes in the LegendKeeper app. A map that
already holds such a size is refused by every map tool and `read_document` with `MAP_FEATURES_UNREADABLE`: the person sets
that feature's label size again in the app (any of small, medium or large) and the map can be read again.

**Links.** `link` is a page by name or id (or `{ page, document }` for one document of it). A name that matches several pages
is refused with every candidate and its role; nothing is guessed. The page must exist and not be deleted. A page the owner
made in the app a few seconds ago may not be linkable yet: wait and try again. `link: null` on `update_map_feature` clears the
link; leaving `link` out leaves it alone.

**Folders.** Name the folder with `folder`; a name that matches more than one folder is refused with their paths (pass the id).
`update_map_feature` with `folder` moves a feature, or a whole folder with its features, into another folder, and
`folder: null` moves it out to the top level. LegendKeeper does **not** delete a folder's features when it deletes the folder,
so `delete_map_feature` refuses a folder that holds features unless you pass `cascade: true`; the answer then lists everything
removed, and the journal (`bridge_journal_lookup`) keeps every removed feature in full, so each can be added again. If a
cascade stops part-way, ask again: it deletes only what is left.

**Images.** `update_document` with `mapImage` (an image asset of the library, by name or id: see `list_assets`) sets or
replaces a map's image, and a blank document given one becomes a map. Features keep their positions when the image changes, so
a replacement with an image of a different size puts them over different pixels. When the map has features, the call is
refused unless you pass `confirm: true` (`CONFIRMATION_REQUIRED`: nothing is written, and the answer says how many features
will sit over different pixels, with the old and new sizes): **tell the person that count and ask before you confirm**. With
`confirm: true` it goes ahead and the warning stays in the result; under `propose` scope the proposal shows the count and the
owner's approval is the confirmation. The same size, or a map with no features, needs none. **Nothing is moved
automatically**; move features with `update_map_feature` if asked.

These are ordinary edits, not canon, even on an Authoritative page (only deleting the whole map document of an Authoritative
page is canonical).

## Images

`upload_image` stores an image as a LegendKeeper image asset: converted to WebP at quality 90 (dimensions, orientation,
transparency and every animation frame kept; a WebP is stored as it is; metadata dropped), checked after storing
(`storedBytesVerified`), and filed in the right folder. Give exactly **one source**:

1. **`data_base64`**: fine for small images. A chat cannot pass a large one: a 2 MB image is about 2.7 million
   characters. For an image the person has in hand, ask them to upload it on the dashboard's **Staging** page and give
   you its staged id.
2. **`url`**: a public https image.
3. **`file`**: in ChatGPT, pass a conversation attachment as `file` (ChatGPT fills it in); the bridge downloads it during
   the call. `name` defaults to the file's name (its extension dropped). If the answer is `FILE_URL_EXPIRED`, call
   `upload_image` again with the same attachment so ChatGPT issues a fresh link; if that fails, ask the user to attach the
   image again. One file per call.
4. **`upload_id`**: if you have a shell or sandbox. Call `prepare_image_upload` with the file's `sha256`, `byte_length`,
   `content_type` and `name`; run the Python or curl script it returns with the file's path (it checks the hash and sends
   the file; it answers "received"); then call `upload_image` with the `upload_id` within 15 minutes. The capability in
   the script works once, for 5 minutes, for that file only: never put it in a URL or a page. Not for ChatGPT or any
   assistant whose code environment cannot reach the bridge: ChatGPT uses `file`.
5. **`staged_id`**: place an image that is already staged.

`destination` says where it goes; the bridge plans it from the asset tree and refuses rather than guesses:
`for_character { name, race }` (a folder named after the character is reused wherever it is; otherwise
`Characters / Group / Race / Name`, created as needed; an unknown race goes to `Undetermined / Unknown`; a race that does
not resolve fails), `for_page` (a character's page, including a Working or Archived one and a specialist page such as
`{name} - Art`, gives its character's folder, the race read from the character's Race / Species fact; if that cannot be
found the refusal says exactly what to pass: `for_character` with the name and race, or `folder`; any other page needs a
`folder` too),
`folder` (an id or a path such as `Characters / Beastkin / Qishen / Mehrana al-Khalid`), plus `subfolders`: a list, or one
path written like the folder chain (`"Wardrobe / Qipao"`: Qipao inside Wardrobe; an empty part, `.` and `..` are refused).
Existing folders are reused and missing ones created. Check with `dryRun: true` first if unsure: it lists the folders that
would be created.

**Staging.** `stage: true` keeps the image on the bridge's own server (nothing goes to LegendKeeper until it is placed);
place it later with `staged_id` (and a `destination`, or the one you gave when staging): it is then uploaded straight into
its folder, with its final name, and verified. With a `propose` connection every upload is staged and the placement is a
proposal for the owner: do not retry it. The same image sent again returns the existing asset
(`deduplicated: true`); never upload a copy to "move" an image.

**Using it.** Put an image on a page with `write_page`: `![alt text](asset url)` (only this project's assets). It can
also go in an image block (an `lk-block`), as a map pin's image, or as a map's image (`update_document`'s settings).
`list_assets` and `browse_asset_tree` show what the bridge knows of images it uploaded (`bridgeUpload`). Deleting an
asset keeps its bytes in the bridge first; if they cannot be kept the delete is refused until the owner allows it.

## Snapshots and restores

The bridge keeps its own snapshots of every page: nightly in full, and after every bridge write (yours included), so a
page's earlier states are there to compare and bring back.

- **`list_snapshots`** (free): a page's snapshots, newest first, and which pieces changed in each (its settings, its
  sidebar, each document). A deleted page is found by its id.
- **`snapshot_diff`**: what changed in a document, the sidebar or the settings between a snapshot and now (a few reads), or
  between two snapshots (free).
- **`restore_snapshot`**: brings back a page's documents, its sidebar, one document, a deleted page, or a deleted image.
  **It is always a proposal, whatever your scope:** nothing is written until the owner approves it; never retry it, follow
  it with `bridge_proposal_status`. Check with `dryRun: true` first: the plan shows the diff and everything it cannot
  restore. Say so to the person: blocks the API cannot show (`unsupported`) and inline icons that are no longer on the
  page are **lost**, a page that holds inline icons now is restored block by block around them (they stay as they are), a restored image is a **new asset with a new URL** (ask whether the pages that showed the old one
  should be updated: `updateReferences`), and a restore never changes a page's lifecycle state (use the lifecycle tools
  first).

Use a restore to undo a mistake, not to edit: to change a page, write it.

## Audit findings

The bridge audits each project after every nightly full snapshot (pages against their templates, links that point
nowhere, unclassified pages, ordering, the taxonomy, facts, the page lifecycle, paragraphs with line breaks, inline
icons, the chronology) and keeps the findings. **`audit_findings`** (free: no request to LegendKeeper) reads them:
filter by `category`, `code`, `severity`, `page` (an id, or part of a name or path), `new` (first seen in the latest
audit), and page with `limit` and `offset`; `detail: "full"` adds each finding's evidence.

- **A finding is a report, not an instruction, and it may be out of date.** It says which snapshot it came from and how
  old that is; edits made since are not in it. Read the page (`get_resource`, `read_document`) before you change anything.
- **Fix through the ordinary tools** (`set_facts`, `move_resource`, `write_page`, `update_resource`…); they go to
  proposals as usual. You cannot run, edit or acknowledge an audit: the owner does, on the dashboard, which also offers
  "Propose a fix" for some findings.
- **Leave lifecycle and canon findings to the owner** (`lifecycle_*`, a Status or tag that disagrees with a prefix or a
  place). The lifecycle tools refuse an inconsistent page; the owner decides which signal is right. Never edit a page's
  prefix, Status or status tag to make a finding go away.
- **Deleted or missing link targets** (`deleted_target`, `missing_target`, `inaccessible_target`) are decisions about a
  page: ask. An Authoritative page that links to an Archived one (`canon_refers_to_archived`) is a warning for the owner.
- A paragraph with a line break inside a text run (`line_break_paragraph`) shows as a keep region in `read_document`, so
  `write_page` cannot change it as text: tell the owner (the dashboard splits it, block by block). A page with inline
  icons (`inline_icon_page`) is refused by `write_page`: do not try to rewrite it.
- Acknowledged findings are hidden by default (the owner decided they are fine as they are); do not "fix" them.

## Budgets, jobs and proposals

- Each project has its own request budget, shared by everyone using it. Every result ends with that budget line.
- Reads from the tree cost nothing. A live read costs one request. A tool says what it costs.
- Before a workload of hundreds of calls, ask `bridge_estimate`; do not read pages to find out. Run multi-step low-level
  work as one `lk_api_batch` job rather than a loop of single calls. Several pages at once: `get_resource` with `resources`.
- **Never loop on a budget error.** `BUDGET_EXHAUSTED` names the time to retry (`retryAt`): wait until then, or tell the
  person. A write that returns `waiting_budget` has not failed: it resumes by itself. Some operations have limits of
  their own (image uploads and asset folders: about 20 a minute); `bridge_budget` lists them, a refusal names the group
  (`group:assets`), and the budget line ends `| blocked assets 12s` while it lasts. Other writes are not affected.
- `queued` and `waiting_budget` mean the write is accepted and will run. Follow a job with `bridge_job_status`; pass
  `wait_seconds` (1 to 25) to wait for it instead of polling. Never submit it again.
- A write that returns `proposal_captured` was not made. Tell the person it is waiting for approval; follow it with
  `bridge_proposal_status` (leave `proposalId` out to list yours). If the page changes before the owner approves, the
  proposal becomes **conflicted** instead of being applied: read the page again and propose afresh. Never submit a
  proposal twice.
- You cannot approve your own proposals, change your scope, or see other connections' jobs.

## Canon and approval

Some changes are **protected canon**. By default:

- setting a page's `Status` to `Authoritative`, or changing it from `Authoritative` to anything else;
- changing an existing `Continuity Type` or `Continuity` (for example `CANON` to `AU`, or one AU to another). Setting
  them where they are empty, as on a new page, is fine;
- **deleting** a page whose `Status` is `Authoritative` (with `cascade`, any page under it that is). Restoring a deleted
  page needs no approval;
- **deleting** an Archived `[BARC]` page, and deleting a map, timeline or board of an Authoritative page (two rules the
  owner can switch off per project);
- **every lifecycle change**: creating an Authoritative page, and `archive_page`, `unarchive_page`, `move_to_working`
  and `promote_page`.

**No connection can make these changes on its own, whatever its scope.** A write that would make one (through
`set_facts`, `lk_api_write`, `lk_api_batch` or any other tool) becomes a **proposal**: the result is
`proposal_captured` with `requiresCanonicalApproval: true` and the `reason`, and nothing is written. Only the owner can
accept it, with a separate "Approve and accept as canon". Never retry such a write or look for another way to make it:
tell the person it is waiting for the owner, and follow it with `bridge_proposal_status`.

**An approval covers only what it listed.** The owner approves exactly the pages a proposal shows. If, by the time it
runs, a page it would touch was added (for example a new page under a page being deleted with `cascade`, or under a set
being archived), removed or moved, it does not run: the proposal becomes `conflicted` and nothing is written. Read the
pages again and propose afresh.

## When the low-level tools are right

`lk_api_read`, `lk_api_write`, `lk_api_batch` (and, where shown, `lk_api_describe_operation`, `lk_api_list_operations`,
`lk_api_paginate_all`) run any of LegendKeeper's 89 operations by id. Use them only when **no high-level tool does the
job**: for example listing the project's members (`listMembers`), reading a page that is outside the AI REPOSITORY, or a
raw block edit the owner has asked for. They keep the engine's guards (versions, `unsupported` blocks, canon, policy,
budget) but not the repository's own rules (ordering, templates, lifecycle placement), which is why a page, fact, create,
move, delete, document, event or map job belongs to its own tool.

- Take the operation id **exactly as listed** under Operations at the end of this guide. An unknown id is refused with up to
  five close suggestions. `lk_api_describe_operation` gives an operation's schema when you can see it; either way `getBlock`
  and `getDocumentBlocks` show the current shape of real data.
- Read first and pass the version you read as `params.ifMatch` on a versioned write. A write that would lose `unsupported`
  blocks, or delete with `cascade`, needs the explicit flag the refusal names: ask the person before you pass it.
- The high-level tools work only inside the AI REPOSITORY; the low-level tools can reach a page outside it, with the same
  guards and budget.

## Reference

### What the bridge is

LK-Bridge sits between you and LegendKeeper. It keeps a model of each world's **AI REPOSITORY** (the page tree your
tools work in), checks every write against the page's current version, protects content Markdown cannot show, records
every change in a journal, and shares each project's request budget fairly between everyone using it. You never hold a
LegendKeeper key.

### Projects

One bridge serves several LegendKeeper projects (for example `arkona`, the live world, and `test`).

- `list_projects` names them and says which is the default.
- Every tool takes an optional `project`. Reads without it use the default project. **A write must name its project**
  when the bridge serves more than one, so a forgotten argument can never land in the wrong world.
- Every result names the project it used and ends with that project's budget line.
- Each project has its own repository, its own assets and its own budget. Nothing carries over between projects.

### The repository tree

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
  saying so. The low-level tools can still reach it, with the same guards and budget.

### The tools you are shown

The tools you are shown depend on your profile. The owner can show or hide the low-level and rarely used tools
(`lk_api_list_operations`, `lk_api_describe_operation`, `lk_api_paginate_all`, `lk_op_*`, `lk_upload_image` and
`create_bare_resource`), and a profile's scope decides
whether the write tools are shown. Hiding is cosmetic: you can still run any operation through `lk_api_read`,
`lk_api_write` and `lk_api_batch`, and policy decides what is allowed. If you do not have the low-level tools, the
**Operations** section at the end of this guide lists every operation id, with its kind and risk.

**Tool-list caching (for the person using the connector).** claude.ai keeps its own copy of a connector's tool list. On
10 November 2026 a change to tool visibility (the "Show low-level and rarely used tools" checkbox, or a scope change that hides or shows
the write tools) appeared in claude.ai only after the connector was disconnected and reconnected in claude.ai's
settings; new chats alone were not enough. (Observed, not a guarantee.) In ChatGPT, use Plugins, then the bridge, then
Refresh.

### When something goes wrong

Every refusal has a code and a plain message that names the next step. The common ones:

| Code                                     | Meaning, and what to do                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AMBIGUOUS`                              | A name matched several pages (listed with paths). Pass the id of the one you mean.                                     |
| `NOT_FOUND`, `NOT_IN_REPOSITORY`         | No such page inside the AI REPOSITORY (it may be outside the root: use `lk_api_read`).                                 |
| `TREE_NOT_READY`, `TREE_NOT_CONFIGURED`  | The repository tree cannot answer yet. Nothing was spent. Tell the owner.                                              |
| `SEARCH_SYNTAX`                          | The search query is malformed; the message says where.                                                                 |
| `SECTION_AMBIGUOUS`, `SECTION_NOT_FOUND` | A section path matched several headings, or none. The options are listed.                                              |
| `BUDGET_EXHAUSTED`                       | Wait until `retryAt`. Do not retry in a loop.                                                                          |
| `PROJECT_REQUIRED`                       | A write did not name its project. Pass `project`.                                                                      |
| `VERSION_CONFLICT`                       | The page changed since you read it. Nothing was written: read again and redo the edit.                                 |
| `requiresCanonicalApproval`              | The change touches protected canon: it waits for the owner. Never retry it.                                            |
| `POLICY_DENIED`                          | This route is closed (a lifecycle change by another tool, a protected change). The message names the tool to use.      |
| `WORKING_PARENT`                         | A Working page needs `[INDEX] Working` or an index inside a Working set. The allowed parents are listed.               |
| `PAGE_NOT_WRITABLE`                      | The edit would change a block the API cannot write back (the inline-icon paragraph). Edit elsewhere or tell the owner. |
| `DUPLICATE_REQUEST`                      | Another request for the same character is under way. Follow it (its job or proposal).                                  |
| `OPERATION_ID_REUSED`                    | That `operation_id` was used for a different request. Use a new id.                                                    |
| `WRITTEN_IN_PART`                        | Some writes were made, then it stopped. Read the pages; make a new, smaller request.                                   |
| `OUTCOME_UNKNOWN`                        | A write may or may not have been made (`uncertain`). Read the pages; do not repeat it.                                 |
| `OWNER_APPROVED_JOB`                     | The owner approved that job; only the owner can cancel it.                                                             |
| `HAS_CHILDREN`                           | The page has pages under it: add `cascade: true` to delete them all.                                                   |
| `INVALID_ARGUMENTS` / `INVALID_PARAMS`   | An argument does not fit the tool's schema. Read the message; do not invent arguments.                                 |

`bridge_errors_recent` lists recent failures with LegendKeeper's request ids when you need to report one.
