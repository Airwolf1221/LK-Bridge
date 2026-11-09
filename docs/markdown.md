# Writing LegendKeeper pages in Markdown

This guide is for agents (Claude, ChatGPT) that read and write LegendKeeper pages through the bridge. You read a page as
Markdown, change the Markdown, and send it back; the bridge turns it into LegendKeeper blocks. It is exact: anything you
did not change comes back exactly as it was, and anything Markdown cannot show is protected in a **keep region**.

Three rules matter more than the rest:

1. **Change only what you mean to change.** Text you leave alone is matched to the page and kept as it is, styling and
   all. Writing back an unchanged page sends nothing.
2. **Never remove or edit a keep region** (`<!-- lk:keep … -->` … `<!-- /lk:keep -->`) unless you mean to delete that
   block. Leave it where it is, or move it whole.
3. **Write each image on a line of its own**, using an image asset URL of this project.

## What you can write

| Write                                                                                      | You get in LegendKeeper                                     |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `#` to `######` and a space                                                                | A heading, levels 1 to 6                                    |
| A line of text                                                                             | A paragraph                                                 |
| `<p></p>` on a line of its own                                                             | An empty paragraph (a blank line in the page)               |
| `<br>`                                                                                     | A line break inside a paragraph, heading, cell or list item |
| `- item` (or `*`, `+`)                                                                     | A bulleted list                                             |
| `1. item`, `3. item`                                                                       | A numbered list (it starts at the first number)             |
| `- [ ] task`, `- [x] done`                                                                 | A task list                                                 |
| `> text`                                                                                   | A quote                                                     |
| `> [!info]`, `[!note]`, `[!success]` or `[!tip]`, `[!warning]`, `[!error]` or `[!caution]` | A callout of that kind                                      |
| `> [!secret]`                                                                              | A secret block (hidden from players)                        |
| `> [!expand] Title`                                                                        | A collapsible section with that title                       |
| ` ```lang ` … ` ``` `                                                                      | A code block, with its language                             |
| `---`                                                                                      | A horizontal rule                                           |
| A GFM table                                                                                | A table (the first row is the header row)                   |
| `![alt text](https://…asset url…)`                                                         | An image                                                    |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``                                         | Text marks                                                  |
| `<u>underline</u>`, `<sub>sub</sub>`, `<sup>sup</sup>`                                     | Text marks                                                  |
| `[text](https://example.com)`                                                              | A link                                                      |
| `[[Page name]]`, `[[Page name\|label]]`                                                    | A mention of a page, found by name                          |
| `[label](lk://resources/<id>)`                                                             | A mention of a page, by id                                  |
| `[label](lk://resources/<id>/docs/<documentId>)`                                           | A mention of one document of a page                         |
| A fenced `lk-block` holding JSON                                                           | Any block, given exactly (see below)                        |

When you read a page, you get exactly this Markdown, so copying what you read is always safe.

### Headings and paragraphs

```markdown
# Asagiri Miyabi

**Asagiri Miyabi** is a Qishen shrine maiden of the [Foxians](lk://resources/x9fox001).

<p></p>

She was born on _Kumikas 1st, 4A 881_.<br>Her sister is [[Asagiri Kaede]].
```

Each paragraph is one line. A line break you type inside a paragraph becomes a space; write `<br>` for a real line
break. Leave a blank line between blocks.

### Lists and tasks

```markdown
- Became head maiden in 4A 900.
- Travelled to:
  1. Ashgate
  2. the Hollow Court

7. Numbered lists start at their first number.
8. Like this one.

- [x] Read the temple archives
- [ ] Check the KCY of every row
```

