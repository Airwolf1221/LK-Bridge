# LK-Bridge F4c: fiction (design, for the owner's approval)

**Status:** APPROVED by the owner as written (20 Nov 2026), E1 to E10.
**Builds on:** F4a (`arkona_brief`, `arkona_name_check`), F4b (`arkona_as_of`, `arkona_consistency`), F3d (renames: renumbering), F3a (`arkona_create_character`: canon proposals) and F3c (the audits and "Propose a fix").
**Governs:**
- **Arkona - Narrative Story Planning & Drafting Workflow:** the planning hierarchy, the Question Gate, the Drafting Gate and the chapter-plan format.
- **Arkona - Fiction Writing Reference:** 32B, durable chapter persistence; 35 and 36, canon and invention.

This design adds the layout and the tools those references leave to "the established story workspace". The two references are amended (E10).

## What the owner decided (20 Nov 2026)

- **Each story is an index.**
  - Its **first child is the Story Map**. Act Maps nest under the Story Map, and Chapter Plans nest under the Act Maps (the Races of Arkona pattern, where a page holds child pages).
  - The manuscript has an **index per act** ("Act 1 - …") and **a page per chapter** inside it ("Chapter 1 - …").
  - **Chapter numbers run across the whole story**: Act 1 holds Chapters 1–3, Act 2 holds Chapters 4–6.
  - **Acts stay optional,** as the Workflow says. A story without acts has its Chapter Plans directly under the Story Map and its chapters directly under the story index. No empty or ceremonial act layers.
- **All stories go under Narratives**, in **"Main CANON"** (the only index allowed "CANON" in its name) or in an index for each AU defined under Continuities. The bridge offers the AU indexes.
- **When a story invents lore, the tools offer it as a canon proposal.** The owner accepts or rejects it.
- **Chapters begin with an in-world date**, exact or an approximate range. The maps plan the dates and the chapters carry them.
- **Narrative pages have no [BSRC] or [BWRK] prefix and no lifecycle tag.** They are tagged `Narrative`, plus their kind, plus `AU` for AU stories. They are exempt from the owner body rules (Purpose first, Source Boundaries, Unresolved Material).
- **The Life or Chronology Map is an optional overview page in each continuity index.**
- **The Chapter template exists** (`[BSRC] AI Narrative Chapter`). Its sidebar: Story, Act, Chapter Number, In-world Date, Continuity, POV, Chapter Plan, Draft Status, Last Major Revision, and the collections Characters Present and Locations.

## E1. The layout, as the pack's narrative config (pack data)

```
Narratives
├── Main CANON                        (continuity index)
│   ├── [optional] Life or Chronology Map
│   └── <Story>                       (story index)
│       ├── Story Map                 (always the first child)
│       │   └── Act 1 Map
│       │       ├── Chapter 1 Plan
│       │       └── Chapter 2 Plan
│       ├── Act 1 - <Title>           (act index, act order)
│       │   ├── Chapter 1 - <Title>   (chapter order)
│       │   └── Chapter 2 - <Title>
│       └── Act 2 - <Title>
│           └── Chapter 3 - <Title>
└── <AU name>                          (one per AU under Continuities)
```

- **Ordering inside Narratives:**
  - **Story Map first.** Then act indexes and chapters in **number order**, so Act 10 comes after Act 9, never alphabetically. Plans sit under their maps in number order too.
  - This is an exception to the ordering rule ("INDEX pages first, then alphabetical"). The ordering audit applies it so it doesn't report Narratives as out of order.
- **Names:**
  - `Act <n> - <Title>` and `Chapter <n> - <Title>`.
  - `Story Map`, `Act <n> Map`, `Chapter <n> Plan`. Each name is unique within its story, because the pages sit under their story.
  - The numbers in names and the Chapter Number field are kept in step by the tools (E5).

## E2. Narrative pages are their own kind

- **Classified by where they sit** (anything under Narratives) and by template. **No [BSRC] or [BWRK] prefix:** the narrative templates' naming pattern applies none.
- **Tags:** `Narrative`; then the kind (`Story`, `Story Map`, `Act`, `Act Map`, `Chapter Plan`, `Chapter`, `Chronology Map`); then `AU` for AU stories. The tools set them; the retag audit leaves Narratives alone.
  - **Change on the owner's side:** remove the `Working` tag from the Chapter template.
- **Exempt from:** the owner body rules, the character completion gate, split triggers, the tagging grammar and the lifecycle tools. Promoting, archiving or moving a narrative page to Working is refused, with "narrative pages have no lifecycle".
- **Never canon evidence:**
  - The consistency check (F4b) and `arkona_brief` never treat narrative pages as authority, as the Fiction Writing Reference says.
  - They can still be **checked against** canon (E6).
  - A chapter can mention canon pages freely.

