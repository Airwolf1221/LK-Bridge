# F3e design: `arkona_split_appraisal` and `arkona_split_owner` (for the owner's approval)

**Status:** APPROVED by the owner, 18 Nov 2026: D1 to D7 as written.

**Status (original):** draft for the owner's approval, 18 Nov 2026. It was built from Arkona read live: Character Architecture (Start Compact, Split Deliberately; Split Triggers; Anti-Fragmentation Rule; Existing-Monolith Development Rule; Monolith Migration Procedure, steps 1 to 9; Growth Review) and Lifecycle & Repository Maintenance (Splits and Replacement; Retirement, Archive, and Deletion; Post-Write Verification).

**What your governance asks of a split** (quoted):
- "Before a split or replacement, **account for current material** across the applicable sources… **Assign each claim or coherent section to a destination**, preserve qualifications and unresolved matters… **Do not discard a valid item**."
- "Create approved replacement owners using the correct templates. **Verify their coverage, metadata, links, and boundaries before removing the old full definitions.** Replace duplicated sections in a surviving broad owner with **compact interface summaries and exact links**. **Retire the old owner only when coverage and incoming routes are verified.**"
- "**Do not delete a predecessor merely because a replacement write returned success.**"
- The Monolith Migration Procedure: a retained-authority audit; one primary owner per claim ("do not duplicate the entire monolith"); relationship, universal-vs-character and visual audits; index construction; dependency repair; retirement only after verification; then direct re-reading of the source graph.
- Anti-Fragmentation: "**Do not split merely because a character has many facts.** The unit of ownership is a coherent subject… Do not create four small files where one clear owner is better."

So the bridge **never decides what to split**. It appraises (A6), and it carries out a split that the agent has planned and you have approved (C2), proving at every step that nothing is lost or duplicated.

---

## 1. `arkona_split_appraisal` (A6): read-only, and free

For one page or a branch, it applies the **Split Triggers** that can be measured, with **Anti-Fragmentation** as a counterweight. Results go into F3c's groups as **architectural candidates**:

| Trigger | What it measures |
|---|---|
| Scope Overload | The Scope lists **3 or more** separate domains (biography, appearance, personality, relationships, powers, wardrobe, career…). |
| Retrieval Cost | Long text (over a threshold, in words) **and** 2 or more top-level sections in different domains. Length alone never counts ("Source length alone is not an automatic trigger"). |
| Asset Ownership | A non-Art page that interprets several images, or has a wardrobe, form or outfit section with images. |
| Shared Ownership | A section about a relationship with one named character, long enough to stand alone, when no relationship owner exists for that pair. |
| Distinct Unresolved Material | Unresolved Material whose items cluster under one domain. |
| Distinct Dependencies | Dependencies that cite universal owners only one section relies on (for example, magic rules cited only from a Powers section). |

Each result names the trigger, the evidence (section names, counts, sizes), a **draft destination map** (which sections might go where), and the **Anti-Fragmentation note**: sections that look closely related and should probably stay together, using the rule's own examples (personality and habits; body, face and forms; a shared romantic hierarchy). It never acts, and it is only ever a suggestion. Independent Retrieval, Independent Maintenance and Downstream Dependency are judgement calls the tool can't measure, so it lists them as questions for you.

## 2. `arkona_split_owner` (C2): a planned, verified split

**What the agent supplies:** the source page, and a **destination map** that assigns every section (and, where needed, individual blocks inside a section) to exactly one of:
- **a new owner**: its template and type (through F3b's owner rules, or F3a's for character pages), name, Scope and facts. For a character, it lands in the character's index;
- **an existing owner**, where the section is appended, under a heading the agent gives;
- **a relationship owner**, existing or new (F3b's relationship rules);
- **"stays"**, kept in the source;
- **"universal"**: the material belongs to an existing universal owner (species, culture, magic, law…) and is **not** migrated. The agent must supply the **subject-specific application text** that replaces it, and the universal owner becomes a Dependency. (This is step 4, "do not migrate universal… rules into character-specific owners".)

**What the tool checks before it proposes anything** (steps 1 and 2: the retained-authority audit and ownership assignment):
- **Coverage:** every block of the source is assigned exactly once. **Anything unassigned or assigned twice is refused** (`SPLIT_COVERAGE`), with the list. Nothing can be lost by omission.
- **No duplicated authority:** a section can't go to two destinations.
- **The visual audit** (step 5): if a section interprets images or assets, its destination must be an Art or visual owner, or "stays".
- **The relationship audit** (step 3): a section naming one other character as a joint subject is flagged if it isn't going to a relationship owner. It's a warning, not a refusal; you judge it.
- **New pages follow the pack:** names, templates, tags, AU and lifecycle all go through F3a and F3b's rules. A new owner of a canon character is created as canon in the same canonical proposal.

**The plan shows:**
- every destination;
- the **interface summary** the source keeps for each section that moves. The agent writes it, and the tool requires one per moved section if the source survives ("compact interface summaries and exact links");
- the **index entries** with their why-to-open lines (step 6);
- **every incoming Dependency** (from F3c's change impact) and what it will point to (step 7). The agent maps each one to the new owner it actually needs. If the source is to be retired, every one **must** be mapped; if it survives, unmapped ones keep pointing at it, and you see the list.

**Two phases** (steps 8 and 9, and "do not delete a predecessor merely because a replacement write returned success"):
1. **Phase 1, one job:** create the new owners, move the content (block for block, verbatim, with IDs preserved where LegendKeeper allows), write the interface summaries, update indexes, and repair Dependencies. Then **verify**:
   - a content check that every original block's text now appears in **exactly one** place across the destinations, interface summaries aside;
   - every new page's Scope and facts are set;
   - no active Dependency points only at content that left;
   - a direct re-read of the whole affected graph.
2. **Phase 2, retirement:** only if phase 1 verifies, the bridge **automatically creates a separate proposal** to retire the source. Retiring means **archiving** it, through the lifecycle tools, so it's always yours to approve. **The split never deletes the source.** Deletion, if you ever want it, is a separate decision of yours. If the source survives as a broad owner, there's no phase 2.

**Always a proposal.** A split creates and changes several owners, often canon, so it's a canonical proposal at every scope, like renames.

**It works with F3d's tools:**
- **Selective approval:** each destination is an item. **Unticking a destination doesn't lose its content**; its sections automatically become "stays" in the source, and the page shows that before you confirm. Coverage holds whatever you untick.
- **Resume:** a stopped phase 1 resumes without repeating anything.
- **Revert:** phase 1 can be reverted, putting the moved content back and removing what it created (the created pages go to a deletion proposal under the rails), as long as nothing has been edited since.

**Not characters only.** Lifecycle's split rules apply to any owner. Character Architecture's extra audits (relationship, universal-vs-character, visual, index) apply when the source is a character page.

---

## Decisions for the owner

- **D1:** content is assigned **by section**, with block-level assignment allowed inside a section when it has to be divided.
- **D2:** retirement is **always a separate phase 2 proposal**, after verification. Retiring means **archiving**; the split never deletes.
- **D3:** "universal" material isn't migrated. The agent must write the subject-specific application text, and the universal owner becomes a Dependency.
- **D4:** the appraisal's thresholds: Scope Overload at 3 or more domains; Retrieval Cost needs length **and** 2 or more domains. Both are pack data you can tune.
- **D5:** when the source is retired, **every** incoming Dependency must be remapped. When it survives, unmapped ones stay and are listed.
- **D6:** unticking a destination keeps its content in the source, never lost.
- **D7:** a split is always a canonical proposal, at every scope.
