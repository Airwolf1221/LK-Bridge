# ADR 0038: The calendar engine, chronology sync and the timeline tools

Status: Accepted (v2 session D1, 11 November 2026). Implements PLAN-v2 4.8 (the calendar engine), 4.9 (chronology sync)
and the Timelines rows of section 5, on C1's engine hooks (ADR 0031), C2a's internal steps and job-level locks (ADR
0032), C2b's `operation_id` and write jobs (ADR 0034), C2c's sorted job-level locks, record step and resume pattern (ADR 0035) and the mid-point review's notes (CR-2026-11). Migration 1800 is this session's (C2d, which ran alongside, took 1750). Owner decision 6 of ADR 0036 (option (a)) is recorded as accepted. No other decision in PLAN.md or
PLAN-v2.md is changed; the choices below fill the gaps the plan and the brief left.

## Context

The Universal Chronology is one `[BSRC]` page holding a Main document (an index table of the ages: `Age | Event count |
Complete dated table | Interactive timeline`, the last two cells mentions of each age's documents) and, per age, an
"<Age> - Table" page document (`Historical Event | Date | KCY`, in calendar order) and an "<Age> - Timeline" timeline
with one lane, "Historical Events", whose events link to the age's table. The table is the authority; the timeline is a
derived view. Dates are written in the owner's forms in the Kumikan Epochal calendar (30-hour days, 716-day years, an
Archon Age counting down before the epoch, then 1A to 5A, years restarting from 2A). The phase 0 spike proved that a
prototype built only from the calendar definition reproduces LegendKeeper's dates for 330 real events; its oracle file
(`test/fixtures/calendar/oracle.json`) is the engine's test data.

## Decisions

1. **The engine is built from the definition only** (`src/calendar`). Months with their lengths, months that occur
   every N years (`interval`, `offset`), leap days with their `400,!100,4` rules, `hasZeroYear`, the negative era
   counting down, forward eras that keep counting (`none`), restart their years (`year`) or restart the whole date
   (`calendar`), and the format templates (`YYYY`, `E`, `EE`, `MMMM`, `MMM`, `M`, `MM`, `D`, `DD`, `D^`, `DDDD`, `DDD`,
   `H`, `HH`, `m`, `mm`, `[literal]`). Every rule repeats with the least common multiple of its intervals, separately
   on each side of the epoch, so a minute is turned into a year without walking 2 million years. Nothing about Arkona
   is in the code; Kumikan is a test fixture.
2. **The minutes follow LegendKeeper exactly** (verified on all 330 oracle events, start and end): a day starts at its
   first minute; a date range ends at the first minute of its last day; a month range at the first minute of its last
   month; a year range (by the same rule, to verify) at the first minute of its last year. `detail` is 1 year, 2 month,
   3 day. A year or month that begins before its era (`4A 1`, which starts on Azah 18th) starts at the era's first
   minute; a day must lie inside its era. KCY is the epoch frame's year number: `year + 1,250,307` for 4A, `-year` for
   the Archon Age.
