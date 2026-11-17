# F3c design: appraisal tools and full-text search (for the owner's approval)

**Status:** APPROVED by the owner, 17 Nov 2026 (D1 to D4 as written), with the owner's addition in section F below.

**Status (original):** draft for the owner's approval, 17 Nov 2026. It was built from Arkona read live: Repository Automation (in full), Source Formatting (Sidebar Metadata; Body Structure; Completeness and Terminology; Links, Dependencies and Tags; Indexes), the Tagging Standard, and Visual References (as F3a and F3b used it).

**What F3c is:** the read-only half of the pack. It covers appraisal tools A1 to A5 from the appraisal: A6, the split appraisal, goes with F3e, and A7, the brief, shipped in F3b.

**Repository Automation sets the boundary, and every tool here keeps to it:**
- "Automations are diagnostic and read-only by default. Report detected issues and the appropriate interactive follow-up; do not silently perform the repair."
- **No tool in F3c writes to LegendKeeper.** A finding may carry a *suggested* follow-up, which the agent can turn into an ordinary proposal through the existing tools, but the appraisal itself never proposes anything.
- Every report says what it inspected, how fresh its data was, and what it could not check ("Inaccessible" or "Incomplete"). It never guesses to fill a gap.

All five read the nightly snapshot plus the change snapshots since, as the audits do, so they cost **no API reads** unless `live: true` asks for a fresh read of the pages concerned.

---

## A1. Full-text search over the snapshots (an enabler, and better search)

- **An SQLite FTS5 index** of every page's text: block text, sidebar fact values, page names and aliases, by page, document and block. It's built from each nightly snapshot and updated from the change snapshots, so it's complete as of its stated time. LegendKeeper's own content search is "ranked and incomplete".
- **The `search` tool gains it.** `content: true` now searches this index first and supports the existing operators (phrases, OR, NOT, brackets), returning page, document, section path and a short snippet. LegendKeeper's live search stays available as `content: "live"`. Results say how fresh the index is.
- **Scope (decision D1):** everything in AI REPOSITORY. Results are labelled by lifecycle (Authoritative, Working, Archived) and by branch. **Legacy Canon Archive and Design References are excluded by default**, because they're non-current; `include: ["legacy", "design"]` brings them in.
- It's never proof on its own. Results are discovery evidence, as Repository Automation says.

## A2. `arkona_appraise_owner`: owner appraisal against Source Formatting

For one page, a branch (`under:`) or everything (bounded and paged), the tool reports in **Repository Automation's four groups**: **required defects**, **optional polish**, **architectural candidates** and **blocked cases**. Each finding is classed in its evidence terms (Confirmed deterministic defect, Potential Maintenance Issue, Explicitly Unresolved, Inaccessible…).

**The checks (decision D2 sets the groups):**

| Check | Rule it comes from | Group |
|---|---|---|
| The body begins with **Purpose** | Body Structure | Required |
| The page title or a metadata header is repeated at the top of the body | Body Structure | Required |
| Links inside headings | Body Structure | Required |
| Literal Markdown pasted as text (`**`, `# `, `- ` or pipe tables in text runs) | Body Structure | Required |
| Decorative blank paragraphs | Body Structure | Polish |
| Em dashes in the name, headings or prose | Page Names and Templates | Required |
| A template field is missing from the sidebar, or an extra field has been improvised | Sidebar Metadata | Required |
| **The character completion gate:** Given Name, Family / Surname, Race / Species, Naming Culture, Life State and Temporal Scope are each populated, with no blanks, whitespace or untouched placeholders. "Unestablished" is accepted. | Sidebar Metadata | Required (Core and Compact only) |
| No Source Boundaries section, or no Unresolved Material section | Body Structure ("where applicable") | **Polish**, never required, since "where applicable" is a judgement |
| A Dependency on a Working or Archived page | Links; Related Sources | Required |
| A Working or Archived page in an Authoritative page's Related Sources | Related Sources | Required |
| An empty Related Sources collection | Related Sources ("acceptable after an actual review") | **Polish**, worded as a prompt to review, not a defect |
| A Related Sources link with no reciprocal link between close specialist owners (Core and its Art, Appearance, Biography, Wardrobe…) | Related Sources | Polish |
| An index with no scope statement, no "why open" text, or no Subpages collection | Indexes | Required |
| Sibling order in an index (INDEX pages first, then the rest, each alphabetical) | Sibling Ordering | Required (reuses the existing ordering audit) |
| Tags outside the closed grammar | Tagging Standard | Required (reuses the existing tag audit) |
| Scope overload, or a Core holding biography or powers | Character Architecture | **Architectural candidate** (only a pointer; A6 does the full analysis in F3e) |

**The existing audits are reused, not duplicated.** A2 gathers that page's open findings from today's audits and adds the checks they don't cover. Each finding names the rule it comes from, with the governance page and section.

## A3. `arkona_change_impact`: what depends on this

