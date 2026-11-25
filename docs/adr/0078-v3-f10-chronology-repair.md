# ADR 0078: v3 F10: the chronology repaired soon after an edit; its deterministic fixes as automation codes

- Status: **Proposed** (v3 F10, 25 November 2026). It builds C1 to C6 of the owner-approved design
  `LK-Bridge-F10-chronology-repair-design.md` (approved as written, 24 November 2026). Every decision is implemented and
  tested against the mock LegendKeeper; nothing in this session touched a live system (no LegendKeeper, no bridge
  connector, no sandbox run). Where the design was silent the choice is marked **chosen**.
- Why: ChatGPT often edits age tables directly, so the timeline goes without its events; the chronology check ran only
  weekly, and its fixes ("Propose a fix") were absent from F5b's automation catalogue.
- Unchanged: **the table is the authority; the timeline is derived** (PLAN-v2 4.12). Nothing here reads the timeline to
  change a table: every fix sets the timeline from its table, or a table cell from the calendar engine, or the rows'
  order from their own dates.
- Amends: [ADR 0068](0068-v3-f5b-automatic-actions-for-audits.md) (a fourth source, `chronology`);
  [ADR 0038](0038-calendar-engine-and-chronology-sync.md) (the check nightly, and soon after an edit).
- Also in this session (Step 0, no decision): the `f7d-art-set` sandbox check expected F7d's old "always a proposal"
  claim; its D3 now runs at scope `propose`, a new D3b tests the direct job at `write`, and its mock world keeps the
  pack's seed switches (the art tool at "follow the scope", as live).
- No migration. One setting (decision 3).

## Decision 1 (C1): the existing fixes become automation codes