3. **The forms are made from the calendar's own templates** (`src/calendar/parse.ts`). The day template divides into a
   month-and-day part and a year part (`MMMM D^` + `, ` + `E YYYY`), which gives the compressed forms: `Jehet 11th -
18th, 4A 424`, `Isar 20th - Pahan 31st, 4A 32`, `Kumikas - Azaakh, 4A 180` and `Unknown, 4A 101` (stored year-only).
   The full forms come from the templates as they are: a day, a month (`Zahras 4A 367`), a year, and ranges of each.
   Matching ignores case, any ordinal suffix or none, extra spaces, any dash between the ends, and a year with or without
   thousands commas; a space the template puts after punctuation stays required (`8,841` is never day 8 of year 841).
   `Unknown` alone is refused. Refusals are typed and precise: an unknown month or era (listing the calendar's), an
   impossible day, a date outside its era (naming the day the era begins, or the next era), a reversed range.
4. **A date is written back in the form it was given** (`ParsedDate.text`), with the calendar's names. The bridge never
   rewrites the owner's form; `calendar_date` shows the text a row would get.
5. **How the tables write KCY and dates is learned, never invented.** A KCY cell's thousands separator, minus sign,
   range separator, and whether a range inside one year is written as one value or as a range, and a date's range
   separator and year grouping, are read from the real rows when the owner reads the chronology on the dashboard
   (`detectStyle`: each aspect's value, how many rows showed it, examples, and the aspects written more than one way).
   The owner confirms (or edits) them with the documents. Where the rows show nothing, the owner's own forms are the
   default (`-`, thousands commas, `-1,988,119`, and a range for a dated range: the Jehet 4A 424 row has the same KCY
   at both ends); the opt-in sandbox test checks every real row against the confirmed style, byte for byte.
6. **Settings per project, found by naming convention and confirmed by the owner** (`src/chronology/settings.ts`, the
   project setting `chronology`, audited `project.set_chronology`), as C2c confirms the lifecycle indexes: the
   chronology resource (by name, or the `chronologyResourceId` setting; among several pages of that name the one
   holding a Main page and an age table), its Main document, each age's table and timeline (by the `" - Table"` and
   `" - Timeline"` suffixes), each timeline's one lane, each age's Main row, and the calendar (the one the timelines
   use; every age timeline must use the same). Ages map to eras by the calendar's era names, and the Main row's Age
   cell must match. Until confirmed, and whenever a confirmed document is gone, renamed or of another type, every
   chronology tool refuses (`CHRONOLOGY_NOT_CONFIGURED`, `CHRONOLOGY_CHANGED`) saying what the owner must do.
7. **`calendar_date` is free when the calendar is cached.** The bridge keeps the calendar definitions it last read
   (`chronology_calendars`); the dashboard's lookup and every write tool's plan read the calendar again (one request),
   so a write never plans on a stale definition.
8. **One job per change, holding every document it touches** (`src/chronology/plan.ts`). `BatchSubmit.holdDocuments`
   (new) takes the locks of the age table, the age timeline and the Main document (two of each for a move between ages)
   in one sorted order with any other job-level lock, from the first step to the last, so two such jobs never wait on
   each other. The job is: `bridge.expect`, `bridge.record` begin, the writes (the table first, it is the authority,
   then the timeline, then the Main counts), `bridge.verify`, `bridge.record` complete.
9. **The compare-and-swap inside the lock decides the row's place and the new count.** Two new `bridge.expect` checks
   run registered checkers on whole documents (`kind: 'document'`, `engine.registerChecker`): `chronology.table` (the
   table and its columns still there; a row to insert not there yet and no identical row; a row to change or delete
   still exactly as planned) and `chronology.main` (each age's Main row still that age's, with a number). They work out,
   from the documents as they are at that moment, where the row goes (calendar order: by year; dated rows by their
   start, ranges by their start; year-only rows after the dated rows of their year; ties after the existing rows of the
   same date) and the new count (one more or one less than the count NOW), and hand them to the writes that follow
   (`StepOptions.bindBody`, checked against the registry's schema before anything is sent). Each versioned write chains
   its If-Match from the check (or the job's own previous write to that document). An event check and a lane check
   (`kind: 'event'`, `'lane'`) confirm the timeline. So two agents adding events to one age at once both land correctly.
10. **Block by block, never the whole document.** A row is written with `insertBlock`, `moveBlock`, `replaceBlock` and
    `deleteBlock`, a count with `updateBlock` on the count cell's paragraph (its first run's marks kept): anything else
    on the page (an inline icon, a keep region) is untouched.
11. **Chronology proposals are judged by their check, not by document versions.** Their table and Main writes carry
    `StepOptions.judgedInLock` (bridge code only): the proposal captures no version of those targets, so another approved
    event in the same table does not make a pending one conflict; the check refuses at execution what would (the row
    changed, an identical row appeared, the age's Main row gone). Events are still captured and compared as before.
12. **Resume, never replay** (C2c's pattern). The job writes a record (`chronology_records`, store `chronology` of the
    `bridge.record` step) with the change's target writes and, from its own check, each Main count before and after. A
    job that stops part-way leaves the record incomplete; the same request again plans from the documents as they are now
    and makes only what is left (a row present or absent by its id, an event by its id, a count by whether it shows the
    before or after value; anything else is `CHRONOLOGY_RESUME_CONFLICT`). Until then another chronology change of those
    ages is refused (`CHRONOLOGY_INCOMPLETE`); the owner can mark a stopped change resolved on the dashboard (audited
    `chronology.resolve`).
13. **A row and its event are linked** (`chronology_links`) when the bridge makes them, since the timeline's short name
    differs from the table's description. Older rows and events are paired by date and text (the event's name equal to
    the description, or the description's start cut short with `...` or `…`). `update_timeline_event` and
    `delete_timeline_event` find the event by its date with its description or name, or by its row or event id, and
    refuse when the row and its event have drifted apart (`CHRONOLOGY_DRIFT`): that is for the check, and fixed by hand.
14. **An update keeps all three in step.** A new date in the same age moves the row (`moveBlock`, place decided in the
    lock) and changes it; a new date in another age inserts the row in that table, deletes it from the old, creates the
    event in that timeline and deletes the old, and adjusts both counts (six writes, insert before delete so nothing is
    ever lost). LegendKeeper cannot take an end away from an event, so a range changed to a single date makes the event
    again (same lane, link and name).
15. **The timeline-only tools touch only the timeline.** `create_timeline_lane` refuses the chronology's age timelines
    (confirmed ones, and any "- Timeline" document of the chronology page), which have exactly one lane by design.
16. **A lane's delete keeps its events** (the CR note). On every route (the tools, `lk_api_*`, `lk_op_*`), the read that
    gives `deleteLane` its journal pre-image also lists the lane's events: the pre-image is the lane with `events`.
17. **Canon: option (a) of ADR 0036 decision 6** (the owner, 11 November 2026). Adding, changing or deleting timeline
    events, lanes, map features and board shapes on an Authoritative page are ordinary edits, not canon-gated, just as
    `write_page` content is not. Only deleting a whole map, timeline or board document of an Authoritative page is
    canonical (C2c's `delete-document-authoritative` rule). Nothing in the guards changes: none of those operations was
    gated.
18. **The chronology check** (`chronology-check`, weekly, P3, background, paced behind agents' work; and the dashboard's
    "Run the check now" at P2): per age the table and the timeline's events, the Main table once. Findings only: rows
    without an event, events without a row, rows out of calendar order, wrong KCY values (and cells written differently
    from the confirmed style), count mismatches, event links not to their age's table, dates the engine cannot read.
    Never a repair (PLAN-v2 4.12).
19. **The opt-in sandbox test is read-only** (`test/sandbox/chronology.test.ts`): every row, every event and every age
    of the real chronology against the engine, with every failing row's exact text and a summary of the cell shapes it
    saw. It runs as the service user (C2d's `--configLoader runner` and read-only sandbox config); `deploy/sandbox-test.sh`
    passes a filter after `--`, so `-- chronology` runs nothing that writes.

## Costs

Measured against the mock (`test/chronology/tools.test.ts`, `check.test.ts`, `sandbox-dryrun.test.ts`):

| Tool                                  | Reads               | Writes | Where the reads go                                                   |
| ------------------------------------- | ------------------- | ------ | -------------------------------------------------------------------- |
| `calendar_date`                       | 0                   | 0      | 1 when the calendar is not cached                                    |
| `create_timeline_event`               | 10                  | 3      | plan 3 (calendar, table, Main); check 4; verify 3                    |
| `update_timeline_event` (same age)    | 9                   | 3      | plan 4 (+1 per 100 events); check 2; the row's pre-image 1; verify 2 |
| `update_timeline_event` (another age) | 18                  | 6      | plan 5; check 6; pre-images 2; verify 5                              |
| `delete_timeline_event`               | 12                  | 3      | plan 4; check 3; pre-images 2; verify 3                              |
| `create_timeline_lane`                | 2                   | 1      | the lanes; verify                                                    |
| `chronology-check`                    | 2 + 2 per age       | 0      | plus 1 per 100 events: about 18 on the test world                    |
| sandbox chronology test               | about 4 + 3 per age | 0      | plus 1 per 100 events: about 26 on the test world                    |

## Consequences

- Every chronology write needs the owner's confirmation of the chronology first; a renamed age document stops the tools
  until the owner confirms again.
- A pending chronology proposal does not conflict because another event of the same age was approved first: it lands in
  calendar order with the count as it then is (the proposal shows the place and count as planned).
- The table's date forms are the owner's: a row is written in the form the agent gave; `calendar_date` shows it first.

## Notes added by D1.1 ([ADR 0039](0039-date-styles-timeline-repair-and-etag-versions.md), 11 November 2026)

- **Decision 5's open guess is settled, and corrected:** LegendKeeper does **not** write years over 1,000 with commas on
  events (`Kumikas 1st, AA 1988119`); the owner's tables do (`AA 1,988,119`). There are two date styles: LegendKeeper's
  (`CalendarEngine.format`, `ParsedDate.formatted`) for everything compared with an event's text, and the table style
  (`DateTextStyle`, `formatTable`, `ParsedDate.text`) for table cells only. The engine used the table style for both,
  which the sandbox run reported as 242 failures (the Archon, First and Second Age events; the Third, Fourth and Fifth
  Age events passed only because their years are under 1,000). Decision 3 stands: parsing accepts a year with or
  without commas.
- **The owner's sandbox run confirmed** the engine against all 695 table rows of every age (date and KCY cells, AA,
  ranges, `Jehet 11th - 18th, 4A 424`, `Zahras 4A 367 - Attina 4A 367`), and minutes, `detail` and shape for every event.
- **Decision 18's check** now pairs rows and events in four passes and reports a row and an event that disagree about the
  date as their own kind, `date_mismatch`; a wording difference alone is not a finding. "Never a repair" stands: the
  repair is `sync_timeline_event`, as a proposal the owner approves (the dashboard's "Propose a fix").
- **Decision 13's `CHRONOLOGY_DRIFT`** refusal now points at `sync_timeline_event`, and a linked pair that disagrees
  about its date is drift, not a pair.
- **Decision 19's sandbox test** reports table and timeline drift under its own heading, apart from the engine's
  failures, and compares event text in LegendKeeper's style.
- **The Costs table** is unchanged for the three event tools; `sync_timeline_event` costs 7 reads and 1 write to create
  an event, 6 and 1 to correct one.

## Open for the owner

- The sandbox test's report confirms or corrects the learned style and the year-range end (decision 2); anything it
  finds becomes a follow-up.
