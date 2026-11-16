# Arkona setting pack: the character tool (F3 design draft, 16 Nov 2026)

**Status:** APPROVED by the owner on 16 Nov 2026. All ten questions in section 5 take their recommended answers, with two changes: (1) em dashes are **replaced** with ASCII hyphens (names, headings and body text), not refused, and every replacement is listed in the preview; CANON or a date in a name is still refused. (2) Last Major Revision is set to today on every page the tool creates or substantially changes (the bridge-wide rule for other tools is session F2's). The original draft text follows. It is built from Arkona's own rules, read live on 16 Nov:
- AI REPOSITORY › **Character Architecture** (`p5rcvxze`);
- AI REPOSITORY › **Source Formatting** (`l41y28c8`);
- AI REPOSITORY › **Controlled Native Tagging Standard** v1.8 (`bfrv43jr`);
- the AI Character Core and AI Compact Character Reference templates;
- the real character sets of Kawasaki Kumiko, Mehrana I al-Khalid, Halime al-Sabri, Kamigawa Miyuki and the compact Vitra.

Where Arkona's pages already decide something, this draft follows them and says so. **The questions at the end are the only things left for you to decide.** Each has a recommended answer: reply only where you disagree.

---

## 1. What the tool is

`arkona_create_character` takes **one package** describing a character, and builds the right set of linked pages for it. It runs as **one proposal**: preview, then your approval, then a verified write. It also extends an existing character's set without duplicating it.

It is the first tool of the **Arkona pack** (PLAN-v2 section 10). The pack's rules are **data** (stored per project, editable on the dashboard), not code, so they can change when Arkona's governance pages change.

## 2. What Arkona's own pages already decide

| Rule | Source | What the tool does |
| --- | --- | --- |
| **Start compact, split deliberately.** Never pre-create a full scaffold; no empty or token pages for symmetry. | Character Architecture: "Start Compact" | It creates **only** the pages the package has real content for. An empty or placeholder section is refused. |
| A minor character can be **one Compact Character Reference**, with no index. | Character Architecture: "Character Reference as a Living Compact Source"; the Vitra compacts | **Minor:** one `{Name} - Character Reference` from the AI Compact Character Reference template, directly under the race or subrace index. |
| A **developed** character gets an `[INDEX] {Name}` with a Core and specialist owners **only for domains with real content**. | Character Architecture: "Developed Character", "Character Index"; Kumiko, Mehrana I | **Developed:** an index, a `{Name} - Character Core` (AI Character Core), and one page per supplied domain. |
| The Core holds **identity and routing only**, not biography, psychology, powers or wardrobe. | Character Architecture: "Character Core" | It **warns** when the Core text carries a large biography, personality or powers block, and suggests the split. It doesn't refuse: that's your judgement. |
| **The completion gate.** Given Name, Family / Surname, Race / Species, Naming Culture, Life State and Temporal Scope must all be filled in on the Core or Compact Reference, never blank. "Unestablished" is allowed only as a deliberate, stated outcome. | Character Architecture: "Required Naming-Culture Question…"; Source Formatting: "Mandatory character-field completion" | **Refused** if any of the six is missing or blank. "Unestablished" needs an accompanying reason, and the result tells the agent to **ask you** rather than guess. |
| **Placement:** under Characters, by established race and subrace; fallback Undetermined / Unknown. | Character Architecture: "Repository Routing"; Races of Arkona | It uses the registry's taxonomy (A3) from the Race / Species fact. An unmatched race goes to the fallback, with a warning. |
| **Names:** `[BSRC] {owner name}`; an ASCII hyphen, **never an em dash**, in names, headings or prose; no CANON or dates in names. | Source Formatting: "Page Names and Templates" | It **replaces** an em dash with an ASCII hyphen anywhere in the package and lists each replacement (owner decision, 16 Nov), and refuses CANON or a date in a page name. |
| **Body structure:** Purpose first, subject sections, then Source Boundaries and Unresolved Material where applicable; no repeated title or metadata header. | Source Formatting: "Body Structure" | It requires **Purpose** as the first heading. It warns if Source Boundaries or Unresolved Material is missing from a Core, Reference or Relationship page. It refuses a body that starts with the page's own title. |
| **The sidebar:** Status, Continuity Type `CANON`, Continuity `Main`, Inheritance `None`, Subject, Canonical Display Name, the name parts, Naming Culture, Aliases, Reference Type, Scope, Race / Species, Life State, Temporal Scope, Last Major Revision, Supersedes. | the AI Character Core and Compact templates; Source Formatting: "Sidebar Metadata" | It fills them in **template order**. Last Major Revision is today; Supersedes is `None` unless given. |
| **Tags:** a closed grammar. Core or Compact: `CANON, Character, {race singular}, {Naming Culture}`, with duplicates dropped. Specialist pages: `CANON, Character` plus at most one of Biography, Personality, Relationship, Character Art, Visual Reference, Wardrobe, Magic, Equipment. Relationships: `CANON, Character, Relationship`. Never "Unknown" or "Unestablished" as a tag; never inferred topic tags. | Controlled Native Tagging Standard | It **computes** the tags from the typed facts and the closed list. A race or culture with no approved token **holds that slot** (leaves it out and reports it) rather than inventing one. An agent's extra tags are refused. Working pages get `Working` and no CANON (v1.8). |
| **Relationships:** one page for a jointly constituted relationship, hosted under the participant where retrieval is most useful; it never gets either participant's race or culture tags. | Character Architecture: "Relationships"; Tagging Standard | `{A} & {B} - {Label}` from the AI Relationship template, under the named host's index, tagged `CANON, Character, Relationship`. |
| **Art:** a Character Art page with image blocks, stating what each reference establishes. Assets go in Assets › Characters › … › {Name}, with outfit subfolders. Semantic file names, WebP. Images don't become canon just by being uploaded. | Source Formatting: "Character Art and Assets"; Halime's Art page | `{Name} - Character Art` from the AI Character Art template. Images come from **staged uploads** (D3) and are placed on approval into the character's asset folder, which mirrors the repository path. Each image needs its interpretation text; a bare image is refused. |
| **Dependencies** name the actual governing owners; **Related Sources** is optional navigation and is reviewed on **each** page; no Working or Archived pages as current links. | Source Formatting: "Links, Dependencies, and Tags" | The package lists both per page. Every target is resolved to an exact id and must be a current `[BSRC]` page (a Working or Archived target is refused for a CANON page). Nothing is added automatically **except** what question 6 decides. |
| **Sibling order:** `[INDEX]` pages first, then substantive pages, each alphabetical. | Source Formatting: "Sibling Ordering" | Already done by the bridge (A3). |
| **Extending, not duplicating.** Existing characters are found by name resolution first. | PLAN-v2 10.4; Character Architecture: "Existing-Monolith Development Rule" | If the character exists, the package **extends** the set: new owners are added beside the existing ones. **Splitting an existing monolith is not done by this tool**: that's a later tool, F3b, because it moves established material and needs a migration plan. |

## 3. The package (what an agent sends)

```jsonc
{
  "name": "Halime al-Sabri",                 // the Canonical Display Name
  "depth": "developed",                       // "compact" | "developed" (question 1)
  "status": "working",                        // "working" (default) | "authoritative" (always a canonical proposal)
  "identity": {                               // the six gated fields, plus the rest of the sidebar
    "givenName": "Halime", "surname": "al-Sabri",
    "race": "Sun Elf", "namingCulture": "Menkheti",
    "lifeState": "Alive at 5A 931", "temporalScope": "…",
    "subject": "Halime al-Sabri", "aliases": "…", "supersedes": "None"
  },
  "pages": [                                  // only the domains with real content
    { "role": "core",        "scope": "…", "markdown": "# Purpose\n…", "dependencies": ["Sun Elves - Core Information"], "related": [] },
    { "role": "specialist",  "title": "Personality & Institutional Ethos", "referenceType": "Character Personality Reference",
      "specialistTag": "Personality", "scope": "…", "markdown": "…" },
    { "role": "art",         "scope": "…", "images": [{ "staged_id": "…", "label": "Primary Reference - Character Portrait", "subfolder": null }], "markdown": "…" },
    { "role": "relationship","with": "Nadira al-Khalid", "label": "Relationship", "host": "self", "scope": "…", "markdown": "…" }
  ],
  "index": { "markdown": "…" }                // optional: see question 8
}
```

## 4. The preview, approval and verify

- **The preview,** before anything is proposed:
  - the page tree it would make, with names, parents and positions;
  - each page's template, sidebar facts, computed tags, Dependencies and Related Sources;
  - the asset placements;
  - every **refusal** (blocking) and **warning** (yours to judge). Refusals include a gated field missing, an em dash, an unknown link target or a Working link target. Warnings include a large biography in the Core, a missing Source Boundaries section, or a race token with no approved tag.
- **The proposal** is **one** proposal, shown page by page (C2's page-level summary). An `authoritative` package is a **canonical** proposal ("Approve and accept as canon"). A `working` package builds a Working set under `[INDEX] Working`, and later `promote_page` with `subtree: true` moves it into canon as one set (C2d).
- **The verify** reads back after the write:
  - the six gated fields, as **separate checks**;
  - the tags in order;
  - the template's field set kept (no missing native rows);
  - parent and position;
  - each link target;
  - each image's bytes (SHA-256) and its block.

  Any difference is recorded on the job and the proposal, as Arkona's "completion gate" requires.

## 5. Questions for you (recommended answer first; reply only where you disagree)

1. **When does a developed character get an index?**
   - *Recommended:* always when there is a Core.
   - A Compact Reference gets an index **only** if the package also brings a Relationship, an Art page or any other sibling (as with Miyuki); otherwise it sits directly under its race index, as the Vitra compacts do.
2. **Which template do specialist pages use** (Biography, Personality & Lifestyle, Physical & Visual, Wardrobe, Powers & Mechanics, role-specific domains)?
   - *Recommended:* **AI General Source**, with Art pages on **AI Character Art** and Relationships on **AI Relationship**.
3. **Reference Type for specialist pages.** Arkona's current values vary ("Biography", "Character Biography", "Character Personality and Conduct Reference"…).
   - *Recommended:* the package supplies it freely, and the preview **suggests** a value from a short list you approve once: Character Biography, Character Personality & Lifestyle Reference, Character Physical & Visual Reference, Character Wardrobe & Personal Presentation Reference, Character Powers & Mechanics Reference, Joint Character Relationship Reference, Character Art.
   - No mass renaming of existing pages.
4. **Tags on a new character `[INDEX]`.** Existing indexes vary: Halime's has none, Elyssarae's has Navigation plus topics, Naeri's has CANON plus Character.
   - *Recommended:* **none**. The Tagging Standard excludes navigation indexes from its grammar.
5. **The default lifecycle of a package.**
   - *Recommended:* **Working**: the whole set built as `[BWRK]` under `[INDEX] Working`, then promoted as one set when you're happy.
   - `status: "authoritative"` stays available, as a canonical proposal, for characters you've already approved in chat.
6. **Relationship links.**
   - *Recommended:* the new Relationship page is added automatically to **both** participants' Core or Compact Reference **Related Sources**, plus the hosting index's routing text if the package's index text names it. Nothing else is automatic.
7. **A missing gated field** (Given Name, Surname, Race / Species, Naming Culture, Life State, Temporal Scope).
   - *Recommended:* **refused**, and the result tells the agent to ask you.
   - `Unestablished` is accepted only with a reason, which is written into Unresolved Material.
8. **The index text.**
   - *Recommended:* the agent writes it.
   - If the package has none, the tool drafts a minimal one: Purpose, How to Use This Index with one line per child from its name and Scope, the Subpages collection, and Index Boundaries. The draft is shown in the preview for you to edit.
9. **The asset folder.**
   - *Recommended:* Assets › Characters › {the same race path as the repository} › {Name}, with outfit subfolders as the package names them (D3's `subfolder`). This is how Halime's assets already sit.
10. **Last Major Revision on creation.**
    - *Recommended:* today's date (YYYY-MM-DD), as the existing pages use.

## 6. Out of scope for F3a

- **Splitting an existing monolith** (Character Architecture: "Monolith Migration Procedure"). That moves established material, so it needs its own plan-then-approve tool (F3b).
- The other pack tools: outfits, species, institutions and nations.
- Selective approval (approving parts of a package) and resuming a part-built package (PLAN-v2 10.5).
- Naming-culture **research**. The tool checks that the fields are filled in and consistent; deciding the culture stays with the agent and you, as Arkona's rules require.