A list item starts with a line of text; it may then hold nested lists (indent them under the item's text). A task is one
line of text: it cannot hold a nested list.

### Quotes, callouts, secrets and expand blocks

```markdown
> A plain quote.

> [!warning]
> Never enter a shrine after dusk.

> [!secret]
> The elder knows the truth about the Long Winter.

> [!expand] The full genealogy
> Everything inside the quote is inside the expand block.
>
> - Lists and other blocks too.
```

The marker (`[!warning]`, `[!expand] Title`…) must be the first thing in the quote. `[!tip]` is the same as
`[!success]`, and `[!caution]` the same as `[!error]`. An expand block's title is plain text.

### Tables

```markdown
| Historical Event                           | Date                                        | KCY             |
| ------------------------------------------ | ------------------------------------------- | --------------- |
| Fall of Ashgate                            | 4A 139                                      | 1250446         |
| [The Long Winter](lk://resources/h0gczxh7) | Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102 | 1250407-1250409 |
```

Each cell holds one line of text (marks, links, mentions and `<br>` are fine). Write a `|` inside a cell as `\|`,
including in `[[Page\|label]]`: a row with more cells than the header row is refused, and a shorter row gets empty cells at its end. Column alignment (`:---:`) is ignored. Tables with merged cells, or with lists or
several paragraphs in a cell, are shown as keep regions.

### Images

```markdown
![Miyabi at the shrine](https://assets.legendkeeper.com/…/miyabi.webp)
```

An image is a block: put it on a line of its own. The URL must be an image asset of this project: upload the image
first and use the URL you get back. A link title (`"…"`) is ignored. Images inside a line of text, `data:` URIs and
other sites' URLs are refused.

### Mentions

- **`[[Name]]`** finds the page by name, exactly as the bridge's name search does (display name, full name with its
  prefix, an alias, or the canonical display name). It must match exactly one page: otherwise the write is refused,
  listing the candidates. The mention shows the page's current name, and follows it if the page is renamed.
- **`[[Name|label]]`** does the same with your own label.
- **`[label](lk://resources/<id>)`** mentions a page by id; **`[label](lk://resources/<id>/docs/<documentId>)`** one of
  its documents. This is how pages are shown when you read them.

Formatting around a mention (`**[label](lk://…)**`) is allowed but a mention itself carries no formatting.

### Escaping

A backslash before a punctuation character writes the character itself: `\*not italic\*`, `\[not a link\]`,
`\<not a tag>`, `\#` at the start of a line. Pages you read are already escaped wherever needed, so text like
`1\. not a numbered list` or `snake_case` is exactly what the page holds. Spaces at the start or end of a line are
written `&#32;`.

### Inline HTML

Only these tags are understood: `<u>`, `<sub>`, `<sup>`, `<br>`, `<strong>` (or `<b>`), `<em>` (or `<i>`), `<s>` (or
`<del>`), `<code>`, and `<span style="color:#RRGGBB; background-color:#RRGGBB">`. The bridge uses `<strong>`, `<em>`
and `<s>` itself where `**`, `*` and `~~` cannot express a run, for example bold text that ends with a space. Any other
HTML is refused. HTML comments are left out (with a warning), except the keep markers.

**Text colours:** LegendKeeper's API cannot store text colours or highlights yet, so a `<span style>` is refused on
write. Pages never show one today.

### Raw blocks: `lk-block`

For a block Markdown cannot express, write its LegendKeeper JSON in a fenced block marked `lk-block`:

````markdown
```lk-block
{ "kind": "callout", "tone": "custom", "color": "#7A3E9D", "children": [{ "kind": "paragraph", "content": [{ "text": "Purple" }] }] }
```
````

The JSON must be one block that LegendKeeper's schema accepts; read-only `version` fields are removed. Give it the `id`
of an existing block to replace that block; leave the id out to add a new one. An `unsupported` block can only be kept
(by its id), never created.

## Keep regions

Blocks Markdown cannot express (infoboxes, embeds, meters, collections and link blocks, map blocks, column layouts,
tables with merged or rich cells, text with inline icons, and content the API itself cannot show) appear as keep
regions:

```markdown
<!-- lk:keep id="infobx01" kind="infobox" -->

**Infobox**

- **PROPERTIES**
  - **Group:** Beastkin

<!-- /lk:keep -->
```

The text between the markers is there for you to read. On a write, the block is restored **exactly** from the page.

