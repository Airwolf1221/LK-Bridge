# ADR 0048: Chronology II: qualified dates read by their anchor, scored pairing, table-only rows, events without a row, and named low-level proposals

- Status: **Accepted** (v2 E6, "Chronology II", also called v3 F1; built 16 November 2026, accepted by the owner the same
  day). The owner's decisions on the three questions: **(A)** the `with-date` naming stays, its separator `–`
  unchanged; **(B)** an unreadable row is reported once; **(C)** table-only rows take no part in pairing. Amended by
  [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 1: the date tail the bridge wrote
  into a linked event's name now follows the row's Date cell (decision 3's "never renames" no longer holds for that
  tail). Amended by [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 2 (same-day
  pairing without guessing). Amended by the **F2.1 amendments** below (v3 F2.1, 16 November 2026: ties, links by choice, `create_new`,
  events in a tie, six more date forms, the KCY of a range inside one year).
- Builds on: [ADR 0038](0038-calendar-engine-and-chronology-sync.md) (the engine, the chronology jobs),
  [ADR 0039](0039-date-styles-timeline-repair-and-etag-versions.md) (the two date styles, `sync_timeline_event`, the
  four-pass pairing, "Propose a fix"), [ADR 0044](0044-audits.md) (the audits' chronology fold-in) and
  [ADR 0046](0046-e4-owner-decisions.md) decision 12 (the owner's rule of 15 November: read a qualified value by its
  anchor, never rewrite the page).
- Migration: `2700` (the table-only marks). No decision in PLAN.md or PLAN-v2.md changes.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike or round-trip script. Every test runs against the mock LegendKeeper and fixtures.

## Context

Arkona's Universal Chronology (live since 15 November 2026: six age tables, six timelines). After E5's fixes its check
reported:

- **63 rows whose dates the engine could not read**, each reported twice (as `unreadable_date` and as
  `row_without_event`). They are the owner's deliberate declared-precision dates (`c. 4A 563; exact date unresolved`,
  `After Isar 6th and before Zarzakh 29th, 4A 610; …`, `Approximately House Year 8 (c. 4A 578); …`), not errors. The owner
  decided on 15 November that the engine reads a qualified date by its anchor, without ever rewriting the table's text.
- **One wrong pairing** in the Fourth Age. The row "The Menkheti Viziers vote to admit Mehrana to active Divan Heirage…"
  (`Isar 3rd, 4A 619`) was paired with the event for the whole Divan Heirage (`Isar 3rd, 4A 619 – Camue 5th, 4A 624`),
  whose own row (`Isar 3rd, 4A 619 through the final personal debrief Camue 8th, 4A 624; …`) could not be read. "Propose
  a fix" on that date mismatch would have shrunk the range to one day.
- **Events without a row had no fix.** `delete_timeline_event` refuses them (`CHRONOLOGY_DRIFT`) and
  `sync_timeline_event` starts only from a row. In E5 the 11 superseded events were deleted through `lk_api_write
deleteEvent`, and those proposals showed only ids (`deleteEvent on aeanf5w1 › vuxddr…`).

## Decision 1: qualified dates are read by their anchor (src/calendar/qualified.ts)

A Date cell the plain forms (ADR 0038 decision 3) cannot read is given to the **qualified reader**. Its result is a
structured reading: `shape` (`day`, `month`, `year` or `range`), `start` and `end` (LegendKeeper minutes), `precision`,
`approximate`, `openStart` or `openEnd`, the **`qualifier`** (everything outside the anchor, verbatim, the anchor's own
text replaced by `…`, so it can be shown and audited), the `anchorText` (the anchor as the engine writes it), the
anchor's slices as they stand in the cell, and the anchor read as an ordinary date (`date`: what a timeline event takes).

The rules, in order. **A reading must be certain**; anything else stays unreadable and the result says why:

1. The text before the first `;` (or the whole cell) is the date part; the rest is qualifier.
2. `c.`, `ca.`, `circa`, `approx.`, `approximately`, `about`, `around` at the start of the date part mean approximate.
   After the `;` they describe something else (`Kumikas 25th, 4A 630; first coronation proceeding, approximately four
hours` is not approximate).
3. A bracketed date (`(c. 4A 578)`, `(c. 4A 589-600)`) wins over an in-world phrase outside it (`House Year 8`); a date
   both inside and outside the brackets is ambiguous; a trailing bracket with no date is qualifier.
4. Relative offsets are never read: an amount of time before or after a date (`about nine months after Isar 1st, 4A
623`, `two days before …`, `some months after …`, `several years before …`).
5. Ranges with bounds: `After X and before Y`, `After X, before Y`, `Between X and Y`, `From X to Y`, `X to Y`, `X
through … Y` (the words before Y are qualifier). A trailing year shared by both ends applies to both (`After Isar 6th
and before Zarzakh 29th, 4A 610`); a leading one does not. A year range may be written with one era (`4A 564-565`).
   Both ends must have the same precision and the range must run forwards.
6. Open dates: `After X`, `Following X`, `Since X`, `From X` (with no end, or `through` words with no date), `X onward`,
   `No earlier than X`, `Shortly after X`, `Less than two days after X` (bounded, so certainly after X), `Days following
X` give an **open end**; `Before Y`, `By Y`, `Prior to Y`, `No later than Y` an **open start**. An end that is not a
   date (`After Pardis-an placement and before Selyros 40th, 4A 605`) leaves that side open. The reading is the bound.
7. `Late`, `Early`, `Mid`, `Mid-`, `Third week of`, `First half of`, `End of` and the like qualify a year or a month and
   never invent a month or a day; on a day they are refused.
8. `In X`, `During X` read X; trailing words after a full date (`Camue 10th, 4A 624 departure`) are qualifier when they
   hold no other date; `Isar, 4A 566` reads as `Isar 4A 566`.

A month or era word the reader cannot place is never guessed (`After the Isar accords and before …` stays unread: "Isar"
is a month of the calendar and also a place). The anchor is always read by the calendar's own forms (the parser's new
`leadingDate` and `trailingDate`, strict reads of a date at either end of a text): nothing about Arkona is in the reader.

**The table is never rewritten.** A row keeps its `date` (the plain reading, or null); the qualified one is `reading`;
`eventDate` is whichever exists. The reading is used for **pairing, the row's timeline event and the KCY check**. It is
not used for calendar order: qualified rows are passed over when a new row is placed and by the out-of-order check, as
before (the owner orders them).

Of the owner's 26 example cells, **25 are read and 1 stays unread** (the relative offset). The table of forms is in
[chronology.md](../chronology.md); every one is a table-driven test (`test/calendar/qualified.test.ts`).

## Decision 2: the KCY of a qualified row; a row reported once

- **KCY.** Where a KCY is computable (a day, a month, a year or a range, not an open bound), the cell's value is checked
  against the anchor's KCY. Its words are text, not errors: `1,250,870 (approximate)`, `1,250,926 - 1,250,931`,
  `1,250,872 (year only)`, `1,250,937 onward` are read for their numbers; a cell with no number (`Unassigned -
approximate date`) is fine; a cell with more numbers than one value or range is not checked. A qualified Date cell is
  never reported as "written differently" (`date_text_differs`).
- **Once.** A row whose date stays unreadable is reported only as `unreadable_date`, with its reason. It is no longer
  also a `row_without_event` (no fix could make its event). Every `row_without_event` is now fixable. On Arkona this
  means: before, 63 `unreadable_date` and the same 63 rows again as `row_without_event`; after, `unreadable_date` falls
  to the uncertain ones and `row_without_event` becomes exactly the rows whose events "Propose a fix" can make (plus any
  plain row without an event, such as the Viziers' vote below). On the Arkona-shaped fixture of 63 rows: **54 certain,
  9 unreadable** (`test/chronology/qualified.test.ts`). **Owner decided** (B, 16 November 2026): reported once, as built.

## Decision 3: a qualified row's timeline event

`sync_timeline_event` and "Propose a fix" make a qualified row's event from its anchor, in the existing write style
(ADR 0038 decision 2): a **year** gives a year-detail event (`detail` 1), a **month** month detail (2), a **range** a
start-to-end event (the end at the first minute of the last day, month or year), and an **open start or end** a single
point at the known bound (`By 4A 623` at 4A 623, year detail; `Days following Isar 19th, 4A 613` at that day).

**The event's name, and how the timeline shows a qualification.** LegendKeeper's events have no text field but the
`name`: the spec's `Event` is `id`, `laneId`, `type`, `name`, `start`, `end`, `detail`, `uri`, `color`, `iconGlyph`,
`imageUrl`, `isHidden`, `showOnCalendar` (and the computed `formattedStart` and `formattedEnd`), and **`detail` is the
precision, a number** (1 year, 2 month, 3 day, 4 time), not a text. There is no "detail text" to start with the row's
Date cell. So, inventing no field:

- A **plain** row's event is named as now: the row's opening words (`shortName`, up to 100 characters).
- A **qualified** row's event is named with the row's opening words as now, then `–` and the row's **Date cell
  verbatim**: `The Menkhet charter is sealed – c. 4A 563; exact date unresolved`. The timeline then shows the owner's own
  wording, and "after" or "before" for an open bound (the cell says it: `By 4A 623; …`, `Days following …`).
  Approximate events are marked consistently: every qualified event, and only those, carries its cell in the same
  place, and an approximate one's cell begins with the owner's own `c.` or `Approximately`. The name is capped at
  LegendKeeper's 500 characters (the cell cut with `...` if it must be).
- On the timeline a qualified event therefore shows its anchor's precision (a year bar, a month bar, a range, one point)
  and its name with the date wording; its link (`uri`) opens the age's table, where the row is.
- Pairing reads past the tail: `namesMatch` compares the name before `–` with the row's description. The bridge links
  every event it makes, so a pair it made never depends on the name. `sync_timeline_event` still never renames an
  event, so existing events keep their names. (Amended by ADR 0049 decision 1: a tail the bridge wrote follows the
  row's Date cell; nothing else about a name changes.)

**Owner decided** (A, 16 November 2026): this naming, `with-date`, with the separator `–`, stays. The `'plain'`
alternative is removed from the code.

## Decision 4: the table-only mark

A row the owner never wants on the timeline is marked **table-only** on the Chronology page, per row id, with the row's
three cells as they are then (and an optional reason). Audited `chronology.table_only` (set and cleared). Stored in
`chronology_table_only` (migration 2700).

- **It holds while the row is unchanged**, as an audit acknowledgement does (ADR 0044): the cells' fingerprint must match.
  If the row changes or goes, the mark no longer holds and the row is back in the check (the page shows the lapsed mark).
- **Hidden from the check**: no finding for that row (unreadable date, row without an event, KCY, order).
- **Left out of pairing** (**owner decided**, C, 16 November 2026): a table-only row takes no event (an event only it could own becomes an event without a row,
  offered for deletion). It still counts as a rival in the shape guard (decision 5). `sync_timeline_event` refuses it
  (`ROW_TABLE_ONLY`).
- **The Main count is still the table's row count**, table-only rows included.

## Decision 5: scored pairing, and how each pair was made

`matchRowsAndEvents` keeps its first three passes (links; the same date with the name; the same date alone, one to one)
and replaces the fourth with a **scored** pass for a row and an event that disagree about the date: the same start and
end (a range against a range, only the precision differs) scores highest, then the same start with a compatible shape
(both ranges, or both single dates), then the event's name, then the same start alone (one a range, the other a single
date); a name match adds to a date match. A candidate is taken only when it is **the one best candidate on both sides**;
a tie stays unpaired, never guessed.

**The guard (the Divan Heirage case):** a row with a single date never takes a range event while a range row of the age
starts at the same minute, and a range row never takes a single-date event while a single-date row starts there. The
fixture is the owner's: with the Heirage row read by its anchor, the event pairs with it (`start+shape`; the fix corrects
the end from Camue 5th to Camue 8th) and the Viziers' vote is offered its own one-day event.

Every pair records how it was made (`pairedBy`: `link`, `date+name`, `date`, and for a mismatch `start+end`,
`start+shape`, `name`, `start`). The check stores each age's pairs and their counts; the Chronology page shows them (the
**Ages** table and **Every pair**), and each date mismatch says how it was paired.

