# ADR 0031: write_page — planning, the compare-and-swap inside the lock, verify, and page-write proposals

Status: Accepted (v2 session C1, 10 November 2026). Implements the Pages row of PLAN-v2 section 5 on B1's converter
(4.7, with the twin-matching hotfix of ADR 0022), A3's name resolution, the job engine, the policy and proposal layers
and B2's read tools, under the constraints of PLAN-v2 10.2 and 10.6. Migration 1200 is this session's. No decision in
PLAN.md or PLAN-v2.md is changed; the choices below fill the gaps the plan and the brief leave open.

## Context

`write_page` is the main way agents change the owner's pages. Data safety comes first: refuse rather than lose
anything, never apply an edit the owner did not see, and check what was written. LegendKeeper's `If-Match` is not an
atomic compare-and-swap (PLAN-v2 10.6), the converter's plan can be built minutes before a queued write runs, and a
proposal can be approved days after it was planned.

## Decisions

1. **One tool, five modes, one write.** `write_page { page, document?, mode, section?, markdown, baseVersion?,
dropRegions?, dryRun?, detail?, project }`, `access: write`, `destructiveHint: true`. The page is resolved inside the
   AI REPOSITORY only (B2's `resolvePage`, A3's resolver); the document must be a page (or `blank`): maps, timelines and
   boards are refused with a pointer to their tools. Every edit becomes ONE `replaceDocumentBlocks` (the converter
   returns the whole tree): one write, one version step, one journal pre-image. Per-block writes were rejected: several
   writes are several chances to be half-applied, and the converter's plan is a whole-tree plan.
2. **No `allowUnsupportedLoss` on `write_page`.** CLAUDE.md says never drop `unsupported` blocks; the converter already
   refuses, and the tool offers no way round it. A keep region may be dropped on purpose with `dropRegions`, but an
   `unsupported` block (content the API cannot recreate) can only be deleted with the low-level `lk_api_write`.
3. **Planning before anything is queued** (src/pages/plan.ts): one read, B1's `applyEdit`, every B1 refusal passed on
   as a typed error with its details, and an **empty plan writes nothing** (no job). Every new block gets an id the
   bridge mints (a cuid2, as the engine mints client ids; LegendKeeper keeps a requested id), so the verify read can
   compare ids exactly.
4. **The `baseVersion` rules.** An older `baseVersion` refuses a whole-page mode (`replace`, `append`, `prepend`), whose
   context is the whole page. A section mode goes ahead only if the section's Markdown is exactly what it was at
   `baseVersion`; the edit is then applied by the converter to the CURRENT page (so attributes Markdown does not show are
   the current ones). To know the section at `baseVersion` the bridge keeps a short **memory of page versions**
   (`document_versions`, migration 1200): the Markdown of a page at each version `read_document` or `write_page` read, or
   a verified write made; five per document, seven days, 2 MiB each. A version it does not remember is a conflict
   (`base_unknown`) carrying the current version and the current section's text, so the agent can redo its edit without
   another read. Markdown is stored rather than blocks: it is a tenth of the size, and a converter upgrade can only make
   the comparison refuse (the safe direction).
