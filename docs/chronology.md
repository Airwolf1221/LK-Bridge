# The chronology: dates, qualified dates, pairing and repairs

The Universal Chronology has, for each age, a **table** (`Historical Event | Date | KCY`, in calendar order), a
**timeline** (one lane, "Historical Events") and a **count** on its Main table. **The table is the authority**; the
timeline is a view of it, and the Main count is the table's row count. The decisions are in
[ADR 0038](adr/0038-calendar-engine-and-chronology-sync.md) (the engine and the timeline tools),
[ADR 0039](adr/0039-date-styles-timeline-repair-and-etag-versions.md) (two date styles, `sync_timeline_event`) and
[ADR 0048](adr/0048-chronology-ii.md) (qualified dates, pairing, table-only rows, events without a row). The tools are in
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

### The rules, in order

1. The text before the first `;` (or the whole cell) is the date part; the rest is qualifier.
2. `c.`, `ca.`, `circa`, `approx.`, `approximately`, `about` or `around` at the start of the date part mean approximate.
3. A bracketed date (`(c. 4A 578)`, `(c. 4A 589-600)`) wins over an in-world phrase such as "House Year 8". A trailing
   bracket with no date is qualifier.
4. `After X and before Y`, `After X, before Y`, `Between X and Y`, `From X to Y`, `X to Y` and `X through … Y` are
   ranges with bounds. A year after the second end applies to both ends. Both ends have the same precision.
5. `After X`, `Following X`, `Since X`, `From X`, `X onward`, `Shortly after X`, `Less than two days after X`, `Days
following X` give an **open end**; `Before Y`, `By Y`, `Prior to Y`, `No later than Y` an **open start**. A side
   that is not a date (`After Pardis-an placement and before …`) is open.
6. `Late`, `Early`, `Mid`, `Third week of`, `First half of`, `End of` and the like qualify a year or a month. They never
   invent a month or a day; on a day they are refused.
7. `In X` and `During X` read X; words after a full date are qualifier when they hold no other date.

### Left unread, and why

| Cell                                                                       | Why                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Approximately nine months after Isar 1st, 4A 623; precise day unassigned` | a relative offset (an amount of time after a date)          |
| `Two days before Isar 3rd, 4A 619`, `Some months after the coronation`     | relative offsets                                            |
| `Isar 3rd or 4th, 4A 629`                                                  | two possible days                                           |
| `Late Kumikas 2nd, 4A 631`                                                 | "Late" qualifies a year or a month, not a day               |
| `After the Isar accords and before Selaphos 9th, 4A 632`                   | "Isar" is a month of the calendar: the bound is not certain |
| `From Isar 4A 566 to Selaphos 3rd, 4A 566`                                 | a month to a day: the precision is not certain              |
| `Spring of 4A 633`, `Shortly before the second coronation`                 | no date of the calendar the reader can place                |

Of the owner's 26 examples, 25 are read and 1 (the relative offset) stays unread.

### The KCY of a qualified row

Where a KCY is computable (a day, a month, a year or a range; not an open bound), the cell's value is checked against
the anchor's. Its words are text, not errors: `1,250,870 (approximate)`, `1,250,926 - 1,250,931`, `1,250,872 (year
only)` and `1,250,937 onward` are read for their numbers, and `Unassigned - approximate date` is fine.

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

## Pairing a row and an event

The check, the repair and the timeline tools pair them the same way: the bridge's own links; the same date with the
event's name the row's description (or its start cut short); the same date alone, one to one. A row and an event that
disagree about the date are then scored: the same start and end (two ranges) first, then the same start with a
compatible shape, then the name, then the same start alone. A candidate is taken only when it is the single best on
both sides. **A row with one date never takes a range event while a range row starts at the same minute** (and the
reverse): in the Fourth Age the Divan Heirage event is the Heirage row's, and the Viziers' vote is offered its own.
Every pair says how it was made (shown on the Chronology page).

A repair that would turn a range event into a single day, or the reverse, says so (`range → single day`) and needs a
confirmation.

## Rows that stay off the timeline

A row the owner never wants on the timeline is marked **table-only** on the Chronology page. The check stops reporting
it while its text is unchanged; if the row changes, it comes back. A table-only row is never given an event, and still
counts in the Main count.

## Events without a row

An event no row accounts for is the check's "event without a row". Its **Propose a fix** deletes only the event (no row,
no count change), and names it, its date and the three rows nearest it by date. The same through MCP:
`delete_timeline_event { event: { event_id }, orphan: true, confirm: true }`. Both refuse when the event has a row after
all, or a row could be its own.
