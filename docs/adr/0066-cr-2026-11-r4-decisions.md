# ADR 0066: Decisions from the fourth review (CR-2026-11-R4)

Status: **Proposed** (21 November 2026). Part A records what this review's fixes chose where an earlier ADR said
otherwise or said nothing, built and tested, for the owner to confirm. Part B lists the questions left open, each with a
recommendation. The findings are in [docs/reviews/CR-2026-11-R4.md](../reviews/CR-2026-11-R4.md).

- Amends: [ADR 0058](0058-v3-f3d-renames-selective-approval-resume.md) decision 1.8 (the re-placing moves, A10);
  [ADR 0059](0059-v3-f3e-splits.md) amendment 1 (the sections a new owner answers for, A8);
  [ADR 0062](0062-dashboard-sessions-and-step-up.md) (its amendment 1, the sessions: S1 to S7);
  [ADR 0063](0063-v3-f4a-governance-drift-names-and-briefs.md) decision 3 (A4);
  [ADR 0064](0064-v3-f4b-consistency-and-as-of.md) D6 ("Pick the right value": P1 to P7), amendment 2 decision 3 (the
  aliases, A9) and its amendment 3 ("as of" and lives: C1 to C10);
  [ADR 0065](0065-v3-f4c-fiction.md) ("until then the tools are not listed", A1; its amendment 2, Narratives: N1 to N9).
- No migration. One pack version, `arkona-2026-11-21-r4` (A11).

## Context

The owner asked for a fourth independent review of everything merged after the third: F4a (the governance drift audit,
the name check, the brief), F4b and F4b.1 (the consistency check, "as of a date", "Pick the right value"), F4c (fiction:
the Narratives layout, the writing tools, the Narrative Integrity audit), ADR 0062's sessions and step-up, the tool
lists' change notice, and F4.1; with the owner's queued items (a split's section expectations as pack data, the third
review's four low findings, Aliases at commas) and two later requests (S: every sandbox check in the ordinary suite; L:
characters with more than one life). Most of the fixes make an existing rule hold on every route. These go further than
a rule as written, or choose where it said nothing.

## Part A: chosen by this review's fixes (built; for the owner to confirm)

### The tool lists (scope 5)