## E3. Templates (the owner edits these; the bridge reads them)

- **Chapter:** as made. Placeholder text left unchanged in a real chapter is reported by the narrative audit (E8).
- **Story Map, Act Map and Chapter Plan** have the generic Working sidebar today. Suggested replacements, keeping **Continuity Type, Continuity and Inheritance** for AU work:

  | Template | Suggested sidebar |
  |---|---|
  | Story Map | Story Span (date or range); Planning Status (Planning, Drafting, Complete); **Principal Characters** (collection) |
  | Act Map | Story; Act Number; Act Span; Planning Status |
  | Chapter Plan | Story; Act; Chapter Number; **Chapter** (link to the manuscript chapter); Planned Date; POV; **Question Gate** (Open, Closed); Planning Status (Planned, Drafted, Reassessed) |

- The Chapter Plan's body already matches the Workflow's "Standard Chapter Planning Format" exactly, so it doesn't change.
- **Question Gate** as a field is what lets the audit enforce the Workflow's Drafting Gate.

## E4. Continuity indexes

- The narrative audit reports an AU defined under Continuities that has **no index under Narratives**, with a **"Propose a fix"** that proposes the index (named as the AU, tagged `Narrative` and `AU`).
- It is a proposal you approve, not an automatic action. Repository Automation's Default Boundary allows a diagnostic job to report but not to create.
- "Main CANON" is created once, the same way.

## E5. Writing tools (routine narrative organisation)

The Fiction Writing Reference (32B) says a request to write a chapter **authorises saving it**, and that this organisation "does not create new substantive canon owners". So at write scope these are **direct writes**: on the Review page and Revertible, never canon proposals. At propose scope they're proposals as usual.

1. **`arkona_story_create { continuity, title, acts?: [titles], span?, principalCharacters? }`:**
   - Creates the story index, its Story Map, and (when acts are given) the act indexes and Act Maps, from the templates, with tags and order.
   - An unknown continuity is refused, pointing to E4.
   - Refused if the story already exists in that continuity.
2. **`arkona_chapter_plan { story, number, act?, title, plannedDate?, pov? }`:**
   - Creates or updates a Chapter Plan under the right map, with its fields.
   - Its body comes from the template.
   - **The planning text itself is written with `write_page`.**
3. **`arkona_chapter_save { story, number, title?, act?, inWorldDate, place?, pov, charactersPresent[], locations[], draftStatus, markdown, baseVersion? }`:**
   - It saves the actual prose: 32B as a tool.
   - **New:** it creates `Chapter <n> - <Title>` under its act index, or the story index, and links it both ways with its Chapter Plan.
   - **Existing:** it fresh-reads, needs `baseVersion`, and **revises in place** (same resource and document; no duplicate pages).
   - **The dateline:** the tool **writes the dateline itself** as the first line, from In-world Date (and `place` if given), in the form `Isar 27th, 4A 645 · <Place>`. An agent's own dateline in `markdown` is replaced. So the field and the dateline can't disagree.
   - **The date must be readable by the calendar engine**, either exactly or as an approximate range; otherwise it's refused with the formats that are accepted.
   - **The prose is verified by direct read-back**, word for word (32B).
   - It refuses: a chapter number already taken by another chapter; an `act` that doesn't contain that number's position; and a story whose Question Gate is still Open on this chapter's plan, unless `overrideGate: { reason }` is given. The reason is shown to you, because the Workflow's Drafting Gate makes closing the gate a precondition.
4. **`arkona_chapter_insert { story, at, act?, title }` and `arkona_chapter_move`:**
   - These insert a chapter at a position, or move one between positions or acts, and **renumber every chapter and plan after it**.
   - Renumbering covers names and Chapter Number fields, through the rename engine (F3d), so links and mentions follow.
   - **It touches many pages, so it goes through the usual rails:** more than 10 pages becomes a proposal.
   - Renumbering never changes prose.

## E6. Reading tools

1. **`arkona_chapter_context { chapter | plan }`:** the smallest sufficient canon for drafting this chapter. It's free.
   - **As of the chapter's In-world Date** (or the plan's Planned Date): the POV, Characters Present and Locations run through `arkona_as_of`, plus each one's `arkona_brief`.
   - The chronology rows around the date.
   - **Open contradictions** on any of them.
   - The plan's Canon Constraints and Question Gate.
   - The previous chapter's closing state (its last section, and the plan's Closing State).

   This is the Workflow's "retrieve current authority sufficiently" step for one chapter, labelled by evidence class.
