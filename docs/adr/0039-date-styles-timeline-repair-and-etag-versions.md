# ADR 0039: Two date styles, timeline repair from the table, and versions from the ETag

Status: Accepted (v2 D1.1, 11 November 2026). Corrects ADR 0038 (the year grouping of LegendKeeper's own text) and
adds `sync_timeline_event`, the check's `date_mismatch` finding and the dashboard's "Propose a fix" to it; amends ADR
0032 decision 4 (chained versions) for a write whose body carries no version. No decision in PLAN.md or PLAN-v2.md
changes; PLAN-v2 gains a D1.1 row and an E5 step. Nothing in this session touched a live system: every test runs against
the mock LegendKeeper, and the sandbox tests are written, not run.

## Context

The owner's full sandbox run on the server (11 November 2026) showed, in short:

- **Smoke** passed; **assumptions** passed 27 of 28 (B12 failed).
- **Chronology** failed 243 checks. Every table row of every age (695) matched the engine exactly, and minutes, `detail`
  and shape matched for every timeline event. **242 failures were one formatting difference:** LegendKeeper's own event
  text has no thousands separator in a year (`Kumikas 1st, AA 1988119`, `Isar 17th, 1A 8501`), the tables write one
  (`AA 1,988,119`), and the engine used the table style for both. Third, Fourth and Fifth Age events passed only because
  their years are under 1,000. This settles ADR 0038's open guess.
- **One real finding** (data drift on the test world, not a bridge fault): the Fourth Age has 335 rows and 333 events.
  The two year-only rows `4A 41` and `4A 139` have no event, and the row `Isar 3rd, 4A 619 - Camue 5th, 4A 624` pairs
  with an event the check prints as `Isar 3rd, 4A 619`, possibly a single day where the table says a range.
- **B12:** `createPropertyRow` and `updatePropertyRow` return no version in the body, but they send an `ETag` header
  (`6f78abcf9e74a430`, `f187b4e39467a0e4`); B13 and D25 showed ETags on 204 responses too.

## Decisions

1. **Two date styles, always named.** _LegendKeeper's style_ has no thousands separator in a year; it is what LegendKeeper
   shows on events (`formattedStart`, `formattedEnd`) and is the only style `CalendarEngine.format` produces (the option
   it took is gone: `format(minute, detail)`). _The table style_ has the separators and the range forms learned from the
   table rows and confirmed on the Chronology page (`DateTextStyle`, `KcyStyle`); it is used only for table Date and KCY
   cells (`formatTable`, `DateParser.render` with a style, `ParsedDate.text`). `LK_DATE_STYLE` and `DEFAULT_DATE_STYLE`
   are the two defaults. Table writes use the table style; every comparison with LegendKeeper's event text uses
   LegendKeeper's.
2. **Parsing reads either.** A year is read with or without thousands commas (a badly grouped one is still refused); the
   range separator is any dash. `ParsedDate` carries both texts: `formatted` (and `formattedStart`, `formattedEnd`), in
   LegendKeeper's style, and `text` / `tableFormatted` (the same text), in the table style. `calendar_date` returns
   `formatted` and `tableFormatted`, and for a KCY each year's `from` and `to` in both.
3. **The check never compared event text,** so it did not report the 242: it pairs by minutes, not by text. What it
   needed was the same discipline: its comparisons are by minutes, its table cells by the confirmed table style, and
   the text it quotes from an event is LegendKeeper's own. A regression test covers a chronology whose years are over
   1,000 in both styles. The opt-in sandbox test (`test/sandbox/chronology.ts`) is where the separator was wrong
   (`engine.format` with commas); it now compares event text in LegendKeeper's style and the Date and KCY cells in the
   table style.
4. **Pairing a row and an event** (`matchRowsAndEvents`, shared by the check, the sandbox test and the tools) has four
   passes, each using only what the earlier ones left: (1) the bridge's own links (a linked pair that disagrees about
   the date is a date mismatch, not a pair); (2) the same date and the event's name is the row's description, or its
   start cut short; (3) the same date alone, when a row and an event are the only ones on that date (or equally many of
   each): the timeline's short name differs from the table's description by design, so wording alone is not drift (the
   owner's run showed unpaired rows and events whose dates matched and whose wording differed); (4) the same chronology
   event with a different date: the event's name is the row's description, or both begin at the same minute, with no
   other candidate on either side.
5. **`date_mismatch` is its own finding kind** (pass 4): a paired row and event that disagree about the date or shape
   (for example a range row with a single-day event). It is no longer reported only as a row without an event plus an
   event without a row. Rows without an event and events without a row are what remains after all four passes.
6. **`sync_timeline_event` (W)** repairs the timeline for ONE age table row, the table being the authority
   (`src/chronology/sync.ts`). Input: the row by its date plus description, or by its block id (with its age when no
   date is given; a row id alone is found by reading the tables). It creates the row's event if none pairs with it
   (minutes, `detail`, an end for a range, the age's lane, `uri` to the age's table, the short name the description, cut
   to 100 characters with `...`), or corrects the paired event's `start`, `end`, `detail` and `uri` to the row. A
   single-date row whose event has an end makes the event again (LegendKeeper cannot take an end away; ADR 0038
   decision 14). **It never touches the table or the Main count** (the row was already counted: that is the drift) and
   **never renames an event**. A row whose event already agrees answers `nothing_to_do` and writes nothing. An unpaired
   row with candidate events (same date, same start, or the name) is refused with the candidates
   (`PAIRING_AMBIGUOUS`): a second event is never made beside a possible first. `event_id` names one of them. Refusals:
   `EVENT_NOT_FOUND`, `EVENT_AMBIGUOUS`, `ROW_DATE_UNREADABLE`, `ROW_MISMATCH`, `EVENT_TAKEN`, `EVENT_MISMATCH`, and the
   date errors.
7. **Its job is the ordinary one** (decision 8 and 12 of ADR 0038; an ordinary edit, not canon: decision 17): one job
   holding the age's table and timeline (sorted locks), `bridge.expect` inside the lock, `bridge.record` (resume, never
   replay), the write (`createEvent`, `updateEvent`, or `deleteEvent` then `createEvent`), `bridge.verify`, the journal.
   `dryRun`, `operation_id`, one proposal under `propose`. The compare-and-swap inside the lock has a new part, a
   **row assertion** (`TargetWrite` `row.assert`, `TableOp` `assert`): the table is locked and its row must still be
   exactly as planned (description, Date, KCY), because the event is built from it. A row edited between a proposal and
   its approval ends the proposal `conflicted`, and nothing is written. A resume does not assert again.