## Decision 6: a fix that changes an event's shape is never one click

A date-mismatch repair that would turn a range event into a single date, or the reverse, carries a warning in plain
words (`range → single day`, `single day → range`) on the finding, in the plan (`shapeChange`) and in the proposal's
summary. It needs a confirmation: the dashboard's **Propose a fix** (on the Chronology page and the Audits page) asks
first and sends `confirmShapeChange: true`; `sync_timeline_event` refuses with `SHAPE_CHANGE_UNCONFIRMED` until repeated
with `confirm_shape_change: true` (a dry run shows the plan either way). Without it nothing is proposed.

## Decision 7: events without a row

"Propose a fix" on an `event_without_row` (the Chronology page and the audits, fix `chronology_orphan`) proposes deleting
that event (src/chronology/orphan.ts). The proposal names the event, its date and the **rows nearest it by date, up to
3, with their opening words** (a range that holds the event's date first), so the owner can see what replaced it.

- Only the event: no row (it has none), no count change (the count is the table's row count).
- Refused when the event is paired with a row after all (`EVENT_HAS_ROW`) or an unpaired row could be its own: the same
  date, the same start or its name (`PAIRING_AMBIGUOUS`, with the candidates). A deletion is never made beside a
  possible pair.
- The ordinary chronology job (ADR 0038 decision 8): the age's table and timeline locked; inside the lock the table must
  still have no row that could be the event's (a new `row.orphan` assertion: rows that were paired elsewhere or
  table-only when planned may stay as they were), and the event must be exactly as read; `deleteEvent`, journalled with
  the event as its pre-image; the verify; the record.
- Canon: an event delete is a content edit (ADR 0036 decision 6, option (a)): an ordinary proposal.
- **The high-level path:** `delete_timeline_event { event: { event_id, age? }, orphan: true, confirm: true }`, rather
  than a new tool: the tool list stays at 62 (the E3 review asked for fewer, not more), and the delete tool is where an
  agent looks. Without `age`, every age's timeline is searched. The bridge guide's chronology section says so.

## Decision 8: low-level proposals are named (src/policy/op-names.ts)

A proposal made by `lk_api_write` or `lk_api_batch` names what each operation touches, at capture: the **page** and the
**document** (the repository tree, free), and the **entity** from the pre-image the capture reads anyway: an event's
name and date, a map feature's type and name, a lane's name, a block's first words, a property's title, a sidebar or
infobox row's key and value with its property's title (one cheap read, `getProperty` or `getBlockProperty`, once per
property). The summary (`Proposed deleteEvent: event “The Long Winter” (Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102) in
“Fourth Arkonan Age - Timeline” on “Universal Chronology” (chrono01 › efour001)`), **Pages affected** and each
operation's card on the dashboard show them. **A failed lookup never blocks the proposal**: what cannot be named is
left out and the ids stand in for it. High-level tools give their own summaries and are unchanged (no extra read).

The brief's "setPropertyRow" is not a LegendKeeper operation; it is taken to mean the property-row writes
(`createPropertyRow`, `updatePropertyRow`, `deletePropertyRow`), which are named as above.

## Decision 9: the audits

`chronology_event_without_row` gains the fix `chronology_orphan`; a shape-changing `chronology_date_mismatch` fix carries
`confirm: { shapeChange }`, and the audits' "Propose a fix" takes `confirmShapeChange`. A chronology refusal raised
through the audits page is now a 409 with its code and reason (it was a 500).

## Consequences

- On the test world nothing changes for clean rows: it has no qualified dates, and its pairs are made by the first three
  passes as before.
- On Arkona the check's `unreadable_date` falls to the dates the reader cannot be certain of, each with its reason;
  `row_without_event` lists the rows whose events can now be made. Their fixes are ordinary proposals.
- An event the bridge makes for a qualified row carries the row's Date cell in its name (decision 3).
- Costs, measured against the mock: `delete_timeline_event` with `orphan: true` reads 3 to plan (the calendar, one page of
  events per 100, the table), then the table and the event in the lock, the event's pre-image and 1 to verify: **8 reads
  and 1 write**, then the change snapshot's re-read of the timeline that follows every timeline write since E1a (3 reads
  and 1 per 100 events). Its "Propose a fix" costs the 3 planning reads. Marking a row table-only reads 2 (the calendar,
  the table). A low-level proposal of a sidebar row costs 1 more read per property; nothing else does.

