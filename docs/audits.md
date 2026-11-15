# Audits

Audits report what is inconsistent in a project's repository. They **never change anything**: they read the newest
complete full snapshot and the change snapshots after it, never LegendKeeper, so a run costs no API requests. The design
is [ADR 0044](adr/0044-audits.md); the owner's later decisions are in [ADR 0046](adr/0046-e4-owner-decisions.md)
decision 12. The findings are on the dashboard's **Audits** page and, read-only, through the `audit_findings` tool.

This page documents how two checks decide what to flag, because their rules are the owner's settings.

## Reference Types (`unknown_reference_type`, category Facts)

A Reference Type is **known** when it is a registry value (a character type's Core and Compact values, such as
"Character Core" and "Compact Character Reference"), a template's name stands for it ("[BSRC] AI Character Art
Template" is "Character Art"), an audit rule names it, or the owner lists it in the audit settings ("Reference Types
that are fine"). Case does not matter.

The setting **"Flag every Reference Type the registry and the templates do not know"** (`strictReferenceTypes`) decides
what happens to the rest:

- **On:** every unknown value is a finding.
- **Off (the default):** only an unknown value that **resembles** a registry value is a finding. Repositories such as
  Arkona use hundreds of free-form Reference Types ("Continent Reference", "Culture Reference") by design, and those are
  left alone.

A value resembles a registry value when **one** of these holds:

| Rule | Meaning                                                                                 | Example                                                                                          |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| (a)  | It is a registry value in other letters, spacing or punctuation.                        | "CharacterCore" against "Character Core"                                                         |
| (b)  | The page's name carries a registry page-name pattern.                                   | "Historical Character Reference" on "Mehrana I al-Khalid - Character Core"                       |
| (c)  | Its distinctive words are a non-empty subset of one registry value's distinctive words. | "Character Reference" ({character}) against "Compact Character Reference" ({compact, character}) |

**Distinctive words** are a value's words without the generic ones. The generic words are a fixed list
(`GENERIC_REFERENCE_TYPE_WORDS` in `src/audits/checks/taxonomy.ts`):

> reference, references, the, and, of, a, an

So "Continent Reference" ({continent}), "Character Biography" ({character, biography}) and "Relationship" resemble
nothing, and a value made only of generic words ("Reference") resembles nothing either.

### The expected value and "Propose a fix"

A finding names the right value, and offers a `set_facts` fix, **only when it is unambiguous**:

- the value is a registry value in other letters (rule (a)); or
- the page's name carries exactly one role's page-name pattern ("… - Character Core" expects "Character Core";
  "… - Character Reference" expects "Compact Character Reference").

Rule (c) on its own never gives one: "Character Reference" fits both "Character Core" and "Compact Character Reference".
Otherwise the evidence says `expected: null`, "no single right value can be told from the page".

## Race / Species (`race_not_in_taxonomy`, category Taxonomy)

A character page's Race / Species value is looked up among the taxonomy entries' plurals, singulars and aliases (case
ignored). Values the registry treats as unknown ("Unestablished" and the like) are skipped.

When the **whole** value matches no entry, its **anchor** is tried: the text before the first `(`, `;` or `-`, trimmed.
When that cut a hyphenated name ("Half-Elf (Northern)" gives "Half"), the text before the first `(` or `;` is tried as
well ("Half-Elf"). The page is never rewritten: this is how the audit reads the value, as the owner decided for qualified
chronology dates.

| Value                                                                  | Anchor                         | Result                               |
| ---------------------------------------------------------------------- | ------------------------------ | ------------------------------------ |
| Therian (Aggeloi)                                                      | Therian                        | matches Therians                     |
| High Human (Human subrace)                                             | High Human                     | matches High Humans                  |
| Sea Elf (contemporary classification; predates Sea Elves as a species) | Sea Elf                        | matches Sea Elves                    |
| Fire Genie (Elemental Genie; Genie race)                               | Fire Genie                     | a finding: no entry has "Fire Genie" |
| Unique draconic Heavenly Beast (Celestial Jade Dragon); …              | Unique draconic Heavenly Beast | a finding                            |

The audit never guesses from a word inside the anchor ("Fire Genie" is not taken to mean "Genies"). A finding names the
anchor it tried (in the message and as `evidence.anchor`); to accept the value, add the anchor as an alias of the right
entry in **Repository Mappings**, and the next audit matches it.

A match by anchor is checked for placement exactly as a full match is: a page whose race belongs to another index than
the one it sits under is `race_index_mismatch` (a subrace under its parent race's index is fine).
