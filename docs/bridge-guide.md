# The LK-Bridge guide for agents

This guide is for agents (Claude, ChatGPT) that use LK-Bridge to work with LegendKeeper worlds. **Read "How to decide" first**
(it is short: `get_bridge_guide` with `section: "How to decide"`), then the section for your task before you do it. The
tasks come first and the reference after. The last section, **Operations**, lists every LegendKeeper operation id.

## How to decide

**Five rules**

1. **Use the high-level tool, not `lk_api_*`.** Every common job has a tool that knows the repository. The `lk_api_*`
   tools are the fallback for the rare job none of them does ([When the low-level tools are right](#when-the-low-level-tools-are-right)).
2. **Read, then write, and pass the version you read back.** `write_page` takes `baseVersion` (from `read_document`);
   `set_facts` takes `baseFactsVersion` (from `get_resource`). A stale version writes nothing. Never write a page you have not read.
3. **Never retry a write that came back `proposal_captured`, `queued` or `waiting_budget`.** It is not lost. Follow a job
   with `bridge_job_status`, a proposal with `bridge_proposal_status`. After a refusal, do the one step the message names, once.
4. **Canon and lifecycle belong to the owner.** Making a page canon, archiving it, bringing it back or deleting an
   Authoritative page is always a proposal for the owner, whatever your scope. New pages are
   **Working** until the owner promotes them.
5. **Do not invent.** Names and ids come from `search`, `browse_repository_tree` and `get_resource`; dates from
   `calendar_date`; operation ids from the Operations list. A name that matches several pages is never guessed: pass the id.

**A question about a subject → `arkona_brief` first** (free; items labelled by lifecycle); then `search` and `read_document` only for what it points to.

**Every character intake and rename → `arkona_name_check`** (namesakes and the naming culture; never a guessed culture).

**A character at a date → `arkona_as_of`; changing a date → `arkona_consistency` first** (free; never picks a value).

**A story or chapter → part `Arkona fiction`** (save prose with `arkona_chapter_save`).

**Rename a subject → `arkona_rename` (never `update_resource`).** It renames a pack's character, culture, race or other
subject everywhere; `update_resource` refuses it (`USE_ARKONA_RENAME`).

**Split an owner → `arkona_split_appraisal`, then `arkona_split_owner` (never by hand).** Only when the owner asks (`write_page` refuses it: `USE_ARKONA_SPLIT`).

**Many characters' identity facts → `arkona_identity_reconcile`, dry run first; one field of many pages →
`query_facts`; label an objective's writes `workstream`, then `bridge_workstream_report`.**

**Which tool?**

| You want to…                                        | Use                                                         | Not                                           |
| --------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Find a page when you know part of its name or a tag | `search`                                                    | `browse_repository_tree` of the whole root    |
| See how a part of the repository is laid out        | `browse_repository_tree`                                    | many `get_resource` calls                     |
| Look at one page's facts, links, tags               | `get_resource` (`resources` for several, up to 25)          | `read_document`, `lk_api_read`                |
| Read a page's text (or one section)                 | `read_document` (`outline`, `section`)                      | `lk_api_read` `getDocumentBlocks`             |
| Change a page's text                                | `write_page`, section modes                                 | `replace` of the whole page, `lk_api_write`   |
| Change facts or links                               | `set_facts` (all changes in one call)                       | `lk_api_write` on properties                  |
| Rename, tag, alias, hide, lock                      | `update_resource` (a subject's rename: `arkona_rename`)     | `lk_api_write`                                |
| Make a character                                    | `create_character`, then `create_resource` (Working)        | `create_many_resources`                       |
| Make an Arkona character, or add pages to one       | `arkona_create_character` (one package)                     | `create_character`, `create_resource` calls   |
| Make any other Arkona owner page (polity, race…)    | `arkona_create_owner` (one package; its home checked)       | `create_resource` and `set_facts` calls       |
| Relate two Arkona characters, or add art to one     | `arkona_create_relationship`, `arkona_add_character_art`    | separate creates; a placed `upload_image`     |
| See a character's art (before describing it)        | `arkona_get_art` (inline, or the url to browse)             | a web or image search; code on the url        |
| Brief on any Arkona subject (or a character)        | `arkona_brief` (free; a character: delegated)               | many `get_resource` and `read_document` calls |
| Check a character's name before an intake or rename | `arkona_name_check` (free; never infers)                    | guessing a culture from the name              |
| Choose or check a Reference Type                    | `arkona_reference_types` (the vocabulary; free)             | inventing a type                              |
| Rename an Arkona character or owner everywhere      | `arkona_rename` (one proposal, item by item)                | `update_resource`, `write_page` page by page  |
| Split an Arkona owner into several owners           | `arkona_split_appraisal`, `arkona_split_owner`              | `write_page` and the create tools by hand     |
| Appraise Arkona pages, or see what a change breaks  | `arkona_appraise_owner`, `arkona_change_impact`             | reading every page yourself                   |
| Make any other page                                 | `create_resource` (template), `create_index` for a category | `create_bare_resource` (rare)                 |
| Move a page                                         | `move_resource`                                             | `lk_api_write` `moveResource`                 |
| Retire a page or a whole character                  | `archive_page` (`subtree: true` for a set)                  | `delete_resource`; a move to the archive      |
| Make Working work canon                             | `promote_page` (`subtree: true` for a set)                  | `set_facts` Status                            |
| Delete (and undo)                                   | `delete_resource`, `restore_resource`                       | `lk_api_write`                                |
| Check or convert a date                             | `calendar_date`                                             | working it out yourself                       |
| Add, change, remove a chronology event              | `create_`, `update_`, `delete_timeline_event`               | `write_page` on a table; `lk_api_*`           |
| Add or move a map pin, region, path                 | `create_map_feature`, `update_map_feature`                  | `lk_api_write` `createFeature`                |
| Put an image in the library                         | `upload_image` (staged first at `propose`)                  | `lk_upload_image` (older; usually not shown)  |
| See older states of a page and bring one back       | `list_snapshots`, `snapshot_diff`, `restore_snapshot`       | rewriting the text with `write_page`          |
| See what the audits found                           | `audit_findings`                                            | scanning pages yourself                       |
| Know how much budget is left, or if work fits       | `bridge_budget`, `bridge_estimate`                          | reading pages to find out                     |
| Know what happened to a proposal or job             | `bridge_proposal_status`, `bridge_job_status`               | repeating the write                           |
| Do something none of the above does                 | the `lk_api_*` tools, with an id from Operations            |                                               |

**What your scope means.** `read` shows read tools only. At `propose` a write becomes a **proposal** the owner decides
on the dashboard; nothing is written. `write` writes directly, except rule 4's always-proposal changes and
`restore_snapshot`. `bridge_info` says which you have.

**Sections to ask for** (`get_bridge_guide` with `section`; a near miss is matched loosely when the match is clear):

- `How to decide` (this section)
- `Find and read a page`
- `Edit a page's text`
- `Change facts and links`
- `Create a page or a character (Working first)`
- `Setting packs (Arkona)`, and under it `Arkona briefs and names`, `Arkona characters`, `Arkona owners`,
  `Arkona relationships, art and the brief`, `Arkona appraisal`, `Arkona renames`, `Arkona splits`, `Arkona retagging`,
  `Arkona identity facts in bulk`, `Arkona Reference Types`, `Arkona fiction`; `Many pages at once: query_facts and workstreams`
- `Rename, move, delete and restore`
- `The page lifecycle` (promote, archive, unarchive, move to Working)
- `Dates and the chronology`
- `Maps`
- `Images`
- `Snapshots and restores`
- `Audit findings`
- `Budgets, jobs and proposals`
- `Canon and approval`
- `At write scope` (what is direct, what is still a proposal)
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
| A page by a word in its text           | `search` with `content: true` (free: the bridge's full-text index)   |
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
says why it matched.

**Searching page text.** `content: true` also searches every page's text (blocks, sidebar facts, names and aliases)
through the bridge's full-text index, with the same operators: free, and complete **as of the newest snapshot it names**
(edits made in LegendKeeper since are not in it yet). A word matches words starting with it; a phrase matches exactly.
Each result says its `lifecycle` (Authoritative, Working, Archived) and `branch`, and a page found by its text shows
where (document, section, a snippet). The Legacy Canon Archive and the Design References are left out unless you ask
(`include: ["legacy", "design"]`): they are not current. A result is discovery evidence, never proof on its own: read the
page before you rely on it.

`content: "live"` asks LegendKeeper's own search instead (1 read). Its content search is incomplete by nature: ranked,
capped at 100 results, no operators, so a page it did not return may still contain the word. Never conclude that a word
appears nowhere from a live content search.

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
naming the projects they work on). The Arkona pack has twenty-one tools. Ask for the part you need:

| You want                                           | Use                          | Part to ask for                           |
| -------------------------------------------------- | ---------------------------- | ----------------------------------------- |
| Know a subject first (free, no read)               | `arkona_brief`               | `Arkona briefs and names`                 |
| Check a name: namesakes, naming culture (free)     | `arkona_name_check`          | `Arkona briefs and names`                 |
| A character at a date (free)                       | `arkona_as_of`               | `Arkona consistency checks`               |
| Dates and identity facts that disagree (free)      | `arkona_consistency`         | `Arkona consistency checks`               |
| Which characters have readable dates (free)        | `arkona_as_of_coverage`      | `Arkona consistency checks`               |
| Suggest the right value to the owner               | `arkona_consistency_suggest` | `Arkona consistency checks`               |
| Make an Arkona character, or add pages to one      | `arkona_create_character`    | `Arkona characters`                       |
| Make any other Arkona owner page                   | `arkona_create_owner`        | `Arkona owners`                           |
| Relate two existing Arkona characters              | `arkona_create_relationship` | `Arkona relationships, art and the brief` |
| Add art to an existing Arkona character            | `arkona_add_character_art`   | `Arkona relationships, art and the brief` |
| See a character's art, with what it establishes    | `arkona_get_art`             | `Seeing character art`                    |
| Recall who an Arkona character is (free, no read)  | `arkona_character_brief`     | `Arkona relationships, art and the brief` |
| Appraise pages against Source Formatting (free)    | `arkona_appraise_owner`      | `Arkona appraisal`                        |
| See what depends on a page, a rename, a proposal   | `arkona_change_impact`       | `Arkona appraisal`                        |
| See what is in progress (Working pages and more)   | `arkona_working_digest`      | `Arkona appraisal`                        |
| Check the images and the asset library             | `arkona_visual_hygiene`      | `Arkona appraisal`                        |
| Make the fix an appraisal finding offers           | `arkona_appraisal_fix`       | `Arkona appraisal`                        |
| Rename a character or owner everywhere it is named | `arkona_rename`              | `Arkona renames`                          |
| See whether an owner page should be split (free)   | `arkona_split_appraisal`     | `Arkona splits`                           |
| Split an owner page into owners                    | `arkona_split_owner`         | `Arkona splits`                           |
| Audit pages' native tags (free)                    | `arkona_retag_audit`         | `Arkona retagging`                        |
| Apply deterministic tag corrections (a proposal)   | `arkona_retag_apply`         | `Arkona retagging`                        |

**What every pack tool that makes pages does the same way** (the appraisal tools only read: see `Arkona appraisal`).

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

### Arkona briefs and names

Two free reads (the bridge's own tree, snapshots and records; no LegendKeeper read). Neither writes anything, and neither
guesses: they report what the records say, and you ask the owner.

**`arkona_brief { subject }`: the first step for any question about a subject** (a nation, polity, culture, religion,
place, event, magic system or item), before `search` and `read_document`: one call instead of reading five pages
(Project Navigation's "Smallest Sufficient Retrieval"). `subject` is a name, alias, path or id; a name meaning several
subjects is refused with the candidates (`AMBIGUOUS`): pass the id. A character is answered by `arkona_character_brief`
(the answer says `delegated`). It returns:

- **the owner**: the subject's `[INDEX]` and the pages directly in it, or its single owner page, each with its
  `lifecycle` (Authoritative, Working, Archived; `au` for an alternate universe), Reference Type, Scope, Last Major
  Revision and tags;
- each owner's **Dependencies** (one level, each with its lifecycle and Scope; a Dependency on a Working or Archived page,
  or on historical material, carries a `flag` quoting Project Navigation: "Current authority must not depend on Working,
  historical material or an unrelated AU"), its **incoming Dependencies** (the count and the first ten), its **Source
  Boundaries** and **Unresolved Material** (a long section is cut, with a `handle` for `bridge_result_page`), and its
  **Related Sources**;
- the **chronology** rows that name it (by a mention, its name or an alias), with their date, KCY and age table;
- the **work in progress**: Working pages that mention it or depend on it, and pending proposals touching its pages;
- its open **audit findings**, and how fresh each source is.

Every item carries its lifecycle: **established canon and Working material are listed apart, never merged**. Never treat
a Working page's material as canon. The Legacy Canon Archive and the Design References are left out (and counted) unless
`include: ["legacy", "design"]` names them. `live: true` re-reads the head owner's sidebar (one read); `detail: "full"`
gives longer lists and sections. Then read only what the brief points to.

**`arkona_name_check`: part of every character intake and rename** (Character Architecture: the naming-culture review
is mandatory). Characters share names. Give `name` (and `givenName`, `surname`, `aliases` when known): it lists the
current characters (Authoritative, Working, AU; never Archived) sharing the full name, the given name, the surname or an
alias, each with the page holding its identity, its Naming Culture and Life State, and what matched. Names are compared
without case, accents or prefixes, and a full name in either order ("Asagiri Miyabi" finds "Miyabi Asagiri"). An exact
full-name match is a `warning`, a partial one `info`; **names may be shared, so nothing is ever refused**. `exclude`
leaves a character out (the one you are renaming). With `namingCulture` (a value the owner gave), it resolves the culture
through the pack's culture map to its owner under Arkonan Cultures and returns that owner's naming sections and the
characters recorded with that culture, for consistency; an unmapped culture is said so.

**It never suggests or infers a naming culture, race or nationality from a name, a surname or its etymology, and never
proposes a rename.** Bring what it reports to the owner and ask; record only what the owner decides. `arkona_create_character`
and `arkona_rename` run the namesake part themselves: an exact full-name match is a `NAMESAKE` warning in the preview and
in the proposal's summary the owner reads; tell the person about it.

### Arkona consistency checks

Free reads of the bridge's snapshots, full-text index, chronology tables and calendar engine (no LegendKeeper read unless
`live: true`). They report; they never repair, and never decide which side is right (Repository Automation's Default
Boundary).

**`arkona_as_of { characters, date }`: before you write about a character at a date** (a chapter, a scene, a history).
`date` is a date of the calendar (`Camue 1st, 4A 100`, `c. 4A 640`, `4A 100`) or `now` (the pack's present, 5A 931). For
each character (at most 25) it returns where its birth is recorded (or "birth unestablished"); the **elapsed calendar
years** (a number when both dates are exact days, a range when either is approximate or coarser, "not yet born" before
the birth, none when the birth is unknown); the **state recorded**: Alive (recorded) between its birth and a recorded
death, inside its attested span or, with a Life State of "Alive", up to the present (never across a recorded death: after
a death with no recorded return it is "Unestablished (recorded death; current Life State Alive)", and between one life's
death and the next life's start "Between lives (recorded)"); Deceased (recorded) after a recorded death with no later life, or "Deceased (recorded by <date>)" at or after a Life State's "Deceased by <date>"; **Unestablished** otherwise; the
chronology rows naming it nearest the date on each side (`window`, default 3); and any open **contradiction** on its birth
or death. **It never gives apparent or biological age**: Arkona's races mature and age differently, so read the race
reference it links. An attested life never proves survival past it: never write a character as alive where the answer
says Unestablished without asking the owner. A character with more than one life (a return, a restoration, "First life
…; second life born …") is answered life by life: `life` names the life the date falls in ("in the second life", "after
the restoration") or the two lives it falls between, `lives` lists them, and the elapsed years are counted within the
life the date falls in. `continuity` (an AU's name) uses the AU's own pages first, else Main CANON's
values labelled "inherited from Main CANON".

**`arkona_consistency { subject | under | all }`: before you change a date** (a birth, a death, a chronology row) or an
identity fact (Race / Species, Naming Culture, Life State, given and family names). It compares what the character's
identity page (its Core or Compact Reference) records with every page that restates it, and a chronology row with the
same event on a page it mentions. Dates are read with their precision; two values conflict only when they cannot both be
true (`4A 100` and `Camue 1st, 4A 100` agree; a "c." date has a margin of five years each side). Each finding shows the
identity page's value first, then each disagreeing restatement with its page, lifecycle, section and excerpt, labelled:

- **Contradictory** (Authoritative against Authoritative; also in the nightly audit, category `consistency`);
- **Proposal differs from canon** (a Working page: allowed to differ);
- **Gap** ("Unestablished" against a value: never a conflict);
- **Unreadable** (a date the calendar cannot read, with its text: never guessed).

Only the pack's phrasings are read ("Born …" in a Temporal Scope, "<name> was born on …", "<name> died in …", a dated
line, a chronology row by its columns), and only when the name **governing the verb** is the character's (a name, alias
or Canonical Display Name; never a pronoun, never another name in the sentence: "Their son Murad al-Khalid was born…" on
his father's page is Murad's birth), so it misses some restatements by design. The date is the first date-shaped text
after the verb ("born in Falkenau on Jehet 27th, 4A 84 (… KCY)"); a dateless "Deceased" is a state, and "Deceased by
<date>" a bound, never a death date. Identity values are compared by their principal value (before the first `;`, `(`
or " - "). Archived pages, the Legacy Canon Archive, the Design References, and sections and chronology rows marked
"Pre-Rewrite" or "Author-Facing" are left out unless `include` names them (`archived`, `legacy`, `design`,
`pre-rewrite`); AU pages are compared only within their AU. A long run is stored: page through it with `runId` and
`offset`.

**Fixing is the owner's.** Tell the person what disagrees and show both values; the owner picks the right value on the
dashboard ("Pick the right value"), and the bridge makes ONE proposal editing every page that disagrees (never the side
picked). You may **suggest** a value with `arkona_consistency_suggest { findingId, value, reason }`: it is shown to the
owner and applies nothing. Never edit the dates yourself to make the pages agree.

**`arkona_as_of_coverage`**: how many characters have a birth the calendar can read, a birth deliberately unestablished,
attested bounds only, or nothing readable (one bucket each, adding up to the total), with a recorded death and an
unreadable birth counted as flags. A report for the owner, never a task list: an unrecorded birth is often deliberate;
never invent a date.

### Arkona fiction

Stories live under **Narratives** (found by name), in **Main CANON** or in one index per AU defined under
**Continuities**. A story is an index; its **first child is its Story Map**; with acts, one act index `Act <n> - <Title>`
holds its chapters and one `Act <n> Map` under the Story Map holds its plans; without acts, chapters sit in the story and
plans in the Story Map. **Chapter numbers run across the whole story** (Act 1 holds 1–3, Act 2 holds 4–6), and inside
Narratives pages are ordered Story Map first, then by number (Act 10 after Act 9). Narrative pages take **no [BSRC] or
[BWRK] prefix and no lifecycle** (the lifecycle tools refuse them: `NARRATIVE_NO_LIFECYCLE`); they are tagged
`Narrative`, their kind, and `AU` in an AU's story. They are **never canon evidence**: the briefs and the consistency
check never read them.

**Moving a page into or out of Narratives is always a proposal**, at every scope and on every route (`move_resource`,
the low-level tools, a create, copy or restore there by any tool but the narrative ones): canonical when a page of it
carries a lifecycle prefix, a status tag or a lifecycle Status, which it would lose or regain. Never move canon into a
story, or a chapter out into the repository; tell the owner instead. No page may take a narrative index's name
(Narratives, Continuities, Main CANON). A page in Narratives that still carries a lifecycle prefix is canon filed in the
wrong place: it stays canon evidence, the audit reports it (`narrative_lifecycle_page`), and the writing tools leave its
story alone (`NARRATIVE_LIFECYCLE_PAGE`, naming the page) until the owner moves it out.

Routine organisation follows your scope (direct at `write`, on the Review page and Revertible; a proposal at `propose`):

- **`arkona_story_create { continuity, title, acts?, span?, principalCharacters? }`**: the story index, its Story Map and
  (with acts) the act indexes and Act Maps. A continuity index that does not exist yet is refused (the narrative audit
  proposes it to the owner).
- **`arkona_chapter_plan { story, number, act?, title?, plannedDate?, pov?, questionGate? }`**: a Chapter Plan under the
  right map, or that plan's fields updated. Its body is the template's chapter-plan headings: write the planning text
  with `write_page`. A new plan's **Question Gate** starts `Open`, and it takes its story's Continuity Type and
  Continuity, as the maps do.
- **The Drafting Gate**: ask the plan's questions, record the answers, then close the gate (`questionGate: "closed"`).
- **`arkona_chapter_save { story, number, title, inWorldDate, place?, pov, charactersPresent, locations, draftStatus,
markdown, baseVersion? }`**: saves the prose (the Fiction Writing Reference, 32B). The tool writes the **dateline**
  itself as the first line (`Isar 27th, 4A 645 · <Place>`): leave yours out (one you put first is replaced).
  `inWorldDate` must be a date the calendar reads, exact or approximate (`c. 4A 640-645`). A new number makes the chapter
  and links it with its plan both ways; an existing one is revised **in place**: read it with `read_document` and pass
  its version as `baseVersion`. An Open Question Gate is refused unless `overrideGate: { reason }` (shown on the Review
  page). The answer's `readBack` says whether the chapter read back word for word, compared with what the job sent
  (`compared`).
- **`arkona_chapter_insert { story, at, title }`** and **`arkona_chapter_move { story, from, to, act? }`**: renumber every
  later chapter and plan (names and Chapter Number; mentions follow; prose never changes). More than 10 pages is a
  proposal the owner approves item by item.

**The working sequence** (the Workflow's): `arkona_chapter_context` (the canon this chapter needs, as of its date; free)
(both reading tools need a full snapshot of the project: before the first, `NO_SNAPSHOT`)
→ the **Question Gate** (ask the plan's questions; record the answers; close the gate) → **draft** → `arkona_chapter_save`
→ `arkona_chapter_check` (what the chapter says against canon at its date: `Contradicts canon`, `Not in canon
(candidate)`, `Unestablished in canon`) → `arkona_promote_from_chapter` for the lore the owner should see. A story's
inventions stay fiction until the owner accepts them: promotion makes **canon proposals** (a character, a page, a fact
or a text) whatever your scope; you supply the content; the chapter is cited in the proposal's note; never promote by
yourself, and never treat silence as acceptance. Fix a `Contradicts canon` item in the chapter, not in canon.

A field a template lacks is never invented: a value you give for one is refused (`TEMPLATE_MISMATCH`, naming it);
others are skipped and listed (`fieldsNotOnTemplate`). The nightly audit's `narrative` category reports structure,
numbering, plans against chapters, open gates, datelines and dates; its fixes are the owner's.

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
  `staged_id` from `upload_image` with `stage: true` and no destination, a `label` `"{Visual Role} - {Descriptor}"` and its `interpretation`,
  what the image establishes: design pieces, placed in the character's own folder; add outfit art afterwards with
  `arkona_add_character_art` and `outfit`); and `relationship`, with
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
Compact Reference to its Character Core (its text kept). A Compact Reference becomes the Character Core automatically,
in the same proposal, when its character gains an index with several owners (where its text calls itself compact, that phrase replaced; any other compact phrasing listed, never edited; its images
left to the Art page; `upgradeToCore: false` is then refused with `CORE_REQUIRED`). New pages are announced in the index's "How to Use This Index"
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
  "referenceType": "Polity Reference",
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

**Art for an existing character: `arkona_add_character_art`.** ONE call, ONE target. Design pieces:
`{ "character": "…", "images": [{ "staged_id": "…", "label": "Primary Reference - Character Portrait", "interpretation": "…" }] }`.
An outfit's pieces: `{ "character": "…", "outfit": "Ceremonial Robes", "images": [{ "staged_id": "…", "label": "Outfit Reference - Front", "interpretation": "…" }] }`.
`outfit` applies to every image of the call; without it they are design pieces. You never name a folder: the bridge
reads the character's folders LIVE and decides. Design pieces go in the character's own folder
(`Characters / <race path> / <name>`) as `<name> - <label>`. An outfit's pieces are named `<name> - <outfit> - <label>`:
an outfit's only piece lies loose in `Wardrobe`; with two or more pieces the outfit has its folder `Wardrobe / <outfit>`,
made when the second piece arrives, the loose piece moved into it in the same job; an outfit that has its folder takes
new pieces there. Forms, Outfits and Details are retired: nothing makes them again (`LEGACY_ART_FOLDER`). The outfit is
matched by its name or an alias the owner gave it (case and spacing ignored). A name CLOSE to an existing outfit's
("Imperial Regalia" beside "Supreme Imperial Regalia") is refused with `OUTFIT_NEAR_MATCH`, which lists the candidates:
call again with the exact name, or with `newOutfit: true` when it really is another outfit. Names are never given a file
extension and are numbered when taken. On the character's Art page, design pieces go under "Reference Images"; an
outfit's go under a heading naming it (wherever it is on the page), else a new one under the page's first heading
holding "Wardrobe", else a new "Wardrobe" section; the Art page is made when it is missing, nothing else on it changed.
Every image needs its `interpretation`, what it establishes (`BARE_IMAGE` otherwise). Up to 30 images a call. Sources:
`staged_id` (staged with no destination), `upload_id` (from `prepare_image_upload`), or in ChatGPT the attached `file`
for one image; an upload or file is staged first, even on a dry run, and its `staged_id` is in the answer. **Several
images: use an archive** (a zip), below.

**Many images: an archive (`upload_image_archive`).** In ChatGPT: attach the zip to `upload_image_archive` (as `file`);
open the same zip in your own code tool to look at each image and write its interpretation; then call the art tool with
images given as `{ "archive": { "id": "<archive_id>", "entry": "<entry>" }, "label": "…", "interpretation": "…" }`.
Elsewhere: `prepare_image_upload` with the zip (`content_type` `application/zip`), run its script, then
`upload_image_archive { "upload_id": "…" }`. Every entry is listed at once (its `entry`, `path`, `folder`,
`suggestedOutfit`, format, size and SHA-256); only the entries an art call uses are converted (or all, with
`stageAll: true`). One archive can feed several calls, and one call can draw from several archives. The folder is a
suggestion: look at the images; use `suggestedOutfit` when it fits; for each top-level image decide yourself whether it is
a design piece or a single-piece outfit; if you are unsure, ask the owner. `character` checks each folder against that
character's outfits (`outfitMatch`: exact, near with its candidates, or new). An entry past the hourly brake or the staging
capacity is `held` and finishes on its own: never upload it again; follow `bridge_archive_status` (free; `retry` converts
failed entries again). An art call naming an entry not staged yet is planned from its header and its job waits
(`waiting_staging`); an entry refused or discarded is left out with its reason, never the others.

**Recall who a character is: `arkona_character_brief`.** `{ "character": "…" }` answers from the bridge's own records,
free: the six identity fields, every page of their set with its Reference Type and Scope, their relationships, their Art
pages with image counts, open audit findings and Unresolved Material, each with how fresh it is. `live: true` re-reads the
identity fields (one read). Use it before you write about a character, and tell the person who is under discussion.

### Seeing character art

**Before you describe, draw on or write about a character's appearance, call `arkona_get_art`.** It is the only way to
see the character's real art. Give exactly one of `character` (all its art; `outfit` for one outfit by its name or an
alias; `design: true` for the pieces in its own folder), `asset` (1 to 6 asset ids or file URLs) or `page` (every image
on a page, in order). At most 6 images a call; call again with `nextCursor` for more.

**What comes back is literal.** Use each image as a literal visual reference, read together with its `authority`: the
pages that show it, each with the image's label and the owner's `text` under it, which records what the image
establishes, its precedence and its limits. **The authority text governs**: where it limits the image, so do you.
Authoritative pages come first. `authority: "none"` means no owner page embeds the image: it establishes nothing about
canon, so say so before you rely on it.

**How to see it.** `delivery: "both"` (the default) gives each image's `url` and the image itself, resized, after the
JSON. If the images did not arrive inline (some clients drop them), open each `url` with your **web browsing tool**,
never with code: code sandboxes cannot reach the asset host. `delivery: "link"` gives the urls alone (no download, no
budget).

**Never substitute.** Never use an image found elsewhere (a web or image search, an image you made) as if it were the
character. If neither the inline image nor the url reaches you, say that you could not see the art; do not describe it.

Cost: none for links; 1 read per image downloaded for inline (cached), plus the live reads that select (a character's
folders, a page's documents).

### Arkona appraisal

Four reports and one way to act on a finding (a fifth report, whether an owner should be split, is `Arkona splits`). **The reports are read-only and free**: they read the bridge's snapshots
(the nightly full snapshot plus the change snapshots since), the audits and its own records, never LegendKeeper, and they
**write nothing and propose nothing**. Each says what it inspected, how fresh its data was and what it could not check.

| You want                                                       | Use                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A page, a branch or everything against Source Formatting       | `arkona_appraise_owner` (`page`, `under` or `all`)                                                                     |
| What depends on a page, a planned rename or a pending proposal | `arkona_change_impact` (`page`, `renameTo`, `proposal`)                                                                |
| What is in progress: Working pages, open proposals and more    | `arkona_working_digest` (`since: "7d"`)                                                                                |
| The images and the asset library                               | `arkona_visual_hygiene` (`page` or `under` narrows it)                                                                 |
| To act on one finding whose follow-up is a `fix`               | `arkona_appraisal_fix` (`findingId`): at scope `write` made at once by default (the owner's switch), else ONE proposal |

**Reading a report.** Findings come in groups (A2: required defects, optional polish, architectural candidates, blocked
cases; A3: proven breakage, review candidates). Each names the rule it comes from (the governance page and section), its
evidence class and its **`followUp`**:

- `fix`: a deterministic repair. Call `arkona_appraisal_fix { "findingId": "…" }` **only when the person asks for it**. It
  re-reads the page, checks the finding still holds (`FIX_STALE` otherwise: nothing is proposed) and makes **one
  proposal** for the owner, whatever your scope: nothing changes until the owner approves. Never resubmit it: follow it
  with `bridge_proposal_status`.
- `judgement`: there is no single right repair. It names the tool you would use and what has to be decided: ask the
  owner, never guess (a Purpose section needs the subject's purpose from the owner or its sources).
- `none`: report only.

**Keep to the evidence.** A polish item or an architectural candidate is a prompt to review, not a defect; a restatement
(A3) is a candidate, never proof anything changed; a visual finding (A5) is a candidate, never a defect to repair; age in
the Working digest is shown, never judged. Blocked cases say what could not be checked: do not fill the gap yourself.

**Long reports** come a page at a time: pass `limit` and `offset`, or `group`; `runId` (from the answer) reads the stored
report again without re-running it. `live: true` (A2, A3) re-reads the pages concerned first and costs reads (A2: 2 a
page, at most 25 pages): use it only when the person needs what changed since the snapshot.

### Arkona renames

`arkona_rename` renames an Arkona **character** (name any page of its set) or **owner** (a culture, a polity, a place, a
race) **everywhere it is named**, as ONE **canonical proposal** for the owner, whatever your scope: a rename changes how
canon names its subject, so it is never made at once and never routed round. The owner approves it whole or item by item.

**What you supply.**

- `subject` (a name, alias, path or id) and `newName`, the name as the pages are to show it.
- `given` and/or `family` when the rename changes a character's name part. **Name parts are never inferred**: if the old
  given or family name is not in the new name and you did not give it, the call is refused (`NAME_PARTS_REQUIRED`,
  naming the part). Ask the person; never derive a name part from the shape of a name.
- `keepOldAsAlias` (default `true`): the old name goes into the Aliases fact and the pages' search aliases.
- `effectiveDate` (optional, a date of the calendar): chronology rows dated before it start unticked.
- `token` for a culture or race whose tag is not its own name (`Draconic (True Dragons)` is tagged `Draconic`): the new
  tag, as the person decided. Never invent one (`TOKEN_REQUIRED`).
- `dryRun: true` first: the plan, item by item, with what each changes, and the cost.

**What it plans, each as an item** (ids are kept: nothing is recreated): the subject's page names (its index, Core or
Reference, every `<Old> - …` child, every relationship naming it, either way round), its identity facts, the old name as
an alias, index routing lines, chronology rows naming it (their timeline events kept in step), the art folder and asset
names, a race's taxonomy entry, a culture's or race's **identity token** (a new pack version the owner approves on the
Packs page; the job waits for it) with every character's fact and tag, and each **textual restatement** elsewhere, one
item per occurrence, with its sentence. A plain mention shows the page's new name by itself, so it is not an item.

**Review only: bring these to the owner (never items).** The plan's `reviewOnly` (and the report's after the job) lists
what the bridge never edits:

- **Name parts**: the old given name, the old family name and each old alias **on their own** (not inside the full old
  name), on current pages, each with its page, section and sentence. Characters share names (renaming Azhar al-Nasir
  leaves plain "Azhar", which may be Azhar al-Rashid), so an occurrence on a page of another character whose name holds
  the same part says so ("this page is in Azhar al-Rashid's set"). Nothing is approved here: tell the person, and if
  they want specific occurrences renamed, propose a follow-up with `from`.
- **Custom mention labels** holding the old name: LegendKeeper's API cannot change a mention's custom label, so the rename
  never writes one ("custom label: change it in the app if wanted"); a rename never fails on one.

At most 200 are listed, with the count of the rest.

**Ticked or not (D1 (a)).** A restatement on a current page starts ticked, except inside quotation marks, after
"formerly", "previously", "once called" or "originally" in the same sentence, under Unresolved Material, or in a
chronology row dated before `effectiveDate`: those start unticked, and the item says why. The owner decides; never argue
a tick from the agent's side.

**Never edited (D2).** Archived pages, the Legacy Canon Archive and the Design References keep the old name; the plan lists
them as "left as historical". AU pages are included, labelled AU. Text in a table cell or a code block, or a name split by
formatting, is reported in `notPlanned` (the owner edits it by hand).

**After it runs.** The job first checks that the subject still has its old name (renamed meanwhile: nothing is written),
then writes the approved items in order (names, then facts, then everything pointing at them), each inside its own page's
lock. **Another writer part-way** (the owner in the app, another job) does not stop it: each item's write re-reads its
target and, when what it edits is still exactly there, re-applies the same change to the fresh text (at most 3 tries).
When that exact text changed meanwhile (or now appears more than once), the item is **skipped**, listed with a before and
after excerpt, and the job carries on; the owner can propose skipped items again. Only the subject's own page names and
identity facts stop the job (resumable). It reads back every page it touched, and dates Last Major Revision by the owner's rule (a name, an alias or a fact that only swaps the name never
counts; 8 or more restated words, a heading or a chronology row do). Then `arkona_rename { "report": "<rename, proposal or
job id>" }` (free) lists what is still left of the old name on current pages, each with its link: what the owner left out,
what the rename does not edit, and anything written since. To propose exactly those, call it again with
`from: "<the old name>"` (the subject already has the new one); tell the person first.

**Never resubmit a rename**: follow it with `bridge_proposal_status`. A rename's job that stops part-way is resumed by the
owner on the dashboard (it ran work the owner approved); `bridge_job_status` shows where it stopped.

### Arkona splits

Splitting an owner page (a character monolith, a polity page covering its law and its faith) is a **deliberate,
owner-approved decision**: "do not split merely because a character has many facts". Two tools, used in order, and
**never by hand**: `write_page` refuses an edit that takes a section's worth of text off a pack page
(`USE_ARKONA_SPLIT`); a page's own revision that removes material on purpose passes `plainEdit: { "reason": "…" }`, and
the reason is shown to the owner. The low-level tools are no way round it: the same amount of text taken off a pack page
through `lk_api_write` or `lk_api_batch` is a proposal for the owner (`proposed because: text removal …`).

**1. Appraise: `arkona_split_appraisal { "page": "…" }`** (or `under` for a branch). Read-only and free (the snapshots;
`live: true` re-reads each page, 2 reads a page). It measures Character Architecture's Split Triggers with the pack's own
thresholds: **Scope Overload** (the Scope or the sections name 3 or more domains), **Retrieval Cost** (long text AND 2 or
more domains: length alone never counts), **Asset Ownership** (a non-Art page interpreting images, or a wardrobe, form or
outfit section with images), **Shared Ownership** (a long section about one other named character with no relationship
owner), **Distinct Unresolved Material** and **Distinct Dependencies**. Each candidate comes with its evidence, a **draft
destination map** and the **Anti-Fragmentation note** (what should stay together, such as personality and habits). What
it cannot measure (Independent Retrieval, Independent Maintenance, Downstream Dependency) comes back as **questions**.
`arkona_appraise_owner` shows the same candidates in its architectural group. Bring all of it to the owner; a candidate is
never a decision.

**2. Split, only when the owner asks: `arkona_split_owner`.** You give the **destination map**, and `dryRun: true` first:

- `destinations`: each with a `key` and a `kind`: `new` (a character's page by its role, `title`, `referenceType`, or any
  other owner by `type`, `name`, `home`; each with `scope` and `purpose`), `existing` (`page`, and `under`: the heading
  the material goes under), `relationship` (an existing relationship `page`, or a new one `with` the other character), or
  `universal` (material a universal owner already owns, a magic rule for one: `owner` and the subject's own application
  `text`; it is not migrated, the text replaces it and the owner becomes a Dependency).
- `map`: every section of the source to one destination's `key` or `stays`. A section that must be divided is divided
  block by block (`blocks: [{ "ids": […], "to": "…" }]`; the ids from `read_document` with `format: "json"`, or from a
  refusal's lists): each block exactly once.
- `summary` for each section that leaves a source that survives: a short interface summary; the bridge adds the exact link.
- `dependencies`: each page that depends on the source, to the new owner it actually needs. `retire: true` (archive the
  source once phase 1 has verified) needs every one of them.
- **Each new owner complete.** When the source has Source Boundaries or Unresolved Material, each new owner the pack
  expects to carry them (on Arkona: a Core, a Compact Reference, a relationship owner and any non-character owner; an Art
  page or a specialist page only when the pack names its Reference Type; the dry run says `by: "not expected"` for the
  others) addresses each one: move items of it there in the `map` (they go under that heading), give your own text
  (`sourceBoundaries`, `unresolvedMaterial`, Markdown), or say it does not apply, with a reason the owner reads in the
  proposal (`notApplicable: { "sourceBoundaries": "…" }`); never leave it out (`SPLIT_SECTIONS_UNADDRESSED`). The bridge
  never writes these sections for you. Give each new owner its own Dependencies: start from the source's own (the dry run's
  `completeness.suggestedDependencies`) and keep only those it relies on; when it has none, say why
  (`noDependencies: { "reason": "…" }`; otherwise `SPLIT_DEPENDENCIES_UNADDRESSED`).

**Refused before anything is proposed, with lists:** a block unassigned or assigned twice (`SPLIT_COVERAGE`), a section
listed twice (`SPLIT_DUPLICATED_AUTHORITY`), images going to a page that is not an Art or visual owner (`SPLIT_VISUAL`),
content LegendKeeper cannot create (it can only stay), a missing summary (`SPLIT_SUMMARY_REQUIRED`), an unmapped
Dependency of a source to be retired (`SPLIT_DEPENDENCIES_UNMAPPED`), a character's identity page to be retired, a map
that would leave a character with an index and several owners but no Character Core (`SPLIT_CORE_REQUIRED`: upgrade its
Compact Character Reference first with `arkona_create_character`, `target` and `upgradeToCore`), and whatever the pack's
own rules refuse for a new page (its name, template, tags, home). A Compact Character Reference you split into several
owners becomes the character's Character Core in the same proposal (its id, text and identity facts kept). **Warnings** for the owner: a
section about one other character not going to a relationship owner, and a block citing a universal owner moving into
a character's page.

**What happens.** ONE **canonical proposal**, whatever your scope; never resubmit it. The owner approves it whole or
destination by destination: a destination left out keeps its sections in the source (nothing is lost). **Phase 1** (one
job) makes and extends the owners with every block moved **verbatim, its id kept**, checks that each destination holds
what it receives **before anything leaves the source**, then takes the blocks out of the source with their summaries,
writes the index lines and the remapped Dependencies, dates Last Major Revision by the owner's rule, and **verifies** with
a direct re-read (every original block in exactly one place). If any of it fails, the job stops before phase 2: the
owner resumes or reverts it on the dashboard. **Phase 2**, with `retire: true`, once phase 1 has verified and nothing was
left out: the bridge proposes archiving the source with `archive_page`, a separate canonical proposal. The split never
deletes the source. `arkona_split_owner { "report": "<split, proposal or job id>" }` (free) says what became of it, and
its `verified` is the job's own verification: a job that ran to its end but read back a difference leaves the split
`unverified` (nothing is retired; tell the owner, who looks at the job's differences). Its `nextSteps` (also in the dry
run and the proposal) list what is still owed afterwards, each with its tool: tell the owner, and do each only when asked. A
destination the owner left out is not proposed again from the old plan: when the owner asks, split what is left as a
new split, on the source as it is now. A source holding an inline icon cannot be split (`SPLIT_NOT_WRITABLE`: the split
writes the source back whole); ask the owner to remove the icon first.

**Cost**, measured on the test fixtures: a character monolith (a Compact Character Reference, upgraded to its Character
Core in the same proposal) split into six new owners with one remapped Dependency costs 26 requests to propose and a job
of 248 (89 writes); an owner split into one new and one existing owner, 12 to propose and 84 (22 writes). The dry run
states the plan's reads and the job's estimate.

### Arkona retagging

The Controlled Native Tagging Standard is the policy; the pack holds a derived translation of it, approved by the
owner. Three rules: **audit first; holds go to the owner; the apply is always a proposal.** Never retag a page by hand
with `update_resource` (and never add or remove `CANON`, `AU`, `Working` or `Archived`: those are the lifecycle tools').

**1. Audit: `arkona_retag_audit { "under": "…" }`** (or `page`, or `all: true`). Read-only and free (the snapshots;
`live: true` re-reads each page, one read each, at most 50). Each current Authoritative page (Main CANON, or AU under the
owner's ruling) comes back with its resource ID, its **current** and **proposed** arrays, a **rationale** for each slot
(the fact or record it comes from), the policy version and digest, and its **disposition**:

- `compliant`; `correction` (deterministic: a wrong order, a missing culture token, an Excluded Routine Tag to remove);
- `hold`: something only the owner can settle: an **uncertain category** (no pack record and two primary categories, or a
  Reference Type that contradicts the tags), a specialist, an identity value that is missing, `Unestablished`, unmapped
  or given twice, or a missing status tag;
- `exception`: an existing tag outside the grammar that the Standard does not list as routine: the owner's judgement.

Working and Archived pages are checked for the lifecycle grammar only (`lifecycle_tag_not_leading`, the audits'); the
Legacy Canon Archive, Design References, indexes and repository governance are never retagged. The category is never
taken from a name, a parent or the body, and no tag outside the closed list is ever proposed. Read a stored run again a
page at a time with `runId` and `filter`.

**Holds go to the owner.** Tell them which pages are held and why. You may suggest a classification with your reason:
`arkona_retag_audit { "suggest": { "page": "…", "primary": "Culture", "specialist": "Language", "reason": "…" } }`. It is
only a suggestion: the owner classifies on the dashboard's Tagging page, and the next audit uses it.

**2. Apply: `arkona_retag_apply { "runId": "rtg_…", "pages": ["…"] }`**: deterministic corrections of that run only, at
most 25 pages. ONE proposal whatever your scope (each page an item the owner can leave out); never resubmit it. When the
owner approves, the job first checks the policy is still the audit's (otherwise it stops: "policy changed since the
audit; audit again"), then for each page reads it fresh: a page whose tags changed since the audit is **conflicted** and
skipped (never rebased), one whose facts changed is **held**, one already right is **already compliant**, one gone is
**inaccessible**; the rest are written and read back (the tags exactly; each page document's body by its version;
each board, map and timeline document by its content). Last Major Revision is never set.

**Reconciliation**, for a long run of batches: `arkona_retag_audit { "reconciliation": "First pass", "all": true }`
starts a named record (a first audit, free); `arkona_retag_apply { "reconciliation": "First pass" }` audits what remains
afresh and proposes its next batch. A page whose facts, Reference Type or template changed since its verdict is marked
stale and audited again: an earlier audit is never current truth.

### Arkona identity facts in bulk

`arkona_identity_reconcile` does a whole maintenance objective (a culture split's Naming Culture changes, a race
correction) as ONE job with one item per character: for each `{ character, facts }` it finds the identity page (the
Character Core, else the Compact Character Reference, else the identity-owning Character Reference; an [INDEX] goes to
its Core), reads it fresh, sets only the facts you give, recomputes the page's tags from the new facts under the approved
tagging policy (grammar order; Approved Supplementary Tags kept; the old value's own token replaced by the new one's),
and reads both back. Run it with `dryRun: true` first and show the person the preview.

- **Only the identity facts**: Race / Species, Naming Culture, Life State, Personal / Given Name, Family / Surname,
  Temporal Scope. A Canonical Display Name or name change is a rename (`USE_ARKONA_RENAME`: `arkona_rename`); Status,
  Continuity Type, Continuity and the other protected facts are refused with the tool that changes them.
- **Race and Naming Culture values must be in the pack's token maps.** An unmapped value refuses that item only
  (`UNMAPPED_VALUE`): ask the owner, who adds the token on the Packs page. Never choose a culture, race or nationality
  from a name. Each Naming Culture comes with `arkona_name_check`'s culture report.
- **Tags that would be a hold or an exception are not written**; the item is `partly_done` and says why (the facts are
  written). The owner settles it on the Tagging page.
- **Isolated**: a character changed since it was read (`FACTS_STALE`) is skipped, one whose write fails is `failed`, and
  the others carry on. Do not repeat the call: redo only the skipped ones after reading them again, or resume a failed
  job (`bridge_job_resume`).
- **The usual boundaries**: at scope `write`, 10 pages or fewer run directly; more becomes ONE proposal with one item
  per character (the owner approves some or all); at `propose` it is a proposal. Follow it with `{ "report":
"<reconcileId>" }`, free.

The result lists each item: `done` (facts and tags read back), `partly_done`, `skipped`, `failed`, `refused` or
`excluded`, with consistency follow-ups (another page restating the old value): bring those to the person.

### Arkona Reference Types

A **Reference Type** names the page's **role**, from a closed list per primary category (the vocabulary): "Polity
Reference", "Language & Naming Reference", "Race Core Reference", "Character Biography". Time goes in **Temporal Scope**,
geography in placement, detail in **Scope**: never in the Reference Type ("Historical Regional Polity Reference" is a
Polity Reference with its time and region elsewhere).

- **Use the vocabulary; never invent a type.** `arkona_reference_types` (read-only, free) lists every value in use, each
  with its count, pages, the suggested canonical value and its status (canonical, mapped, specialist, rejected, open).
  `status: "canonical"` and the categories show what to use.
- **The creation tools check it.** `arkona_create_owner`, `arkona_create_character` and `create_resource` refuse a
  Reference Type outside the published vocabulary (`REFERENCE_TYPE_NOT_IN_VOCABULARY`, naming the nearest canonical
  value) and accept an approved specialist type; while the vocabulary is a draft it is a warning.
- **The owner decides**: mapping a value, rejecting it or keeping it as a specialist type is the owner's, on the
  dashboard's Reference Types page. You report what you see; you never retype pages yourself (`set_facts` on Reference
  Type to "tidy" it is not yours to do). The audits' `reference_type_noncanonical` fix applies only the owner's mapping.

## Many pages at once: query_facts and workstreams

**`query_facts`** returns the same fields of many pages as ONE compact table (`columns` once, then `rows` as arrays;
`format: "csv"` too), free, from the bridge's stored sidebars. Select by `type` (Reference Type), `tag`, `under`, `kind`,
`lifecycle` or `name`; `characters: true` takes every current identity page of Main CANON (or of an AU with
`continuity`). Each row's `coverage` says whether its stored facts are `ok`, `stale` or `missing`: when it matters, re-read
those with `live: true` (one read a row; more than 10 shows an estimate first). Example: `{ "characters": true, "type":
"Character Core", "fields": ["canonicalDisplayName", "Race / Species", "Naming Culture", "Life State", "Temporal
Scope", "tags", "parent"] }`. Page with `nextCursor`.

**Workstreams.** Give every write of one objective the same `workstream` label (any write tool takes it), or set a
default for your connection once with `bridge_workstream { "set": "Menkheti culture split" }` (it lapses after 12 hours
unused). Every result echoes the label in force. `bridge_workstream_report { "workstream": "…" }` then reports, free:
what was written and verified (each page, its versions and who wrote it), what is accepted but not yet run, what was
deliberately left out (and why), what waits for the owner's judgement, and what still looks inconsistent, with a short
"still to do". Use it to tell the person where an objective stands; never invent what it does not list.

## Rename, move, delete and restore

- **Rename, tags, aliases, icon, banner, hidden, locked:** `update_resource` (a rename keeps the prefix and re-places
  the page; give the name without a prefix). It renames one page. To rename an Arkona character or owner everywhere it
  is named (its set, its facts, chronology, art, other pages' text), use `arkona_rename` ([Arkona
  renames](#arkona-renames)). On a project with a setting pack, `update_resource` (and `updateResource` through
  `lk_api_*`) **refuses** a rename that changes a subject's name (the part before " - ", or an index's whole name) of a
  page in a character's set, a page with a Subject fact or a pack owner: `USE_ARKONA_RENAME`, with a hint. Renaming
  only the descriptor (after " - ") is never refused. For a genuinely plain rename (a typo), pass
  `plainRename: { "reason": "…" }`; the reason is shown to the owner.
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
**The status tags are guarded too**: adding or removing `CANON`, `Working` or `Archived` (in any case or spelling), and
`AU` where the project's pack carries the AU ruling, with `update_resource`, a low-level tool or a create body is
refused, naming the lifecycle tool to use. The tools place the tags themselves: an AU page is promoted with `AU`, and
where the pack says so (Arkona) the lifecycle tag goes first (`Archived, Magic`). Other changes to
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
  reports such an event as an "event in a tie", never as an event without a row. While the age's table has a row whose
  date cannot be read (not marked table-only), it is refused too (`ORPHAN_NEAR_UNREADABLE`, naming the rows): tell the
  person; the owner marks the row table-only or fixes its date. `dryRun` shows the event and the three rows nearest it
  by date. The journal keeps the event.
- `sync_timeline_event { row: { date, description } | { row_id, age } }` repairs the timeline for ONE table row, the
  table being the authority: it creates the row's missing event, or corrects the paired event's minutes, `detail`, shape
  and `uri` to match the row. It never touches the table or the count and never renames an event; a row whose event
  already agrees answers `nothing_to_do`. `description` may be the row's opening words (at least 20 characters, the
  start of exactly one row of that date); no such row is `ROW_NOT_FOUND`. If several events could be the row's it
  refuses (`PAIRING_AMBIGUOUS`) naming each candidate's name, date and id: tell the person, then pass `event_id` to pair
  it with one (an event that already agrees is linked, with no LegendKeeper write: a proposal for the owner at every
  scope, since it changes what the check pairs; once approved the choice is remembered),
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

**Using it.** Put an image on a page with `write_page`: `![alt text](asset url)`, with the asset's exact `url` (only
this project's image assets: any other is refused with `IMAGE_URL_REFUSED`, after the bridge has read the project's asset
listing live, so an image uploaded in LegendKeeper a moment ago is accepted; it reads the listing at most once every five
minutes, and a refusal in between says when to try again). It can also go in an image block (an
`lk-block`), as a map pin's image, or as a map's image (`update_document`'s settings). `list_assets` and
`browse_asset_tree` show what the bridge knows of images it uploaded (`bridgeUpload`); they answer from the bridge's
asset tree, whose age they state: `browse_asset_tree` with `refresh: true` and a `folder` reads that folder live first. Deleting an
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
icons, the chronology, and the governance pages against the bridge) and keeps the findings. **`audit_findings`** (free: no request to LegendKeeper) reads them:
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
- **Governance findings** (`category: "governance"`, on a project whose pack governs it) compare the governance pages
  with the bridge: a tool name it does not have, or an old bridge call (`governance_unknown_tool`, with the bridge's
  equivalent where the pack knows one: the old write_lk with job_action guide is `get_bridge_guide`), an external skill name
  (`governance_external_name`), and a page, tab or standard named in a Startup, Related Guidance, Source Boundaries or
  Dependencies section that resolves to nothing, read generously (`governance_missing_reference`; a near miss names the
  closest match). They are the owner's: never
  edit a governance page to make one go away. Tell the person; the finding's `suggestedReplacement` is what the owner may
  copy into the page by hand.

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
- **A package or a rename that stops part-way** (a failed step, a cancel) keeps what it wrote, and `bridge_job_status`
  shows where it stopped (`stoppedAt`: its last verified step, the step it stopped at, why). A job **you** ran at scope
  `write` (one the owner did not approve) can be resumed with `bridge_job_resume { "jobId": "…" }`: its own check runs
  again first, no step that succeeded runs again, and a step that is no longer safe is refused with its reason. Work the
  owner approved is resumed by the owner only, and so is a job the owner cancelled (`CANCELLED_BY_OWNER`: the cancel
  stands; tell the person). Your safety rails are judged again on the steps left: if one now covers a step, the rest
  becomes one proposal for the owner (`proposal_captured`): follow it with `bridge_proposal_status`, never resume or
  redo it. Resume once, then follow the job; never loop on a refusal.
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

## At write scope

Your connection's scope is set by the owner. At scope `propose` every write is a proposal. At scope `write` ordinary
changes are **made at once**: page text, facts and links, chronology events, names, tags and aliases, new Working pages,
image placements. The owner **reviews them afterwards** on the bridge's Review page and can revert a job from its
journal, so write as carefully as you would for a proposal: read first, pass the version you read, change only what
was asked.

**Still a proposal at scope `write`:**

- protected canon and every lifecycle change ([Canon and approval](#canon-and-approval)), always;
- whatever the owner's **safety rails** on your profile keep for approval. By default: **deletes** (pages, documents,
  timeline events and lanes, map features, assets, calendars, sidebar and infobox properties, board shapes, and replacing
  a board's content or a calendar whole; through `lk_api_*`, also every block, row or list entry removed), **a job that
  touches more than 10 pages** (a copy with its children counts every page it copies, a restore every page it brings
  back), and **asset deletes and moves**; the owner can also keep renames and moves of pages. The result is
  `proposal_captured` with `proposedBecause`, for example `proposed because: bulk change (14 pages > 10)`;
- a chronology link you choose (`sync_timeline_event` with `event_id`), a restore that may bring back an Authoritative
  page (`restore_resource` of a page deleted with others), and **any rename of an Authoritative page**, even one that
  keeps `[BSRC]`: canonical or ordinary proposals at every scope;
- a setting pack's package (`arkona_create_character`, `arkona_create_owner`, `arkona_create_relationship`), unless the
  owner switched the tool to follow your scope;
- a rename with `arkona_rename`: always ONE canonical proposal (the bulk rail does not apply to it: the owner reads it
  item by item);
- `restore_snapshot`, always.

**Never route round a rail.** Do not split a bulk change into smaller jobs, rename instead of deleting, or reach the
same change through `lk_api_*`: tell the person the change is waiting for the owner, and follow it with
`bridge_proposal_status`. Never retry a write that returned `proposal_captured`.

The rails are judged when your request arrives; a job already accepted runs as accepted. The owner's emergency brake is
your scope: lowered, your queued jobs stop before their next write. A page is never moved under `templates`
(`TEMPLATES_DESTINATION`), whatever your scope.

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
