# LK-Bridge v2: Development Plan

**Status:** v1.0.2 is deployed at `https://lk.ottomoons.co.uk`, serving the test world. Claude and ChatGPT are connected, the propose → approve → execute loop works, and the hardening review is done.
**Goal of v2:** an agent-facing layer that lets Claude and ChatGPT work across the Arkona repository through simple, safe, Markdown-based tools. It is backed by the bridge's own model of the repository, so most questions cost no LegendKeeper requests at all.
**Source:** the "Bridge Requirements" Google Doc, our discussion on 8 and 9 November 2026, and the behaviour of the old bridge (`Airwolf1221/legendkeeper-bridge`, Linux 0.15.0).
**Plan date:** 9 November 2026

How claims are marked in this plan:

- **Decided:** the owner has agreed it.
- **Verified:** checked against LegendKeeper's API or the test world.
- **Proposal:** my recommendation, not yet agreed.
- **To verify:** must be tested on the test world before it is relied on.

---

## 1. Decisions already made

| Topic              | Decision                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setting name       | Arkona (formerly Baisheng)                                                                                                                                                                                                                             |
| Repository scope   | Only content under the **AI REPOSITORY** page. Everything else is completely ignored by the high-level tools.                                                                                                                                          |
| Page kinds         | `[INDEX]` = index, `[BSRC]` = article (Baisheng Source). Anything else under AI REPOSITORY is _unclassified_ and reported.                                                                                                                             |
| Projects           | Several projects, each with a unique name and key, plus a default project. Agent scopes are **global**, not per project. The test world becomes a registered project, which replaces the sandbox settings.                                             |
| Tree freshness     | No reliance on `updatedAt`, which LegendKeeper doesn't maintain properly. The tree updates after each of the bridge's own writes, and a **daily** consistency check catches everything else.                                                           |
| Taxonomy           | Seeded once from the race indexes. After that it belongs to the owner, who edits it on the dashboard. Each entry holds plural, singular, parent, aliases and asset folder.                                                                             |
| Markdown           | The owner's schema (section 6). Styling on edited blocks may be lost, because AI pages don't use styling.                                                                                                                                              |
| Low-level tools    | Hidden from agents by default once the high-level tools exist. Which ones stay visible is decided in a review at the end (phase E).                                                                                                                    |
| Test fixtures      | Sample pages from the test world may be committed to the private repo.                                                                                                                                                                                 |
| `update_document`  | Changes a document's own settings (name, hidden, full width, calendar, map image), never its content.                                                                                                                                                  |
| New facts          | Template facts follow the template's order. Any other new fact goes at the bottom.                                                                                                                                                                     |
| Dates              | Forms used: `Kumikas 1st, 1A 159` · `4A 881` · `Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102` · `Kumikas - Azaakh, 4A 180` · `Unknown, 4A 101` (stored as year-only) · a year range such as `4A 881 - 4A 900` · `Unknown` (**refused**).                |
| Chronology         | Each timeline event also gets a row in its age's table, in the right place, and the age's event count on the Main page goes up. One table per age page. Each event has a short **name** (for the timeline) and a full **description** (for the table). |
| Old bridge         | Every behaviour of the old bridge is kept (section 9).                                                                                                                                                                                                 |
| Links              | Relationship links (link collections such as Dependencies and Related Sources) are edited through `set_facts`, as optional `links`.                                                                                                                    |
| Images             | Three ways in: inline base64, a single-use binary upload endpoint, and a URL. Images are converted to WebP at quality 90, as the old bridge does.                                                                                                      |
| Backups            | Snapshots in the bridge, **including images**, with an encrypted off-server copy on **Google Drive** and restore tools. Retention: 8 weekly snapshots plus 30 days of change snapshots.                                                                |
| Character creation | Kept from the old bridge (Core / Compact / unknown race). Filling pages with content automatically ("automatic page work") is **later**, not v2.                                                                                                       |

---

## 2. Verified facts that shape the design

- **What a cheap tree pass returns:** `listResources` gives `id, name, parentId, rank, tags, aliases, documents, updatedAt`. The structure of a project the size of Arkona (about 3,500 resources) costs **about 35 reads**.
- **Where the catalogue fields live:** Scope, Index Scope and Reference Type are **sidebar properties**, so they need `getResource`: **1 read per resource** (about 3,500 for a full pass).
- **Placing pages costs nothing extra:** `createResource`, `createResourceFromTemplate` (with `parentId`, `after`, `before`, `name` and `id`) and `moveResource` all accept `after` or `before`, so alphabetical placement happens inside the same write.
- **Templates:** LegendKeeper does not record which template a page came from. The bridge works it out from **Reference Type** and records the template itself for pages it creates.
- **Search (verified by the phase 0 spike):** LegendKeeper's search returns one page (up to 100 results), with no operators and no hidden cap. But it is **ranked and incomplete**: for "the", 15 of the 62 pages with it in their name were missing from the top 100. Results at limit 50 are not the first 50 of limit 100, and a resource appears once per matching document. Tree-based search is the default; LegendKeeper's search is only an add-on for page text.
- **Nested batch creation (verified):** `createManyResources` accepts a parent created **in the same batch**. A, then B under A, then C under B works in one call.
- **Images (verified):** asset images download from `assets.legendkeeper.com` **without authentication**, through the bridge's existing address and port checks.
- **Timeline events (verified):**
  - each event stores `start` and `end` in minutes, `detail` (1 = year, 2 = month, 3 = day) and LegendKeeper's own `formattedStart`/`formattedEnd`;
  - a month range ends at the first minute of its end month;
  - `createEvent` also accepts `formattedStart`, which LegendKeeper parses loosely. The bridge sends exact minutes instead;
  - each age timeline has **one lane** ("Historical Events"), and every event's `uri` links to its age's **table page** (for example `lk://resources/h0gczxh7/docs/bt0bm3pc`).
- **The date engine is proven possible:** a prototype built only from the calendar definition reproduced LegendKeeper's formatted dates for **all 330 sampled events, start and end, with 0 mismatches**. KCY (the year count with no era resets) matches the tables. The spike's oracle file of the calendar and those events is kept as test data for D1.
- **The test world's tree (verified):**
  - 1,452 resources under AI REPOSITORY: 376 `[INDEX]`, 1,076 `[BSRC]`, **0 unclassified**, up to 9 levels deep;
  - outside the root are only the 14 templates;
  - sampled sibling order already follows the `[INDEX]` first, then `[BSRC]`, alphabetical rule;
  - every sampled `[BSRC]` sidebar has the same layout: `PROPERTIES` (key-value), `Dependencies` and `Related Sources` (link collections), and `TAGS` (unsupported).
- **Characters (verified):**
  - nine groups under `[INDEX] Characters`;
  - **both** layouts occur: `Beastkin / Foxians` (group, then race) and `Dwarves` (race directly under Characters, with characters beneath it);
  - Humans mixes character indexes, subraces (`High Humans`) and compact references directly beneath it;
  - exactly one `[INDEX] Undetermined / Unknown` exists.