A1. **A pack's F4b and F4c tools are listed only while the version the owner APPROVED carries their rules** (R4-51).
ADR 0064 and ADR 0065 said "until then the tools are not listed"; they were listed whenever the CURRENT version
carried them, waiting or not, and then refused (they read the approved version at every call). Their listing now
reads the approved version (`PackService.approvedRules`): a version waiting for approval lists nothing new, and a
newer version that drops the rules hides nothing the approved one still serves. The package tools (character,
owner, split, the generic ones) are unchanged: listed while their pack is attached, refusing `PACK_NOT_CURRENT` while
a version waits (F3a's design; part B, question 1).
A2. **A connection the owner moves to another profile tells its sessions** (R4-52): the tool lists' watch compares each
connection's profile too (`PolicyStore.connectionProfiles`), so a 2026-07-28 session listening for changes gets
`notifications/tools/list_changed`. A connection made or removed tells no one (a new one asks for its list; a removed
one has no session left). A 2025-era session is told on its next request as before, per connection: stateless
serving has no session id, so two sessions of one connection share that one notice (best effort).
A3. **The tool lists read the pack through a kept copy** (R4-53): every MCP request worked its list out by parsing the
Arkona pack's rules 18 times (about 0.75 ms each). `PackService.peek` and `approvedRules` keep the pack until its row
changes (its version, approval or last change); the lifecycle guard's narrative rules are kept per stored version
(a version's rules never change, only its approval).

### F4a (scope 6)

A4. **ADR 0063 decision 3, completed** (R4-54): without its trailing generic word ("Standard", "Reference"…) a name must
keep two words or more to resolve as a whole name. "the Tagging Standard" resolved silently through any one-word
known name "Tagging" (a heading, a tag, a one-word subject), so a run inside a longer name escaped the near-miss
report. This narrows decision 3's generous resolution: "Moonlit Standard" no longer resolves to a page called
"Moonlit" (it is reported, as a near miss when it is part of a longer name). "the Fiction Writing Standard" still
resolves.

### The sandbox checks and the chapter tools (the owner's request S)

A5. **Every sandbox check runs in the ordinary suite against the mock**, through the same runtime and harness as the
owner's run (`test/sandbox-mock/`), and any item that is not PASS or NOTED fails the build, the whole report printed
(no slice of a tool's answer). Where a check depends on what LegendKeeper does, the mock models it as the owner's
runs established (or, where no run has, as the bridge assumes, and says so), behind an opt-in faithful setting so
the older tests see what they always saw (`test/sandbox-mock/faithful.ts`); a template copy holds each of the
template's documents with its content, in an order other than the template's (`copyTemplateDocuments`). The newer
checks' steps moved into runner modules beside them, which the owner's opt-in test and the mock run both call.
A6. **A new chapter's read-back compares what the job sent, to the document it sent it to** (R4-55, narrative-f4c's
N3): it compared the chapter's Markdown with the first page document listed, so a Chapter template with a second
page document (listed first), or a block of the template's that the job keeps, made it differ at its first word,
the dateline, on a chapter written as planned. The answer now says what it compared (`compared`).
A7. **The chapter tools refuse `NO_SNAPSHOT` when there is no full snapshot yet** (R4-56): every page they read, live or
not, is read through the snapshots' reader, and canon comes from the snapshots; `arkona_chapter_check` answered
`CHAPTER_UNREADABLE` ("could not be read") and suggested `live: true`, already its default.

### The owner's queued items

A8. **A split's new owners answer for Source Boundaries and Unresolved Material only where the pack expects them**
(amends ADR 0059 amendment 1): pack data, `splits.sections`, by the new owner's Reference Type (ignoring case), else
its role in a character's set, else its owner type, else `otherwise`. Arkona's seed follows the roles' own
`warnMissing`: a Core, a Compact Reference and a relationship owner both; an Art page and a specialist page
neither; any other owner both; no Reference Type named. A section a kind of page is not expected to carry is
recorded in the plan as "not expected" (shown to the owner), never refused; items of it may still move there, its
text may still be given; contradictory answers still conflict. A version without the data keeps amendment 1's rule.
A9. **Aliases split at semicolons, line breaks and commas outside brackets** (the owner's rule; amends ADR 0064
amendment 2, decision 3's departure, which split at semicolons only). Chosen: a semicolon inside a bracket does not
split either (a bracketed note holding one stays one note: "(from 4A 192; regnal)"); a piece that is only a date (an
unbracketed note's tail: "…, 4A 192") is no alias; an unclosed bracket keeps every comma after it.
A10. **The third review's four low findings** (R3-56, R3-58, R3-59, R3-60), as ADR 0058's amendment of 21 November 2026
records: a rename's re-placing moves follow the names written, in sequence (this changes how ADR 0058 decision 1.8
is worked out; a set already in order still moves nothing); the low-level rename steering reads a sidebar the tree
has not read, once, live (also for `lk_op_updateResource` and `lk_api_batch`); `arkona_appraisal_fix`'s name fix of a
subject carries a plain-rename reason rather than being refused (the fix is the owner's proposal, also from the
dashboard); a culture rename's tag write that the approved version no longer maps is skipped inside its lock, the
rest of the character's rename standing; "Propose these again" replays the approved part's renames first.
A11. **The pack version `arkona-2026-11-21-r4`** supersedes `arkona-2026-11-20-f41` and carries this review's pack data
(A8; amendment 3's phrasings, particles and word lists, C1 to C10). Until the owner approves it, the package tools
refuse as for every new version, and the consistency and narrative tools read the approved version's rules (A1).

### "Pick the right value" (scope 2; amends ADR 0064 D6)

P1. **The edit is placed where the check read the value, never searched for** (R4-11, R4-12; D6.2 said "editing only
the restated value", and the code replaced the first occurrence of the date's text). Each fact records the sentence
(or the field's `;` clause) it was read from and the date's offset there (outside any closed bracket first: the scan
reads none inside one, LD-09). The pick requires that sentence exactly once in the block or field as it is now, the
date whole at its offset and in one text run, and edits only that run. A sentence or clause changed since the
check, or written twice, is not planned and is listed with the value it holds now; so is a chronology row whose
Date cell or Historical Event changed (the newer date kept). The facts index is rebuilt once, from the snapshots, at
the first request after deploying (no LegendKeeper request).
P2. **An identity value keeps its qualifier** (R4-14; D6.2 said "an identity field's whole value"): only its principal
part (before the first `;`, `(` or spaced dash), which is all the comparison reads (ADR 0064 amendment 1 E), is
replaced; "Elf; raised among Humans (see Upbringing)" picked as Human becomes "Human; raised among Humans (see
Upbringing)".
P3. **A page archived, renamed or moved since the check is left as it is** (R4-15; D6.2's "each page read live first"
read only the sidebar or document): the page itself is read (its name, parent and tags; one more read a page, ADR
0064's Costs table amended); a page Archived, or filed under the Archived area, the Legacy Canon Archive or the
Design References since is listed and left; the job checks each page's name, parent and tags again inside its locks
and stops, writing nothing to it, on any change.
P4. **The pick names the value it was shown** (R4-16; D6.1's `{ side | value }`): the dashboard sends the side's value as
shown (`shown`); when the side reads otherwise now, the pick is refused `SIDE_CHANGED` and nothing is proposed.
P5. **A restatement inside a quotation is listed, never edited** (R4-19; as renames leave quotations, ADR 0058 D1 (a)).
Part B, question 6.
P6. **A chronology row is compared, and written, whole** (R4-17 and LD-08; R3-35's rule for renames, made general):
inside the lock the row is compared with the row as read (its marks, links and mentions included), and the write is
that row with only the cells the change makes replaced. This holds for the pick, for every `update_timeline_event`
(direct or a proposal) and for its Resume.
P7. **A typed value is one date, whole** (R4-18; D6.2 already said so, and the check let a range or a line break
through): a range, or a value holding a control character, is `VALUE_UNREADABLE`; the calendar's own reading of the
value is what is written. Part B, question 7.

### Narratives (scope 1; ADR 0065 amendment 2)

N1. **Moving any page into or out of Narratives is a proposal, and never changes its lifecycle silently** (R4-01; E2
exempted narrative pages from the lifecycle and nothing guarded the boundary). Narratives is an area the lifecycle
guard knows, by the id the narrative tools resolve (none when missing or ambiguous: every page keeps its lifecycle).
A crossing on any route is a proposal at every scope, judged again inside the lock; canonical when a page of it
carries a lifecycle signal (a prefix, a status tag in any spelling, a lifecycle Status), the proposal naming each.
Chosen: a move OUT with a signal is canonical too (the page takes a status signal back into the repository).
N2. **Inside Narratives, an `AU` tag and a Status of Working are no signal** (the AU continuity's narrative tag, which the
tools set; the generic Working sidebar's own value, which the tools never write). Crossing the boundary, every
signal counts.
N3. **A marker's `to: null` declares placement and a new page's first state only** (R4-02): the first state of a page the
same job creates is judged inside the lock from the job's own create steps (so it survives a restart), which the
narrative tools' template copies need; never a change of an existing page's Status, prefix or tags. The narrative
tags fix only adds tags.
N4. **`AU` is not a status tag on a page in Narratives without a lifecycle prefix.**
N5. **The audit's own Main CANON fix may still make that index** (declared by its marker, directly under Narratives), and
a page that already holds a narrative index's name may be renamed within it; no other route gives a page those
names (R4-04).
N6. **The writing tools refuse the whole story while it holds any lifecycle page** (`NARRATIVE_LIFECYCLE_PAGE`, R4-08);
the reading tools are unaffected; the audit reports each such page (`narrative_lifecycle_page`).
N7. **A narrative page restored to where it was, with no signal, crosses nothing.** Other creates and restores into
Narratives are ordinary proposals unless the existing rules make them canonical.
N8. **A move costs one more read inside the lock** (the destination, read live), plus a subtree listing when it crosses;
a create trusts the tree, as ADR 0057's accepted residual risk.
N9. **Canon filed under Narratives stays canon** (the lead, NA-43 and LD-10): a page under Narratives whose name carries
a lifecycle prefix is evidence for the facts index and a known name for `arkona_chapter_check`, so a canon set the
owner files there (approving the canonical proposal, or in the app) keeps its births and deaths in the checks while
the audit reports it.

### "As of" and consistency (scope 3; ADR 0064 amendment 3)

C1. **"Between lives (recorded)"** is the state between a death and a later life (a return, a restoration, a later named
life's birth); "Deceased (recorded)" now means a death with no later life (F4c said "Deceased (recorded)" between a
death and a return).
C2. **A death restated on another Authoritative page feeds the death guard** (R4-26): with the Life State "Alive" the
answer after it is "Unestablished (recorded death; current Life State Alive)", never a bare "Deceased (recorded)".
C3. **Lives are sorted by date**: a start opens a life, a death closes it; a plain birth after a closed life opens a new
life; a return or a restoration while a life is open closes that life with no recorded death.
C4. **Lives are named** "the first life", "the second life", … and "the restored life"; `died` shows the death of the
life the date falls in, labelled with that life.
C5. **Elapsed years are counted within the life** the date falls in; none between lives; `born` stays the first life's
(what the coverage report counts).
C6. **In an AU its own pages come first** (R4-27): its birth and deaths when it states them, else Main CANON's resolved
values, labelled; an AU's own Authoritative value is never compared with the inherited one.
C7. **Spelling differs**, a new information label and group, for a given name or surname that differs only in accents;
word order in identity values matters, except that the character's own given name and surname may be swapped
(R4-37; part B, question 8).
C8. **The seeded lists** (the relational particles, the doubt words, the words that may follow an alive value) are pack
data, edited on the Packs page. Two of them can cost a true answer: `aliveAt` read over the whole value may end an
alive span at an unrelated date inside a qualifier (it only ever makes an answer less Alive), and the particles
(by, and, to…) give up some true readings to avoid false ones.
C9. **A container opens a heading frame of its own** (R4-36): the full-text index's section paths change for every tool
that shows them, recomputed as pages are next read from a snapshot.
C10. **"Died by" in a Temporal Scope is no longer a death date** (R4-29), and is not read as an upper bound either.

### The sessions (scope 4; ADR 0062 amendment 1)

S1. **The consent page's step-up is a page of its own** (R4-42), shown after the consent form is submitted (whether it
is needed depends on the choice, and the page has no script); Deny needs none; a step-up made there counts on the
dashboard too (the same session). Ordinary `read` and `propose` connections and lowerings are not asked (part B,
question 2).
S2. **Approval and the low-level tools** (R4-43): low-level removals count only when the recorded tool is
`lk_api_write`, `lk_api_batch` or `lk_op_*`, as the entry rails count them; a `write_page` block deletion stays an
edit; a proposal with no recorded tool is not low-level; a session already stepped up is not judged (no reads); a
restore still counts as over 10 pages; the live recount of copies with children applies at approval too.
S3. **Member removals count at approval only** (R4-44); part B, question 10, asks about the entry rail.
S4. **An idle tab** (R4-46): opening the live stream is never a use (an EventSource cannot send a header); any request
more than 60 seconds after the owner's last key, click, touch or back or forward (the page load counts) is marked as
the dashboard's own.
S5. **The bounce and `Sec-Fetch-Mode`** (R4-49): the mode is not read on its own (Node's fetch always sends `cors`); for
browsers, `Dest: document` implies `Mode: navigate`. Chrome 76 to 79, which sent the mode without the destination,
is bounced as before.
S6. **The bounce pages' headers** (R4-48): the CSP is `default-src 'none'; img-src 'self'; form-action 'none';
    frame-ancestors 'none'; base-uri 'none'`, with `no-referrer` kept and no COOP (it would break the OAuth pop-up's
opener).
S7. **Recorded as ADR 0062 amendment 1** (proposed), with `docs/auth.md`, `docs/dashboard.md` and `docs/policy.md`.

## Part B: the owner's decisions (open)

1. **The package tools while a version waits** (A1). Options: (a) as built, listed while the pack is attached, refusing
   `PACK_NOT_CURRENT` until the owner approves the new version; (b) listed only while the current version is approved,
   as the F4b and F4c tools now are. Recommended: **(a)**. The refusal tells the agent exactly what to ask the owner;
   hiding the tools would make them vanish and return at every new version (each a `list_changed`), and an agent mid-task
   would lose the tool it was using rather than learn why it waits.
2. **The consent page and a new connection** (S1, R4-42). Options: (a) as built, asking for a raise, a new profile above
   the default scope, or a connection at `write`; (b) asking for every new connection, whatever its scope. Recommended:
   **(a)**. A `read` connection cannot write, and every write of a `propose` connection waits for the owner's approval
   (which asks for the step-up where ADR 0062 says so); asking for them would add a code to every read-only client
   while a stolen cookie that got one could still write nothing.
3. **Resuming a job the owner paused** (R4-59, SE-51). Options: (a) as built, one click; (b) asking for the step-up, as
   resuming writes and undraining do. Recommended: **(b)**, by the owner's own rule for ADR 0062 (tightening is one click,
   loosening asks): a pause is a brake, and its release runs writes. It costs one code at most every 10 minutes. SE-51
   is kept as an expected failure until decided.
4. **The routes ADR 0062 does not list** (pass 4's note): the tool registry, the marks kept in the bridge's tables only,
   "Mark resolved", `resume-stopped`, a forced step retry, a rehearsal's start. Options: (a) as built, one click each;
   (b) the step-up for those that run or resume writes (`resume-stopped`, a forced step retry, a rehearsal's start), one
   click for those that change only the bridge's own bookkeeping (the registry, the marks, "Mark resolved").
   Recommended: **(b)**, for the reason of question 3.
5. **The Narratives index by a confirmed id** (R4-04, N1). Options: (a) as built, the one index named Narratives found in
   the tree (none when it is missing or there are several: every page keeps its lifecycle), now that no page can be given
   that name; (b) the owner confirms the index's id once, on the dashboard, as the chronology's settings are confirmed,
   and a rename or a second index then changes nothing. Recommended: **(a)** for now: with the name protected on every
   route, (b) adds a setting to keep without closing a gap the review found.
6. **Quotations in the pick** (P5, R4-19). Options: (a) as built, listed and never edited; (b) offered as an item the
   owner may tick, unticked by default. Recommended: **(a)**, as renames leave quotations (ADR 0058 D1 (a)): a quotation
   records what was said, and a date in it is not the page's own claim.
7. **A typed range** (P7, R4-18). Options: (a) as built, a typed value is one date; (b) a range allowed where the side
   picked is itself a range. Recommended: **(a)**: a side that is a range can be picked as it stands, and a typed range
   cannot be placed in a sentence that states one date.
8. **Name order in identity values** (C7, R4-37). Options: (a) as built, word order matters except the character's own
   given name and surname swapped; (b) word order never matters (the words as a set); (c) word order always matters.
   Recommended: **(a)**: (b) hides "von Woerfels-Hohenfalk" against "von Hohenfalk-Woerfels" (two names), and (c)
   reports every "Yamato Katsuragi" written in the other order on a page about him.
9. **The lives design** (C1 to C5, the owner's request L). Options: (a) as built ("Between lives (recorded)", lives in
   date order, named "the first life" … "the restored life", elapsed years within the life, `born` the first life's);
   (b) as built but naming each life by the name it was lived under where the Temporal Scope gives one (Yasmin Arshama,
   Mehrana II), which needs a phrasing for it. Recommended: **(a)** now; (b) when the owner's Temporal Scopes name their
   lives regularly (pass the phrasing as pack data).
10. **Member removals at the entry rail** (S3, R4-44). Options: (a) as built, counted at approval only; (b) also at entry,
    so an agent at scope `write` with `LK_ALLOW_MEMBER_ADMIN` on proposes a removal rather than making it. Recommended:
    **(b)**: removing a member is not revertible from the journal, which is what the guarded rails are for.

## Consequences

No migration. After deploying, approve `arkona-2026-11-21-r4` on the Packs page; the facts index is rebuilt once at the
first request (from the snapshots), and the full-text index's section paths as pages are next read. Agents see new
refusals: `NARRATIVE_LIFECYCLE_PAGE`, `NARRATIVE_INDEX_NAME`, `NO_SNAPSHOT` (the chapter tools), and moves into or out
of Narratives answered as proposals; the dashboard's pick may answer `SIDE_CHANGED`; the owner sees a step-up on the
consent page, at the approval of a low-level removal or a member removal, and on the chronology settings. Every part A
choice is pinned by a test; each finding's test fails on the reviewed code (or on this review's first fix, where the
review says so) and passes now.
