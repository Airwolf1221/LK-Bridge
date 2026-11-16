# Audits

Audits report what is inconsistent in a project's repository. They **never change anything**: they read the newest
complete full snapshot and the change snapshots after it, never LegendKeeper, so a run costs no API requests. The design
is [ADR 0044](adr/0044-audits.md); the owner's later decisions are in [ADR 0046](adr/0046-e4-owner-decisions.md)
decision 12. The findings are on the dashboard's **Audits** page and, read-only, through the `audit_findings` tool.

This page documents how three checks decide what to flag, because their rules are the owner's settings.

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

## Authoritative without CANON (`lifecycle_inconsistent`, category Lifecycle)

A `[BSRC]` page normally needs Status Authoritative, the `CANON` tag and a place outside the Working and Archived areas.
The lifecycle setting **"Indexes whose pages are Authoritative without CANON"** (Projects page, Lifecycle; empty by
default) lists indexes, such as Arkona's `[INDEX] Design References`, beneath which a `[BSRC]` page is consistent with
Status Authoritative and **without** `CANON`, at any depth. Pages inside the Working and Archived areas keep their own
rules.

There, `CANON` is itself a problem: the finding's tag signal expects "no CANON (Design References area)", and the
evidence names the area (`canonExemptArea`: its id and name). Status and the other status tags are checked as
everywhere. A page outside a listed index still needs `CANON`.

## Duplicate asset folders (`duplicate_asset_folders`, category Asset library; v3 F2)

[ADR 0049](adr/0049-v3-f2-last-major-revision-default-project-and-staging.md) decision 9. Read-only, from the bridge's
asset tree (no request): two or more sibling folders with exactly the same name (byte for byte, as LegendKeeper stores
names). The finding gives each set's path and, for each folder, how many assets it holds (and which is the earliest the
bridge saw). Before v3 F2, two placements planned while a folder chain was missing could each create it.

**Propose a fix** (`merge_asset_folders`, ONE proposal):

1. the assets of the later duplicates move into the earliest one, matched folder by folder down the chain (a subfolder the
   earliest also has, by exact name, is merged the same way);
2. each duplicate the moves empty is deleted, deepest first; each delete checks the folder again when the job runs and
   skips one that is not empty then (never deleted with what is in it).

An asset whose name the earliest folder already holds is moved anyway, never deleted, and the proposal says so. A
duplicate that would still hold something (a subfolder with no match) is never deleted. Pre-images are journalled as for
any move and delete (a deleted folder's bytes are kept).

## Chronology: an event in a tie (`chronology_event_in_tie`; v3 F2.1)

ADR 0048's F2.1 amendments. An unpaired timeline event that unpaired rows of its age's table could own (the same date, the
same start, or its name). It is never reported as `chronology_event_without_row` and never offered for deletion. Its fix
(`chronology_pair`) lists the candidate rows (date and opening words) with **Pair with this row** for each: one
`sync_timeline_event` proposal for that row with the event's id (`POST /audits/findings/:id/propose-fix` with `rowId`).
A chronology fix refused because several events could be a row's own shows them with **Use this event** (`eventId`) and
**Make a new event** (`createNew: true`).

## Chronology: an event's date tail out of step (`chronology_name_drift`; v3 F2)

ADR 0049 decision 1. A linked qualified event whose name ends with a date tail the bridge wrote, which no longer says what
its row's Date cell says although the date agrees (the cell's wording changed). **Propose a fix** goes through
`sync_timeline_event` and makes a name-only update.
