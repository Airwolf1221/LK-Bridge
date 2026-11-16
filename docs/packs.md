# Setting packs (v3 F3a)

A **setting pack** holds one setting's rules as data, above the general bridge (PLAN-v2 section 10): which pages a kind
of subject gets, from which templates, under which names and in which place, with which sidebar facts and tags, and the
text rules its pages follow. The bridge's code holds the engine that applies any pack's rules and a few small hooks for
what data cannot say. The first pack is **Arkona**, attached to the `arkona` and `test` projects, and its first tool is
**`arkona_create_character`**. Design: [ADR 0050](adr/0050-setting-packs-and-the-arkona-character-tool.md) and the
owner-approved [character pack design](design/F3-character-pack.md). The tool's reference:
[tools.md](tools.md#setting-packs-arkona_create_character-v3-f3a). The agents' guide: the "Setting packs (Arkona
characters)" section of [bridge-guide.md](bridge-guide.md). The dashboard page: [dashboard.md](dashboard.md#packs-v3-f3a).

## What a pack holds

One versioned JSON document, its **rules** (`src/packs/types.ts` checks its shape):

- **settings**: `alwaysPropose` (every package is a proposal for the owner, whatever the agent's scope; on for a pack's
  first weeks).
- **tags**: the status tags (`CANON` for Authoritative, `Working` for Working, first and with no `CANON`), the values
  that are never tags (`Unknown`, `Unestablished`, `None`), the **token maps** (a Race / Species or Naming Culture value
  and the tag token it becomes) and the exceptional identity kinds.
- **names**: words never in a page name (`CANON`) and the date patterns refused in one.
- **sidebar**: the key-value property's title (`PROPERTIES`) and the two link collections (Dependencies, Related
  Sources).