Given a page, a pending proposal, or a planned rename (`renameTo`), the tool lists everything connected, split into two groups:
- **Proven breakage:** Dependencies or Related Sources pointing at a page that is deleted, archived or Working; mentions whose target is gone; for a rename, mentions and chronology rows whose displayed text will no longer match.
- **Review candidates:** incoming Dependencies and Related Sources; mentions; chronology rows naming the subject; **textual restatements**, found through A1 by name and aliases, where another page restates facts about the subject.

Each comes with its page, its section and a snippet. Repository Automation is explicit that "a resource change is not proof every document changed substantively", so restatements are only ever review candidates.

## A4. `arkona_working_digest`

- Every Working page, with its Status, Scope and age.
- Every **pending or conflicted** proposal.
- **Approved but not promoted:** Working sets whose package was approved but whose pages are still `[BWRK]`.
- **Declared contradictions:** Working pages whose Unresolved Material says "contradict", "conflict" or "supersede".

Age is shown, never judged: "Age alone is a review signal". The digest is ordered by most recent change and takes a `since` window. (Decision D3: no "stale" threshold.)

## A5. `arkona_visual_hygiene`

All read from the asset tree and the snapshots:
- asset names that **include a file extension** (forbidden);
- **non-WebP** assets;
- an asset outside its subject's `Characters / <race path> / <Name> / Forms|Outfits|Details` folder, compared with the page that uses it;
- **orphan candidates:** assets no page's image block or Art page uses;
- **broken image references:** image blocks whose asset is gone;
- **Art pages without interpretation text** for an image;
- **conflicting primary references:** two images labelled as the Primary Reference for one subject.

All are reported as candidates, never as defects to repair automatically. "Visual conclusions require inspectable imagery and the written owner."

## Where the results appear (decision D4)

- **Tool results** for agents, paged, with handles for large reports.
- **A new dashboard page, "Appraisal", in the Quality group.** It lets you run A2 to A5 on a page or branch and read the report, with each finding linking to the page in LegendKeeper. Nothing on it writes.
- **Reports aren't stored in LegendKeeper.** Repository Automation says reports belong in the response unless persistence is explicitly authorised. The bridge keeps the latest run per tool in its own database, for comparison, as the audits do.

## F. Actioning findings: "Propose a fix" (owner addition, 17 Nov 2026)

> "I would also like options down the road for this to be given clean ways to action the problems they find, similar to the 'Propose a Fix' workflow of the audits."

**How this fits Repository Automation.** Its rule is that a diagnostic *job* never repairs by itself ("report detected issues and the appropriate interactive follow-up"). An owner, or an agent at the owner's request, choosing to act on a finding **is** that interactive follow-up. So the appraisal tools stay read-only, and a fix is always a separate, explicit request that becomes an ordinary proposal for the owner to approve.

**Built now, in F3c:**
1. **Every finding carries a structured `followUp`:**
   - `kind: "fix"`: a deterministic repair, with the exact tool and arguments that would propose it, and a one-line description of the change.
   - `kind: "judgement"`: there is no single right repair. It names the tool an agent would use and what has to be decided (for example "write a Purpose section: needs the subject's purpose from the owner or its sources").
   - `kind: "none"`: report only (for example an orphan asset candidate).
2. **"Propose a fix" on the Appraisal page and through an agent tool** (`arkona_appraisal_fix { findingId }`), for the deterministic set:
   - **an em dash** in a name, heading or prose: replace it with an ASCII hyphen. Name changes go through `update_resource`; headings and prose through `write_page`, keeping every other character;
   - **decorative blank paragraphs:** remove them;
   - **links inside headings:** keep the heading text and drop the link;
   - **an asset name with an extension:** rename it, dropping the extension, with the collision check;
   - **sibling order and closed-grammar tags:** hand over to the existing audit fixes rather than duplicating them;
   - **a Working or Archived page in an Authoritative page's Related Sources:** remove that link. Removing a **Dependency** on a Working page is `judgement`, because the governing owner may need replacing rather than dropping.

   Each "Propose a fix" re-reads the page live, checks that the finding still holds, and then produces **one ordinary proposal**, with Last Major Revision decided by ADR 0051's rule (most of these are minor). Nothing is ever applied without the owner's approval. A stale finding says so and proposes nothing.
3. **Batch fixes**, a branch's em dashes in one proposal for example, are **not** in F3c. They're noted for later, alongside F3d's selective approval.

**Later sessions** can add fixes to the deterministic set as they prove safe. Each needs its own rule for exactly what it changes.

## Decisions for the owner

- **D1:** the full-text scope (all of AI REPOSITORY; Legacy Canon Archive and Design References excluded by default).
- **D2:** the A2 check list and which group each check falls in, especially the three softened to polish: missing Source Boundaries or Unresolved Material, an empty Related Sources, and missing reciprocal links.
- **D3:** the Working digest has no "stale" threshold; age is shown only.
- **D4:** a dashboard "Appraisal" page, and no reports written to LegendKeeper.