2. **`arkona_chapter_check { chapter }`:** a read-only check of a saved chapter against canon **at its date**.
   - **People:** a character who is **not yet born**, **deceased (recorded)** or outside their attested life at the date (the as-of states). A character in Characters Present who never appears in the prose, and the reverse.
   - **Ages and dates written in the prose** that disagree with as-of. This uses the F4b patterns only, never a guess.
   - **Names in the prose** that resolve to nothing in the repository: **new-lore candidates**. Names that resolve only to Archived or Legacy pages are flagged too.
   - **Locations** that don't exist, or resolve only to Archived pages.
   - **Continuity:** an AU chapter is read with the AU's facts first (F4b D9).
   - Each item is labelled **Contradicts canon**, **Not in canon (candidate)** or **Unestablished in canon**. It never edits anything.

## E7. From story to canon ("offer it; I'll say no if not")

- **`arkona_promote_from_chapter { chapter, candidate, as }`** turns one item of the check into a **canon proposal**, through the existing tools.
  - The **as** options:
    - a new **character**: `arkona_create_character`, Authoritative, so a canon proposal;
    - a new **page**: `create_resource`, Authoritative;
    - a **fact** or **text** on an existing owner: `set_facts` or `write_page`, made a proposal whatever the scope, because it states new canon.
  - The **agent supplies the content.** The tool never takes facts from the prose by itself. It sets up the proposal, cites the chapter, and runs `arkona_name_check` for new names.
- **The proposal cites the chapter** ("introduced in Chapter 4 of <Story>") **in the proposal note only.** It is not a Dependency, because Project Navigation says "A historical citation is not a current governing dependency". It is not a Related Source either, unless you choose.
- **What you see:** one proposal per candidate, or a selected few as **items** of one proposal (F3d), so you can accept some and reject the rest.
- **What it never does:** promote anything automatically, or treat your silence as acceptance.

## E8. The Narrative Integrity audit (nightly, category `narrative`)

This is the Repository Automation diagnostic that has no tool yet. It's read-only. Findings:
- **Structure:**
  - Story Map not first;
  - an empty act index (ceremonial, against the Workflow);
  - a chapter under the wrong act (Act field vs parent);
  - Continuity field vs the continuity index it sits in;
  - a missing `AU` tag in an AU branch.
- **Numbering:** gaps, duplicates, and names disagreeing with Chapter Number.
- **Plans and chapters:**
  - a chapter without a plan;
  - a plan marked Drafted with no chapter;
  - a broken two-way link;
  - **Question Gate Open on a chapter that exists** (the Drafting Gate).
- **Dates:**
  - a dateline that disagrees with In-world Date, or one the engine can't read;
  - a chapter dated **earlier than the one before it** without the `Flashback` tag (`info`);
  - a chapter's date outside its Act Span or Story Span.
- **Leftovers:** template placeholder text still in a field.
- **"Propose a fix"** where the fix is mechanical: numbering, links, dateline, tags and order. Never the prose.

## E9. Pack data and governance

- The narrative config is pack data: the names (Narratives, Continuities, Main CANON), kinds, templates, tags, name patterns, the numeric ordering and the `Flashback` tag. It isn't code.
- **The pinned governance:** the Workflow's "LegendKeeper Planning and Manuscript Structure" and the Fiction Writing Reference's "32B". A change to either means approving a new pack version, as usual.

## E10. Amendments to the two Design References

I'd write these into the pages once you approve this design. They're direct writes to Authoritative design pages, so they go on the Review page and can be Reverted.
- **The Workflow:**
  - "Story and Repository Boundaries" and "LegendKeeper Planning and Manuscript Structure" get the layout from E1–E3:
    - the continuity indexes and Main CANON naming;
    - the Story Map as the first child, with plans nested under maps;
    - act indexes and chapter pages, with numbering across the story;
    - stories without acts;
    - narrative pages without lifecycle;
    - the optional Chronology Map per continuity;
    - the Question Gate field.
  - It also names the bridge tools as the way to do these things.
- **The Fiction Writing Reference:**
  - **32B:** the chapter opens with its dateline, written from In-world Date; `arkona_chapter_save` is the persistence route; new lore goes through `arkona_chapter_check` and `arkona_promote_from_chapter`, accepted or rejected by you.
  - **32A** is ChatGPT-specific (its Writing Block). It gets a line saying what other assistants do: "use the product's editable writing surface where one exists; otherwise ordinary prose, saved with `arkona_chapter_save`".

## Questions for you

Say "approved as written", or change any of E1 to E10. In particular:
- **E3:** the suggested sidebars for Story Map, Act Map and Chapter Plan, and removing `Working` from the Chapter template.
- **E5.3:** the tool writes the dateline itself, and an Open Question Gate blocks a save unless a reason is given.
- **E8:** the `Flashback` tag for chapters dated earlier than the one before.
- **E7:** the chapter is cited in the proposal note only, not as a Dependency.