- **types**, each with its tool name (`create_character` becomes `arkona_create_character`), its hook (or none), its
  placement (by a fact through the registry's taxonomy, with a fallback index; or under one fixed index), its **roles**
  (each with its template role, name pattern, Reference Type, tag slots, which facts it gets, whether text is required,
  the sections warned about when missing, and how many a package may bring), its identity fields (which are **gated**:
  required, never blank or a placeholder), the deliberate gap (`Unestablished`, only with a reason), the placeholders
  refused, the fixed facts, the closed list of specialist tags, suggested Reference Types, the asset rules (the folder
  names for forms, outfits and details; the image name; the Art page's section), the index rules (its Purpose, routing
  section, collection and boundaries) and the text rules (the first heading; the Core-overload warning).

Beside the rules a pack keeps its **governance sources** (the pages its rules were derived from: for Arkona, the
Character Architecture, Source Formatting and Controlled Native Tagging Standard v1.8 documents on the AI REPOSITORY
page), the projects it is **attached** to with the template ids it uses in each, every **version** of its rules, and the
owner's **approval**.

Storage (migration `3000`): `packs` (the current rules, governance, approval, drift), `pack_projects` (attachments and
template ids), `pack_versions` (every version with its reason) and `pack_reservations` (a running job's claim on a new
character's name, so two approved packages cannot both create it).

## Seed, attach, approve

1. **Seeded once.** At start the bridge stores each pack it knows (`src/packs/arkona.ts`, data) if it is not stored yet
   (audited `pack.seed`). After that the stored copy is the owner's: it is never overwritten by code.
2. **Attached** to the projects the seed names, when the bridge serves them (`pack.attach`). Template ids differ between
   projects: the home project's are given (Arkona's AI Character Core, AI Compact Character Reference, AI Character Art,
   AI Relationship, AI General Source and the index template); another project's are worked out from the home project's
   template **names**, matched exactly, from each project's templates as last read on Repository Mappings. A role that
   cannot be worked out stays unset, with a note on the Packs page, and a package that needs it is refused
   (`PACK_TEMPLATE_UNSET`) until the owner refreshes the templates and approves again (an approval works the unset ids out
   again).
3. **Approved** by the owner on the Packs page: the current version, with each governance source's document version read
   at that moment (`pack.approve`, re-authenticated). Until a version is approved, the pack's tools compute nothing.

A pack's tools are listed to agents only while the pack is attached to a project the bridge serves, and refuse any other
project (`PACK_NOT_ATTACHED`).

## Derived, never competing: drift fails closed

The Controlled Native Tagging Standard says a machine-readable translation of it must be "explicitly identified as
derived" and must "compare policy version/digest before writing". So:

- every preview reads each governance source's current document version (three reads for Arkona) and compares it with
  the approved one;
- every job reads them again, in the lock, before its first write (`PACK_GOVERNANCE_CHANGED` stops it otherwise);
- when a source has changed, or the rules were edited since the approval, or a source cannot be read, the pack is not
  current: **no tags are computed**, every package is refused (`PACK_NOT_CURRENT`, naming what changed), and the Packs
  page shows an alert (`pack.drift` is audited when a check first sees it). The owner reads the changed page, adjusts
  the token maps if needed, and approves again.

## Editing a pack

F3a edits only the **token maps**, on the Packs page: a value and its token per row, for Race / Species and Naming
Culture. A save makes a new version (`pack.set_tokens`, re-authenticated), which waits for approval. A token is never a
never-tag, and no value or token has an em or en dash in it. Everything else in the rules is read-only in F3a: the service's `replaceRules` command (the tests use it) makes a new
version the same way (`pack.replace_rules`), and a seed never overwrites a stored pack.

**A value with no token is held, not invented.** When a character's race or naming culture has no token, that tag slot is
left out and reported in the preview (`heldTags`); the page is still made. Add the token on the Packs page and approve,
then add the tag with `update_resource` if the page should have it now.

## The tags Arkona computes (Controlled Native Tagging Standard v1.8)

| Page                              | Tags, in order                                                           |
| --------------------------------- | ------------------------------------------------------------------------ |
| Character Core, Compact Reference | status, `Character`, race token, naming culture token (once if the same) |
| Specialist page (Biography, …)    | status, `Character`, its one specialist tag (optional)                   |
| Character Art                     | status, `Character`, `Character Art`                                     |
| Relationship                      | status, `Character`, `Relationship` (never a participant's race)         |
| `[INDEX]` of a character          | none                                                                     |

The status is `CANON` for an Authoritative page and `Working` for a Working one (which never carries `CANON`). An agent
never types a tag: an extra one is refused (`TAG_NOT_ALLOWED`).

## The character tool, in short

`arkona_create_character` takes one package (the name, `depth`, `status`, the identity facts, only the pages with real
content, the index text) and builds the set: a Compact Character Reference under its race index for a minor character,
or an `[INDEX] {name}` with a Character Core and one page per domain for a developed one; Art pages with staged images
placed in the character's asset folder; relationships hosted under one participant and linked from both. It previews
everything first (`dryRun`), then makes **one proposal**; on approval it runs as one job and verifies what it wrote. With
`target` it adds pages to an existing character without duplicating it: new pages take the character's standing, a
Compact Reference gets an index in its place when it gains siblings (its id kept), `upgradeToCore` makes it a Core, and
the index's routing section gains a line per new page. Its gate: a new character's six identity fields are required,
and an agent asks the owner rather than guess. The full reference is in [tools.md](tools.md#setting-packs-arkona_create_character-v3-f3a).

## Types as data, and what F3b extends

The engine never assumes it is making a character: a type's rules say what it makes, and a hook (`src/packs/hooks.ts`)
answers only what data cannot say. A type with no hook gets the generic behaviour, and a tool name shared by a pack's
types (other than `arkona_create_character`, which has its own schema) is served by a **generic pack tool**,
`{prefix}{tool}` with a `type` argument, listed while its types exist. The tests define a dummy "Polity" type in data only
and run it through plan, preview, proposal and verify with no code change.

The extension points named for F3b (ADR 0050):

- **a type's hook**: `identityRole` (which page holds a new subject's identity), `wantsIndex` (when a set gets an
  index), `relationships` (pages shared by two subjects, hosted under one), `upgrade` (an existing identity page that can
  become another role), `routing` (whether new pages are announced in an index's routing section);
- **placement kinds**: `taxonomy` (by a fact through the registry) and `fixed` (under one index); a new kind is a small
  addition to the planner;
- **roles** with their own template, name, tags and facts (outfits, species, institutions, nations are new types and
  roles, not new engines);
- **the registered checks** the job runs in the lock and at verify (`pack.governance`, `pack.absent`, `pack.page`), and
  the **filler** that writes a template copy's text while keeping the template's collection block;
- **selective approval and resuming a part-built package** (PLAN-v2 10.5) and **splitting an existing page** (refused
  in F3a: `MONOLITH_SPLIT_UNSUPPORTED`) are left to F3b.

## When a package is refused

| Code                                   | What to do                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PACK_NOT_CURRENT`                     | The owner checks the governance pages and approves the pack again on the Packs page                    |
| `PACK_NOT_ATTACHED`                    | Use a project the pack is attached to (the message names them)                                         |
| `PACK_TEMPLATE_UNSET`, `…_UNKNOWN`     | The owner refreshes the project's templates (Repository Mappings) and approves the pack again          |
| `TEMPLATES_NOT_READ`                   | The owner refreshes the project's templates (Repository Mappings)                                      |
| `LIFECYCLE_NOT_CONFIGURED`             | The owner confirms the Working index (Projects page, Lifecycle), or the package uses `"authoritative"` |
| `IDENTITY_INCOMPLETE`                  | The agent asks the owner for the missing values; never guesses                                         |
| `CHARACTER_EXISTS`                     | Call again with `target` (the existing character's name or id)                                         |
| `PACK_GOVERNANCE_CHANGED` (in the job) | A governance page changed after the proposal: approve the pack again, then ask for a new package       |