5. **The bridge's own compare-and-swap, inside the lock** (PLAN-v2 10.6). The engine already reads the document inside
   the lock before a `replaceDocumentBlocks` (for If-Match, the unsupported-block guard and the pre-image) and refuses a
   caller's version that is not current. `write_page` passes the plan's version as `ifMatch`, so that read IS the
   compare-and-swap. On a mismatch, a step that names a **planner** (`options.replan`, new in src/jobs/planners.ts) is
   re-planned there instead of refused: `write_page`'s planner (src/pages/replan.ts) re-renders the current page, checks
   the section's SHA-256 against the one taken at planning time, and applies the stored edit to the current page; any
   difference, or a section that is gone or ambiguous, is a conflict and nothing is sent. Whole-page modes have no
   planner: a conflict. The re-plan reuses the in-lock read, so the cost is unchanged. Planners are registered by name
   (`engine.registerPlanner`) because the services they need (the tree's name resolution) are built after the engine; a
   missing planner falls back to the plain conflict. Only bridge code sets step options beyond `allowUnsupportedLoss`
   and `confirm` (the tools never pass an agent's input into them).
6. **Verify inside the lock, never a retry.** A step with `verifyAfterWrite` reads the document again after a successful
   `replaceDocumentBlocks`, still holding the lock and the writer slot, so only an edit from outside the bridge can come
   between the write and the read. The stored blocks are compared with the blocks sent, ids included, ignoring exactly
   (src/jobs/verify-blocks.ts, from LegendKeeper's spec 3.0.0): a block's `version` (read-only on `Versioned…Block`); a
   mention's `name` (read-only); LegendKeeper's run normalisation (empty text runs dropped, neighbouring runs with the
   same marks merged); the id it gives a block sent without one; the document's own `version`, `text` and `schema`. A
   difference is recorded on the step and the job (`result.verification`, `result.verified`), in the errors table
   (`VERIFY_MISMATCH`, classification `conflict`) and in the result ("written but not as planned: …", with the journal
   entry that holds the page as it was). A read that cannot be made leaves the write `not_checked`, with the reason.
7. **The journal records the high-level operation** (`write_journal.operation`, migration 1200): the tool, mode,
   section, a SHA-256 of the Markdown and its length, the version planned on, the agent's `baseVersion`, `dropRegions`,
   and `replannedInLock` when it applies. Not the Markdown itself: the pre-image and the params already hold the page
   before and after, and the journal is shown to every agent.
8. **Proposals hold the operation and its expansion** (PLAN-v2 10.2; `proposals.operation`, migration 1200). At scope
   `propose` the same plan is captured: the high-level operation (page, document, mode, section, the Markdown,
   `baseVersion`, the counts, and the page's Markdown before and after) and the expansion (the one
   `replaceDocumentBlocks`, pinned to the version it was built on). The capture reuses the plan's read (`prefetched`
   in the new `ProposalExtras`), and refuses a capture whose read is not that version. The dashboard shows the
   Markdown diff, keep regions as one labelled placeholder line each (src/pages/diff.ts), beside the block diff. On
   approval the existing re-read applies and a version change is `conflicted`; the stored expansion is never re-planned
   (`replan` is not kept with a proposal), but it is verified and journalled like a direct write. **New transition:**
   a page-write proposal whose job fails with `VERSION_CONFLICT` before any step succeeded (the compare-and-swap inside
   the lock caught a change after the approval's re-read) becomes `conflicted` rather than `failed`: nothing was
   written, as for a change the re-read sees. v1 proposals are unchanged.
9. **Pages LegendKeeper would not take back.** B1's converter checks what is new or changed against the spec; the
   engine checks the whole request. A page that already holds content the API returns but its write schema has no form
   for (B1's fixture models an inline icon as an `icon` run, which the spec's `Run` does not have) can therefore never
   be written by a whole-document replace. `write_page` finds this at planning time and refuses with
   `PAGE_NOT_WRITABLE`, naming the blocks, instead of the engine's bare `INVALID_PARAMS`. **To verify on the test world**
   (E4 or the owner): what `getDocumentBlocks` returns for an inline icon, and whether `replaceDocumentBlocks` accepts
   it back. The converter is unchanged (reported, not worked around).
10. **Image URLs are left to LegendKeeper.** The converter is given no `isProjectAsset`: the asset tree can lag behind
    uploads made in the app, and a false refusal would block a correct write, while LegendKeeper itself refuses a
    foreign URL before writing anything. URLs the page already holds pass; others pass with `IMAGE_URL_UNCHECKED`.
11. **The keep-region paragraphs.** `npm run roundtrip -- --project <name> --list-keep paragraph` lists every keep
    region of that kind (or `all`) with its page name and id, document, block id and the characters that made it
    read-only as visible escapes (`\n`, `\u0007`), with a short context. Read-only, as the rest of the script.
12. **A newline inside a text run is not rendered as `<br>` (not proposed).** It does not round-trip exactly:
    `<br>` already means LegendKeeper's own line-break run (`{ "break": true }`), and it parses back as one, so a run
    `"first\nsecond"` would come back as three runs and the block would change. A character reference (`&#10;`) does
    not help either: B1's parser reads it as a space. Both checked in test/pages/units.test.ts. The 32 paragraphs stay
    keep regions; any change would be B1's to make, with its own exactness proof.

## Consequences

- A typical write costs 2 reads and 1 write, plus the verify read; a dry run 1 read; a proposal 1 read to capture, then
  2 reads, 1 write and the verify read when approved. Measured in test/pages/write-page.test.ts.
- Section edits are the robust mode: they survive edits elsewhere on the page, before the call (with `baseVersion`)
  and while it waits (in the lock). Many simultaneous section edits to different sections of one page all land, one
  after another; edits to the same section or to the whole page from the same version: one lands, the rest are
  reported conflicts (test/pages/concurrency.test.ts, part of E4's acceptance).
- The engine gains generic hooks (`verifyAfterWrite`, `journalOperation`, `replan`, `registerPlanner`, proposal
  `extras`) that C2's tools (set_facts, link edits) can use without new engine work.
- `document_versions` is a cache: losing it only makes section edits from older reads refuse.
