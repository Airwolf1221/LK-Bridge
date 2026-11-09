# ADR 0022: The Markdown converter (v2 session B1)

Status: Accepted (v2 session B1, 9 November 2026). No decision in PLAN.md or PLAN-v2.md is changed. The choices below fill
the gaps PLAN-v2 4.7 and the B1 brief leave open; each is flagged so it can be overturned.

## Context

Agents will read and rewrite the owner's pages through Markdown (PLAN-v2 4.7). The converter must round-trip exactly,
keep every id and attribute of what an agent did not change, send nothing for an unchanged page, and refuse rather than
lose anything. It is a library (`src/markdown`) that later sessions wrap in tools (B2, C1).

## Decisions

1. **Parser: micromark, through `mdast-util-from-markdown`**, with the GFM table, strikethrough and task-list-item
   extensions only (no autolink literals, so a bare URL stays text; no footnotes), and one extension of our own for
   `[[Name]]` (`wiki-syntax.ts`). Why:
   - Agents write CommonMark/GFM; a strict, reference-grade parser reads their Markdown the way they expect. micromark
     follows CommonMark 0.31 to the letter (the emphasis rules, link and HTML rules) and is maintained.
   - It gives positions, which the converter needs to tell an escaped `\[!info]` from a callout marker, and a
     tokenizer API, which `[[…]]` needs so that `\[\[x\]\]` stays text.
   - It is fast enough: about 25 ms for the real-size Fourth Age page and 200 to 350 ms for one seven times larger.
   - **Rejected:** a hand-written parser (a second, private Markdown dialect; CommonMark's inline rules are where bugs
     hide), markdown-it (a token stream with HTML handled as opaque strings, and no positions inside inlines), marked
     (not CommonMark-strict), the full unified/remark pipeline (not needed: we only read mdast). The renderer is our own:
     no serialiser can promise the exact Markdown the round trip needs.
2. **Exactness is checked, not assumed.** A line with marks is parsed back after rendering; if CommonMark would read it
   differently (bold text ending in a space, `***` between two marks), it is written with `<strong>`, `<em>`, `<s>`
   instead, which have no flanking rules. Then the whole page is parsed back and compared with the blocks' projections;
   a top-level block that still does not survive becomes a keep region (warning `RENDERED_AS_KEEP_REGION`), so the
   Markdown never misrepresents the page. The cost is one extra parse per conversion.
3. **Matching by projection.** A block's projection is exactly what its Markdown shows. Parsed blocks are projections;
   at each container level they are aligned with the current blocks' projections (prefix and suffix, exact LCS up to
   4 million cells, patience anchors beyond). A match restores the current block **verbatim** (same object, id and
   attributes); a block written elsewhere at the same level is a move and keeps its id; remaining blocks of the same kind
   in the same gap are paired as edits by similarity (a lone one of its kind on both sides always pairs). An edited
   block keeps its id and every field Markdown does not show (`SHOWN_FIELDS`: an image keeps its title, layout and
   width, a callout its icon, a table cell its header flag). PLAN-v2 section 1 allows styling on edited blocks to be
   lost; this keeps it where it can.
4. **The plan is derived, not tracked**: the new tree is compared with the current one by id (or by origin for blocks
   without one). "Nothing changed" is therefore exactly an empty plan, whatever path the alignment took.