## Owner's decisions (16 November 2026)

- (A) The qualified event's name (decision 3): `with-date`, separator `–` unchanged.
- (B) An unreadable row reported once (decision 2).
- (C) Table-only rows take no part in pairing (decision 4).
- After deploying: the test world's check (nothing should change for its clean rows); Arkona's check and its counts;
  then a few qualified-row events approved one shape at a time (year, range, open start, approximate) and looked at on
  the timeline in the app before the rest; and the Divan Heirage pair (the range row with its event, the vote with its
  own or offered a new one).

## F2.1 amendments (v3 F2.1, 16 November 2026)

The owner's Arkona run of 16 November 2026, after F1: every "Propose a fix" worked except on open-start rows, refused
with `PAIRING_AMBIGUOUS`. On the Fourth Age table (`jhk6xcal`) three rows share Selyros 40th, 4A 605: two qualified rows
(`After Pardis-an placement and before Selyros 40th, 4A 605; …`, `Before Selyros 40th, 4A 605; …`) whose open-start
anchors are that day, and the plain row `Selyros 40th, 4A 605`. The one event of that day plainly belongs to the plain
row. Pass 3 found three rows and one event and paired nothing; the plain row was refused too; choosing the event with
`event_id` answered `nothing_to_do` and recorded nothing, so the next check tied again; naming the row by its opening
words failed with `EVENT_NOT_FOUND`. And all four of Arkona's "events without a row" (the 4A 605 return, the 4A 613
wedding, the Divan Heirage, the 4A 630 abdication) offered a delete that was then refused: they were events caught in
ties. No new ADR and no migration: the row–event link table (`chronology_links`) holds a link the caller chose as it
holds one the bridge made.

