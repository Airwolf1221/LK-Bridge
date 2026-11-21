# ADR 0064: v3 F4b: the consistency check and "as of a date"

- Status: **Proposed** (v3 F4b, 20 November 2026). It builds the owner-approved design
  [design/F4b-consistency-and-as-of.md](../design/F4b-consistency-and-as-of.md) (APPROVED 20 November 2026: D1 to D10 as
  written), copied into the repository unchanged as this session's first commit. Where the design was silent the choice
  is marked **chosen**, for the owner to confirm; the one place the build departs from the design's words is marked
  **departure**, with its reason.
- Every decision is implemented and tested against the mock LegendKeeper and fixtures modelled on the design's own
  phrasings (`test/consistency/world.ts`), never fetched. Nothing in this session touched a live system: no
  LegendKeeper, no bridge connector, no dashboard, no sandbox, soak, spike, rehearsal or round-trip script. The sandbox
  check below is written, not run.
- Builds on [ADR 0048](0048-chronology-ii.md) and [ADR 0049](0049-v3-f2-last-major-revision-default-project-and-staging.md)
  (the calendar engine, KCY, the qualified reader, the chronology's tables and ties),
  [ADR 0054](0054-arkona-appraisal-tools-and-full-text-search.md) (the snapshot overlay, the full-text index, stored runs,
  the non-current areas), [ADR 0055](0055-write-scope-review-revert-rails.md) and
  [ADR 0057](0057-cr-2026-11-r2-owner-decisions.md) (write scope, Review, Revert, the rails),
  [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md) (a proposal made of items, selective approval),
  [ADR 0062](0062-dashboard-sessions-and-step-up.md) (the step-up) and
  [ADR 0063](0063-v3-f4a-governance-drift-names-and-briefs.md) (the name normalisation, `arkona_brief`).
- Migration: **`3900_consistency.sql`** (the facts index and its pages and state; agents' suggestions; the owner's picks).
- Pack version: **`arkona-2026-11-20-f4b`** (`rules.consistency`: the phrasings, the present day, the "c." margin, the
  fields). It supersedes `arkona-2026-11-19-f4a`; the owner approves it on the Packs page. Until then the four tools are
  not listed and the audits' consistency category reports nothing (they read the APPROVED version's rules).
- Numbered 0064, the next free number.
- **Write scope: no issue found.** None of the read tools writes anything (to LegendKeeper or a proposal); the one
  write, "Pick the right value", is the owner's step-up action and is always ONE proposal (`forceProposal`), never a
  direct write at any scope; agents can only record a suggestion in the bridge's own database. Every write of a pick's
  job is covered by a job-level lock, so the engine checks and writes each page under its lock.

## D1, D2: what is read, and how narrowly

1. **The phrasings are pack data** (`rules.consistency.patterns`, `src/packs/arkona.ts`), each with its `source`:
   `temporalScope` (each `;` clause of the Temporal Scope field), `lifeState` (a dated "Deceased" Life State: **chosen**,
   a fourth source, since D2 names that phrasing), `prose` (each sentence of a page's text) or `chronology` (a row's
   Historical Event cell). Each is a regular expression whose named group `date` holds the text the date is read from
   (`leading`: the date starts it; `first`: the first date in it, for "alive and immortal in Fifth-Age present 5A 931");
   `{name}` stands for the subject. A deliberate gap ("birth date unestablished") is a pattern with `gap: true`. Seeded
   from the design: "Born …", "Died …", "birth date unestablished", "Attested 5A 411–5A 931", "attested through …",
   "alive / active at …", "Deceased <date>", "<name> was / is born on / in …", "<name> died / dies / was killed on / in
   …", the dated line "<date> - <name> is born…", and in a chronology row "<name> is born" / "<name> dies". New
   phrasings are a new pack version, never a code change.