- **Templates (verified):** 14, including `[INDEX] AI Index`, `[BSRC] AI Character Core`, `[BSRC] AI Compact Character Reference`, `[BSRC] AI Character Art`, `[BSRC] AI Relationship` and `[BSRC] AI General Source`.
- **Asset folders (verified):** `Characters / Group / Race / Character` (for example `Characters / Beastkin / Qishen / Mehrana al-Khalid`). LegendKeeper's asset listing returns one folder level at a time, so folders must be walked.
- **Maps:** the test world has **no maps** under AI REPOSITORY, so D2 creates its own test map.
- **The calendar (`Kumikan Epochal`, test world id `rp86pkdr`):**
  - 21 months in this order: Kumikas, Isar, Selaphos, Azah, Selyros, Sarias, Highsun, Surion, Azaakh, Malakh, Zahras, Camue, Pahan, Redfall, Meshaph, Kusha, Jehet, Attina, Umbaeos, Zarzakh, Frostmoot.
  - 716 days a year, 30-hour days, no leap days.
  - Eras: AA (before the epoch), 1A, then 2A to 5A, which restart their year numbering.
  - Formats: day `MMMM D^, E YYYY`, year `E YYYY`.
- **Ages start mid-year.** For example, 4A begins on **Azah 18th** (the era's first minute), so "Kumikas 1st, 4A 1" doesn't exist. The Fourth Age table's first row is Azah 18th, 4A 1.
- **KCY** is the continuous year count: for the Fourth Age, KCY = year + 1,250,307. It can be calculated from the calendar.
- **The chronology's layout:**
  - **Universal Chronology** has a Main page (an index table: Age | Event count | Complete dated table | Interactive timeline), then a "– Table" page and a "– Timeline" document for each age.
  - Table columns: **Historical Event | Date | KCY**.
  - Rows are sorted in calendar order, and year-only rows come after the dated rows of their year.
  - The table is the authority; the timeline events are secondary views.
- **Ids differ between projects** (a copied project gets new ids). Everything the bridge knows by id is configured and seeded **per project**.
- **Example sidebar (Asagiri Miyabi):** a key-value property `PROPERTIES` (facts), the link collections `Dependencies` and `Related Sources`, and `TAGS`, which the API can't represent (`unsupported`).

---

## 3. Architecture: the building blocks

```
Agent tools (Discover · Read · Pages · Resources · Documents · Facts · Maps · Timelines · Assets · api_read/api_write)
        │
        ▼
┌──────────────── Bridge services ────────────────────────────────────────────┐
│ Project registry ─ Name resolution ─ Ordering ─ Type registry and taxonomy   │
│ Repository tree ─ Asset tree ─ Markdown converter ─ Calendar engine          │
│ Chronology sync ─ Image pipeline ─ Snapshots, backup and restore ─ Audits    │
└──────────────────────────────────────────────────────────────────────────────┘
        │  (existing, unchanged in spirit)
        ▼
Policy gate and proposals → Job engine, writers and locks → Journal → Governor (one per project) → LegendKeeper
```

Every high-level write runs as a **job**, through the same guards as v1: policy, version checks, the unsupported-block guard, the journal and proposals. High-level tools never call LegendKeeper directly.

---

## 4. Component specifications

### 4.1 Project registry (multiple projects)

- **Projects:** each has a `name` (for example `arkona`, `test`), an API key, a project id (checked against the key at start-up), a role, and these settings:
  - the AI REPOSITORY root id;
  - the Characters root;
  - the chronology resource;
  - template ids.
    Keys live in the env file; everything else lives in the database and is edited on the dashboard. (OPS2, ADR 0028:
    keys now live in an encrypted store in the database too, and projects are added, re-keyed and removed on the
    dashboard; env keys are imported once.)
- **One governor per project.** Each project has its own key budget and per-project tier, and the dashboard shows each project's budgets.
- **The `project` argument.** Every tool takes an optional `project` (a name, or an id the bridge maps back). Every result names the project it used.
- **Decided: explicit project for writes** (`REQUIRE_PROJECT_FOR_WRITES=true`). A write with no `project` is refused when more than one project is registered, so a forgotten argument can't land in Arkona by accident. Reads may use the default project.
- **Data:** every stored row (jobs, journal, proposals, tree, assets, snapshots, mappings) carries a `project_id`, added by migration. Existing rows belong to the test world.
- **Sandbox:** the sandbox settings are retired. The sandbox and soak scripts target a registered project marked `sandbox: true`, and refuse any project not marked that way.

### 4.2 Repository tree

- **Each node holds:**
  - id, raw name, display name (prefix removed), kind (`index`, `bsrc` or `unclassified`);
  - parentId, rank, path (ids and display names), depth;
  - tags, aliases;
  - Scope / Index Scope, Reference Type, Canonical Display Name;
  - documents (id, name, type);
  - the recorded template (if the bridge created the page);
  - hidden and locked flags;
  - when it was last read, and how.
- **Root:** the project's AI REPOSITORY page. Only its descendants are included, and the high-level tools refuse anything outside it.
- **First build:** a background job lists every resource (about 35 reads), then reads each resource in the subtree (about 3,500 reads) at P3, so it never blocks agents. Expect roughly 30 to 60 minutes per large project.
- **Updates after the bridge's own writes:** after any successful write that can change what the tree holds (creates, moves, renames, tags, deletes, restores, fact changes), the bridge **re-reads that one resource** and updates the tree. It never guesses the result from the request. Page-text edits don't touch the tree.
- **Structural sweep (decided: hourly by default, can be switched off):** about 35 reads. It catches new pages, moves, renames, tag changes and deletions made in the app, without re-reading properties.
- **Daily consistency check:** a full pass at night at P3. It corrects the tree and records **what it corrected**, shown on the dashboard. It also feeds the audits (4.12) and the taxonomy drift report (4.3).
- **Estimated standing cost on Arkona:** hourly sweeps about 840 reads a day, the daily check about 3,550, snapshots about 500 a day averaged (4.11). Roughly **5,000 a day against 60,000** allowed.

### 4.3 Type registry and taxonomy

- **Index types:** for each type (for example `Character`, `Equipment`):
  - its singular and plural names;
  - its root index (`[INDEX] Characters`);
  - its index template;
  - its asset root folder (`Characters`);
  - its placement rules (for characters, the old bridge's rules in section 9).
- **The taxonomy:** for each category (for example races):
  - plural (the index's name, such as `Foxians`) and singular (`Foxian`);
  - parent (`Beastkin`) and aliases;
  - the source index id;
  - the asset folder name.
- **Seeding:** done once, from the tree plus the old bridge's `race-mappings.json` (Elf → Elves and so on). The bridge only **guesses** singular forms; the owner corrects them on the dashboard (an extension of chunk 6's Repository Mappings page).
- **Drift:** reported by the daily check, never fixed automatically:
  - an index with no entry;
  - an entry whose source has been renamed, moved or deleted;
  - an entry whose parent no longer matches the tree.
    An "add missing" action creates entries for new indexes without touching existing ones.
- **Facts are never rewritten by placement.** `race: "Human"` stays `Human` in the facts and places the page under `[INDEX] Humans`.

### 4.4 Name resolution

- **One shared resolver**, used by every tool that accepts "name or id":
  - ids are always accepted;
  - names match the display name, the raw name (with prefix), aliases or the Canonical Display Name;
  - the search can be scoped (within a type root, under an index, or by kind).
- **Exactly one match** is used. **Several matches** are refused, with the candidates and their paths. **No fuzzy matching.**
- **Prefixes:** a name passed with a stray `[INDEX]` or `[BSRC]` is cleaned up (the doc's "escapes … in case an agent decides to be funny").

### 4.5 Ordering

- **Siblings:** `[INDEX]` pages come first, then `[BSRC]` pages, then unclassified ones. Each group is alphabetical, comparing display names in a case-insensitive, locale-aware way.
- **Placement:** the bridge works out the right `after` or `before` neighbour from the tree and passes it in the create or move call, so ordering costs no extra writes. Renames are re-placed the same way.
- **Existing pages that are out of order are reported, not moved** (audits).

### 4.6 Asset tree

- **Building it:** walk every folder with `listAssets` (paged). Store folders and assets: id, name, folderId, type, size and SHA-256 once known.
- **Keeping it current:** updates after the bridge's own uploads and folder creation, a regular refresh (as the old bridge did: every 6 hours, paced and giving way to other work), and the daily check.
- **Placement:** follows the old bridge's rules (section 9), plus the type registry for other types (for example `Equipment / Sacred Blades`).

### 4.7 Markdown converter

**The owner's schema:**

| Markdown                                                                                                    | LegendKeeper                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `#`–`######`, paragraphs, `-` lists, `1.` lists, `>` quotes, fenced code, `---`, GFM tables                 | The matching blocks                                                                                                               |
| `- [ ]` / `- [x]`                                                                                           | Task list                                                                                                                         |
| `> [!info]`, `[!note]`, `[!success]`/`[!tip]`, `[!warning]`, `[!error]`/`[!caution]`                        | Callout                                                                                                                           |
| `> [!secret]`                                                                                               | Secret block                                                                                                                      |
| `> [!expand] Title`                                                                                         | Collapsible section                                                                                                               |
| `**b**`, `*i*`, `~~s~~`, `` `c` ``, `<u>`, `<sub>`, `<sup>`, `<span style="color:#…; background-color:#…">` | Text marks and colours                                                                                                            |
| `[[Name]]`, `[[Name\|label]]`, `[label](lk://resources/<id>)`, `[label](lk://resources/<id>/docs/<docId>)`  | Mention of a page, or of one document on it (the Main chronology table links to each age's table and timeline documents this way) |
| `![alt](asset-url)`                                                                                         | Image (same-project asset only)                                                                                                   |
| fenced `lk-block` + JSON                                                                                    | Any raw block                                                                                                                     |
| `<!-- lk:keep id="…" kind="…" --> … <!-- /lk:keep -->`                                                      | A block Markdown can't express, preserved exactly                                                                                 |

**Additions (decided):**

- **Line breaks:** written as `<br>`.
- **Inline icons:** become keep regions. There's no Markdown syntax for them in v2.
- **Tables:** tables with merged cells, or with lists or several paragraphs inside a cell, become keep regions.
  **Rules the converter must keep:**

1. **Round trip:** converting blocks to Markdown and back gives the original tree exactly. Block ids are kept for every block that didn't change.
2. **Writing back an unchanged page sends nothing.** The diff is empty, so no write is made.
3. **A missing keep region in replace mode is refused** (with the block ids listed), unless the call names those blocks to drop. Unsupported blocks also keep their existing guard.
4. **Mentions** are always rendered as `[label](lk://resources/<id>)`. `[[Name]]` on a write must resolve to exactly one page.
5. **Editor limits** (for example a list inside an expand inside a table cell) are checked **before** sending, with a clear error rather than LegendKeeper's `INVALID_CONTENT`.
6. **Sections** run from a heading to the next heading of the same or a higher level. They are addressed by heading path (`Biography > Early Life`), and a duplicate heading is refused with the options listed.
   **Reading maps, timelines and boards:**

- **Maps:** features listed with their type, name, position and link.
- **Timelines:** lanes, then events in calendar order, with formatted dates.
- **Boards:** shape text and connections.
  **Tests:** fuzz and property-based tests (punctuation, nested marks, escaping), a fixture corpus of real test-world pages, and a **server script** that round-trips **every page** in a project and reports any page that doesn't come back identical.

### 4.8 Calendar engine

- **Built from the project's LegendKeeper calendar definition:** months, lengths, leap days, eras and their numbering rules, and format templates. Nothing is hard-coded for Arkona.
- **Parsing:** the five decided forms (section 1), using the calendar's own month names and era abbreviations. It also accepts a **year range** (for example `4A 881 - 4A 900`), which appears once in the Fourth Age table. It refuses unknown months, dates outside an era (for example before Azah 18th in 4A 1), and impossible days. `Unknown, <year>` becomes a year-only event. `Unknown` alone is refused.
- **Output:** LegendKeeper's minute values for events, formatted text in the calendar's own format, and **KCY** (single or a range).
- **Two independent tests:**
  - every row of every age table in the test world (date ↔ KCY);
  - LegendKeeper's own formatted start text on real events.

### 4.9 Chronology sync

- **Per-project settings:** the chronology resource, plus the mapping from era to its table page and timeline document. These are found by naming convention ("<Era name> - Table" / "- Timeline") and confirmed by the owner.
- **`create_timeline_event`, as one job:**
  1. parse the date;
  2. pick the age;
  3. calculate the KCY;
  4. insert the table row in calendar order (ties go after existing rows with the same date; year-only rows after the dated rows of their year; ranges by their start);
  5. create the timeline event, with exact minutes and `detail`, in the age timeline's lane (each has one, "Historical Events"), and with its `uri` linking to the age's table page, as every existing event does;
  6. increase the Main page's event count for that age.
     The job is journalled and recoverable, and never applies anything twice.
- **Update and delete** keep the table, the timeline and the count in step.
- **The timeline-only tools** (lanes) touch only the timeline.
- **Audits** report table rows without an event, events without a row, rows out of order, and wrong KCY values.

### 4.10 Image pipeline

- **Three ways in:**
  1. **Inline `data_base64`**, up to the configured cap.
  2. **A single-use binary endpoint:** it lasts 5 minutes and is tied to one upload, one project, the file's SHA-256, its length and its type. The capability goes in a header, never a URL. The bridge supplies a ready-made script for agents with a sandbox or shell.
  3. **A URL source**, which goes through the existing address and port checks.
- **Processing:** WebP at quality 90, keeping dimensions, orientation and transparency; already-WebP files left byte for byte; display names without extensions; the stored bytes checked; and the same original sent again returns the existing asset.
- **Destination:** from the asset tree and the type registry, creating missing folders with the old bridge's rules (section 9).

### 4.11 Snapshots, backup and restore

- **Snapshots:** everything under AI REPOSITORY (resources, sidebars, all documents' content, maps, timelines, boards), plus **images**.
  - **Full content:** weekly, at night, at P3.
  - **Change snapshots:** after any write the bridge makes, of the page it changed.
  - **Storage:** each piece of content is stored once (by its hash), so unchanged pages and images take no extra space.
  - **Retention:** 8 weekly snapshots, plus 30 days of change snapshots.
- **Off-server copy:** a **separate** systemd timer runs **rclone with encryption** to **Google Drive**. It's independent of the bridge process. The encryption password goes in the env file, and you keep a copy somewhere other than the server.
- **Restore tools** (owner and agent, made as **proposals**): restore a page, a sidebar or a document to a chosen snapshot, or restore a deleted resource with its content.
- **Rehearsal:** restoring a whole project's snapshot into the **test** project, to prove the backups work.
- **Dashboard:** a snapshot list, sizes, the last off-server copy, and restore rehearsal results.

### 4.12 Audits

- **Kept from the old bridge:** rules by Reference Type, name prefix and ancestry; sidebar-structure checks; a tag-definition document; internal-reference checks.
- **New checks:** unclassified pages, ordering, taxonomy drift, chronology consistency, and keep-region health.
- **Findings only.** Proposed fixes are shown but never applied automatically.

### 4.13 Request coordination

- **Optional `operation_id` on every create.** A repeat returns the earlier result rather than duplicating.
- **Two requests for the same character at once** (exact name, case-insensitive) are recognised as duplicates.
- **Never replay failed work.** Look at its journal, then submit only what's left.

---

## 5. Tool surface (v2)

`access` R = read, W = write. Every tool takes `project`. Every W tool works under `propose` scope by producing a proposal, which the dashboard shows as a **Markdown diff**.

| Category  | Tool                                                                                                                                                                                                                                     | Access | Notes                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover  | `list_projects`                                                                                                                                                                                                                          | R      | Name, id, default flag                                                                                                                                              |
|           | `browse_repository_tree`                                                                                                                                                                                                                 | R      | Subtree by path or id, depth limit, kinds, with Scope / Reference Type / tags                                                                                       |
|           | `browse_asset_tree`                                                                                                                                                                                                                      | R      | Folders and assets                                                                                                                                                  |
|           | `search`                                                                                                                                                                                                                                 | R      | `AND`/`OR`/`NOT`, quoted phrases, `tag:`, `type:` (Reference Type), `kind:`, `under:`. Runs on the tree by default; `content: true` also uses LegendKeeper's search |
|           | `get_resource` / `get_resources`                                                                                                                                                                                                         | R      | By name or id. Unchanged data is served from the tree                                                                                                               |
|           | `list_tags`, `list_templates`, `list_calendars`, `list_assets`                                                                                                                                                                           | R      |                                                                                                                                                                     |
| Read      | `read_document`                                                                                                                                                                                                                          | R      | Markdown by default; `format: "json"`; `outline`; `section`                                                                                                         |
| Pages     | `write_page`                                                                                                                                                                                                                             | W      | `append`, `prepend`, `replace`, `replace_section`, `append_to_section`                                                                                              |
| Resources | `create_index`                                                                                                                                                                                                                           | W      | Type plus category, using the type registry and taxonomy, alphabetical placement                                                                                    |
|           | `create_resource`                                                                                                                                                                                                                        | W      | `[BSRC]`, required template, under an index                                                                                                                         |
|           | `create_bare_resource`                                                                                                                                                                                                                   | W      | No template                                                                                                                                                         |
|           | `create_many_resources`                                                                                                                                                                                                                  | W      | ≤100, nested with `key`/`parent_key`, in **one call** (verified: a parent created in the same batch works)                                                          |
|           | `create_character`                                                                                                                                                                                                                       | W      | `core` or `compact`, with the old bridge's rules (section 9)                                                                                                        |
|           | `update_resource`                                                                                                                                                                                                                        | W      | Name (keeps the prefix and re-places the page), tags add/remove, aliases, icon, banner, hidden, locked                                                              |
|           | `move_resource`                                                                                                                                                                                                                          | W      | Re-placed alphabetically                                                                                                                                            |
|           | `delete_resource`                                                                                                                                                                                                                        | W      | `confirm: true`, plus a separate `cascade: true` for children                                                                                                       |
|           | `restore_resource`                                                                                                                                                                                                                       | W      | Adds it back to the tree                                                                                                                                            |
| Documents | `create_document`                                                                                                                                                                                                                        | W      | Map, timeline or board                                                                                                                                              |
|           | `update_document`                                                                                                                                                                                                                        | W      | Settings only; blank documents and pages are refused (use `write_page`)                                                                                             |
|           | `delete_document`                                                                                                                                                                                                                        | W      |                                                                                                                                                                     |
| Facts     | `set_facts`                                                                                                                                                                                                                              | W      | `facts` (`null` removes; template order) plus optional `links` (add/remove per collection)                                                                          |
| Maps      | `create_map_feature`, `update_map_feature`, `delete_map_feature`                                                                                                                                                                         | W      | Pin, label, region, path or folder; lat/lng **or pixel** coordinates (converted using the map image bounds); link by name or id                                     |
| Timelines | `create_timeline_event`, `update_timeline_event`, `delete_timeline_event`                                                                                                                                                                | W      | The calendar engine and chronology sync                                                                                                                             |
|           | `create_timeline_lane`                                                                                                                                                                                                                   | W      |                                                                                                                                                                     |
| Assets    | `upload_image`                                                                                                                                                                                                                           | W      | Three ways in, the WebP pipeline, destination from the trees                                                                                                        |
| Restore   | `restore_snapshot`                                                                                                                                                                                                                       | W      | Page, sidebar or document                                                                                                                                           |
| Bridge    | `bridge_info`, `bridge_budget`, `bridge_estimate`, `bridge_job_status`, `bridge_job_wait`, `bridge_job_cancel`, `bridge_errors_recent`, `bridge_journal_lookup`, `bridge_proposal_status`, `bridge_proposals_mine`, `bridge_result_page` | R/W    | Kept from v1                                                                                                                                                        |
| Guides    | `get_markdown_guide`, `get_bridge_guide`                                                                                                                                                                                                 | R      | Also published as MCP resources, with a summary in the server instructions                                                                                          |
| Fallback  | `api_read`, `api_write`                                                                                                                                                                                                                  | R / W  | The doc's `api_request`, kept split so reads can be auto-approved                                                                                                   |
| Low-level | `lk_api_*`, `lk_op_*`                                                                                                                                                                                                                    |        | **Hidden by default** (a per-profile `showLowLevelTools` setting). Final list decided in phase E                                                                    |

**B2 notes (what built differs from the table):** the asset tools (`browse_asset_tree`, `list_assets`) cover the whole asset
library, which has no AI REPOSITORY root; `get_resource` shows a sidebar property's `version` only where LegendKeeper's
`getResource` gives one (it does not; `set_facts` reads the version itself); the final visible list stays E3's decision
([ADR 0029](adr/0029-discover-and-read-tools.md)).

**C1 notes (what built differs from the table):** `write_page` has no `allowUnsupportedLoss` (unsupported blocks are
always kept; the low-level tools remain for a deliberate deletion); a page holding content LegendKeeper's write schema
has no form for is refused as `PAGE_NOT_WRITABLE`; a page-write proposal whose version changes between the approval's
check and the write becomes `conflicted` ([ADR 0031](adr/0031-write-page.md)).

**C2a notes (what built differs from the table):** `set_facts` takes a value as plain text, or `{ "markdown": "…" }` for
inline Markdown (so text with an asterisk is never read as Markdown by accident); a key that occurs twice in the
property, or a link collection title that occurs twice, is refused rather than guessed; a link removal matches every
item of the page unless a document is named; the job holds the page's lock from its first step to its last (a
job-level lock), with the bridge's own check and verify steps; the If-Match token is the one `listPropertyRows` gives,
whatever `listProperties` carries ([ADR 0032](adr/0032-set-facts-and-canon.md)).

**C2b notes (what built differs from the table):** a rename re-places the page with a `moveResource` in the same job,
not the same write (`updateResource` takes no place); `create_resource` refuses a character type's Core or Compact
template (use `create_character`) and an Index template (use `create_index`); `create_many_resources` sends pages
without a template in `createManyResources` calls and each page from a template as its own write (`createManyResources`
takes no template), parents first; facts on a page the same job creates are bound to the copy's ids inside the job (a
`copy` check, `bindIds`); `restore_resource` takes the deleted page's id; `update_document` refuses page and blank
documents; `delete_document` refuses a page's last document and its only page document; deleting an Authoritative page
is a `delete` canon rule; the character page names default to `{name} - Character Core` and
`{name} - Character Reference` ([ADR 0034](adr/0034-resources-documents-characters.md)).

**C2c notes (decided by the owner on 10 November 2026; built in C2c, [ADR 0035](adr/0035-page-lifecycle.md)):** three
lifecycle states, each a prefix, a Status, a status tag and a place; new pages Working by default (a change from C2b);
four lifecycle tools, always canonical; every other route to a lifecycle change refused by an engine guard; a permanent
lifecycle record that `unarchive_page` and `promote_page` read; related pages from a link index refreshed by a paced
`link-sweep` maintenance job; two recommended, switchable canon rules (deleting a `[BARC]` page; deleting a map,
timeline or board of an Authoritative page). An index has no lifecycle state and gets no Status any more; the
`agentDefaultStatus` setting is superseded by the lifecycle settings.

**Note for ChatGPT:** after the tools change, open ChatGPT's **Plugins** page, open the bridge, and use **Refresh**. ChatGPT keeps its own copy of the tool list.

---

## 6. Phases and sessions

```
Phase 0 ── spike (verify assumptions on the test world)
Phase A ── A1 multi-project ──► A2 repository tree ──► A3 registry, resolution, ordering
                                        └───────────► A4 asset tree
Phase B ── B1 Markdown converter (library; starts alongside A1) ──► B2 Discover and Read tools (after A3)
Phase C ── C1 write_page ──► C2a facts, links and canon ──► C2b resources, documents, characters ──► C2c page lifecycle ──► CR mid-point review
Phase D ── D1 calendar and chronology   D2 maps   D3 image pipeline   (in parallel, after CR)
Phase E ── E1 snapshots, backup and restore ─► E2 audits ─► E3 tool review and guides ─► E4 independent hardening ─► E5 Arkona go-live
```

| #      | Session                                                                                                                                                                                                                                                                                                                                                                  | Model · effort       | Depends on              | Why this level                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **0**  | **Spike:** a server script that checks on the test world: whether a `createMany` parent created in the same batch works; LegendKeeper's search cap; whether assets can be downloaded (for backups); formatted start text on events; whether pixel and lat/lng map coordinates match the map bounds; and a dump of one age table's blocks and the Main page's index table | Sonnet 5.5 · medium  | —                       | Small and exploratory; its results settle the "to verify" items                                                                            |
| **A1** | **Multiple projects:** registry, a governor per project, the `project` argument on all tools, `project_id` migrations, dashboard project switcher, sandbox retirement, the explicit-project rule for writes                                                                                                                                                              | **Opus 5.5 · xhigh** | 0                       | Touches every layer and every table; a mistake here mixes up projects (raised to xhigh on Max)                                             |
| **A2** | **Repository tree:** build, updates after writes, hourly sweep, daily check and its report, dashboard page                                                                                                                                                                                                                                                               | Opus 5.5 · high      | A1                      | The foundation every tool trusts; correctness under concurrent writes matters                                                              |
| **A3** | **Type registry, taxonomy seeding, name resolution and ordering**, extending the Repository Mappings page                                                                                                                                                                                                                                                                | Opus 5.5 · high      | A2                      | Every write tool trusts its name resolution and placement; it must also grow into recipes (raised to Opus on Max)                          |
| **A4** | **Asset tree:** inventory, refresh, placement rules                                                                                                                                                                                                                                                                                                                      | Sonnet 5.5 · medium  | A2 (alongside A3)       | A smaller version of A2                                                                                                                    |
| **B1** | **Markdown converter library:** both directions, keep regions, block matching, sections, editor-limit checks, fuzz tests, real-page fixtures, round-trip server script                                                                                                                                                                                                   | **Opus 5.5 · xhigh** | — (starts alongside A1) | The riskiest piece for your data; exact round trips are hard                                                                               |
| **B2** | **Discover and Read tools,** guides, hiding low-level tools by default                                                                                                                                                                                                                                                                                                   | Sonnet 5.5 · high    | A3, A4, B1              | Mostly assembly on top of the services                                                                                                     |
| **C1** | **`write_page`:** modes, sections, keep-region refusals, version conflicts with retry when the section is unchanged, Markdown-diff proposals                                                                                                                                                                                                                             | **Opus 5.5 · xhigh** | B2                      | The main way agents will change your pages                                                                                                 |
| **C2a** | **`set_facts` and the protected canonical facts,** plus the proposal and job groundwork for multi-page operations: high-level operation lists, ids minted at capture, the page-level summary, the generic verify step (ADR 0032)                                                                                                                                         | **Opus 5.5 · xhigh** | C1                      | The first multi-write tool, and the guard that keeps canon in the owner's hands on every write path                                        |
| **C2b** | **Resource, document and character tools,** including `operation_id` and duplicate detection, built on C2a's groundwork and calling its canonical guard. **Built (10 November 2026, ADR 0034, migration 1500):** the twelve tools; one job or one proposal each, ids minted at capture, the page-level summary first; placement in the same write; Status `Working`; the template recorded in the tree at once; every write verified (pages by their parent's listing); `operation_id` and `DUPLICATE_REQUEST`; failed work reported, never replayed; deleting Authoritative pages as protected canon; `factsVersion` and `baseFactsVersion`; mentions of a character's pages to its Core, Reference, then index | **Opus 5.5 · xhigh** | C2a                     | Many writes with placement, taxonomy and guards; multi-page proposals with ids minted at capture                                           |
| **C2c** | **The page lifecycle** (added and decided by the owner on 10 November 2026): Authoritative `[BSRC]`, Working `[BWRK]` and Archived `[BARC]` pages; `status` on the creation tools (Working by default); `archive_page`, `unarchive_page`, `move_to_working` and `promote_page`, always with the owner's canonical approval; the lifecycle guard on every write path; the lifecycle record; related pages from a link index and its paced sweep. **Built (10 November 2026, ADR 0035, migration 1600)** | **Opus 5.5 · xhigh** | C2b | Moves canon in and out of the owner's hands; every side route must be closed |
| **CR** | **Mid-point independent review of the write layer** (C1, C2a, C2b and C2c): a fresh session that trusts no earlier report, reviews `write_page`, the proposal path, the version checks inside the lock, protected facts, the lifecycle guard and tools, and the verify step, then fixes what it finds, before phase D builds on them | **Opus 5.5 · xhigh** | C2b, C2c                | The write layer is where data could be lost; catching problems before D, E and the setting packs build on it is far cheaper (added on Max) |
| **D1** | **Calendar engine and chronology sync,** plus the timeline tools                                                                                                                                                                                                                                                                                                         | Opus 5.5 · high      | C2b                     | Date arithmetic, plus a three-part write that must stay consistent                                                                         |
| **D2** | **Map tools,** including pixel coordinates                                                                                                                                                                                                                                                                                                                               | Sonnet 5.5 · medium  | C2b                     | Straightforward                                                                                                                            |
| **D3** | **Image pipeline:** three ways in, the single-use endpoint, WebP, destinations                                                                                                                                                                                                                                                                                           | Opus 5.5 · high      | C2b, A4                 | A new public endpoint that must be secure                                                                                                  |
| **E1** | **Snapshots, Google Drive copy with rclone, restore tools, rehearsal**. The Google Drive connection is made **through the dashboard** (Google's sign-in flow), with its token kept in the encrypted secret store (OPS2, ADR 0028), rather than by configuring rclone by hand | Opus 5.5 · high      | C2b, D3                 | Backups only matter if restores are right (raised to Opus on Max)                                                                          |
| **E2** | **Audits:** rules, the new checks, findings view. **Added by C2b (10 November 2026):** a check for paragraphs with embedded line breaks (32 on the test world, kept as keep regions, ADR 0031 decision 12) and one for pages holding inline icons (which `write_page` cannot write back). **Added by C2c (10 November 2026):** a **lifecycle-consistency audit**: every page's prefix, Status, status tag and location agree (`[BSRC]` / Authoritative / CANON / normal place; `[BWRK]` / Working / Working / directly under `[INDEX] Working`; `[BARC]` / Archived / Archived / directly under `[INDEX] Archived`), and an incomplete lifecycle record is reported; it reports and never fixes (the lifecycle tools refuse an inconsistent page with `LIFECYCLE_INCONSISTENT`, and legacy pages such as a `[BSRC]` page with Status Working have no tool path until the owner makes them agree) | Sonnet 5.5 · medium  | A3, D1                  | Read-only, rule-driven                                                                                                                     |
| **E3** | **Tool review (with you):** final visible tool list, descriptions, both guides, the server instructions, a check that ChatGPT and Claude each pick the right tool                                                                                                                                                                                                        | Sonnet 5.5 · high    | All of the above        | Mostly wording and judgement; you take part                                                                                                |
| **E4** | **Independent hardening review:** a fresh session that trusts no earlier report. **Added by C2b (10 November 2026):** a block-by-block fallback for `write_page` on pages holding content the API cannot write back, such as inline icons (`PAGE_NOT_WRITABLE` today). Tested on 10 November: `insertBlock`, `replaceBlock` and `deleteBlock` work beside an icon paragraph; `deleteBlock` returns no new version; the fallback is not atomic, so it needs journal-based undo | **Opus 5.5 · xhigh** | E3                      | Same reasoning as v1's chunk 8                                                                                                             |
| **E5** | **Moving to Arkona:** a runbook and a Claude Code session on the server (section 7)                                                                                                                                                                                                                                                                                      | Sonnet 5.5 · medium  | E4                      | Operational                                                                                                                                |
| **HF-0033** | **Hotfix: removing connections, replace on reconnect, consent clarity, dates, operation discovery** (10 November 2026; operations, outside the phases): revoked and expired connections removed from the dashboard (tombstones keep history readable; automatic removal after 30 days by default; stale badge and "Revoke stale"); the consent page offers to replace the application's existing connections (revoked only when the new code is exchanged), shows the new-profile fields only for "New profile…", and keeps the chosen profile's scope (`keep`); dates carry the year; `UNKNOWN_OPERATION` suggests close operations and the bridge guide gains a generated Operations section; tool-list caching documented; conflicted proposals can be rejected. Migration 1400. ADR 0033. **For E3:** with the low-level tools hidden (B2, ADR 0029) callers lost operation discovery (`lk_api_list_operations`, `lk_api_describe_operation`); this hotfix covers it through the guide and the error hints, but E3 still makes the final visibility decision | (hotfix session) | B2, C1 | Touches credentials (deletion with tombstones) and the consent page (revoking other grants at token issue) |
| **OPS1** | **Env file sync and deploy self-check** (operations, outside the phases): `env-sync.sh` keeps `/etc/lk-bridge/lk-bridge.env` in step with markers in `deploy/env.template` (adds defaults, generates secrets, placeholders and ACTION NEEDED for owner-only secrets, comments out removed settings, never changes or prints a value), migrates the single-project form with `--migrate-projects`, and checks every edit with `npm run config:check` (restoring the backup on failure); `deploy.sh` checks the env file and its own installed copies against the release first (`--sync-env`, `--update-self`). ADR 0024 | (operations session) | A1 | Runs as root next to every secret; a mistake could leak or lose a key or stop the bridge |
| **OPS2** | **Projects, keys and the owner's sign-in on the dashboard** (operations, outside the phases): an encrypted secret store in the database (AES-256-GCM under `SECRETS_MASTER_KEY`, generated by env-sync; the project and purpose as associated data; a missing or wrong key affects only its secrets), projects added (key checked with LegendKeeper first), re-keyed (same project only, atomic) and removed (archived, after pause and drain) at runtime without a restart, env keys and the owner's credentials imported once with the stored value winning, re-authentication for sensitive actions, the password and the authenticator app (QR drawn locally, recovery codes) on the dashboard, `env-sync.sh --retire-imported-keys` and `--rotate-master-key`. ADR 0028 | (operations session) | A1, OPS1 | Handles secrets over the web: a mistake could leak or lose a key, or lock the owner out |

**Parallel sessions:** A1 and B1; A3 and A4; D1, D2 and D3. Each pair or group has its own branch and a clear split of which files it owns, as in v1. **Ground rules carried over from v1:** never force-push; merge `main` in rather than rebasing; squash merge; I write each handoff when its turn comes, from the previous session's report.

**Rough effort:** 20 sessions, 13 of them on Opus (8 at xhigh), sized for the Max plan: the sessions that protect your data (A1, B1, C1, C2a, C2b, C2c, the mid-point review and E4) get the most depth. That's a few weeks of steady work at your pace; there's no deadline. The four parallel groups (A1 with B1, A3 with A4, D1 with D2 and D3) are where Max's extra quota saves the most time.

---

## 7. Moving to Arkona (E5)

1. Register `arkona` with its own key and **read-only** settings.
2. Build its tree and asset tree, and review the daily check's first report (unclassified pages, ordering, taxonomy drift).
3. Seed and review its taxonomy and type registry on the dashboard.
4. Run the Markdown **round-trip script on every Arkona page** (read-only). Any page that doesn't come back identical blocks the move until it's fixed.
5. Run the date engine against **every Arkona age table**.
6. Take the first full snapshot and the first Google Drive copy, and do a restore rehearsal into `test`.
7. Move ChatGPT's work from the old bridge to this one, and **retire the old bridge and revoke its key**. Anything that edits Arkona outside this bridge is only picked up by the daily check.
8. Lift read-only on Arkona with `WRITERS_MAX=1`, and agents at `propose`, for the first weeks.
9. Raise scopes when you're confident.

---

## 8. Settled items (decided 9 November 2026)

| #   | Item                                    | Decision                                                                                                                                 |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Require an explicit `project` on writes | **Yes.** `REQUIRE_PROJECT_FOR_WRITES=true` by default; a write with no `project` is refused when more than one project is registered     |
| 2   | Hourly structural sweep                 | **On** by default (about 840 reads a day on Arkona), and it can be switched off                                                          |
| 3   | Syntax for inline icons                 | **None for now.** Inline icons are preserved in keep regions                                                                             |
| 4   | The Drive backup's encryption password  | Set up in **E1** and kept somewhere other than the server (for example a password manager). Without it, the Drive copy can't be restored |

---

## 9. Old-bridge behaviours carried into v2 (checklist for C2a, C2b, D3 and E2)

- **Character Core:** `[INDEX] <Character>` from the Index template under the race index, then the Core template beneath it. An existing unique index is reused, and an existing core is returned rather than duplicated.
- **Compact Character Reference:** created directly under the race index, with no index of its own.
- **Reference Type** is set to exactly `Character Core` or `Compact Character Reference`.
- **The race search** looks only at the Characters root's children and grandchildren (`Characters / Group / Race`). There may be one `[INDEX] <Character>` between the race and the core.
- **Unknown or omitted race** (`null`, blank, `Unknown`, `Undetermined`, `Unestablished`, `Undetermined / Unknown`) goes to `[INDEX] Undetermined / Unknown` directly under Characters, with Race / Species set to `Unestablished`.
- **A declared race that doesn't resolve fails.** It never falls back silently.
- **Never automatic:** classification indexes are never created, existing pages are never moved or reclassified, and tags are never inferred.
- **The species value is kept as given**, even though placement uses the index label.
- **Asset folders:**
  - an existing folder named after the character is reused wherever it is;
  - otherwise the path is `Characters/Group/Race/Character` (or `Characters/Race/Character`), plus literal subfolders passed as a list;
  - `Undetermined / Unknown` is used for unknown races;
  - folders are never moved, and a non-folder with the same name is a conflict.
- **Images:** WebP at quality 90, keeping dimensions, orientation and transparency; display names without extensions; the stored bytes checked; uploads deduplicated by the original's hash.
- **Link collections:** edits keep the collection type, each item's id and order, the filter, and any items the filter adds.
- **Duplicate requests** for the same character are recognised. Failed work is never replayed.
- **Audits** produce findings only, never automatic repairs.
- **Inventory refresh** is paced and gives way to agents' work.

---

## 10. Design constraints for future setting packs (not v2 scope)

**Why this section exists:** after v2, the plan is a **setting-aware layer** above the general bridge. For Arkona that means tools such as `arkona_create_character`, `arkona_create_outfit`, `arkona_create_species`, `arkona_create_institution`, `arkona_create_magic_tradition` and `arkona_create_nation`. Each takes a whole package (a name, a race, several Markdown owners, art) and builds the complete set of linked pages, through preview, then execute, then verify. Nothing in this section is built in v2. These are constraints on **how** v2 is built, so the setting packs can sit on top of it without rework. The source is the "Further Goals" tab of the Bridge Requirements doc.

### 10.1 The two layers

- **The general bridge** (v1 and v2) handles everything technical: reading, writing, resources, templates, hierarchy, assets, references, version checks, recovery and verification.
- **A setting pack** holds one setting's rules: its taxonomy, page types, owner rules, required facts, canonical rules, naming and templates.
  - A pack is attached to one or more projects (Arkona and the test world share the Arkona pack).
  - Its rules are **data** where possible (recipes and rules on the dashboard), with small code hooks only where data can't express a rule.
  - Pack tools carry the pack's prefix (for example `arkona_`).
  - Another setting gets its own pack without changes to the general bridge.

### 10.2 Constraints on v2 sessions

| Session                                                       | Constraint                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A3** (type registry and taxonomy)                           | Store the registry so it can grow into **recipes**: page types with their template, required facts, default facts and child pages. It should be keyed by project, and able to belong to a pack later. Don't hard-code Arkona's types in code.                                                                                                          |
| **C1** (`write_page`) and **C2** (resources, facts and links) | A proposal must be able to store **high-level operations** (for example "write this Markdown to this page section", "create this resource from this template under this index", "set these facts and links"). Not only raw API calls. Proposals keep both the high-level operation (for display and later re-validation) and its expansion into steps. |
| **C2**                                                        | Proposals that create several linked pages use **ids minted at proposal time**, so a child "under" a new index and links "to" a new page are fixed in the proposal. The diff can then show the final structure.                                                                                                                                        |
| **C2**                                                        | Add a **page-level summary** of each proposal (for example "Character Core: Create · Biography: Create · Racial index: navigation updated"), alongside the existing per-operation diff. The dashboard groups operations by the page they affect.                                                                                                       |
| **C2**                                                        | Add an optional **verify** step to multi-page jobs. After execution, re-read what was created or changed and compare it with the plan. Record any difference on the job (and, for proposals, on the proposal).                                                                                                                                         |
| **D3** (images)                                               | Uploads can go to a **staging area**: the image is uploaded and verified, but not yet placed in its final folder. A later package or proposal can then **refer to staged uploads by id**, and they're placed on approval. Image bytes never travel inside a package.                                                                                   |

### 10.3 Protected canonical facts (a guard; built in C2a)

Arkona records each page's standing in its sidebar facts:

- `Status` is the page's working state (for example `Authoritative`, `Working`, `Archived`).
- `Continuity Type` is `CANON` (with `Continuity` = `Main`) or `AU` (with `Continuity` = the name of that alternate universe).
  **The rule (decided in principle):** an agent can never make something canonical on its own authority. Setting `Continuity Type` to `CANON`, `Continuity` to `Main`, or `Status` to `Authoritative`, through any tool, always needs the owner's **explicit canonical approval**. That's a separate choice on a proposal ("accept as canon"), distinct from approving the write itself. Without it, the bridge refuses those values, or turns the write into a proposal even at `write` scope.

- The protected facts and values are **configuration** (per project, later per pack), not hard-coded.
- The rule covers `set_facts`, template defaults copied into new pages, and every future pack tool.
- **Candidate for C2:** C2 builds `set_facts`, so the guard can be built there in its general form ("protected fact values"). That protects canon from v2 onwards, before any setting pack exists. The owner confirms when C2's handoff is written.

**The rule as refined by the owner (decided 10 November 2026; built in C2a, [ADR 0032](adr/0032-set-facts-and-canon.md)):**

- **`Status` = `Authoritative`** is protected in **both** directions: setting a page's Status TO Authoritative, or
  changing it FROM Authoritative to anything else (removing it too), needs canonical approval.
- **`Continuity Type` and `Continuity`:** CHANGING an existing non-empty value needs canonical approval (for example
  CANON ↔ AU, or one AU to another). Setting them where they are empty, new pages included, is allowed.
- The default Status of pages agents create is **`Working`** (since C2c by the page lifecycle: new pages are `[BWRK]`
  under `[INDEX] Working` unless created as `status: "authoritative"`, ADR 0035). **Templates carry no fact defaults**
  (the owner confirmed), so nothing is inherited.
- The rules are a list per project (dashboard, audited), seeded with these defaults.
- **Every write path** is guarded, not only `set_facts`: the low-level `lk_api_write`, `lk_api_batch` and every
  `lk_op_*` for the property and property-row operations, a template copy, and C2b's tools (the guard is in the job
  engine, with `assessFactChange` as the shared function). A protected change becomes a proposal flagged
  `requiresCanonicalApproval` whatever the caller's scope (`write` or `propose`), with the reason in the agent's
  result; a `read` caller is refused as before.
- The only approval of such a proposal is **"Approve and accept as canon"**, a separate audited action that records
  `canonicalApprovedBy`; the ordinary Approve is disabled for it; Reject works as normal. At execution the guard checks
  again: an expansion carrying a protected change without canonical approval is refused and nothing is written.
- **Deleting** (decided by the owner on 10 November 2026; built in C2b, [ADR 0034](adr/0034-resources-documents-characters.md)):
  deleting a page whose Status is `Authoritative` needs canonical approval; with a cascade, if any page of the subtree
  is. It is a per-project canon rule (kind `delete`), on every path, and at `write` scope it becomes a canonical
  proposal listing the protected pages. **Restoring** needs none: it brings back what was approved, and is how a
  mistaken delete is undone.
- Deleting a map, timeline or board of an Authoritative page, and deleting an Archived `[BARC]` page, need canonical
  approval since C2c (two recommended rules, on by default, which the owner can switch off per project; flagged by C2b,
  settled in C2c, ADR 0035).
- **Lifecycle changes** (C2c, ADR 0035): Status to or from Working or Archived, a `[BWRK]` / `[BARC]` prefix change, and
  a move into, out of or between the lifecycle indexes happen only through `archive_page`, `unarchive_page`,
  `move_to_working` and `promote_page` (always the owner's canonical approval) and the creation tools' `status`; the
  lifecycle guard refuses every other route, naming the tool.

### 10.4 Owner planning is explicit

Which pages a package creates ("intelligent owner planning") follows **rules the owner sets**, never the agent's or the bridge's own inference. Examples:

- a minor character becomes one Compact Character Reference with no index;
- a developed character gets an index, a Core page and only the specialist pages that have content.
  The rules are applied the same way every time and shown in the preview. An agent may request a specific structure, but it's checked against the rules. Existing characters are detected first (name resolution), so a package **extends** an existing set of pages rather than duplicating it.

### 10.5 Later, after the first setting tools

- **Selective approval:** approve parts of a package and reject others. The bridge removes what depends on the rejected parts (for example links to a rejected page) and produces a revised diff for approval.
- **Continuing a part-built package** after an interruption, without duplicate creations. The v1 job engine's ids and recovery already provide the basis.

### 10.6 Concurrency: don't rely on LegendKeeper's version check alone (applies to v2)

**From real testing (reported via ChatGPT, 9 November 2026):** LegendKeeper can accept **overlapping** writes that carry the same expected version. Its `If-Match` check works for writes that happen one after another, but it is **not a guaranteed atomic compare-and-swap**. Consequences for v2:

- **The bridge's own per-document and per-resource locks stay mandatory** (they already exist: chunk 2). Two writes from the bridge to the same target never overlap.
- **The bridge checks versions itself (C1, C2).** Inside the lock, just before a versioned write, the bridge re-reads the current version and compares it with the expected one. A mismatch is a conflict, whatever LegendKeeper would do. The high-level tools usually read anyway, so the cost is rarely an extra request.
- **One bridge process per project** is a rule, recorded in an ADR by A1. The locks are in-process. Running two bridge processes against the same project would bypass them, so that would need database-held locks first.
- **The verify step (10.2) reads back writes** and compares them with the plan. That catches a write lost to an overlapping outside edit (the LegendKeeper app, another tool) straight away. The journal's previous state then allows recovery.
- **E4 adds a concurrency acceptance test:**
  1. many simultaneous bridge writes to the same page, which must be fully serialised, with nothing lost and every conflict reported;
  2. simultaneous same-version writes sent straight to LegendKeeper on the test world, to record its real behaviour;
  3. an outside write landing between the bridge's read and its write, which the verify step must catch.