**F2.1-1. A plain row beats a qualified anchor** (decision 5, amended). After pass 3, a date where rows and events are not
equally many is settled by its plain rows: when they are exactly as many as its events, they take them (one to one, as
pass 3 does), and the qualified rows anchored on that day are left unpaired and offered new events, as the Viziers' vote
is in the Divan Heirage case. The pair records `pairedBy: plain` ("plain row preferred over qualified anchor"). Pass 2 now
takes a name only when it names exactly one row of that date, and that row's name matches one event (two plain rows and
one event: the name decides, or nothing does; a cut-short name that names both decides nothing). In the scored pass, two
ranges of the same start are told apart by the year their ends fall in (`start+year`, between `start+end` and
`start+shape`; named only where it decided). The Divan Heirage guard and every earlier ordering test stand.

**F2.1-2. A caller's choice is remembered** (decision 5 and ADR 0039's `sync_timeline_event`). `event_id` on an event that
already agrees records the row–event link (`pairedBy: "chosen by the caller"`) and answers `linked` (`action: "link"`),
not `nothing_to_do`. It is a bridge-side record with no LegendKeeper write: the job holds the age's table and timeline,
compares the row (`row.assert`) and the event (a new `event.assert`, not a write) inside the lock, and its record's
completion stores the link; the record audits it. At scope `propose` it is still ONE proposal (summary `link row … to
event …`), because it changes what the check reports: bridge code may force a proposal for a job whose only change is its
record (`src/jobs/engine.ts`: `forceProposal` now also applies when a `bridge.record` step is the change). The check
honours stored links first, as before. The orphan path is the same: "Pair with this row" on an event in a tie makes the
link (or the correction) for the row the owner picks, so the event stops being in a tie.

