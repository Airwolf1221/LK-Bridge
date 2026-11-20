# LK-Bridge F4b: consistency check and "as of a date" (design, for the owner's approval)

**Status:** APPROVED by the owner as written (20 Nov 2026), D1 to D10.
**Builds on:** F2 and F2.1 (the calendar engine, KCY, the chronology tables), F3c (snapshots, full-text index, appraisal, change impact) and F4a (`arkona_brief`).
**Used by:** F4c (fiction): its chapter check is these two tools run at the chapter's date.

## What the repository actually holds (read live, 20 Nov 2026)

- **Births are recorded, mostly in a form the calendar engine already reads:**
  - A Core's or Compact Reference's **Temporal Scope** field holds them, for example:
    - "Born Camue 44th, 4A 360; alive and immortal in Fifth-Age present 5A 931" (Rashad al-Khalid);
    - "Born 2A 73,511; attested through 5A 931" (Soraya bint al-Noor);
    - "Born Sarias 28th, 1A 51,743; succession Redfall 1st, 1A 62,313; active at…" (Titania).
  - Other characters record an unknown birth honestly: "Attested 5A 411–5A 931; birth date unestablished" (Kamigawa Haru).
- **The same facts are restated in several places:**
  - in biographies ("Yasmin was born on Camue 1st, 4A 100…");
  - in chronology rows ("…al-Naim, is born in 4A 401");
  - on nation pages with KCY ("Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von Katzen is born in…").

  These restatements are where drift happens.
- **Birth names are aliases** ("Rita von Katzen, later Katsuragi Yamato"), so finding restatements must use aliases.
- **The present is 5A 931**, as stated in many Temporal Scopes.
- **The governance limits apply to both tools:**
  - Repository Automation's Default Boundary: report, never repair; "do not… choose a conflicting interpretation".
  - Character Architecture: "An attested historical life or office does not prove current survival"; "Do not invent dates or treat the time covered by a source as equivalent to a person's complete lifespan".

## Part 1: the consistency check

**D1. Only a closed list of facts is checked: facts that can be read reliably, never free-prose meaning.**
- **Dated life events:** birth, death, and the bounds of a subject's attested life ("attested through", "alive at", "active at").
- **Identity facts:** Race / Species, Naming Culture, Life State, Personal / Given Name, Family / Surname. They are compared where another page **restates them in a sidebar field of the same name**, for example a relationship page's "Family / Surname".
- **Chronology dates:** a chronology row's date compared with the same event's date restated on a page. "The same event" means the row mentions or links the page, and the page's sentence names the same subject and the same kind of event.
- **Out of scope:** what a relationship is like, abilities, motives, and any contradiction that needs reading comprehension. `arkona_brief` and change impact already list the pages that restate a subject, for an agent or the owner to read.

**D2. The patterns are deliberately narrow: they miss things rather than invent conflicts.**
- **Births:** "Born <date>" in Temporal Scope. "<Name or alias> was / is born (on | in) <date>" in prose and chronology rows.
- **Deaths:** "<Name or alias> died / dies / was killed (on | in) <date>"; "Died <date>" in Temporal Scope; a Life State of "Deceased" with a date.
- **Who it's about:** only the subject's name, its aliases or its Canonical Display Name, **never a pronoun**. "She was born in 4A 100" with no name in the sentence is not read.
- **Dates:** read by the calendar engine, keeping their **precision**: a day, a month, a year, "c.", or a range.
- **The patterns are pack data,** so you can add phrasings later without a code change.

**D3. A conflict needs dates that cannot both be true.**
- Every date becomes a span on KCY: a day is one day; "4A 100" is that whole year; "c. 4A 640–645" is that span with a margin set in the pack (default ±5 years).
- Two values conflict only if their spans don't overlap. "4A 100" and "Camue 1st, 4A 100" agree; "Camue 1st, 4A 100" and "4A 103" conflict.
- For identity facts, values are compared after the usual normalisation (case, diacritics, East Asian name order). The value "Unestablished" never conflicts with anything; it's reported as a gap.