- **Leave the region as it is.** You may move it, whole, somewhere else on the page; the block moves with it.
- **Edits inside a region are ignored**, with a `KEEP_REGION_EDITED` warning. To change such a block, replace the whole
  region with an `lk-block` holding its new JSON (same `id`).
- **Removing a region is refused** in a whole-page replace (`KEEP_REGIONS_MISSING`, listing the ids), unless you pass
  `dropRegions` with those ids. Removing an `unsupported` block also needs `allowUnsupportedLoss`: that content cannot
  be recreated through the API.
- **A region cannot appear twice**, nor in an append (the block is already on the page).

## Sections

A section runs from a heading to the next heading of the same or a higher level. It is named by its **heading path**:

```text
Biography                      the heading "Biography", wherever it is
Biography > Early Life         "Early Life" under "Biography"
Asagiri Miyabi > Early Life    levels in between may be left out
```

The path's parts must appear in that order on the way down to the heading; the last part is the heading itself.
Matching is exact, then ignoring case. If several headings match, the write is refused with the options listed (for
example `Notes [1]`, `Notes [2]`): add `[n]` to the last part to choose.

### Edit modes

| Mode                | What it does                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append`            | Adds your Markdown at the end of the page.                                                                                                                                                          |
| `prepend`           | Adds it at the start.                                                                                                                                                                               |
| `replace`           | Replaces the whole page. Unchanged blocks are kept as they are; keep regions must all be present (or in `dropRegions`).                                                                             |
| `replace_section`   | Replaces one section. If your Markdown starts with a heading of the section's level or higher, the heading is replaced too; otherwise the heading stays and only the section's content is replaced. |
| `append_to_section` | Adds your Markdown at the end of a section (before the next heading of its level or higher).                                                                                                        |

Blocks outside the section are never touched.

## What is kept, and what is new

- A block whose Markdown you did not change keeps its id, its styling and every setting Markdown cannot show (an
  image's size, position and title, a callout's icon, header cells in the first column of a table…).
- A block you edited keeps its id and those settings; only what Markdown shows (its text, marks, level, URL…) changes.
- A block you moved keeps its id, also into or out of a quote, callout, secret or expand block, as long as its
  Markdown is unchanged.
- A new block gets LegendKeeper's defaults.

## Limits

Before anything is sent, the bridge checks what LegendKeeper's editor accepts, and refuses with a clear error instead
of LegendKeeper's `INVALID_CONTENT`:

| Rule                                                                         | Limit                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `listItem.parent`                                                            | A list item sits directly in a bulleted or numbered list.       |
| `list.children`                                                              | A bulleted or numbered list holds only list items.              |
| `listItem.firstChild`                                                        | A list item starts with a paragraph.                            |
| `listItem.nested`                                                            | After its first paragraph, a list item holds only nested lists. |
| `taskItem.parent`                                                            | A task sits directly in a task list.                            |
| `taskList.children`                                                          | A task list holds only tasks.                                   |
| `taskItem.content`                                                           | A task is one line of text (no nested list or other blocks).    |
| `tableRow.parent`, `table.children`, `tableCell.parent`, `tableRow.children` | Tables hold rows, rows hold cells.                              |
| `layoutColumn.parent`, `layout.children`                                     | Layouts hold columns.                                           |
| `tableCell.expandList`                                                       | A list cannot sit inside an expand block inside a table cell.   |
| `callout.color`                                                              | A callout colour needs tone `custom` (in an `lk-block`).        |
| `map.ids`                                                                    | A map block names both its resource and document, or neither.   |
| `run.codeAlone`                                                              | Inline code carries no other formatting.                        |
| `run.subSup`                                                                 | Text is subscript or superscript, not both.                     |

Field limits come from LegendKeeper's schema: 100,000 characters of text per run or code block, 2,048 for a link or
an expand title, 500 for alt text, 10,000 blocks on a page or in one container, blocks nested at most 64 levels deep.
A rule the page already breaks (content made in the app) never blocks your write; only what you add or change is
checked.

## Errors

Every refusal has a code. Fix what the message says and try again.

| Code                       | Meaning and what to do                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEP_REGIONS_MISSING`     | Keep regions are missing from a replace. Put them back, or pass `dropRegions`.                                                                                                                          |
| `KEEP_REGION_UNKNOWN`      | A region names a block the page does not hold (the page changed?). Read the page again.                                                                                                                 |
| `KEEP_REGION_DUPLICATE`    | A region appears twice, or in an append, or belongs to another section.                                                                                                                                 |
| `KEEP_REGION_MALFORMED`    | A region's markers are broken (no closing marker at the same level, a stray one, nesting).                                                                                                              |
| `UNSUPPORTED_BLOCK_LOSS`   | The write would delete content the API cannot show. Keep it, or pass `allowUnsupportedLoss`.                                                                                                            |
| `MENTION_NOT_FOUND`        | `[[Name]]` matched no page. Check the name, or link by id.                                                                                                                                              |
| `MENTION_AMBIGUOUS`        | `[[Name]]` matched several pages (listed). Use a more exact name, or link by id.                                                                                                                        |
| `MENTION_RESOLVER_MISSING` | `[[Name]]` cannot be looked up here. Link by id.                                                                                                                                                        |
| `INVALID_LK_BLOCK`         | An `lk-block` is not JSON, or not a block LegendKeeper accepts (the problems are listed).                                                                                                               |
| `UNSUPPORTED_KIND`         | An `lk-block` tries to create an `unsupported` block.                                                                                                                                                   |
| `DUPLICATE_BLOCK_ID`       | Two blocks would share an id.                                                                                                                                                                           |
| `EDITOR_LIMIT`             | The content breaks an editor limit (the rule is named).                                                                                                                                                 |
| `FIELD_LIMIT`              | Text, a list or the nesting is past a limit.                                                                                                                                                            |
| `SCHEMA_VIOLATION`         | Something LegendKeeper's schema refuses, such as a text colour.                                                                                                                                         |
| `IMAGE_URL_REFUSED`        | The image URL is not an image asset of this project. Upload the image first.                                                                                                                            |
| `INLINE_IMAGE`             | An image inside a line of text. Put it on its own line.                                                                                                                                                 |
| `UNSUPPORTED_HTML`         | HTML the bridge does not understand. Write Markdown, or escape the `<` as `\<`.                                                                                                                         |
| `UNSUPPORTED_MARKDOWN`     | Markdown with no LegendKeeper equivalent or that would vanish: an `lk://` link that is not a mention, a table row with more cells than its header, a link reference definition (`[x]: …`) no link uses. |
| `SECTION_NOT_FOUND`        | No heading matches the path. The page's headings are listed.                                                                                                                                            |
| `SECTION_AMBIGUOUS`        | Several headings match. Use a longer path or `[n]`.                                                                                                                                                     |
| `INVALID_EDIT`             | The edit is malformed: an unknown mode, or a section missing or not allowed.                                                                                                                            |

Warnings do not stop the write: `KEEP_REGION_EDITED`, `KEEP_REGION_KIND`, `HTML_COMMENT_IGNORED`,
`HTML_TAG_UNBALANCED`, `TITLE_IGNORED` (link and image titles), `ALIGNMENT_IGNORED`, `CALLOUT_TYPE_UNKNOWN` (kept as a
plain quote), `FORMATTING_IGNORED` (in an expand title), `TASK_LIST_NUMBERING`, `IMAGE_URL_UNCHECKED`,
`LK_BLOCK_VERSION_STRIPPED`, `DROP_REGION_NOT_MISSING`, and on reading, `RENDERED_AS_KEEP_REGION`.

## Maps, timelines and boards

These are read-only as Markdown:

- **Maps:** each feature with its type, name, position and link, folders as nested lists.
- **Timelines:** each lane, then its events in date order with LegendKeeper's own formatted dates and their links.
- **Boards:** each page's shapes with their text, then the connections (arrows between shapes).

Change them with the map, timeline and board tools, not with Markdown.