**F2.1-3. "None of these: make a new event."** `create_new: true` on `sync_timeline_event` (never with `event_id`:
`INVALID_PARAMS`) creates the row's event even though candidates exist; the answer (`passedOver`), the proposal's summary
and its head name the candidates it passed over. A row that is paired already is refused (`ROW_HAS_EVENT`).

**F2.1-4. Refusals show the candidates.** `PAIRING_AMBIGUOUS` names every candidate's name, date and id in its message,
not only in its details. On the Chronology page and the Audits page a refused fix shows each candidate event with **Use
this event** (F2.1-2) and one **Make a new event** button (F2.1-3), so the owner resolves a tie without an assistant. A
choice that changes the event's shape asks first, as decision 6 requires.

**F2.1-5. A row by its opening words.** In `row: { date, description }` a description that is a prefix of exactly one row
of that date (at least 20 characters, compared after trimming and collapsing whitespace; a trailing `…` or `...` is
ignored) finds the row. An exact match still wins. An ambiguous prefix is refused with the rows it matched
(`ROW_AMBIGUOUS`); a prefix under 20 characters that begins a row is refused (`ROW_PREFIX_TOO_SHORT`); nothing matching
is `ROW_NOT_FOUND` (it was `EVENT_NOT_FOUND`), with the rows of that date in its message and details. A missing `row_id`
is `ROW_NOT_FOUND` too.