`chronology_row_without_event`, `chronology_date_mismatch` and `chronology_name_drift` (the sync) and
`chronology_count_mismatch` (the count) are in the catalogue (`src/automation/registry.ts`) with the new source
`chronology`: proposal-first with Apply allowed (`automatable: 'propose'`, `defaultMode: 'propose'`,
`applyDirect: true`, as F7.1's codes), each naming the check's finding kind and its fix. `defineCode` refuses a
chronology code that is anything else.

The engine (`runChronologyCode` in `src/automation/service.ts`) reads the findings from the chronology check's newest
successful run (**chosen**: not from the audits' fold-in, which lags a check by up to a night), and calls the
chronology's new `repair(actor, project, fix, { mode, origin })`, which plans exactly as "Propose a fix" plans (one
shared planner, `planFix`, its reads at P3, the checks inside the lock unchanged) and either captures ONE proposal or,
at Apply, submits the same job as the Automation principal. Always a proposal, never applied, with the reason in the
proposal's summary and the run's item: a sync that changes the event's shape (`SHAPE_CHANGE`: the owner's approval is
the confirmation `confirmShapeChange` asked for); a row whose date is qualified (`QUALIFIED_DATE`, **chosen**: the
design's "unreadable date" for a row that has a fix; a date the engine cannot read at all has no fix, below); a row
whose table-only mark has lapsed (`TABLE_ONLY_LAPSED`: its cells changed since the owner marked it).

Left for the owner, recorded as `guarded`, never counted towards F5b's pause after three skips: an ambiguous pairing
(the existing refusal, with its choices on the Chronology page), a date the engine cannot read, a KCY or style a
partial or qualified date does not decide, an order that is not strict. A row the owner marked table-only (a current
mark) is skipped (`TABLE_ONLY`); the check already hides it. A finding a run proposed or applied is not acted on again
(keyed by its age, kind, target and words, so a changed row is a new finding). Caps as F5b: 25 a code, 100 a run.

## Decision 2 (C2): four new deterministic fixes

`src/chronology/repairs.ts`, each a plan from a live read run by the ordinary chronology job (`buildJob`: the documents
locked, the compare-and-swap inside the lock, block-level writes with If-Match chained, `bridge.verify`, the journal and
the record), as "Propose a fix" (Chronology and Audits pages) and as automation codes like decision 1's:

| Code                           | Fix                                                                                | Only when                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `chronology_wrong_kcy`         | the row's KCY cell set to the engine's value for its date, in the confirmed style  | the date is complete and readable (a day; else `KCY_NOT_DETERMINED`)                     |
| `chronology_wrong_uri`         | the event's `uri` set to its age's table                                           | the age is known (always: the finding's)                                                 |
| `chronology_row_out_of_order`  | the fewest rows moved into calendar order                                          | strict (below); else `ORDER_NOT_STRICT`, a judgement as before                           |
| `chronology_date_text_differs` | the Date cell written as the engine writes the same date; a right KCY in the style | a plain readable date (a qualified one is never rewritten); a wrong KCY is `wrong_kcy`'s |

**Strict order** (**chosen** precisely): the rows that change place and their neighbours either side all have plain
readable dates, and each is strictly before the next compared at the coarser of their details (a year with a day of
another year is ordered; a year with a day of the same year, or two equal dates, is not). The moves: the rows outside a
longest run already in order, each moved after its predecessor in the new order (`row.move`, a `moveBlock` with a
fixed `after`); a new `row.order` target asserts inside the lock that the table holds exactly the rows read, in that
order, with those texts; each moved row is verified in its place. A reorder is not reverted by Revert (the calendar
decides the order).

Every proposal shows the before and after text per cell (the order: the rows' dates before and after) as `textChanges`
(`src/jobs/text-change.ts`, F7.1a's display). The record tools `chronology_kcy_fix`, `chronology_uri_fix`,
`chronology_order_fix`, `chronology_style_fix`.

## Decision 3 (C3): repair soon after an edit

The snapshot service calls a new `afterChange` hook when a job's change snapshot is written. When it took a chronology
document (the Main table, an age table or an age timeline; the whole page counts), `src/chronology/after-edit.ts`
schedules the project's chronology check **`CHRONOLOGY_CHECK_DELAY_MS`** (new setting, group "Automation", default
600,000, 1,000 to 86,400,000, applies now) after the last such change, through F6a.1's background runner (debounced,
one run at a time per project, awaited on stop, never inside a request). When the check finishes, the automation's
chronology codes run on its findings straight away (`AutomationService.runChronology`, the trigger `chronology`), within
the caps and every stop condition of the nightly run. The chronology's own jobs (the timeline tools, the fixes, a
revert, the automation's repairs) keep the table and timeline in step and verify themselves, so they schedule nothing.

The scheduled `chronology-check` is nightly at 05:00 (was weekly), at P3, and a scheduled run waits for the night's chain
(the full snapshot, then its audit), as F9's jobs do. **Chosen**: a job on its default schedule whose stored next run
is later than its new default's next run takes the new one at start (so the weekly run does not wait a week).

## Decision 4 (C4): steering agents

A `write_page` that changes an age table, and an `lk_api_write` that names an age table's document, carry
`chronologyNote`: "This is a chronology table. New or changed rows are synced to the timeline by the bridge within
minutes; to add one row with its event in one step, use sync_timeline_event." (the owner's words). Nothing is refused.
The guide's "Dates and the chronology" says the same, plus when a direct table edit is right (several rows, or
restructuring), and that each repair is a proposal unless the owner set its code to Apply; "How to decide" gains one
row (its cap raised by exactly the row, 9,450 to 9,613).

## Decision 5 (C5): visible

The Chronology page's new "Repairs by the automation" card (`GET /chronology/automation`): when the automation last
ran (and last after a chronology check), each chronology code's mode, and the newest items (synced, proposed, left for
the owner) with their job or proposal. `bridge_workstream_report` attributes the repairs to the workstream of the table
edit that caused them: the after-edit hook remembers, per document, the workstream of the newest edit, and each repair
of that age (its table or timeline, else the Main table) carries it on its origin (job, proposal and journal).

## Decision 6 (C6): these stay judgements

`chronology_event_without_row`, `chronology_event_in_tie`, `chronology_unreadable_date` and `chronology_not_found` are in
the catalogue as never eligible; their proposal and report flows are unchanged.