2. **The facts are a closed list** (D1): births, deaths and attested bounds; and the identity facts Race / Species,
   Naming Culture, Life State, Personal / Given Name and Family / Surname (`rules.consistency.identityFields`).
   **Chosen: a page restates an identity fact when its own Subject (or its name's subject part) is the character's**
   (a Biography whose Subject is the character, a second identity page); a relationship page's sidebar is not read as
   one character's, because its subject is the pair. Narrow, as D2 asks.
3. **Who it is about** (D2): a name, an alias or a Canonical Display Name of a current character, matched with F4a's
   normalisation (`nameKeyOf`: case, accents, apostrophes, punctuation, prefixes), and the given and family names together
   in either order (F4a's East Asian order). Never a pronoun. **Chosen, three narrowings**:
   - a **given name alone** ("Yasmin was born on Camue 1st, 4A 100", the design's own biography example) counts only on
     the character's own pages (its set), never elsewhere;
   - a **name two current characters share** (in the same continuity) counts only on one's own pages; elsewhere it is
     not attributed, and the run counts such sentences (`inspected.ambiguousNames`);
   - **an appositive** ("Yasmin al-Naim, daughter of Karim al-Naim, is born") is read for the name before its first comma;
     a name inside the appositive is never taken for the subject. A chronology row with no name read is attributed to
     the one page it mentions, if exactly one (resolved to the character whose set holds it).
4. **Dates** go through the calendar engine (`src/consistency/dates.ts`): one of the calendar's forms at the start of
   the text, an optional "c." / "approximately", and `– <date>` or `– <year>` for a range ("c. 4A 640–645",
   "5A 411–5A 931"); a chronology Date cell as the chronology reads it (plain, else the qualified reader, by its anchor).
   **Precision is kept**: a day, a month, a year, approximate, a range, an open bound. An unreadable date is kept as
   unreadable with the calendar's own reason ("Camue has 50 days; there is no day 51") and its text; never guessed.
5. **The facts index** (`src/consistency/facts-index.ts`, `consistency_facts`): the extractor run over the appraisal's
   overlay (its full-text units: the page's name, its sidebar facts by key, each block of text) and the chronology's
   tables (from the snapshot store). Free. **Incremental** like the F3c indexes: each page's stamp (its name and its
   pieces' hashes) is kept, and a change snapshot re-reads only the pages it took. **Rebuilt** when the key changes (the
   approved phrasings, the characters' names, the calendar's definition, the chronology's settings) or the overlay was
   rebuilt from a newer full snapshot. **Bounded and streaming** (R3's per-event retention): one cursor over the units,
   page by page, keeping only each page's candidate units (its name, its facts, text holding a life-event verb) until
   the page is done, and only the facts until they are written; nothing is cached between requests. Measured
   (`test/consistency/index.test.ts`, 1,500 Arkona-shaped pages of 30 paragraphs): the heap after a full collection was
   65.3 MB before and 65.2 to 65.3 MB after each of six full extractions.

## D3, D4: the comparison and its labels

1. **Spans** (`spanOf`): a day is that day, a month that month, `4A 100` that whole year, a range from its first unit to
   its last; a "c." date widened by `approxMargin` years each side (pack data, default 5); an open bound runs to the
   calendar's edge. **Two values conflict only when their spans do not overlap**. Tested at the margin's edge on both
   sides (c. 4A 640 agrees with 4A 635 and 4A 645, conflicts with 4A 634 and 4A 646).
2. **Identity values** are compared normalised: `nameKeyOf`, with the words in any order (East Asian order). A value in
   `rules.consistency.unestablished` (`Unestablished`, `Unknown`, `Unrecorded`) is a gap, never a conflict.
3. **Where it starts** (D4): the identity page's value (its Temporal Scope first, then its Life State, its sidebar, its
   prose), then each disagreeing restatement, each with page, lifecycle, section, excerpt and precision. **Chosen**: when
   the identity page records none, the first Authoritative restatement is shown first, and the finding says so
   (`referenceNote`).
4. **Labels**, one finding per label: **Contradictory** (Authoritative against Authoritative, `warning`), **Proposal
   differs from canon** (a Working page, `info`), **Gap** (`info`), and **chosen**: **Historical material differs**
   (`info`) for an Archived page or a non-current area brought in with `include`, never Contradictory; **Unreadable**
   (`info`) for a date the calendar cannot read. A Working page against a Working page is "Proposal differs from canon"
   too (**chosen**: neither is canon, and neither is reported to the audits).
5. **Chronology** (D1): a row's date against the same kind of event, for the same subject, on a page the row mentions,
   **chosen**: or a page that links to the row's table (D1's "links the page"). Code `consistency_chronology`.
6. **Departure: attested bounds are read but never compared.** D1 lists "the bounds of a subject's attested life" among
   the facts checked. Comparing them across pages would report a page whose Temporal Scope is the time its source covers
   (a biography of five years) as contradicting the identity page, which Character Architecture forbids ("Do not …
   treat the time covered by a source as equivalent to a person's complete lifespan"). They are read, and used by "as of
   a date" (the attested span) and the coverage report. **For the owner**: keep this, or compare only the identity
   pages' own bounds against each other (a Core and a Compact Reference of one character), or compare a recorded death
   against an attested "alive at" a later date.
7. **Archived pages and the Legacy Canon Archive** (and the Design References) are left out unless `include` names them
   (`archived`, `legacy`, `design`); the run lists what it left out. **AU pages** are compared only within their AU
   (D9): a page's continuity is its Continuity fact when its Continuity Type is the pack's AU type, else Main CANON.

## D5: where it shows up

1. **`arkona_consistency { subject | under | all, include?, continuity?, live? }`**: free; every run is stored as the
   appraisal's are (the latest per scope, `runId`, paged with `offset`, `limit`, `group`; `apr_` ids; the tool is
   `arkona_consistency` in the appraisal's run store). Each finding's id is a fingerprint (`cf_…`, the same in every run,
   in the audits and on the dashboard). Its `followUp` is the owner's pick (a judgement), never a fix.
2. **The nightly audit's `consistency` category**: Contradictory pairs only, codes `consistency_birth`,
   `consistency_death`, `consistency_identity`, `consistency_chronology`, keyed by the consistency id on the identity
   page. **Chosen**: the consistency service computes them from the same snapshots (its facts index over the appraisal's
   overlay) and hands them to the audit through a hook (`AuditDeps.consistency`), so the check
   (`src/audits/checks/consistency.ts`) stays a pure function of its context. A finding clears when the pages agree.
   No "Propose a fix" and no "Re-check now".
3. **`arkona_brief`** (and `arkona_character_brief`, to which a character is delegated) gains `consistency`: the open
   Contradictory findings involving the subject's pages, from the audits' store (free), with "do not write on these
   values until the owner picks the right one".

## D6: "Pick the right value"

1. **On the Audits page**, a consistency finding has **Pick the right value**: its values side by side (page,
   lifecycle, where, excerpt; the identity page's first), **Pick this value** on each, a field to type the right one, the
   agents' suggestions and the earlier picks (`GET /api/admin/audits/findings/:id/consistency`). The pick
   (`POST …/consistency-pick { side | value, confirm: true }`) is a **step-up action** (ADR 0062, as a pack-level
   decision), audited `consistency.pick`, recorded in `consistency_picks`.
2. **ONE proposal of items** (F3d), one per page that disagrees with the pick (`src/consistency/fix.ts`), each page read
   live first, editing only the restated value: a sidebar field's date replaced inside the field, the rest of the field
   kept (`set_facts`' planner); an identity field's whole value; a sentence's date replaced in its one text run
   (`write_page`'s block-by-block path); a chronology row's date through **`update_timeline_event`'s own plan**,
   refactored out of the tool as `planEventChange` (behaviour unchanged: the chronology suite passes), so its Date and KCY
   cells and its timeline event change together. **Chosen**: a date split by a mention or formatting, a field holding a
   mention, or a value changed since the snapshot is not planned and is listed (`notPlanned`); a value that agrees with
   the pick (spans overlap) is untouched; **the side picked is never edited**; a deliberate gap and a value inherited from
   Main CANON are never edited (`leftAsTheyAre`). A typed value must read, whole, as one date of the calendar
   (`VALUE_UNREADABLE` otherwise).
3. **Always a proposal** (`forceProposal`), by the owner's system principal, whatever any scope. Every write is covered
   by the job's locks (the first page's lock, the other fact pages' as `holdMore`, the documents as `holdDocuments`).
   Approval and selective approval work as usual; **more than 10 pages asks for the step-up at approval** (the guarded
   rails' size, ADR 0062, judged on the proposal's operations); Last Major Revision follows the engine's rule (a date's
   few characters are measured like any edit). **Revert** applies to an approved pick's job (**chosen**: as to an
   approved retag batch; recognised through the pick's recorded proposal, `approvedRevertible`).
4. **Agents suggest, never pick**: `arkona_consistency_suggest { findingId, value, reason }` records a suggestion (a
   `cf_…` id from the tool or the audits), shown on the dashboard; it applies and proposes nothing. **Chosen**: its access
   is `write` (it writes the bridge's own record), so a read-scope connection cannot add one. No agent tool picks.

## D7 to D10: "as of a date", coverage, AU, the present

1. **`arkona_as_of { characters (≤ 25), date, continuity?, window?, live? }`**: born (the identity page's value and
   where; **chosen**: else the Authoritative restatements when they all agree; else "birth unestablished"); elapsed
   **calendar** years: a whole number when both dates are exact days (an anniversary not reached does not count), a range
   `{ min, max }` when either is approximate or coarser, "not yet born" when the date ends before the birth can begin,
   none when the birth is unknown; never apparent or biological age, and the race reference is linked (its Race / Species
   value's page, found by subject and a "Race" or "Species" Reference Type; never guessed, a note when none or several
   match).
2. **The state** (D7): Deceased (recorded) after a recorded death; Alive (recorded) between a recorded birth and a
   recorded death, or inside the attested span; Unestablished otherwise. **Chosen**: the attested span runs from the
   recorded birth (born, and attested alive later, the life is attested in between) or, with no birth, from the
   attestation's own start, to the latest attestation; an attestation of the present ("alive at 5A 931") runs to the
   present (D10). A date before the recorded birth is Unestablished, with "before the recorded birth" (the elapsed years
   say "not yet born"). Never Alive past what is recorded.
3. **Around the date**: the chronology rows naming the character (a mention of one of its pages, or one of its names as
   whole words), the nearest `window` each side (default 3), and those overlapping the date. **Contradictions**: the open
   Contradictory findings on its birth or death (a chronology one included), with a warning.
4. **Coverage** (D8, `arkona_as_of_coverage`, **chosen** as its own tool): the current Main CANON characters, from their
   identity pages: a readable birth, an unreadable one, a deliberately unestablished one, a recorded death, attested
   bounds, and those with nothing readable (listed). Its note says absence is often deliberate and that it is not a task
   list. On the test fixtures: 23 Main CANON characters; 8 with a readable birth, 1 with its birth deliberately unestablished, 1 with a recorded death, 3 with attested bounds, 14 with nothing readable (the F3a to F4a fixtures' characters, which record no birth; one of them, Tsubame Hoshizora, has a Temporal Scope written as a bare range, "5A 900 - 5A 931", which no phrasing reads: a phrasing for it would be a pack change, the owner's).
5. **AU** (D9): `continuity` defaults to Main CANON; for an AU, its own pages' facts first, else the Main CANON value
   labelled "inherited from Main CANON" (birth, death and identity facts, from the Main identity page). Nothing about the
   AU's inheritance is assumed beyond that label (Project Navigation's "a separate relation").
6. **The present** (D10) is pack data, `present: "5A 931"`; `date: "now"` means it.

## Costs

| Call                                                          | LegendKeeper requests                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `arkona_consistency`, `arkona_as_of`, `arkona_as_of_coverage` | 0                                                                        |
| … with `live: true`                                           | 1 per identity page re-read (at most 25)                                 |
| `arkona_consistency_suggest`; the audits' category; the brief | 0                                                                        |
| Pick the right value (planning)                               | 1 per page edited (its sidebar or document); a chronology row: about 9   |
| The approved pick's job                                       | each page's check, writes and read-back, as `set_facts` and `write_page` |

## Consequences

- After deploying: approve `arkona-2026-11-20-f4b`; the next nightly audit (or "Run an audit now") reports the
  consistency category; agents call `arkona_as_of` before writing about a character at a date and `arkona_consistency`
  before changing one (the bridge guide's "How to decide" and its part "Arkona consistency checks").
- The sandbox check (written, not run): `sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test --
consistency-f4b` (`test/sandbox/consistency-f4b.test.ts`): on the test world, a throwaway Character Core and a page
  restating its birth differently, a full snapshot, the check, the owner's pick, approval, the page read back, the check
  again, and clean-up (the throwaway index deleted with everything under it). It copies the project's settings, tree
  and packs from the bridge's database read-only, as the write-scope rehearsal does, and needs the chronology's calendar
  confirmed on the test world.
- **Amended after the owner's sandbox run (20 November 2026).** F2 failed: the check made its throwaway Authoritative
  `[BSRC] … - Character Core` through the bridge's governed `createResource` as the system principal, and the canon
  guard correctly refused it (an Authoritative page is made only by the owner's canonical approval). The guard is
  unchanged. The probe's three pages (the throwaway index, the Core and the restating page) are now made, and deleted
  again, with the sandbox runtime's raw client (`test/sandbox/f4b-probe.ts`: `LkClient.call` with the governor's own
  `fetch`, as the assumptions checks make their throwaway pages: paced and counted by the governor, with If-Match on
  the versioned write, but no job, proposal or guard of the bridge), followed by a tree sweep so the bridge sees them;
  the check, the pick, the approval and the read-back go through the bridge as before.
  `test/consistency/sandbox-probe.test.ts` (mock) pins that the helper makes the `[BSRC]` Core with the raw client and
  never through the job engine, and that the sandbox check itself makes no governed create or delete.
- **Unverified on a real project**: the pick's writes are the ones existing sandbox rounds check (a block replaced with
  its ids kept, a sidebar row updated, a chronology row and its event in step); the sandbox check exercises them together.

## For the owner

1. The **departure** (D3, D4 decision 6): attested bounds are not compared. Keep, or one of the two alternatives.
2. The **chosen** narrowings of D2: a given name alone only on the character's own pages; a shared name only on one's
   own pages; the appositive rule; a page restates identity facts only when its Subject is the character.
3. Whether a Working page against a Working page should be reported at all (it is "Proposal differs from canon" now),
   and the label "Historical material differs" for Archived material brought in with `include`.
4. The attested span starting at the recorded birth (D7 decision 2), and a date before the birth reading Unestablished.
5. `approxMargin` stays 5 years (D3's question), and `present` stays 5A 931 until the owner moves it.
6. A Temporal Scope written as a bare range ("5A 900 - 5A 931", with no "Born" or "Attested") is not read: D2's
   phrasings do not cover it, and whether such a range is a life or a source's time is the owner's to say. Adding a
   phrasing is one pack change.

## Tests

`test/consistency/`: `extract.test.ts` (each seeded phrasing; an alias; a pronoun never read; an unreadable date with
the calendar's reason; precision kept), `compare.test.ts` (a day against its year; non-overlapping spans; "c." at the
margin's edges; a gap; Working; Archived; identity normalised; attested never compared), `tools.test.ts` (the run's
labels, exclusions, AU and paging; every as-of case; coverage; no request without `live`, one a character with it),
`audit-pick.test.ts` (only Contradictory pairs, stable codes, cleared when the pages agree; the brief's line; the step-up;
one proposal, one item per page, the side picked untouched; a suggestion shown and applying nothing; Revert; a typed
value; more than 10 pages asks for the step-up at approval), `pick-chronology.test.ts` (a row through the row tools: its
Date, KCY and event together), `index.test.ts` (incremental from a change snapshot; rebuilt on a new key; the heap back
to its baseline after repeated extractions); and the guide's (`test/discover`).

## Amendment 1: from the first live run

- Status: **Proposed** (20 November 2026, session F4b.1). It amends the decisions above; where it changes one, the
  change is said here and the text above is left as it was approved.
- **What the run found** (the owner, 20 November 2026; run `apr_7e189380f2f0ee05` on Arkona: 299 characters, 2,039
  facts, 1,467 pages): 4 Contradictory, 5 Gaps, 39 Unreadable, and only 12 of 299 births readable. On review, every
  Contradictory finding was false and most Unreadable dates were readable: the fixtures had not modelled how Arkona's
  pages are written. Every fixture of this amendment is built from the excerpts the owner quoted from that run, verbatim.
- **Write scope: no issue found.** Nothing in this amendment writes: the four tools stay read-only, the audits'
  category still reports Contradictory pairs only, and "Pick the right value" is unchanged (always ONE proposal).
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike, rehearsal or round-trip script. Mocks and fixtures only.
- **No new ADR number** (the owner's instruction). No migration: the one new stored value (a fact's non-current mark)
  is kept in the facts' existing JSON column. The facts index's key gains a version, so the index is rebuilt once on
  the first request after deploying.
- **Pack version `arkona-2026-11-20-f4b1`** (supersedes `arkona-2026-11-20-f4b`; the owner approves it on the Packs
  page). Rules A, C, E and G and the identity-page fix are code and apply at once; rules B and D and the switch F are
  pack data and apply when `-f4b1` is approved.

### A. Subject attribution (D2 made precise)

1. **The subject is the name or alias governing the verb in its own clause** (`resolveName`, src/consistency/extract.ts):
   the name directly before "was / is born", "died / dies", "was killed", with only titles and appositives between.
   Clauses break at commas, semicolons, a spaced dash and the clause words (after, when, before, until, while).
   - The clause running straight into the verb: the longest run of its last words that is a name ("Their son Murad
     al-Khalid" → Murad al-Khalid; "After Kaiser Soren von Woerfels" → Soren von Woerfels). None: nobody, never a name
     in an earlier clause ("…passed to Soren after Tobias von Hohenfalk died" is Tobias's, or nobody's).
   - A comma before the verb: the clause before it must be a name standing alone (after its titles: "Their son,
     Leopold I von Hohenfalk, was born"); otherwise it is an appositive, passed over only when a comma opens it too
     ("Yasmin al-Naim, daughter of Karim al-Naim, is born" is Yasmin's). **Chosen**: an appositive opened by a clause
     word is not passed over (nobody), so a name inside an appositive never governs.
   - The phrasing's own `\s*,?` before the verb is put back (match indices), so the comma counts.
   - **Titles and clause words are pack data** (`rules.consistency.titles`, `clauseWords`; absent: Kaiser and Kaiserin,
     and the five words). `-f4b1` seeds Kaiser, Kaiserin and the common European titles.
2. **The identity page is no exception** (the cause of the false findings): F4b counted every sentence on a character's
   identity page as that character's. Now a sentence there counts only when its governing name is one of the
   character's own names, aliases or its given name (`characterFacts`, src/consistency/service.ts). Falling back to the
   page's character is left to the phrasings without `{name}` (the Temporal Scope and Life State fields).
3. Pronouns are still never read; a sentence naming two characters is only the governing one's.
4. **Chosen, kept from F4b**: a given name alone counts only on that character's own pages. "When Finn died on Kusha 9th,
   4A 12…" on Veresa von Mader's page is Finn von Mader's death (by his given name), so it is no longer Veresa's, but it
   is not compared with Finn's own pages either.
5. **Departure from F4b decision D2.3** (a row with no name read, attributed to the one page it mentions): a chronology
   row is attributed to a mentioned page's character only when the mention's text is the name governing the verb ("A
   daughter is born" with one mention is nobody's). The owner's rule allows falling back only when the clause's subject
   is literally the character's name.

### B. The date inside the clause

1. **A new reading, `date: 'scan'`** (`readScan`, src/consistency/dates.ts): after the verb, the clause (cut at a
   semicolon or a clause word, never at a comma, which dates and places hold) is scanned for the first date-shaped text:
   a word starting with one of the calendar's month names or era abbreviations followed by a number, with an optional
   "c." or "approximately". It is read by the calendar engine's leading reader, so a leading place, "to <parents>" and a
   trailing "(… KCY)" are skipped. "in <era year>" reads as a year. Built from the calendar: nothing about Arkona is in
   the code.
2. **Nothing date-shaped: no fact is recorded.** "Unreadable" is reserved for a date-shaped text the engine refuses,
   with its reason ("Camue has 50 days; there is no day 51").
3. `-f4b1` reads with `scan`: "Born …" and "Died …" in a Temporal Scope, "alive / active …", the Life State's
   "Deceased …", and the prose "<name> was / is born on / in …" and "<name> died / dies / was killed on / in …". A
   consequence, tested: Titania's "active at…" is no longer reported as unreadable (it holds no date).
4. "born al-Shariff" (a maiden name) is no second birth: one fact a sentence, as before, and the phrasing needs "was /
   is born on / in".

### C. Chronology rows

1. **A table row is never read as its joined cells.** The full-text index keeps a row as one unit ("Varadi Bendeguz is
   born in Varadyn Kiralysag | Selaphos 40th, 3A 78 | 1,250,076"); F4b read those units as prose, which made most of the
   run's Unreadable rows. They are no longer read as prose.
2. The chronology's rows are read as F4b already did besides: through F2's row parser (`findTable` on the configured age
   tables), the date from the Date column (read as the chronology reads it), the subject from the Historical Event
   column by rule A, with the event cell's mentions and their text (`ChronologyRowInput.subjects`). The KCY column is
   not compared (as before).
3. **For the owner**: a table elsewhere (not one of the chronology's age tables) is no longer read at all. Reading such
   tables by their columns too would be a later change.

### D. Life State and bounds

1. A dateless "Deceased" is a state: the Life State identity fact records it, and the death date comes from the Temporal
   Scope or prose; none, nothing is reported.
2. "Deceased by <date>" is an upper bound on death, never a death date (`death.lifestate` no longer matches "Deceased by"
   or "Deceased before"). **Chosen**: it is not recorded as a fact at all; recording it as a bound would be a new fact
   kind, for the owner. "alive at", "active at" and "attested through" stay attested bounds (lower bounds on life),
   never a death.
3. "death date unestablished" and "exact death date unestablished" are an explicit gap in the Life State too
   (`death.lifestate.gap`), as they already were in the Temporal Scope.

### E. Identity values

1. **The principal value is compared** (`principalValue`, `principalKey`): the part before the first qualifier (`;`,
   `(`, or a spaced dash), normalised as before (case, accents, punctuation, word order). Differing qualifiers or wording
   after it are no conflict and nothing is reported; Contradictory needs different principal values.
2. A value whose principal value is in `unestablished` ("Unestablished (pending review)") is a gap too.

### F. Non-current sections inside current pages

1. **The owner's ruling (20 November 2026)**: "Pre-Rewrite" and "Author-Facing" sections and rows are non-current; the
   exclusion is **switched on** by default.
2. **Pack data** (`rules.consistency.nonCurrent: { markers, exclude }`, `-f4b1`: `["Pre-Rewrite", "Author-Facing"]`,
   `exclude: true`). A fact read from a section with a marker in any heading above it, or from a chronology row whose
   text holds one ("(author-facing pre-rewrite provenance)"), is marked (case, dashes and spaces between words ignored).
3. With the switch on, marked facts are left out of `arkona_consistency`, `arkona_as_of`, the coverage report and the
   audits unless `include: ["pre-rewrite"]` asks for them; the run's `leftOut` says how many. When included they are
   labelled **Historical material differs** (`info`), never Contradictory, and never the reference. With the switch off,
   nothing changes.
4. **For the owner to check on Arkona**: in the integration fixture, Purandukht Mithra's birth in Yue Bailu's Biography
   ("born on Zarzakh 17th, 2A 748,455…") is under a current heading, so it is the one sentence compared (a Gap against
   her identity page's "birth date unestablished"). If on Arkona that sentence stands under "Birth, Upbringing and
   Magical Reputation - Pre-Rewrite", it is left out too, and her Gap disappears.

### G. Coverage that adds up

`arkona_as_of_coverage` now puts each character in **one primary bucket**, in this order: a readable birth; a birth
deliberately unestablished; attested bounds only; nothing readable. The buckets add up to the total (`counts`; `sums`
says so). A recorded death and an unreadable birth are **flags** with their own counts (`flags`). **Chosen**: a
character with only a recorded death is in "nothing readable", listed with the flag. The output's shape changed:
`counts.unreadableBirth`, `counts.recordedDeath` and `counts.attestedBounds` moved (no consumer in the repository besides
the tests).

### The integration test's numbers

`test/consistency/live-run.test.ts`, on a world built from the run's excerpts (`test/consistency/live-world.ts`: F4b's
fixture world plus 29 characters and their pages), the findings about the run's subjects, before (F4b's code and pack)
and after:

| Finding                                   | Before | After                                     |
| ----------------------------------------- | -----: | ----------------------------------------- |
| Contradictory                             |      4 | 0                                         |
| Gap                                       |      4 | 1 (Purandukht Mithra: a real gap)         |
| Unreadable (findings)                     |     16 | 1 (F4b's "Camue 51st, 4A 360": refused)   |
| Coverage: readable births (52 characters) |     19 | 23                                        |
| Coverage: unreadable births               |      4 | 0                                         |
| Coverage: recorded deaths                 |      8 | 7 ("Deceased by 5A 931" is no death date) |

Before, the 4 Contradictory were Soren von Woerfels (Tobias's death), Daryavan al-Khalid (Murad's birth), Katsuragi
Koharu (Naming Culture) and Murket (Family / Surname); the Gaps included Veresa von Mader (Finn's death), Yvonne von
Hohenfalk (Leopold's birth) and Jahan-Timur ("Deceased by"). After, the coverage buckets are 23 + 3 + 3 + 23 = 52.

### Tests

`test/consistency/amendment1.test.ts` (every fixture above, on the extractor, the scan and the comparison: A's four
must-not-attribute sentences and the Falkenreich line; B's nine clauses and their sentences; C's ten rows and the joined
row never read; D's Life States and bounds; E's two must-not-conflict pairs and the must-conflict one; F's markers, the
Core's and Biography's sections and the row; D2 kept: pronouns, two names), `test/consistency/live-run.test.ts` (the
integration world), and the F4b suites updated where the amendment changes their expectation (Titania's "active at…",
the mention-only row, the coverage shape). The heap test (`index.test.ts`) passes unchanged.

### For the owner

1. Approve `arkona-2026-11-20-f4b1`, then re-run the coverage report and `arkona_consistency { all: true }` and compare
   with run `apr_7e189380f2f0ee05`.
2. Rule A's chosen narrowings: an appositive opened by a clause word is never passed over; a given name alone still counts
   only on the character's own pages (Finn's death on Veresa's page is read as Finn's but not compared).
3. The departure in A.5 (a mention counts only as the governing name).
4. "Deceased by <date>" is recorded as nothing (D.2); a bound fact kind would be a later change.
5. Tables other than the chronology's age tables are no longer read (C.3).
6. Check the section Purandukht Mithra's Biography sentence stands under on Arkona (F.4).
7. The titles seeded in `-f4b1` (edit them on the Packs page).

## Amended by ADR 0065 (v3 F4c, 20 November 2026)

On top of amendment 1's seed, `-f4c` adds pack data and changes `arkona_as_of` only (the extractor and comparison are
unchanged): the bare-range attested phrasing (decision 6), the age phrasings for `arkona_chapter_check`, "Deceased by
<date>" as an as-of-only upper bound (replacing D.2's "recorded as nothing" in `arkona_as_of`; still never a fact), D9's
inheritance of the attested life and the Life State, and D7 amended by the owner's ruling: a Life State of "Alive"
records the character alive at the present. See [ADR 0065](0065-v3-f4c-fiction.md), "On top of F4b.1".

## Amendment 2: from the owner's check of the live tools (v3 F4.1)

- Status: **Proposed** (20 November 2026, session F4.1). It amends the decisions above and amendment 1; where it changes
  one, the change is said here and the text above is left as it was approved. **No new ADR number** (the owner's
  instruction); its narrative half is [ADR 0065](0065-v3-f4c-fiction.md) amendment 1.
- **Write scope: no issue found.** Nothing in this amendment writes to LegendKeeper: the four consistency tools stay
  read-only (the one new request, loading the calendar, is a read); "Pick the right value" is unchanged (always ONE
  proposal); the audits' category still reports Contradictory pairs only and makes no request.
- Nothing in this session touched a live system: no LegendKeeper, no bridge connector, no dashboard, no sandbox, soak,
  spike, rehearsal or round-trip script. Mocks and fixtures only; every fixture is the owner's live data, quoted verbatim
  (`test/consistency/f41.test.ts`, on amendment 1's live-run world).
- No migration. The facts index rebuilds itself once (its key holds the characters' names, which the alias parser
  changes).
- **Pack version `arkona-2026-11-20-f41`** (supersedes `arkona-2026-11-20-f4c`; the owner approves it on the Packs page).
  Decisions 1, 3 and 4 and the calendar loader are code and apply at once; so does decision 2's prefix match, on the
  approved values ("Alive in 5A 931" with `-f4c`'s `["Alive"]`, then read up to the present). "Living", the dated
  reading (`aliveAt`) and the two Temporal Scope phrasings are pack data and apply when `-f41` is approved.

### 1. Coverage agrees with `arkona_as_of` (amends D8 and amendment 1 G)

The live coverage put Elias Brenner, Varadi Bendeguz and Mehrana al-Khalid under "nothing readable" (12 readable births of 299) while `arkona_as_of` read all three: Elias from his own page's prose ("Elias Brenner was born in Falkenau on Jehet
39th, 4A 100 (1,250,407 KCY)"), Varadi from a Universal Chronology row ("Varadi Bendeguz is born in Varadyn Kiralysag |
Selaphos 40th, 3A 78"), Mehrana through her birth name ("Yasmin Arshama is born… | Camue 1st, 4A 100"). Coverage had read
only the identity page's sidebar facts. **Now one resolver** (`Consistency.lifeValue`): the identity page's own value (its
Temporal Scope, Life State or own prose naming the character), else Main CANON's inherited one (D9), else the
Authoritative restatements (prose elsewhere, chronology rows; by name or alias) when they agree. `arkona_as_of` and
`arkona_as_of_coverage` both call it, over the same facts (`characterFacts`, non-current sections left out alike), so a
character is in "readable birth" exactly when `arkona_as_of` finds a birth (a property test over every Main CANON
character, both ways). A recorded death is flagged by the same resolver; attested bounds are the identity page's, as
as-of reads them. `detail: "full"` adds `byCharacter` (each character's bucket, and the birth's value, page and source).

### 2. Alive phrasings (pack data; amends ADR 0065's D7 ruling)

Only the exact Life State "Alive" counted. **`aliveValues` now match a principal value (before the first ";", "(" or
" - ") that STARTS with one of them as a whole word**; `-f41` seeds `["Alive", "Living"]`. An optional "in / at <date>"
there (`aliveAt`, pack data: `\b(?:in|at)\s+(?<date>.+)$`, read with the scan reader) is an attestation up to that date:
the life runs from the recorded birth (or, with none, is at that date only) to the date, not to the present. Two Temporal
Scope phrasings, both attested-through (`bound: to`): `attested.scope.living` ("living at <date>") and
`attested.scope.present` ("present <date>"). The death guard (ADR 0065, "On top of F4b.1", 6) is kept: a recorded death
always wins inside its span, now with the alive end in place of the present ("Living" after a death with no return is
"Unestablished (recorded death; current Life State Living)"). Read by `arkona_as_of` only; never facts, never compared.
**Chosen**: "Living" as a value of its own beside "Alive" (the owner's "starts with Alive or Living").

### 3. One alias parser, notes dropped (amends D2's "a name, an alias")

"Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)" kept each note as part of the name, so
"Zahras 1st, 4A 99 (1,250,406 KCY) - Rita von Katzen, later Katsuragi Yamato, is born in Varadyn Kiralysag." (Varadyn -
Historical Kingdom & Personal Union) named nobody. **`splitAliases`** (`src/packs/naming/namesakes.ts`) is the one
parser: split at semicolons and line breaks; each alias loses its trailing bracketed notes (`aliasName`: a bracket holding
a digit, opening with a note word such as "from", "until", "c.", "birth", "earlier", "maiden", "regnal", or ending
"name"). The facts index, `arkona_as_of`, `arkona_consistency`, `arkona_brief`, `arkona_name_check`, the character tools,
the change impact (resource aliases through `aliasName`) and the rename review (which had its own `split(';')`) all use
it. **Departure** from F4a's parser, which also split at commas: a note's date may hold a comma ("(from Zahras 1st, 4A
47)"), and the owner's rule is ";". **Chosen**: a bracket that is not a note ("Leopold (the Elder)") stays part of the
name; a lone "…" (an elided list) is no alias. Rule A already passes over "later Katsuragi Yamato" as an appositive, so
Yamato's birth is now Zahras 1st, 4A 99 from the Varadyn line.

### 4. Race reference links (amends D7's "its Race / Species value's page")

"High Elf", "Human", "Foxian" and "Faerie" found no page ("High Elves - Core Information" and the like); "Vitra" did only
because its plural is the same. **Now**: the value's principal part, through the pack's race token map (F3a,
`tags.race`), matched in the singular or the plural (`numberForms`: elves/elf, ies/y and ie, es, s) against the subject or
aliases of the Race Core Reference pages (the race kind's Reference Type, or a "… - Core Information" name) under the race
roster (`owners.races.root`, Races of Arkona); if none, the earlier rule (any page whose Reference Type or name says race
or species), now also singular or plural. One match is linked; several or none say so, as before.

### 5. The calendar on demand

`Chronology.loadCalendar` is THE loader (`calendar_date`'s code moved into it unchanged in behaviour): the kept calendar,
else one `listCalendars` read and kept. `arkona_as_of`, `arkona_as_of_coverage` and `arkona_consistency` pass their
governed read to `Consistency.world`, which loads the calendar before the facts index is brought up to date (the
extractor reads dates with it; a new calendar is a new index key, so the index rebuilds). The nightly audit passes no
read and never makes a request (**chosen**: the chronology check, which runs nightly, keeps the calendar anyway). A
calendar that cannot be read leaves the dates unread as before, and `couldNotCheck` says why. The narrative tools: ADR
0065 amendment 1.

### The fixture results, before and after

`test/consistency/f41.test.ts` (`F41_REPORT=1` prints them), on amendment 1's live-run world with the owner's values;
before is this session's tests run against `main`'s code and pack.

| Fixture                                                                                             | Before                                      | After                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Coverage, 59 Main CANON characters                                                                  | 20 readable, 27 nothing readable            | 24 readable, 23 nothing readable                             |
| Elias Brenner, Varadi Bendeguz, Mehrana al-Khalid (coverage)                                        | nothing readable                            | readable birth (prose; chronology; chronology)               |
| Rashad al-Khalid at 5A 931                                                                          | Unestablished                               | Alive (recorded)                                             |
| Katsuragi Yamato at 5A 931                                                                          | Unestablished                               | Alive (recorded)                                             |
| Iuno at 5A 931                                                                                      | Unestablished                               | Alive (recorded)                                             |
| Katsuragi Yamato, born                                                                              | birth unestablished                         | Zahras 1st, 4A 99 (the Varadyn line)                         |
| `arkona_name_check`: Rita von Katzen, Takamori Ayame, Ayame al-Jabaal, Mizuno Rei, Farzana al-Ruyan | no alias match                              | each matches its character as an alias                       |
| Race reference: High Elf, Human, Foxian, Faerie                                                     | "no race reference page matches this value" | "High Elves / Humans / Foxians / Faeries - Core Information" |
| Race reference: Vitra                                                                               | "Vitra - Core Information"                  | "Vitra - Core Information"                                   |

The fourth extra readable birth is Katsuragi Yamato's (decision 3). F4b's own fixture gave "Rita von Katzen" a second,
different birth on its nation page ("was born in 4A 305"); this file leaves that sentence out, since two disagreeing
restatements give no birth (D7, unchanged).

### For the owner

1. Approve `arkona-2026-11-20-f41`, then re-run `arkona_as_of_coverage` (and `detail: "full"` to see each bucket) and the
   `narrative-f4c` sandbox check.
2. Decision 3's departure: commas no longer separate aliases. An Aliases value written with commas is now one alias.
3. Decision 2: "Living" is an alive value; a dated alive Life State attests the life only up to its date.
4. Decision 5: the nightly audit makes no request for the calendar.
