# The chronology: dates, qualified dates, pairing and repairs

The Universal Chronology has, for each age, a **table** (`Historical Event | Date | KCY`, in calendar order), a
**timeline** (one lane, "Historical Events") and a **count** on its Main table. **The table is the authority**; the
timeline is a view of it, and the Main count is the table's row count. The decisions are in
[ADR 0038](adr/0038-calendar-engine-and-chronology-sync.md) (the engine and the timeline tools),
[ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md) (two date styles, `sync_timeline_event`) and
[ADR 0048](adr/0048-chronology-ii.md) (qualified dates, pairing, table-only rows, events without a row; its F2.1
amendments: ties, links by choice, `create_new`, more forms) and
[ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) (same-day pairing without guessing; Last
Major Revision only for a row's date or description). The tools are in
[tools.md](tools.md), the dashboard's Chronology page in [dashboard.md](dashboard.md#chronology-v2-d1).

## Plain dates

The owner's forms, made from the calendar's own templates (for the Kumikan calendar, day `MMMM D^, E YYYY`, month
`MMMM E YYYY`, year `E YYYY`). A plain date is what the timeline tools write, and the only kind that orders a table.

| Form              | Example                                       | Stored on the timeline as |
| ----------------- | --------------------------------------------- | ------------------------- |
| a day             | `Kumikas 1st, 1A 159`                         | a day (`detail` 3)        |
| a year            | `4A 881`                                      | a year (`detail` 1)       |
| an unknown day    | `Unknown, 4A 101`                             | a year (`detail` 1)       |
| a month           | `Zahras 4A 367`                               | a month (`detail` 2)      |
| a range           | `Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102` | a range of days           |
| days of one month | `Jehet 11th - 18th, 4A 424`                   | a range of days           |
| across months     | `Isar 20th - Pahan 31st, 4A 32`               | a range of days           |
| months            | `Kumikas - Azaakh, 4A 180`                    | a range of months         |
| months, in full   | `Zahras 4A 367 - Attina 4A 367`               | a range of months         |
| years             | `4A 881 - 4A 900`                             | a range of years          |

Matching ignores case, an ordinal suffix or none, extra spaces and the kind of dash, and reads a year with or without
thousands commas (the tables write `AA 1,988,119`, LegendKeeper `AA 1988119`). `Unknown` alone is refused.

## Qualified dates (v2 E6)

Some rows give their date with its declared precision. They are the owner's on purpose, never errors, and **the table is
never rewritten**: the bridge reads such a cell by its **anchor**, the calendar date it is pinned to, and keeps
everything else as the **qualifier**, verbatim. The reading is used to pair the row with its timeline event, to make
that event, and to check the row's KCY. It is not used to order the table: the owner places qualified rows.

A reading must be **certain**. Anything else stays unreadable, and the check says why.

### The forms read (examples from Arkona's tables)

| Cell                                                                                       | Read as                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `c. 4A 563; exact date unresolved`                                                         | year 4A 563, approximate                                   |
| `c. 4A 564-565; exact date unresolved`                                                     | years 4A 564 – 4A 565, approximate                         |
| `4A 565; exact date unresolved`                                                            | year 4A 565                                                |
| `Late 4A 565; exact date unresolved`                                                       | year 4A 565 ("Late" kept as qualifier, not a month)        |
| `Third week of Isar, 4A 566; exact day unresolved`                                         | month Isar 4A 566 (the week is qualifier)                  |
| `Isar-Selaphos, 4A 566; exact sessions undated`                                            | months Isar – Selaphos 4A 566                              |
| `Approximately House Year 8 (c. 4A 578); exact dates unresolved`                           | year 4A 578, approximate (the bracketed era date wins)     |
| `Approximately House Years 19-30 (c. 4A 589-600); …`                                       | years 4A 589 – 4A 600, approximate                         |
| `After Pardis-an placement and before Selyros 40th, 4A 605; …`                             | before Selyros 40th, 4A 605 (an open start)                |
| `After Selaphos 35th, 4A 617 and before Surion 10th, 4A 618; …`                            | range Selaphos 35th, 4A 617 – Surion 10th, 4A 618          |
| `After Isar 6th and before Zarzakh 29th, 4A 610; …`                                        | range Isar 6th – Zarzakh 29th, 4A 610 (the year is shared) |
| `Between Isar 30th and Azah 27th, 4A 607; …`                                               | range Isar 30th – Azah 27th, 4A 607                        |
| `From Surion 30th, 4A 618 to Isar 3rd, 4A 619; …`                                          | range                                                      |
| `Isar 3rd, 4A 619 to Selaphos 1st, 4A 620`                                                 | range                                                      |
| `Isar 3rd, 4A 619 through the final personal debrief Camue 8th, 4A 624; …`                 | range Isar 3rd, 4A 619 – Camue 8th, 4A 624                 |
| `Isar 13th, 4A 607; Divan post follows`                                                    | day Isar 13th, 4A 607                                      |
| `Isar 30th, 4A 607 (start of first MSO investigator period)`                               | day Isar 30th, 4A 607                                      |
| `Kumikas 25th, 4A 630; first coronation proceeding, approximately four hours`              | day Kumikas 25th, 4A 630 (not approximate: after the `;`)  |
| `Camue 10th, 4A 624 departure; Sarayi Halid arrival … afterwards, precise day unassigned`  | day Camue 10th, 4A 624                                     |
| `Less than two days after Isar 6th, 4A 610; exact trial day unresolved`                    | after Isar 6th, 4A 610 (an open end)                       |
| `From Kumikas 25th, 4A 630 through the subsequent reign; no exact peace-onset date or end` | from Kumikas 25th, 4A 630 (an open end)                    |
| `By 4A 623; exact comparison date recorded separately`                                     | by 4A 623 (an open start)                                  |
| `Days following Isar 19th, 4A 613; exact date unresolved`                                  | after Isar 19th, 4A 613 (an open end)                      |
| `After Zahras 15th, 4A 220, before Camue 33rd, 4A 325; precise date unresolved`            | range Zahras 15th, 4A 220 – Camue 33rd, 4A 325             |
| `In 4A 645; exact month and day unassigned`                                                | year 4A 645                                                |

**More forms (v3 F2.1, the owner, 16 November 2026).** Each is read only when it is unambiguous; anything else stays
unread with its reason.

| Cell                                                        | Read as                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `On or after Selaphos 9th, 4A 643` (Arkona row 443)         | from Selaphos 9th, 4A 643 (an open end), as `After X`                         |
| `On or before Selaphos 9th, 4A 643`                         | up to and including Selaphos 9th, 4A 643 (an open start), as `Before X`       |
| `Before or during the third week of Isar, 4A 566` (row 288) | an open start ending at the end of Isar 4A 566 (the event: the month)         |
| `During or after Isar 4A 566`                               | an open end from the start of Isar 4A 566                                     |
| `4A 614-617`, `Across 4A 614-617; …` (row 340)              | years 4A 614 – 4A 617 ("Across" is a qualifier like "From")                   |
| `Early 4A 621`, `Mid 4A 621`, `Late 4A 565; …`              | the year, approximate (a year event; its name tail carries the cell as usual) |
| `Late 4A 621 onward` (row 358)                              | an open end from 4A 621, approximate                                          |
| `Camue 1st, 5A 1 (4A 950)`                                  | day Camue 1st, 5A 1 (the gloss names the same instant, so it is qualifier)    |
| `Camue 4A 624 - Kumikas 25th, 4A 630`, `… to …`             | each end at its own precision; the event takes the coarser (month) detail     |

`4A 614-617` needs the second part to be a bare number greater than the first, in the same era. A bracketed gloss in
another era is ignored for the anchor only when both read to the same instant (a year: the same KCY; a month or day: the
same minutes); otherwise the row stays unread, as before.

### The rules, in order

1. The text before the first `;` (or the whole cell) is the date part; the rest is qualifier.
2. `c.`, `ca.`, `circa`, `approx.`, `approximately`, `about` or `around` at the start of the date part mean approximate.
3. A bracketed date (`(c. 4A 578)`, `(c. 4A 589-600)`) wins over an in-world phrase such as "House Year 8". A trailing
   bracket with no date is qualifier.
4. `After X and before Y`, `After X, before Y`, `Between X and Y`, `From X to Y`, `X to Y` and `X through … Y` are
   ranges with bounds. A year after the second end applies to both ends. Both ends have the same precision.
5. `After X`, `Following X`, `Since X`, `From X`, `On or after X`, `X onward`, `Shortly after X`, `Less than two days
after X`, `Days following X` give an **open end**; `Before Y`, `By Y`, `Prior to Y`, `No later than Y`, `On or before
Y` an **open start**. `Before or during X` is an open start ending at the end of X; `During or after X` an open end
   from its start. A side that is not a date (`After Pardis-an placement and before …`) is open.
6. `Late`, `Early`, `Mid`, `Third week of`, `First half of`, `End of` and the like qualify a year or a month. They never
   invent a month or a day; on a day they are refused. `Early`, `Mid` and `Late` make a year approximate.
7. `In X`, `During X` and `Across X` read X; words after a full date are qualifier when they hold no other date.
8. A range whose ends differ in precision is read with each end at its own; its event takes the coarser detail. A
   bracketed gloss in another era that names the same instant is qualifier.

### Left unread, and why

| Cell                                                                       | Why                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Approximately nine months after Isar 1st, 4A 623; precise day unassigned` | a relative offset (an amount of time after a date)          |
| `Two days before Isar 3rd, 4A 619`, `Some months after the coronation`     | relative offsets                                            |
| `Isar 3rd or 4th, 4A 629`                                                  | two possible days                                           |
| `Late Kumikas 2nd, 4A 631`                                                 | "Late" qualifies a year or a month, not a day               |
| `After the Isar accords and before Selaphos 9th, 4A 632`                   | "Isar" is a month of the calendar: the bound is not certain |
| `Isar 4A 566 to Isar 3rd, 4A 566`                                          | a range that ends in the month it begins                    |
| `Camue 1st, 5A 1 (4A 949)`                                                 | the gloss names another instant                             |
| `After the Altun Sahra War in 4A 633`                                      | an event used as a date                                     |
| `Spring of 4A 633`, `Shortly before the second coronation`                 | no date of the calendar the reader can place                |

Of the owner's 26 examples, 25 are read and 1 (the relative offset) stays unread. (`From Isar 4A 566 to Selaphos 3rd,
4A 566`, left unread in v2 E6 as a month to a day, is read since v3 F2.1 with each end at its own precision.) The reader
never works out a relative offset (`nine months after …`) or an event used as a date.

### The KCY of a qualified row

Where a KCY is computable (a day, a month, a year or a range; not an open bound), the cell's value is checked against
the anchor's. Its words are text, not errors: `1,250,870 (approximate)`, `1,250,926 - 1,250,931`, `1,250,872 (year
only)` and `1,250,937 onward` are read for their numbers, and `Unassigned - approximate date` is fine.

**A range inside one KCY** (v3 F2.1, the owner, 16 November 2026: `Kumikas 17th - 24th, 4A 611`). The confirmed style is
now the single value, `1,250,918` (the default for a project that has not confirmed its style). `1,250,918 - 1,250,918`
is accepted too. Neither is reported as "written differently"; another value is still a wrong KCY.

## The timeline event of a qualified row

`sync_timeline_event` (and the dashboard's "Propose a fix") makes it from the anchor:

| Reading       | Event                                              |
| ------------- | -------------------------------------------------- |
| a year        | a year (`detail` 1)                                |
| a month       | a month (`detail` 2)                               |
| a day         | a day (`detail` 3)                                 |
| a range       | from its start to its end, at its precision        |
| an open start | one point at the known bound (`By 4A 623`: 4A 623) |
| an open end   | one point at the known bound (`After X`: X)        |

LegendKeeper's events have no text but their name (`detail` is the precision, a number). So a qualified row's event is
named with the row's opening words, as every event is, then `–` and the row's Date cell as written: `The Menkhet
charter is sealed – c. 4A 563; exact date unresolved`. The timeline then shows the owner's own wording, "after" or
"before" for an open bound, and `c.` or `Approximately` for an approximate date. Plain rows' events are named as before.

**The tail follows the row** (v3 F2, [ADR 0049](adr/0049-v3-f2-last-major-revision-default-project-and-staging.md)
decision 1). The link between a row and its event records the tail the bridge wrote. When the owner later edits the Date
cell, the next sync or "Propose a fix" that changes the event's date also rewrites the tail (after the name's **last**
`–`) to the cell, in the same proposal (`name: "… – c. 4A 563; exact date unresolved" → "… – Isar 3rd, 4A 563; exact
day disputed"`); a row that has become plain drops the tail and its `–`. If only the wording changed (the date did not),
the check reports **name drift** on the row, fixed by a name-only update. The opening words are never touched, and an
unlinked event, an event the owner renamed, or a `–` written by anyone else is never treated as the bridge's tail.

## Pairing a row and an event

The check, the repair and the timeline tools pair them the same way: the bridge's own links; the same date with the
event's name the row's description (or its start cut short); the same date alone, one to one. A row and an event that
disagree about the date are then scored: the same start and end (two ranges) first, then the same start with a
compatible shape, then the name, then the same start alone. A candidate is taken only when it is the single best on
both sides. **A row with one date never takes a range event while a range row starts at the same minute** (and the
reverse): in the Fourth Age the Divan Heirage event is the Heirage row's, and the Viziers' vote is offered its own.
Every pair says how it was made (shown on the Chronology page).

### Ties (v3 F2.1)

The owner's Arkona run of 16 November 2026 found rows refused because several rows and one event shared a day. The
pairing now settles every tie it safely can, and the owner settles the rest on the dashboard:

- **A plain row beats a qualified anchor.** An event whose date and shape exactly equal a plain row's date is that row's
  before any qualified row anchored on the same day (`Before Selyros 40th, 4A 605; …`); the pair says **plain row
  preferred over qualified anchor**. The qualified rows are then rows without an event, each offered a new event of its
  own (named with its Date-cell tail), as the Viziers' vote is in the Divan Heirage case. This applies when the plain
  rows of that day are exactly as many as its events.
- **Two plain rows and one event on a day**: the event's name decides, if it names exactly one of them; otherwise it
  stays a tie. A cut-short name that names both decides nothing.
- **Ranges that start the same day** (the Divan Heirage against the other ranges starting on Isar 3rd, 4A 619): the one
  whose end falls in the same year as the event's end wins (**the same start and final year**).
- **A caller's choice is remembered.** `sync_timeline_event` with `event_id` on an event that already agrees records the
  row–event link (`pairedBy: "chosen by the caller"`) and answers `linked`. It is a bridge-side record with no
  LegendKeeper write, audited as a chronology change, and a proposal (summary `link row … to event …`) at every scope
  because it changes what the check reports (CR-2026-11-R2, R2-11: at scope `write` a direct link was never on the
  Review page; ADR 0056 decision 3). The check honours stored links first, as it does the links the bridge makes, so a
  later tie on that day no longer touches the pair.
- **None of these: make a new event.** `create_new: true` (never with `event_id`) creates the row's event even though
  candidates exist; the proposal names the candidates it passed over.
- **Refusals name the candidates.** `PAIRING_AMBIGUOUS` gives every candidate's name, date and id in its message, not
  only in its details. On the Chronology and Audits pages a refused fix shows each candidate with **Use this event**,
  and one **Make a new event** button.
- **A row by its opening words.** `row: { date, description }` accepts a description that is a prefix of exactly one row
  of that date (at least 20 characters, compared after trimming and collapsing whitespace). An exact match still wins;
  an ambiguous prefix is refused with the rows it matched (`ROW_AMBIGUOUS`); a shorter one is refused
  (`ROW_PREFIX_TOO_SHORT`); no match is `ROW_NOT_FOUND`, with the rows of that date in the message.

Anything still tied is refused, with the candidates shown as above.

### Same-day pairing without guessing (v3 F3c)

[ADR 0051](adr/0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 2. Up to F2.1 a day with as
many rows as events (two or more of each) was paired one to one in table order: a guess. Now, inside such a day:

1. **a unique name match pairs first**: the event's name names exactly one row of that date (F2.1's rule);
2. **stored links are respected** (the bridge's own, and the ones the owner chose with **Use this event** or **Pair
   with this row**);
3. **what is left pairs by the date only when it is one row and one event.** Two or more rows and as many events left
   on that day are a **tie**: each event is reported as an **Event in a tie** with its candidate rows and **Pair with
   this row**, and `sync_timeline_event` on one of the rows is refused with `PAIRING_AMBIGUOUS`, naming the candidates
   (**Use this event**, **Make a new event**). Never paired by order.

A day with exactly one row and one event is unchanged. "A plain row beats a qualified anchor" (above) likewise applies
only to one plain row and one event. Once the owner pairs one row of a tie, the one row and one event left are unique
and pair by the date at the next check.

A repair that would turn a range event into a single day, or the reverse, says so (`range → single day`) and needs a
confirmation.

## Rows that stay off the timeline

A row the owner never wants on the timeline is marked **table-only** on the Chronology page. The check stops reporting
it while its text is unchanged; if the row changes, it comes back. A table-only row is never given an event, and still
counts in the Main count.

## Events without a row, and events in a tie

An event no row accounts for is the check's "event without a row". Its **Propose a fix** deletes only the event (no row,
no count change), and names it, its date and the three rows nearest it by date. The same through MCP:
`delete_timeline_event { event: { event_id }, orphan: true, confirm: true }`. Both refuse when the event has a row after
all, or a row could be its own.

**An event with candidate rows is not an event without a row** (v3 F2.1, the owner's report of 16 November 2026: all
four of Arkona's "events without a row" were real events caught in ties). An unpaired event that any unpaired row could
own (the same date, the same start, or its name) is reported as **Event in a tie** (`event_in_tie`; in the audits
`chronology_event_in_tie`). It lists its candidate rows (date and opening words) with **Pair with this row** for each,
which is `sync_timeline_event` with that row and the event's id. It is never offered for deletion. A delete reached
anyway is refused: "This event is not an orphan: N rows of the table could be its own (…). Pair it with one instead of
deleting it."