5. **Syntax choices the schema left open:**
   - an empty paragraph is `<p></p>` on its own line, and an empty task `- [ ] <!-- empty -->` (CommonMark has no empty
     paragraph, and `- [ ]` alone is not a task);
   - a callout marker sits on its own line followed by a blank quote line (`> [!info]` then `>`); `> [!info] text` is
     also read;
   - `[!tip]` and `[!caution]` read as success and error; an unknown `[!x]` stays a quote with a warning;
   - a soft line break in agent Markdown becomes a space (CommonMark's rendering); text with a real line break or a
     control character is a keep region;
   - in a table cell, `\|` separates `[[Name\|label]]` (an unescaped `|` would end the cell), so a page name cannot
     contain `|` in a wiki mention;
   - `[[Name]]` gives a mention without a label (it follows renames); `[[Name|label]]` and `[label](lk://…)` fix the
     label. An edited paragraph reuses the page's own mention object when the label did not change.
   - neighbouring lists alternate `-`/`*` and `.`/`)` so they stay separate lists.
6. **Text colours.** The API's run schema (spec 3.0.0) has no colour or highlight. The converter reads and writes
   `<span style="color:#…; background-color:#…">` as run fields `color` and `highlight`, so the owner's schema works
   the day the API adds them under those names (any other name is an unknown run field, hence a keep region). Today
   a write carrying one is refused by the schema check (`SCHEMA_VIOLATION`, with an explanation).
7. **Keep regions** are top-most blocks Markdown cannot express, marked with the block's id (`anon-<n>` for a block
   LegendKeeper returned without a usable one). The readable text inside is for reading; edits there are ignored with a
   warning; a region may be moved; it may not appear twice or in an append; a missing one is refused unless named in
   `dropRegions`. An `lk-block` with a region's id replaces that block. The job engine's own `unsupportedLoss` guard
   is applied to the whole result, so dropping an unsupported block also needs `allowUnsupportedLoss`.
8. **Editor limits are a list (`EDITOR_RULES`)**, each with its source in the spec or the plan, written from a block's
   own point of view. They and the spec's field limits (validated with a small validator over the vendored spec's
   definitions: zod's generic JSON Schema import took 5.5 s on a 3,000-row table and reported only "invalid union") are
   checked for what is new, changed or moved. A limit the page already breaks in the same place is never refused: it is
   LegendKeeper's own content. The list holds the plan's example (a list in an expand in a table cell); the round-trip
   script and sandbox writes will show which others the editor enforces.
9. **Sections** are found by a heading path whose parts appear in order on the way down (levels may be skipped), exact
   and then ignoring case; duplicates are refused with the options, and `[n]` picks one. `replace_section` replaces the
   heading too only when the Markdown starts with a heading of the section's level or higher.
10. **The name resolver is synchronous** (`resolveMention(name)`): A3's tree lives in SQLite through better-sqlite3. An
    asynchronous caller uses `collectMentionNames` and `mapResolver`.
11. **Image URLs** are checked through `ctx.isProjectAsset` (A4's asset tree); without it, URLs the page holds pass,
    `data:`, `blob:` and non-https URLs are refused, and others pass with a warning (LegendKeeper refuses a foreign URL
    before writing anything). The library never names LegendKeeper's asset host (the ESLint rule for `src/`).
12. **The round-trip script** (`npm run roundtrip`, `deploy/markdown-roundtrip.sh`) selects the project the way the
    phase 0 spike does (`LK_SANDBOX_API_KEY`, `LK_SANDBOX_PROJECT_ID`, `--allow-bridge-project`), because A1's
    `--project` had not merged when B1 finished. It reads only (listProjects, listResources, getDocumentBlocks) at P3.
    Switching it to A1's project selection is a small change in the CLI and wrapper.
13. **One known limit of GFM:** inline code cannot end a backslash right before `|` inside a table cell (GFM reads
    `\|` as an escaped pipe even in code), so such a table is a keep region.

## Consequences

- Every write path in v2 goes through one converter whose central promise is property-tested: thousands of generated
  pages (every block kind, marks, mentions, keep regions, arbitrary Unicode) round-trip exactly with an empty plan, and
  the Markdown is stable.
- The self-check doubles the parsing work of a conversion; a 3,000-block page still converts both ways in about a
  quarter of a second.
- `docs/PLAN-v2.md` is excluded from the Prettier check, as `docs/PLAN.md` already was: it is the owner's document, edited
  outside the repository's formatting, and it failed the check on `main`.