**F2.1-6. Other ties.** Settled: two plain rows and one event (the name, F2.1-1); a plain row against an open-end (or any
qualified) row anchored on the same day (F2.1-1); ranges of the same start (F2.1-1, `start+year`). Still refused, with the
candidates shown (F2.1-4): two or more plain rows and fewer events with no deciding name; qualified rows alone on a day
with fewer events; ranges of the same start ending in the same year. Kept from ADR 0039 (not a refusal): a day with as
many rows as events is paired one to one in table and timeline order. (Amended by [ADR 0051](0051-v3-f3c-major-revisions-same-day-ties-and-image-restore.md) decision 2: two or
more rows and as many events left on a day after the links and unique names are a tie, never paired by order.)

**F2.1-7. Six more certain forms** (decision 1, amended; the owner, 16 November 2026). Each reads only when unambiguous:
`On or after X` / `On or before X` (as `After X` / `Before X`; Arkona row 443); `Before or during X` (an open start ending
at the end of X) and `During or after X` (an open end from its start), X any known form such as `the third week of Isar,
4A 566` (row 288); `4A 614-617` (the second part a bare number greater than the first, the same era) and `Across X` as a
qualifier like `From` (row 340); `Early` / `Mid` / `Late` on a year make it approximate (its event year detail, its name
tail the cell as usual), and `Late 4A 621 onward` is an open end from that year (row 358); a bracketed gloss in another
era naming the same instant (`Camue 1st, 5A 1 (4A 950)`: the same KCY at a year's precision, the same minutes at a finer
one) is qualifier, and one that does not agree leaves the row unread; a range whose ends differ in precision (`Camue 4A
624` to `Kumikas 25th, 4A 630`) reads with each end at its own precision (`QualifiedReading.endsText`) and its event takes
the coarser detail. `From Isar 4A 566 to Selaphos 3rd, 4A 566`, unread before, is now read that way. A reading of an
inclusive bound carries `inclusive` (described "from X", "up to and including X"). The reader still never works out a
relative offset or an event used as a date (`After the Altun Sahra War in 4A 633` stays unread). Every example is in the
shared date-form fixture (`READ_F21`).

**F2.1-8. A range within one KCY** (ADR 0038 decision 5's `sameYearRange`). The default is now the single value
(`1,250,918` for `Kumikas 17th - 24th, 4A 611`); `1,250,918 - 1,250,918` is accepted as well, and neither is reported as
"written differently", whatever the confirmed style says. A project whose confirmed style says `range` keeps writing
ranges until the owner confirms the style again.

**F2.1-9. An event with candidate rows is not an event without a row** (decision 7 and 9, amended). An unpaired event that
any unpaired row could own (the same date, the same start or its name: `couldBeRowOf`, now shared by the check and the
orphan delete) is reported as `event_in_tie` ("Event in a tie"; in the audits `chronology_event_in_tie`, fix
`chronology_pair`), never as `event_without_row`. It lists its candidate rows (date and opening words) with **Pair with
this row** for each (F2.1-2). It never offers a delete. "Event without a row" and its delete are kept for events no row
could own. The orphan refusal now reads "This event is not an orphan: N rows of the table could be its own (…). Pair it
with one instead of deleting it."

### F2.1 consequences

- On the Arkona fixture (`test/chronology/ties.test.ts`) the Selyros 40th row pairs with its event (`plain`), each
  "before Selyros 40th" row's fix makes one open-start event named with its Date-cell tail, and the event is never an
  event without a row. The four Arkona shapes appear as events in a tie (with their candidates, no delete) until the
  plain rows decide; then they pair outright.
- The answer's `pairedBy` is now in words for every pair (`linked by the bridge`, `the same date`, …).
- Costs: a link costs the planning reads of any sync (about 6) and, in the lock, the table and the event: no write.

### For the owner, after deploying

Re-run the Arkona check. The Selyros 40th row should be paired, and the two "before Selyros 40th" rows should each offer
a new event. Any other open-start refusal should now resolve the same way, or show its candidates with **Use this
event** and **Make a new event**. If the Fourth Age's confirmed KCY style says a range inside one year is a range,
confirm the style again to write the single value (both are accepted either way).
