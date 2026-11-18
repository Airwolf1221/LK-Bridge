# F3d design: `arkona_rename`, selective approval and resuming a package (for the owner's approval)

**Status:** APPROVED by the owner, 18 Nov 2026: D1 (a), D2 to D6 as written.

**Status (original):** draft for the owner's approval, 18 Nov 2026. It was built from Arkona read live: Lifecycle & Repository Maintenance (Revision in Place; Dependency and Continuity Integrity; Concurrent LegendKeeper Writing; Post-Write Verification), Source Formatting (Sidebar Metadata's name rules), Project Navigation (cultural renames), the Tagging Standard (identity tokens), and the appraisal's C1, E2 and E3.

**What your governance asks of a rename** (quoted):
- "When an owner keeps its conceptual purpose, revise that resource in place and **preserve its resource and document IDs**."
- "Renames and moves should **preserve IDs, refresh maintained labels and routes, and retain useful aliases**."
- "When an owned fact changes, **inspect affected applications, contextual restatements, dependencies, and index descriptions**. Update what the change actually requires. Remove obsolete wording… Do not duplicate the complete rule into every related page."
- "An existing cultural name, including a possible future Ruterran rename, **remains current until its replacement is approved and verified** in the correct owner."
- Name parts: "A regnal designation or title must not be arbitrarily split… **Do not … infer a surname** merely from the shape of the displayed name."
- Verification: "directly read the exact affected resources… **A successful request alone is not completion.**"

Since R2.1 (decision 5), **renaming an Authoritative page is always a canonical proposal**. So a rename is always yours to approve, whatever the agent's scope.

---

## 1. `arkona_rename`

**The input:** `subject` (a page: a character's index or Core, or an owner such as a culture, polity, place or race), `newName`, and, for people, the new **name parts** where they change (`given`, `family`). The tool never infers name parts; if the rename touches a name part and none is supplied, it refuses with `NAME_PARTS_REQUIRED`. Also `keepOldAsAlias` (default **true**, matching "retain useful aliases").

**The plan:** one rename package, built from A3's change impact and the full-text index. It's made of **items**, each one edit you can approve or leave out (section 2):

| Item kind | What it changes | Selected by default? |
|---|---|---|
| **Page names** | The subject's own pages: the index, the Core or Reference, every `<Old> - …` child, and every `<Old> & <B> - Relationship` (or `<A> & <Old>`). IDs are kept; only names change. | Yes |
| **Identity facts** | Subject and Canonical Display Name; Given and Family only as supplied; Aliases gains the old name (if `keepOldAsAlias`). | Yes |
| **Resource aliases** | The old name is added to the pages' search aliases. | Yes |
| **Mention labels** | Mentions whose **custom label** is the old name. (Plain mentions show the page's current name automatically and need nothing.) | Yes |
| **Index routing** | Routing lines in indexes that name the subject. | Yes |
| **Chronology** | Table rows naming the subject, with their timeline events kept in step (the chronology tools' path). | Yes |
| **Taxonomy and art** | The character's taxonomy entry, its art folder (`Characters / … / <Old>`) and asset display names containing the old name. | Yes |
| **For a culture or race:** the identity token | The pack's token map (old token → new), as a **new pack version** for you to approve, and the **Naming Culture** or **Race / Species** fact and identity tag on every character that has the old value. | Yes |
| **Textual restatements** | Each plain-text occurrence of the old name elsewhere, **one occurrence per item, with its sentence for context**. | **It depends** (decision D1) |

**What a rename never touches** (decision D2): Archived pages, the Legacy Canon Archive and Design References keep the old name, because that's their historical record. They're listed in the plan as "left as historical", so you can see them.

**One job, then verification.** On approval the selected items run as **one job**, in dependency order (names first, then facts, then everything that points at them). Afterwards it:
- **reads back every touched page directly**, as Post-Write Verification requires;
- **searches the full-text index for the old name again**, reporting any remaining current occurrences that weren't selected, which you can act on later;
- re-checks inside the lock that the subject still has the old name. If someone renamed it meanwhile, nothing runs.

**Cost:** a rename can be large; a culture rename can touch dozens of pages. The plan states its cost, and section 3 makes a stop part-way safe.

## 2. Selective approval (E2): approve some items, not others

This is for any proposal made of **items**: rename packages, and also F3a and F3b's character, owner, relationship and art packages.
- **The Proposals page** shows each item with a tickbox, its diff and its dependencies. You can untick items, then approve.
- **Dependants are dropped automatically.** Unticking an item drops everything that needs it, and the page shows which items went with it before you confirm. For example, unticking a page rename drops the routing lines that point to the new name. Unticking a character's Core in a package drops the pages that hang off it.
- **The record:** the proposal keeps exactly what you approved and what you left out, and the job runs only the approved set. The items you left out are listed afterwards. They aren't silently lost, and you can propose them again later.
- **Agents can't approve.** Selective approval is yours, on the dashboard, as approval always is.
- Proposals that aren't made of items (an ordinary `write_page`, say) are unchanged.

## 3. Resuming a package that stopped part-way (E3)

F2 did this for recreating snapshots. This generalises it to packages and renames.
- A package job that stops part-way records its last **verified** step.
- The job then shows **Resume** on the Jobs and Review pages.
- **Resume** re-reads everything that's left, re-checks each step's preconditions (inside the lock, as the original would have), and continues from there. It **never** repeats a step that verified, and never creates a second page or document.
- If something changed in the meantime that makes a remaining step unsafe, that step is refused with its reason, and you decide.
- Resuming a canonical package needs no fresh approval, because it's the same approved plan, but it is audited.
- A partly applied package can also be **Reverted** for the steps it completed (ADR 0055), as an alternative to resuming.

---

## Decisions for the owner

- **D1, textual restatements.** Which occurrences are pre-ticked?
  - **(a), recommended:** pre-tick occurrences on current Authoritative and Working pages. **Leave unticked**, for you to decide, any occurrence that is in quotation marks, follows "formerly", "previously", "once called" or "originally", sits under Unresolved Material, or is in a chronology row's description dated before the rename's effective date (if you give one).
  - (b): every occurrence starts unticked.
  - (c): every occurrence starts ticked.
- **D2:** Archived pages, Legacy Canon Archive and Design References are never edited by a rename, only listed.
- **D3:** a culture or race rename includes the identity-token change and the character facts and tags in the **same** package, with the pack's token map coming in as a new pack version. Alternatively, leave tokens to F3f (retagging).
- **D4:** new name parts must be given explicitly; the tool never infers them.
- **D5:** selective approval applies to every item-based proposal (renames and all packages), not just renames.
- **D6:** Resume needs no fresh approval for an already-approved plan, but it is audited.
