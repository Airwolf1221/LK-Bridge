# `src/markdown`: the Markdown converter

The library behind every Markdown read and write of v2 (docs/PLAN-v2.md 4.7; decisions in
[ADR 0022](../../docs/adr/0022-markdown-converter.md); the agent guide is [docs/markdown.md](../../docs/markdown.md)).
Pure functions over block trees and Markdown: **no MCP tools, no database, no LegendKeeper calls.** Import from
`src/markdown/index.ts` only.

## Interface

| Export                                                                                     | What it does                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toMarkdown(document, ctx?) → { markdown, regions, warnings }`                             | A page's blocks (the API's `DocumentBlocks`, or its `blocks`) → Markdown in the owner's schema. `regions` lists every keep region `{ id, kind, reason }`. `ctx.selfCheck` (default true) parses the result back and turns any top-level block that does not survive into a keep region (warning `RENDERED_AS_KEEP_REGION`). |
| `fromMarkdown(markdown, base, ctx?, options?) → { blocks, plan, warnings }`                | Markdown → the whole new block tree, aligned against `base` (the CURRENT page). A whole-page replace: missing keep regions are refused unless `options.dropRegions` names them; `options.allowUnsupportedLoss` mirrors the job engine's guard.                                                                              |
| `applyEdit(base, { mode, section?, markdown, dropRegions?, allowUnsupportedLoss? }, ctx?)` | `append`, `prepend`, `replace`, `replace_section`, `append_to_section`. Same result shape. Blocks outside the edited range are unchanged (and cannot be taken by a move).                                                                                                                                                   |
| `outline(md)`, `getSection(md, path)`                                                      | Headings with their paths and lines; one section's Markdown (`markdown`, `body`, lines).                                                                                                                                                                                                                                    |
| `renderMap`, `renderTimeline`, `renderBoard`                                               | Read-only Markdown for the other document types, from the API's data.                                                                                                                                                                                                                                                       |
| `checkRoundTrip(blocks)`, `firstDifference`, `minimalRepro`                                | The round-trip check of one page (used by `npm run roundtrip`).                                                                                                                                                                                                                                                             |
| `collectMentionNames(md)`, `mapResolver(map)`, `stubResolver(table)`                       | Mention helpers: collect `[[names]]` for an asynchronous lookup, answer from a map; a test stub.                                                                                                                                                                                                                            |
| `MarkdownError` (`code`, `message`, `details`)                                             | Every refusal. Codes are listed in `errors.ts` and docs/markdown.md.                                                                                                                                                                                                                                                        |
| `EDITOR_RULES`, `validateAgainstSpec`, `MAX_BLOCK_DEPTH`, `MAX_DOCUMENT_BLOCKS`            | The limits, for callers that build blocks themselves.                                                                                                                                                                                                                                                                       |

`ctx` for writes (`FromMarkdownContext`):

- `resolveMention(name) → { status: 'resolved', resourceId, documentId? } | { status: 'ambiguous', candidates } | { status: 'not_found' }`.
  Session A3 implements it over the repository tree. It is **synchronous** (the tree is in SQLite through
  better-sqlite3); an asynchronous caller resolves `collectMentionNames(md)` first and passes `mapResolver(answers)`.
- `isProjectAsset(url) → boolean`: whether an image URL is an asset of this project (A4's asset tree). Without it,
  URLs the page already holds pass and other https URLs pass with `IMAGE_URL_UNCHECKED`.
- `mintBlockId()`: ids for new blocks (otherwise LegendKeeper mints them).

The `plan` (`WritePlan`) is derived by comparing the result with the current page: `empty`, `kept` (a count), `changed`
(own fields; with `before` and `after`), `added` (top-most, with parent, index and `afterId`), `removed`, `moved`,
`droppedRegions`. C1 can turn it into minimal block writes, or send `blocks` with `replaceDocumentBlocks`.

## How it works

- **model.ts** decides, per block and in its place, whether Markdown expresses it or it becomes a keep region, and
  computes its **projection**: exactly the fields its Markdown shows, normalised (runs merged, empty runs dropped, an
  empty container holding one empty paragraph, the first table row as header). Invariant, proved by the property tests:
  for every expressible block, `parse(render(B)) = project(B)`.
- **render.ts / inline.ts** write the Markdown. Text is escaped; a line with marks is parsed back and, when CommonMark's
  emphasis rules would read it differently, written again with `<strong>`, `<em>`, `<s>`. The whole page is then parsed
  back and compared (the self-check).
- **parse.ts** reads Markdown with micromark (`mdast-util-from-markdown`, GFM tables, strikethrough and task items) plus
  the `[[…]]` construct in wiki-syntax.ts, into drafts: projections, keep references and raw `lk-block`s.
- **rebuild.ts** aligns drafts with the current blocks at each container level (align.ts: common prefix and suffix, an
  exact LCS, patience anchors for huge gaps), restores matches verbatim, keeps moved blocks, pairs edited blocks by kind
  and similarity (keeping their ids and every field Markdown does not show, SHOWN_FIELDS), restores keep regions by id;
  a second pass then finds, anywhere on the page, the unchanged block a still-new block may be (moved into or out of a
  container) and restores it verbatim;
  then applies the rules: missing regions, the job engine's `unsupportedLoss` guard, duplicate ids, editor and field
  limits (limits.ts, schema.ts) for what is new or changed, image URLs.
- **sections.ts** finds sections by heading path, in Markdown (outline, getSection) and in blocks (applyEdit).
- **readable.ts** writes the readable text inside keep regions; **documents.ts** the map, timeline and board views.

## Extending the editor limits

Add an entry to `EDITOR_RULES` in limits.ts (an id, the message, its source, and `breaks(block, { ancestors, index })`),
a case in `test/markdown/units.test.ts` (the test fails until every rule has one), and a line in docs/markdown.md. A
rule that the current page already breaks in the same place is never refused.

## Tests

`test/markdown/`: property tests (`FC_RUNS`, default 300; `FC_SEED` replays), the escaping fuzz, fixtures modelled on the
test world, a test for every error and warning, unit tests of each part, and the round-trip script's dry run and wrapper.
`npm run roundtrip` (deploy/markdown-roundtrip.sh) checks every page of a real project, read-only.