**D4. The check never decides which side is right. It reports evidence, labelled as the owner's evidence classes.**
- **Where it starts:** the subject's identity page (its Core or Compact Reference), then every disagreeing restatement. Each is shown with page, lifecycle, section and an excerpt.
- **Authoritative vs Authoritative** is labelled **Contradictory**: a `warning`.
- **Working vs Authoritative** is labelled **Proposal differs from canon**: `info`. Working material is allowed to differ.
- **AU pages** are compared only within their own AU (D9).
- **Archived pages** and the Legacy Canon Archive are left out unless asked for. Historical material may legitimately say something else.
- **A restatement that reads "Unestablished" while the owner gives a value** is a **gap**: `info`.

**D5. Where it shows up:**
- **A read tool, `arkona_consistency { subject | under | all, include? }`:** free, from the snapshots and the full-text index. A whole-repository run is stored as a run, read a page at a time.
- **The nightly audit**, as a new category, `consistency`. It reports only **Contradictory** pairs (Authoritative vs Authoritative); the rest stays in the tool.
- **`arkona_brief`** (F4a) gains a "consistency" line listing open contradictions on the subject.

**D6. Fixing is your choice: "Pick the right value".**
- On a consistency finding, the dashboard shows both values side by side. You pick the correct one, or type a different one.
- The bridge then **proposes** edits to every page that disagrees with your choice. That's an ordinary proposal: you approve it, it can be Reverted, and Last Major Revision follows the usual rule.
- It never edits the side you picked, and never runs without your pick.
- An agent can **suggest** a pick, which is shown to you as a suggestion, but it can't make one.

## Part 2: "as of a date"

**D7. `arkona_as_of { characters[], date, continuity? }`** answers the following for each character at that date, with every value's source and precision:
- **Born:** the date and where it's recorded, or "birth unestablished".
- **Elapsed years at the date:** a single number when both dates are exact, a range when either is approximate, "not yet born" before birth, and nothing when the birth is unknown.
  - **Elapsed calendar years only, never apparent or biological age.** Arkona's races mature and age differently (Foxian tails, non-senescent High Humans and Elves). The result links the character's race reference so an agent reads the maturation rules there, rather than the tool guessing them.
- **State at the date:**
  - **Alive (recorded):** between birth and a recorded death, or inside the attested span.
  - **Deceased (recorded):** after a recorded death.
  - **Unestablished:** anything else, as the governance requires. An attested life does not prove survival past it.
- **Around the date:** the chronology rows naming the character before and after it (the nearest few each side, and a window you can set).
- **Any open consistency contradiction** on the character's birth or death, so a chapter isn't written on a disputed date without anyone noticing.

**D8. Coverage first.** The first output of F4b is a **coverage report**: how many characters have a birth the engine can read, a recorded death, attested bounds, or none. Characters with nothing readable are listed. It's a report for you, never a task list. Unrecorded births are often deliberate ("birth date unestablished").

**D9. Alternate universes:**
- `continuity` defaults to Main CANON.
- For an AU, a fact stated on that AU's own pages is used first. Otherwise the Main CANON value is used, **labelled "inherited from Main CANON"**.
- If the governance defines an AU's inheritance as narrower than that, the check follows the governance. Project Navigation calls continuity inheritance "a separate relation". Until it's pinned in the pack, AU results carry the label and nothing is assumed.

**D10. The present day is pack data, `present: "5A 931"`, not hard-coded.**
- "Now" in either tool means that date.
- A Temporal Scope phrase like "alive at 5A 931" counts as attested up to the present.
- When the present moves on, it's one setting.

## What it costs and what it never does

- **Both tools are free:** they read the snapshots, the full-text index and the calendar engine. `live: true` re-reads the pages a result rests on (one read each).
- **Never:**
  - writes anything except an owner-picked fix (D6);
  - infers a date from a pronoun, a sibling's age or an era name with no date;
  - treats a source's time span as a lifespan;
  - picks a winner;
  - counts Working or Archived material as canon.

## Questions for you

Say "approved as written", or change any of D1 to D10. In particular:
- **D2:** is "precision over recall" right? It will miss restatements written with only a pronoun.
- **D3:** is ±5 years the right margin for "c."?
- **D6:** the "pick the right value" fix.
- **D9:** the AU inheritance default.