8. **"Propose a fix" on the dashboard** (`POST /chronology/propose-fix`, `Chronology.proposeFix`): each
   `row_without_event` and `date_mismatch` finding of the check has the action. It plans `sync_timeline_event` for that
   row and captures ONE proposal whatever the caller (`BatchSubmit.forceProposal`, bridge code only; the policy gate and
   the write guard still run, a deny still denies), proposed by the `system` principal with the dashboard as its origin.
   The owner approves it as normal on the Proposals page; approving runs the job of decision 7. Audited
   `chronology.propose_fix`. A change of that age that stopped part-way, an ambiguous pairing and a row that is gone are
   refused with their reason.
9. **Versions from the `ETag`** (sandbox B12, B13, D25). The governor captures the response `ETag`, unquoted
   (`CapturedResponse.etag`, `parseEtag`), and `callOp` keeps it on the call (`CallStats.etag`). For a write LegendKeeper
   versions (`versioned` in the registry: a row write, a block write, a document write; never `updateProperty`, whose
   ETag, if any, is of another kind), a step stores the ETag beside its result (`etag`). A step that chains its If-Match
   from it (`ifMatchFrom`, ADR 0032 decision 4) takes the body's `version` when there is one, else the ETag, and a
   chained row write then needs no read of its own: the bridge's in-lock read of the property is skipped as it is for a
   version in the body (the deletes' pre-image read stays). This applies to row writes and to deletes (B13, D25). With
   neither a body version nor an ETag the safe fallback stands: the bridge re-reads, and for `expectCurrent` steps
   compares the content.
10. **`useEtagVersions`, per project, default on.** Until the owner's next sandbox run confirms it, the ETag use sits
    behind this project setting (Projects page, or `npm run projects -- set <project> useEtagVersions off`): off, the
    bridge ignores the ETag and re-reads, with no deploy. The sandbox's **B12** now asserts, for a create, an update and a
    delete, both that the ETag equals the version the next `listPropertyRows` gives and that LegendKeeper accepts it as
    If-Match (sent instead of the version read); it reports PASS only if both hold, and says plainly which half did not,
    and that the setting should be switched off.

## Consequences

Measured against the mock (the same calls against a LegendKeeper that answers a row write's version nowhere, as the
bridge had to assume until now, and in an ETag):

| Call                                                     | Reads without the ETag | Reads with it | Writes |
| -------------------------------------------------------- | ---------------------- | ------------- | ------ |
| `set_facts`: a change, a change, an addition, a removal  | 10                     | 6             | 4      |
| `set_facts`: two facts changed                           | 6                      | 4             | 2      |
| `set_facts`: two removals                                | the same               | the same      | 2      |
| `archive_page`, Authoritative (a proposal, then the job) | 19                     | 15            | 8      |
| `unarchive_page`, to Authoritative                       | 18                     | 15            | 7      |
| `unarchive_page`, to Working / `archive_page`, Working   | 18 / 19                | 15 / 15       | 7 / 8  |
| `move_to_working`                                        | 11                     | 11            | 3      |
| `promote_page`                                           | 13                     | 11            | 5      |
| `sync_timeline_event`, a missing event (create)          | 7                      | 7             | 1      |
| `sync_timeline_event`, a correction                      | 6                      | 6             | 1      |
| Propose a fix (plan and capture)                         | 3                      | 3             | 0      |

A chained change or addition saves its in-lock read of the property (`listPropertyRows` and `listProperties`: 2 reads);
a removal reads the row for its journal pre-image either way, and `move_to_working` has no chained row write to save.
`sync_timeline_event` reads 3 to plan (the calendar, the table, one page of 100 events), then 3 in the lock for a create
(the table, the event, the lane) or 2 for a correction, and 1 to verify. The chronology tools' block writes chain from
the check inside the lock; a block write with no version in its body (a `deleteBlock`) now chains from its ETag too.

- The check reports the same drift as before, in fewer, clearer findings: a wording-only difference is no finding, and a
  date mismatch is one finding, not two.
- A repair is a proposal the owner approves, never an automatic fix (PLAN-v2 4.12 stands: the check never repairs).

## Open for the owner

- The sandbox again (`deploy/sandbox-test.sh --project test`): B12 should pass. If it does not, switch
  `useEtagVersions` off and send the report.
- For E5: run `chronology-check` on Arkona and propose fixes before the move is called done.
